import { expect, test } from "bun:test";
import { DEFAULT_AUTHORITY, type ProjectConfig, type RepoTarget } from "./types.ts";
import {
  probeCodeGraph,
  type CodeGraphProbeDeps,
  type ReadOnlyCommandResult,
} from "./graph-health.ts";

const NOW = Date.parse("2026-08-08T12:00:00Z");
const API_PATH = "/srv/graph/acme/api";
const WEB_PATH = "/srv/graph/acme/web";

function repo(name: string, graphProject?: string): RepoTarget {
  return {
    name,
    cloneUrl: `https://github.com/acme/${name}.git`,
    defaultBranch: "main",
    gates: [],
    ...(graphProject === undefined ? {} : { graphProject }),
  };
}

function project(...repos: RepoTarget[]): ProjectConfig {
  return {
    name: "demo",
    tracker: { kind: "github", repo: "acme/planning" },
    queueLabel: "ready-for-agent",
    stateLabels: { inProgress: "agent:in-progress", blocked: "agent:blocked", failed: "agent:failed" },
    routing: { labelPrefix: "repo:", repos: Object.fromEntries(repos.map((value) => [value.name, value])) },
    caps: {},
    escalation: { fallbackToIssueComment: true, orchestrator: "external" },
    authority: { ...DEFAULT_AUTHORITY },
    workspaceRoot: "/tmp/worktrees",
    mirrorRoot: "/tmp/mirrors",
  };
}

function completed(stdout: string, exitCode = 0): ReadOnlyCommandResult {
  return { kind: "completed", exitCode, stdout };
}

function healthyRun(command: string, args: readonly string[]): Promise<ReadOnlyCommandResult> {
  if (command === "/usr/local/bin/codebase-memory-mcp") {
    return Promise.resolve(
      completed(JSON.stringify({ projects: [{ root_path: API_PATH }, { root_path: WEB_PATH }] })),
    );
  }
  if (command !== "systemctl") return Promise.resolve({ kind: "unavailable" });
  if (args[0] === "is-enabled") return Promise.resolve(completed("enabled\n"));
  if (args[0] === "is-active") return Promise.resolve(completed("active\n"));
  if (args[0] === "show") {
    return Promise.resolve(
      completed(
        [
          "Result=success",
          "ExecMainStatus=0",
          `ExecMainExitTimestamp=${new Date(NOW - 10 * 60_000).toISOString()}`,
        ].join("\n"),
      ),
    );
  }
  return Promise.resolve({ kind: "unavailable" });
}

function deps(over: Partial<CodeGraphProbeDeps> = {}): CodeGraphProbeDeps {
  return {
    prereqs: () => ({
      indexer: "/usr/local/bin/codebase-memory-mcp",
      mcpConfig: "/home/fleet/.omp/agent/mcp.json",
      mounted: true,
    }),
    exists: () => true,
    run: healthyRun,
    now: () => NOW,
    ...over,
  };
}

function configuredProject(): ProjectConfig {
  return project(repo("api", API_PATH), repo("web", WEB_PATH));
}

test("an unconfigured project skips every host probe", async () => {
  let calls = 0;
  const health = await probeCodeGraph(
    project(repo("api")),
    deps({
      run: async () => {
        calls += 1;
        return { kind: "unavailable" };
      },
    }),
  );

  expect(health).toEqual({ configured: false });
  expect(calls).toBe(0);
});

test("healthy proves prerequisites, exact indexed roots, timer, and recent success", async () => {
  const calls: string[][] = [];
  const health = await probeCodeGraph(configuredProject(), deps({
    run: async (command, args) => {
      calls.push([command, ...args]);
      return healthyRun(command, args);
    },
  }));

  expect(health).toMatchObject({
    configured: true,
    status: "healthy",
    prerequisites: { indexer: "present", mcpMount: "present" },
    repos: [
      { name: "api", path: API_PATH, clone: "present", index: "present" },
      { name: "web", path: WEB_PATH, clone: "present", index: "present" },
    ],
    timer: { enabled: "enabled", active: "active" },
    refresh: { result: "success", fresh: true, ageMs: 600_000 },
    reasons: [],
  });
  expect(calls).toHaveLength(4);
  expect(calls.map(([command, verb]) => `${command} ${verb}`)).toEqual([
    "/usr/local/bin/codebase-memory-mcp cli",
    "systemctl is-enabled",
    "systemctl is-active",
    "systemctl show",
  ]);
});

test("a missing indexer is degraded without guessing index state", async () => {
  const health = await probeCodeGraph(configuredProject(), deps({
    prereqs: () => ({ indexer: null, mcpConfig: "/home/fleet/.omp/agent/mcp.json", mounted: true }),
  }));

  expect(health).toMatchObject({ configured: true, status: "degraded" });
  if (!health.configured) return;
  expect(health.prerequisites.indexer).toBe("missing");
  expect(health.repos.every((value) => value.index === "unknown")).toBe(true);
  expect(health.reasons).toContain("indexer is not present on PATH");
});

test("a missing worker MCP mount is degraded", async () => {
  const health = await probeCodeGraph(configuredProject(), deps({
    prereqs: () => ({
      indexer: "/usr/local/bin/codebase-memory-mcp",
      mcpConfig: "/home/fleet/.omp/agent/mcp.json",
      mounted: false,
    }),
  }));

  expect(health).toMatchObject({
    configured: true,
    status: "degraded",
    prerequisites: { indexer: "present", mcpMount: "missing" },
  });
});

test("a missing configured clone names only that repo", async () => {
  const health = await probeCodeGraph(configuredProject(), deps({ exists: (path) => path !== WEB_PATH }));

  expect(health).toMatchObject({ configured: true, status: "degraded" });
  if (!health.configured) return;
  expect(health.repos[1]).toMatchObject({ name: "web", clone: "missing", index: "present" });
  expect(health.reasons).toContain("web: configured clone is missing");
});

test("an indexed project must match the configured absolute root exactly", async () => {
  const health = await probeCodeGraph(
    configuredProject(),
    deps({
      run: (command, args) =>
        command === "/usr/local/bin/codebase-memory-mcp"
          ? Promise.resolve(
              completed(JSON.stringify({ projects: [{ root_path: API_PATH }, { root_path: "/srv/graph/acme/Web" }] })),
            )
          : healthyRun(command, args),
    }),
  );

  expect(health).toMatchObject({ configured: true, status: "degraded" });
  if (!health.configured) return;
  expect(health.repos[1]).toMatchObject({ name: "web", index: "missing" });
  expect(health.reasons).toContain(`web: no indexed project exactly matches ${WEB_PATH}`);
});

test("a disabled or inactive refresh timer is degraded", async () => {
  const health = await probeCodeGraph(configuredProject(), deps({
    run: (command, args) => {
      if (command === "systemctl" && args[0] === "is-enabled") return Promise.resolve(completed("disabled\n", 1));
      if (command === "systemctl" && args[0] === "is-active") return Promise.resolve(completed("inactive\n", 3));
      return healthyRun(command, args);
    },
  }));

  expect(health).toMatchObject({
    configured: true,
    status: "degraded",
    timer: { enabled: "disabled", active: "inactive" },
  });
});

test("a failed latest refresh is degraded with no false freshness", async () => {
  const health = await probeCodeGraph(configuredProject(), deps({
    run: (command, args) =>
      command === "systemctl" && args[0] === "show"
        ? Promise.resolve(completed("Result=exit-code\nExecMainStatus=1\nExecMainExitTimestamp=n/a\n"))
        : healthyRun(command, args),
  }));

  expect(health).toMatchObject({
    configured: true,
    status: "degraded",
    refresh: { result: "failed", fresh: false },
  });
});

test("a successful but stale refresh is degraded and reports its age", async () => {
  const health = await probeCodeGraph(configuredProject(), deps({
    run: (command, args) =>
      command === "systemctl" && args[0] === "show"
        ? Promise.resolve(
            completed(
              `Result=success\nExecMainStatus=0\nExecMainExitTimestamp=${new Date(NOW - 60 * 60_000).toISOString()}\n`,
            ),
          )
        : healthyRun(command, args),
  }));

  expect(health).toMatchObject({
    configured: true,
    status: "degraded",
    refresh: { result: "success", fresh: false, ageMs: 3_600_000 },
  });
});

test("a timed-out bounded probe makes health unknown", async () => {
  const health = await probeCodeGraph(configuredProject(), deps({
    run: (command, args) =>
      command === "/usr/local/bin/codebase-memory-mcp"
        ? Promise.resolve({ kind: "timeout" })
        : healthyRun(command, args),
  }));

  expect(health).toMatchObject({ configured: true, status: "unknown" });
  if (!health.configured) return;
  expect(health.reasons).toContain("indexer project probe timed out");
});

test("malformed indexer output makes health unknown", async () => {
  const health = await probeCodeGraph(configuredProject(), deps({
    run: (command, args) =>
      command === "/usr/local/bin/codebase-memory-mcp"
        ? Promise.resolve(completed('{"projects":[{"name":"api"}]}'))
        : healthyRun(command, args),
  }));

  expect(health).toMatchObject({ configured: true, status: "unknown" });
  if (!health.configured) return;
  expect(health.reasons).toContain("indexer returned malformed project data");
});

test("unavailable systemd is unknown rather than healthy or fatal", async () => {
  const health = await probeCodeGraph(configuredProject(), deps({
    run: (command, args) =>
      command === "systemctl" ? Promise.resolve({ kind: "unavailable" }) : healthyRun(command, args),
  }));

  expect(health).toMatchObject({
    configured: true,
    status: "unknown",
    timer: { enabled: "unknown", active: "unknown" },
    refresh: { result: "unknown", fresh: null },
  });
});
