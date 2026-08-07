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
    const unitPid = systemdMainPid();
    if (unitPid !== undefined && (await stopViaSystemd(undefined))) {
      const deadline = Date.now() + (o.timeoutMs ?? STOP_TIMEOUT_MS);
      while (isAlive(unitPid) && Date.now() < deadline) await sleep(100);
      if (isAlive(unitPid)) {
        throw new Error(
          `daemon pid ${unitPid} still alive after systemctl stop ${SYSTEMD_UNIT} — ` +
            `check \`systemctl status ${SYSTEMD_UNIT}\``,
        );
      }
      clearRecord();
      return { kind: "stopped", pid: unitPid, via: "systemctl" };
    }
    clearRecord();
    return { kind: "not-running" };
  }

  if (await stopViaSystemd(rec.pid)) {
    // Wait out the unit: systemctl stop is synchronous for Type=simple, but
    // a slow drain still holds the old pid briefly and the next start would
    // refuse against it.
    const deadline = Date.now() + (o.timeoutMs ?? STOP_TIMEOUT_MS);
    while (isAlive(rec.pid) && Date.now() < deadline) await sleep(100);
    if (isAlive(rec.pid)) {
      throw new Error(
        `daemon pid ${rec.pid} still alive after systemctl stop ${SYSTEMD_UNIT} — ` +
          `check \`systemctl status ${SYSTEMD_UNIT}\``,
      );
    }
    clearRecord();
    return { kind: "stopped", pid: rec.pid, via: "systemctl" };
  }

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
 * `systemctl restart` keeps systemd in charge of the replacement process so
 * the new MainPID is still the unit's. Falling back to stop+start for a
 * hand-started daemon would leave the unit dead and the new process
 * unsupervised — fine for a laptop, wrong for the host that installed a unit
 * specifically so a crash comes back.
 *
 * Returns the record of the process that is now answering `/healthz`.
 */
export async function restartDaemon(
  o: { port?: number; project?: string; timeoutMs?: number } = {},
): Promise<{ previous: DaemonRecord | undefined; record: DaemonRecord; via: "systemctl" | "cli" }> {
  const previous = livingDaemon();
  const unitPid = systemdMainPid();
  const unitOwns =
    unitPid !== undefined && (previous === undefined || previous.pid === unitPid);

  if (unitOwns) {
    const ran = systemctl(["restart", SYSTEMD_UNIT]);
    if (ran.ok) {
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
    // Unit exists and owns the pid but systemctl refused (permissions, dbus
    // down). Fall through to the signal path rather than stranding the
    // operator with "restart failed" and a still-running daemon they cannot
    // reach through the unit.
  }

  await stopDaemon({ timeoutMs: o.timeoutMs });
  const record = await startDaemon({ port: o.port ?? previous?.port, project: o.project ?? previous?.project });
  return { previous, record, via: "cli" };
}

/**
 * The MainPID of {@link SYSTEMD_UNIT}, or `undefined` when systemd is absent,
 * the unit is unknown, or it is not running. Never throws: a missing binary
 * or a dbus blip is "no unit", and stop falls back to SIGTERM.
 */
export function systemdMainPid(unit = SYSTEMD_UNIT): number | undefined {
  const ran = systemctl(["show", unit, "--property=MainPID", "--property=ActiveState", "--value"]);
  if (!ran.ok) return undefined;
  // `systemctl show --value` prints one property per line, MainPID then
  // ActiveState, in the order requested. Tolerate either order and blank
  // lines so a future systemctl rearrange does not silently disable the path.
  const lines = ran.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let pid: number | undefined;
  let active: string | undefined;
  for (const line of lines) {
    if (/^\d+$/.test(line)) {
      const n = Number(line);
      if (Number.isInteger(n) && n > 1) pid = n;
    } else {
      active = line;
    }
  }
  if (active !== undefined && active !== "active" && active !== "reactivating") return undefined;
  return pid;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Ask systemd to stop the unit, but only when it actually owns `pid`.
 *
 * `pid === undefined` means "no pidfile" — still stop the unit if it is
 * active, because that is the only process that could be the daemon. A unit
 * whose MainPID is some other process is left alone: stopping it would take
 * down a neighbour, and the signal path handles *our* pid.
 */
async function stopViaSystemd(pid: number | undefined): Promise<boolean> {
  const main = systemdMainPid();
  if (main === undefined) return false;
  if (pid !== undefined && main !== pid) return false;
  const ran = systemctl(["stop", SYSTEMD_UNIT]);
  return ran.ok;
}

/**
 * Run one `systemctl` invocation. Captures output and never throws: absence
 * of the binary, a missing unit, or a permission error are all "not ok", and
 * the caller decides whether to fall back.
 *
 * The default shells out. Tests replace it with {@link setSystemctlForTest}
 * so the ownership decision is exercised without a real systemd.
 */
export type SystemctlFn = (args: string[]) => { ok: boolean; stdout: string; stderr: string };

function defaultSystemctl(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const res = spawnSync("systemctl", args, {
      encoding: "utf8",
      // A hung dbus is not worth blocking stop on; the signal path is right there.
      timeout: 15_000,
      env: process.env,
    });
    if (res.error) return { ok: false, stdout: "", stderr: res.error.message };
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
