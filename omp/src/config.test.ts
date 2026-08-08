/**
 * Behavioural tests for the config boundary. `$OMP_CONDUCTOR_HOME` is pointed
 * at a fresh temp directory per test and restored afterwards, so nothing here
 * can read — or clobber — a real `~/.omp/conductor`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, findProject, loadConfig, resolveCaps, saveConfig, stateDir } from "./config.ts";
import {
  CONFIG_VERSION,
  DEFAULT_CAPS,
  DEFAULT_REPORT_SCOPE,
  type Caps,
  type ConductorConfig,
  type ProjectConfig,
} from "./types.ts";

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
    escalation: { telegramChatId: "123456", fallbackToIssueComment: true, orchestrator: "embedded" },
    authority: { merge: "human", release: "human" },
    reporting: { scope: "escalations" },
    workspaceRoot: join(home, "worktrees"),
    mirrorRoot: join(home, "mirrors"),
  };
}

function config(...projects: ProjectConfig[]): ConductorConfig {
  return { version: CONFIG_VERSION, defaults: { ...DEFAULT_CAPS }, projects };
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

test("loadConfig rejects a config written by a version it cannot read", () => {
  writeRawConfig({ ...config(project("demo")), version: 3 });

  expect(() => loadConfig()).toThrow(/"version" must be 1 or 2, found 3/);
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

test("a project with no reporting block loads as the documented default", () => {
  const { reporting, ...withoutReporting } = project("demo");
  writeRawConfig({ version: 1, defaults: { ...DEFAULT_CAPS }, projects: [withoutReporting] });

  // The compatibility promise: a config written before this key existed keeps
  // the reporting volume it already had, rather than going quiet.
  expect(loadConfig().projects[0]?.reporting).toEqual({ scope: DEFAULT_REPORT_SCOPE });
  expect(reporting).toEqual({ scope: "escalations" });
});

test("loadConfig rejects an unknown reporting scope by name instead of defaulting it", () => {
  writeRawConfig({
    version: 1,
    defaults: { ...DEFAULT_CAPS },
    projects: [{ ...project("demo"), reporting: { scope: "materal" } }],
  });

  // Silently folding a typo to "material" would read as configured on the day
  // the operator meant to turn the volume down.
  expect(() => loadConfig()).toThrow(/reporting\.scope must be "escalations" or "material", found "materal"/);
});

test("a project that never answered the authority question keeps both with the human", () => {
  const { authority, ...withoutAuthority } = project("demo");
  writeRawConfig({ version: CONFIG_VERSION, defaults: { ...DEFAULT_CAPS }, projects: [withoutAuthority] });

  // The one default that must never drift: an unattended session gets write
  // access to a main branch only when somebody said so out loud.
  expect(loadConfig().projects[0]?.authority).toEqual({ merge: "human", release: "human" });
});

test("a delegated authority survives its own validator", () => {
  writeRawConfig({
    version: CONFIG_VERSION,
    defaults: { ...DEFAULT_CAPS },
    projects: [{ ...project("demo"), authority: { merge: "orchestrator", release: "orchestrator" } }],
  });

  expect(loadConfig().projects[0]?.authority).toEqual({ merge: "orchestrator", release: "orchestrator" });
});

test("loadConfig rejects an authority holder it does not recognise, naming the field", () => {
  writeRawConfig({
    version: CONFIG_VERSION,
    defaults: { ...DEFAULT_CAPS },
    projects: [{ ...project("demo"), authority: { merge: "yes", release: "human" } }],
  });

  // Folding "yes" to the default would leave a config that reads as delegated
  // beside standing orders that say the opposite — the exact disagreement this
  // key exists to make impossible.
  expect(() => loadConfig()).toThrow(/authority\.merge must be "human" or "orchestrator", found "yes"/);
});

test("loadConfig rejects a misspelt authority key rather than ignoring it", () => {
  writeRawConfig({
    version: CONFIG_VERSION,
    defaults: { ...DEFAULT_CAPS },
    projects: [{ ...project("demo"), authority: { merges: "orchestrator" } }],
  });

  expect(() => loadConfig()).toThrow(/authority has unknown key\(s\): merges/);
});

test("escalation.orchestrator defaults to embedded and rejects anything but the two modes", () => {
  const { escalation, ...rest } = project("demo");
  const { orchestrator, ...escalationWithoutMode } = escalation;
  writeRawConfig({
    version: CONFIG_VERSION,
    defaults: { ...DEFAULT_CAPS },
    projects: [{ ...rest, escalation: escalationWithoutMode }],
  });
  expect(loadConfig().projects[0]?.escalation.orchestrator).toBe("embedded");

  writeRawConfig({
    version: CONFIG_VERSION,
    defaults: { ...DEFAULT_CAPS },
    projects: [{ ...rest, escalation: { ...escalation, orchestrator: "externl" } }],
  });
  // A typo that resolved to "embedded" would start a second brain beside the
  // operator's own session, and both would triage the same issue.
  expect(() => loadConfig()).toThrow(
    /escalation\.orchestrator must be "embedded" or "external", found "externl"/,
  );
});

test("a repo without graphProject keeps the key absent, so nothing renders a graph", () => {
  const original = config(project("demo"));
  saveConfig(original);

  // Not `undefined`, not `""`: absent. The worker brief's graph paragraph is
  // rendered from this key's presence, so a project that never answered the
  // question must produce the brief this package shipped before graphs existed.
  expect(loadConfig()).toEqual(original);
  expect(Object.hasOwn(loadConfig().projects[0]?.routing.repos["api"] ?? {}, "graphProject")).toBe(false);
});

test("a configured graphProject survives a round-trip, with ~ expanded", () => {
  const p = project("demo");
  const api = p.routing.repos["api"];
  if (api === undefined) throw new Error("fixture lost its repo");
  api.graphProject = "~/.cache/conductor-graph/acme/api";
  writeRawConfig({ version: CONFIG_VERSION, defaults: { ...DEFAULT_CAPS }, projects: [p] });

  // Expanded on load for the same reason workspaceRoot is: a literal `~`
  // directory is nobody's intent, and the path is handed to another process.
  expect(loadConfig().projects[0]?.routing.repos["api"]?.graphProject).toBe(
    join(homedir(), ".cache", "conductor-graph", "acme", "api"),
  );
});

test("loadConfig refuses a relative graphProject instead of resolving it", () => {
  const p = project("demo");
  const api = p.routing.repos["api"];
  if (api === undefined) throw new Error("fixture lost its repo");
  api.graphProject = "../graph/api";
  writeRawConfig({ version: CONFIG_VERSION, defaults: { ...DEFAULT_CAPS }, projects: [p] });

  // This path is written by one process and read by another — a worker session
  // whose cwd is its own throwaway worktree. A relative value would name a
  // different directory for every reader and the indexed one for none of them,
  // and the worker would find an empty graph and silently go back to grepping.
  expect(() => loadConfig()).toThrow(/graphProject must be an absolute path/);
  expect(() => loadConfig()).toThrow(/\.\.\/graph\/api/);
});

test("loadConfig reports a misshapen reporting block alongside every other fault", () => {
  writeRawConfig({
    version: 1,
    defaults: { ...DEFAULT_CAPS },
    projects: [{ ...project("demo"), queueLabel: "", reporting: { scope: "material", digest: "daily" } }],
  });

  let message = "";
  try {
    loadConfig();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }

  expect(message).toContain("reporting has unknown key(s): digest");
  expect(message).toContain("queueLabel must be a non-empty string");
});

test("loadConfig rejects a reporting block that is not an object", () => {
  writeRawConfig({
    version: 1,
    defaults: { ...DEFAULT_CAPS },
    projects: [{ ...project("demo"), reporting: "material" }],
  });

  expect(() => loadConfig()).toThrow(/reporting must be an object with a "scope"/);
});

test("a v1 config keeps loading after a cap is retired, and reports as v2", () => {
  writeRawConfig({
    version: 1,
    defaults: { ...DEFAULT_CAPS, retiredCapFromAnOlderVersion: 6 },
    projects: [{ ...project("demo"), caps: { retiredCapFromAnOlderVersion: 4 } }],
  });

  // Every config the wizard has ever written carries the caps current at the
  // time. Refusing to load is how an upgrade strands a fleet whose config is
  // otherwise fine — so a v1 file drops what no longer exists and migrates up.
  const loaded = loadConfig();
  expect(loaded.version).toBe(CONFIG_VERSION);
  expect(loaded.defaults).toEqual(DEFAULT_CAPS);
  expect(loaded.projects[0]?.caps).toEqual({});
});

test("a v2 config rejects an unknown cap key, because there is nothing left to retire", () => {
  writeRawConfig({
    version: CONFIG_VERSION,
    defaults: { ...DEFAULT_CAPS },
    projects: [{ ...project("demo"), caps: { dailySpendUSD: 5 } }],
  });

  // The typo that motivates this: a mistyped spend ceiling reads as configured
  // while the real ceiling is the shipped default — five dollars intended,
  // twenty-five enforced.
  expect(() => loadConfig()).toThrow(/caps has unknown key\(s\): dailySpendUSD/);
});

test("a cap whose value cannot be read is rejected at either version", () => {
  for (const version of [1, CONFIG_VERSION]) {
    writeRawConfig({
      version,
      defaults: { ...DEFAULT_CAPS },
      projects: [{ ...project("demo"), caps: { dailySpendUsd: "twenty" } }],
    });

    // Tolerating a retired *key* must never soften a cap the operator did set:
    // a ceiling the daemon cannot read is worth stopping for.
    expect(() => loadConfig()).toThrow(/caps\.dailySpendUsd must be a non-negative finite number/);
  }
});

test("workerModel survives a save/load round-trip", () => {
  saveConfig(config({ ...project("demo"), workerModel: "smol" }));

  expect(loadConfig().projects[0]?.workerModel).toBe("smol");
});

test("an unusable workerModel is dropped rather than failing the load", () => {
  writeRawConfig({
    version: 1,
    defaults: { ...DEFAULT_CAPS },
    projects: [
      { ...project("blank"), workerModel: "   " },
      { ...project("wrongType"), workerModel: 7 },
    ],
  });

  // A model is a hint to the harness, not a ceiling: the worst case is a run on
  // the default model, and the session's own fallback notice is what says so.
  const loaded = loadConfig();
  expect(loaded.projects[0]?.workerModel).toBeUndefined();
  expect(loaded.projects[1]?.workerModel).toBeUndefined();
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
    dailySpendUsd: 40,
    workerMaxTurns: 200,
    workerWallClockMs: 60_000,
    maxAttemptsPerIssue: 4,
    maxContinuationsPerIssue: 3,
  };
  const p = project("demo");
  p.caps = { workerMaxTurns: 7, dailySpendUsd: 0 };

  expect(resolveCaps(p, defaults)).toEqual({
    maxConcurrentWorkers: 3,
    // An explicit 0 is a hard stop, so it must survive the merge.
    dailySpendUsd: 0,
    workerMaxTurns: 7,
    workerWallClockMs: 60_000,
    maxAttemptsPerIssue: 4,
    maxContinuationsPerIssue: 3,
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

test("dailySpendUsd null means no spend gate", () => {
  const p = project("demo");
  p.caps = { dailySpendUsd: null };
  saveConfig(config(p));
  const cfg = loadConfig();
  expect(cfg.projects[0]?.caps?.dailySpendUsd).toBeNull();
  expect(resolveCaps(cfg.projects[0]!, DEFAULT_CAPS).dailySpendUsd).toBeNull();
});
