/**
 * Self-tick for the fleet orchestrator session.
 *
 * The orchestrator is a 24/7 omp session with a standing brief (composed ORCHESTRATOR.md + POLICY.md)
 * and no user typing into it. A session that is never prompted never runs its
 * loop, so this extension is the heartbeat: every `intervalSeconds` it injects
 * one message that starts a turn.
 *
 * Three properties are worth protecting, and each one is a branch in
 * `tickDecision()`:
 *
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
 *   makes the tick idempotent under slow turns — and, because it is the only
 *   signal in the process that says whether the last prompt was ever consumed,
 *   it doubles as the wedge detector: see {@link STALL_MARKER_FILE}.
 *
 * Beyond those three gates, every tick carries the project's `reporting.scope`
 * as one explicit constraint line, re-read from the conductor config on each
 * tick so a `/conductor setup` change binds the next heartbeat rather than
 * waiting for a session restart — and one delivery rule
 * ({@link TICK_DELIVERY_RULE}), because a tick is injected locally and a report
 * written as end-of-turn text on such a turn reaches nobody. An operator's own
 * `message` replaces both, and is re-read per tick for the same reason.
 *
 * The extension is inert unless `<cwd>/.conductor-tick.json` exists, so shipping
 * it inside `omp-conductor` costs an ordinary session nothing. That file is a
 * property of the *directory*, though, which is why arming is gated on one more
 * question — {@link resolveTickOwnership}: is this session the orchestrator, or
 * merely a session standing in its directory? Without it, a shell opened in the
 * fleet's cwd armed a second heartbeat and, with merge and release delegated in
 * config, believed it held both.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { findProject, loadConfig, resolveReleasePolicy } from "./config.ts";
import {
  briefPathForProject,
  policyPathForProject,
  refreshComposedBriefForProject,
} from "./setup.ts";
import {
  recordReleaseBlock,
  releaseDecision,
  releaseDriftDigestLine,
  type ReleaseDecision,
} from "./release-policy.ts";
import { DEFAULT_RELEASE_POLICY, DEFAULT_REPORT_SCOPE, type FrictionSignal, type ReportScope, type Store } from "./types.ts";
import { dbPath, openStore } from "./store.ts";

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
/** Repetition threshold and windows for Learning-loop friction signals. */
export const FRICTION_MIN_OBSERVATIONS = 3;
export const FRICTION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;
export const FRICTION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1_000;
const FRICTION_DIGEST_LIMIT = 3;

/**
 * How often to re-ask who owns the fleet tick after herdr failed to answer.
 *
 * Retrying rather than latching is the whole point: a declined identity is
 * permanent, an unanswered one is a blip. Cheap enough to run every minute — one
 * short-lived `herdr agent list` — and it stops the moment the answer is
 * definitive, either way.
 */
const RETRY_OWNERSHIP_MS = 60_000;

/**
 * The stall marker — written beside the activation file, in the session cwd —
 * and the number of consecutive coalesced ticks that earn it.
 *
 * This detects a failure that happened. 2026-08-07: the dogfood fleet's
 * orchestrator finished a turn, logged `ui.loop-blocked` immediately after an
 * auto-compaction threshold decision, and never started another. The process
 * stayed alive, so `herdr-conductor`'s recovery — agent listed AND a
 * non-shell foreground process — read healthy, and the dispatch daemon is a
 * different process entirely, so `/healthz` stayed green too. A tick injected
 * two minutes later and an operator's Telegram message five minutes after that
 * both sat unconsumed for 23 minutes, until a manual SIGTERM. This extension
 * had the evidence and threw it away: coalescing logged `tick skipped: tick
 * already pending`, which reads exactly like healthy backpressure.
 *
 * Two in a row is a full hour at the reference 1800s interval — generous by
 * construction, because a turn that legitimately runs an hour belongs to a
 * fleet with larger problems than one spurious marker. The escalation has to
 * leave the session, since a wedged loop cannot report on itself: a file any
 * out-of-process watchdog can stat, plus an error-level line a log scraper can
 * match.
 */
export const STALL_MARKER_FILE = ".conductor-stalled";
export const STALL_TICKS = 2;

/**
 * Written by herdr-conductor `recover.sh` *before* `agent start`, so a resumed
 * fleet can reconcile orphans without waiting a full `intervalSeconds`. Cleared
 * only after a tick is actually sent — a disarmed or channel-down fleet keeps
 * the request until gates pass (or a human removes the file).
 */
export const TICK_REQUESTED_FILE = ".conductor-tick-requested";

/** Runtime heartbeat schedule consumed by `omp-conductor status`. */
export const TICK_STATUS_FILE = ".conductor-tick-status.json";

export interface TickRuntimeStatus {
  pid: number;
  intervalSeconds: number;
  nextTickAt: string;
}

export function readTickRuntimeStatus(cwd: string): TickRuntimeStatus | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(cwd, TICK_STATUS_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const row = parsed as Record<string, unknown>;
  if (
    typeof row["pid"] !== "number" ||
    !Number.isInteger(row["pid"]) ||
    row["pid"] <= 1 ||
    typeof row["intervalSeconds"] !== "number" ||
    !Number.isInteger(row["intervalSeconds"]) ||
    row["intervalSeconds"] < MIN_INTERVAL_SECONDS ||
    typeof row["nextTickAt"] !== "string" ||
    !Number.isFinite(Date.parse(row["nextTickAt"]))
  ) {
    return undefined;
  }
  return {
    pid: row["pid"],
    intervalSeconds: row["intervalSeconds"],
    nextTickAt: row["nextTickAt"],
  };
}

/**
 * The marker's one line after its ISO timestamp, and the middle of the error
 * log. Shared so the file and the log can never describe different failures.
 */
const STALL_DIAGNOSIS = `${STALL_TICKS} ticks queued unconsumed — the agent loop is not draining`;

/**
 * The one skip reason the stall counter reacts to, shared with the decision so
 * a reworded log line cannot silently disarm the detector.
 */
const PENDING_REASON = "tick already pending";

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
   * The session's own transcript path, or `undefined` before anything is written
   * to it. Typed as the SDK types it: `ExtensionContext.sessionManager` is a
   * `ReadonlySessionManager`, whose `getSessionFile(): string | undefined` is at
   * `@oh-my-pi/pi-coding-agent/src/session/session-manager.ts`. Read for one
   * reason — a directory claim that names only a pid tells an operator which
   * process holds the tick but not which session it is.
   */
  sessionManager: { getSessionFile(): string | undefined };
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
  /**
   * The herdr agent name this fleet's orchestrator pane is registered under, and
   * the whole of {@link resolveTickOwnership}'s identity test under herdr.
   * Omitted means {@link DEFAULT_FLEET_AGENT_NAME}, which is
   * `herdr/bin/recover.sh`'s own `AGENT_NAME=${AGENT_NAME:-fleet}` default — the
   * recovery half and the ticking half key on one identity or neither is safe.
   */
  agentName?: string;
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
 * "Re-read … from disk" is an order, not colour. A 24/7 session holds a copy of
 * the brief from its own start (or its last compaction), and a tick that merely
 * says "run your loop" was observed acting on that cached copy first — which
 * means an operator's amendment, or a dated standing task added between ticks,
 * may never bind. The whole point of a file the operator can edit is that the
 * next tick obeys the file, not the memory of it.
 *
 * Deliberately silent about reporting volume: that clause is
 * {@link TICK_SCOPE_CONSTRAINTS}, appended per tick from the configured scope.
 * A second spelling of it here would contradict the first inside one prompt the
 * moment a fleet chose `escalations`.
 */
export function defaultTickMessage(
  now: Date,
  briefPath = "ORCHESTRATOR.md",
  policyPath = "POLICY.md",
): string {
  return (
    `Tick ${now.toISOString()}: re-read ${briefPath} (composed package floor + policy) and ` +
    `${policyPath} (editable fleet policy) from disk, then run your standing loop from them. ` +
    `Learning-loop amendments edit only ${policyPath} — never the package floor.`
  );
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

function frictionLabel(kind: FrictionSignal["kind"]): string {
  if (kind.startsWith("admission:")) return `admission hold ${kind.slice("admission:".length)}`;
  if (kind === "feedback:escalation-should-digest") return "escalations classified as digest material";
  if (kind === "feedback:report-noise") return "tick reports classified as noise";
  return "tick reports classified as surprising";
}

/** Bounded evidence for the existing approval protocol — never an automatic edit. */
export function formatFrictionDigest(signals: readonly FrictionSignal[]): string {
  const shown = signals.slice(0, FRICTION_DIGEST_LIMIT);
  const lines = [
    "Repeated friction observed over the last 7 days (evidence only; not permission to edit policy):",
    ...shown.map((signal) => {
      const issues =
        signal.issues.length === 0 ? "" : `; issues ${signal.issues.map((issue) => `#${issue}`).join(", ")}`;
      const samples = signal.samples.length === 0 ? "" : `; examples: ${signal.samples.join(" | ")}`;
      return (
        `- ${frictionLabel(signal.kind)} — ${signal.observations} observations, ` +
        `${signal.occurrences} affected${issues}${samples}`
      );
    }),
  ];
  if (signals.length > shown.length) lines.push(`- ${signals.length - shown.length} more signal(s) deferred`);
  lines.push(
    "After the tick duties, investigate at most one signal. Use the existing Learning loop only if the recurring cause has a safe POLICY.md remedy; otherwise leave policy unchanged and report or file the underlying product/infra issue through the existing rules.",
  );
  return lines.join("\n");
}

/**
 * The scope this tick carries, where the brief actually lives, and — when the
 * config could not answer — why.
 *
 * Read on every tick rather than cached at session start, for the reason the
 * channel gate is: the operator re-runs `/conductor setup` while this session
 * lives, and a heartbeat holding a startup snapshot would keep injecting the
 * old contract until somebody restarted it.
 *
 * `briefPath` exists because the prompt orders a re-read, and an order must
 * name a file that is really there: the brief lives at
 * `<workspaceRoot>/ORCHESTRATOR.md`, not in the session cwd — the cwd usually
 * holds only an `AGENTS.md` symlink to it. The name is spelled here rather than
 * imported from setup.ts, whose import graph drags the session SDK into an
 * extension that must stay cheap to load.
 *
 * Every fault collapses to {@link DEFAULT_REPORT_SCOPE} and a pathless prompt:
 * no config written yet, an unreadable or invalid one, or several projects with
 * none named — the same ambiguity `findProject` refuses to guess through for
 * `status`. Stopping the heartbeat over either preference would be the worse
 * trade.
 */
export function resolveTickScope(): {
  scope: ReportScope;
  briefPath?: string;
  policyPath?: string;
  projectName?: string;
  fallback?: string;
} {
  try {
    const project = findProject(loadConfig());
    return {
      scope: project.reporting?.scope ?? DEFAULT_REPORT_SCOPE,
      briefPath: briefPathForProject(project),
      policyPath: policyPathForProject(project),
      projectName: project.name,
    };
  } catch (err) {
    return { scope: DEFAULT_REPORT_SCOPE, fallback: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Best-effort recompose of `ORCHESTRATOR.md` from the installed package floor +
 * live `POLICY.md`.
 *
 * Runs on **every** successful send — including ticks that use a custom
 * `message` — so protocol updates land after a package upgrade without waiting for
 * the default prompt path. Failures (no config, no `POLICY.md`, unreadable
 * overlay) are silent: the tick still goes out.
 */
export function refreshComposedBriefBestEffort(): boolean {
  try {
    return refreshComposedBriefForProject(findProject(loadConfig()));
  } catch {
    return false;
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

  const agentRaw = raw["agentName"];
  let agentName: string | undefined;
  if (agentRaw !== undefined) {
    if (typeof agentRaw !== "string" || agentRaw.trim().length === 0) {
      problems.push("agentName must be a non-empty string when present");
    } else {
      agentName = agentRaw.trim();
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
      ...(agentName === undefined ? {} : { agentName }),
    },
  };
}

/**
 * The claim file the non-herdr path uses to make "who is the orchestrator here"
 * answerable from disk. A sibling of the activation file, and dot-prefixed like
 * the rest of that family.
 */
export const TICK_OWNER_FILE = ".conductor-tick-owner.json";

/**
 * The agent name a fleet is registered under when its config names none —
 * `herdr/bin/recover.sh`'s own default (`AGENT_NAME=${AGENT_NAME:-fleet}`).
 */
export const DEFAULT_FLEET_AGENT_NAME = "fleet";

/** A herdr query that hangs would hang session startup, so it is bounded. */
const HERDR_QUERY_TIMEOUT_MS = 3000;

/**
 * One entry of `herdr agent list`, narrowed to the two fields that decide
 * identity.
 *
 * `name` is the *registered agent name* — what `herdr agent start fleet --pane`
 * sets, what `recover.sh` keys every identity decision on, and what an ad-hoc
 * shell in the same directory does not have. herdr's `agent` field is
 * deliberately not read: it is the *runtime*, it says `"omp"` for the real
 * orchestrator and for a pane somebody opened to look at state, and reading it
 * is what made this problem look unfixable.
 */
export interface HerdrPaneAgent {
  paneId: string;
  /** Absent on a pane herdr has no registered name for. */
  name?: string;
}

/** Either the list, or why there is none — never an exception: a herdr that does
 *  not answer is a fact to log, not a session that fails to start. */
export type HerdrAgentList =
  | { kind: "ok"; agents: HerdrPaneAgent[] }
  | { kind: "unavailable"; problem: string };

/**
 * Whether this session may tick in this directory.
 *
 * `declined` carries the whole sentence to log, because the point of the check is
 * that an operator can tell which session is driving the fleet — a decline that
 * does not name the holder answers the question no better than silence did.
 */
export type TickOwnership =
  | { kind: "owner"; note?: string }
  /** Proven not to be the fleet's session. Permanent until this session ends. */
  | { kind: "declined"; reason: string }
  /**
   * Could not be determined — herdr did not answer. Deliberately NOT `declined`:
   * both refuse to tick, but only this one is worth retrying, and conflating
   * them means a single 3-second CLI timeout silently disables the real
   * orchestrator until someone restarts the pane. An unproven identity still
   * must not tick; a heartbeat that stopped for a transient blip and never came
   * back is the exact silent stall this package keeps having to fix.
   */
  | { kind: "unresolved"; reason: string };

/**
 * `herdr agent list`, over the socket herdr injected into this pane's
 * environment.
 *
 * Shelled out rather than spoken over the socket directly: the wire protocol is
 * not a published interface, while the CLI's "one JSON line on stdout" is — it is
 * what `herdr/bin/recover.sh` already parses, envelope and all. `HERDR_BIN_PATH`
 * is honoured for the same reason that script honours it, so both halves of this
 * repo have one spelling of "how do we reach herdr".
 *
 * Synchronous on purpose: it feeds a decision taken inside `session_start`, and a
 * heartbeat that armed first and checked afterwards would tick from the wrong
 * session for the length of the window between.
 */
function readHerdrAgents(env: Record<string, string | undefined>): HerdrAgentList {
  const bin = env["HERDR_BIN_PATH"] ?? "herdr";
  let stdout: string;
  try {
    const run = spawnSync(bin, ["agent", "list"], {
      encoding: "utf8",
      timeout: HERDR_QUERY_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (run.error !== undefined) return { kind: "unavailable", problem: run.error.message };
    if (run.status !== 0) {
      // A signal rather than an exit code when herdr was killed mid-answer; both
      // mean the same thing here, and both belong in the log line an operator
      // reads to find out why the heartbeat stopped.
      const how = run.signal === null || run.signal === undefined ? `exited ${String(run.status)}` : `died on ${run.signal}`;
      const detail = (run.stderr ?? "").trim().split("\n")[0] ?? "";
      return { kind: "unavailable", problem: `\`${bin} agent list\` ${how}${detail.length === 0 ? "" : `: ${detail}`}` };
    }
    stdout = run.stdout ?? "";
  } catch (err) {
    return { kind: "unavailable", problem: err instanceof Error ? err.message : String(err) };
  }

  return parseHerdrAgents(stdout);
}

/**
 * The CLI's single JSON line, as `recover.sh` reads it: the payload is either the
 * envelope's `result` or the object itself, and `agents` is inside it. Anything
 * else is reported rather than guessed at — an agent list that cannot be parsed
 * proves nothing about which pane owns the tick.
 */
export function parseHerdrAgents(stdout: string): HerdrAgentList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return { kind: "unavailable", problem: `agent list was not JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (parsed === null || typeof parsed !== "object") return { kind: "unavailable", problem: "agent list was not an object" };

  const envelope = parsed as { readonly [key: string]: unknown };
  const inner = envelope["result"];
  const payload = (inner !== null && typeof inner === "object" ? inner : envelope) as {
    readonly [key: string]: unknown;
  };
  const rows = payload["agents"];
  if (!Array.isArray(rows)) return { kind: "unavailable", problem: "agent list carried no agents array" };

  const agents: HerdrPaneAgent[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const entry = row as { readonly [key: string]: unknown };
    const paneId = entry["pane_id"];
    if (typeof paneId !== "string" || paneId.length === 0) continue;
    const name = entry["name"];
    // `null` is what herdr reports for an unnamed pane, and it means the same
    // thing as the key being absent: this pane is not a registered agent.
    agents.push({ paneId, ...(typeof name === "string" && name.trim().length > 0 ? { name: name.trim() } : {}) });
  }
  return { kind: "ok", agents };
}

/**
 * The herdr half of the decision, with no subprocess in it.
 *
 * Fleet-ness is the *session*, shared by every pane in it, so `HERDR_SESSION` and
 * the cwd cannot distinguish the orchestrator from a shell opened beside it. The
 * pane's registered name can, and it survives a detection gap: herdr counts a
 * pane as an agent terminal on a saved name alone, so the fleet pane is listed
 * with its name even in the moment before its runtime is re-detected.
 */
export function paneOwnership(input: { paneId: string; agentName: string; agents: HerdrPaneAgent[] }): TickOwnership {
  const mine = input.agents.find((a) => a.paneId === input.paneId);
  if (mine?.name === input.agentName) return { kind: "owner" };

  if (mine?.name !== undefined) {
    // A registered agent, just not this fleet's. herdr can name several omp
    // agents in one directory, and requiring merely *a* name would arm each one.
    return {
      kind: "declined",
      reason: `this pane is agent "${mine.name}", not the fleet agent "${input.agentName}" — this session will not tick`,
    };
  }

  const holder = input.agents.find((a) => a.name === input.agentName);
  if (holder !== undefined) {
    return {
      kind: "declined",
      reason: `pane ${holder.paneId} (agent "${input.agentName}") owns the fleet tick here — this session will not tick`,
    };
  }

  // No name here and nobody else holding it: an ad-hoc pane in the fleet's
  // directory, which is exactly the session that must stay inert. Fail-closed,
  // and the fix is named — an orchestrator that lost its registration is one
  // `herdr agent start` from ticking again.
  return {
    kind: "declined",
    reason:
      `this pane is not a registered herdr agent, and no pane is running the fleet agent ` +
      `"${input.agentName}" — register it with \`herdr agent start ${input.agentName} --kind omp --pane ${input.paneId}\`; ` +
      `this session will not tick`,
  };
}

/** The claim on disk. `sessionFile` is for the human reading it — the decision
 *  itself only ever trusts `pid`. */
interface TickOwnerRecord {
  pid: number;
  sessionFile?: string;
  claimedAt: string;
}

/** Whether a pid is running. `EPERM` means it exists and is not ours, which is
 *  still alive; only `ESRCH` proves it is gone. */
function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err !== null && typeof err === "object" && "code" in err && err.code === "EPERM";
  }
}

/**
 * The no-herdr half: claim the directory, and tick only while this process is the
 * live claimant.
 *
 * Liveness is a pid check and never a timestamp. A crashed orchestrator leaves
 * its claim behind, and a claim that expired on age alone would either wedge the
 * fleet until someone deleted a file, or hand ownership to a second session while
 * the first was merely slow.
 */
export function claimTickOwner(input: {
  cwd: string;
  pid: number;
  sessionFile?: string;
  now: Date;
  alive?: (pid: number) => boolean;
}): TickOwnership {
  const alive = input.alive ?? pidIsAlive;
  const path = join(input.cwd, TICK_OWNER_FILE);

  const held = readOwnerRecord(path);
  if (held !== undefined && held.pid !== input.pid && alive(held.pid)) {
    return {
      kind: "declined",
      reason:
        `pid ${held.pid} (claimed ${held.claimedAt}${held.sessionFile === undefined ? "" : `, session ${held.sessionFile}`}) ` +
        `owns the fleet tick in ${input.cwd} — this session will not tick`,
    };
  }

  const record: TickOwnerRecord = {
    pid: input.pid,
    ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
    claimedAt: input.now.toISOString(),
  };
  try {
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    // An unwritable claim leaves this session no worse off than it was before the
    // file existed, and refusing to tick over it would silence a fleet that has
    // no rival at all. Said out loud, because the guard is now only advisory.
    return {
      kind: "owner",
      note: `could not write ${path} (${err instanceof Error ? err.message : String(err)}) — ticking anyway, but a second session here would not be detected`,
    };
  }
  return { kind: "owner" };
}

/** A claim that is missing, unreadable or not shaped like one is no claim: the
 *  caller then takes ownership, which is also how a corrupt file heals. */
function readOwnerRecord(path: string): TickOwnerRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    const raw = parsed as { readonly [key: string]: unknown };
    const pid = raw["pid"];
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
    const sessionFile = raw["sessionFile"];
    const claimedAt = raw["claimedAt"];
    return {
      pid,
      ...(typeof sessionFile === "string" && sessionFile.length > 0 ? { sessionFile } : {}),
      claimedAt: typeof claimedAt === "string" && claimedAt.length > 0 ? claimedAt : "unknown",
    };
  } catch {
    return undefined;
  }
}

/**
 * Who owns the tick in this directory: the whole answer, both paths.
 *
 * Activation is the presence of `.conductor-tick.json` in the session cwd, which
 * is a property of the *directory* — so every omp session started there became a
 * ticker, and with `authority.merge`/`authority.release` delegated, a shell
 * somebody opened to read state believed it could merge and release. The
 * directory cannot identify a session, so this asks something that can: under
 * herdr, the pane's registered agent name; otherwise, a claim on the directory
 * that is only honoured while its claimant is alive.
 *
 * Every collaborator is injectable so the two paths can be tested without a
 * running herdr and without spawning processes to kill.
 */
export function resolveTickOwnership(input: {
  cwd: string;
  agentName: string;
  env: Record<string, string | undefined>;
  pid: number;
  now: Date;
  sessionFile?: string;
  listAgents?: (env: Record<string, string | undefined>) => HerdrAgentList;
  alive?: (pid: number) => boolean;
}): TickOwnership {
  const paneId = input.env["HERDR_PANE_ID"] ?? "";
  if (input.env["HERDR_ENV"] === "1" && paneId.length > 0) {
    const list = (input.listAgents ?? readHerdrAgents)(input.env);
    if (list.kind === "ok") return paneOwnership({ paneId, agentName: input.agentName, agents: list.agents });

    // Fail closed, but not forever. Under herdr this session is one pane of
    // possibly several in the fleet's directory, and an unproven identity is the
    // case this whole check exists for — so it does not tick. It is `unresolved`
    // rather than `declined` because herdr not answering says nothing about who
    // this pane is: the caller retries, and the moment herdr answers the real
    // orchestrator arms. Latching here would mean one CLI timeout stops the
    // fleet until a human notices and restarts the pane.
    return {
      kind: "unresolved",
      reason:
        `cannot yet prove this pane is the fleet agent "${input.agentName}" — ${list.problem} — not ticking until it can`,
    };
  }

  return claimTickOwner({
    cwd: input.cwd,
    pid: input.pid,
    ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
    now: input.now,
    ...(input.alive === undefined ? {} : { alive: input.alive }),
  });
}

/**
 * Whether this tick sends, and why — the whole decision, with no clock, no
 * filesystem and no session in it. The interesting part of a heartbeat is the
 * precedence between "not armed", "channel down" and "already pending", and
 * that is worth being able to test without a session at all.
 *
 * The pause sentinel is deliberately NOT consulted. `pause` is the dispatch
 * daemon's flag — "stop claiming; in-flight work finishes" — and this heartbeat
 * drives a different brain: the supervising session whose duties (groom the
 * queue, drain escalations, report) are exactly the ones that stay useful while
 * dispatch is stopped. Honouring it here shipped once, when the tick-driven
 * session WAS the dispatcher; the day dispatch moved into the daemon, one flag
 * silencing both brains became a starvation bug: a paused fleet's orchestrator
 * could neither groom nor even say it was paused. The operator's lever for this
 * session is the arm marker — `disarm` stops ticks, and only the operator arms.
 *
 * `armed` and `channelOk` are the *satisfied* gates, not the files behind them:
 * a config with no `armedFile` passes the first, and one with no `accessFile`
 * passes the second. The fleet deploy always configures `accessFile` — an
 * orchestrator that can page nobody must not dispatch — so an unconfigured
 * channel gate means "this session is not the fleet", not "the check is off".
 */
export function tickDecision(input: {
  armed: boolean;
  channelOk: boolean;
  hasPending: boolean;
}): {
  send: boolean;
  reason: string;
} {
  if (!input.armed) return { send: false, reason: "not armed" };
  if (!input.channelOk) return { send: false, reason: "escalation channel down" };
  if (input.hasPending) return { send: false, reason: PENDING_REASON };
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
 * Marker writes are best-effort by construction. This runs inside the loop
 * whose whole job is to keep prompting a session; a read-only filesystem, a
 * full disk, or a cwd deleted out from under a long-lived process is not a
 * reason to stop doing that. Both directions log their own failure and carry
 * on — the error line stands as the record either way, and the marker is only
 * the copy an out-of-process watchdog can see.
 */
function writeStallMarker(pi: TickApi, cwd: string): void {
  const path = join(cwd, STALL_MARKER_FILE);
  try {
    writeFileSync(path, `${new Date().toISOString()} ${STALL_DIAGNOSIS}\n`);
  } catch (err) {
    pi.logger.error(`[omp-conductor] could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Cleared by the first consumed tick, whether or not this process wrote it.
 * Recovery normally arrives as a *new* session — the wedged one was SIGTERM'd
 * and its transcript resumed — which starts with a zero counter and its
 * predecessor's marker on disk. Gating removal on this session's own count
 * would strand that file, and a stall marker nobody clears is a stall marker
 * nobody believes.
 */
function clearStallMarker(pi: TickApi, cwd: string): void {
  const path = join(cwd, STALL_MARKER_FILE);
  if (!existsSync(path)) return;
  try {
    rmSync(path, { force: true });
    pi.logger.info("[omp-conductor] orchestrator stall cleared: a tick was consumed");
  } catch (err) {
    pi.logger.error(`[omp-conductor] could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Best-effort, same posture as {@link clearStallMarker}. Leaving the file on a
 * failed unlink means the next successful send retries the clear; that is
 * preferable to treating a recover poke as fire-and-forget when the tick did
 * land.
 */
function clearTickRequest(pi: TickApi, cwd: string): void {
  const path = join(cwd, TICK_REQUESTED_FILE);
  if (!existsSync(path)) return;
  try {
    rmSync(path, { force: true });
    pi.logger.info("[omp-conductor] recover tick request cleared: a tick was sent");
  } catch (err) {
    pi.logger.error(`[omp-conductor] could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Everything one tick remembers for the next. */
interface TickSession {
  /**
   * Whether the reporting-scope fallback has been logged. Without it, a host
   * with no conductor config would repeat the same line about the same missing
   * file every interval, for as long as the session lives.
   */
  scopeFallbackLogged: boolean;
  /** Consecutive {@link PENDING_REASON} skips — see {@link STALL_MARKER_FILE}. */
  pendingSkips: number;
}

/**
 * One tick: gather the three facts, ask `tickDecision`, log the reason either
 * way. Skips are deliberately silent in the UI — a disarmed fleet would
 * otherwise emit a notification every interval, forever.
 */
function tick(pi: TickApi, ctx: TickContext, config: TickConfig, session: TickSession): void {
  const decision = tickDecision({
    armed: config.armedFile === undefined || existsSync(config.armedFile),
    channelOk: config.accessFile === undefined || channelIsUp(config.accessFile),
    hasPending: ctx.hasPendingMessages(),
  });

  if (!decision.send) {
    pi.logger.info(`[omp-conductor] tick skipped: ${decision.reason}`, { reason: decision.reason });
    // Only a coalesced skip counts. "Not armed" and "channel down" say nothing
    // about the queue — they are gates the operator or the bridge closed, and
    // the session behind them may be perfectly awake.
    if (decision.reason !== PENDING_REASON) return;
    session.pendingSkips += 1;
    // Only the crossing writes. A later skip refreshing the timestamp would
    // keep moving "stalled since" forward, and how long it has been wedged is
    // the fact the file is read for.
    if (session.pendingSkips === STALL_TICKS) {
      pi.logger.error(`[omp-conductor] orchestrator stalled: ${STALL_DIAGNOSIS}; see ${STALL_MARKER_FILE}`, {
        reason: decision.reason,
        pendingSkips: session.pendingSkips,
      });
      writeStallMarker(pi, ctx.cwd);
    }
    return;
  }

  // Floor refresh is independent of which prompt we send: a custom message still
  // expects ORCHESTRATOR.md / AGENTS.md to track the installed package.
  refreshComposedBriefBestEffort();

  const scope = resolveTickScope();
  // A configured message owns the ordinary reporting and delivery clauses.
  // Mechanical evidence is different: release-policy drift and repeated
  // operational friction must not disappear because an operator customized the
  // ordinary heartbeat wording.
  let content = currentMessage(ctx.cwd, config);
  if (content === undefined) {
    if (scope.fallback !== undefined && !session.scopeFallbackLogged) {
      session.scopeFallbackLogged = true;
      pi.logger.info(`[omp-conductor] tick reporting scope: using ${DEFAULT_REPORT_SCOPE} — ${scope.fallback}`);
    }
    content = `${defaultTickMessage(new Date(), scope.briefPath, scope.policyPath)}\n${TICK_SCOPE_CONSTRAINTS[scope.scope]}\n${TICK_DELIVERY_RULE}`;
  }
  let frictionStore: Store | undefined;
  let frictionSignals: FrictionSignal[] = [];
  const now = Date.now();
  if (scope.projectName !== undefined) {
    const drift = releaseDriftDigestLine(scope.projectName);
    if (drift !== undefined) content = `${content}\n${drift}`;
    if (existsSync(dbPath())) {
      try {
        frictionStore = openStore(dbPath());
        frictionSignals = frictionStore.pendingFriction(
          scope.projectName,
          now - FRICTION_LOOKBACK_MS,
          FRICTION_MIN_OBSERVATIONS,
          now - FRICTION_COOLDOWN_MS,
        );
        if (frictionSignals.length > 0) content = `${content}\n${formatFrictionDigest(frictionSignals)}`;
      } catch (err) {
        frictionStore?.close();
        frictionStore = undefined;
        pi.logger.error(
          `[omp-conductor] friction digest unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  try {
    pi.sendMessage(
      { customType: TICK_CUSTOM_TYPE, content, display: true, attribution: "user" },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    if (scope.projectName !== undefined && frictionSignals.length > 0) {
      try {
        frictionStore?.markFrictionSurfaced(
          scope.projectName,
          frictionSignals.map((signal) => signal.kind),
          now,
        );
      } catch (err) {
        pi.logger.error(
          `[omp-conductor] friction digest cooldown could not be recorded: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    frictionStore?.close();
  }
  pi.logger.info(`[omp-conductor] tick sent: ${decision.reason}`, { reason: decision.reason });
  // An empty queue at send time is the proof the previous tick was consumed, so
  // this is the only place either the counter or the marker is cleared.
  session.pendingSkips = 0;
  clearStallMarker(pi, ctx.cwd);
  // Recover poke is consumed only on a real send — gates still apply above.
  clearTickRequest(pi, ctx.cwd);
}

function writeTickRuntimeStatus(pi: TickApi, cwd: string, intervalSeconds: number): void {
  const path = join(cwd, TICK_STATUS_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  const status: TickRuntimeStatus = {
    pid: process.pid,
    intervalSeconds,
    nextTickAt: new Date(Date.now() + intervalSeconds * 1000).toISOString(),
  };
  try {
    writeFileSync(tmp, `${JSON.stringify(status)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    pi.logger.error(`[omp-conductor] could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Arm the interval heartbeat, then honour a recover poke if one is waiting.
 * Extracted so the ownership-retry path and the immediate-accept path cannot
 * drift: both must fire the same "do not wait a full interval after resume"
 * behaviour.
 */
function armTickHeartbeat(pi: TickApi, ctx: TickContext, config: TickConfig, session: TickSession): void {
  writeTickRuntimeStatus(pi, ctx.cwd, config.intervalSeconds);
  ctx.setInterval(() => {
    try {
      tick(pi, ctx, config, session);
    } finally {
      writeTickRuntimeStatus(pi, ctx.cwd, config.intervalSeconds);
    }
  }, config.intervalSeconds * 1000);
  if (!existsSync(join(ctx.cwd, TICK_REQUESTED_FILE))) return;
  pi.logger.info("[omp-conductor] tick requested by recover — firing without waiting for the interval");
  tick(pi, ctx, config, session);
}

export default function orchestratorTickExtension(pi: TickApi): void {
  // Scoped to this registration rather than the module, so a second
  // `session_start` can neither install a second heartbeat on the same session
  // nor repeat the ownership decline — which is logged exactly once, because it
  // is the line that tells an operator which session is driving the fleet.
  let decided = false;
  // Held per registration for the same reason: the "using the default reporting
  // scope, because ..." line is logged once for this heartbeat, and the stall
  // counter is about this session's own queue. A second session in the same
  // process starts with both at zero.
  const session: TickSession = { scopeFallbackLogged: false, pendingSkips: 0 };
  let releaseGateArmed = false;
  // An activation file makes this a fleet directory before Herdr can prove
  // which pane owns it. The gate therefore starts closed and only honours an
  // operator-brief policy after ownership is accepted.
  let releaseAuthorityAccepted = false;
  const armReleaseGate = (): void => {
    if (releaseGateArmed) return;
    releaseGateArmed = true;
    (pi as TickApi & {
      on(
        event: "tool_call",
        handler: (
          event: { toolName: string; input: Record<string, unknown> },
          ctx: unknown,
        ) => ReleaseDecision | undefined,
      ): void;
    }).on("tool_call", (event) => {
      // Most tool calls are ordinary tracker/file work. Detect shape first so
      // they do not re-read config or emit policy diagnostics.
      const candidate = releaseDecision(DEFAULT_RELEASE_POLICY, event.toolName, event.input);
      if (candidate === undefined) return undefined;
      let projectName: string | undefined;
      let policy = DEFAULT_RELEASE_POLICY;
      let external = true;
      try {
        const project = findProject(loadConfig());
        projectName = project.name;
        policy = resolveReleasePolicy(project);
        external = project.escalation.orchestrator === "external";
      } catch (err) {
        // A missing/unreadable config cannot open a release gate. Log only when
        // a release-shaped call actually reaches this handler.
        pi.logger.error(
          `[omp-conductor] release policy unreadable; enforcing ${DEFAULT_RELEASE_POLICY}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (releaseAuthorityAccepted && policy === "operator-brief") return undefined;
      // Embedded orchestrators carry the same tripwire inline through
      // `createSession`; suppress this second copy only after this session has
      // proved it owns the external heartbeat.
      if (releaseAuthorityAccepted && !external) return undefined;
      if (projectName !== undefined) {
        try {
          recordReleaseBlock(projectName, "orchestrator", candidate.shape);
        } catch (err) {
          pi.logger.error(
            `[omp-conductor] could not record release-policy block: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return candidate.decision;
    });
  };

  pi.on("session_start", (_event, ctx) => {
    if (decided) return;

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

    // Present but invalid still identifies a fleet directory. Install the
    // fail-closed handler before validation or ownership can return early.
    armReleaseGate();

    if (result.kind === "invalid") {
      const detail = `${result.path}: ${result.problem}`;
      pi.logger.error(`[omp-conductor] orchestrator tick disabled — ${detail}`);
      // The one notification this extension ever raises: a broken heartbeat
      // config is silent failure otherwise, and silence is what it is for.
      ctx.ui.notify(`omp-conductor: orchestrator tick disabled — ${detail}`, "error");
      return;
    }

    const config = result.config;

    // Activation is a property of the directory, so every omp session started in
    // the fleet's cwd used to become a ticker — and with merge and release
    // delegated in config, a shell opened beside the orchestrator believed it
    // held both. Asked after the config read because the config names the agent,
    // and before the timer because arming first is the bug.
    const agentName = config.agentName ?? DEFAULT_FLEET_AGENT_NAME;
    const resolve = (): TickOwnership =>
      resolveTickOwnership({
        cwd: ctx.cwd,
        agentName,
        env: process.env,
        pid: process.pid,
        now: new Date(),
        ...(ctx.sessionManager.getSessionFile() === undefined
          ? {}
          : { sessionFile: ctx.sessionManager.getSessionFile() }),
      });

    const ownership = resolve();

    // Only a definitive answer is final. "You are not the fleet agent" cannot
    // become untrue while this session lives, so it latches. "herdr did not
    // answer" says nothing about identity, so it must not — otherwise one CLI
    // timeout at session start is indistinguishable from a fleet that was never
    // meant to tick, and the heartbeat is gone until a human notices.
    if (ownership.kind === "unresolved") {
      pi.logger.info(`[omp-conductor] orchestrator tick pending: ${ownership.reason}`, { agentName });
      // Faster than the tick interval so a blip costs a minute rather than a
      // whole cycle, and never slower than one — a fleet on a short interval
      // should not wait longer to recover than it would to tick.
      const retryMs = Math.min(RETRY_OWNERSHIP_MS, config.intervalSeconds * 1000);
      // Disarmed by a flag, not `clearInterval`: `ctx.setInterval` hands back an
      // opaque handle precisely because the harness owns timer lifecycle and
      // clears them on `session_shutdown`. A settled retry is a no-op that costs
      // one boolean per minute until the session ends.
      let settled = false;
      ctx.setInterval(() => {
        if (settled) return;
        const next = resolve();
        if (next.kind === "unresolved") return; // already logged once; stay quiet
        settled = true;
        if (next.kind === "declined") {
          pi.logger.info(`[omp-conductor] orchestrator tick inactive: ${next.reason}`, { agentName });
          return;
        }
        if (next.note !== undefined) pi.logger.error(`[omp-conductor] tick ownership: ${next.note}`);
        releaseAuthorityAccepted = true;
        armTickHeartbeat(pi, ctx, config, session);
        pi.logger.info(`[omp-conductor] orchestrator tick active: ownership resolved on retry`, { agentName });
      }, retryMs);
      decided = true;
      return;
    }

    if (ownership.kind === "declined") {
      decided = true;
      pi.logger.info(`[omp-conductor] orchestrator tick inactive: ${ownership.reason}`, { agentName });
      return;
    }
    if (ownership.note !== undefined) pi.logger.error(`[omp-conductor] tick ownership: ${ownership.note}`);
    releaseAuthorityAccepted = true;
    armTickHeartbeat(pi, ctx, config, session);
    decided = true;
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
