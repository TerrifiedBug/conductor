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
 * `gh auth token`; the seven Tracker methods above it stay untouched.
 */

import type { ProjectConfig, ReadyIssue, Tracker } from "../types.ts";

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

export function makeTracker(p: ProjectConfig): Tracker {
  const repo = p.tracker.repo;

  return {
    async listReady(): Promise<ReadyIssue[]> {
      const raw = await gh([
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
        await gh(["issue", "edit", String(issue), "--repo", repo, "--add-label", label]);
      } catch (err) {
        if (!isLabelNoop(err, "add")) throw err;
      }
    },

    async removeLabel(issue: number, label: string): Promise<void> {
      try {
        await gh(["issue", "edit", String(issue), "--repo", repo, "--remove-label", label]);
      } catch (err) {
        if (!isLabelNoop(err, "remove")) throw err;
      }
    },

    async comment(issue: number, body: string): Promise<void> {
      // `--body-file -` reads stdin, so the body is never shell- or argv-
      // mangled and has no length limit worth worrying about.
      await gh(["issue", "comment", String(issue), "--repo", repo, "--body-file", "-"], body);
    },

    async close(issue: number): Promise<void> {
      await gh(["issue", "close", String(issue), "--repo", repo]);
    },

    async linkParent(child: number, parent: number): Promise<void> {
      // Native sub-issue linkage rather than a body mention: it is what the
      // repo's own epic rollups read, so a human sees the split without us
      // maintaining a second index of it.
      await gh(["issue", "edit", String(parent), "--repo", repo, "--add-sub-issue", String(child)]);
    },

    async openCloserFor(issue: number): Promise<string | undefined> {
      // GraphQL wants the halves of `owner/repo` separately. Config validates
      // that spelling, so an empty half means a hand-edited config: `gh` then
      // errors and the caller holds the candidate rather than guessing.
      const [owner = "", name = ""] = repo.split("/");
      const raw = await gh([
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
  };
}
