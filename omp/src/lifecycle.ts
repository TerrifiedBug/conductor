/**
 * Lifecycle for the standalone daemon: start it in the background, prove it
 * came up, stop it, and answer "is it running?" honestly.
 *
 * The record under the runtime directory is a hint, never a fact. A pidfile
 * outlives the process that wrote it — a crash, a reboot, an OOM kill all
 * leave one behind — and pids are recycled, so the file's *existence* says
 * nothing. Every read probes the pid before believing the record; a stale
 * entry is cleared rather than honoured, because the two failures that cost an
 * operator real time are `start` refusing against a ghost and `status`
 * reporting a daemon that died hours ago.
 *
 * When the live pid is the MainPID of the `omp-conductor.service` unit,
 * `stop`/`restart` go through `systemctl` rather than a raw `SIGTERM`. A
 * raw signal against a unit with `Restart=on-failure` is read as a crash and
 * the unit comes straight back — the bug that made `omp-conductor stop` look
 * like a no-op on a systemd-managed host.
 *
 * Deliberately free of every other module in this package: nothing here opens
 * the store, loads the config or talks to `gh`, so `stop` and `status` keep
 * working when the config is the very thing that is broken.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The systemd unit name operators are expected to install for a supervised
 * daemon. Hardcoded rather than configured: one name on the host is the
 * whole point of a unit, and a wrong name would silently fall back to the
 * SIGTERM path and reintroduce the restart loop this module exists to avoid.
 */
export const SYSTEMD_UNIT = "omp-conductor.service";

/**
 * Mirrors `DEFAULT_PORT` in ./daemon.ts. Duplicated rather than imported so
 * this module stays free of the dispatcher's dependency tree; exported so the
 * CLI can name the port a foreground daemon will serve on without adding a
 * third literal.
 * // ponytail: two constants that must agree. If a third *definition* ever
 * // appears, move it into ./types.ts and import it everywhere.
 */
export const DEFAULT_PORT = 8787;

/** How long `startDaemon` waits for the first successful `/healthz`. */
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 250;

/** `/healthz` is a local, in-memory answer; a slow one means something is wrong. */
const HEALTH_TIMEOUT_MS = 1_500;

/** Default grace period between `SIGTERM` and `SIGKILL`. */
const STOP_TIMEOUT_MS = 10_000;

/** Bytes of `daemon.log` quoted back when the daemon dies during boot. */
const LOG_TAIL_BYTES = 4_096;

/**
 * Where the pidfile and the log live. Sits under `~/.omp/run/daemons/` with
 * the other omp daemons rather than beside the config, because this is
 * runtime state that is meaningless after a reboot — the config directory is
 * for things worth keeping.
 */
export function runtimeDir(): string {
  const override = process.env["OMP_CONDUCTOR_RUNTIME_DIR"];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".omp", "run", "daemons", "omp-conductor");
}

/** What a running daemon was started with, as far as the pidfile knows. */
export interface DaemonRecord {
  pid: number;
  port: number;
  project?: string;
  startedAt: number;
  logFile: string;
}

function recordPath(): string {
  return join(runtimeDir(), "daemon.json");
}

/** Creates the runtime directory 0700; only chmods what this call created. */
function ensureRuntimeDir(): string {
  const dir = runtimeDir();
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask, so fix up what we made; an existing
  // directory keeps whatever the operator chose for it.
  if (created !== undefined) chmodSync(dir, 0o700);
  return dir;
}

/**
 * Reads the pidfile. Every failure — absent, unreadable, truncated mid-write,
 * hand-edited into nonsense — is the same answer: `undefined`. A lifecycle
 * command that throws because a runtime file is garbage is a lifecycle command
 * that cannot clean up after itself.
 */
export function readRecord(): DaemonRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recordPath(), "utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const r = parsed as Record<string, unknown>;

  const pid = r["pid"];
  const port = r["port"];
  const startedAt = r["startedAt"];
  const logFile = r["logFile"];
  const project = r["project"];

  // pid 0 and 1 are never ours: 0 means "this process group" to `kill`, which
  // would make a corrupt file signal the whole group.
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return undefined;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined;
  if (typeof logFile !== "string" || logFile.length === 0) return undefined;
  if (project !== undefined && typeof project !== "string") return undefined;

  return { pid, port, startedAt, logFile, ...(project === undefined ? {} : { project }) };
}

/**
 * Writes the pidfile atomically — temp file, then rename — so a reader never
 * catches a half-written record and concludes the daemon is gone. Mode 0600:
 * it names a process another user has no business signalling.
 */
export function writeRecord(r: DaemonRecord): void {
  const dir = ensureRuntimeDir();
  const target = recordPath();
  const tmp = join(dir, `.daemon.json.${process.pid.toString(36)}.${Date.now().toString(36)}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  chmodSync(target, 0o600);
}

/** Removes the pidfile. Absent is success — this is how staleness is repaired. */
export function clearRecord(): void {
  rmSync(recordPath(), { force: true });
}

/**
 * Whether a pid names a live process. Signal 0 performs the permission and
 * existence checks without delivering anything: `ESRCH` is dead, `EPERM` is
 * alive but owned by somebody else — still alive, so still a reason not to
 * start a second daemon.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The record, but only when the process it names is actually running. A dead
 * pid clears the file on the way out, so the next `start` is not blocked by a
 * daemon that stopped existing three reboots ago.
 */
export function livingDaemon(): DaemonRecord | undefined {
  const rec = readRecord();
  if (rec === undefined) return undefined;
  if (isAlive(rec.pid)) return rec;
  clearRecord();
  return undefined;
}

/**
 * Probes the daemon's own health endpoint. Never throws: a refused connection,
 * a DNS-less host, a hung socket and a 500 are all just "not healthy", and the
 * callers of this are the ones responsible for saying so nicely.
 */
export async function healthCheck(port: number): Promise<{ ok: boolean; body?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const body = (await res.text()).trim();
    return { ok: res.ok, ...(body.length > 0 ? { body } : {}) };
  } catch {
    return { ok: false };
  }
}

/**
 * Starts the daemon in the background and does not return until it answers
 * `/healthz`.
 *
 * Spawning is not starting. A daemon whose config is broken, whose port is
 * taken or whose database is locked exits within a second of being spawned,
 * and a `start` that printed "started" for it hands the operator a lie they
 * only discover when work silently fails to be picked up. So: spawn, watch
 * both the pid and the endpoint, and fail loudly with the log if either says
 * no.
 */
export async function startDaemon(o: { port?: number; project?: string } = {}): Promise<DaemonRecord> {
  const running = livingDaemon();
  if (running !== undefined) {
    throw new Error(
      `daemon already running (pid ${running.pid}, port ${running.port}) — ` +
        `use "omp-conductor restart" to replace it, or "omp-conductor stop" first`,
    );
  }

  const port = o.port ?? DEFAULT_PORT;
  const logFile = join(ensureRuntimeDir(), "daemon.log");

  // Append, never truncate: the previous boot's failure is usually the reason
  // somebody is running `start` again.
  const logFd = openSync(logFile, "a", 0o600);
  let pid: number | undefined;
  try {
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "cli.ts"), "daemon", "--port", String(port), ...(o.project === undefined ? [] : ["--project", o.project])],
      {
        // The runtime directory is one we know exists and will not be deleted
        // out from under a long-running process; the daemon itself resolves
        // every path from the config, so cwd is only about not holding a
        // stale directory open.
        cwd: runtimeDir(),
        detached: true,
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.once("error", (err) => {
      process.stderr.write(`omp-conductor: daemon process failed: ${err.message}\n`);
    });
    // Detach from the parent's event loop and process group so the daemon
    // outlives the shell that started it.
    child.unref();
    pid = child.pid;
  } finally {
    closeSync(logFd);
  }

  if (pid === undefined) throw new Error(`could not spawn the daemon; see ${logFile}`);

  const record: DaemonRecord = {
    pid,
    port,
    startedAt: Date.now(),
    logFile,
    ...(o.project === undefined ? {} : { project: o.project }),
  };
  // Written before the wait so a concurrent `status` sees a booting daemon
  // rather than nothing at all.
  writeRecord(record);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    // Liveness first. If the child is gone, a healthy answer on that port came
    // from somebody else's server, and reporting it as ours would be worse
    // than reporting nothing.
    if (!isAlive(pid)) {
      clearRecord();
      throw new Error(`daemon exited during startup${tailLog(logFile)}`);
    }
    const health = await healthCheck(port);
    if (health.ok) return record;
    if (Date.now() >= deadline) break;
    await sleep(READY_POLL_MS);
  }

  // Alive but never healthy: a wedged process is not a running daemon, and
  // leaving it behind would block the next `start` for no benefit.
  await terminate(pid, STOP_TIMEOUT_MS);
  clearRecord();
  throw new Error(
    `daemon did not answer http://127.0.0.1:${port}/healthz within ${Math.round(READY_TIMEOUT_MS / 1000)}s${tailLog(logFile)}`,
  );
}

/**
 * How the last stop actually landed. Callers print this so an operator can
 * tell a supervised stop from a bare SIGTERM without reading the journal.
 */
export type StopResult =
  | { kind: "stopped"; pid: number; via: "systemctl" | "signal" }
  | { kind: "not-running" };

/**
 * Stops the daemon.
 *
 * Prefer `systemctl stop omp-conductor.service` when that unit's MainPID is
 * the live daemon: systemd then owns the stop and will not schedule a restart
 * for the exit it just requested. A raw `SIGTERM` against a unit with
 * `Restart=on-failure` is what made `omp-conductor stop` look like a no-op on
 * the reference fleet — exit 143 was a "failure", and the unit came back five
 * seconds later.
 *
 * Falls back to `SIGTERM` then `SIGKILL` when there is no unit, the unit is
 * not running, or its MainPID is somebody else (a hand-started daemon next to
 * a stopped unit). The grace period is a deadline, not a clean drain: a tick
 * with a worker in flight can run for that worker's whole wall clock.
 */
export async function stopDaemon(o: { timeoutMs?: number } = {}): Promise<StopResult> {
  const rec = livingDaemon();
  if (rec === undefined) {
    // `livingDaemon` already cleared a stale file; this covers the unparseable
    // one it refused to read. Still ask systemd: a unit can be running with
    // no pidfile (boot race, wiped runtime dir) and stop must still land.
    const decision = decideSystemdStop(undefined);
    if (decision.kind === "unknown") {
      throw new Error(ownershipUnknown("stop", decision.reason));
    }
    if (decision.kind === "stop") {
      await runSystemdStop(decision.mainPid, o.timeoutMs);
      clearRecord();
      return { kind: "stopped", pid: decision.mainPid, via: "systemctl" };
    }
    clearRecord();
    return { kind: "not-running" };
  }

  const decision = decideSystemdStop(rec.pid);
  if (decision.kind === "unknown") {
    // Pidfile stays: we could not prove the unit does *not* own this pid, and
    // signalling it under that uncertainty is the bounce under Restart=on-failure.
    throw new Error(ownershipUnknown("stop", decision.reason));
  }
  if (decision.kind === "stop") {
    await runSystemdStop(rec.pid, o.timeoutMs);
    clearRecord();
    return { kind: "stopped", pid: rec.pid, via: "systemctl" };
  }

  // decision.kind === "not-ours": confirmed no unit, inactive unit, no systemd
  // binary, or a unit whose MainPID is somebody else. Only a *confirmed*
  // negative is safe to signal.
  const gone = await terminate(rec.pid, o.timeoutMs ?? STOP_TIMEOUT_MS);
  if (!gone) {
    // The record stays: something is still holding that pid, and forgetting
    // about it would let the next `start` bind a port that is already taken.
    throw new Error(`daemon pid ${rec.pid} survived SIGTERM and SIGKILL — it may belong to another user`);
  }
  clearRecord();
  return { kind: "stopped", pid: rec.pid, via: "signal" };
}

/**
 * Restarts the daemon.
 *
 * Same ownership rule as {@link stopDaemon}: when the unit owns the live pid,
 * `systemctl restart` is the *only* path — a failed manager call is terminal,
 * never a fallthrough to raw signals. An *unanswered* ownership query is also
 * terminal: "dbus blipped" is not "no unit". Falling back to stop+start is
 * reserved for a confirmed hand-started daemon (no systemd, inactive unit, or
 * a unit whose MainPID is someone else).
 *
 * Returns the record of the process that is now answering `/healthz`.
 */
export async function restartDaemon(
  o: { port?: number; project?: string; timeoutMs?: number } = {},
): Promise<{ previous: DaemonRecord | undefined; record: DaemonRecord; via: "systemctl" | "cli" }> {
  const previous = livingDaemon();
  const ownership = probeUnit();
  if (ownership.kind === "unknown") {
    throw new Error(ownershipUnknown("restart", ownership.reason));
  }

  const unitOwns =
    ownership.kind === "active" && (previous === undefined || previous.pid === ownership.pid);

  if (unitOwns) {
    // Ownership is proven. A refused/timed-out restart must not fall through
    // to stopDaemon's signal path — that is the exact bounce this module exists
    // to prevent (SIGTERM → exit 143 → Restart=on-failure → new MainPID).
    const ran = systemctl(["restart", SYSTEMD_UNIT]);
    if (!ran.ok) {
      throw new Error(systemctlFailure("restart", ran));
    }
    // systemctl restart returns once the new MainPID is up; the pidfile is
    // written by the daemon itself on boot, so wait for that rather than
    // inventing a record from the unit alone.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const rec = livingDaemon();
      if (rec !== undefined) {
        const health = await healthCheck(rec.port);
        if (health.ok) return { previous, record: rec, via: "systemctl" };
      }
      if (Date.now() >= deadline) break;
      await sleep(READY_POLL_MS);
    }
    throw new Error(
      `systemctl restart ${SYSTEMD_UNIT} returned, but the daemon never answered /healthz`,
    );
  }

  await stopDaemon({ timeoutMs: o.timeoutMs });
  const record = await startDaemon({ port: o.port ?? previous?.port, project: o.project ?? previous?.project });
  return { previous, record, via: "cli" };
}

/**
 * What we know about {@link SYSTEMD_UNIT}.
 *
 * - `active` — unit has a live MainPID (> 1). Includes transitional manager
 *   states (`activating`, `deactivating`, `reloading`, `reactivating`) — the
 *   pid is still systemd-owned, so a raw SIGTERM would bounce under
 *   `Restart=on-failure`.
 * - `inactive` — confirmed not running (MainPID absent/0), unit absent, *or*
 *   no `systemctl` binary on this host. Safe to treat as "not supervised here".
 * - `unknown` — the manager exists (or we cannot tell it does not) but the
 *   query failed: dbus blip, permission, timeout. Must not be collapsed into
 *   `inactive` — that is how a unit-owned daemon gets a raw SIGTERM.
 */
export type UnitOwnership =
  | { kind: "active"; pid: number }
  | { kind: "inactive" }
  | { kind: "unknown"; reason: string };

/**
 * Probe {@link SYSTEMD_UNIT} ownership. Never throws — the caller decides
 * whether `unknown` is fatal (stop/restart: yes).
 */
export function probeUnit(unit = SYSTEMD_UNIT): UnitOwnership {
  const ran = systemctl(["show", unit, "--property=MainPID", "--property=ActiveState", "--value"]);
  if (!ran.ok) {
    // No binary at all → this host has no systemd manager, so nothing here can
    // be unit-owned. Any other failure (dbus, auth, timeout) is unknown.
    if (ran.missing) return { kind: "inactive" };
    const detail = (ran.stderr.trim() || ran.stdout.trim() || "systemctl show failed").split("\n")[0]!;
    return { kind: "unknown", reason: detail };
  }
  // `systemctl show --value` prints one property per line, MainPID then
  // ActiveState, in the order requested. Tolerate either order and blank
  // lines so a future systemctl rearrange does not silently disable the path.
  // Unknown units still exit 0 with `0` / `inactive`, which is the confirmed
  // negative we want — not an error.
  //
  // Ownership is the MainPID, not ActiveState. A successful probe that names a
  // live pid (> 1) means systemd still owns that process — including during
  // `activating` / `deactivating` / `reloading`. Filtering on ActiveState here
  // used to label those transitional states "inactive" and hand the pid to a
  // raw SIGTERM, which is exactly the Restart=on-failure bounce.
  const lines = ran.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let pid: number | undefined;
  for (const line of lines) {
    if (/^\d+$/.test(line)) {
      const n = Number(line);
      if (Number.isInteger(n) && n > 1) pid = n;
    }
  }
  if (pid === undefined) return { kind: "inactive" };
  return { kind: "active", pid };
}

/**
 * The MainPID of an *active* {@link SYSTEMD_UNIT}, or `undefined` when the
 * unit is confirmed inactive/absent or when ownership could not be determined.
 * Prefer {@link probeUnit} when the caller must distinguish those two.
 */
export function systemdMainPid(unit = SYSTEMD_UNIT): number | undefined {
  const ownership = probeUnit(unit);
  return ownership.kind === "active" ? ownership.pid : undefined;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Whether systemd should stop this daemon.
 *
 * - `stop` — unit is active and owns `pid` (or there is no pidfile and the
 *   unit is the only candidate). Caller MUST go through systemctl; a failed
 *   manager call is terminal.
 * - `not-ours` — confirmed inactive/absent unit, no systemd binary, or a unit
 *   whose MainPID is someone else. Caller may SIGTERM its own pidfile process.
 * - `unknown` — ownership query failed. Caller MUST NOT signal.
 */
type SystemdStopDecision =
  | { kind: "stop"; mainPid: number }
  | { kind: "not-ours" }
  | { kind: "unknown"; reason: string };

function decideSystemdStop(pid: number | undefined): SystemdStopDecision {
  const ownership = probeUnit();
  if (ownership.kind === "unknown") return { kind: "unknown", reason: ownership.reason };
  if (ownership.kind === "inactive") return { kind: "not-ours" };
  if (pid !== undefined && ownership.pid !== pid) return { kind: "not-ours" };
  return { kind: "stop", mainPid: ownership.pid };
}

/**
 * `systemctl stop` for a pid we have already proven the unit owns.
 *
 * Throws on manager refusal/timeout — never returns "false" for the caller to
 * reinterpret as "try SIGTERM instead". That reinterpretation is how stop
 * bounced under `Restart=on-failure`.
 */
async function runSystemdStop(pid: number, timeoutMs?: number): Promise<void> {
  const ran = systemctl(["stop", SYSTEMD_UNIT]);
  if (!ran.ok) {
    // Record stays: the unit still owns the process, and clearing it would let
    // the next `start` believe the port is free while systemd still holds it.
    throw new Error(systemctlFailure("stop", ran));
  }
  // systemctl stop is synchronous for Type=simple, but a slow drain still
  // holds the old pid briefly and the next start would refuse against it.
  const deadline = Date.now() + (timeoutMs ?? STOP_TIMEOUT_MS);
  while (isAlive(pid) && Date.now() < deadline) await sleep(100);
  if (isAlive(pid)) {
    throw new Error(
      `daemon pid ${pid} still alive after systemctl stop ${SYSTEMD_UNIT} — ` +
        `check \`systemctl status ${SYSTEMD_UNIT}\``,
    );
  }
}

function systemctlFailure(verb: "stop" | "restart", ran: SystemctlResult): string {
  const detail = (ran.stderr.trim() || ran.stdout.trim() || "no output").split("\n")[0] ?? "no output";
  return (
    `systemctl ${verb} ${SYSTEMD_UNIT} failed: ${detail} — ` +
    `refusing to signal a unit-owned daemon (that is how Restart=on-failure turns stop into a bounce); ` +
    `fix the unit or run \`systemctl ${verb} ${SYSTEMD_UNIT}\` yourself`
  );
}

function ownershipUnknown(verb: "stop" | "restart", reason: string): string {
  return (
    `cannot determine whether ${SYSTEMD_UNIT} owns the daemon (${reason}) — ` +
    `refusing to ${verb} via signal while ownership is unknown ` +
    `(a raw SIGTERM under Restart=on-failure is a bounce); ` +
    `retry when systemctl answers, or run \`systemctl ${verb} ${SYSTEMD_UNIT}\` yourself`
  );
}

/**
 * Run one `systemctl` invocation. Captures output and never throws: the caller
 * classifies the result. `missing: true` means the binary is not on PATH — that
 * is a confirmed "no systemd on this host", not a transient query failure.
 *
 * The default shells out. Tests replace it with {@link setSystemctlForTest}
 * so the ownership decision is exercised without a real systemd.
 */
export type SystemctlResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Binary not found (ENOENT). Distinct from a failed invocation of a present binary. */
  missing?: boolean;
};

export type SystemctlFn = (args: string[]) => SystemctlResult;

function defaultSystemctl(args: string[]): SystemctlResult {
  try {
    const res = spawnSync("systemctl", args, {
      encoding: "utf8",
      // Bound the wait: a hung dbus becomes `unknown` ownership, not a hang.
      // Callers must NOT treat that timeout as "no unit".
      timeout: 15_000,
      env: process.env,
    });
    if (res.error) {
      const err = res.error as NodeJS.ErrnoException;
      return {
        ok: false,
        stdout: "",
        stderr: err.message,
        ...(err.code === "ENOENT" ? { missing: true } : {}),
      };
    }
    return {
      ok: res.status === 0,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  } catch (err) {
    return { ok: false, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

let systemctl: SystemctlFn = defaultSystemctl;

/** Test-only: replace the `systemctl` runner. Pass `undefined` to restore. */
export function setSystemctlForTest(fn: SystemctlFn | undefined): void {
  systemctl = fn ?? defaultSystemctl;
}


function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** `SIGTERM`, poll until dead, then `SIGKILL`. Returns whether the pid is gone. */
async function terminate(pid: number, timeoutMs: number): Promise<boolean> {
  if (!isAlive(pid)) return true;
  if (!signal(pid, "SIGTERM")) return !isAlive(pid);

  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) await sleep(100);
  if (!isAlive(pid)) return true;

  signal(pid, "SIGKILL");
  // SIGKILL is not instant — the kernel still has to reap it — so give the
  // pid a moment to disappear before anyone reads liveness again.
  const hardDeadline = Date.now() + 2_000;
  while (isAlive(pid) && Date.now() < hardDeadline) await sleep(50);
  return !isAlive(pid);
}

/** Sends a signal, treating "already gone" as success. Returns false if the send failed. */
function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * The tail of the daemon log, formatted for an error message. Reads the last
 * few KB by offset rather than the whole file, because the log is append-only
 * across every boot and can be arbitrarily long.
 */
function tailLog(path: string): string {
  let text: string;
  let truncated = false;
  try {
    const size = statSync(path).size;
    const want = Math.min(size, LOG_TAIL_BYTES);
    if (want === 0) return ` — nothing was written to ${path}`;
    truncated = want < size;
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.allocUnsafe(want);
      const read = readSync(fd, buf, 0, want, size - want);
      text = buf.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return ` — see ${path}`;
  }
  // Reading from an offset lands mid-line; that fragment is an artefact, not
  // output. Reading the whole file does not, so keep line one in that case.
  const all = text.split("\n");
  const lines = (truncated ? all.slice(1) : all).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return ` — see ${path}`;
  return `:\n${lines.slice(-10).join("\n")}\n(full log: ${path})`;
}
