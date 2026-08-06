/**
 * Behavioural tests for the setup wizard's headless core.
 *
 * Nothing here touches the network or `gh`: the functions under test are the
 * ones that decide what the config will say, and those are pure. `gh`-backed
 * scope and label discovery is deliberately out of scope — mocking a subprocess
 * would only assert that the mock was called.
 *
 * `$OMP_CONDUCTOR_HOME` and `$OMP_TELEGRAM_STATE_DIR` are pointed at fresh temp
 * directories per test and restored afterwards, so nothing here can read — or
 * clobber — a real install.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, stateDir } from "./config.ts";
import {
  buildConfig,
  detectTelegram,
  summarisePlan,
  type LabelPlan,
  type ScopeCheck,
  type SetupAnswers,
  type TelegramPresence,
} from "./setup.ts";
import { DEFAULT_CAPS } from "./types.ts";

const CONDUCTOR_HOME = "OMP_CONDUCTOR_HOME";
const TELEGRAM_HOME = "OMP_TELEGRAM_STATE_DIR";

let home = "";
let telegramHome = "";
let previousHome: string | undefined;
let previousTelegramHome: string | undefined;

beforeEach(() => {
  previousHome = process.env[CONDUCTOR_HOME];
  previousTelegramHome = process.env[TELEGRAM_HOME];
  home = mkdtempSync(join(tmpdir(), "omp-conductor-setup-"));
  telegramHome = mkdtempSync(join(tmpdir(), "omp-conductor-telegram-"));
  process.env[CONDUCTOR_HOME] = home;
  process.env[TELEGRAM_HOME] = telegramHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env[CONDUCTOR_HOME];
  else process.env[CONDUCTOR_HOME] = previousHome;
  if (previousTelegramHome === undefined) delete process.env[TELEGRAM_HOME];
  else process.env[TELEGRAM_HOME] = previousTelegramHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(telegramHome, { recursive: true, force: true });
});

/** A complete set of answers, as the wizard would hand them over. */
function answers(overrides: Partial<SetupAnswers> = {}): SetupAnswers {
  return {
    projectName: "demo",
    trackerRepo: "acme/demo",
    queueLabel: "ready-for-agent",
    stateLabels: { inProgress: "agent:in-progress", blocked: "agent:blocked", failed: "agent:failed" },
    routingLabelPrefix: "repo:",
    targetRepos: [
      {
        name: "api",
        cloneUrl: "git@github.com:acme/api.git",
        defaultBranch: "main",
        gates: [{ cmd: "bun run check", cwd: "." }],
      },
    ],
    caps: {},
    fallbackToIssueComment: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------- buildConfig

test("a config built from answers survives its own validator", () => {
  // The wizard's whole job is emitting something loadConfig() accepts. If these
  // two ever disagree, setup writes a file the daemon then refuses to start on.
  const built = buildConfig(
    answers({
      caps: { maxConcurrentWorkers: 3, dailySpendUsd: 40 },
      telegramChatId: "424242",
      fallbackToIssueComment: false,
    }),
  );

  saveConfig(built);
  const loaded = loadConfig();

  expect(loaded).toEqual(built);
  const project = loaded.projects[0];
  expect(project?.tracker).toEqual({ kind: "github", repo: "acme/demo" });
  expect(project?.caps).toEqual({ maxConcurrentWorkers: 3, dailySpendUsd: 40 });
  expect(project?.escalation).toEqual({ fallbackToIssueComment: false, telegramChatId: "424242" });
  expect(project?.routing.repos["api"]?.gates).toEqual([{ cmd: "bun run check", cwd: "." }]);
  expect(loaded.defaults).toEqual(DEFAULT_CAPS);
});

test("re-running setup for one project replaces it and leaves the others alone", () => {
  const first = buildConfig(answers({ projectName: "demo" }));
  const both = buildConfig(answers({ projectName: "homelab", trackerRepo: "acme/homelab" }), first);
  expect(both.projects.map((p) => p.name)).toEqual(["demo", "homelab"]);

  const rerun = buildConfig(
    answers({ projectName: "demo", trackerRepo: "acme/demo-next", queueLabel: "queued" }),
    both,
  );

  // Replaced in place, not appended and not deduplicated away.
  expect(rerun.projects.map((p) => p.name)).toEqual(["demo", "homelab"]);
  expect(rerun.projects[0]?.tracker.repo).toBe("acme/demo-next");
  expect(rerun.projects[0]?.queueLabel).toBe("queued");
  // The neighbour is byte-identical to what it was before this run.
  expect(rerun.projects[1]).toEqual(both.projects[1]!);

  // And the result is still loadable, which is what makes the replacement safe.
  saveConfig(rerun);
  expect(loadConfig().projects).toHaveLength(2);
});

test("worktrees and mirrors are derived from the state directory, not the repo", () => {
  const project = buildConfig(answers()).projects[0];

  expect(stateDir()).toBe(home);
  expect(project?.workspaceRoot).toBe(join(home, "worktrees"));
  expect(project?.mirrorRoot).toBe(join(home, "mirrors"));
});

// --------------------------------------------------------------- summarisePlan

/** Two of four missing, so the summary has to distinguish rather than list all. */
function labelPlan(): LabelPlan[] {
  return [
    { name: "ready-for-agent", colour: "0e8a16", description: "queued", exists: false },
    { name: "agent:in-progress", colour: "1d76db", description: "running", exists: true },
    { name: "agent:blocked", colour: "fbca04", description: "parked", exists: false },
    { name: "agent:failed", colour: "b60205", description: "gave up", exists: true },
  ];
}

const NO_TELEGRAM: TelegramPresence = { available: false, stateDir: "/nowhere", hasToken: false };

test("the plan names every label it would create", () => {
  const scopes: ScopeCheck = { ok: true, login: "acme", scopes: ["repo", "project"], missing: [] };

  const text = summarisePlan(answers(), scopes, labelPlan(), NO_TELEGRAM);

  expect(text).toContain("would CREATE 2");
  for (const label of labelPlan().filter((l) => !l.exists)) {
    expect(text).toContain(`+ ${label.name}`);
  }
  // Already-present labels are reported as present, never as pending creation.
  expect(text).toContain("already present: agent:in-progress, agent:failed");
  expect(text).not.toContain("+ agent:in-progress");
  expect(text).not.toContain("MISSING TOKEN SCOPE");
});

test("a missing token scope is a prominent warning, not a footnote", () => {
  const scopes: ScopeCheck = { ok: false, login: "acme", scopes: ["gist"], missing: ["repo", "project"] };

  const text = summarisePlan(answers(), scopes, labelPlan(), NO_TELEGRAM);

  expect(text).toContain("MISSING TOKEN SCOPE: repo, project");
  expect(text).toContain("gh auth refresh -s repo,project");
  // Prominent means first: an operator skimming the top of the plan sees it.
  expect(text.split("\n")[0]).toContain("MISSING TOKEN SCOPE");
});

test("the plan shows effective caps, marking the ones that were answered", () => {
  const scopes: ScopeCheck = { ok: true, login: "acme", scopes: ["repo", "project"], missing: [] };

  const text = summarisePlan(answers({ caps: { maxConcurrentWorkers: 5 } }), scopes, labelPlan(), NO_TELEGRAM);

  expect(text).toContain("maxConcurrentWorkers");
  expect(text).toMatch(/maxConcurrentWorkers\s+5\s+\(answered\)/);
  // Unanswered caps still show, at the shipped default, so nothing is implicit.
  expect(text).toMatch(new RegExp(`maxIssuesPerDay\\s+${DEFAULT_CAPS.maxIssuesPerDay}$`, "m"));
});

// -------------------------------------------------------------- detectTelegram

test("a directory with no omp-telegram install is simply unavailable", () => {
  process.env[TELEGRAM_HOME] = join(telegramHome, "does-not-exist");

  expect(detectTelegram()).toEqual({
    available: false,
    stateDir: join(telegramHome, "does-not-exist"),
    hasToken: false,
  });
});

test("a paired omp-telegram install is detected without leaking the token", () => {
  const secret = "1234567:AA-this-value-must-never-escape";
  writeFileSync(join(telegramHome, ".env"), `# comment\nTELEGRAM_BOT_TOKEN="${secret}"\nOTHER=1\n`);
  writeFileSync(
    join(telegramHome, "access.json"),
    JSON.stringify({ enabled: true, allowFrom: ["424242"], groups: {} }),
  );

  const found = detectTelegram();

  expect(found.available).toBe(true);
  expect(found.hasToken).toBe(true);
  expect(found.pairedOwnerId).toBe("424242");
  // The one property that matters: presence is reported, the value is not.
  expect(JSON.stringify(found)).not.toContain(secret);
  expect(JSON.stringify(found)).not.toContain("AA-this-value");
});

test("several paired chats means no owner can be offered", () => {
  writeFileSync(join(telegramHome, ".env"), "TELEGRAM_BOT_TOKEN=abc\n");
  writeFileSync(join(telegramHome, "access.json"), JSON.stringify({ allowFrom: ["1", "2"] }));

  const found = detectTelegram();

  expect(found.hasToken).toBe(true);
  // Guessing which of two humans owns escalations would page a stranger.
  expect(found.pairedOwnerId).toBeUndefined();
});

test("an install with no token line is available but cannot send", () => {
  writeFileSync(join(telegramHome, ".env"), "# TELEGRAM_BOT_TOKEN=commented-out\nOTHER=1\n");
  writeFileSync(join(telegramHome, "access.json"), JSON.stringify({ allowFrom: ["424242"] }));

  const found = detectTelegram();

  expect(found.available).toBe(true);
  expect(found.hasToken).toBe(false);
  expect(found.pairedOwnerId).toBe("424242");
});
