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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, stateDir } from "./config.ts";
import {
  ORCHESTRATOR_BRIEF_NAME,
  REPORT_SCOPE_CHOICES,
  buildConfig,
  detectTelegram,
  orchestratorBriefPath,
  renderOrchestratorBrief,
  summarisePlan,
  writeOrchestratorBrief,
  type LabelPlan,
  type ScopeCheck,
  type SetupAnswers,
  type TelegramPresence,
} from "./setup.ts";
import { DEFAULT_AUTHORITY, DEFAULT_CAPS, DEFAULT_REPORT_SCOPE } from "./types.ts";

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
    reportScope: DEFAULT_REPORT_SCOPE,
    authority: { ...DEFAULT_AUTHORITY },
    orchestratorMode: "embedded",
    writeOrchestratorBrief: false,
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
  expect(project?.escalation).toEqual({
    fallbackToIssueComment: false,
    telegramChatId: "424242",
    orchestrator: "embedded",
  });
  expect(project?.authority).toEqual({ merge: "human", release: "human" });
  expect(project?.routing.repos["api"]?.gates).toEqual([{ cmd: "bun run check", cwd: "." }]);
  expect(project?.reporting).toEqual({ scope: "material" });
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

test("the chosen report scope reaches the config the daemon will load", () => {
  saveConfig(buildConfig(answers({ reportScope: "escalations" })));

  expect(loadConfig().projects[0]?.reporting).toEqual({ scope: "escalations" });
});

test("one answered graph root becomes one index-only clone per routed repo", () => {
  const root = join(home, "graph", "acme");
  saveConfig(
    buildConfig(
      answers({
        graphRoot: root,
        targetRepos: [
          { name: "api", cloneUrl: "git@github.com:acme/api.git", defaultBranch: "main", gates: [] },
          { name: "web", cloneUrl: "git@github.com:acme/web.git", defaultBranch: "trunk", gates: [] },
        ],
      }),
    ),
  );

  // Siblings under one root, and absolute — the validator would reject anything
  // else, because a worker reads these from inside its own worktree.
  const repos = loadConfig().projects[0]?.routing.repos;
  expect(repos?.["api"]?.graphProject).toBe(join(root, "api"));
  expect(repos?.["web"]?.graphProject).toBe(join(root, "web"));
});

test("declining code-graph discovery writes no graph key at all", () => {
  saveConfig(buildConfig(answers()));

  // The invariant behind the whole feature being optional: with no answer, the
  // config is what it was before graphs existed, so every brief this project
  // ever renders is too.
  const api = loadConfig().projects[0]?.routing.repos["api"];
  expect(Object.hasOwn(api ?? {}, "graphProject")).toBe(false);
});

// --------------------------------------------------------- orchestrator brief

test("the rendered brief carries this project's coordinates and nothing unfilled", () => {
  const text = renderOrchestratorBrief(
    answers({ projectName: "homelab", trackerRepo: "acme/planning", queueLabel: "queued" }),
  );

  expect(text).toContain("homelab");
  expect(text).toContain("acme/planning");
  expect(text).toContain("`queued`");
  // An unfilled placeholder means the template and the renderer disagree about a
  // key, and the operator's brief would ship that literally to their session.
  expect(text).not.toMatch(/\{\{[A-Za-z0-9_]+\}\}/);
});

test("the brief defaults to never releasing, and says the section is the operator's", () => {
  const text = renderOrchestratorBrief(answers());

  // The package's own boundary: whatever an operator writes later, the shipped
  // default must never read as permission to release or to merge.
  expect(text).toContain("## Releases (yours to define)");
  expect(text).toContain("**Default: humans release, and you do not merge.**");
  expect(text).toContain("YOURS TO EDIT");
  // And the fixed half stays fixed: duties, tiers, evidence.
  expect(text).toContain("## Duty 1 — drain");
  expect(text).toContain("## Duty 2 — groom");
  expect(text).toContain("## Duty 3 — report");
  expect(text).toContain("Every claim cites evidence");
});

test("delegating in setup renders a Releases paragraph that says so", () => {
  const text = renderOrchestratorBrief(answers({ authority: { merge: "orchestrator", release: "orchestrator" } }));

  // The whole point of the key: the session must never read a prohibition its
  // own config has already lifted.
  expect(text).toContain("**Delegated in setup: you merge, and you release.**");
  expect(text).not.toContain("**Default: humans release, and you do not merge.**");
  // Delegated or not, the procedure is still the operator's to write.
  expect(text).toContain("Spell out all seven.");
});

test("each authority combination renders its own paragraph, and none renders a placeholder", () => {
  for (const merge of ["human", "orchestrator"] as const) {
    for (const release of ["human", "orchestrator"] as const) {
      const text = renderOrchestratorBrief(answers({ authority: { merge, release } }));

      expect(text).not.toContain("{{RELEASES_DEFAULT}}");
      expect(text).toContain(
        merge === "orchestrator" ? "you merge" : release === "orchestrator" ? "humans merge" : "you do not merge",
      );
    }
  }
});

test("Duty 1's green-PR branch is worded from the same grant as the standing orders", () => {
  const kept = renderOrchestratorBrief(answers());
  expect(kept).toContain("waiting on a human merge");
  expect(kept).toContain("You do not merge it.");

  // The failure this guards: a session told "merging is yours" in its standing
  // orders, and told "you do not merge it" by its own Duty 1, does whichever it
  // read last — and a delegated fleet's PRs then sit green forever.
  const delegated = renderOrchestratorBrief(answers({ authority: { merge: "orchestrator", release: "human" } }));
  expect(delegated).toContain("merging is yours");
  expect(delegated).not.toContain("You do not merge it.");
  expect(delegated).not.toContain("waiting on a human merge");
});

test("Duty 1's answered-block branch names the verb, so the never-hand-edit rule stays absolute", () => {
  const text = renderOrchestratorBrief(answers());
  const banner = text.indexOf("YOURS TO EDIT");
  const fixed = text.slice(0, banner);

  // The contradiction this pins shut: the Coordinates rule forbids hand-editing
  // a state label, and the only other exit from `agent:blocked` used to be
  // exactly that hand-edit. A brief shipping both strands the first issue an
  // orchestrator successfully answers — silently, because an ineligible issue
  // does not fail, it just stops being dispatched.
  expect(fixed).toContain("hand-edit them");
  expect(fixed).toContain("run `omp-conductor unblock <n>`");
  expect(fixed).not.toContain("remove the blocked label");
});

test("a worker's release prohibition is fixed, while the orchestrator's is policy", () => {
  const text = renderOrchestratorBrief(answers());
  const banner = text.indexOf("YOURS TO EDIT");
  const fixed = text.slice(0, banner);
  const editable = text.slice(banner);

  // A worker sees one issue, so it can never judge a release. That has to sit above
  // the banner, where an operator rewriting their own policy cannot reach it.
  expect(fixed).toContain("Workers stop at a green PR.");
  expect(fixed).toContain("delegated downward");
  // The concurrency invariant binds whoever merges, so it is fixed too — otherwise
  // a delegated release could land two PRs at once and clobber them.
  expect(fixed).toContain("PRs land one at a time");
  // The self-modification wall is fixed for the same reason: a session that may
  // edit its own dispatcher can relax every other boundary by construction.
  expect(fixed).toContain("Nobody patches the running conductor.");

  // The orchestrator's own authority is deliberately NOT a hard boundary: an
  // operator who delegates releases must be able to say so without the brief
  // contradicting itself, and the Learning loop forbids relaxing hard boundaries.
  expect(fixed).toContain("**Your own** merge and release authority is not decided here.");
  expect(editable).toContain("it is the only place your merge");
});

test("the fixed half never contradicts a delegated grant", () => {
  const text = renderOrchestratorBrief(
    answers({ authority: { merge: "orchestrator", release: "orchestrator" } }),
  );
  const fixed = text.slice(0, text.indexOf("YOURS TO EDIT"));

  // Hard boundaries and the Releases paragraph sit ~60 lines apart in one
  // standing prompt. This shipped as "unedited it is none", which a delegated
  // fleet rendered directly above "you merge, and you release" — two opposite
  // instructions in one file, which is the drift `authority` exists to end. The
  // fixed half may describe where the grant comes from; it may never assert what
  // the grant is.
  expect(fixed).not.toContain("unedited it is none");
  expect(fixed).toContain("granted at setup time");

  // Same failure, other direction: Duty 2 tells this session to groom the queue,
  // so the coordinates cannot also declare that adding the queue label is never
  // its job — a fleet that cannot promote stops dead once the queue drains.
  expect(fixed).not.toContain("You never add it");
  expect(fixed).toContain("Adding it to an issue is *promotion*");
});

test("the rendered brief ships the amendment protocol above the operator's half", () => {
  const text = renderOrchestratorBrief(answers());

  // The loop is only self-amending if the protocol is in the shipped half: an
  // operator who rewrites their own sections must not be able to delete it.
  expect(text).toContain("## Learning loop");
  expect(text.indexOf("## Learning loop")).toBeLessThan(text.indexOf("YOURS TO EDIT"));
  // Approval is the whole safety property — an unapproved self-edit is a session
  // rewriting its own boundaries.
  expect(text).toContain("single yes/no question");
  expect(text).toContain("## Amendments");
  // Hard boundaries stay hand-edited, or the loop can widen its own mandate.
  expect(text).toContain("You never propose relaxing **Hard boundaries**");
  // A human's question is answered as a question, not folded into tick narration.
  expect(text).toContain("## Human messages");
});

test("the brief names the chosen scope while still spelling both out", () => {
  const material = renderOrchestratorBrief(answers({ reportScope: "material" }));
  const escalations = renderOrchestratorBrief(answers({ reportScope: "escalations" }));

  expect(material).toContain("Your report scope is **`material`**");
  expect(escalations).toContain("Your report scope is **`escalations`**");
  // Both are described either way: the operator can switch by editing the key
  // without having to re-run setup to find out what the other one meant.
  for (const text of [material, escalations]) {
    for (const choice of REPORT_SCOPE_CHOICES) expect(text).toContain(`- **\`${choice.scope}\`**`);
  }
});

test("writing the brief creates the workspace root it lands in", () => {
  const a = answers();
  const expected = join(home, "worktrees", ORCHESTRATOR_BRIEF_NAME);
  expect(orchestratorBriefPath(a)).toBe(expected);
  expect(existsSync(expected)).toBe(false);

  const written = writeOrchestratorBrief(a);

  expect(written).toBe(expected);
  expect(readFileSync(expected, "utf8")).toBe(renderOrchestratorBrief(a));
});

test("writing the brief again replaces it — the overwrite question is the wizard's", () => {
  writeOrchestratorBrief(answers({ projectName: "outgoing-project" }));

  writeOrchestratorBrief(answers({ projectName: "incoming-project" }));

  const text = readFileSync(join(home, "worktrees", ORCHESTRATOR_BRIEF_NAME), "utf8");
  expect(text).toContain("incoming-project");
  expect(text).not.toContain("outgoing-project");
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
  expect(text).toMatch(new RegExp(`workerMaxTurns\\s+${DEFAULT_CAPS.workerMaxTurns}$`, "m"));
});

test("the plan names who merges, who releases, and who triages — before anything is written", () => {
  const scopes: ScopeCheck = { ok: true, login: "acme", scopes: ["repo", "project"], missing: [] };

  const kept = summarisePlan(answers(), scopes, labelPlan(), NO_TELEGRAM);
  expect(kept).toContain("authority      merge=human  release=human");
  expect(kept).toContain("triage         embedded");

  // The consent screen is the last place a delegation can be caught before it
  // is granted, so it has to say the word.
  const delegated = summarisePlan(
    answers({ authority: { merge: "orchestrator", release: "orchestrator" }, orchestratorMode: "external" }),
    scopes,
    labelPlan(),
    NO_TELEGRAM,
  );
  expect(delegated).toContain("authority      merge=orchestrator  release=orchestrator");
  expect(delegated).toContain("triage         external");
});

test("the plan names every graph clone it would have workers query, or none at all", () => {
  const scopes: ScopeCheck = { ok: true, login: "acme", scopes: ["repo", "project"], missing: [] };
  const root = join(home, "graph", "acme");

  const on = summarisePlan(answers({ graphRoot: root }), scopes, labelPlan(), NO_TELEGRAM);
  expect(on).toContain("code graph");
  expect(on).toContain(join(root, "api"));
  // The indexes are not created by setup, and an operator who thinks otherwise
  // arms a fleet whose workers query an empty graph on their first run.
  expect(on).toContain("omp-conductor graph-setup");

  // Declined: not a line, not a "none" row. The consent screen for a project
  // with no graph reads exactly as it did before graphs were on offer.
  const off = summarisePlan(answers(), scopes, labelPlan(), NO_TELEGRAM);
  expect(off).not.toContain("code graph");
  expect(off).not.toContain("graph-setup");
});

test("the plan names both reporting answers, so neither is applied unseen", () => {
  const scopes: ScopeCheck = { ok: true, login: "acme", scopes: ["repo", "project"], missing: [] };

  const declined = summarisePlan(answers({ reportScope: "escalations" }), scopes, labelPlan(), NO_TELEGRAM);

  expect(declined).toContain("scope          escalations");
  expect(declined).toContain("brief          not written");

  const accepted = summarisePlan(
    answers({ reportScope: "material", writeOrchestratorBrief: true }),
    scopes,
    labelPlan(),
    NO_TELEGRAM,
  );

  expect(accepted).toContain("scope          material");
  expect(accepted).toContain(`would write ${join(home, "worktrees", ORCHESTRATOR_BRIEF_NAME)}`);
});

test("the plan says OVERWRITE when a brief is already there", () => {
  const scopes: ScopeCheck = { ok: true, login: "acme", scopes: ["repo", "project"], missing: [] };
  writeOrchestratorBrief(answers());

  const text = summarisePlan(answers({ writeOrchestratorBrief: true }), scopes, labelPlan(), NO_TELEGRAM);

  // Destroying an operator's own policy file is exactly the change the consent
  // screen exists to name before it happens.
  expect(text).toContain(`would OVERWRITE ${join(home, "worktrees", ORCHESTRATOR_BRIEF_NAME)}`);

  // And declining says the existing file survives, rather than claiming there
  // is none — the operator is being told what happens to the file they wrote.
  const declined = summarisePlan(answers(), scopes, labelPlan(), NO_TELEGRAM);
  expect(declined).toContain(`${join(home, "worktrees", ORCHESTRATOR_BRIEF_NAME)} is left exactly as it is`);
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
