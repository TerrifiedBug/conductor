/**
 * The wizard's conversation, driven through a scripted dialog surface.
 *
 * `collectSetup` is the whole of `/conductor setup` up to — and not including —
 * its first read of GitHub, so everything here runs with no `gh`, no network and
 * no daemon. What is worth testing at this level is which questions get asked:
 * a first run must ask everything it always did, and an amend must ask one area's
 * questions and carry the rest of the config through untouched.
 *
 * `$OMP_CONDUCTOR_HOME` and `$OMP_TELEGRAM_STATE_DIR` are pointed at fresh temp
 * directories per test, so nothing here can read — or clobber — a real install,
 * and `detectTelegram()` reliably finds nothing.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config.ts";
import { collectSetup } from "./plugin.ts";
import {
  ORCHESTRATOR_BRIEF_NAME,
  POLICY_BRIEF_NAME,
  answersFromProject,
  buildConfig,
  buildProject,
  type SetupAnswers,
} from "./setup.ts";
import { DEFAULT_CAPS, type ProjectConfig } from "./types.ts";
import { hostRamBytes, recommendedMaxWorkers } from "./host.ts";

const CONDUCTOR_HOME = "OMP_CONDUCTOR_HOME";
const TELEGRAM_HOME = "OMP_TELEGRAM_STATE_DIR";

let home = "";
let telegramHome = "";
let previousHome: string | undefined;
let previousTelegramHome: string | undefined;

beforeEach(() => {
  previousHome = process.env[CONDUCTOR_HOME];
  previousTelegramHome = process.env[TELEGRAM_HOME];
  home = mkdtempSync(join(tmpdir(), "omp-conductor-plugin-"));
  telegramHome = mkdtempSync(join(tmpdir(), "omp-conductor-plugin-tg-"));
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

/**
 * What an operator would do, keyed by a substring of the prompt's title.
 *
 * Anything unlisted takes the answer an operator gets by pressing Enter: an
 * empty `input` (which the wizard reads as "accept the shown default"), `no` on
 * a `confirm`, and the row a `select` put its cursor on. That default matters —
 * "Enter accepts what you see" is the contract the whole wizard is built on, so
 * a test that has to script an answer is a test whose default moved.
 *
 * An array answers successive prompts with the same title in turn, and its last
 * entry repeats. `null` dismisses the dialog, which abandons the wizard.
 */
interface Script {
  input?: Record<string, string>;
  confirm?: Record<string, boolean | boolean[]>;
  select?: Record<string, string | number | null>;
}

/** A recording dialog surface: what was asked, in order, and what was shown. */
function dialogs(script: Script = {}) {
  const asked: string[] = [];
  const menus: { title: string; labels: string[] }[] = [];
  const notices: string[] = [];
  const seen = new Map<string, number>();

  const answer = <T>(table: Record<string, T> | undefined, title: string): T | undefined => {
    for (const [key, value] of Object.entries(table ?? {})) {
      if (!title.includes(key)) continue;
      if (!Array.isArray(value)) return value;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return (value[Math.min(n, value.length - 1)] ?? value.at(-1)) as T;
    }
    return undefined;
  };

  const ctx = {
    ui: {
      notify: (message: string) => {
        notices.push(message);
      },
      confirm: async (title: string) => {
        asked.push(`confirm: ${title}`);
        const scripted = answer(script.confirm, title);
        return Array.isArray(scripted) ? false : (scripted ?? false);
      },
      input: async (title: string) => {
        asked.push(`input: ${title}`);
        return answer(script.input, title) ?? "";
      },
      select: async (
        title: string,
        options: { label: string; description?: string }[],
        dialogOptions?: { initialIndex?: number },
      ) => {
        asked.push(`select: ${title}`);
        menus.push({ title, labels: options.map((o) => o.label) });
        const chosen = answer(script.select, title);
        if (chosen === null) return undefined;
        if (typeof chosen === "number") return options[chosen]?.label;
        if (typeof chosen === "string") return options.find((o) => o.label.startsWith(chosen))?.label ?? chosen;
        // Enter: the row the wizard put the cursor on.
        return options[dialogOptions?.initialIndex ?? 0]?.label;
      },
    },
  };

  return { ctx, asked, menus, notices };
}

/** A real fleet's config: every optional answered, so a carry-through that drops
 *  a field is visible. Two repos, because one hides every per-repo bug. */
function fullAnswers(overrides: Partial<SetupAnswers> = {}): SetupAnswers {
  return {
    projectName: "veltro",
    trackerRepo: "veltrosecurity/veltro",
    queueLabel: "queued",
    stateLabels: { inProgress: "agent:busy", blocked: "agent:parked", failed: "agent:gave-up" },
    routingLabelPrefix: "module:",
    targetRepos: [
      {
        name: "chad",
        cloneUrl: "https://github.com/veltrosecurity/chad.git",
        defaultBranch: "main",
        gates: [
          { cmd: "ruff check .", cwd: "backend" },
          { cmd: "pnpm lint", cwd: "frontend" },
        ],
      },
      {
        name: "vectorflow",
        cloneUrl: "https://github.com/veltrosecurity/vectorflow.git",
        defaultBranch: "trunk",
        gates: [{ cmd: "pnpm lint", cwd: "." }],
      },
    ],
    caps: {
      maxConcurrentWorkers: 3,
      dailySpendUsd: 40,
      workerMaxTurns: 200,
      workerWallClockMs: 5_400_000,
      maxAttemptsPerIssue: 1,
    },
    workerModel: "anthropic/claude-sonnet-4",
    telegramChatId: "8236653927",
    fallbackToIssueComment: false,
    reportScope: "escalations",
    authority: { merge: "orchestrator", release: "orchestrator" },
    orchestratorMode: "external",
    writeOrchestratorBrief: false,
    ...overrides,
  };
}

/** Through the real validator and back, which is where an amend starts: from
 *  what is on disk, not from what the wizard happened to hold. */
function savedProject(a: SetupAnswers): ProjectConfig {
  saveConfig(buildConfig(a));
  const project = loadConfig().projects[0];
  if (project === undefined) throw new Error("buildConfig wrote no project");
  return project;
}

/** Key-order-independent JSON, so "identical" means every value is identical
 *  rather than that two builders happened to assign in the same order. */
function serialise(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, stable(x)]),
    );
  };
  return JSON.stringify(stable(value), null, 2);
}

/** The project with every `graphProject` removed — what it looked like before the
 *  graph area was amended, and nothing else. */
function withoutGraph(p: ProjectConfig): ProjectConfig {
  const repos = Object.fromEntries(
    Object.entries(p.routing.repos).map(([key, repo]) => {
      const { graphProject: _dropped, ...rest } = repo;
      return [key, rest];
    }),
  );
  return { ...p, routing: { ...p.routing, repos } };
}

// ------------------------------------------------------------------- first run


/** Caps left empty when the host keeps the shipped worker default; otherwise
 *  the small-host override that askCaps writes without a Caps confirm. */
function expectedDefaultCaps(): { maxConcurrentWorkers?: number } {
  const workers = recommendedMaxWorkers(hostRamBytes());
  return workers === DEFAULT_CAPS.maxConcurrentWorkers
    ? {}
    : { maxConcurrentWorkers: workers };
}

test("a first run asks no amend question and collects what it always collected", async () => {
  const d = dialogs({
    input: {
      "Project name": "demo",
      "Tracker repo": "acme/demo",
      "Routing key": "api",
      "Clone URL": "git@github.com:acme/api.git",
      "Pre-push gates": "bun run check, bun test @ server",
    },
    confirm: { "Escalation fallback": true },
  });

  const { answers, amend } = await collectSetup(d.ctx, undefined, undefined);

  expect(amend).toBeUndefined();

  // Every prompt, in order. Pinned rather than spot-checked: amend mode reshaped
  // the code behind this conversation, and a question that quietly stopped being
  // asked is a config key written without consent.
  expect(d.asked).toEqual([
    "input: Project name",
    "input: Tracker repo (owner/repo) — where ready issues live",
    "input: Queue label — the human sign-off that makes an issue claimable",
    "confirm: State labels",
    "input: Routing label prefix — an issue picks its checkout with <prefix><repo>",
    'input: Routing key for repo 1 — the "repo:<key>" label an issue carries',
    "input: Clone URL for repo:api",
    "input: Default branch for api — worktrees are cut from it and PRs target it",
    "input: Pre-push gates for api — exactly what CI runs, comma separated",
    "confirm: Another repo?",
    "confirm: Code-graph discovery",
    "confirm: Caps",
    "confirm: Merge authority",
    "confirm: Release authority",
    "input: Worker model pattern (blank = harness default)",
    "confirm: Escalation fallback",
    "confirm: Orchestrator session",
    "select: What should the orchestrator report unprompted?",
    `confirm: Write ${ORCHESTRATOR_BRIEF_NAME} + ${POLICY_BRIEF_NAME} under ${join(home, "worktrees")}?`,
  ]);

  // Enter accepted every default. Caps stay empty on ≥16 GiB hosts (inherit
  // DEFAULT_CAPS); under 16 GiB askCaps writes maxConcurrentWorkers: 1 (#51).
  expect(answers).toEqual({
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
        gates: [
          { cmd: "bun run check", cwd: "." },
          { cmd: "bun test", cwd: "server" },
        ],
      },
    ],
    caps: expectedDefaultCaps(),
    fallbackToIssueComment: true,
    authority: { merge: "human", release: "human" },
    orchestratorMode: "embedded",
    reportScope: "material",
    writeOrchestratorBrief: false,
  });
});

test("a project this config has never seen is created rather than amended", async () => {
  savedProject(fullAnswers());
  const d = dialogs({
    input: {
      "Project name": "homelab",
      "Tracker repo": "acme/homelab",
      "Routing key": "web",
      "Clone URL": "git@github.com:acme/web.git",
      "Pre-push gates": "pnpm lint",
    },
  });

  const { answers, amend } = await collectSetup(d.ctx, loadConfig(), "homelab");

  expect(amend).toBeUndefined();
  expect(d.asked.filter((a) => a.includes("already configured"))).toEqual([]);
  expect(answers.projectName).toBe("homelab");
  // Seeded from the shipped defaults, never from the neighbour that happens to
  // be in the same file.
  expect(answers.queueLabel).toBe("ready-for-agent");
  expect(answers.routingLabelPrefix).toBe("repo:");
  expect(answers.caps).toEqual(expectedDefaultCaps());
});

// ----------------------------------------------------------------- amend mode

test("amending the code graph adds the graph and moves nothing else", async () => {
  const before = savedProject(fullAnswers());
  const root = join(home, "graph", "veltrosecurity");
  const d = dialogs({
    select: { "already configured": "Change one area", "Which area": "code graph" },
    confirm: { "Code-graph discovery": true },
    input: { "Root for those clones": root },
  });

  const { answers, amend } = await collectSetup(d.ctx, loadConfig(), "veltro");

  expect(amend?.area).toBe("graph");
  // Two questions, and they are the graph's own. This is the whole point of the
  // feature: a key that shipped after a fleet was configured costs two prompts.
  expect(d.asked.filter((a) => !a.startsWith("select:"))).toEqual([
    "confirm: Code-graph discovery",
    "input: Root for those clones — one per repo (chad, vectorflow) is created under it",
  ]);

  const after = buildProject(answers);
  expect(after.routing.repos["chad"]?.graphProject).toBe(join(root, "chad"));
  expect(after.routing.repos["vectorflow"]?.graphProject).toBe(join(root, "vectorflow"));
  // The regression that matters: caps, gates, routing, escalation, authority and
  // reporting are byte-identical to what was read off disk.
  expect(serialise(withoutGraph(after))).toBe(serialise(before));
});

test("amending gates re-asks the gate lines and nothing about the repos", async () => {
  const before = savedProject(fullAnswers());
  const d = dialogs({
    select: { "already configured": "Change one area", "Which area": "gates" },
    input: {
      "Pre-push gates for chad": "ruff check . @ backend, pnpm lint @ frontend, pnpm test @ frontend",
    },
  });

  const { answers, amend } = await collectSetup(d.ctx, loadConfig(), "veltro");

  expect(amend?.area).toBe("gates");
  // One prompt per repo — no clone URL, no branch, no routing key retyped.
  expect(d.asked.filter((a) => !a.startsWith("select:"))).toEqual([
    "input: Pre-push gates for chad — exactly what CI runs, comma separated",
    "input: Pre-push gates for vectorflow — exactly what CI runs, comma separated",
  ]);

  const after = buildProject(answers);
  expect(after.routing.repos["chad"]?.gates).toEqual([
    { cmd: "ruff check .", cwd: "backend" },
    { cmd: "pnpm lint", cwd: "frontend" },
    { cmd: "pnpm test", cwd: "frontend" },
  ]);
  // Enter on vectorflow's line re-affirmed the gates it already had, rather than
  // clearing them — the pre-filled placeholder has to round-trip.
  expect(after.routing.repos["vectorflow"]).toEqual(before.routing.repos["vectorflow"]!);
  // Put chad's old entry back and the whole project is identical again.
  const restored: ProjectConfig = {
    ...after,
    routing: {
      ...after.routing,
      repos: { ...after.routing.repos, chad: before.routing.repos["chad"]! },
    },
  };
  expect(serialise(restored)).toBe(serialise(before));
});

test("an amend that changes its answer to the same value writes the same config", async () => {
  const before = savedProject(fullAnswers());
  const d = dialogs({ select: { "already configured": "Change one area", "Which area": "reporting scope" } });

  const { answers, amend } = await collectSetup(d.ctx, loadConfig(), "veltro");

  expect(amend?.area).toBe("reporting");
  expect(d.asked).toEqual([
    'select: "veltro" is already configured — what would you like to do?',
    "select: Which area? Each row shows what it says now",
    "select: What should the orchestrator report unprompted?",
  ]);
  // The scope list opens on the configured scope, so Enter re-affirms it and the
  // rebuilt project is the one that was already there.
  expect(serialise(buildProject(answers))).toBe(serialise(before));
});

test("the amend menu shows each area's current value", async () => {
  const project = savedProject(fullAnswers());
  const d = dialogs({ select: { "already configured": "Change one area", "Which area": "code graph" } });

  await collectSetup(d.ctx, loadConfig(), "veltro");

  const menu = d.menus.find((m) => m.title.startsWith("Which area"));
  expect(menu?.labels).toEqual([
    `tracker & repos — veltrosecurity/veltro, queue "queued", "module:" → chad, vectorflow`,
    "gates — chad: ruff check . @ backend, pnpm lint @ frontend; vectorflow: pnpm lint",
    "caps & worker model — 3 workers, 200 turns, 90m, $40/day, 1 failed attempt, 2 continuations — model anthropic/claude-…",
    "code graph — not configured — workers grep",
    "authority — merge=orchestrator, release=orchestrator",
    "escalation & triage — tier 2 pages Telegram 8236653927, no comment fallback, triage external",
    "reporting scope — escalations — escalations when they happen, plus one daily digest — silent otherwise",
    `orchestrator brief — none at ${join(project.workspaceRoot, ORCHESTRATOR_BRIEF_NAME)}`,
  ]);
});

test("only the chosen area's questions are asked, whichever area it is", async () => {
  savedProject(fullAnswers());
  const existing = loadConfig();

  // Each area, asked with nothing scripted: what it asks is what it owns.
  const asked = async (area: string) => {
    const d = dialogs({ select: { "already configured": "Change one area", "Which area": area } });
    await collectSetup(d.ctx, existing, "veltro");
    return d.asked.filter((a) => !a.startsWith("select:"));
  };

  expect(await asked("authority")).toEqual(["confirm: Merge authority", "confirm: Release authority"]);
  expect(await asked("caps & worker model")).toEqual([
    "confirm: Caps",
    "input: Worker model pattern (blank = harness default)",
  ]);
  expect(await asked("escalation & triage")).toEqual([
    "confirm: Escalation fallback",
    "confirm: Orchestrator session",
  ]);
  expect(await asked("reporting scope")).toEqual([]);
  expect(await asked("orchestrator brief")).toEqual([
    `confirm: Write ${ORCHESTRATOR_BRIEF_NAME} + ${POLICY_BRIEF_NAME} under ${join(home, "worktrees")}?`,
  ]);
});

test("re-interviewing a configured project pre-fills every prompt from it", async () => {
  const before = savedProject(fullAnswers());
  const d = dialogs({
    select: { "already configured": "Walk every question again" },
    confirm: {
      // The two grants and the triage answer are the only questions whose "no" is
      // a change: they start on no by design, so Enter revokes rather than renews.
      "Merge authority": true,
      "Release authority": true,
      "Orchestrator session": true,
      "Another repo?": [true, false],
    },
  });

  const { answers, amend } = await collectSetup(d.ctx, loadConfig(), "veltro");

  expect(amend).toBeUndefined();
  // Enter through the whole interview and the saved config comes back out, which
  // is what makes the seed — not each prompt — the single source of a default.
  expect(serialise(buildProject(answers))).toBe(serialise(before));
  expect(answers).toEqual(answersFromProject(before));
});

test("dismissing a dialog abandons the amend rather than guessing an area", async () => {
  savedProject(fullAnswers());
  const existing = loadConfig();

  const first = dialogs({ select: { "already configured": null } });
  await expect(collectSetup(first.ctx, existing, "veltro")).rejects.toThrow("setup cancelled");

  const second = dialogs({ select: { "already configured": "Change one area", "Which area": null } });
  await expect(collectSetup(second.ctx, existing, "veltro")).rejects.toThrow("setup cancelled");
});

test("a select answered with a label nobody offered falls back to asking everything", async () => {
  savedProject(fullAnswers());
  const d = dialogs({
    select: { "already configured": "Something the harness invented" },
    confirm: { "Merge authority": true, "Release authority": true, "Orchestrator session": true, "Another repo?": [true, false] },
  });

  const { amend } = await collectSetup(d.ctx, loadConfig(), "veltro");

  // The full interview is the answer that cannot silently skip a question.
  expect(amend).toBeUndefined();
  expect(d.notices.some((n) => n.includes("Unrecognised choice"))).toBe(true);
  expect(d.asked).toContain("input: Project name");
});
