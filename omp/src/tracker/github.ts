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
 * `gh auth token`; the six Tracker methods above it stay untouched.
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
 */
function isLabelNoop(err: unknown, op: "add" | "remove"): boolean {
  if (!(err instanceof GhError)) return false;
  const stderr = err.stderr;
  return op === "add"
    ? /already (?:has|had|exists|applied|added)|label .* already/i.test(stderr)
    : /label does not exist|not labeled|does not have (?:that|the|this) label|label .* not found|not found on (?:this )?issue/i.test(
        stderr,
      );
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
  };
}
