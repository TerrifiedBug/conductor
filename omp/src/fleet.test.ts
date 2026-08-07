/**
 * Fleet operator surface (#61): hold/halt/arm/disarm + layered status.
 * Arm is proof-gated — tests inject the challenge deps so no real Telegram.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armTicks,
  classifyKillError,
  clearPaneHalt,
  deliverSignal,
  disarmTicks,
  fleetLayers,
  formatFleetStatus,
  halt,
  haltWithPane,
  hold,
  type KillFn,
  ompPidsFromProcessInfo,
  PANE_HALT_FILE,
  paneHaltPath,
  pidLiveness,
  pinPaneHalt,
  releaseHold,
  sessionDirForCwd,
  stopConductorPane,
  transcriptHasUserCode,
} from "./fleet.ts";
import { setSystemctlForTest } from "./lifecycle.ts";
import { TICK_CONFIG_FILE } from "./orchestrator-tick.ts";
import { statusSnapshot } from "./daemon.ts";

const HOME_KEY = "HOME";
const COND_KEY = "OMP_CONDUCTOR_HOME";
const TG_KEY = "OMP_TELEGRAM_STATE_DIR";
const RUNTIME_KEY = "OMP_CONDUCTOR_RUNTIME_DIR";

let home = "";
let previous: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omp-fleet-"));
  previous = {
    HOME: process.env[HOME_KEY],
    COND: process.env[COND_KEY],
    TG: process.env[TG_KEY],
    RUNTIME: process.env[RUNTIME_KEY],
  };
  process.env[HOME_KEY] = home;
  process.env[COND_KEY] = join(home, ".omp", "conductor");
  process.env[TG_KEY] = join(home, ".omp", "agent", "telegram");
  process.env[RUNTIME_KEY] = join(home, ".omp", "run", "daemons", "omp-conductor");
  mkdirSync(process.env[COND_KEY]!, { recursive: true });
  mkdirSync(process.env[TG_KEY]!, { recursive: true });
  setSystemctlForTest(() => ({ ok: false, stdout: "", stderr: "not found", missing: true }));
});

afterEach(() => {
  setSystemctlForTest(undefined);
  if (previous.HOME === undefined) delete process.env[HOME_KEY];
  else process.env[HOME_KEY] = previous.HOME;
  if (previous.COND === undefined) delete process.env[COND_KEY];
  else process.env[COND_KEY] = previous.COND;
  if (previous.TG === undefined) delete process.env[TG_KEY];
  else process.env[TG_KEY] = previous.TG;
  if (previous.RUNTIME === undefined) delete process.env[RUNTIME_KEY];
  else process.env[RUNTIME_KEY] = previous.RUNTIME;
  rmSync(home, { recursive: true, force: true });
});

function writeMinimalConfig(workspaceRoot?: string): void {
  const cfg = {
    version: 2,
    defaults: {
      maxConcurrentWorkers: 2,
      dailySpendUsd: 25,
      workerMaxTurns: 120,
      workerWallClockMs: 5_400_000,
      maxAttemptsPerIssue: 2,
    },
    projects: [
      {
        name: "demo",
        tracker: { kind: "github", repo: "acme/demo" },
        queueLabel: "ready-for-agent",
        routing: {
          labelPrefix: "repo:",
          repos: {
            api: {
              name: "api",
              cloneUrl: "https://example.com/api.git",
              defaultBranch: "main",
              gates: [{ cmd: "true", cwd: "." }],
            },
          },
        },
        caps: {},
        escalation: { fallbackToIssueComment: true, orchestrator: "external" },
        authority: { merge: "human", release: "human" },
        workspaceRoot: workspaceRoot ?? join(home, ".omp", "conductor", "worktrees"),
        mirrorRoot: join(home, ".omp", "conductor", "mirrors"),
      },
    ],
  };
  writeFileSync(join(process.env[COND_KEY]!, "config.json"), JSON.stringify(cfg, null, 2));
}

function writeTick(armedFile = "armed"): string {
  const cwd = process.env[COND_KEY]!;
  writeFileSync(
    join(cwd, TICK_CONFIG_FILE),
    JSON.stringify({
      intervalSeconds: 600,
      armedFile,
      accessFile: join(process.env[TG_KEY]!, "access.json"),
    }),
  );
  return cwd;
}

function writeChannel(): void {
  writeFileSync(
    join(process.env[TG_KEY]!, "access.json"),
    JSON.stringify({ enabled: true, allowFrom: ["8236653927"] }),
  );
  writeFileSync(join(process.env[TG_KEY]!, ".env"), "TELEGRAM_BOT_TOKEN=test-token\n");
}

function writeTranscript(cwd: string, userText: string): string {
  const dir = sessionDirForCwd(cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: userText }] },
      }),
    ].join("\n") + "\n",
  );
  return path;
}

test("hold pauses claiming and removes the arm marker", () => {
  writeMinimalConfig();
  const cwd = writeTick();
  const armed = join(cwd, "armed");
  writeFileSync(armed, "armed previously\n");
  const r = hold();
  expect(r.wasPaused).toBe(false);
  expect(r.disarmed.wasArmed).toBe(true);
  expect(existsSync(armed)).toBe(false);
  expect(existsSync(join(process.env[COND_KEY]!, "paused"))).toBe(true);
  const r2 = hold();
  expect(r2.wasPaused).toBe(true);
  expect(r2.disarmed.wasArmed).toBe(false);
});

test("releaseHold clears pause but never re-arms", () => {
  writeMinimalConfig();
  writeTick();
  hold();
  releaseHold();
  expect(existsSync(join(process.env[COND_KEY]!, "paused"))).toBe(false);
  expect(existsSync(join(process.env[COND_KEY]!, "armed"))).toBe(false);
});

test("halt holds and stops the daemon", async () => {
  writeMinimalConfig();
  writeTick();
  writeFileSync(join(process.env[COND_KEY]!, "armed"), "x\n");
  const r = await halt();
  expect(r.hold.disarmed.wasArmed).toBe(true);
  expect(r.stop).toEqual({ kind: "not-running" });
  expect(existsSync(join(process.env[COND_KEY]!, "paused"))).toBe(true);
  expect(existsSync(join(process.env[COND_KEY]!, "armed"))).toBe(false);
});

test("halt --pane pins recovery first then stops the conductor agent", async () => {
  writeMinimalConfig();
  const cwd = writeTick();
  const signals: Array<{ pid: number; sig: string }> = [];
  const living = new Set<number>([5150]);
  const r = await haltWithPane(undefined, {
    listAgents: async () => [{ name: "fleet", paneId: "w1:p1", agent: "omp" }],
    panePids: async () => [5150],
    isAlive: (pid) => living.has(pid),
    signalPid: (pid, sig) => {
      signals.push({ pid, sig });
      if (sig === "SIGTERM" || sig === "SIGKILL") living.delete(pid);
      return true;
    },
    sleep: async () => {},
  });
  expect(existsSync(r.pane.pinPath)).toBe(true);
  expect(r.pane.pinPath).toBe(join(cwd, PANE_HALT_FILE));
  expect(r.pane.stopped).toBe("herdr-agent");
  expect(r.pane.agentName).toBe("fleet");
  expect(signals.some((s) => s.pid === 5150 && s.sig === "SIGTERM")).toBe(true);
  const cleared = clearPaneHalt();
  expect(cleared.wasHalted).toBe(true);
});

test("halt --pane pin is written even when agent already gone", async () => {
  writeMinimalConfig();
  writeTick();
  const r = await haltWithPane(undefined, {
    listAgents: async () => [],
    sleep: async () => {},
  });
  expect(existsSync(r.pane.pinPath)).toBe(true);
  expect(r.pane.stopped).toBe("already-gone");
});

test("halt --pane throws when identity is ambiguous — pin remains", async () => {
  writeMinimalConfig();
  writeTick();
  await expect(
    haltWithPane(undefined, {
      listAgents: async () => [
        { name: "fleet", paneId: "w1:p1", agent: "omp" },
        { name: "fleet", paneId: "w1:p2", agent: "omp" },
      ],
      sleep: async () => {},
    }),
  ).rejects.toThrow(/not unique/);
  // Pin was written before the throw so recovery cannot race a respawn.
  expect(existsSync(paneHaltPath())).toBe(true);
});

test("halt --pane throws when live omp claim has no recognized PID", async () => {
  writeMinimalConfig();
  writeTick();
  await expect(
    haltWithPane(undefined, {
      listAgents: async () => [{ name: "fleet", paneId: "w1:p1", agent: "omp" }],
      panePids: async () => [],
      sleep: async () => {},
    }),
  ).rejects.toThrow(/no omp foreground PID/);
  expect(existsSync(paneHaltPath())).toBe(true);
});

test("halt --pane throws when agent survives SIGKILL — never exits success while alive", async () => {
  writeMinimalConfig();
  writeTick();
  const living = new Set<number>([5150]);
  let clock = 0;
  await expect(
    haltWithPane(undefined, {
      listAgents: async () => [{ name: "fleet", paneId: "w1:p1", agent: "omp" }],
      panePids: async () => [5150],
      isAlive: (pid) => living.has(pid),
      // Signal is a no-op — process stays alive.
      signalPid: () => true,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }),
  ).rejects.toThrow(/still alive after SIGTERM\+SIGKILL/);
  expect(living.has(5150)).toBe(true);
  expect(existsSync(paneHaltPath())).toBe(true);
});

test("halt --pane throws when herdr is down", async () => {
  writeMinimalConfig();
  writeTick();
  await expect(
    haltWithPane(undefined, {
      listAgents: async () => {
        throw new Error("server_not_running");
      },
      sleep: async () => {},
    }),
  ).rejects.toThrow(/herdr agent list failed/);
  expect(existsSync(paneHaltPath())).toBe(true);
});

function writeHerdrStub(body: string): string {
  const bin = join(home, "stub-bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, `herdr-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("halt --pane throws on an invalid tick config — pin lands beside the bad file", async () => {
  // The pane's cwd must differ from the state dir, otherwise a state-dir
  // fallback would look correct by accident.
  const fleetCwd = join(home, "fleet");
  mkdirSync(join(fleetCwd, "worktrees"), { recursive: true });
  writeMinimalConfig(join(fleetCwd, "worktrees"));
  writeFileSync(join(fleetCwd, TICK_CONFIG_FILE), "{ not json");
  expect(fleetCwd).not.toBe(process.env[COND_KEY]!);

  // The bad file still names the pane's own directory, which is the only place
  // herdr-conductor's recover.sh reads the pin from.
  expect(paneHaltPath()).toBe(join(fleetCwd, PANE_HALT_FILE));
  await expect(
    haltWithPane(undefined, {
      listAgents: async () => [{ name: "fleet", paneId: "w1:p1", agent: "omp" }],
      sleep: async () => {},
    }),
  ).rejects.toThrow(/tick config invalid/);
  expect(existsSync(join(fleetCwd, PANE_HALT_FILE))).toBe(true);
  expect(existsSync(join(process.env[COND_KEY]!, PANE_HALT_FILE))).toBe(false);
});

test("herdr agent list output that is not an explicit agent array throws", async () => {
  writeMinimalConfig();
  writeTick();

  const cases: Array<{ label: string; body: string; expected: RegExp }> = [
    { label: "empty output", body: "exit 0", expected: /printed nothing/ },
    { label: "not JSON", body: "printf 'herdr: server not running\\n'", expected: /not JSON/ },
    {
      label: "no agents key",
      body: `printf '%s\\n' '{"result":{"type":"agent_list"}}'`,
      expected: /no .agents. array/,
    },
    {
      label: "malformed row",
      body: `printf '%s\\n' '{"result":{"agents":[{"pane_id":"w1:p1"}]}}'`,
      expected: /missing a string/,
    },
  ];

  for (const c of cases) {
    const bin = writeHerdrStub(c.body);
    await expect(stopConductorPane(undefined, { herdrBin: bin, sleep: async () => {} })).rejects.toThrow(
      c.expected,
    );
  }
});

test("an explicit empty agent array is the only 'no agents' answer", async () => {
  writeMinimalConfig();
  writeTick();
  const bin = writeHerdrStub(`printf '%s\\n' '{"result":{"agents":[]}}'`);
  const r = await stopConductorPane(undefined, { herdrBin: bin, sleep: async () => {} });
  expect(r.stopped).toBe("already-gone");
});

test("CLI halt --pane exits nonzero while a live claimed agent cannot be stopped", async () => {
  writeMinimalConfig();
  writeTick();

  // A real process the pane "owns" — the herdr stub reports it as the only
  // foreground process, but it is not an omp process, so no PID is
  // recognizable. The command must refuse rather than call that "halted".
  const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  const bin = join(home, "bin");
  mkdirSync(bin);

  const herdr = join(bin, "herdr");
  writeFileSync(
    herdr,
    `#!/bin/sh
case "$*" in
  *"agent list"*)
    printf '%s\\n' '{"result":{"agents":[{"name":"fleet","pane_id":"w1:p1","agent":"omp"}]}}'
    ;;
  *"pane process-info"*)
    printf '%s\\n' '{"result":{"process_info":{"foreground_processes":[{"pid":${child.pid},"name":"sleep","argv0":"sleep","argv":["sleep","60"]}]}}}'
    ;;
  *)
    exit 2
    ;;
esac
`,
  );
  chmodSync(herdr, 0o755);

  // Confirmed-inactive unit so the daemon half of halt behaves the same on a
  // laptop with no systemd and on a CI box whose systemd is not booted.
  const systemctl = join(bin, "systemctl");
  writeFileSync(systemctl, "#!/bin/sh\nprintf '0\\ninactive\\n'\nexit 0\n");
  chmodSync(systemctl, 0o755);

  try {
    const proc = Bun.spawn(["bun", "src/cli.ts", "halt", "--pane"], {
      cwd: import.meta.dir.replace(/\/src$/, ""),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        HERDR_SESSION: "fleet",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).not.toContain("halted");
    expect(stderr).toContain("live omp but no omp foreground PID");
    expect(child.exitCode).toBeNull();
    expect(existsSync(paneHaltPath())).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});

test("halt --pane throws when liveness cannot be probed — EPERM is not death", async () => {
  writeMinimalConfig();
  writeTick();
  await expect(
    haltWithPane(undefined, {
      listAgents: async () => [{ name: "fleet", paneId: "w1:p1", agent: "omp" }],
      panePids: async () => [5150],
      isAlive: () => {
        // What the real probe now does for EPERM: the process exists, we just
        // may not signal it. Answering `false` here used to read as "stopped".
        throw new Error("cannot probe pid 5150 (EPERM) — liveness unknown, not dead");
      },
      signalPid: () => true,
      sleep: async () => {},
    }),
  ).rejects.toThrow(/cannot tell whether the conductor agent is still running/);
  expect(existsSync(paneHaltPath())).toBe(true);
});

test("halt --pane throws when a signal cannot be delivered", async () => {
  writeMinimalConfig();
  writeTick();
  const attempt = async (signalPid: (pid: number, sig: NodeJS.Signals) => boolean) => {
    // Clock advances so a regression that drops the refusal fails the
    // assertion instead of spinning in the liveness loop forever.
    let clock = 0;
    return haltWithPane(undefined, {
      listAgents: async () => [{ name: "fleet", paneId: "w1:p1", agent: "omp" }],
      panePids: async () => [5150],
      isAlive: () => true,
      signalPid,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
  };

  await expect(
    attempt(() => {
      throw new Error("cannot send SIGTERM to pid 5150 (EPERM)");
    }),
  ).rejects.toThrow(/SIGTERM to pid 5150 failed/);
  // A probe that merely reports non-delivery is the same refusal.
  await expect(attempt(() => false)).rejects.toThrow(/SIGTERM to pid 5150 was not delivered/);
  expect(existsSync(paneHaltPath())).toBe(true);
});

test("kill errors map to gone only on ESRCH", () => {
  expect(classifyKillError(Object.assign(new Error("x"), { code: "ESRCH" }))).toBe("gone");
  // EPERM means the process exists and is not ours — the bug this guards.
  expect(classifyKillError(Object.assign(new Error("x"), { code: "EPERM" }))).toBe("unknown");
  expect(classifyKillError(Object.assign(new Error("x"), { code: "EINVAL" }))).toBe("unknown");
  expect(classifyKillError(new Error("no errno"))).toBe("unknown");
});

test("pidLiveness and deliverSignal refuse an EPERM answer", () => {
  // The kill syscall is injected: no real process is signalled, so this cannot
  // page init on a host where pid 1 happens to be ours.
  const eperm: KillFn = () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  };
  const esrch: KillFn = () => {
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  };

  expect(() => pidLiveness(4242, eperm)).toThrow(/liveness unknown, not dead/);
  expect(pidLiveness(4242, esrch)).toBe(false);
  expect(() => deliverSignal(4242, "SIGTERM", eperm)).toThrow(/cannot send SIGTERM to pid 4242/);
  // Already gone is the outcome we wanted.
  expect(deliverSignal(4242, "SIGTERM", esrch)).toBe(true);
});

test("pidLiveness tracks a real process through exit", async () => {
  const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  expect(pidLiveness(child.pid)).toBe(true);
  child.kill("SIGKILL");
  await child.exited;
  expect(pidLiveness(child.pid)).toBe(false);
  expect(deliverSignal(child.pid, "SIGTERM")).toBe(true);
});

test("disarm removes marker; arm requires inbound user-turn proof", async () => {
  writeMinimalConfig();
  const cwd = writeTick();
  writeChannel();
  writeTranscript(cwd, "not yet");
  expect(disarmTicks().wasArmed).toBe(false);
  await expect(
    armTicks(undefined, {
      sendChallenge: async () => {},
      waitForUserTurn: async () => false,
      timeoutMs: 10,
      sleep: async () => {},
    }),
  ).rejects.toThrow(/NOT armed/);
  expect(existsSync(join(cwd, "armed"))).toBe(false);
  let sent = "";
  const r = await armTicks(undefined, {
    sendChallenge: async (_t, _o, text) => {
      sent = text;
    },
    waitForUserTurn: async (_path, code) => {
      expect(sent).toContain(code);
      return true;
    },
    timeoutMs: 10,
    sleep: async () => {},
  });
  expect(r.owner).toBe("8236653927");
  expect(existsSync(r.path)).toBe(true);
});

test("arm refuses when channel is down — no force path", async () => {
  writeMinimalConfig();
  writeTick();
  writeFileSync(
    join(process.env[TG_KEY]!, "access.json"),
    JSON.stringify({ enabled: false, allowFrom: ["1"] }),
  );
  await expect(armTicks()).rejects.toThrow(/channel is not up/);
});

test("arm refuses when there is no tick config", async () => {
  writeMinimalConfig();
  await expect(armTicks()).rejects.toThrow(/no \.conductor-tick\.json/);
});

test("transcriptHasUserCode only counts user turns", async () => {
  const path = join(home, "t.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "FLEET-DEADBEEF" }] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "ok FLEET-CAFEBABE here" }] },
      }),
    ].join("\n") + "\n",
  );
  expect(await transcriptHasUserCode(path, "FLEET-DEADBEEF")).toBe(false);
  expect(await transcriptHasUserCode(path, "FLEET-CAFEBABE")).toBe(true);
});

test("ompPidsFromProcessInfo selects only omp foreground pids", () => {
  const pids = ompPidsFromProcessInfo({
    shell_pid: 4242,
    foreground_processes: [
      { pid: 4242, name: "bash", argv0: "-bash" },
      { pid: 5150, name: "bun", argv0: "bun", argv: ["bun", "omp", "--resume=/tmp/x"] },
      { pid: 5151, name: "omp" },
      { pid: 9999, name: "claude", argv: ["claude"] },
    ],
  });
  expect(pids.sort()).toEqual([5150, 5151]);
});

test("fleetLayers reports dispatch stopped + ticks disarmed after hold", () => {
  writeMinimalConfig();
  writeTick();
  writeFileSync(join(process.env[COND_KEY]!, "armed"), "x\n");
  hold();
  const layers = fleetLayers();
  expect(layers.dispatch).toBe("stopped");
  expect(layers.ticks).toBe("disarmed");
  expect(layers.paused).toBe(true);
});

test("fleetLayers separates pane liveness from recovery pin", () => {
  writeMinimalConfig();
  writeTick();
  pinPaneHalt();
  const layers = fleetLayers();
  expect(layers.recovery).toBe("pinned");
  expect(layers.recoveryDetail).toBe(paneHaltPath());
  expect(["live", "missing", "unknown"]).toContain(layers.pane);
});

test("formatFleetStatus stacks dispatch/ticks/pane/recovery/herdr/daemon", () => {
  writeMinimalConfig();
  writeTick();
  hold();
  const s = statusSnapshot();
  const text = formatFleetStatus(s, fleetLayers());
  expect(text).toContain("dispatch  stopped");
  expect(text).toContain("ticks     disarmed");
  expect(text).toMatch(/pane\s+/);
  expect(text).toMatch(/recovery\s+/);
  expect(text).toMatch(/herdr\s+/);
  expect(text).toContain("daemon    not running");
  expect(text).toContain("project   demo  (PAUSED)");
});
