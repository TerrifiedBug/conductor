/**
 * Behavioural tests for the config boundary. `$OMP_CONDUCTOR_HOME` is pointed
 * at a fresh temp directory per test and restored afterwards, so nothing here
 * can read — or clobber — a real `~/.omp/conductor`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, findProject, loadConfig, resolveCaps, saveConfig, stateDir } from "./config.ts";
import { DEFAULT_CAPS, type Caps, type ConductorConfig, type ProjectConfig } from "./types.ts";

const ENV_KEY = "OMP_CONDUCTOR_HOME";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env[ENV_KEY];
  home = mkdtempSync(join(tmpdir(), "omp-conductor-config-"));
  process.env[ENV_KEY] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousHome;
  rmSync(home, { recursive: true, force: true });
});

/** A project with every field spelled out, so a round-trip has nothing to default. */
function project(name: string): ProjectConfig {
  return {
    name,
    tracker: { kind: "github", repo: `acme/${name}` },
    queueLabel: "agent:ready",
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
    caps: { workerMaxTurns: 7 },
    escalation: { telegramChatId: "123456", fallbackToIssueComment: true },
    workspaceRoot: join(home, "worktrees"),
    mirrorRoot: join(home, "mirrors"),
  };
}

function config(...projects: ProjectConfig[]): ConductorConfig {
  return { version: 1, defaults: { ...DEFAULT_CAPS }, projects };
}

/** Writes a config the loader must reject, bypassing `saveConfig`'s typing. */
function writeRawConfig(value: unknown): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(value, null, 2));
}

test("configPath and stateDir follow $OMP_CONDUCTOR_HOME", () => {
  expect(configPath()).toBe(join(home, "config.json"));
  expect(stateDir()).toBe(home);
});

test("save then load round-trips a fully specified config unchanged", () => {
  const original = config(project("demo"));

  saveConfig(original);

  expect(loadConfig()).toEqual(original);
});

test("loadConfig on a missing file names the path and the fix", () => {
  expect(() => loadConfig()).toThrow(join(home, "config.json"));
  expect(() => loadConfig()).toThrow("/conductor setup");
});

test("loadConfig rejects a config written by a different version", () => {
  writeRawConfig({ ...config(project("demo")), version: 2 });

  expect(() => loadConfig()).toThrow(/"version" must be 1/);
});

test("loadConfig rejects an empty projects list", () => {
  writeRawConfig(config());

  expect(() => loadConfig()).toThrow(/"projects" must be a non-empty array/);
});

test("loadConfig reports every problem it found, not just the first", () => {
  const broken = project("demo");
  writeRawConfig({
    version: 1,
    defaults: { ...DEFAULT_CAPS },
    projects: [
      {
        ...broken,
        name: "",
        tracker: { kind: "github", repo: "not-a-repo" },
        queueLabel: "",
        routing: { labelPrefix: "repo:", repos: {} },
      },
    ],
  });

  let message = "";
  try {
    loadConfig();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }

  expect(message).toContain("name must be a non-empty string");
  expect(message).toContain(`tracker.repo must look like "owner/repo"`);
  expect(message).toContain("queueLabel must be a non-empty string");
  expect(message).toContain("routing.repos needs at least one repo entry");
});

test("saveConfig writes the config readable only by its owner", () => {
  saveConfig(config(project("demo")));

  expect(statSync(configPath()).mode & 0o777).toBe(0o600);
});

test("saveConfig creates a missing state directory as 0700 and leaves no temp files", () => {
  const nested = join(home, "nested", "conductor");
  process.env[ENV_KEY] = nested;

  saveConfig(config(project("demo")));

  expect(statSync(nested).mode & 0o777).toBe(0o700);
  expect([...new Bun.Glob("*").scanSync({ cwd: nested, dot: true })]).toEqual(["config.json"]);
});

test("saveConfig replaces an existing config atomically rather than truncating it", () => {
  saveConfig(config(project("demo")));
  saveConfig(config(project("homelab")));

  const onDisk = JSON.parse(readFileSync(configPath(), "utf8")) as ConductorConfig;
  expect(onDisk.projects[0]?.name).toBe("homelab");
  expect(loadConfig().projects).toHaveLength(1);
});

test("resolveCaps overrides only the fields a project sets and inherits the rest", () => {
  const defaults: Caps = {
    maxConcurrentWorkers: 3,
    maxIssuesPerDay: 9,
    dailySpendUsd: 40,
    workerMaxTurns: 200,
    workerWallClockMs: 60_000,
    maxAttemptsPerIssue: 4,
  };
  const p = project("demo");
  p.caps = { workerMaxTurns: 7, dailySpendUsd: 0 };

  expect(resolveCaps(p, defaults)).toEqual({
    maxConcurrentWorkers: 3,
    maxIssuesPerDay: 9,
    // An explicit 0 is a hard stop, so it must survive the merge.
    dailySpendUsd: 0,
    workerMaxTurns: 7,
    workerWallClockMs: 60_000,
    maxAttemptsPerIssue: 4,
  });
});

test("resolveCaps returns the defaults when a project overrides nothing", () => {
  const p = project("demo");
  p.caps = {};

  expect(resolveCaps(p, DEFAULT_CAPS)).toEqual(DEFAULT_CAPS);
});

test("findProject returns the sole project when no name is given", () => {
  const c = config(project("demo"));

  expect(findProject(c).name).toBe("demo");
});

test("findProject refuses to guess between two projects", () => {
  const c = config(project("demo"), project("homelab"));

  expect(() => findProject(c)).toThrow(/2 projects/);
});

test("findProject rejects an unknown name and lists what exists", () => {
  const c = config(project("demo"), project("homelab"));

  expect(() => findProject(c, "nope")).toThrow(/Unknown project "nope"/);
  expect(() => findProject(c, "nope")).toThrow(/demo, homelab/);
  expect(findProject(c, "homelab").name).toBe("homelab");
});
