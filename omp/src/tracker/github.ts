/**
 * GitHub adapter for the tracker port.
 *
 * Every operation goes through the already-authenticated `gh` CLI, so the
 * daemon never handles a token itself: credentials stay in the user's keychain
 * or `gh` config and are never passed as argv, written to a file, or logged.
 *
 * ponytail: shelling out to `gh` is the deliberate simplification. The ceiling
 * is per-call cost (one process spawn plus one TLS handshake per operation,
 * ~200-400ms) and failure classification by matching human-readable stderr
 * instead of reading a status code. Upgrade path when either bites: replace the
 * body of `gh()` with `fetch("https://api.github.com/...")` using a token from
 * `gh auth token`; the eleven Tracker methods above it stay untouched.
 */

import type {
  IssueState,
  PrState,
  PrVerification,
  ProjectConfig,
  ReadyIssue,
  Tracker,
} from "../types.ts";

/** The subset of `gh issue list --json` output this adapter reads. Fields the
 *  API can return as null are typed as such so the mapping has to handle it. */
interface GhIssue {
  number: number;
  title: string | null;
  body: string | null;
  labels: { name: string }[] | null;
  url: string;
  updatedAt: string;
}

/**
 * Pull requests that would close an issue, with the one field that decides it.
 *
 * `gh issue view <n> --json closedByPullRequestsReferences` returns `id`,
 * `number`, `repository` and `url` and no state, so a guard built on it holds an
 * issue forever on a reference that is merged or closed-unmerged — which is
 * exactly what a reopened issue looks like. GraphQL is the only spelling that
 * yields `state`, so it is the spelling used.
 *
 * `includeClosedPrs:false` is deliberately not passed: it is not the filter it
 * sounds like. Measured on gh 2.86.0 (2026-08-06), `veltro#260` returned a
 * MERGED reference with the argument both true and false. The state is filtered
 * in this consumer instead.
 *
 * ponytail: one page of ten. An issue closed by more than ten PRs is not a
 * dispatch problem, and the first OPEN one already answers the question.
 */
const CLOSERS_QUERY = `query($owner:String!,$repo:String!,$n:Int!){
  repository(owner:$owner,name:$repo){
    issue(number:$n){
      closedByPullRequestsReferences(first:10){
        nodes{ number state isDraft url repository{ nameWithOwner } }
      }
    }
  }
}`;

const PARENT_QUERY = `query($owner:String!,$repo:String!,$n:Int!){
  repository(owner:$owner,name:$repo){
    issue(number:$n){ parent{ number } }
  }
}`;

/** The `gh api graphql` envelope for {@link CLOSERS_QUERY}. Every level is
 *  nullable: a deleted or wrong-numbered issue answers `null`, not an error. */
interface ClosersResponse {
  data?: {
    repository?: {
      issue?: {
        closedByPullRequestsReferences?: {
          nodes?: ({ state: string; isDraft: boolean; url: string } | null)[] | null;
        } | null;
      } | null;
    } | null;
  } | null;
}

interface GhCheck {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
}

interface GhPrVerification {
  state?: string;
  isDraft?: boolean;
  headRefOid?: string;
  statusCheckRollup?: GhCheck[] | null;
}

/** Carries the captured stderr so callers can classify a failure without
 *  re-running the command or parsing the message text of a plain Error. */
class GhError extends Error {
  readonly argv: string[];
  readonly code: number;
  readonly stderr: string;

  constructor(argv: string[], code: number, stderr: string) {
    const detail = stderr.trim() || "(no stderr)";
    super(`\`gh ${argv.join(" ")}\` exited ${code}: ${detail}`);
    this.name = "GhError";
    this.argv = argv;
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * The single execution path for this adapter. `stdin` is written to the child
 * and closed, which is how bodies containing newlines, backticks or a leading
 * `-` reach `gh` without ever being interpolated into argv.
 */
async function gh(argv: string[], stdin?: string): Promise<string> {
  const proc = Bun.spawn(["gh", ...argv], {
    // Always a closed stream: commands that do not read stdin see immediate
    // EOF instead of an open pipe nobody ends.
    stdin: new Blob([stdin ?? ""]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const signal = proc.signalCode;
  if (code !== 0 || signal) {
    throw new GhError(argv, code, signal ? `${stderr}\nterminated by ${signal}` : stderr);
  }
  return stdout;
}

/**
 * True when a label edit failed only because the requested end state already
 * holds. Adding a label is idempotent server-side, but removing one that is not
 * present is a 404, and a concurrent daemon restart can easily race into both.
 *
 * The quoted form is gh's own, and it is why the two operations are classified
 * separately: `gh issue edit --remove-label x` on a label the *repository* does
 * not define exits 1 with `'x' not found` (2.97.0), which for a removal is the
 * end state already holding — a label nobody defined cannot be on an issue —
 * while for an add it is a genuine failure. Removing a label the repo defines
 * but the issue does not carry is already a silent success, so this path is
 * reached only by the undefined-label case, most often a state label an
 * operator declined to create at setup.
 */
function isLabelNoop(err: unknown, op: "add" | "remove"): boolean {
  if (!(err instanceof GhError)) return false;
  const stderr = err.stderr;
  return op === "add"
    ? /already (?:has|had|exists|applied|added)|label .* already/i.test(stderr)
    : /label does not exist|not labeled|does not have (?:that|the|this) label|label .* not found|not found on (?:this )?issue|'[^']+' not found/i.test(
        stderr,
      );
}

/**
 * The URL of the first OPEN closer in a `gh api graphql` reply, if any.
 *
 * Split from the call so the state filter — the only real logic in this file —
 * is pinned against recorded payloads instead of a live repo.
 *
 * A draft counts. `isDraft` is selected because the API offers it, not because
 * it changes the answer: draft means "not ready to review", not "not pushed",
 * and the branch behind a draft still holds the only copy of the work. Sending
 * a second worker at it duplicates that work exactly as much as a ready PR
 * would, so OPEN is the whole test.
 */
export function firstOpenCloser(raw: string): string | undefined {
  const nodes =
    (JSON.parse(raw) as ClosersResponse).data?.repository?.issue?.closedByPullRequestsReferences
      ?.nodes ?? [];
  return nodes.find((n) => n !== null && n.state === "OPEN")?.url;
}

/**
 * A pull request URL this adapter is willing to hand to `gh`.
 *
 * Load-bearing, not defensive: `gh pr view` also accepts a bare number or a
 * *branch name*, and resolves those against whatever repository the current
 * directory belongs to. So a `prUrl` that is not a URL would not fail — it would
 * be answered, confidently, about some other repository's pull request. A
 * settle sweep that acted on that answer would mark the wrong run merged.
 */
const PR_URL = /^https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+\/?$/;

type CheckVerdict = PrVerification["status"];

function checkName(check: GhCheck): string {
  return check.name ?? check.context ?? "(unnamed check)";
}

function checkVerdict(check: GhCheck): CheckVerdict {
  if (check.__typename === "StatusContext" || check.state !== undefined) {
    if (check.state === "SUCCESS") return "green";
    if (check.state === "PENDING" || check.state === "EXPECTED") return "pending";
    return "failed";
  }
  if (check.status !== "COMPLETED") return "pending";
  if (check.conclusion === "SUCCESS" || check.conclusion === "SKIPPED") return "green";
  return "failed";
}

/**
 * Verify one `gh pr view --json state,isDraft,headRefOid,statusCheckRollup`
 * payload against the worker-observed head. A missing rollup is pending rather
 * than green because GitHub may not have created the checks yet.
 */
export function prVerificationFrom(raw: string, expectedHead: string): PrVerification {
  const pr = JSON.parse(raw) as GhPrVerification;
  if (pr.state !== "OPEN") {
    return { status: "failed", reason: `PR is ${pr.state ?? "unknown"}, expected OPEN` };
  }
  if (pr.isDraft !== false) {
    return { status: "failed", reason: "PR is draft or draft state is unknown" };
  }
  if (pr.headRefOid?.toLowerCase() !== expectedHead.toLowerCase()) {
    return {
      status: "failed",
      reason: `PR head changed: expected ${expectedHead}, found ${pr.headRefOid ?? "unknown"}`,
    };
  }

  const checks = pr.statusCheckRollup ?? [];
  if (checks.length === 0) {
    return { status: "pending", reason: "GitHub has not reported any checks yet" };
  }
  const failed = checks.filter((check) => checkVerdict(check) === "failed");
  if (failed.length > 0) {
    return {
      status: "failed",
      reason: `Checks failed: ${failed.map((check) => `${checkName(check)} (${check.conclusion ?? check.state ?? "unknown"})`).join(", ")}`,
    };
  }
  const pending = checks.filter((check) => checkVerdict(check) === "pending");
  if (pending.length > 0) {
    return {
      status: "pending",
      reason: `Checks pending: ${pending.map(checkName).join(", ")}`,
    };
  }
  return { status: "green", reason: `${checks.length} checks succeeded or were skipped` };
}

function failedCheck(raw: string): GhCheck | undefined {
  const checks = (JSON.parse(raw) as GhPrVerification).statusCheckRollup ?? [];
  return checks.find((check) => checkVerdict(check) === "failed");
}

function runLogArgs(detailsUrl: string): string[] | undefined {
  const match =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(
      detailsUrl,
    );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return [
    "run",
    "view",
    match[2],
    "--repo",
    match[1],
    ...(match[3] === undefined ? [] : ["--job", match[3]]),
    "--log-failed",
  ];
}

function conciseLog(raw: string): string | undefined {
  const lines = raw
    .replaceAll(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(-8)
    .map((line) => line.slice(0, 240));
  return lines.length === 0 ? undefined : lines.join("\n");
}

/**
 * GitHub's PR state spelling mapped onto {@link PrState}.
 *
 * Split from the call so the mapping is pinned without a network round trip,
 * and unrecognised text answers undefined rather than being coerced: this
 * function's caller settles a run row on the answer, and every wrong answer
 * here rewrites history for work that has no other record. `MERGED`, `CLOSED`
 * and `OPEN` are the only three `gh pr view --json state` emits (verified on
 * gh 2.97.0); anything else means the CLI changed under us, which is a reason
 * to leave the row alone and let a human look.
 */
export function prStateFrom(raw: string): PrState | undefined {
  switch (raw.trim()) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    case "OPEN":
      return "open";
    default:
      return undefined;
  }
}

/** GitHub's issue state spelling, kept fail-closed for cleanup decisions. */
export function issueStateFrom(raw: string): IssueState | undefined {
  switch (raw.trim()) {
    case "OPEN":
      return "open";
    case "CLOSED":
      return "closed";
    default:
      return undefined;
  }
}

/**
 * Parent number from a raw GraphQL response, or undefined when the issue has
 * no parent. Throws when the issue or claimed parent is malformed — admission
 * must not turn an unknown relationship into permission to run siblings.
 */
export function parentNumberFrom(raw: string): number | undefined {
  const parsed = JSON.parse(raw) as {
    data?: { repository?: { issue?: { parent?: { number?: unknown } | null } | null } | null };
  };
  const issue = parsed.data?.repository?.issue;
  if (issue == null) throw new Error("unexpected missing issue in parent response");
  if (issue.parent == null) return undefined;
  const n = issue.parent.number;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new Error(`unexpected parent number ${JSON.stringify(n)}`);
  }
  return n;
}

export function makeTracker(p: ProjectConfig, runGh: typeof gh = gh): Tracker {
  const repo = p.tracker.repo;

  return {
    async listReady(): Promise<ReadyIssue[]> {
      const raw = await runGh([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--label",
        p.queueLabel,
        // ponytail: one page is the cap. A queue deeper than 100 ready issues
        // truncates silently; upgrade path is `--paginate` via the API, but a
        // backlog that size is a staffing problem before it is a paging one.
        "--limit",
        "100",
        "--json",
        "number,title,body,labels,url,updatedAt",
      ]);

      const text = raw.trim();
      // `gh` prints nothing at all in some no-match paths; an empty queue is
      // the normal steady state, not an error.
      if (!text) return [];

      const issues = JSON.parse(text) as GhIssue[];
      return issues.map((issue) => ({
        number: issue.number,
        title: issue.title ?? "",
        body: issue.body ?? "",
        labels: (issue.labels ?? []).map((label) => label.name),
        url: issue.url,
        updatedAt: issue.updatedAt,
      }));
    },

    async addLabel(issue: number, label: string): Promise<void> {
      try {
        await runGh(["issue", "edit", String(issue), "--repo", repo, "--add-label", label]);
      } catch (err) {
        if (!isLabelNoop(err, "add")) throw err;
      }
    },

    async removeLabel(issue: number, label: string): Promise<void> {
      try {
        await runGh(["issue", "edit", String(issue), "--repo", repo, "--remove-label", label]);
      } catch (err) {
        if (!isLabelNoop(err, "remove")) throw err;
      }
    },

    async comment(issue: number, body: string): Promise<void> {
      // `--body-file -` reads stdin, so the body is never shell- or argv-
      // mangled and has no length limit worth worrying about.
      await runGh(["issue", "comment", String(issue), "--repo", repo, "--body-file", "-"], body);
    },

    async close(issue: number): Promise<void> {
      await runGh(["issue", "close", String(issue), "--repo", repo]);
    },

    async linkParent(child: number, parent: number): Promise<void> {
      // Native sub-issue linkage rather than a body mention: it is what the
      // repo's own epic rollups read, so a human sees the split without us
      // maintaining a second index of it.
      await runGh(["issue", "edit", String(parent), "--repo", repo, "--add-sub-issue", String(child)]);
    },

    async parentOf(issue: number): Promise<number | undefined> {
      // gh 2.86 cannot expose `parent` through `issue view --json`; its raw
      // GraphQL command can, and is already the adapter's path for PR closers.
      const [owner = "", name = ""] = repo.split("/");
      return parentNumberFrom(
        await runGh([
          "api",
          "graphql",
          "-f",
          `query=${PARENT_QUERY}`,
          "-F",
          `owner=${owner}`,
          "-F",
          `repo=${name}`,
          "-F",
          `n=${issue}`,
        ]),
      );
    },

    async openCloserFor(issue: number): Promise<string | undefined> {
      // GraphQL wants the halves of `owner/repo` separately. Config validates
      // that spelling, so an empty half means a hand-edited config: `gh` then
      // errors and the caller holds the candidate rather than guessing.
      const [owner = "", name = ""] = repo.split("/");
      const raw = await runGh([
        "api",
        "graphql",
        "-f",
        `query=${CLOSERS_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `repo=${name}`,
        // -F, not -f: the query declares $n as Int! and a string would be a
        // type error rather than a coerced number.
        "-F",
        `n=${issue}`,
      ]);

      return firstOpenCloser(raw);
    },

    async issueState(issue: number): Promise<IssueState | undefined> {
      try {
        return issueStateFrom(
          await runGh(["issue", "view", String(issue), "--repo", repo, "--json", "state", "--jq", ".state"]),
        );
      } catch {
        return undefined;
      }
    },

    async prState(url: string): Promise<PrState | undefined> {
      // No `--repo`: a full URL is self-locating, and verified so on gh 2.97.0
      // from a directory that is not a git repository at all — which is exactly
      // where the daemon runs (its state directory), while the PR lives in one
      // of the routed repos. Deriving `--repo` from the URL would only re-state
      // what the URL already says.
      if (!PR_URL.test(url)) return undefined;
      try {
        return prStateFrom(await runGh(["pr", "view", url, "--json", "state", "--jq", ".state"]));
      } catch {
        // Never throws, per the port's contract. A deleted PR, a revoked token
        // and a flaky network all mean "could not tell", and the caller's whole
        // job is to leave the row alone on that — so classifying them here would
        // buy nothing but a way to get the classification wrong. The next tick
        // asks again for free.
        return undefined;
      }
    },

    async verifyPr(url: string, expectedHead: string): Promise<PrVerification | undefined> {
      if (!PR_URL.test(url)) return undefined;
      try {
        const raw = await runGh([
          "pr",
          "view",
          url,
          "--json",
          "state,isDraft,headRefOid,statusCheckRollup",
        ]);
        const verification = prVerificationFrom(raw, expectedHead);
        if (verification.status !== "failed") return verification;

        const detailsUrl = failedCheck(raw)?.detailsUrl;
        const args = detailsUrl === undefined ? undefined : runLogArgs(detailsUrl);
        if (args === undefined) return verification;
        try {
          const digest = conciseLog(await runGh(args));
          return digest === undefined
            ? verification
            : { ...verification, reason: `${verification.reason}\n${digest}` };
        } catch {
          return verification;
        }
      } catch {
        // Lookup or payload failure is not permission to accept success. The
        // daemon records a pending row and asks again on a later tick.
        return undefined;
      }
    },
  };
}
