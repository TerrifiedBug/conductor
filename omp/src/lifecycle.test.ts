/**
 * Behavioural tests for the daemon pidfile. `$OMP_CONDUCTOR_RUNTIME_DIR` is
 * pointed at a fresh temp directory per test and restored afterwards, so
 * nothing here can read — or clobber — a real `~/.omp/run/daemons`.
 *
 * Nothing spawns a daemon and nothing listens: every case here is about what
 * the lifecycle believes when the file and the process disagree, which is the
 * only part of this that is hard to get right.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRecord,
  type DaemonRecord,
  healthCheck,
  isAlive,
  livingDaemon,
  readRecord,
  restartDaemon,
  runtimeDir,
  setSystemctlForTest,
  startDaemon,
  stopDaemon,
  SYSTEMD_UNIT,
  systemdMainPid,
  writeRecord,
} from "./lifecycle.ts";

const ENV_KEY = "OMP_CONDUCTOR_RUNTIME_DIR";

/** Above every plausible `pid_max`, so `kill` answers ESRCH rather than hitting a real process. */
const DEAD_PID = 999_999;

let dir = "";
let previousDir: string | undefined;

beforeEach(() => {
  previousDir = process.env[ENV_KEY];
  dir = mkdtempSync(join(tmpdir(), "omp-conductor-lifecycle-"));
  process.env[ENV_KEY] = dir;
});

afterEach(() => {
  setSystemctlForTest(undefined);
  if (previousDir === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<DaemonRecord> = {}): DaemonRecord {
  return {
    pid: process.pid,
    port: 8787,
    project: "conductor",
    startedAt: Date.now() - 90_000,
    logFile: join(dir, "daemon.log"),
    ...overrides,
  };
}

function recordFile(): string {
  return join(runtimeDir(), "daemon.json");
}

test("runtimeDir honours the environment override", () => {
  expect(runtimeDir()).toBe(dir);
});

test("writeRecord round-trips through readRecord", () => {
  const r = record();
  writeRecord(r);
  expect(readRecord()).toEqual(r);
});

test("the pidfile is written 0600", () => {
  writeRecord(record());
  expect(statSync(recordFile()).mode & 0o777).toBe(0o600);
});

test("a record without a project round-trips without inventing one", () => {
  const r = record();
  delete r.project;
  writeRecord(r);
  const read = readRecord();
  expect(read).toEqual(r);
  expect(read?.project).toBeUndefined();
});

test("isAlive is true for this process and false for a pid that cannot exist", () => {
  expect(isAlive(process.pid)).toBe(true);
  expect(isAlive(DEAD_PID)).toBe(false);
});

test("isAlive refuses pid 0, which would signal the whole process group", () => {
  expect(isAlive(0)).toBe(false);
});

test("livingDaemon returns the record when its pid is alive", () => {
  const r = record();
  writeRecord(r);
  expect(livingDaemon()).toEqual(r);
  expect(existsSync(recordFile())).toBe(true);
});

test("livingDaemon clears a stale record instead of honouring it", () => {
  writeRecord(record({ pid: DEAD_PID }));
  expect(livingDaemon()).toBeUndefined();
  expect(existsSync(recordFile())).toBe(false);
});

test("readRecord returns undefined when there is no pidfile", () => {
  expect(readRecord()).toBeUndefined();
});

test("readRecord returns undefined for corrupt JSON rather than throwing", () => {
  writeRecord(record());
  writeFileSync(recordFile(), "{ this is not json");
  expect(readRecord()).toBeUndefined();
});

test("readRecord rejects a well-formed JSON file with the wrong shape", () => {
  writeFileSync(recordFile(), JSON.stringify({ pid: "12345", port: 8787, startedAt: 1, logFile: "x" }));
  expect(readRecord()).toBeUndefined();

  writeFileSync(recordFile(), JSON.stringify({ pid: 1, port: 8787, startedAt: 1, logFile: "x" }));
  expect(readRecord()).toBeUndefined();

  writeFileSync(recordFile(), JSON.stringify({ pid: 4242, port: 70000, startedAt: 1, logFile: "x" }));
  expect(readRecord()).toBeUndefined();
});

test("clearRecord is idempotent", () => {
  writeRecord(record());
  clearRecord();
  clearRecord();
  expect(existsSync(recordFile())).toBe(false);
});

test("startDaemon refuses to double-start against a live pid", async () => {
  writeRecord(record({ pid: process.pid, port: 9191 }));
  // Names the incumbent so the operator can decide, and — critically — spawns
  // nothing: the throw happens before any process is created.
  await expect(startDaemon({ port: 9191 })).rejects.toThrow(new RegExp(`already running \\(pid ${process.pid}`));
  expect(readRecord()?.pid).toBe(process.pid);
});

test("stopDaemon reports not-running and clears a stale record", async () => {
  writeRecord(record({ pid: DEAD_PID }));
  // No unit on this host (or the stub says so) — bare not-running.
  setSystemctlForTest(() => ({ ok: false, stdout: "", stderr: "unit not found" }));
  expect(await stopDaemon()).toEqual({ kind: "not-running" });
  expect(existsSync(recordFile())).toBe(false);
});

test("stopDaemon reports not-running when there was never a pidfile", async () => {
  setSystemctlForTest(() => ({ ok: false, stdout: "", stderr: "unit not found" }));
  expect(await stopDaemon()).toEqual({ kind: "not-running" });
});

test("stopDaemon uses systemctl when the unit MainPID matches the live daemon", async () => {
  const calls: string[][] = [];
  // A child we own and can kill if the signal path is wrongly taken.
  const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  const pid = child.pid;
  try {
    writeRecord(record({ pid }));
    setSystemctlForTest((args) => {
      calls.push(args);
      if (args[0] === "show") {
        return { ok: true, stdout: `${pid}\nactive\n`, stderr: "" };
      }
      if (args[0] === "stop" && args[1] === SYSTEMD_UNIT) {
        // Mimic systemd reaping the MainPID.
        child.kill("SIGTERM");
        return { ok: true, stdout: "", stderr: "" };
      }
      return { ok: false, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    });

    expect(await stopDaemon()).toEqual({ kind: "stopped", pid, via: "systemctl" });
    expect(calls.some((a) => a[0] === "stop" && a[1] === SYSTEMD_UNIT)).toBe(true);
    expect(existsSync(recordFile())).toBe(false);
    expect(isAlive(pid)).toBe(false);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await child.exited;
  }
});

test("stopDaemon falls back to SIGTERM when the unit MainPID is someone else", async () => {
  const calls: string[][] = [];
  const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  const pid = child.pid;
  try {
    writeRecord(record({ pid }));
    setSystemctlForTest((args) => {
      calls.push(args);
      if (args[0] === "show") {
        // Unit is up, but its MainPID is not our daemon — a neighbour.
        return { ok: true, stdout: `${DEAD_PID}\nactive\n`, stderr: "" };
      }
      // stop must never be requested against a foreign MainPID.
      return { ok: false, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    });

    expect(await stopDaemon()).toEqual({ kind: "stopped", pid, via: "signal" });
    expect(calls.every((a) => a[0] !== "stop")).toBe(true);
    expect(existsSync(recordFile())).toBe(false);
    expect(isAlive(pid)).toBe(false);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await child.exited;
  }
});

test("stopDaemon stops a unit-owned daemon even with no pidfile", async () => {
  const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  const pid = child.pid;
  try {
    setSystemctlForTest((args) => {
      if (args[0] === "show") return { ok: true, stdout: `${pid}\nactive\n`, stderr: "" };
      if (args[0] === "stop") {
        child.kill("SIGTERM");
        return { ok: true, stdout: "", stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "" };
    });

    expect(await stopDaemon()).toEqual({ kind: "stopped", pid, via: "systemctl" });
    expect(isAlive(pid)).toBe(false);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await child.exited;
  }
});

test("systemdMainPid returns undefined when the unit is inactive", () => {
  setSystemctlForTest(() => ({ ok: true, stdout: "0\ninactive\n", stderr: "" }));
  expect(systemdMainPid()).toBeUndefined();
});

test("systemdMainPid returns the MainPID of an active unit", () => {
  setSystemctlForTest(() => ({ ok: true, stdout: "4242\nactive\n", stderr: "" }));
  expect(systemdMainPid()).toBe(4242);
});

test("stopDaemon throws when the unit owns the pid but systemctl stop refuses", async () => {
  // The bug this guards: collapsing manager failure to "not ours" and then
  // SIGTERMing a unit-owned MainPID — Restart=on-failure reads that as a crash
  // and the unit comes straight back. Ownership is proven; refusal is terminal.
  const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  const pid = child.pid;
  const calls: string[][] = [];
  try {
    writeRecord(record({ pid }));
    setSystemctlForTest((args) => {
      calls.push(args);
      if (args[0] === "show") return { ok: true, stdout: `${pid}\nactive\n`, stderr: "" };
      if (args[0] === "stop") {
        return { ok: false, stdout: "", stderr: "Access denied\n" };
      }
      return { ok: false, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    });

    await expect(stopDaemon()).rejects.toThrow(/systemctl stop .* failed: Access denied/);
    // Must not have signalled the child — it is still the unit's MainPID.
    expect(isAlive(pid)).toBe(true);
    // Pidfile stays so the next start does not bind a port systemd still holds.
    expect(readRecord()?.pid).toBe(pid);
    expect(calls.filter((a) => a[0] === "stop")).toHaveLength(1);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await child.exited;
  }
});

test("restartDaemon throws when the unit owns the pid but systemctl restart refuses", async () => {
  const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  const pid = child.pid;
  const calls: string[][] = [];
  try {
    writeRecord(record({ pid }));
    setSystemctlForTest((args) => {
      calls.push(args);
      if (args[0] === "show") return { ok: true, stdout: `${pid}\nactive\n`, stderr: "" };
      if (args[0] === "restart") {
        return { ok: false, stdout: "", stderr: "Connection timed out\n" };
      }
      // A fallthrough that called stop would still be wrong — assert neither.
      return { ok: false, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    });

    await expect(restartDaemon()).rejects.toThrow(/systemctl restart .* failed: Connection timed out/);
    expect(isAlive(pid)).toBe(true);
    expect(readRecord()?.pid).toBe(pid);
    expect(calls.some((a) => a[0] === "stop")).toBe(false);
    expect(calls.filter((a) => a[0] === "restart")).toHaveLength(1);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await child.exited;
  }
});


test("healthCheck resolves ok:false against a closed port instead of rejecting", async () => {
  // Port 1 is privileged, so nothing in a test run is listening on it and the
  // connection is refused outright.
  expect(await healthCheck(1)).toEqual({ ok: false });
});

test("writeRecord creates the runtime directory 0700 when it is missing", () => {
  const nested = join(dir, "nested", "omp-conductor");
  process.env[ENV_KEY] = nested;
  writeRecord(record());
  expect(statSync(nested).mode & 0o777).toBe(0o700);
  expect(JSON.parse(readFileSync(join(nested, "daemon.json"), "utf8")).pid).toBe(process.pid);
});
