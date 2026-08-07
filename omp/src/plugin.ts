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
import { checkBrief, formatBriefStatus, writeMergedBrief } from "./brief-upgrade.ts";
import { configPath, findProject, loadConfig, saveConfig } from "./config.ts";
import {
  armConductor,
  formatStatus,
  isPaused,
  previewQueue,
  setPaused,
  statusSnapshot,
  type QueuePreview,
} from "./daemon.ts";
import {
  ORCHESTRATOR_BRIEF_NAME,
  REPORT_SCOPE_CHOICES,
  SETUP_DEFAULTS,
  briefPathForProject,
  buildConfig,
  checkTokenScopes,
  createMissingLabels,
  detectTelegram,
  orchestratorBriefPath,
  planLabels,
  renderBriefForProject,
  summarisePlan,
  writeOrchestratorBrief,
  type SetupAnswers,
} from "./setup.ts";
import {
  DEFAULT_CAPS,
  DEFAULT_REPORT_SCOPE,
  type Caps,
  type ConductorConfig,
  type OrchestratorMode,
  type ProjectConfig,
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
  { value: "setup", label: "setup", description: "onboarding wizard: config, labels, dry run, then arm" },
  { value: "status", label: "status", description: "pause state, caps, active runs, today's usage" },
  { value: "pause", label: "pause", description: "stop claiming new work" },
  { value: "resume", label: "resume", description: "allow claiming again" },
  {
    value: "brief-upgrade",
    label: "brief-upgrade",
    description: "check ORCHESTRATOR.md against the brief this version ships",
  },
];

const USAGE = [
  "/conductor setup [project]         create or update a project, then arm after you confirm",
  "/conductor status [project]        pause state, caps, active runs, today's usage",
  "/conductor pause                   stop claiming new work",
  "/conductor resume                  allow claiming again",
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
 * Pre-push gates as one comma-separated line, `cmd @ cwd` for a subdirectory:
 * `bun run check, bun test @ server`.
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
  const shown = seed.map((g) => (g.cwd === "." ? g.cmd : `${g.cmd} @ ${g.cwd}`)).join(", ");
  const raw = await ask(ctx, `Pre-push gates for ${repoName} — exactly what CI runs, comma separated`, shown);

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
 * Whether to render the operator's own brief, and — separately — whether an
 * existing one may be replaced. Two questions on purpose: that file is where a
 * fleet's release and reporting policy ends up, so it is never overwritten by
 * an operator who only meant to re-run setup.
 */
async function askOrchestratorBrief(ctx: CommandContext, a: SetupAnswers): Promise<boolean> {
  const path = orchestratorBriefPath(a);
  const wanted = await ctx.ui.confirm(
    `Write an orchestrator brief template to ${path}?`,
    `It is the standing prompt for your supervising session: duties, tiers, and boundaries, ` +
      `plus a release policy and a reporting section that are yours to edit. ` +
      `The conductor never reads it back — it stops at green PRs either way.`,
  );
  if (!wanted) return false;
  if (!existsSync(path)) return true;

  return await ctx.ui.confirm(
    `Overwrite the existing ${ORCHESTRATOR_BRIEF_NAME}?`,
    `${path} already exists. Overwriting replaces it with the shipped template — any policy you wrote there is lost.`,
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
 * The conversation. Reads only — every answer is collected before anything is
 * checked against GitHub, and long before anything is written.
 */
async function collectAnswers(
  ctx: CommandContext,
  existing: ConductorConfig | undefined,
  projectArg: string | undefined,
): Promise<SetupAnswers> {
  const prior = priorProject(existing, projectArg);

  const projectName = await askValid(
    ctx,
    "Project name",
    projectArg ?? prior?.name ?? "",
    (v) => (v.length > 0 ? undefined : "A name is required — it is how `/conductor status <name>` finds this project."),
  );

  const trackerRepo = await askValid(
    ctx,
    "Tracker repo (owner/repo) — where ready issues live",
    prior?.tracker.repo ?? "",
    (v) => (REPO_RE.test(v) ? undefined : `"${v}" is not owner/repo — e.g. acme/planning.`),
  );

  const queueLabel = await ask(
    ctx,
    "Queue label — the human sign-off that makes an issue claimable",
    prior?.queueLabel ?? SETUP_DEFAULTS.queueLabel,
  );

  // One confirm instead of three prompts: the namespaced defaults are right for
  // almost everyone, and three dialogs of Enter-to-accept is how a wizard earns
  // its reputation.
  const stateLabels: SetupAnswers["stateLabels"] = { ...(prior?.stateLabels ?? SETUP_DEFAULTS.stateLabels) };
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
    prior?.routing.labelPrefix ?? SETUP_DEFAULTS.routingLabelPrefix,
  );

  const targetRepos: SetupAnswers["targetRepos"] = [];
  const seeds = Object.values(prior?.routing.repos ?? {});
  for (let i = 0; ; i++) {
    const seed = seeds[i];
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

  const caps: Partial<Caps> = { ...prior?.caps };
  const tuneCaps = await ctx.ui.confirm(
    "Caps",
    `Defaults: ${DEFAULT_CAPS.maxConcurrentWorkers} workers, ` +
      `$${DEFAULT_CAPS.dailySpendUsd}/day, ${DEFAULT_CAPS.workerMaxTurns} turns and ` +
      `${Math.round(DEFAULT_CAPS.workerWallClockMs / 60000)} min per worker, ` +
      `${DEFAULT_CAPS.maxAttemptsPerIssue} attempts per issue. Change them?`,
  );
  if (tuneCaps) {
    // Spelled out rather than looped: adding a cap should fail to compile here,
    // not silently go unasked.
    caps.maxConcurrentWorkers = await askNumber(
      ctx,
      "Max concurrent workers",
      caps.maxConcurrentWorkers ?? DEFAULT_CAPS.maxConcurrentWorkers,
    );
    caps.dailySpendUsd = await askNumber(ctx, "Spend ceiling per rolling day (USD)", caps.dailySpendUsd ?? DEFAULT_CAPS.dailySpendUsd);
    caps.workerMaxTurns = await askNumber(ctx, "Turn ceiling per worker", caps.workerMaxTurns ?? DEFAULT_CAPS.workerMaxTurns);
    caps.workerWallClockMs = await askNumber(
      ctx,
      "Wall-clock ceiling per worker (ms)",
      caps.workerWallClockMs ?? DEFAULT_CAPS.workerWallClockMs,
    );
    caps.maxAttemptsPerIssue = await askNumber(
      ctx,
      "Attempts per issue before it escalates",
      caps.maxAttemptsPerIssue ?? DEFAULT_CAPS.maxAttemptsPerIssue,
    );
  }

  // Straight after the caps, and for the same reason they sit together: these
  // are the two questions that decide what an unattended fleet may do without
  // asking anybody.
  const authority = await askAuthority(ctx, prior?.authority ?? SETUP_DEFAULTS.authority);

  // Outside the caps block: a model is not a ceiling, and an operator who left
  // the caps alone may still want workers on a cheaper model.
  const answeredModel = await ask(
    ctx,
    "Worker model pattern (blank = harness default)",
    prior?.workerModel ?? "",
  );
  const workerModel = answeredModel.trim().length > 0 ? answeredModel.trim() : undefined;

  const telegram = detectTelegram();
  let telegramChatId = prior?.escalation.telegramChatId;
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

  const orchestratorMode = await askOrchestratorMode(
    ctx,
    prior?.escalation.orchestrator ?? SETUP_DEFAULTS.orchestratorMode,
  );

  const reportScope = await askReportScope(ctx, prior?.reporting?.scope ?? DEFAULT_REPORT_SCOPE);

  const answers: SetupAnswers = {
    projectName,
    trackerRepo,
    queueLabel,
    stateLabels,
    routingLabelPrefix,
    targetRepos,
    caps,
    fallbackToIssueComment,
    authority,
    orchestratorMode,
    reportScope,
    // Asked last, and asked with the real path in the question — which needs the
    // rest of the answers to derive, so the decision is folded in below.
    writeOrchestratorBrief: false,
  };
  if (telegramChatId !== undefined) answers.telegramChatId = telegramChatId;
  if (workerModel !== undefined) answers.workerModel = workerModel;
  return { ...answers, writeOrchestratorBrief: await askOrchestratorBrief(ctx, answers) };
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

/**
 * The dry run needs a saved config to read, and before the confirm there may
 * not be one — that is the normal first run, not a failure. So the reason is
 * reported inline and the wizard carries on; the post-write preview is the one
 * that always has something to say.
 */
async function tryPreview(project: string): Promise<string[]> {
  try {
    return formatPreview(await previewQueue(project));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [`  (not available yet: ${message.split("\n")[0] ?? message})`];
  }
}

/**
 * The onboarding wizard.
 *
 * The invariant that makes this safe to run against a live tracker: nothing is
 * written or created before the confirm below returns true. Reading the config,
 * asking questions, `checkTokenScopes`, `planLabels` and `previewQueue` are all
 * reads. The four mutations — `createMissingLabels`, `saveConfig`,
 * `writeOrchestratorBrief`, `armConductor` — all live after it. Keep it that way.
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

  let answers: SetupAnswers;
  try {
    answers = await collectAnswers(ctx, existing, projectArg);
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err;
    ctx.ui.notify("Setup cancelled — nothing was changed.", "info");
    return;
  }

  const scopes = await checkTokenScopes();
  const labels = await planLabels(answers.trackerRepo, answers);
  const telegram = detectTelegram();

  ctx.ui.notify(
    [
      summarisePlan(answers, scopes, labels, telegram),
      "",
      existing === undefined
        ? "Dry run: available once the config is written."
        : "Dry run against the CURRENTLY SAVED config:",
      ...(existing === undefined ? [] : await tryPreview(answers.projectName)),
      "",
      "Nothing has been changed yet.",
    ].join("\n"),
    "info",
  );

  const toCreate = labels.filter((l) => !l.exists).map((l) => l.name);
  const go = await ctx.ui.confirm(
    "Apply this setup?",
    [
      toCreate.length > 0
        ? `Creates ${toCreate.length} label(s) in ${answers.trackerRepo}: ${toCreate.join(", ")}.`
        : "Creates no labels.",
      `Writes ${path}, creates the state database and clears the pause flag.`,
      scopes.missing.length > 0
        ? `WARNING: the gh token is missing ${scopes.missing.join(", ")} — the daemon will fail to label issues.`
        : "",
      answers.writeOrchestratorBrief
        ? `Writes ${orchestratorBriefPath(answers)}, which is then yours to edit.`
        : "",
      "Issues are only claimed once the daemon runs.",
    ]
      .filter((s) => s.length > 0)
      .join(" "),
  );
  if (!go) {
    ctx.ui.notify("Left untouched — no labels created, no config written, nothing armed.", "info");
    return;
  }

  // Labels first: a config pointing at labels that do not exist is a daemon
  // that starts and then fails on its first claim.
  const created = await createMissingLabels(answers.trackerRepo, labels);
  saveConfig(buildConfig(answers, existing));
  const briefPath = answers.writeOrchestratorBrief ? writeOrchestratorBrief(answers) : undefined;
  armConductor();

  ctx.ui.notify(
    [
      created.length > 0 ? `Created label(s): ${created.join(", ")}` : "No labels needed creating.",
      `Wrote ${path} and armed the conductor.`,
      briefPath === undefined
        ? "No orchestrator brief written — the conductor stops at green PRs; merges and releases stay human."
        : `Wrote ${briefPath} — edit its "Releases" and "Reporting" sections; nothing here reads them back.`,
      "",
      "Dry run against the config just written:",
      ...(await tryPreview(answers.projectName)),
      "",
      "Start the loop with `omp-conductor daemon`, or `omp-conductor daemon --once` for a single tick.",
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
      const [sub, project] = args.trim().split(/\s+/);

      try {
        switch (sub) {
          case "setup":
            await setup(ctx, project);
            break;

          case "status":
            ctx.ui.notify(formatStatus(statusSnapshot(project)), "info");
            break;

          case "pause":
            setPaused(true);
            ctx.ui.notify("Conductor paused — no new work will be claimed.", "info");
            break;

          case "resume":
            setPaused(false);
            ctx.ui.notify("Conductor resumed — work will be claimed on the next tick.", "info");
            break;

          case "brief-upgrade": {
            const p = findProject(loadConfig(), project);
            const path = briefPathForProject(p);
            if (!existsSync(path)) {
              ctx.ui.notify(
                `No brief at ${path} — run /conductor setup and say yes to writing ${ORCHESTRATOR_BRIEF_NAME}.`,
                "warning",
              );
              break;
            }
            const status = checkBrief(readFileSync(path, "utf8"), renderBriefForProject(p));
            ctx.ui.notify(formatBriefStatus(path, status), status.kind === "current" ? "info" : "warning");
            // Confirmed here rather than applied on sight: this file is a standing
            // prompt the operator may have spent an hour on, so the diff they just
            // read is the thing they are agreeing to.
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
