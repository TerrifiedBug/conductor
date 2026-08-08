import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isPaused, prepareConductor, type StatusSnapshot } from "./daemon.ts";
import { join } from "node:path";
import {
  formatHostRuntimePlan,
  planHostRuntime,
  renderDaemonService,
  runSetupSmoke,
  writeHostRuntime,
  type ServiceRuntime,
} from "./setup-host.ts";
import { dbPath } from "./store.ts";
import { DEFAULT_AUTHORITY, DEFAULT_CAPS, type ProjectConfig } from "./types.ts";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env["OMP_CONDUCTOR_HOME"];
  home = mkdtempSync(join(tmpdir(), "conductor-host-setup-"));
  process.env["OMP_CONDUCTOR_HOME"] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env["OMP_CONDUCTOR_HOME"];
  else process.env["OMP_CONDUCTOR_HOME"] = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function project(mode: "embedded" | "external" = "external"): ProjectConfig {
  return {
    name: "demo",
    tracker: { kind: "github", repo: "acme/demo" },
    queueLabel: "ready-for-agent",
    stateLabels: { inProgress: "agent:in-progress", blocked: "agent:blocked", failed: "agent:failed" },
    routing: {
      labelPrefix: "repo:",
      repos: {
        api: {
          name: "api",
          cloneUrl: "git@github.com:acme/api.git",
          defaultBranch: "main",
          gates: [{ cmd: "bun run check", cwd: "." }],
        },
      },
    },
    caps: {},
    escalation: { orchestrator: mode, fallbackToIssueComment: true },
    authority: { ...DEFAULT_AUTHORITY },
    releasePolicy: "none",
    reporting: { scope: "material" },
    workspaceRoot: join(home, "worktrees"),
    mirrorRoot: join(home, "mirrors"),
  };
}

function runtime(): ServiceRuntime {
  return {
    username: "fleet",
    home: "/home/fleet",
    path: "/home/fleet/.bun/bin:/usr/bin:/bin",
    bun: "/home/fleet/.bun/bin/bun",
    cli: "/home/fleet/.bun/bin/omp-conductor",
    packageCli: "/opt/omp-conductor/src/cli.ts",
    conductorHome: home,
    telegramStateDir: join(home, "telegram"),
  };
}

test("a new external fleet gets gated heartbeat and supervised daemon files", () => {
  const plan = planHostRuntime(project(), DEFAULT_CAPS, join(home, "telegram"), runtime());

  expect(plan.tick?.action).toBe("create");
  expect(plan.tick?.path).toBe(join(home, "worktrees", ".conductor-tick.json"));
  expect(plan.tick?.value).toEqual({
    intervalSeconds: 900,
    armedFile: join(home, "armed"),
    accessFile: join(home, "telegram", "access.json"),
    agentName: "fleet",
  });
  expect(plan.service.content).toContain('ExecStart="/home/fleet/.bun/bin/omp-conductor" "daemon" "--project" "demo" "--port" "8787"');
  expect(plan.service.content).toContain(`Environment="OMP_CONDUCTOR_HOME=${home}"`);
  expect(plan.service.content).toContain("SuccessExitStatus=0 143");
  expect(plan.service.content).toContain("MemoryMax=5G");
  expect(formatHostRuntimePlan(plan)).toContain("channel gate");

  expect(writeHostRuntime(plan)).toEqual([plan.service.path, plan.tick!.path]);
  expect(JSON.parse(readFileSync(plan.tick!.path, "utf8"))).toEqual(plan.tick?.value);
  expect(statSync(plan.tick!.path).mode & 0o777).toBe(0o600);
  expect(statSync(plan.service.path).mode & 0o777).toBe(0o644);
});

test("runtime planning preserves custom heartbeat values and adds missing safety gates", () => {
  const cwd = project().workspaceRoot;
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, ".conductor-tick.json"),
    `${JSON.stringify({ intervalSeconds: 1800, message: "custom loop", agentName: "operator" })}\n`,
  );

  const plan = planHostRuntime(project(), DEFAULT_CAPS, join(home, "telegram"), runtime());

  expect(plan.tick?.action).toBe("update");
  expect(plan.tick?.value).toMatchObject({
    intervalSeconds: 1800,
    message: "custom loop",
    agentName: "operator",
    armedFile: join(home, "armed"),
    accessFile: join(home, "telegram", "access.json"),
  });
});

test("runtime planning refuses to hide a malformed heartbeat", () => {
  const cwd = project().workspaceRoot;
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, ".conductor-tick.json"), '{"intervalSeconds":10}\n');

  expect(() => planHostRuntime(project(), DEFAULT_CAPS, join(home, "telegram"), runtime())).toThrow(
    "tick config invalid",
  );
});

test("embedded orchestration stages only the daemon service", () => {
  const plan = planHostRuntime(project("embedded"), { ...DEFAULT_CAPS, maxConcurrentWorkers: 1 }, join(home, "telegram"), runtime());

  expect(plan.tick).toBeUndefined();
  expect(plan.service.content).toContain("MemoryMax=3G");
});

test("a plugin-only install stages a Bun service entrypoint", () => {
  const serviceRuntime = { ...runtime(), cli: undefined };
  const plan = planHostRuntime(project("embedded"), DEFAULT_CAPS, join(home, "telegram"), serviceRuntime);

  expect(plan.cliSource).toBe("plugin");
  expect(plan.service.content).toContain(
    'ExecStart="/home/fleet/.bun/bin/bun" "/opt/omp-conductor/src/cli.ts" "daemon" "--project" "demo" "--port" "8787"',
  );
});

test("service rendering quotes spaces and systemd specifiers", () => {
  const unit = renderDaemonService(project(), DEFAULT_CAPS, {
    ...runtime(),
    home: "/home/fleet user/100%",
    conductorHome: "/state/fleet user",
  });

  expect(unit).toContain('Environment="HOME=/home/fleet user/100%%"');
  expect(unit).toContain('Environment="OMP_CONDUCTOR_HOME=/state/fleet user"');
});

function status(): StatusSnapshot {
  return {
    project: "demo",
    configPath: join(home, "config.json"),
    stateDir: home,
    paused: true,
    caps: DEFAULT_CAPS,
    activeRuns: [],
    liveWorkers: 0,
    runsToday: 0,
    spendTodayUsd: 0,
  };
}

test("preparing setup creates the store and holds dispatch", () => {
  prepareConductor();

  expect(isPaused()).toBe(true);
  expect(existsSync(dbPath())).toBe(true);
});

test("the setup smoke proves once, health startup, status, and cleanup in order", async () => {
  const calls: string[] = [];
  const daemon = { pid: 4242, port: 8787, project: "demo", startedAt: 1, logFile: "/tmp/daemon.log" };
  const result = await runSetupSmoke("demo", {
    paused: () => true,
    living: () => undefined,
    runOnce: async (name) => { calls.push(`once:${name}`); },
    start: async (name) => { calls.push(`start:${name}`); return daemon; },
    health: async (port) => { calls.push(`health:${port}`); return { ok: true }; },
    status: (name) => { calls.push(`status:${name}`); return status(); },
    stop: async () => { calls.push("stop"); return { kind: "stopped", pid: daemon.pid, via: "signal" }; },
  });

  expect(calls).toEqual(["once:demo", "start:demo", "health:8787", "status:demo", "stop"]);
  expect(result).toEqual({ mode: "temporary", daemon, status: status() });
});

test("the setup smoke never exercises an unpaused dispatcher", async () => {
  await expect(runSetupSmoke("demo", {
    paused: () => false,
    living: () => undefined,
    health: async () => ({ ok: true }),
    runOnce: async () => {},
    start: async () => { throw new Error("not reached"); },
    status,
    stop: async () => ({ kind: "not-running" }),
  })).rejects.toThrow("requires paused dispatch");
});

test("the setup smoke proves a held tick and the existing daemon health", async () => {
  const daemon = { pid: 4242, port: 8787, project: "demo", startedAt: 1, logFile: "/tmp/daemon.log" };
  const calls: string[] = [];
  const result = await runSetupSmoke("demo", {
    paused: () => true,
    living: () => daemon,
    health: async (port) => { calls.push(`health:${port}`); return { ok: true }; },
    runOnce: async (name) => { calls.push(`once:${name}`); },
    start: async () => { throw new Error("not reached"); },
    status: (name) => { calls.push(`status:${name}`); return status(); },
    stop: async () => { throw new Error("not reached"); },
  });

  expect(calls).toEqual(["once:demo", "health:8787", "status:demo"]);
  expect(result.mode).toBe("existing");
});
