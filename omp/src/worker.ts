/**
 * Runs exactly one omp coding session for one issue, under caps this file
 * enforces itself.
 *
 * The caps are the point. A worker that is *asked* to respect a turn budget
 * will talk itself out of it around turn 80, so the ceiling lives out here:
 * count the turns, watch the clock, and abort the session. Likewise the final
 * state is parsed out of the worker's own report rather than trusted — an
 * unreadable report is a failure, because the alternative is unverified work
 * sliding into a merge queue.
 */

import { createSession, disposeSession } from "./omp.ts";
import type { Caps, RunState } from "./types.ts";

/** Structured evidence fields from the worker's final report. */
const PR_URL_PATTERN = /^pr:\s*(https:\/\/github\.com\/\S+\/pull\/\d+)\s*$/im;
const HEAD_SHA_PATTERN = /^head:\s*([0-9a-f]{40})\s*$/im;
const PUSHED_GREEN_PATTERN = /^state:\s*pushed-green\s*$/im;
const BLOCKED_PATTERN = /^state:\s*blocked\s*$/im;

/** `{{KEY}}` placeholders in a brief template. */
const PLACEHOLDER_PATTERN = /\{\{([A-Za-z0-9_]+)\}\}/g;

/**
 * Which ceiling stopped a run. Only ever set alongside `state: "killed"`: the
 * turn counter caught a loop, or the wall clock caught a session that was stuck
 * without spending turns.
 */
export type KilledBy = "turns" | "wallclock";

export interface WorkerOpts {
  brief: string;
  cwd: string;
  caps: Caps;
  /**
   * Directory the harness writes this run's transcript into — a directory, not
   * a file. The SDK takes no `sessionFile` input, so naming a path here would
   * only name one nothing ever writes to. Omitted, the harness picks its own
   * location; either way the real path comes back on {@link WorkerResult}.
   */
  sessionDir?: string;
  /**
   * Model pattern for this session, in omp's model/role syntax. Omitted leaves
   * the harness to pick, which is what an unconfigured project wants.
   */
  model?: string;
  onTurn?: (n: number) => void;
  /** Cumulative USD spend, reported as each cost-bearing message finishes. */
  onSpend?: (usd: number) => void;
  /**
   * The transcript path, handed over the moment the session opens it rather
   * than at the end with {@link WorkerResult.sessionFile}. Both report the same
   * path; only this one arrives while there is still something to watch, which
   * is what `omp-conductor tail` attaches to. Never called for a session that
   * opened no transcript — there is no path to report, and an empty string
   * would be a path that fails to open rather than an absence.
   */
  onSessionFile?: (path: string) => void;
}

/**
 * The one collaborator worth injecting: starting a session is the only thing
 * `runWorker` does that needs a real harness. Defaulted, so production callers
 * never pass it and a test can hand over a fake without a live peer dependency.
 */
export interface RunWorkerDeps {
  createSession: typeof createSession;
}

export interface WorkerResult {
  state: RunState;
  prUrl?: string;
  headSha?: string;
  turns: number;
  spendUsd: number;
  report: string;
  killedBy?: KilledBy;
  /**
   * Transcript the session actually opened, absent if it opened none. Recorded
   * per run because it is the only readable evidence left once the worktree is
   * cleaned up.
   */
  sessionFile?: string;
  /**
   * Set when the harness could not honour {@link WorkerOpts.model} and used
   * another. Carried out rather than swallowed: a run that quietly read dumber
   * is otherwise indistinguishable from a run that was merely unlucky.
   */
  modelFallbackMessage?: string;
}

/**
 * Fill `{{KEY}}` placeholders from `vars`.
 *
 * An unknown key is left verbatim rather than blanked: a brief that reads
 * `Fix {{ISSUE}}` is obviously broken to whoever reads the transcript, whereas
 * `Fix undefined` looks like an instruction.
 */
export function renderBrief(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER_PATTERN, (placeholder, key: string) => {
    // Own properties only, so `{{constructor}}` cannot reach up the prototype.
    if (!Object.hasOwn(vars, key)) return placeholder;
    const value = vars[key];
    return value === undefined ? placeholder : value;
  });
}

/**
 * Read the run's structured outcome evidence from its final report.
 *
 * A textual `pushed-green` claim is not success by itself. The exact state line
 * must carry both a PR URL and the head SHA observed after CI; the daemon then
 * asks the tracker to verify those facts independently. Missing or malformed
 * evidence fails closed.
 */
export function deriveResult(report: string): {
  state: RunState;
  prUrl?: string;
  headSha?: string;
} {
  const prUrl = PR_URL_PATTERN.exec(report)?.[1];
  const headSha = HEAD_SHA_PATTERN.exec(report)?.[1]?.toLowerCase();
  if (PUSHED_GREEN_PATTERN.test(report) && prUrl !== undefined && headSha !== undefined) {
    return { state: "pushed-green", prUrl, headSha };
  }

  const state: RunState = BLOCKED_PATTERN.test(report) ? "blocked" : "failed";
  return {
    state,
    ...(prUrl === undefined ? {} : { prUrl }),
    ...(headSha === undefined ? {} : { headSha }),
  };
}

/**
 * Is this `agent_end` the end of the run?
 *
 * `isTerminal: false` means the harness will resume the session for maintenance
 * or async delivery, so the messages so far are a snapshot rather than a
 * result: completing there truncates the worker mid-flight and reports a
 * partial run as final. An absent field is terminal — that is what older
 * harness builds send, and treating it as non-terminal would hang every run.
 *
 * Exported because it is the one seam that lets this rule be tested without
 * standing up an SDK session.
 */
export function shouldComplete(event: { isTerminal?: boolean }): boolean {
  return event.isTerminal !== false;
}

/**
 * Drive one session to completion, a cap, or a failure. Never throws for a
 * failed run — a rejected `prompt()` is reported as `state: "failed"` so the
 * dispatcher's retry/escalate logic has one shape to reason about.
 */
export async function runWorker(
  o: WorkerOpts,
  deps: RunWorkerDeps = { createSession },
): Promise<WorkerResult> {
  // Read the caps once, by value: `o.caps` belongs to the caller's config.
  const { workerMaxTurns, workerWallClockMs } = o.caps;

  const session = await deps.createSession({
    cwd: o.cwd,
    ...(o.sessionDir === undefined ? {} : { sessionDir: o.sessionDir }),
    ...(o.model === undefined ? {} : { model: o.model }),
    // Prevention half of #24: structured file tools cannot leave this worktree.
    confineToCwd: true,
  });

  // Before the first turn, not after the last: a caller that only learns the
  // transcript path from the result learns it once the run it wanted to watch
  // is already over.
  if (session.sessionFile !== undefined) o.onSessionFile?.(session.sessionFile);

  // Every exit below reports the session's own facts the same way: the
  // transcript it actually opened, and any model downgrade it announced. Read at
  // return time so a session that materialises either late is still reported
  // honestly.
  const withSessionFacts = (result: WorkerResult): WorkerResult => {
    const { sessionFile, modelFallbackMessage } = session;
    return {
      ...result,
      ...(sessionFile === undefined ? {} : { sessionFile }),
      ...(modelFallbackMessage === undefined ? {} : { modelFallbackMessage }),
    };
  };

  let turns = 0;
  let spendUsd = 0;
  let report = "";
  let killedBy: KilledBy | undefined;
  // Bun's global timer handle; cleared on every exit path below.
  let timer: Timer | undefined;
  // Resolved by the first terminal `agent_end`, and by every cap kill. Only
  // ever awaited when the harness has already said it is not finished.
  const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
  // Set by a non-terminal `agent_end`: the harness will resume this session.
  let resuming = false;

  const clearWallClock = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const kill = (by: KilledBy) => {
    if (killedBy !== undefined) return;
    killedBy = by;
    clearWallClock();
    session.abort();
    // An aborted session may never reach a terminal `agent_end`. The cap is the
    // outcome now, so nothing may still be waiting for one.
    settle();
  };

  session.on("turn_start", () => {
    // The documented watchdog signal, and the honest one: `turn_start` fires
    // exactly once per turn, whereas one turn can emit several assistant
    // `message_end`s and would burn the cap on a run that is behaving.
    turns += 1;
    o.onTurn?.(turns);
    if (turns > workerMaxTurns) kill("turns");
  });

  session.on("message_end", (event) => {
    const message = field(event, "message");
    if (field(message, "role") !== "assistant") return;
    // Keep the newest non-empty assistant text: whatever the worker said last
    // is its report, whether it finished cleanly or was cut off.
    const text = reportText(field(message, "content"));
    if (text !== "") report = text;

    // Real cost lives on assistant messages as `usage.cost.total` (live hermes
    // transcripts, 2026-08-07). The earlier agent_end.telemetry path never
    // fired, so every run recorded $0 and the daily cap was theater (#46).
    const cost = costUsdFromMessage(message);
    if (cost !== undefined) {
      spendUsd += cost;
      o.onSpend?.(spendUsd);
    }
  });

  session.on("agent_end", (event) => {
    // Fallback for harnesses that only attach cost on the terminal event.
    const estimated = field(field(field(event, "telemetry"), "cost"), "estimatedUsd");
    if (
      spendUsd === 0 &&
      typeof estimated === "number" &&
      Number.isFinite(estimated) &&
      estimated > 0
    ) {
      // Prefer message totals when both exist — do not double-count a run that
      // already accumulated per-message costs.
      spendUsd = estimated;
      o.onSpend?.(spendUsd);
    }

    // Anything that is not literally `false` — including garbage or nothing at
    // all — is a finished run.
    const isTerminal = field(event, "isTerminal");
    if (shouldComplete(typeof isTerminal === "boolean" ? { isTerminal } : {})) {
      settle();
      return;
    }
    resuming = true;
  });

  // A stuck session spends no turns, so turns alone cannot detect it. The
  // callback does not drop the handle itself: every exit runs `clearWallClock()`
  // exactly once instead, and clearing an already-fired handle is a documented
  // no-op — cheaper than assuming a fired timer holds nothing.
  timer = setTimeout(() => kill("wallclock"), workerWallClockMs);

  try {
    await session.prompt(o.brief);
    // `prompt()` returning is not the end of the run once the harness has
    // announced a resume: finishing here would hand back a truncated report as
    // the final result. Wait for the terminal `agent_end`, or for a cap.
    if (resuming && killedBy === undefined) await settled;
  } catch (cause) {
    // Our own abort surfaces here on some paths; that is a kill, not a crash.
    if (killedBy === undefined) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return withSessionFacts({
        state: "failed",
        turns,
        spendUsd,
        report: report === "" ? detail : report,
      });
    }
  } finally {
    // Runs on every exit, including the early return above: a live timer keeps
    // the dispatcher process alive long after the run it was guarding.
    clearWallClock();
    try {
      await disposeSession(session);
    } catch {
      // Teardown noise must not overwrite the run's actual outcome.
    }
  }

  if (killedBy !== undefined) {
    return withSessionFacts({ state: "killed", turns, spendUsd, report, killedBy });
  }

  return withSessionFacts({
    ...deriveResult(report),
    turns,
    spendUsd,
    report,
  });
}

/**
 * USD cost from one assistant message's `usage.cost` block.
 *
 * Prefer `total` when present; otherwise sum the component fields the live
 * harness emits (input/output/cacheRead/cacheWrite). Exported so a unit test
 * can pin the shape without standing up a session.
 */
export function costUsdFromMessage(message: unknown): number | undefined {
  const usage = field(message, "usage");
  const cost = field(usage, "cost");
  if (cost === null || typeof cost !== "object") return undefined;
  const total = field(cost, "total");
  if (typeof total === "number" && Number.isFinite(total) && total >= 0) return total;
  let sum = 0;
  let any = false;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const v = field(cost, key);
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : undefined;
}

/**
 * Read one property off an unvalidated harness event. The event union lives in
 * the peer dependency, so the worker narrows the handful of fields it reads
 * instead of importing types it cannot see at build time.
 */
function field(source: unknown, key: string): unknown {
  if (source === null || typeof source !== "object") return undefined;
  return Reflect.get(source, key);
}

/** Flatten an assistant message's content blocks to their plain text. */
function reportText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  const blocks: readonly unknown[] = Array.isArray(content) ? content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (field(block, "type") !== "text") continue;
    const text = field(block, "text");
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n").trim();
}
