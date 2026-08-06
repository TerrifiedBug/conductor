/**
 * Self-tick for the fleet orchestrator session.
 *
 * The orchestrator is a 24/7 omp session with a standing brief (ORCHESTRATOR.md)
 * and no user typing into it. A session that is never prompted never runs its
 * loop, so this extension is the heartbeat: every `intervalSeconds` it injects
 * one message that starts a turn.
 *
 * Four properties are worth protecting, and each one is a branch in
 * `tickDecision()`:
 *
 * - **Pause is honoured.** `isPaused()` is imported from ./daemon.ts — the exact
 *   function `/conductor pause` writes for and the dispatch loop reads. A second
 *   spelling of "is it paused" here is how a paused fleet keeps working.
 * - **A disarmed fleet is not woken.** The arm marker is a file the operator
 *   controls; missing means "not armed", and a tick then does nothing.
 * - **The human channel must still be there.** Autonomous dispatch is only
 *   defensible while a tier-2 escalation can reach a person, so every tick
 *   re-reads the Telegram bridge's access file and requires it enabled with
 *   exactly one paired owner. This is fail-closed: an unreadable, unparseable or
 *   ambiguous access file stops ticking. A stale arm marker must not outlive the
 *   channel that makes running unattended safe.
 * - **Ticks coalesce.** A tick that lands while an earlier one is still queued
 *   would stack prompts on a session that is already behind. `hasPendingMessages()`
 *   makes the tick idempotent under slow turns.
 *
 * The extension is inert unless `<cwd>/.conductor-tick.json` exists, so shipping
 * it inside `omp-conductor` costs an ordinary session nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isPaused } from "./daemon.ts";

/** The activation file. Absent means "this is not an orchestrator session". */
export const TICK_CONFIG_FILE = ".conductor-tick.json";

/** Namespaced so a renderer or a session-log reader can pick ticks out. */
export const TICK_CUSTOM_TYPE = "omp-conductor.tick";

/**
 * A tick costs a whole turn of a frontier model, and the orchestrator's loop is
 * about minutes of latency, not seconds. Anything under a minute is a
 * misconfiguration worth refusing rather than obeying.
 */
export const MIN_INTERVAL_SECONDS = 60;

/**
 * The slice of the omp extension API this entry touches, mirroring
 * `ExtensionAPI` / `ExtensionContext` from `@oh-my-pi/pi-coding-agent`.
 *
 * Declared here rather than imported for the reason ./plugin.ts declares its
 * own: the harness is a peer dependency and the package has to type-check
 * without it installed. Structural typing means the real objects satisfy these
 * on the way in.
 */
interface TickLogger {
  info(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

interface TickContext {
  /** Session cwd — where the activation file is looked for. */
  cwd: string;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  /** True while steering, follow-up or next-turn messages are still queued. */
  hasPendingMessages(): boolean;
  /**
   * Managed timer: throws inside `callback` are contained and surfaced on the
   * extension error channel, the handle is `unref`'d, and it is cleared on
   * `session_shutdown`. Raw `setInterval` has none of that and a throwing tick
   * would take the session down, so it is never used here.
   */
  setInterval(callback: () => void, ms?: number): unknown;
}

interface TickApi {
  logger: TickLogger;
  on(event: "session_start", handler: (event: { type: "session_start" }, ctx: TickContext) => void): void;
  /**
   * `deliverAs: "followUp"` + `triggerTurn: true`, verified against
   * `AgentSession.sendCustomMessage` rather than assumed:
   *
   * - idle: the `nextTurn` branch is skipped, `triggerTurn` prompts immediately,
   *   so the tick starts a turn now;
   * - streaming: the message is queued as a follow-up and drained when the
   *   current turn ends, which is exactly the intended "tick after this
   *   finishes" and is also what `hasPendingMessages()` sees, so the next tick
   *   coalesces instead of stacking.
   *
   * `attribution: "user"` bills the turn as operator-initiated work, which is
   * what a heartbeat prompt is.
   */
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      attribution: "user" | "agent";
    },
    options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

/** Validated activation config. `armedFile` and `accessFile` are absolute once
 *  they get here. */
export interface TickConfig {
  intervalSeconds: number;
  armedFile?: string;
  accessFile?: string;
  message?: string;
}

/**
 * Three outcomes, none of them an exception: an absent file is the normal case
 * for every other session, and a broken one must not stop the rest of the
 * extension host from loading.
 */
export type TickConfigResult =
  | { kind: "absent"; path: string }
  | { kind: "invalid"; path: string; problem: string }
  | { kind: "ok"; path: string; config: TickConfig };

/** The prompt when the config names none. The timestamp is what makes two
 *  consecutive ticks distinguishable in the session log. */
export function defaultTickMessage(now: Date): string {
  return `Tick ${now.toISOString()}: run your standing loop from ORCHESTRATOR.md now. Report only material events.`;
}

/**
 * An optional file-path field. Relative paths resolve against the session cwd
 * so `state/armed` means what it looks like; a present-but-unusable value is a
 * config error rather than something to ignore, because both paths this reads
 * are safety gates and a silently dropped gate is an open one.
 */
function optionalPath(raw: unknown, key: string, cwd: string, problems: string[]): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    problems.push(`${key} must be a non-empty string when present`);
    return undefined;
  }
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/**
 * Reads and validates `<cwd>/.conductor-tick.json`.
 *
 * Every fault is collected and reported in one message, the way ./config.ts
 * does it: an operator fixing a config wants the whole list, not the first
 * complaint followed by another edit-and-retry cycle.
 */
export function readTickConfig(cwd: string): TickConfigResult {
  const path = join(cwd, TICK_CONFIG_FILE);
  if (!existsSync(path)) return { kind: "absent", path };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { kind: "invalid", path, problem: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", path, problem: "must be a JSON object" };
  }

  const raw = parsed as { readonly [key: string]: unknown };
  const problems: string[] = [];

  let intervalSeconds = 0;
  const interval = raw["intervalSeconds"];
  if (typeof interval !== "number" || !Number.isFinite(interval) || !Number.isInteger(interval)) {
    problems.push("intervalSeconds must be a whole number of seconds");
  } else if (interval < MIN_INTERVAL_SECONDS) {
    problems.push(`intervalSeconds must be at least ${MIN_INTERVAL_SECONDS}`);
  } else {
    intervalSeconds = interval;
  }

  // Relative paths resolve against the session cwd, so the files can sit beside
  // the config that names them (`state/armed`) without hard-coding /root/fleet.
  const armedFile = optionalPath(raw["armedFile"], "armedFile", cwd, problems);
  const accessFile = optionalPath(raw["accessFile"], "accessFile", cwd, problems);

  const messageRaw = raw["message"];
  let message: string | undefined;
  if (messageRaw !== undefined) {
    if (typeof messageRaw !== "string" || messageRaw.trim().length === 0) {
      problems.push("message must be a non-empty string when present");
    } else {
      message = messageRaw;
    }
  }

  if (problems.length > 0) return { kind: "invalid", path, problem: problems.join("; ") };

  return {
    kind: "ok",
    path,
    config: {
      intervalSeconds,
      ...(armedFile === undefined ? {} : { armedFile }),
      ...(accessFile === undefined ? {} : { accessFile }),
      ...(message === undefined ? {} : { message }),
    },
  };
}

/**
 * Whether this tick sends, and why — the whole decision, with no clock, no
 * filesystem and no session in it. The interesting part of a heartbeat is the
 * precedence between "paused", "not armed", "channel down" and "already
 * pending", and that is worth being able to test without a session at all.
 *
 * `armed` and `channelOk` are the *satisfied* gates, not the files behind them:
 * a config with no `armedFile` passes the first, and one with no `accessFile`
 * passes the second. The fleet deploy always configures `accessFile` — an
 * orchestrator that can page nobody must not dispatch — so an unconfigured
 * channel gate means "this session is not the fleet", not "the check is off".
 */
export function tickDecision(input: {
  paused: boolean;
  armed: boolean;
  channelOk: boolean;
  hasPending: boolean;
}): {
  send: boolean;
  reason: string;
} {
  if (input.paused) return { send: false, reason: "paused" };
  if (!input.armed) return { send: false, reason: "not armed" };
  if (!input.channelOk) return { send: false, reason: "escalation channel down" };
  if (input.hasPending) return { send: false, reason: "tick already pending" };
  return { send: true, reason: "armed, nothing pending" };
}

/**
 * Whether the Telegram bridge can still reach a person: enabled, with exactly
 * one paired owner.
 *
 * Fail-closed, and every failure mode collapses to the same answer on purpose —
 * missing file, truncated write, hand-edit that dropped `enabled`, a second
 * chat id pasted in, or the pairing revoked. Distinguishing them would only
 * tempt a future reader into treating one of them as benign, and none of them
 * are: each one means a tier-2 escalation lands nowhere.
 *
 * Re-read on every tick rather than cached at session start, because the bridge
 * is reconfigured by a long-lived operator out-of-band and a heartbeat that
 * trusted a startup snapshot would keep dispatching for days after the channel
 * went away.
 */
function channelIsUp(path: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const access = parsed as { readonly [key: string]: unknown };
  if (access["enabled"] !== true) return false;
  const allowFrom = access["allowFrom"];
  return Array.isArray(allowFrom) && allowFrom.length === 1;
}

/**
 * One tick: gather the four facts, ask `tickDecision`, log the reason either
 * way. Skips are deliberately silent in the UI — a paused fleet would otherwise
 * emit a notification every interval, forever.
 */
function tick(pi: TickApi, ctx: TickContext, config: TickConfig): void {
  const decision = tickDecision({
    paused: isPaused(),
    armed: config.armedFile === undefined || existsSync(config.armedFile),
    channelOk: config.accessFile === undefined || channelIsUp(config.accessFile),
    hasPending: ctx.hasPendingMessages(),
  });

  if (!decision.send) {
    pi.logger.info(`[omp-conductor] tick skipped: ${decision.reason}`, { reason: decision.reason });
    return;
  }

  const content = config.message ?? defaultTickMessage(new Date());
  pi.sendMessage(
    { customType: TICK_CUSTOM_TYPE, content, display: true, attribution: "user" },
    { triggerTurn: true, deliverAs: "followUp" },
  );
  pi.logger.info(`[omp-conductor] tick sent: ${decision.reason}`, { reason: decision.reason });
}

export default function orchestratorTickExtension(pi: TickApi): void {
  // Scoped to this registration rather than the module, so a second
  // `session_start` cannot install a second heartbeat on the same session.
  let armed = false;

  pi.on("session_start", (_event, ctx) => {
    if (armed) return;

    const result = readTickConfig(ctx.cwd);

    if (result.kind === "absent") {
      pi.logger.info(`[omp-conductor] orchestrator tick inactive: no ${TICK_CONFIG_FILE} in ${ctx.cwd}`);
      return;
    }

    if (result.kind === "invalid") {
      const detail = `${result.path}: ${result.problem}`;
      pi.logger.error(`[omp-conductor] orchestrator tick disabled — ${detail}`);
      // The one notification this extension ever raises: a broken heartbeat
      // config is silent failure otherwise, and silence is what it is for.
      ctx.ui.notify(`omp-conductor: orchestrator tick disabled — ${detail}`, "error");
      return;
    }

    const config = result.config;
    ctx.setInterval(() => tick(pi, ctx, config), config.intervalSeconds * 1000);
    armed = true;
    // Both gates are named at startup: "why is it not ticking?" is answered by
    // looking at the files this line lists, and an unset channel gate on a fleet
    // host is visible here rather than only in its absence.
    const gates = [
      config.armedFile === undefined ? undefined : `armed marker ${config.armedFile}`,
      config.accessFile === undefined ? "no escalation-channel gate" : `escalation channel ${config.accessFile}`,
    ].filter((g) => g !== undefined);
    pi.logger.info(
      `[omp-conductor] orchestrator tick active: every ${config.intervalSeconds}s, gated on ${gates.join(" + ")}`,
    );
  });
}
