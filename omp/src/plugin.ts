/**
 * The omp plugin surface: one `/conductor` command with four subcommands.
 *
 * `status`, `pause` and `resume` are argument parsing plus printing over
 * ./daemon.ts, so the plugin and the `omp-conductor` CLI can never disagree
 * about what a cap means or where the state lives.
 *
 * `setup` is the exception, and only in volume: it owns the dialogs and nothing
 * else. Every decision it makes lives in ./setup.ts, which is headless and
 * tested; this file turns answers into questions and back again. The invariant
 * worth protecting is on `setup()` below — nothing is written before the confirm.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
  checkBrief,
  formatBriefStatus,
  formatMigrateResult,
  inspectBriefLayout,
  migrateToPolicy,
  repairPolicyBannerCrumbs,
  writeMergedBrief,
} from "./brief-upgrade.ts";
import { configPath, expandHome, findProject, loadConfig, resolveCaps, saveConfig } from "./config.ts";
import { hostRamBytes, recommendedMaxWorkers } from "./host.ts";
import {
  isPaused,
  prepareConductor,
  previewProject,
  setPaused,
  type QueuePreview,
} from "./daemon.ts";
import {
  armTicks,
  armedMarkerPath,
  clearPaneHalt,
  disarmTicks,
  halt,
  haltWithPane,
  hold,
  releaseHold,
  renderStatus,
} from "./fleet.ts";
import { restartDaemon } from "./lifecycle.ts";

import { defaultGraphRoot } from "./graph.ts";
import {
  formatHostRuntimePlan,
  planHostRuntime,
  runSetupSmoke,
  writeHostRuntime,
} from "./setup-host.ts";
import {
  AMEND_AREAS,
  ORCHESTRATOR_BRIEF_NAME,
  POLICY_BRIEF_NAME,
  REPORT_SCOPE_CHOICES,
  SETUP_DEFAULTS,
  amendChoices,
  answersFromProject,
  briefPathForProject,
  policyPathForProject,
  renderFloorForProject,
  buildConfig,
  checkTokenScopes,
  createMissingLabels,
  defaultAnswers,
  detectTelegram,
  formatGates,
  orchestratorBriefPath,
  planLabels,
  renderBriefForProject,
  summariseAmend,
  summarisePlan,
  writeOrchestratorBrief,
  type AmendAreaId,
  type SetupAnswers,
} from "./setup.ts";
import {
  DEFAULT_CAPS,
  type Caps,
  type ConductorConfig,
  type OrchestratorMode,
  type ProjectConfig,
  type ReleasePolicy,
  type ReportScope,
} from "./types.ts";

/**
 * The slice of the omp extension API this plugin actually touches, mirroring
 * `RegisteredCommand` / `ExtensionUIContext` from `@oh-my-pi/pi-coding-agent`.
 *
 * Declared here rather than imported because the harness is a peer dependency:
 * the package has to type-check without it installed. Structural typing means
 * the real API object satisfies this on the way in, and narrowing the surface
 * to the five members the wizard uses keeps the coupling visible.
 */
interface Completion {
  value: string;
  label: string;
  description?: string;
}

interface CommandContext {
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    confirm(title: string, message: string): Promise<boolean>;
    /**
     * Single-line text prompt. Resolves `undefined` when the operator dismisses
     * the dialog, which the wizard treats as "abandon, change nothing".
     *
     * The harness has no pre-filled variant, so `placeholder` carries the
     * default and submitting an empty line accepts it.
     */
    input(title: string, placeholder?: string): Promise<string | undefined>;
    /**
     * Single-choice list. Resolves the chosen option's **label**, or
     * `undefined` when the operator dismisses it — so callers map labels back to
     * their own values rather than trusting the index.
     */
    select(
      title: string,
      options: { label: string; description?: string }[],
      dialogOptions?: { initialIndex?: number },
    ): Promise<string | undefined>;
  };
}

interface PluginApi {
  registerCommand(
    name: string,
    options: {
      description?: string;
      getArgumentCompletions?: (argumentPrefix: string) => Completion[] | null;
      handler: (args: string, ctx: CommandContext) => Promise<void>;
    },
  ): void;
}

const SUBCOMMANDS: Completion[] = [
  {
    value: "setup",
    label: "setup",
    description: "wizard: config, labels, dry run, then arm — or amend one area of a configured project",
  },
  { value: "status", label: "status", description: "layered fleet report: dispatch, ticks, pane, herdr, daemon" },
  { value: "hold", label: "hold", description: "soft stop: pause claiming AND disarm ticks" },
  { value: "halt", label: "halt", description: "hold + stop dispatch daemon; pass --pane to pin recovery off" },
  { value: "arm", label: "arm", description: "proof-gated: inbound Telegram round-trip, then write arm marker" },
  { value: "disarm", label: "disarm", description: "remove arm marker so ticks skip" },
  { value: "release-pane", label: "release-pane", description: "clear halt --pane recovery pin" },
  { value: "pause", label: "pause", description: "stop claiming only (ticks keep firing if armed); prefer hold" },
  { value: "resume", label: "resume", description: "clear pause only — does not re-arm" },
  {
    value: "brief-upgrade",
    label: "brief-upgrade",
    description: "check ORCHESTRATOR.md against the brief this version ships",
  },
];

const USAGE = [
  "/conductor setup [project]         create a project, or amend one area of one you already have",
  "/conductor status [project]        layered fleet report (dispatch, ticks, pane, herdr, daemon)",
  "/conductor hold [project]          soft stop: pause claiming AND disarm ticks",
  "/conductor halt [--pane] [project] hold + stop daemon; --pane pins conductor recovery off only",
  "/conductor arm [project]           proof-gated inbound Telegram round-trip, then arm ticks",
  "/conductor disarm [project]        remove arm marker (ticks skip)",
  "/conductor release-pane [project]  clear halt --pane recovery pin",
  "/conductor pause                   stop claiming only (prefer hold)",
  "/conductor resume                  clear pause only — does not re-arm",
  "/conductor brief-upgrade [project] check ORCHESTRATOR.md against the shipped brief",
].join("\n");

/**
 * Dismissing any dialog abandons the whole wizard.
 *
 * Thrown rather than returned as a sentinel: the prompt sequence runs to a
 * dozen questions, and a cancellation check after each one would bury the
 * shape of the conversation under branching.
 */
class Cancelled extends Error {
  constructor() {
    super("setup cancelled");
    this.name = "Cancelled";
  }
}

/** The spelling `config.ts` validates tracker repos against. Checked here too
 *  so a typo is fixed in the dialog instead of in an error an hour later. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * One text answer. The placeholder shows the default and an empty submission
 * takes it, because the harness has no pre-filled input dialog — so "Enter
 * accepts what you see" is the contract the whole wizard is built on.
 */
async function ask(ctx: CommandContext, title: string, fallback: string): Promise<string> {
  const raw = await ctx.ui.input(title, fallback.length > 0 ? fallback : undefined);
  if (raw === undefined) throw new Cancelled();
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Re-asks until the answer passes `check`, which returns the complaint or
 * `undefined`. Bounded at three tries: a dialog that cannot be escaped is worse
 * than one that gives up and leaves the config alone.
 */
async function askValid(
  ctx: CommandContext,
  title: string,
  fallback: string,
  check: (value: string) => string | undefined,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = await ask(ctx, title, fallback);
    const problem = check(value);
    if (problem === undefined) return value;
    ctx.ui.notify(problem, "warning");
  }
  throw new Cancelled();
}

/** A cap. Unparseable input keeps the current value rather than writing a NaN
 *  the validator would later reject — the operator sees why, immediately. */
async function askNumber(ctx: CommandContext, title: string, fallback: number): Promise<number> {
  const raw = await ask(ctx, title, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    ctx.ui.notify(`"${raw}" is not a non-negative number — keeping ${fallback}.`, "warning");
    return fallback;
  }
  return value;
}

/**
 * Daily spend ceiling. Blank / "none" / "off" → null (no gate). Unparseable
 * non-empty input keeps the current value. Distinct from askNumber so operators
 * can turn the money brake off without writing a magic 0 (which is a hard stop).
 */
async function askSpendCap(
  ctx: CommandContext,
  title: string,
  fallback: number | null,
): Promise<number | null> {
  const seed = fallback === null ? "" : String(fallback);
  const raw = (await ask(ctx, title, seed)).trim().toLowerCase();
  if (raw === "" || raw === "none" || raw === "off" || raw === "null") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    ctx.ui.notify(
      `"${raw}" is not a non-negative number or blank — keeping ${fallback === null ? "no cap" : fallback}.`,
      "warning",
    );
    return fallback;
  }
  return value;
}

/**
 * Pre-push gates as one comma-separated line, `cmd @ cwd` for a subdirectory:
 * `bun run check, bun test @ server`. Shown through `formatGates`, the same
 * spelling the amend menu reads a repo's current gates back with.
 *
 * ponytail: the ceiling is a command containing a comma or a literal " @ ",
 * which this would split wrongly. Rare in a lint or test invocation, and the
 * config file is hand-editable. Upgrade path is `ctx.ui.editor()`, a real
 * multi-line buffer, once someone hits it.
 */
async function askGates(
  ctx: CommandContext,
  repoName: string,
  seed: { cmd: string; cwd: string }[],
): Promise<{ cmd: string; cwd: string }[]> {
  const raw = await ask(
    ctx,
    `Pre-push gates for ${repoName} — exactly what CI runs, comma separated`,
    formatGates(seed),
  );

  const gates: { cmd: string; cwd: string }[] = [];
  for (const chunk of raw.split(",")) {
    const entry = chunk.trim();
    if (entry.length === 0) continue;
    const at = entry.lastIndexOf(" @ ");
    if (at === -1) gates.push({ cmd: entry, cwd: "." });
    else gates.push({ cmd: entry.slice(0, at).trim(), cwd: entry.slice(at + 3).trim() });
  }

  if (gates.length === 0) {
    // Loud, because an unattended push with no gate is how a lint failure
    // reaches the runners at 03:00 with nobody watching.
    ctx.ui.notify(`No gates for ${repoName} — nothing will be verified before a push.`, "warning");
  }
  return gates;
}

/**
 * How loud the orchestrator should be. A list rather than a confirm: "report
 * scope" has no natural yes, and phrasing it as one would bury which answer
 * means silence. The cursor starts on the current setting so Enter re-affirms
 * it, the same contract every other prompt here has.
 */
async function askReportScope(ctx: CommandContext, current: ReportScope): Promise<ReportScope> {
  const options = REPORT_SCOPE_CHOICES.map((c) => ({ label: c.label, description: c.description }));
  const at = REPORT_SCOPE_CHOICES.findIndex((c) => c.scope === current);
  const picked = await ctx.ui.select("What should the orchestrator report unprompted?", options, {
    initialIndex: at === -1 ? 0 : at,
  });
  if (picked === undefined) throw new Cancelled();

  const choice = REPORT_SCOPE_CHOICES.find((c) => c.label === picked);
  if (choice === undefined) {
    // The harness answers with a label we did not offer only if the dialog
    // contract changed under us; keeping the current scope is the answer that
    // changes nothing, and it is said out loud rather than assumed.
    ctx.ui.notify(`Unrecognised choice "${picked}" — keeping "${current}".`, "warning");
    return current;
  }
  return choice.scope;
}

/**
 * Who merges and who releases. Two confirms rather than one four-way list:
 * these are independent grants — delegating merges is routine, delegating
 * releases is not — and a menu of four combinations frames them as equally
 * ordinary choices, which is exactly the framing a release grant must not get.
 *
 * Neither confirm can start on "yes", so a re-run that Enters through the
 * wizard revokes rather than renews. That is the safe direction, and the
 * current grant is named in the question so the revoke is never a surprise.
 */
async function askAuthority(
  ctx: CommandContext,
  prior: ProjectConfig["authority"],
): Promise<ProjectConfig["authority"]> {
  const merge = await ctx.ui.confirm(
    "Merge authority",
    "Delegate PR merging to the orchestrator session? It would land green PRs one at a time, each " +
      "re-checked against the base branch first. Default: humans merge" +
      `${prior.merge === "orchestrator" ? " — currently delegated, answer no to take it back" : ""}.`,
  );
  const release = await ctx.ui.confirm(
    "Release authority",
    "Delegate release cutting to the orchestrator session? It would tag, pin and publish by the " +
      "procedure you write into its brief — and its brief forbids cutting one before you have. " +
      "Default: humans release" +
      `${prior.release === "orchestrator" ? " — currently delegated, answer no to take it back" : ""}.`,
  );
  return { merge: merge ? "orchestrator" : "human", release: release ? "orchestrator" : "human" };
}

async function askReleasePolicy(
  ctx: CommandContext,
  prior: ReleasePolicy,
): Promise<ReleasePolicy> {
  const open = await ctx.ui.confirm(
    "Release tool gate",
    "Allow worker and orchestrator sessions to invoke release/deploy-shaped tools? Only enable this " +
      "when the operator brief contains the release procedure they must follow. Default: no, block " +
      "git tags, tag pushes, package publishing, GitHub release creation and deploy commands" +
      `${prior === "operator-brief" ? " — currently enabled, answer no to close it" : ""}.`,
  );
  return open ? "operator-brief" : "none";
}

/**
 * Where the session that triages escalations lives. Phrased as a fact about the
 * host rather than a preference, because that is what it is: answering yes when
 * no such session exists leaves tier-1 escalations sitting in issue comments
 * that nobody drains.
 */
async function askOrchestratorMode(ctx: CommandContext, prior: OrchestratorMode): Promise<OrchestratorMode> {
  const external = await ctx.ui.confirm(
    "Orchestrator session",
    "Do you already run your own orchestrator session for this project — a visible TUI session, say? " +
      "Then the daemon starts none of its own, and posts tier-1 escalations as issue comments for yours " +
      "to drain. Default: no, the daemon runs one" +
      `${prior === "external" ? " — currently external" : ""}.`,
  );
  return external ? "external" : "embedded";
}

/**
 * Whether workers get a code graph, and where its clones live.
 *
 * One confirm and at most one prompt, asked after the repos are known because
 * the answer is derived per repo. A declined answer leaves the field off every
 * repo, which is what keeps an existing fleet's briefs byte-identical.
 *
 * The root is validated as absolute here rather than at load time so the
 * operator learns immediately: a relative path would be resolved against
 * whichever cwd happened to read the config, and never against the directory
 * that was indexed.
 */
async function askGraphRoot(
  ctx: CommandContext,
  trackerRepo: string,
  repoNames: string[],
  prior: string | undefined,
): Promise<string | undefined> {
  const wanted = await ctx.ui.confirm(
    "Code-graph discovery",
    "Set up code-graph discovery for workers? Workers spend most of their turn budget finding code; " +
      'a graph answers "who calls this" in one call. Conductor keeps one disposable clone per repo, ' +
      "pinned to the default branch purely for indexing — never your own checkout" +
      `${prior === undefined ? "" : `. Currently on, under ${prior}`}.`,
  );
  if (!wanted) return undefined;

  return await askValid(
    ctx,
    `Root for those clones — one per repo (${repoNames.join(", ")}) is created under it`,
    prior ?? defaultGraphRoot(trackerRepo),
    (v) =>
      isAbsolute(expandHome(v))
        ? undefined
        : `"${v}" is not an absolute path — a worker reads this from its own worktree, so a relative one names the wrong directory.`,
  );
}

/**
 * Whether to render the operator's own brief, and — separately — whether an
 * existing one may be replaced. Two questions on purpose: that file is where a
 * fleet's release and reporting policy ends up, so it is never overwritten by
 * an operator who only meant to re-run setup.
 */
async function askOrchestratorBrief(ctx: CommandContext, a: SetupAnswers): Promise<boolean> {
  const path = orchestratorBriefPath(a);
  const wanted = await ctx.ui.confirm(
    `Write ${ORCHESTRATOR_BRIEF_NAME} + ${POLICY_BRIEF_NAME} under ${dirname(path)}?`,
    `Writes composed ${ORCHESTRATOR_BRIEF_NAME} (package floor, refreshed each tick) and ${POLICY_BRIEF_NAME} ` +
      `(Releases, Project context, Reporting, Amendments — yours to edit via the Learning loop). ` +
      `The conductor stops at green PRs either way.`,
  );
  if (!wanted) return false;
  if (!existsSync(path)) return true;

  return await ctx.ui.confirm(
    `Overwrite existing ${ORCHESTRATOR_BRIEF_NAME} / ${POLICY_BRIEF_NAME}?`,
    `${path} already exists. Overwriting replaces the composed brief and POLICY.md scaffold — any policy you wrote is lost.`,
  );
}

/** The project these answers would replace, so a re-run pre-fills with what is
 *  already there instead of making the operator retype it. */
function priorProject(existing: ConductorConfig | undefined, name: string | undefined): ProjectConfig | undefined {
  if (existing === undefined) return undefined;
  if (name !== undefined) return existing.projects.find((p) => p.name === name);
  return existing.projects.length === 1 ? existing.projects[0] : undefined;
}

/**
 * One area's questions, over the answers everything else is carried through in.
 *
 * Every asker takes the whole answer set and returns the whole answer set with
 * only its own fields replaced. That is what lets the full interview fold them in
 * order while an amend applies exactly one, with no second spelling of either the
 * prompts or the defaults they pre-fill from: the value shown is always the value
 * that would otherwise be carried through.
 */
type AreaAsker = (ctx: CommandContext, a: SetupAnswers) => Promise<SetupAnswers>;

/**
 * Where work comes from and where it lands: tracker, labels, routing prefix, and
 * every repo an issue can be routed to, each with its gates. One area because it
 * is one fact — the identity of the queue — and changing any part of it without
 * seeing the rest is how a routing prefix stops matching its labels.
 */
const askTrackerAndRepos: AreaAsker = async (ctx, a) => {
  const trackerRepo = await askValid(
    ctx,
    "Tracker repo (owner/repo) — where ready issues live",
    a.trackerRepo,
    (v) => (REPO_RE.test(v) ? undefined : `"${v}" is not owner/repo — e.g. acme/planning.`),
  );

  const queueLabel = await ask(
    ctx,
    "Queue label — the human sign-off that makes an issue claimable",
    a.queueLabel,
  );

  // One confirm instead of three prompts: the namespaced defaults are right for
  // almost everyone, and three dialogs of Enter-to-accept is how a wizard earns
  // its reputation.
  const stateLabels: SetupAnswers["stateLabels"] = { ...a.stateLabels };
  const customiseStates = await ctx.ui.confirm(
    "State labels",
    `The conductor writes back "${stateLabels.inProgress}", "${stateLabels.blocked}" and ` +
      `"${stateLabels.failed}" so the tracker alone shows live state. Rename them?`,
  );
  if (customiseStates) {
    stateLabels.inProgress = await ask(ctx, "Label for a run in progress", stateLabels.inProgress);
    stateLabels.blocked = await ask(ctx, "Label for a run parked on a human", stateLabels.blocked);
    stateLabels.failed = await ask(ctx, "Label for a run that gave up", stateLabels.failed);
  }

  const routingLabelPrefix = await ask(
    ctx,
    "Routing label prefix — an issue picks its checkout with <prefix><repo>",
    a.routingLabelPrefix,
  );

  const targetRepos: SetupAnswers["targetRepos"] = [];
  for (let i = 0; ; i++) {
    const seed = a.targetRepos[i];
    const name = await askValid(
      ctx,
      `Routing key for repo ${i + 1} — the "${routingLabelPrefix}<key>" label an issue carries`,
      seed?.name ?? "",
      (v) => (v.length > 0 ? undefined : "A routing key is required, or no issue can reach this repo."),
    );
    const cloneUrl = await askValid(
      ctx,
      `Clone URL for ${routingLabelPrefix}${name}`,
      seed?.cloneUrl ?? "",
      (v) => (v.length > 0 ? undefined : "A clone URL is required — the daemon mirrors it before every run."),
    );
    const defaultBranch = await ask(
      ctx,
      `Default branch for ${name} — worktrees are cut from it and PRs target it`,
      seed?.defaultBranch ?? SETUP_DEFAULTS.defaultBranch,
    );
    targetRepos.push({ name, cloneUrl, defaultBranch, gates: await askGates(ctx, name, seed?.gates ?? []) });

    const more = await ctx.ui.confirm(
      "Another repo?",
      `${targetRepos.map((r) => r.name).join(", ")} configured. Add another checkout this project routes to?`,
    );
    if (!more) break;
  }

  return { ...a, trackerRepo, queueLabel, stateLabels, routingLabelPrefix, targetRepos };
};

/**
 * The gates alone, repo by repo, with nothing else asked.
 *
 * The area that earns amend mode: a CI command changes far more often than a
 * clone URL does, and re-typing four repos to correct one lint invocation is the
 * reason an operator edits config.json by hand instead.
 */
const askGatesOnly: AreaAsker = async (ctx, a) => {
  if (a.targetRepos.length === 0) {
    ctx.ui.notify("No repos are configured yet — amend \"tracker & repos\" first.", "warning");
    return a;
  }

  const targetRepos: SetupAnswers["targetRepos"] = [];
  for (const r of a.targetRepos) {
    targetRepos.push({ ...r, gates: await askGates(ctx, r.name, r.gates) });
  }
  return { ...a, targetRepos };
};

/**
 * Whether workers get a code graph, and where its clones live. Asked after the
 * repos in the full interview because the answer is derived per repo.
 */
const askGraph: AreaAsker = async (ctx, a) => {
  const graphRoot = await askGraphRoot(
    ctx,
    a.trackerRepo,
    a.targetRepos.map((r) => r.name),
    a.graphRoot,
  );

  const next: SetupAnswers = { ...a };
  // Deleted rather than set to `undefined`: the absence of the key is what keeps
  // a project that declines graphs identical to one written before they existed.
  if (graphRoot === undefined) delete next.graphRoot;
  else next.graphRoot = graphRoot;
  return next;
};

/** The hard ceilings. One confirm first, because the shipped defaults are the
 *  answer for anyone who has not measured their own runners. */
const askCaps: AreaAsker = async (ctx, a) => {
  const caps: Partial<Caps> = { ...a.caps };
  const spendLabel =
    DEFAULT_CAPS.dailySpendUsd === null ? "no spend cap" : `$${DEFAULT_CAPS.dailySpendUsd}/day`;
  // Workers are in-process omp sessions inside the daemon PID. On a host under
  // 16 GiB the measured shape (2 workers + orchestrator) peaks at 3–4 GB and
  // swaps on a 7.6 GB shared VPS (#51) — setup therefore defaults to 1 there.
  const workersDefault =
    caps.maxConcurrentWorkers ?? recommendedMaxWorkers(hostRamBytes());
  const smallHostNote =
    workersDefault < DEFAULT_CAPS.maxConcurrentWorkers
      ? ` This host looks under 16 GiB RAM, so the worker default is ${workersDefault} instead of ${DEFAULT_CAPS.maxConcurrentWorkers}.`
      : "";
  const tuneCaps = await ctx.ui.confirm(
    "Caps",
    `Defaults: ${workersDefault} workers, ` +
      `${spendLabel}, ${DEFAULT_CAPS.workerMaxTurns} turns and ` +
      `${Math.round(DEFAULT_CAPS.workerWallClockMs / 60000)} min per worker, ` +
      `${DEFAULT_CAPS.maxAttemptsPerIssue} failed attempts and ` +
      `${DEFAULT_CAPS.maxContinuationsPerIssue} operational continuations per issue.${smallHostNote} Change them?`,
  );
  if (!tuneCaps) {
    if (
      caps.maxConcurrentWorkers === undefined &&
      workersDefault !== DEFAULT_CAPS.maxConcurrentWorkers
    ) {
      caps.maxConcurrentWorkers = workersDefault;
    }
    return { ...a, caps };
  }

  // Spelled out rather than looped: adding a cap should fail to compile here,
  // not silently go unasked.
  caps.maxConcurrentWorkers = await askNumber(
    ctx,
    "Max concurrent workers",
    workersDefault,
  );
  caps.dailySpendUsd = await askSpendCap(
    ctx,
    "Spend ceiling per rolling day (USD) — blank = no spend cap",
    caps.dailySpendUsd !== undefined ? caps.dailySpendUsd : DEFAULT_CAPS.dailySpendUsd,
  );
  caps.workerMaxTurns = await askNumber(ctx, "Turn ceiling per worker", caps.workerMaxTurns ?? DEFAULT_CAPS.workerMaxTurns);
  caps.workerWallClockMs = await askNumber(
    ctx,
    "Wall-clock ceiling per worker (ms)",
    caps.workerWallClockMs ?? DEFAULT_CAPS.workerWallClockMs,
  );
  caps.maxAttemptsPerIssue = await askNumber(
    ctx,
    "Failed implementation attempts per issue before escalation",
    caps.maxAttemptsPerIssue ?? DEFAULT_CAPS.maxAttemptsPerIssue,
  );
  caps.maxContinuationsPerIssue = await askNumber(
    ctx,
    "Operational continuations per issue before escalation",
    caps.maxContinuationsPerIssue ?? DEFAULT_CAPS.maxContinuationsPerIssue,
  );
  return { ...a, caps };
};

/** Outside the caps block: a model is not a ceiling, and an operator who left
 *  the caps alone may still want workers on a cheaper model. */
const askWorkerModel: AreaAsker = async (ctx, a) => {
  const answered = await ask(ctx, "Worker model pattern (blank = harness default)", a.workerModel ?? "");
  const next: SetupAnswers = { ...a };
  if (answered.trim().length === 0) delete next.workerModel;
  else next.workerModel = answered.trim();
  return next;
};

/** Both grants, asked together because they are the two questions that decide
 *  what an unattended fleet may do without asking anybody. */
const askAuthorityArea: AreaAsker = async (ctx, a) => ({
  ...a,
  authority: await askAuthority(ctx, a.authority),
  releasePolicy: await askReleasePolicy(ctx, a.releasePolicy),
});

/** How a stuck run reaches a human, and who triages it when it does. */
const askEscalation: AreaAsker = async (ctx, a) => {
  const telegram = detectTelegram();
  let telegramChatId = a.telegramChatId;
  if (telegram.available && telegram.hasToken) {
    if (telegramChatId === undefined && telegram.pairedOwnerId !== undefined) {
      const usePaired = await ctx.ui.confirm(
        "Tier-2 escalations",
        `omp-telegram is paired with chat ${telegram.pairedOwnerId}. Page it when a run is stuck?`,
      );
      if (usePaired) telegramChatId = telegram.pairedOwnerId;
    } else {
      const answered = await ask(ctx, "Telegram chat id for tier-2 escalations (blank for none)", telegramChatId ?? "");
      telegramChatId = answered.length > 0 ? answered : undefined;
    }
  } else {
    // Not an error: tier 2 degrades to a comment, which is the documented fallback.
    ctx.ui.notify(
      `No usable omp-telegram install at ${telegram.stateDir} — tier-2 escalations will comment on the issue.`,
      "info",
    );
  }

  const fallbackToIssueComment = await ctx.ui.confirm(
    "Escalation fallback",
    "Also comment on the issue when a run escalates? Recommended: a chat message you miss is a run nobody sees.",
  );

  const orchestratorMode = await askOrchestratorMode(ctx, a.orchestratorMode);

  const next: SetupAnswers = { ...a, fallbackToIssueComment, orchestratorMode };
  if (telegramChatId === undefined) delete next.telegramChatId;
  else next.telegramChatId = telegramChatId;
  return next;
};

/** How loud the orchestrator is when nobody asked it anything. */
const askReporting: AreaAsker = async (ctx, a) => ({ ...a, reportScope: await askReportScope(ctx, a.reportScope) });

/** The operator's own brief. Asked last in the full interview, because the
 *  question quotes the path the rest of the answers derive. */
const askBrief: AreaAsker = async (ctx, a) => ({ ...a, writeOrchestratorBrief: await askOrchestratorBrief(ctx, a) });

/**
 * One dialog sequence per amend area, keyed so a new area cannot be added to
 * {@link AMEND_AREA_IDS} without one.
 */
const AREA_ASKERS: { readonly [K in AmendAreaId]: AreaAsker } = {
  tracker: askTrackerAndRepos,
  gates: askGatesOnly,
  // The two per-worker knobs the full interview separates with the authority
  // grants; an amend has no reason to put anything between them.
  caps: async (ctx, a) => await askWorkerModel(ctx, await askCaps(ctx, a)),
  graph: askGraph,
  authority: askAuthorityArea,
  escalation: askEscalation,
  reporting: askReporting,
  brief: askBrief,
};

/** The two ways to answer the first question a configured project gets. Labels,
 *  because the harness's select resolves to the label it displayed. */
const AMEND_ONE = "Change one area";
const REINTERVIEW = "Walk every question again";

/**
 * The first question a re-run asks, and the reason amend mode exists: adding one
 * key should not cost twenty prompts.
 *
 * Returns the area to amend, or `undefined` for the full interview. Only asked
 * when the named project is already configured — a first run, or a new project
 * beside an old one, has nothing to amend and is never shown this.
 */
async function chooseAmendArea(ctx: CommandContext, prior: ProjectConfig): Promise<AmendAreaId | undefined> {
  const mode = await ctx.ui.select(
    `"${prior.name}" is already configured — what would you like to do?`,
    [
      {
        label: AMEND_ONE,
        description: "asks one area's questions; every other answer is carried through from the saved config",
      },
      {
        label: REINTERVIEW,
        description: "the full interview, every prompt pre-filled with what is configured now",
      },
    ],
    { initialIndex: 0 },
  );
  if (mode === undefined) throw new Cancelled();
  if (mode !== AMEND_ONE) {
    // Either the operator chose the full interview, or the dialog answered with
    // a label we never offered. Both land on today's behaviour, which is the one
    // that cannot silently skip a question.
    if (mode !== REINTERVIEW) ctx.ui.notify(`Unrecognised choice "${mode}" — asking everything.`, "warning");
    return undefined;
  }

  const choices = amendChoices(prior);
  const picked = await ctx.ui.select(
    "Which area? Each row shows what it says now",
    choices.map((c) => ({ label: c.label, description: c.description })),
    { initialIndex: 0 },
  );
  if (picked === undefined) throw new Cancelled();

  const chosen = choices.find((c) => c.label === picked);
  if (chosen === undefined) {
    // Guessing an area here would ask the wrong questions and carry the rest
    // through as if they had been reviewed. Abandoning changes nothing.
    ctx.ui.notify(`Unrecognised choice "${picked}" — nothing was changed.`, "warning");
    throw new Cancelled();
  }
  return chosen.id;
}

/**
 * The conversation. Reads only — every answer is collected before anything is
 * checked against GitHub, and long before anything is written.
 *
 * Seeded from one answers object rather than pre-filling each prompt from
 * `prior?.field ?? default`: that is the same carry-through an amend relies on,
 * so the two flows cannot disagree about what an unanswered field is.
 */
async function collectAnswers(
  ctx: CommandContext,
  prior: ProjectConfig | undefined,
  projectArg: string | undefined,
): Promise<SetupAnswers> {
  const seed = prior === undefined ? defaultAnswers(projectArg ?? "") : answersFromProject(prior);

  const projectName = await askValid(
    ctx,
    "Project name",
    projectArg ?? seed.projectName,
    (v) => (v.length > 0 ? undefined : "A name is required — it is how `/conductor status <name>` finds this project."),
  );

  let a: SetupAnswers = { ...seed, projectName };
  a = await askTrackerAndRepos(ctx, a);
  // Straight after the repos, because it is a fact about them: one clone per
  // routed repo, under one root.
  a = await askGraph(ctx, a);
  a = await askCaps(ctx, a);
  a = await askAuthorityArea(ctx, a);
  a = await askWorkerModel(ctx, a);
  a = await askEscalation(ctx, a);
  a = await askReporting(ctx, a);
  // Asked last, and asked with the real path in the question — which needs the
  // rest of the answers to derive.
  return await askBrief(ctx, a);
}

/** The dry run, rendered. Same routing code the loop uses, so this is what the
 *  next tick would actually do — not a description of it. */
function formatPreview(p: QueuePreview): string[] {
  const lines = [
    `state        ${p.paused ? "paused" : "armed"}`,
    p.ready.length === 0
      ? "Would pick up: nothing — the queue is empty."
      : `Would pick up ${p.ready.length} issue(s), caps permitting:`,
  ];
  for (const r of p.ready) lines.push(`  #${r.number}  → ${r.repo}  ${r.branch}  ${r.title}`);

  if (p.unroutable.length > 0) {
    lines.push("", `Cannot route ${p.unroutable.length} issue(s) — these escalate instead of running:`);
    for (const u of p.unroutable) {
      lines.push(`  #${u.number}  ${u.reason}  [${u.labels.join(", ") || "no labels"}]  ${u.title}`);
    }
  }
  return lines;
}


/** What the whole conversation produced: the answers, and which area an amend
 *  narrowed it to. `amend` absent means every question was asked. */
export interface CollectedSetup {
  answers: SetupAnswers;
  amend?: { area: AmendAreaId; before: ProjectConfig };
}

/**
 * The whole conversation, from the amend question to the last prompt, and not one
 * byte further: no `gh`, no dry run, nothing written.
 *
 * Exported at exactly that seam so a test can script the dialogs and pin what a
 * first run asks and what an amend refuses to ask — the two properties amend mode
 * is judged on — on a host with no `gh` and no config.
 */
export async function collectSetup(
  ctx: CommandContext,
  existing: ConductorConfig | undefined,
  projectArg: string | undefined,
): Promise<CollectedSetup> {
  // Only a project that is already configured can be amended. A first run, or a
  // name this config has never seen, goes straight into the full interview with
  // no extra question — which is what it was before amend mode existed.
  const prior = priorProject(existing, projectArg);
  if (prior === undefined) return { answers: await collectAnswers(ctx, undefined, projectArg) };

  const area = await chooseAmendArea(ctx, prior);
  if (area === undefined) return { answers: await collectAnswers(ctx, prior, projectArg) };

  return { answers: await AREA_ASKERS[area](ctx, answersFromProject(prior)), amend: { area, before: prior } };
}

/**
 * The onboarding wizard, and — for a project it already knows — the amend.
 *
 * The invariant that makes this safe against a live tracker: no mutation occurs
 * before the consent below. Config, tracker, and host-runtime planning are
 * read-only. The paused state, labels, config, brief, runtime files, smoke, and
 * arm proof all follow the same consent gate.
 *
 * An amend changes which questions are asked and what the summary leads with,
 * and nothing else: the same answers, the same `buildConfig`, the same single
 * confirm, the same dry run. One writer, one consent gate.
 */
async function setup(ctx: CommandContext, projectArg: string | undefined): Promise<void> {
  const path = configPath();
  // A config that exists but does not parse is a fault to report, never
  // something to quietly replace: overwriting it would delete every project it
  // describes. Absence, by contrast, is just the first run.
  const existing = existsSync(path) ? loadConfig() : undefined;
  if (existing === undefined) {
    ctx.ui.notify(`No config at ${path} yet — let's make one. Nothing is written until you confirm.`, "info");
  }

  let collected: CollectedSetup;
  try {
    collected = await collectSetup(ctx, existing, projectArg);
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err;
    ctx.ui.notify("Setup cancelled — nothing was changed.", "info");
    return;
  }
  const { answers, amend } = collected;

  const scopes = await checkTokenScopes();
  if (!scopes.ok) {
    ctx.ui.notify(
      `Setup stopped before writing anything. The gh token needs repo and project scopes. ` +
        `Run \`gh auth refresh -s repo,project\`, then run setup again.`,
      "error",
    );
    return;
  }
  const labels = await planLabels(answers.trackerRepo, answers);
  const telegram = detectTelegram();
  const nextConfig = buildConfig(answers, existing);
  const project = findProject(nextConfig, answers.projectName);
  if (
    project.escalation.orchestrator === "external" &&
    !answers.writeOrchestratorBrief &&
    (!existsSync(briefPathForProject(project)) || !existsSync(policyPathForProject(project)))
  ) {
    ctx.ui.notify(
      `Setup stopped before writing anything. External orchestration needs ${ORCHESTRATOR_BRIEF_NAME} and ${POLICY_BRIEF_NAME}. ` +
        `Run setup again and approve the brief write.`,
      "error",
    );
    return;
  }
  const runtime = planHostRuntime(
    project,
    resolveCaps(project, nextConfig.defaults),
    telegram.stateDir,
  );
  let queuePreview: string[];
  try {
    queuePreview = formatPreview(await previewProject(project));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(
      `Setup stopped before writing anything because the proposed queue could not be read: ${message}`,
      "error",
    );
    return;
  }

  ctx.ui.notify(
    [
      // The delta first when there is one, then the whole plan: the confirm has
      // to name every mutation it authorises, and a delta names none of them.
      ...(amend === undefined ? [] : [summariseAmend(amend.area, amend.before, answers)]),
      summarisePlan(answers, scopes, labels, telegram),
      "",
      formatHostRuntimePlan(runtime),
      "",
      "Dry run against the PROPOSED config:",
      ...queuePreview,
      "",
      "Nothing has been changed yet.",
    ].join("\n"),
    "info",
  );

  const toCreate = labels.filter((l) => !l.exists).map((l) => l.name);
  const go = await ctx.ui.confirm(
    amend === undefined ? "Apply this setup?" : `Apply this change to ${AMEND_AREAS[amend.area].name}?`,
    [
      toCreate.length > 0
        ? `Creates ${toCreate.length} label(s) in ${answers.trackerRepo}: ${toCreate.join(", ")}.`
        : "Creates no labels.",
      `Writes ${path}, prepares a paused state database, then runs a paused daemon smoke.`,
      runtime.service.action === "keep"
        ? `Keeps the staged systemd unit at ${runtime.service.path}.`
        : `${runtime.service.action === "create" ? "Creates" : "Updates"} the staged systemd unit at ${runtime.service.path}.`,
      runtime.tick === undefined
        ? ""
        : runtime.tick.action === "keep"
          ? `Keeps the external heartbeat config at ${runtime.tick.path}.`
          : `${runtime.tick.action === "create" ? "Creates" : "Updates"} the external heartbeat config at ${runtime.tick.path}.`,
      answers.writeOrchestratorBrief
        ? `Writes ${orchestratorBriefPath(answers)}, which is then yours to edit.`
        : "",
      project.escalation.orchestrator === "external"
        ? "Dispatch stays paused until the existing arm marker or a new inbound Telegram proof makes the heartbeat live."
        : "Dispatch resumes after the smoke succeeds.",
      "Issues are only claimed after every setup gate succeeds.",
    ]
      .filter((s) => s.length > 0)
      .join(" "),
  );
  if (!go) {
    ctx.ui.notify("Left untouched — no labels created, no config written, nothing armed.", "info");
    return;
  }

  // Hold first. Any later filesystem, tracker, smoke, or channel error leaves a
  // partially applied setup unable to claim work.
  prepareConductor();
  const created = await createMissingLabels(answers.trackerRepo, labels);
  saveConfig(nextConfig);
  const briefPath = answers.writeOrchestratorBrief ? writeOrchestratorBrief(answers) : undefined;
  const runtimeFiles = writeHostRuntime(runtime);
  const smoke = await runSetupSmoke(project.name);
  let smokeLine =
    `paused daemon --once; temporary /healthz on :${smoke.daemon.port}; ` +
    `stored status for ${smoke.status.project}`;
  let restartVia: "systemctl" | "cli" | undefined;
  if (smoke.mode === "existing") {
    if (smoke.status.liveWorkers > 0) {
      ctx.ui.notify(
        [
          `Setup files are updated, but ${smoke.status.liveWorkers} live worker(s) still use the old daemon config.`,
          "Dispatch remains paused. Let those workers finish.",
          `Then run \`omp-conductor restart --project ${project.name}\`.`,
          project.escalation.orchestrator === "external"
            ? `Run \`omp-conductor arm --project ${project.name}\` if ticks are disarmed, then run \`omp-conductor resume\`.`
            : "Then run `omp-conductor resume`.",
        ].join("\n"),
        "warning",
      );
      return;
    }
    const restarted = await restartDaemon({ project: project.name });
    restartVia = restarted.via;
    smokeLine =
      `existing /healthz and stored status; restarted through ${restarted.via}; ` +
      `new /healthz on :${restarted.record.port}`;
  }

  let armLine = "embedded orchestrator — no heartbeat arm marker";
  if (project.escalation.orchestrator === "external") {
    const marker = armedMarkerPath(project.name);
    if (existsSync(marker)) {
      armLine = `existing heartbeat arm preserved at ${marker}`;
    } else {
      ctx.ui.notify("Setup smoke passed. Sending the inbound Telegram arm challenge…", "info");
      try {
        const armed = await armTicks(project.name);
        armLine = `heartbeat armed for owner ${armed.owner} at ${armed.path}`;
      } catch (err) {
        ctx.ui.notify(
          [
            "Setup files passed the paused daemon smoke, but the fleet remains held.",
            err instanceof Error ? err.message : String(err),
            `Start the external orchestrator in ${project.workspaceRoot}, then run \`omp-conductor arm --project ${project.name}\`.`,
            "After the arm proof succeeds, run `omp-conductor resume`.",
          ].join("\n"),
          "warning",
        );
        return;
      }
    }
  }
  setPaused(false);

  ctx.ui.notify(
    [
      created.length > 0 ? `Created label(s): ${created.join(", ")}` : "All required labels already existed.",
      `Wrote ${path}; dispatch is ready.`,
      briefPath === undefined
        ? "Kept the existing orchestrator brief."
        : `Wrote ${briefPath} + POLICY.md. Edit POLICY.md for Releases and Reporting.`,
      runtimeFiles.length === 0
        ? "Host runtime files were already current."
        : `Wrote host runtime file(s): ${runtimeFiles.join(", ")}`,
      `Smoke passed: ${smokeLine}.`,
      `Heartbeat: ${armLine}.`,
      "",
      "On a systemd host, install and start the supervised daemon:",
      ...(restartVia === "cli" ? ["  omp-conductor stop"] : []),
      ...runtime.installCommands.map((command) => `  ${command}`),
      "",
      "Without systemd, run `omp-conductor start`.",
      "Use the documented toy-issue drill to prove one complete worker path.",
    ].join("\n"),
    "info",
  );
}

export default function conductorPlugin(pi: PluginApi): void {
  pi.registerCommand("conductor", {
    description: "Dispatch ready issues to omp coding sessions",
    getArgumentCompletions: (prefix) => SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.trim())),

    handler: async (args, ctx) => {
      // findProject() throws when the config holds several projects and none is
      // named, so the project name rides along as an optional second word.
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];
      const withPane = tokens.includes("--pane");
      const project = tokens.find((t, i) => i > 0 && t !== "--pane");

      try {
        switch (sub) {
          case "setup":
            await setup(ctx, project);
            break;

          case "status":
            ctx.ui.notify(await renderStatus(project), "info");
            break;

          case "hold": {
            const r = hold(project);
            ctx.ui.notify(
              `Held — claiming paused; ticks disarmed at ${r.disarmed.path}. Daemon and pane left running.`,
              "info",
            );
            break;
          }

          case "halt": {
            if (withPane) {
              const r = await haltWithPane(project);
              const stop =
                r.stop.kind === "not-running"
                  ? "daemon was not running"
                  : `daemon stopped (pid ${r.stop.pid})`;
              ctx.ui.notify(
                `Halted — ${stop}. Pane: ${r.pane.stopped} (${r.pane.detail}); recovery pinned at ${r.pane.pinPath}.`,
                "info",
              );
            } else {
              const r = await halt(project);
              const stop =
                r.stop.kind === "not-running"
                  ? "daemon was not running"
                  : `daemon stopped (pid ${r.stop.pid})`;
              ctx.ui.notify(`Halted — ${stop}. Pane left running.`, "info");
            }
            break;
          }

          case "arm": {
            ctx.ui.notify("Arm: sending inbound Telegram challenge — reply in the bot DM…", "info");
            const r = await armTicks(project);
            ctx.ui.notify(`ARMED — owner ${r.owner}; marker ${r.path}`, "info");
            break;
          }

          case "disarm": {
            const r = disarmTicks(project);
            ctx.ui.notify(`Disarmed — ${r.path}`, "info");
            break;
          }

          case "release-pane": {
            const r = clearPaneHalt(project);
            ctx.ui.notify(
              r.wasHalted ? `Pane recovery pin cleared (${r.path}).` : `No pane recovery pin at ${r.path}.`,
              "info",
            );
            break;
          }

          case "pause":
            setPaused(true);
            ctx.ui.notify("Paused claiming only — ticks keep firing if armed. Prefer /conductor hold.", "info");
            break;

          case "resume":
            releaseHold();
            ctx.ui.notify("Resumed claiming — did NOT re-arm. Run /conductor arm for ticks.", "info");
            break;

          case "brief-upgrade": {
            const p = findProject(loadConfig(), project);
            const path = briefPathForProject(p);
            const rendered = renderBriefForProject(p);
            const layout = inspectBriefLayout(p.workspaceRoot, rendered);
            if (layout.kind === "missing") {
              ctx.ui.notify(
                `No brief at ${path} — run /conductor setup and say yes to writing ${ORCHESTRATOR_BRIEF_NAME} + ${POLICY_BRIEF_NAME}.`,
                "warning",
              );
              break;
            }
            if (layout.kind === "overlay") {
              ctx.ui.notify(
                formatBriefStatus(path, {
                  kind: "overlay",
                  policyPath: layout.policyPath,
                  orchestratorPath: layout.orchestratorPath,
                }),
                "info",
              );
              const repair = await ctx.ui.confirm(
                "Repair POLICY.md banner crumbs and recompose?",
                "Strips any leading HTML-comment leftovers from a pre-fix migrate, then recomposes ORCHESTRATOR.md from the package floor + POLICY.md.",
              );
              if (repair) {
                const repaired = repairPolicyBannerCrumbs({
                  orchestratorPath: layout.orchestratorPath,
                  policyPath: layout.policyPath,
                  floor: renderFloorForProject(p),
                });
                ctx.ui.notify(
                  repaired === undefined
                    ? "Recomposed ORCHESTRATOR.md — POLICY.md needed no crumb strip."
                    : formatMigrateResult(repaired),
                  "info",
                );
              }
              break;
            }
            if (layout.kind === "legacy-bannered") {
              ctx.ui.notify(
                [
                  `Legacy bannered brief at ${layout.orchestratorPath}.`,
                  "Migrate the owned half into POLICY.md so the package floor refreshes each tick.",
                ].join("\n"),
                "warning",
              );
              const migrate = await ctx.ui.confirm(
                "Migrate to POLICY.md overlay?",
                "Writes POLICY.md from everything below YOURS TO EDIT, recomposes ORCHESTRATOR.md from the package floor + that policy, and keeps backups.",
              );
              if (migrate) {
                const result = migrateToPolicy({
                  orchestratorPath: layout.orchestratorPath,
                  policyPath: policyPathForProject(p),
                  floor: renderFloorForProject(p),
                  owned: layout.owned,
                });
                ctx.ui.notify(formatMigrateResult(result), "info");
              }
              break;
            }
            const status = checkBrief(readFileSync(path, "utf8"), rendered);
            ctx.ui.notify(formatBriefStatus(path, status), "warning");
            if (status.kind === "mergeable") {
              const apply = await ctx.ui.confirm(
                "Upgrade the brief?",
                "Replace the half above the YOURS TO EDIT banner with the one this version ships? Everything below the banner is kept exactly as it is, and the current file is backed up first.",
              );
              if (apply) {
                const backup = writeMergedBrief(path, status.merged);
                ctx.ui.notify(`Brief upgraded. Previous version kept at ${backup}.`, "info");
              }
            }
            break;
          }

          default:
            ctx.ui.notify(
              `${sub ? `Unknown subcommand "${sub}".` : "Pick a subcommand."}\n\n${USAGE}` +
                (isPaused() ? "\n\nThe conductor is currently paused." : ""),
              sub ? "warning" : "info",
            );
        }
      } catch (err) {
        // Config problems arrive as a single readable message listing every
        // fault, which is more use to the operator than a stack.
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
}
