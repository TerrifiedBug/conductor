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
 * Beyond those four gates, every tick carries the project's `reporting.scope`
 * as one explicit constraint line, re-read from the conductor config on each
 * tick so a `/conductor setup` change binds the next heartbeat rather than
 * waiting for a session restart — and one delivery rule
 * ({@link TICK_DELIVERY_RULE}), because a tick is injected locally and a report
 * written as end-of-turn text on such a turn reaches nobody. An operator's own
 * `message` replaces both, and is re-read per tick for the same reason.
 *
 * The extension is inert unless `<cwd>/.conductor-tick.json` exists, so shipping
 * it inside `omp-conductor` costs an ordinary session nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { findProject, loadConfig } from "./config.ts";
import { isPaused } from "./daemon.ts";
import { DEFAULT_REPORT_SCOPE, type ReportScope } from "./types.ts";

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
  /**
   * Whether a UI is attached — false in print/RPC mode, and false for every
   * subagent. Typed as the SDK types it: `ExtensionContext.hasUI: boolean`,
   * `@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts:424-425`.
   */
  hasUI: boolean;
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
  /**
   * The currently active tool names. Typed as the SDK types it:
   * `ExtensionAPI.getActiveTools(): string[]`,
   * `@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts:1267-1268`.
   */
  getActiveTools(): string[];
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

/**
 * The prompt when the config names none. The timestamp is what makes two
 * consecutive ticks distinguishable in the session log.
 *
 * Deliberately silent about reporting volume: that clause is
 * {@link TICK_SCOPE_CONSTRAINTS}, appended per tick from the configured scope.
 * A second spelling of it here would contradict the first inside one prompt the
 * moment a fleet chose `escalations`.
 */
export function defaultTickMessage(now: Date): string {
  return `Tick ${now.toISOString()}: run your standing loop from ORCHESTRATOR.md now.`;
}

/**
 * The reporting contract, one line per scope, appended to the tick prompt.
 *
 * This is the whole of what `reporting.scope` does at tick time: it constrains
 * what the turn is allowed to say, in the session that reads it. It is not an
 * outbound filter — nothing downstream drops a report the orchestrator decides
 * to send anyway.
 *
 * A mapped type rather than a plain object, so adding a member to
 * `REPORT_SCOPES` fails to compile here instead of resolving to `undefined` at
 * the point of use.
 */
export const TICK_SCOPE_CONSTRAINTS: { readonly [K in ReportScope]: string } = {
  material: "Report material events per your brief.",
  escalations:
    "Report NOTHING this turn except a Tier 1 or Tier 2 escalation; everything else -- releases included -- waits for the daily digest.",
};

/**
 * The delivery clause, appended to every default tick prompt.
 *
 * End-of-turn text streams to the operator's Telegram only on a turn that
 * *began* as an inbound Telegram message. A heartbeat tick is injected locally,
 * so it is never such a turn, and a session that believes otherwise reports
 * into a void: on 2026-08-06 the fleet this extension runs produced a release
 * report and two tier-2 escalations as end-of-turn text, and not one of the
 * three reached anybody. What makes a report real is a tool call the session
 * watched succeed, so the prompt says so on every tick rather than trusting a
 * brief that can drift, be edited, or be compacted away.
 */
export const TICK_DELIVERY_RULE =
  "This tick was injected locally, not sent from Telegram, so your end-of-turn text does NOT reach your operator. Deliver anything reportable this turn by calling the telegram_send tool and confirming success; never claim a report was sent otherwise.";

/**
 * The scope this tick carries, and — when it had to fall back — why.
 *
 * Read on every tick rather than cached at session start, for the reason the
 * channel gate is: the operator re-runs `/conductor setup` while this session
 * lives, and a heartbeat holding a startup snapshot would keep injecting the
 * old contract until somebody restarted it.
 *
 * Every fault collapses to {@link DEFAULT_REPORT_SCOPE}: no config written yet,
 * an unreadable or invalid one, or several projects with none named — the same
 * ambiguity `findProject` refuses to guess through for `status`. Stopping the
 * heartbeat over a reporting preference would be the worse trade.
 */
export function resolveTickScope(): { scope: ReportScope; fallback?: string } {
  try {
    return { scope: findProject(loadConfig()).reporting?.scope ?? DEFAULT_REPORT_SCOPE };
  } catch (err) {
    return { scope: DEFAULT_REPORT_SCOPE, fallback: err instanceof Error ? err.message : String(err) };
  }
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
  // the config that names them (`state/armed`) without hard-coding a deploy path.
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
 * The operator's own prompt for this tick, re-read from the session cwd rather
 * than taken from the startup snapshot — for the reason {@link resolveTickScope}
 * and the channel gate re-read: the operator of a 24/7 session reconfigures it
 * out-of-band, and a heartbeat holding a startup copy would keep injecting last
 * week's prompt until somebody restarted the session.
 *
 * A re-read that succeeds owns the answer, "no `message` key any more" included:
 * deleting the override hands the prompt back to the shipped default. A re-read
 * that fails keeps the startup value — a mid-edit truncation, a file moved away
 * or a fault the validator collects must not stop the heartbeat, and must not
 * silently swap the operator's prompt for ours over a transient bad read.
 *
 * `intervalSeconds` is deliberately *not* re-read here: rescheduling a live
 * managed timer is a different change, so a period edit still needs a restart.
 */
function currentMessage(cwd: string, startup: TickConfig): string | undefined {
  const reread = readTickConfig(cwd);
  return reread.kind === "ok" ? reread.config.message : startup.message;
}

/**
 * One tick: gather the four facts, ask `tickDecision`, log the reason either
 * way. Skips are deliberately silent in the UI — a paused fleet would otherwise
 * emit a notification every interval, forever.
 *
 * `session` holds the only thing one tick remembers for the next: whether the
 * scope fallback has been logged. Without it, a host with no conductor config
 * would repeat the same line about the same missing file every interval, for as
 * long as the session lives.
 */
function tick(pi: TickApi, ctx: TickContext, config: TickConfig, session: { scopeFallbackLogged: boolean }): void {
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

  // A configured message owns the whole contract, reporting and delivery clauses
  // included: an operator who wrote their own prompt did not ask for ours
  // appended to it.
  let content = currentMessage(ctx.cwd, config);
  if (content === undefined) {
    const scope = resolveTickScope();
    if (scope.fallback !== undefined && !session.scopeFallbackLogged) {
      session.scopeFallbackLogged = true;
      pi.logger.info(`[omp-conductor] tick reporting scope: using ${DEFAULT_REPORT_SCOPE} — ${scope.fallback}`);
    }
    content = `${defaultTickMessage(new Date())}\n${TICK_SCOPE_CONSTRAINTS[scope.scope]}\n${TICK_DELIVERY_RULE}`;
  }

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
  // Held per registration for the same reason: the "using the default reporting
  // scope, because ..." line is logged once for this heartbeat, and a second
  // session in the same process starts with its own count.
  const session = { scopeFallbackLogged: false };

  pi.on("session_start", (_event, ctx) => {
    if (armed) return;

    // A subagent inherits the orchestrator's cwd, so it finds the same
    // activation file and would arm a heartbeat of its own — one extra tick
    // per worker, each prompting a session whose whole contract is to finish
    // and yield. The discriminator is the one omp-telegram has been running in
    // production: task sessions are headless *and* always carry the `yield`
    // tool. Neither half suffices alone — a headless root session (print/RPC
    // mode) has no `yield`, and an
    // interactive session may well have one. Checked before the config read
    // so the overwhelmingly common case never touches the filesystem.
    if (!ctx.hasUI && pi.getActiveTools().includes("yield")) {
      pi.logger.info("[omp-conductor] tick inert: subagent session");
      return;
    }

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
    ctx.setInterval(() => tick(pi, ctx, config, session), config.intervalSeconds * 1000);
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
