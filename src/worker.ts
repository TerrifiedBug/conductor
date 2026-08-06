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

/** A PR link the worker pushed, recognised anywhere in its report. */
const PR_URL_PATTERN = /https:\/\/github\.com\/\S+\/pull\/\d+/;

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
  sessionFile?: string;
  onTurn?: (n: number) => void;
}

export interface WorkerResult {
  state: RunState;
  prUrl?: string;
  turns: number;
  spendUsd: number;
  report: string;
  killedBy?: KilledBy;
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
 * Read the run's outcome out of the worker's final report.
 *
 * Success has to be claimed explicitly (`pushed-green`); everything else,
 * including an empty or unparseable report, is a failure. Defaulting the other
 * way would let a session that died mid-thought be reported as merge-ready.
 */
export function deriveResult(report: string): { state: RunState; prUrl?: string } {
  const haystack = report.toLowerCase();
  const state: RunState = haystack.includes("pushed-green")
    ? "pushed-green"
    : haystack.includes("ci-red")
      ? "failed"
      : haystack.includes("blocked")
        ? "blocked"
        : "failed";
  const prUrl = PR_URL_PATTERN.exec(report)?.[0];
  return prUrl === undefined ? { state } : { state, prUrl };
}

/**
 * Drive one session to completion, a cap, or a failure. Never throws for a
 * failed run — a rejected `prompt()` is reported as `state: "failed"` so the
 * dispatcher's retry/escalate logic has one shape to reason about.
 */
export async function runWorker(o: WorkerOpts): Promise<WorkerResult> {
  // Read the caps once, by value: `o.caps` belongs to the caller's config.
  const { workerMaxTurns, workerWallClockMs } = o.caps;

  const session = await createSession({
    cwd: o.cwd,
    ...(o.sessionFile === undefined ? {} : { sessionFile: o.sessionFile }),
  });

  let turns = 0;
  let spendUsd = 0;
  let report = "";
  let killedBy: KilledBy | undefined;
  // Bun's global timer handle; cleared on every exit path below.
  let timer: Timer | undefined;

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
  };

  session.on("message_end", (event) => {
    const message = field(event, "message");
    if (field(message, "role") !== "assistant") return;
    turns += 1;
    o.onTurn?.(turns);
    // Keep the newest non-empty assistant text: whatever the worker said last
    // is its report, whether it finished cleanly or was cut off.
    const text = reportText(field(message, "content"));
    if (text !== "") report = text;
    if (turns > workerMaxTurns) kill("turns");
  });

  session.on("agent_end", (event) => {
    // ponytail: cost only arrives when the harness run carries telemetry, so
    // spend can legitimately read 0 and the daily-spend cap then leans on the
    // turn and wall-clock ceilings. Upgrade path: pass a telemetry config
    // through `createSession` once the harness exposes it on the SDK options.
    const estimated = field(field(field(event, "telemetry"), "cost"), "estimatedUsd");
    if (typeof estimated === "number" && Number.isFinite(estimated)) spendUsd += estimated;
  });

  // A stuck session spends no turns, so turns alone cannot detect it. The
  // callback does not drop the handle itself: every exit runs `clearWallClock()`
  // exactly once instead, and clearing an already-fired handle is a documented
  // no-op — cheaper than assuming a fired timer holds nothing.
  timer = setTimeout(() => kill("wallclock"), workerWallClockMs);

  try {
    await session.prompt(o.brief);
  } catch (cause) {
    // Our own abort surfaces here on some paths; that is a kill, not a crash.
    if (killedBy === undefined) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return { state: "failed", turns, spendUsd, report: report === "" ? detail : report };
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

  if (killedBy !== undefined) return { state: "killed", turns, spendUsd, report, killedBy };

  const { state, prUrl } = deriveResult(report);
  return prUrl === undefined
    ? { state, turns, spendUsd, report }
    : { state, prUrl, turns, spendUsd, report };
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
