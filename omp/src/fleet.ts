/**
 * Operator surface for the two-process fleet: dispatch daemon + orchestrator
 * pane. Issue #61 — one answer to "stop the conductor" without naming four
 * files and units.
 *
 * Verbs:
 * - hold          — pause claiming AND disarm ticks; processes stay up
 * - halt          — hold, then stop the dispatch daemon (systemctl-aware)
 * - halt --pane   — pin recovery first, stop the exact omp conductor agent,
 *                   never systemctl stop herdr-fleet
 * - arm / disarm  — first-class armed marker (arm is inbound Telegram proof)
 * - releaseHold   — clear pause only; never re-arms
 * - release-pane  — clear the halt --pane recovery pin
 */

import { spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { findProject, loadConfig, stateDir } from "./config.ts";
import { isPaused, setPaused, statusSnapshot, type StatusSnapshot } from "./daemon.ts";
import {
  healthCheck,
  livingDaemon,
  stopDaemon,
  type StopResult,
  SYSTEMD_UNIT,
} from "./lifecycle.ts";
import {
  readTickConfig,
  TICK_CONFIG_FILE,
  type TickConfig,
  type TickConfigResult,
} from "./orchestrator-tick.ts";

export const PANE_HALT_FILE = ".conductor-pane-halted";
export const DEFAULT_HERDR_UNIT = "herdr-fleet.service";

/**
 * Agent name assumed when no tick config names one. Mirrors
 * `herdr-conductor`'s own `AGENT_NAME=${AGENT_NAME:-fleet}` default — a
 * documented default, not a guess. An *invalid* config is a different thing
 * and makes {@link stopConductorPane} refuse.
 */
export const DEFAULT_FLEET_AGENT_NAME = "fleet";
export const ARM_CHALLENGE_TIMEOUT_MS = 300_000;

export function telegramStateDir(): string {
  const override = process.env["OMP_TELEGRAM_STATE_DIR"];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".omp", "agent", "telegram");
}

export function tickConfigSearchRoots(projectName?: string): string[] {
  const roots: string[] = [stateDir()];
  try {
    const p = findProject(loadConfig(), projectName);
    const parent = dirname(p.workspaceRoot);
    if (parent !== roots[0]) roots.push(parent);
    if (p.workspaceRoot !== roots[0] && p.workspaceRoot !== parent) roots.push(p.workspaceRoot);
  } catch {
    /* no config */
  }
  return roots;
}

export type ResolvedTick =
  | { kind: "absent" }
  | { kind: "invalid"; path: string; cwd: string; problem: string }
  | { kind: "ok"; path: string; cwd: string; config: TickConfig };

export function resolveTickConfig(projectName?: string): ResolvedTick {
  for (const cwd of tickConfigSearchRoots(projectName)) {
    const r: TickConfigResult = readTickConfig(cwd);
    if (r.kind === "ok") return { kind: "ok", path: r.path, cwd, config: r.config };
    if (r.kind === "invalid") return { kind: "invalid", path: r.path, cwd, problem: r.problem };
  }
  return { kind: "absent" };
}

export function armedMarkerPath(projectName?: string): string {
  const tick = resolveTickConfig(projectName);
  if (tick.kind === "ok" && tick.config.armedFile !== undefined) return tick.config.armedFile;
  return join(stateDir(), "armed");
}

export function disarmTicks(projectName?: string): { path: string; wasArmed: boolean } {
  const path = armedMarkerPath(projectName);
  const wasArmed = existsSync(path);
  rmSync(path, { force: true });
  return { path, wasArmed };
}

export interface ArmResult {
  path: string;
  alreadyArmed: boolean;
  owner: string;
  challenge: string;
}

export interface ArmDeps {
  sendChallenge?: (token: string, owner: string, text: string) => Promise<void>;
  waitForUserTurn?: (transcript: string, code: string, timeoutMs: number) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export async function armTicks(projectName?: string, deps: ArmDeps = {}): Promise<ArmResult> {
  const tick = resolveTickConfig(projectName);
  if (tick.kind === "invalid") {
    throw new Error(`tick config invalid at ${tick.path}: ${tick.problem}`);
  }
  if (tick.kind === "absent") {
    throw new Error(
      `no ${TICK_CONFIG_FILE} under ${tickConfigSearchRoots(projectName).join(" or ")} — ` +
        `nothing would read an arm marker; drop a tick config first`,
    );
  }
  if (tick.config.armedFile === undefined) {
    throw new Error(`${tick.path} has no armedFile — this heartbeat is ungated; add armedFile before arming`);
  }
  if (tick.config.accessFile === undefined) {
    throw new Error(`${tick.path} has no accessFile — arm cannot prove an inbound channel without it`);
  }

  const channel = readPairedChannel(tick.config.accessFile);
  if (channel.kind === "down") {
    throw new Error(
      `escalation channel is not up (${tick.config.accessFile}): ${channel.reason} — ` +
        `pair the bot (/telegram pair) and enable the bridge (/telegram on) before arming`,
    );
  }

  const token = readBotToken();
  if (token === undefined) {
    throw new Error(
      `no TELEGRAM_BOT_TOKEN in ${join(telegramStateDir(), ".env")} — the arm challenge cannot send without it`,
    );
  }

  const transcript = newestSessionTranscript(tick.cwd);
  if (transcript === undefined) {
    throw new Error(
      `no orchestrator session transcript under ${sessionDirForCwd(tick.cwd)} — ` +
        `the inbound proof is read from a user turn there. Start the pane orchestrator, let it settle, then arm again`,
    );
  }

  const path = tick.config.armedFile;
  const alreadyArmed = existsSync(path);
  const code = makeChallengeCode();
  const text =
    `Fleet arming check. Reply to this chat with exactly:\n${code}\n` +
    `Nothing will be dispatched until that reply is seen in the orchestrator session.`;

  const send = deps.sendChallenge ?? sendTelegramMessage;
  try {
    await send(token, channel.owner, text);
  } catch (err) {
    throw new Error(
      `arm: outbound sendMessage failed — NOT armed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const timeoutMs = deps.timeoutMs ?? ARM_CHALLENGE_TIMEOUT_MS;
  const wait = deps.waitForUserTurn ?? ((tr, c, ms) => waitForChallengeInTranscript(tr, c, ms, deps));
  const seen = await wait(transcript, code, timeoutMs);
  if (!seen) {
    throw new Error(
      `arm: the challenge never arrived as a user turn in time — NOT armed.\n` +
        `Inbound Telegram is not reaching the omp session. Check, in order:\n` +
        `  * is the bridge polling?      attach and run: /telegram status\n` +
        `  * is another process holding this bot token? Telegram allows exactly one\n` +
        `    getUpdates consumer and rejects the second with HTTP 409.\n` +
        `  * did you reply in the DM with the bot, not another chat?\n` +
        `transcript: ${transcript}`,
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `armed ${new Date().toISOString()} owner=${channel.owner}\n`, { mode: 0o600 });
  return { path, alreadyArmed, owner: channel.owner, challenge: code };
}

export interface HoldResult {
  wasPaused: boolean;
  disarmed: { path: string; wasArmed: boolean };
}

export interface HaltResult {
  hold: HoldResult;
  stop: StopResult;
}

export interface PaneStopResult {
  pinPath: string;
  /** How the pane was confirmed gone. Failures throw — never silent success. */
  stopped: "herdr-agent" | "already-gone";
  detail: string;
  agentName: string;
}

export interface HaltWithPaneResult extends HaltResult {
  pane: PaneStopResult;
}

export function hold(projectName?: string): HoldResult {
  const wasPaused = isPaused();
  setPaused(true);
  return { wasPaused, disarmed: disarmTicks(projectName) };
}

export function releaseHold(): void {
  setPaused(false);
}

export async function halt(projectName?: string): Promise<HaltResult> {
  const held = hold(projectName);
  const stop = await stopDaemon();
  return { hold: held, stop };
}

/**
 * Where `halt --pane` pins recovery off. This must be the pane's own cwd —
 * `herdr-conductor`'s `recover.sh` only reads `$FLEET_CWD/.conductor-pane-halted`,
 * and the tick config lives in that same directory by construction (the
 * heartbeat extension activates on `.conductor-tick.json` in the session cwd).
 *
 * An *invalid* tick config still names the right directory, so pin beside it
 * rather than in the state dir: the pin has to land somewhere recovery reads
 * before {@link stopConductorPane} refuses over that same invalid config.
 */
export function paneHaltPath(projectName?: string): string {
  const tick = resolveTickConfig(projectName);
  if (tick.kind === "ok" || tick.kind === "invalid") return join(tick.cwd, PANE_HALT_FILE);
  return join(stateDir(), PANE_HALT_FILE);
}

export function pinPaneHalt(projectName?: string): { path: string } {
  const path = paneHaltPath(projectName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      `# Written by omp-conductor halt --pane at ${new Date().toISOString()}`,
      `# herdr-conductor recover.sh must not resume the fleet agent while this file exists.`,
      `# Clear with: omp-conductor release-pane  (or rm this file)`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { path };
}

export function clearPaneHalt(projectName?: string): { path: string; wasHalted: boolean } {
  const path = paneHaltPath(projectName);
  const wasHalted = existsSync(path);
  rmSync(path, { force: true });
  return { path, wasHalted };
}

export interface HerdrAgent {
  name: string;
  paneId: string;
  agent?: string;
  sessionPath?: string;
}

/** The kill syscall, injectable so error mapping is testable without one. */
export type KillFn = (pid: number, sig: NodeJS.Signals | 0) => void;

const realKill: KillFn = (pid, sig) => {
  process.kill(pid, sig);
};

/**
 * What a failed `kill` proves.
 *
 * Only `ESRCH` — "no such process" — proves the process is gone. `EPERM` means
 * it *exists* and merely is not ours to signal; every other errno is an answer
 * we cannot read. Collapsing either into "gone" is how a live conductor gets
 * reported as stopped.
 */
export function classifyKillError(err: unknown): "gone" | "unknown" {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ESRCH" ? "gone" : "unknown";
}

/** Whether `pid` is still running. Throws when the answer cannot be read. */
export function pidLiveness(pid: number, kill: KillFn = realKill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    if (classifyKillError(err) === "gone") return false;
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(`cannot probe pid ${pid} (${code ?? String(err)}) — liveness unknown, not dead`);
  }
}

/**
 * Deliver `sig` to `pid`. An already-gone process is success — that is the
 * outcome we wanted. Every other failure throws: an undelivered signal must
 * never read as a kill.
 */
export function deliverSignal(pid: number, sig: NodeJS.Signals, kill: KillFn = realKill): boolean {
  try {
    kill(pid, sig);
    return true;
  } catch (err) {
    if (classifyKillError(err) === "gone") return true;
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(`cannot send ${sig} to pid ${pid} (${code ?? String(err)})`);
  }
}

export interface PaneStopDeps {
  herdrBin?: string;
  herdrSession?: string;
  /** Deliver a signal. Return `false` or throw when delivery is unproven. */
  signalPid?: (pid: number, sig: NodeJS.Signals) => boolean;
  /** Liveness probe. MUST throw when it cannot tell — never answer `false`. */
  isAlive?: (pid: number) => boolean;
  /** Clock for deterministic deadline tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  listAgents?: () => Promise<HerdrAgent[]>;
  panePids?: (paneId: string) => Promise<number[]>;
}

/**
 * hold + pin recovery first + stop exact omp conductor agent.
 * Never systemctl stop herdr-fleet.
 *
 * Pin is written even when the pane stop throws — recovery stays off so a
 * failed kill cannot be undone by herdr-conductor respawning the agent. The
 * command still fails (throws) so operators never see a green "halted" while
 * the pane is still alive.
 */
export async function haltWithPane(
  projectName?: string,
  deps: PaneStopDeps = {},
): Promise<HaltWithPaneResult> {
  const pin = pinPaneHalt(projectName);
  const result = await halt(projectName);
  // Throws on uncertainty or if the agent survives SIGTERM+SIGKILL.
  const stopped = await stopConductorPane(projectName, deps);
  return { ...result, pane: { pinPath: pin.path, ...stopped } };
}

/**
 * Stop the configured conductor agent only. Recovery must already be pinned.
 *
 * Success returns only when the pane is confirmed gone (`herdr-agent` or
 * `already-gone`). Any uncertainty **throws**: an unparseable tick config (the
 * agent name is then a guess), herdr unreachable, output we cannot read as an
 * explicit agent list, ambiguous identity, a live omp claim with no recognized
 * PID, a liveness probe or signal delivery that fails (`EPERM` is "exists but
 * not ours", never "dead"), or a process that survives SIGKILL. Callers must not treat a thrown
 * error as "maybe stopped".
 */
export async function stopConductorPane(
  projectName?: string,
  deps: PaneStopDeps = {},
): Promise<Omit<PaneStopResult, "pinPath">> {
  const tick = resolveTickConfig(projectName);
  if (tick.kind === "invalid") {
    // The file that names the agent does not parse, so the identity we would
    // stop is a guess. Stopping the wrong pane is worse than refusing.
    throw new Error(
      `halt --pane: tick config invalid at ${tick.path} (${tick.problem}) — ` +
        `the conductor agent name cannot be read, so refusing to stop a guessed identity. ` +
        `Recovery pin was written; fix the config and re-run.`,
    );
  }
  const agentName =
    tick.kind === "ok" && tick.config.agentName !== undefined
      ? tick.config.agentName
      : DEFAULT_FLEET_AGENT_NAME;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const signalPid = deps.signalPid ?? deliverSignal;
  const alive = deps.isAlive ?? pidLiveness;
  const pinned = "Recovery pin was written";

  /** Any-alive across `pids`; an unreadable probe refuses instead of "dead". */
  const anyAlive = (pids: number[], stage: string): boolean => {
    try {
      return pids.some((pid) => alive(pid));
    } catch (err) {
      throw new Error(
        `halt --pane: cannot tell whether the conductor agent is still running ${stage} ` +
          `(${err instanceof Error ? err.message : String(err)}) — refusing to report success. ` +
          `${pinned}; check the pane by hand.`,
      );
    }
  };

  /** Send `sig` to every pid, refusing on any delivery we cannot prove. */
  const deliver = (pids: number[], sig: NodeJS.Signals): void => {
    for (const pid of pids) {
      let delivered: boolean;
      try {
        delivered = signalPid(pid, sig);
      } catch (err) {
        throw new Error(
          `halt --pane: ${sig} to pid ${pid} failed ` +
            `(${err instanceof Error ? err.message : String(err)}) — refusing to report success. ${pinned}.`,
        );
      }
      if (!delivered) {
        throw new Error(
          `halt --pane: ${sig} to pid ${pid} was not delivered — refusing to report success. ${pinned}.`,
        );
      }
    }
  };

  let agents: HerdrAgent[];
  try {
    agents = deps.listAgents ? await deps.listAgents() : await herdrAgentList(deps);
  } catch (err) {
    throw new Error(
      `halt --pane: herdr agent list failed — refusing to guess a pane ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Recovery pin was written; fix herdr and re-run halt --pane or kill the agent by hand.`,
    );
  }

  const matches = agents.filter((a) => a.name === agentName);
  if (matches.length === 0) {
    return { stopped: "already-gone", detail: `no herdr agent named ${agentName}`, agentName };
  }
  if (matches.length > 1) {
    throw new Error(
      `halt --pane: refusing to stop — ${matches.length} herdr agents named ${agentName} (not unique). ` +
        `Recovery pin was written; resolve the identity and re-run or kill by hand.`,
    );
  }
  const claim = matches[0]!;
  if (claim.agent !== "omp") {
    if (claim.agent === undefined || claim.agent === "") {
      // Sticky name after exit — herdr still lists the claim but no live agent.
      return {
        stopped: "already-gone",
        detail: `agent ${agentName} pane ${claim.paneId} has no live agent label (sticky name only)`,
        agentName,
      };
    }
    throw new Error(
      `halt --pane: agent ${agentName} pane ${claim.paneId} is ${claim.agent}, not omp — refusing. ` +
        `Recovery pin was written.`,
    );
  }

  let pids: number[];
  try {
    pids = deps.panePids
      ? await deps.panePids(claim.paneId)
      : await herdrOmpForegroundPids(claim.paneId, deps);
  } catch (err) {
    throw new Error(
      `halt --pane: pane process-info failed for ${claim.paneId} ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Live omp claim exists but PIDs are unknown — refusing to report success. Recovery pin was written.`,
    );
  }

  const live = pids.filter((pid) => anyAlive([pid], `for pane ${claim.paneId}`));
  if (live.length === 0) {
    // Live agent=omp claim but no recognizable omp PID: we cannot prove gone.
    // Treating this as already-gone would exit 0 while the pane may still run.
    throw new Error(
      `halt --pane: agent ${agentName} pane ${claim.paneId} is live omp but no omp foreground PID ` +
        `was recognized — refusing to report success. Recovery pin was written; inspect the pane and kill by hand if needed.`,
    );
  }

  deliver(live, "SIGTERM");
  const softDeadline = now() + 10_000;
  while (now() < softDeadline) {
    if (!anyAlive(live, "after SIGTERM")) {
      return {
        stopped: "herdr-agent",
        detail: `SIGTERM omp in agent ${agentName} pane ${claim.paneId} pids ${live.join(",")}`,
        agentName,
      };
    }
    await sleep(100);
  }

  deliver(live, "SIGKILL");
  const hardDeadline = now() + 2_000;
  while (now() < hardDeadline) {
    if (!anyAlive(live, "after SIGKILL")) {
      return {
        stopped: "herdr-agent",
        detail: `SIGKILL omp in agent ${agentName} pane ${claim.paneId} pids ${live.join(",")} after SIGTERM grace`,
        agentName,
      };
    }
    await sleep(50);
  }

  const survivors = live.filter((pid) => anyAlive([pid], "after SIGKILL"));
  throw new Error(
    `halt --pane: agent ${agentName} pane ${claim.paneId} still alive after SIGTERM+SIGKILL ` +
      `(pids ${survivors.join(",")}). Recovery pin was written; kill by hand before trusting a quiet fleet.`,
  );
}

async function herdrAgentList(deps: PaneStopDeps): Promise<HerdrAgent[]> {
  const bin = deps.herdrBin ?? "herdr";
  const session = deps.herdrSession ?? process.env["HERDR_SESSION"] ?? "fleet";
  const res = spawnSync(bin, ["--session", session, "agent", "list"], {
    encoding: "utf8",
    timeout: 8_000,
    env: process.env,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error((res.stderr ?? res.stdout ?? `herdr exit ${String(res.status)}`).trim());
  }
  // Everything below is fail-closed: only an explicit `agents: []` means "no
  // agents". Empty output, unparseable JSON, a missing `agents` key or a row
  // we cannot read is uncertainty — collapsing any of it to `[]` would report
  // a live conductor pane as `already-gone`.
  const raw = (res.stdout ?? "").trim();
  if (raw.length === 0) {
    throw new Error("herdr agent list printed nothing — cannot tell whether the pane is running");
  }
  let parsed: { result?: { agents?: unknown }; agents?: unknown };
  try {
    parsed = JSON.parse(raw) as { result?: { agents?: unknown }; agents?: unknown };
  } catch (err) {
    throw new Error(
      `herdr agent list output is not JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const list = parsed.result?.agents ?? parsed.agents;
  if (!Array.isArray(list)) {
    throw new Error("herdr agent list output has no `agents` array — unrecognized schema");
  }
  const out: HerdrAgent[] = [];
  for (const row of list) {
    if (row === null || typeof row !== "object") {
      throw new Error("herdr agent list contains a non-object agent row — unrecognized schema");
    }
    const a = row as { readonly [key: string]: unknown };
    const name = a["name"];
    const paneId = a["pane_id"];
    if (typeof name !== "string" || typeof paneId !== "string") {
      throw new Error(
        "herdr agent list row is missing a string `name`/`pane_id` — " +
          "cannot tell whether it is the conductor pane",
      );
    }
    const agent = typeof a["agent"] === "string" ? a["agent"] : undefined;
    let sessionPath: string | undefined;
    const sess = a["agent_session"];
    if (sess !== null && typeof sess === "object") {
      const s = sess as { readonly [key: string]: unknown };
      if (s["source"] === "herdr:omp" && typeof s["value"] === "string") sessionPath = s["value"];
    }
    out.push({
      name,
      paneId,
      ...(agent === undefined ? {} : { agent }),
      ...(sessionPath === undefined ? {} : { sessionPath }),
    });
  }
  return out;
}

async function herdrOmpForegroundPids(paneId: string, deps: PaneStopDeps): Promise<number[]> {
  const bin = deps.herdrBin ?? "herdr";
  const session = deps.herdrSession ?? process.env["HERDR_SESSION"] ?? "fleet";
  const res = spawnSync(bin, ["--session", session, "pane", "process-info", "--pane", paneId], {
    encoding: "utf8",
    timeout: 8_000,
    env: process.env,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error((res.stderr ?? res.stdout ?? `process-info exit ${String(res.status)}`).trim());
  }
  const raw = (res.stdout ?? "").trim();
  if (raw.length === 0) {
    throw new Error(`herdr pane process-info printed nothing for ${paneId}`);
  }
  let parsed: { result?: { process_info?: ProcessInfo }; process_info?: ProcessInfo };
  try {
    parsed = JSON.parse(raw) as { result?: { process_info?: ProcessInfo }; process_info?: ProcessInfo };
  } catch (err) {
    throw new Error(
      `herdr pane process-info output is not JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const info = parsed.result?.process_info ?? parsed.process_info;
  if (info === undefined) {
    throw new Error(`herdr pane process-info has no process_info for ${paneId} — unrecognized schema`);
  }
  return ompPidsFromProcessInfo(info);
}

interface ProcessInfo {
  shell_pid?: number;
  foreground_processes?: ForegroundProc[];
}

interface ForegroundProc {
  pid?: number;
  name?: string;
  argv0?: string;
  argv?: string[];
}

export function ompPidsFromProcessInfo(info: ProcessInfo): number[] {
  const shell = typeof info.shell_pid === "number" ? info.shell_pid : undefined;
  const out: number[] = [];
  for (const proc of info.foreground_processes ?? []) {
    if (typeof proc.pid !== "number" || !Number.isInteger(proc.pid) || proc.pid <= 1) continue;
    if (shell !== undefined && proc.pid === shell) continue;
    if (!isOmpProcess(proc)) continue;
    out.push(proc.pid);
  }
  return out;
}

function isOmpProcess(proc: ForegroundProc): boolean {
  const name = (proc.name ?? "").toLowerCase();
  const argv0 = (proc.argv0 ?? "").toLowerCase();
  const argv = (proc.argv ?? []).map((a) => a.toLowerCase());
  if (name === "omp" || argv0 === "omp" || argv0.endsWith("/omp")) return true;
  if (name === "bun" || argv0 === "bun" || argv0.endsWith("/bun")) {
    if (argv.some((a) => a === "omp" || a.endsWith("/omp") || /(^|\/)omp$/.test(a))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// layered status
// ---------------------------------------------------------------------------

export type DispatchLayer = "running" | "paused" | "stopped";
export type TicksLayer =
  | "armed"
  | "disarmed"
  | "no-heartbeat-config"
  | "invalid-heartbeat-config"
  | "ungated";
export type PaneLayer = "live" | "missing" | "unknown";
export type RecoveryLayer = "pinned" | "clear";
export type HerdrLayer = "active" | "inactive" | "unknown";

export interface FleetLayers {
  dispatch: DispatchLayer;
  ticks: TicksLayer;
  ticksDetail?: string;
  pane: PaneLayer;
  paneDetail?: string;
  recovery: RecoveryLayer;
  recoveryDetail?: string;
  herdr: HerdrLayer;
  herdrDetail?: string;
  armedPath?: string;
  tickConfigPath?: string;
  paneHaltPath?: string;
  paused: boolean;
  daemon: { running: boolean; pid?: number; port?: number };
}

export function fleetLayers(projectName?: string): FleetLayers {
  const rec = livingDaemon();
  const paused = isPaused();
  const dispatch: DispatchLayer = rec === undefined ? "stopped" : paused ? "paused" : "running";

  const tick = resolveTickConfig(projectName);
  let ticks: TicksLayer;
  let ticksDetail: string | undefined;
  let armedPath: string | undefined;
  let tickConfigPath: string | undefined;
  if (tick.kind === "absent") {
    ticks = "no-heartbeat-config";
  } else if (tick.kind === "invalid") {
    ticks = "invalid-heartbeat-config";
    ticksDetail = `${tick.path}: ${tick.problem}`;
    tickConfigPath = tick.path;
  } else {
    tickConfigPath = tick.path;
    armedPath = tick.config.armedFile;
    if (tick.config.armedFile === undefined) {
      ticks = "ungated";
      ticksDetail = "no armedFile in tick config — heartbeat sends without an arm marker";
    } else if (existsSync(tick.config.armedFile)) {
      ticks = "armed";
      ticksDetail = tick.config.armedFile;
    } else {
      ticks = "disarmed";
      ticksDetail = tick.config.armedFile;
    }
  }
  if (armedPath === undefined) armedPath = armedMarkerPath(projectName);

  const haltPath = paneHaltPath(projectName);
  const recoveryPinned = existsSync(haltPath);
  const omp = probeOmpPane();
  let pane: PaneLayer;
  let paneDetail: string | undefined;
  if (omp.kind === "live") {
    pane = "live";
    paneDetail = omp.summary;
  } else if (omp.kind === "missing") {
    pane = "missing";
  } else {
    pane = "unknown";
    paneDetail = omp.reason;
  }

  const herdr = probeHerdrUnit();

  return {
    dispatch,
    ticks,
    ...(ticksDetail === undefined ? {} : { ticksDetail }),
    pane,
    ...(paneDetail === undefined ? {} : { paneDetail }),
    recovery: recoveryPinned ? "pinned" : "clear",
    ...(recoveryPinned ? { recoveryDetail: haltPath } : {}),
    herdr: herdr.kind,
    ...(herdr.detail === undefined ? {} : { herdrDetail: herdr.detail }),
    armedPath,
    ...(tickConfigPath === undefined ? {} : { tickConfigPath }),
    paneHaltPath: haltPath,
    paused,
    daemon: rec === undefined ? { running: false } : { running: true, pid: rec.pid, port: rec.port },
  };
}

export function formatFleetStatus(
  s: StatusSnapshot,
  layers: FleetLayers,
  daemonHealth?: { ok: boolean; body?: string },
): string {
  const tickLine =
    layers.ticksDetail === undefined
      ? `ticks     ${layers.ticks}`
      : `ticks     ${layers.ticks}  (${layers.ticksDetail})`;
  const paneLine =
    layers.paneDetail === undefined
      ? `pane      ${layers.pane}`
      : `pane      ${layers.pane}  (${layers.paneDetail})`;
  const recoveryLine =
    layers.recoveryDetail === undefined
      ? `recovery  ${layers.recovery}`
      : `recovery  ${layers.recovery}  (${layers.recoveryDetail})`;
  const herdrLine =
    layers.herdrDetail === undefined
      ? `herdr     ${layers.herdr}`
      : `herdr     ${layers.herdr}  (${layers.herdrDetail})`;

  let daemonBlock: string;
  if (!layers.daemon.running || layers.daemon.pid === undefined) {
    daemonBlock = "daemon    not running";
  } else {
    const hz =
      daemonHealth === undefined
        ? "unprobed"
        : daemonHealth.ok
          ? `ok  ${daemonHealth.body ?? ""}`.trimEnd()
          : "unreachable — the process is up but not serving";
    daemonBlock = [
      "daemon",
      `  pid       ${layers.daemon.pid}`,
      `  port      ${layers.daemon.port ?? "?"}`,
      `  healthz   ${hz}`,
      `  unit      ${SYSTEMD_UNIT}`,
    ].join("\n");
  }

  return [
    `dispatch  ${layers.dispatch}`,
    tickLine,
    paneLine,
    recoveryLine,
    herdrLine,
    daemonBlock,
    "",
    formatProjectBody(s),
  ].join("\n");
}

function formatProjectBody(s: StatusSnapshot): string {
  const lines = [
    `project   ${s.project}${s.paused ? "  (PAUSED)" : ""}`,
    `config    ${s.configPath}`,
    `state     ${s.stateDir}`,
    "",
    "caps",
    `  workers            ${s.liveWorkers} / ${s.caps.maxConcurrentWorkers}`,
    `  issues today       ${s.runsToday}`,
    s.caps.dailySpendUsd === null
      ? `  spend today        $${s.spendTodayUsd.toFixed(2)} (no daily cap)`
      : `  spend today        $${s.spendTodayUsd.toFixed(2)} / $${s.caps.dailySpendUsd.toFixed(2)}`,
    `  worker max turns   ${s.caps.workerMaxTurns}`,
    `  worker wall clock  ${Math.round(s.caps.workerWallClockMs / 60_000)}m`,
    `  attempts per issue ${s.caps.maxAttemptsPerIssue}`,
    "",
  ];
  if (s.activeRuns.length === 0) {
    lines.push("active runs  (none)");
  } else {
    lines.push("active runs");
    for (const r of s.activeRuns) {
      lines.push(
        `  #${r.issue}  ${r.repo}  ${r.state}  attempt ${r.attempt}  ` +
          `${r.turns} turns  $${r.spendUsd.toFixed(2)}  ${r.branch}` +
          (r.prUrl ? `  ${r.prUrl}` : ""),
      );
    }
  }
  if (s.liveWorkers > 0) {
    lines.push(
      "",
      `deploy    ${s.liveWorkers} live worker(s) — restart salvages dirty trees then orphans the rows; ` +
        `hold and wait for workers 0/${s.caps.maxConcurrentWorkers} when you can drain instead`,
    );
  }
  return lines.join("\n");
}

export async function renderStatus(projectName?: string): Promise<string> {
  const s = statusSnapshot(projectName);
  const layers = fleetLayers(projectName);
  let health: { ok: boolean; body?: string } | undefined;
  const rec = livingDaemon();
  if (rec !== undefined) health = await healthCheck(rec.port);
  return formatFleetStatus(s, layers, health);
}

// ---------------------------------------------------------------------------
// arm proof helpers
// ---------------------------------------------------------------------------

type Channel = { kind: "up"; owner: string } | { kind: "down"; reason: string };

function readPairedChannel(path: string): Channel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { kind: "down", reason: "unreadable or missing access.json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "down", reason: "access.json is not an object" };
  }
  const access = parsed as { readonly [key: string]: unknown };
  if (access["enabled"] !== true) return { kind: "down", reason: "bridge disabled (enabled !== true)" };
  const allowFrom = access["allowFrom"];
  if (!Array.isArray(allowFrom) || allowFrom.length !== 1) {
    return { kind: "down", reason: "allowFrom must hold exactly one paired owner id" };
  }
  const owner = allowFrom[0];
  if (typeof owner !== "string" && typeof owner !== "number") {
    return { kind: "down", reason: "paired owner id is not a string or number" };
  }
  return { kind: "up", owner: String(owner) };
}

function readBotToken(): string | undefined {
  const env = process.env["TELEGRAM_BOT_TOKEN"];
  if (env !== undefined && env.length > 0) return env;
  const file = join(telegramStateDir(), ".env");
  if (!existsSync(file)) return undefined;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^TELEGRAM_BOT_TOKEN=(.*)$/.exec(line.trim());
      if (m?.[1]) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function sessionDirForCwd(cwd: string): string {
  const home = homedir();
  const slug = cwd.startsWith(home) ? cwd.slice(home.length) : cwd;
  return join(home, ".omp", "agent", "sessions", slug.replaceAll("/", "-"));
}

function newestSessionTranscript(cwd: string): string | undefined {
  const dir = sessionDirForCwd(cwd);
  if (!existsSync(dir)) return undefined;
  let best: { path: string; mtime: number } | undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const mtime = statSync(path).mtimeMs;
      if (best === undefined || mtime > best.mtime) best = { path, mtime };
    } catch {
      /* race */
    }
  }
  return best?.path;
}

function makeChallengeCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `FLEET-${hex}`;
}

async function sendTelegramMessage(token: string, owner: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = new URLSearchParams({ chat_id: owner, text });
  const res = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(20_000) });
  const json = (await res.json()) as { ok?: boolean; description?: string };
  if (!res.ok || json.ok !== true) {
    throw new Error(json.description ?? `HTTP ${res.status}`);
  }
}

async function waitForChallengeInTranscript(
  transcript: string,
  code: string,
  timeoutMs: number,
  deps: ArmDeps,
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await transcriptHasUserCode(transcript, code)) return true;
    await sleep(5_000);
  }
  return false;
}

export async function transcriptHasUserCode(path: string, code: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row === null || typeof row !== "object") continue;
      const rec = row as { readonly [key: string]: unknown };
      if (rec["type"] !== "message") continue;
      const message = rec["message"];
      if (message === null || typeof message !== "object") continue;
      const msg = message as { readonly [key: string]: unknown };
      if (msg["role"] !== "user") continue;
      const content = msg["content"];
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part === null || typeof part !== "object") continue;
        const p = part as { readonly [key: string]: unknown };
        if (p["type"] === "text" && typeof p["text"] === "string" && p["text"].includes(code)) {
          return true;
        }
      }
    }
  } finally {
    rl.close();
  }
  return false;
}

// ---------------------------------------------------------------------------
// probes
// ---------------------------------------------------------------------------

function probeHerdrUnit(unit = DEFAULT_HERDR_UNIT): { kind: HerdrLayer; detail?: string } {
  try {
    const res = spawnSync("systemctl", ["is-active", unit], {
      encoding: "utf8",
      timeout: 5_000,
      env: process.env,
    });
    if (res.error) {
      const err = res.error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return { kind: "unknown", detail: "no systemctl" };
      return { kind: "unknown", detail: err.message };
    }
    const out = (res.stdout ?? "").trim();
    if (out === "active") return { kind: "active", detail: unit };
    if (out === "inactive" || out === "failed" || out === "dead") {
      return { kind: "inactive", detail: `${unit} ${out}` };
    }
    return { kind: "unknown", detail: `${unit} ${out || `exit ${String(res.status)}`}` };
  } catch (err) {
    return { kind: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
}

function probeOmpPane():
  | { kind: "live"; summary: string }
  | { kind: "missing" }
  | { kind: "unknown"; reason: string } {
  try {
    const res = spawnSync("pgrep", ["-af", String.raw`bun .*/omp( |$)`], {
      encoding: "utf8",
      timeout: 5_000,
      env: process.env,
    });
    if (res.error) {
      const err = res.error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return { kind: "unknown", reason: "no pgrep" };
      return { kind: "unknown", reason: err.message };
    }
    const lines = (res.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !l.includes("omp-conductor"));
    if (lines.length === 0) return { kind: "missing" };
    const first = lines[0]!;
    const summary = first.length > 100 ? `${first.slice(0, 97)}…` : first;
    return {
      kind: "live",
      summary: lines.length === 1 ? summary : `${summary} (+${lines.length - 1} more)`,
    };
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
}
