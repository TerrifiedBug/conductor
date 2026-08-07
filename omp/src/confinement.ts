/**
 * Mechanical worktree confinement for worker sessions.
 *
 * The harness has no first-class fs-policy field, but `createAgentSession`
 * accepts inline `extensions` that subscribe to `tool_call` and can return
 * `{ block: true }` before a tool runs (see the harness `protected-paths`
 * example). Workers get that gate for structured file tools; the orchestrator
 * does not — it has to read the state directory and briefs.
 *
 * `bash` is deliberately not confined here: its input is an opaque shell
 * string, and parsing it is a false-sense of security. Closing that gap is a
 * least-privilege uid (deployment), documented beside this module's README
 * section — not a regex over `rm -rf`.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Tools whose structured `path` (or path-like) field we can gate. */
const GATED = new Set(["write", "edit", "read", "grep", "glob"]);

/**
 * Resolve `candidate` as a worker would, then ask whether it stays under
 * `root`. Symlink-aware: existing path components are realpath'd so a link
 * planted inside the worktree cannot escape by string-prefix tricks.
 *
 * A path that does not exist yet (a new write) realpaths the deepest existing
 * ancestor and appends the rest — the same TOCTOU posture as the harness's
 * own workspace confinement helper.
 */
export function isInsideWorktree(root: string, candidate: string): boolean {
  if (candidate.length === 0 || candidate.includes("\0")) return false;

  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    rootReal = resolve(root);
  }

  const abs = resolve(rootReal, candidate);

  const missing: string[] = [];
  let probe = abs;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    missing.unshift(basename(probe));
    probe = parent;
  }

  let base: string;
  try {
    base = realpathSync(probe);
  } catch {
    base = probe;
  }
  const resolved = missing.length === 0 ? base : join(base, ...missing);

  const rel = relative(rootReal, resolved);
  // Inside ⇒ "" or a relative path that does not climb out. Absolute `rel` is
  // a Windows drive mismatch; anything starting with `..` has left the root.
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Pull the path-like field a gated tool carries, if any. */
export function pathFromToolInput(toolName: string, input: Record<string, unknown>): string | undefined {
  if (!GATED.has(toolName)) return undefined;
  const path = input.path;
  if (typeof path === "string" && path.length > 0) return path;
  // glob / grep sometimes scope via target_directory / path_filter; only a
  // concrete directory root is confinable without inventing a glob parser.
  const target = input.target_directory ?? input.cwd;
  if (typeof target === "string" && target.length > 0) return target;
  return undefined;
}

export type ConfineDecision = { block: true; reason: string };

/**
 * Decide whether one tool_call may run. Undefined means "no opinion" (allow).
 * Pure so tests pin the gate without standing up a harness session.
 */
export function confineToolCall(
  root: string,
  toolName: string,
  input: Record<string, unknown>,
): ConfineDecision | undefined {
  const path = pathFromToolInput(toolName, input);
  if (path === undefined) return undefined;
  if (isInsideWorktree(root, path)) return undefined;
  return {
    block: true,
    reason:
      `Blocked: ${toolName} path "${path}" is outside the worker worktree (${root}). ` +
      `Structured file tools may only touch the assigned checkout; use paths under it.`,
  };
}

/**
 * Minimal extension surface this package needs. Kept duck-typed so the peer
 * harness does not have to be on disk for `tsc` — same reason `omp.ts` exists.
 */
export interface ConfinementPi {
  on(
    event: "tool_call",
    handler: (
      event: { toolName: string; input: Record<string, unknown> },
      ctx: unknown,
    ) => ConfineDecision | undefined | Promise<ConfineDecision | undefined>,
  ): void;
}

/**
 * Inline extension factory for `createAgentSession({ extensions: [...] })`.
 * Installs the worktree gate on every structured file tool_call.
 */
export function worktreeConfinement(root: string): (pi: ConfinementPi) => void {
  const rootAbs = resolve(root);
  return (pi) => {
    pi.on("tool_call", (event) => confineToolCall(rootAbs, event.toolName, event.input));
  };
}
