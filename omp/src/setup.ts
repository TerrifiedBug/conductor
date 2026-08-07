/**
 * The onboarding core behind `/conductor setup`.
 *
 * Everything here is headless and synchronously testable: the plugin owns the
 * dialogs, this module owns the decisions. That split is the point — a wizard
 * whose logic lives inside UI callbacks can only be verified by driving a TUI,
 * so in practice it never is, and the first thing a new user touches is the
 * least tested code in the package.
 *
 * Two functions here mutate something outside the process: `createMissingLabels`
 * and `writeOrchestratorBrief`. Everything else reads, or computes. That is what
 * lets the plugin show a complete plan before asking for consent, and it is a
 * property worth preserving — check it before adding a function.
 *
 * ponytail: `gh` is shelled out to per call rather than shared with the tracker
 * adapter's private `gh()`, which throws on non-zero exit. Setup needs the
 * opposite: an unauthenticated or unreachable `gh` is a finding to report in the
 * plan, not an exception thrown mid-prompt. The ceiling is one duplicated 15-line
 * spawn helper; the upgrade path, if a third caller appears, is to lift both into
 * `src/gh.ts` exposing `gh()` (throwing) over `ghTry()` (classifying).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  COMPOSE_BANNER,
  ORCHESTRATOR_BRIEF_NAME,
  POLICY_BRIEF_NAME,
  composeOrchestrator,
  policyPathForRoot,
  renderBriefTemplate,
  writeWithBackup,
} from "./brief-upgrade.ts";
import { configPath, resolveCaps, stateDir } from "./config.ts";
import { graphProjectPath, graphRepos } from "./graph.ts";
import {
  CONFIG_VERSION,
  DEFAULT_AUTHORITY,
  DEFAULT_CAPS,
  DEFAULT_REPORT_SCOPE,
  type Caps,
  type ConductorConfig,
  type OrchestratorMode,
  type ProjectConfig,
  type ReportScope,
  type RepoTarget,
} from "./types.ts";

/**
 * Every decision the wizard needs, in one plain object. Collected by the UI,
 * consumed by `buildConfig`, so the prompt order can change without touching
 * the shape of the config that comes out.
 */
export interface SetupAnswers {
  projectName: string;
  /** Tracker repo as `owner/repo` — the only spelling `gh` takes without a host. */
  trackerRepo: string;
  queueLabel: string;
  stateLabels: { inProgress: string; blocked: string; failed: string };
  routingLabelPrefix: string;
  targetRepos: { name: string; cloneUrl: string; defaultBranch: string; gates: { cmd: string; cwd: string }[] }[];
  caps: Partial<Caps>;
  /**
   * Model pattern for worker sessions, in omp's model/role syntax. Absent means
   * the harness default, which is the answer for anyone who has not deliberately
   * pinned one.
   */
  workerModel?: string;
  telegramChatId?: string;
  fallbackToIssueComment: boolean;
  /** How loud the supervising orchestrator session should be. */
  reportScope: ReportScope;
  /**
   * Whether to render `ORCHESTRATOR.md` into the project's workspace root. Not
   * part of the config — the brief is the operator's file, and the conductor
   * never reads it back — but it is a decision the wizard has to carry from the
   * prompt that asked it to the step that acts on it.
   */
  writeOrchestratorBrief: boolean;
  /**
   * Who lands green PRs and who cuts releases. Both default to the human — see
   * {@link DEFAULT_AUTHORITY} — and the answer is what the rendered brief's
   * Releases paragraph states, so the session can never read a delegation the
   * config does not grant.
   */
  authority: ProjectConfig["authority"];
  /**
   * Whether the daemon runs its own triage session, or an operator already runs
   * one elsewhere. `external` on a host where the orchestrator is a visible TUI
   * session: the daemon then posts tier-1 escalations as issue comments for
   * that session to drain, rather than starting a second brain.
   */
  orchestratorMode: OrchestratorMode;
  /**
   * Parent directory of the index-only clones workers query, or absent when the
   * operator declined code-graph discovery — in which case no repo gets a
   * `graphProject` and every rendered brief is the one this package shipped
   * before graphs existed.
   *
   * One answer for the whole project rather than one per repo: the clones are
   * derived data with no reason to live apart, and a per-repo prompt would ask
   * the same question four times to arrive at four siblings.
   */
  graphRoot?: string;
}

/** What `gh auth status` says the active token may do. */
export interface ScopeCheck {
  ok: boolean;
  login?: string;
  scopes: string[];
  missing: string[];
}

/** One tracker label the daemon depends on, and whether it is already there. */
export interface LabelPlan {
  name: string;
  /** Six hex digits, no leading `#` — what `gh label create --color` wants. */
  colour: string;
  description: string;
  exists: boolean;
}

/** Defaults the wizard pre-fills. Exported so the prompts and this module
 *  cannot drift apart: one spelling of "ready-for-agent" in the package. */
export const SETUP_DEFAULTS = {
  queueLabel: "ready-for-agent",
  stateLabels: { inProgress: "agent:in-progress", blocked: "agent:blocked", failed: "agent:failed" },
  routingLabelPrefix: "repo:",
  defaultBranch: "main",
  /** Both authorities start with the human; the wizard asks to move each one. */
  authority: DEFAULT_AUTHORITY,
  /** The daemon runs its own triage session unless an operator already runs one. */
  orchestratorMode: "embedded",
} as const;

/**
 * The two report scopes as the operator meets them, described once. The wizard
 * shows these labels, the plan summary quotes the description, and the rendered
 * brief spells the same two options out — so "material" cannot come to mean one
 * thing in the dialog and another in the session that has to honour it.
 */
export const REPORT_SCOPE_CHOICES: readonly { scope: ReportScope; label: string; description: string }[] = [
  {
    scope: "material",
    label: "Material events",
    description: "escalations, plus green PRs, second failures, and anything that stops the fleet",
  },
  {
    scope: "escalations",
    label: "Escalations only",
    description: "escalations when they happen, plus one daily digest — silent otherwise",
  },
];

/**
 * The Releases paragraph the brief opens with, one per authority combination.
 *
 * Rendered rather than written by hand for the reason the standing orders are
 * worded from the same config: an operator who delegated merging in setup and a
 * brief that still says "you do not merge" is a session that has been given two
 * answers and will act on whichever it read last.
 *
 * A mapped type over both holders, so adding a third holder fails to compile
 * here instead of rendering `undefined` into somebody's standing prompt.
 */
export const RELEASES_DEFAULTS: {
  readonly [K in `${ProjectConfig["authority"]["merge"]}/${ProjectConfig["authority"]["release"]}`]: string;
} = {
  "human/human":
    '**Default: humans release, and you do not merge.** Work ends at a green PR;\n' +
    "merging is a separate human action, and releasing is a separate human action after\n" +
    'that. "This needs releasing" is something you report, never something you take on.',
  "orchestrator/orchestrator":
    "**Delegated in setup: you merge, and you release.** Merge green PRs one at a\n" +
    "time, re-checked against the base branch first. Cut releases per the procedure\n" +
    "your operator writes below — do not cut one before the seven specifics are\n" +
    "filled in.",
  "orchestrator/human":
    "**Delegated in setup: you merge; humans release.** Merge green PRs one at a\n" +
    'time, re-checked against the base branch first. "This needs releasing" is\n' +
    "something you report, never something you take on.",
  "human/orchestrator":
    "**Delegated in setup: humans merge; you release.** You cut releases from work a\n" +
    "human has already merged, per the procedure your operator writes below.",
};

/**
 * Duty 1's "the PR is green" branch, worded from `authority.merge`.
 *
 * The duty has to name an action, and which action depends on the grant. A
 * session told "merging is yours" in its standing orders and told "you do not
 * merge it" three sections into its own brief will do whichever it read last,
 * which is the failure this whole key exists to prevent. The bullet marker is
 * part of the value so the template line is nothing but the placeholder.
 */
export const MERGE_DUTY: { readonly [K in ProjectConfig["authority"]["merge"]]: string } = {
  human:
    "- **It is already done.** The PR is green and waiting on a human merge. Note it,\n" +
    "  with the link, and move on. You do not merge it.",
  orchestrator:
    "- **It is already done.** The PR is green, and merging is yours. Re-check it\n" +
    "  against the base branch, merge it, and note the link. One PR at a time — that\n" +
    "  one is a hard boundary, not a preference.",
};

export { ORCHESTRATOR_BRIEF_NAME, POLICY_BRIEF_NAME };

/** Shipped floor template — duties, tiers, hard boundaries, Learning loop. */
const ORCHESTRATOR_TEMPLATE_PATH = join(import.meta.dir, "briefs", "orchestrator.md");

/** Shipped POLICY.md scaffold — Releases, Project context, Reporting, Amendments. */
const POLICY_TEMPLATE_PATH = join(import.meta.dir, "briefs", "policy.md");

/**
 * `repo` writes labels and closes issues; `project` moves cards on the board.
 * Both are load-bearing for an unattended loop, so a missing one is reported
 * rather than discovered at 03:00 as a run that claimed work it cannot label.
 */
const REQUIRED_SCOPES = ["repo", "project"] as const;

/** GitHub's own palette, so the tracker reads at a glance: green means queued,
 *  blue means moving, amber means waiting on you, red means it gave up. */
const LABEL_COLOURS = {
  queue: "0e8a16",
  inProgress: "1d76db",
  blocked: "fbca04",
  failed: "b60205",
} as const;

interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `gh` and classifies instead of throwing. stdin is a closed stream so a
 * command that would read it sees EOF rather than hanging on an open pipe.
 */
async function gh(argv: string[]): Promise<GhResult> {
  try {
    const proc = Bun.spawn(["gh", ...argv], {
      stdin: new Blob([""]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (err) {
    // `gh` missing from PATH lands here. A diagnosis, not a crash: the wizard
    // is mid-conversation with a human and should say what is wrong.
    return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Bounds `gh` stderr to the two lines that carry the diagnosis. A durable
 * contract rather than a rename: every error this module raises passes through
 * here, so an unexpectedly chatty `gh` build can never dump an arbitrary
 * subprocess transcript into a message the caller shows or logs.
 */
function briefly(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.slice(0, 2).join(" / ") || "(no output)";
}

/**
 * Reads the active `gh` token's scopes without ever handling the token itself.
 *
 * `gh auth status` masks the token in its own output and this function returns
 * only the parsed scope names and login, so no credential can escape through
 * the return value, a log line, or a thrown message — hence the deliberate
 * absence of any `throw` here.
 *
 * ponytail: the first `Token scopes:` line wins. A `gh` configured for both
 * github.com and a GHES host prints one block each, and this credits the first.
 * Upgrade path: pass `--hostname` once the tracker learns about non-default hosts.
 */
export async function checkTokenScopes(): Promise<ScopeCheck> {
  // Older gh writes the status block to stderr, newer to stdout; read both
  // rather than guessing at the installed version.
  const r = await gh(["auth", "status"]);
  const text = `${r.stdout}\n${r.stderr}`;

  const scopeLine = /Token scopes:\s*(.*)/.exec(text);
  const scopes = (scopeLine?.[1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter((s) => s.length > 0 && s !== "none");

  // "account <login>" is gh >= 2.40, "as <login>" everything before it.
  const loginMatch = /Logged in to \S+ (?:account|as) (\S+)/.exec(text);
  const login = loginMatch?.[1];

  const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
  const check: ScopeCheck = { ok: r.code === 0 && missing.length === 0, scopes, missing };
  if (login !== undefined) check.login = login;
  return check;
}

/**
 * The four labels the loop reads and writes, and which already exist. Read-only:
 * this is what the operator is shown before being asked to consent to creation.
 */
export async function planLabels(trackerRepo: string, a: SetupAnswers): Promise<LabelPlan[]> {
  const wanted: Omit<LabelPlan, "exists">[] = [
    {
      name: a.queueLabel,
      colour: LABEL_COLOURS.queue,
      description: "Signed off by a human as ready for the conductor to claim",
    },
    {
      name: a.stateLabels.inProgress,
      colour: LABEL_COLOURS.inProgress,
      description: "A conductor worker is running on this issue",
    },
    {
      name: a.stateLabels.blocked,
      colour: LABEL_COLOURS.blocked,
      description: "Parked by the conductor — waiting on a human answer",
    },
    {
      name: a.stateLabels.failed,
      colour: LABEL_COLOURS.failed,
      description: "The conductor gave up on this issue after its retry budget",
    },
  ];

  const existing = await listLabelNames(trackerRepo);

  // GitHub label names are unique case-insensitively, so an operator who answers
  // "Ready-For-Agent" against an existing "ready-for-agent" must not be told a
  // creation is pending that would then fail.
  const seen = new Set<string>();
  const plan: LabelPlan[] = [];
  for (const w of wanted) {
    const key = w.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    plan.push({ ...w, exists: existing.has(key) });
  }
  return plan;
}

/** Lower-cased label names currently on the repo. Throws rather than guessing:
 *  a repo whose labels cannot be listed cannot be serviced either. */
async function listLabelNames(trackerRepo: string): Promise<Set<string>> {
  const r = await gh(["label", "list", "--repo", trackerRepo, "--limit", "200", "--json", "name"]);
  if (r.code !== 0) {
    throw new Error(`Cannot list labels in ${trackerRepo}: ${briefly(r.stderr)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout || "[]") as unknown;
  } catch {
    throw new Error(`Cannot read the label list for ${trackerRepo}: gh returned output that is not JSON.`);
  }
  const names = new Set<string>();
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const name = (entry as { name?: unknown } | null)?.name;
      if (typeof name === "string" && name.length > 0) names.add(name.toLowerCase());
    }
  }
  return names;
}

/**
 * The single mutating step in this module, and the plugin calls it only after
 * the operator has confirmed the printed plan.
 *
 * Returns the names actually created — a label that already existed is not in
 * the list, because reporting it as created would be a lie the operator would
 * have to verify by hand. A concurrent creation (or a label list that was
 * stale by the time we got here) is success, not an error: the end state the
 * caller asked for holds either way.
 */
export async function createMissingLabels(trackerRepo: string, plan: LabelPlan[]): Promise<string[]> {
  const created: string[] = [];
  for (const label of plan) {
    if (label.exists) continue;
    const r = await gh([
      "label",
      "create",
      label.name,
      "--repo",
      trackerRepo,
      "--color",
      label.colour,
      "--description",
      label.description,
    ]);
    if (r.code === 0) {
      created.push(label.name);
      continue;
    }
    if (/already exists/i.test(r.stderr)) continue;
    throw new Error(`Could not create label "${label.name}" in ${trackerRepo}: ${briefly(r.stderr)}`);
  }
  return created;
}

/**
 * The single `ProjectConfig` the answers describe.
 *
 * Split out of `buildConfig` so the plan summary can show the exact project
 * that would be written — including the derived worktree and mirror paths —
 * without assembling a whole config and indexing back into its array. Exported
 * for the amend summary's before-and-after, and so a test can pin its round-trip
 * with {@link answersFromProject} — the pair an amend's carry-through rests on.
 */
export function buildProject(a: SetupAnswers): ProjectConfig {
  const dir = stateDir();

  const repos: Record<string, RepoTarget> = {};
  const graphRoot = a.graphRoot?.trim();
  for (const r of a.targetRepos) {
    repos[r.name] = {
      name: r.name,
      cloneUrl: r.cloneUrl,
      defaultBranch: r.defaultBranch,
      gates: r.gates.map((g) => ({ cmd: g.cmd, cwd: g.cwd })),
      // One answered root becomes one clone per routed repo. Omitted entirely
      // when unanswered rather than written empty: the key's absence is what
      // makes an existing config's briefs render exactly as they did before.
      ...(graphRoot === undefined || graphRoot.length === 0
        ? {}
        : { graphProject: graphProjectPath(graphRoot, r.name) }),
    };
  }

  const escalation: ProjectConfig["escalation"] = {
    fallbackToIssueComment: a.fallbackToIssueComment,
    orchestrator: a.orchestratorMode,
  };
  if (a.telegramChatId !== undefined && a.telegramChatId.trim().length > 0) {
    escalation.telegramChatId = a.telegramChatId.trim();
  }

  const caps: Partial<Caps> = {};
  // Drops `undefined` members so an unanswered cap is absent from the JSON
  // rather than present-and-null, which the validator would have to reject.
  for (const [key, value] of Object.entries(a.caps) as [keyof Caps, number | undefined][]) {
    if (typeof value === "number") caps[key] = value;
  }

  return {
    name: a.projectName,
    tracker: { kind: "github", repo: a.trackerRepo },
    queueLabel: a.queueLabel,
    stateLabels: { ...a.stateLabels },
    routing: { labelPrefix: a.routingLabelPrefix, repos },
    caps,
    ...(a.workerModel !== undefined && a.workerModel.trim().length > 0
      ? { workerModel: a.workerModel.trim() }
      : {}),
    escalation,
    authority: { ...a.authority },
    reporting: { scope: a.reportScope },
    // Both under the state dir so one `rm -rf ~/.omp/conductor` is a complete
    // uninstall, and neither can land in a repo the daemon then tries to commit.
    workspaceRoot: join(dir, "worktrees"),
    mirrorRoot: join(dir, "mirrors"),
  };
}

/**
 * Turns answers into a config the real validator accepts.
 *
 * `existing` is how re-running setup for one project stays safe: a same-named
 * project is replaced in place (keeping its position), everything else is
 * carried through untouched. Rebuilding from answers alone would silently
 * delete a neighbour's entire configuration.
 */
export function buildConfig(a: SetupAnswers, existing?: ConductorConfig): ConductorConfig {
  const project = buildProject(a);
  const previous = existing?.projects ?? [];

  return {
    version: CONFIG_VERSION,
    // Answered caps land on the project, not here: on a re-run the global block
    // is also the baseline every other project inherits, and one project's
    // answers must never quietly re-budget its neighbour. An existing global
    // block is kept as-is so a hand-tuned default survives setup.
    defaults: { ...DEFAULT_CAPS, ...(existing?.defaults ?? {}) },
    projects: previous.some((p) => p.name === project.name)
      ? previous.map((p) => (p.name === project.name ? project : p))
      : [...previous, project],
  };
}

/**
 * The seed a brand-new project starts from: the shipped defaults, and nothing
 * answered yet.
 *
 * Exists so "what does an unanswered field start as" has exactly one spelling.
 * The wizard pre-fills every prompt from an answers object — this one on a first
 * run, {@link answersFromProject} on a re-run — rather than reaching for a
 * default at each prompt, which is how one prompt comes to disagree with the
 * config key it writes.
 */
export function defaultAnswers(projectName: string): SetupAnswers {
  return {
    projectName,
    // Empty rather than a plausible guess: both are required, and a pre-filled
    // tracker repo is the one default an operator would Enter straight past.
    trackerRepo: "",
    queueLabel: SETUP_DEFAULTS.queueLabel,
    stateLabels: { ...SETUP_DEFAULTS.stateLabels },
    routingLabelPrefix: SETUP_DEFAULTS.routingLabelPrefix,
    targetRepos: [],
    caps: {},
    fallbackToIssueComment: true,
    authority: { ...SETUP_DEFAULTS.authority },
    orchestratorMode: SETUP_DEFAULTS.orchestratorMode,
    reportScope: DEFAULT_REPORT_SCOPE,
    writeOrchestratorBrief: false,
  };
}

/**
 * The answers that describe a project already on disk — the inverse of
 * {@link buildProject}, and what makes amending one area possible.
 *
 * Every field is derived here, in one function, rather than field by field at
 * each prompt: an amend asks one area's questions and carries everything else
 * through untouched, so anything this forgets is a setting the operator loses by
 * changing an unrelated one. `buildProject(answersFromProject(p))` is pinned to
 * `p` by a test for exactly that reason.
 *
 * Three fields cannot be a straight copy:
 *
 * - `writeOrchestratorBrief` is a decision rather than a value, and it starts
 *   `false` so an amend that never visits the brief area leaves that file alone.
 * - `reportScope` reads through {@link DEFAULT_REPORT_SCOPE}, because the key is
 *   optional on disk. A config written before it existed gains it explicitly on
 *   the next write, saying what it already meant.
 * - `graphRoot` is one answer for a whole project while the config stores one
 *   path per repo, so it comes back from whichever repo already has one. Repos
 *   that disagree — only a hand-edit can produce that — widen to all of them on
 *   the next write exactly as a full re-run would, and the plan summary names
 *   every clone before anything is written.
 */
export function answersFromProject(p: ProjectConfig): SetupAnswers {
  const answers: SetupAnswers = {
    projectName: p.name,
    trackerRepo: p.tracker.repo,
    queueLabel: p.queueLabel,
    stateLabels: { ...p.stateLabels },
    routingLabelPrefix: p.routing.labelPrefix,
    targetRepos: Object.values(p.routing.repos).map((r) => ({
      name: r.name,
      cloneUrl: r.cloneUrl,
      defaultBranch: r.defaultBranch,
      gates: r.gates.map((g) => ({ cmd: g.cmd, cwd: g.cwd })),
    })),
    caps: { ...p.caps },
    fallbackToIssueComment: p.escalation.fallbackToIssueComment,
    authority: { ...p.authority },
    orchestratorMode: p.escalation.orchestrator,
    reportScope: p.reporting?.scope ?? DEFAULT_REPORT_SCOPE,
    writeOrchestratorBrief: false,
  };

  // Set only when present, never as an explicit `undefined`: an absent key is
  // what keeps the rewritten config identical to the one that was read.
  if (p.workerModel !== undefined) answers.workerModel = p.workerModel;
  if (p.escalation.telegramChatId !== undefined) answers.telegramChatId = p.escalation.telegramChatId;
  const graphed = graphRepos(p)[0];
  if (graphed !== undefined) answers.graphRoot = dirname(graphed.graphProject);

  return answers;
}

/**
 * Where a configured project's composed brief lives: beside its worktrees, under
 * the state directory, so it is on the same disk the fleet already owns and
 * survives a reinstall of the package. Derived from the project rather than
 * fixed, so a project that ever gains a chosen workspace root keeps its brief
 * with it.
 */
export function briefPathForProject(p: ProjectConfig): string {
  return join(p.workspaceRoot, ORCHESTRATOR_BRIEF_NAME);
}

/** Where the fleet-owned POLICY.md overlay lives for a project. */
export function policyPathForProject(p: ProjectConfig): string {
  return policyPathForRoot(p.workspaceRoot);
}

function briefVarsForProject(p: ProjectConfig): Record<string, string> {
  return {
    PROJECT: p.name,
    TRACKER_REPO: p.tracker.repo,
    QUEUE_LABEL: p.queueLabel,
    RELEASES_DEFAULT: RELEASES_DEFAULTS[`${p.authority.merge}/${p.authority.release}`],
    MERGE_DUTY: MERGE_DUTY[p.authority.merge],
    REPORT_SCOPE: p.reporting?.scope ?? DEFAULT_REPORT_SCOPE,
  };
}

/** Package floor template, placeholders and all. */
export function shippedFloorTemplate(): string {
  return readFileSync(ORCHESTRATOR_TEMPLATE_PATH, "utf8");
}

/** POLICY.md scaffold template, placeholders and all. */
export function shippedPolicyTemplate(): string {
  return readFileSync(POLICY_TEMPLATE_PATH, "utf8");
}

/**
 * Floor + policy templates concatenated with the compose banner, placeholders
 * intact. Used when no project config is available to render coordinates.
 */
export function shippedBriefTemplate(): string {
  return composeOrchestrator(shippedFloorTemplate(), shippedPolicyTemplate());
}

/** Rendered package floor for a configured project. */
export function renderFloorForProject(p: ProjectConfig): string {
  return renderBriefTemplate(shippedFloorTemplate(), briefVarsForProject(p));
}

/** Rendered POLICY.md scaffold for a configured project. */
export function renderPolicyForProject(p: ProjectConfig): string {
  return renderBriefTemplate(shippedPolicyTemplate(), briefVarsForProject(p));
}

/**
 * Composed session brief: rendered floor + POLICY scaffold (or a caller's policy).
 *
 * Setup writes the policy half to `POLICY.md` and this compose to
 * `ORCHESTRATOR.md`. Later ticks recompose from the live POLICY.md so package
 * floor updates apply without brief-upgrade.
 */
export function renderBriefForProject(p: ProjectConfig, policyText?: string): string {
  return composeOrchestrator(renderFloorForProject(p), policyText ?? renderPolicyForProject(p));
}

/** Wizard-time path, via the project the answers describe. */
export function orchestratorBriefPath(a: SetupAnswers): string {
  return briefPathForProject(buildProject(a));
}

/** Wizard-time render, via the project the answers describe. */
export function renderOrchestratorBrief(a: SetupAnswers): string {
  return renderBriefForProject(buildProject(a));
}

/**
 * Writes `POLICY.md` + composed `ORCHESTRATOR.md`, and returns the composed path.
 *
 * Unconditional by design: the "do not clobber my edits" decision belongs to the
 * operator, is asked in the wizard, and arrives here as
 * `answers.writeOrchestratorBrief`. A second existence check in here would make
 * that dialog's answer un-actionable — an operator who says "yes, overwrite it"
 * must get an overwrite.
 */
export function writeOrchestratorBrief(a: SetupAnswers): string {
  const project = buildProject(a);
  const policyPath = policyPathForProject(project);
  const orchestratorPath = briefPathForProject(project);
  mkdirSync(dirname(orchestratorPath), { recursive: true });
  const policy = renderPolicyForProject(project);
  writeFileSync(policyPath, policy);
  writeFileSync(orchestratorPath, composeOrchestrator(renderFloorForProject(project), policy));
  return orchestratorPath;
}

/**
 * Recompose `ORCHESTRATOR.md` from the package floor + live `POLICY.md`.
 *
 * Returns false when POLICY.md is missing (caller should migrate or set up).
 */
export function refreshComposedBriefForProject(p: ProjectConfig): boolean {
  const policyPath = policyPathForProject(p);
  if (!existsSync(policyPath)) return false;
  const orchestratorPath = briefPathForProject(p);
  mkdirSync(dirname(orchestratorPath), { recursive: true });
  writeFileSync(
    orchestratorPath,
    composeOrchestrator(renderFloorForProject(p), readFileSync(policyPath, "utf8")),
  );
  return true;
}

/** @internal test helper — expose compose banner for assertions. */
export const BRIEF_COMPOSE_BANNER = COMPOSE_BANNER;

/** Backup-aware POLICY write used by migrate paths that already computed text. */
export function writePolicyFile(path: string, content: string): string | undefined {
  return writeWithBackup(path, content);
}

/**
 * What can be told about an omp-telegram install without opening a socket.
 *
 * A named contract rather than an inferred one: consumers depend on the shape
 * of the answer, not on the identity of the function that produced it.
 */
export interface TelegramPresence {
  /** An omp-telegram state directory exists at all. */
  available: boolean;
  stateDir: string;
  /** A bot token line is present. Never, under any circumstance, its value. */
  hasToken: boolean;
  /** Set only when exactly one chat is paired, so the wizard cannot offer to
   *  page a chat that belongs to somebody else. */
  pairedOwnerId?: string;
}

/**
 * Whether omp-telegram is installed beside us, and who it is paired with.
 *
 * Only ever reports the *presence* of a token, never its value — a wizard that
 * echoes a bot token into a plan summary has leaked it to the scrollback, the
 * terminal's history and any screen recording of the session.
 */
export function detectTelegram(): TelegramPresence {
  const override = process.env["OMP_TELEGRAM_STATE_DIR"]?.trim();
  const dir = override ? override : join(homedir(), ".omp", "agent", "telegram");

  const envPath = join(dir, ".env");
  const accessPath = join(dir, "access.json");
  const available = existsSync(envPath) || existsSync(accessPath);
  if (!available) return { available: false, stateDir: dir, hasToken: false };

  const result: TelegramPresence = {
    available: true,
    stateDir: dir,
    hasToken: hasTelegramToken(envPath),
  };

  const owner = pairedOwner(accessPath);
  if (owner !== undefined) result.pairedOwnerId = owner;
  return result;
}

/** True when `.env` carries a non-empty `TELEGRAM_BOT_TOKEN`. The value is
 *  compared against emptiness and then dropped on the floor. */
function hasTelegramToken(envPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?TELEGRAM_BOT_TOKEN\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = (match[1] ?? "").trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) return true;
  }
  return false;
}

/**
 * The paired owner id, but only when there is exactly one. Several entries
 * means the wizard cannot know which human owns escalations, and guessing
 * would route a tier-2 page to a stranger.
 */
function pairedOwner(accessPath: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(accessPath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  const allowFrom = (parsed as { allowFrom?: unknown } | null)?.allowFrom;
  if (!Array.isArray(allowFrom) || allowFrom.length !== 1) return undefined;
  const only = allowFrom[0] as unknown;
  if (typeof only === "string" && only.trim().length > 0) return only.trim();
  if (typeof only === "number" && Number.isFinite(only)) return String(only);
  return undefined;
}

/**
 * Everything that would change, as plain text, with no side effects at all.
 *
 * This is the consent screen. If it does not name a change, the operator did
 * not agree to it — so every mutating step the plugin can take afterwards is
 * listed here first, including the labels that would be created and the
 * transport a tier-2 page would take.
 */
export function summarisePlan(
  a: SetupAnswers,
  scopes: ScopeCheck,
  labels: LabelPlan[],
  tg: TelegramPresence,
): string {
  const project = buildProject(a);
  // Caps are shown against the shipped baseline: the summary describes what
  // these answers mean on their own, before any hand-edited global block.
  const effective = resolveCaps(project, DEFAULT_CAPS);
  const states = Object.values(a.stateLabels).join(", ");

  const lines: string[] = [];

  if (scopes.missing.length > 0) {
    lines.push(
      `!! MISSING TOKEN SCOPE: ${scopes.missing.join(", ")}`,
      scopes.login === undefined
        ? "   `gh` reported no authenticated account — run `gh auth login` first."
        : `   Signed in as ${scopes.login} with: ${scopes.scopes.join(", ") || "(no scopes reported)"}`,
      "   Without `repo` the daemon cannot label or close issues; without `project` it cannot move cards.",
      "   Fix with: gh auth refresh -s repo,project",
      "",
    );
  }

  lines.push(
    `project        ${a.projectName}`,
    `config         ${configPath()}`,
    `tracker        ${a.trackerRepo}`,
    `github user    ${scopes.login ?? "(not authenticated)"}`,
    `queue query    open issues in ${a.trackerRepo} labelled "${a.queueLabel}", minus anything already`,
    `               labelled ${states}, routed by one "${a.routingLabelPrefix}<repo>" label`,
    `worktrees      ${project.workspaceRoot}`,
    `mirrors        ${project.mirrorRoot}`,
    "",
  );

  const toCreate = labels.filter((l) => !l.exists);
  const present = labels.filter((l) => l.exists);
  lines.push(
    toCreate.length === 0
      ? `labels         all ${labels.length} already exist in ${a.trackerRepo} — nothing to create`
      : `labels         would CREATE ${toCreate.length} in ${a.trackerRepo}:`,
  );
  for (const l of toCreate) lines.push(`                 + ${l.name}  #${l.colour}  ${l.description}`);
  if (present.length > 0 && toCreate.length > 0) {
    lines.push(`               already present: ${present.map((l) => l.name).join(", ")}`);
  }

  lines.push("", `routing        "${a.routingLabelPrefix}<repo>" on an issue selects one of:`);
  if (a.targetRepos.length === 0) {
    lines.push("                 (none — nothing can be routed, setup will refuse this)");
  }
  for (const r of a.targetRepos) {
    lines.push(`                 ${a.routingLabelPrefix}${r.name}  ${r.cloneUrl}  (${r.defaultBranch})`);
    for (const g of r.gates) lines.push(`                   gate: ${g.cmd}   [cwd ${g.cwd}]`);
    if (r.gates.length === 0) {
      lines.push("                   gate: none — nothing is verified before a push");
    }
  }

  // Absent entirely when unanswered: a plan for a project with no graph must
  // read exactly as it did before graphs were a thing this wizard could offer.
  const graphed = graphRepos(project);
  if (graphed.length > 0) {
    lines.push("", "code graph     workers query these clones instead of grepping:");
    for (const r of graphed) lines.push(`                 ${r.name}  ${r.graphProject}`);
    lines.push(
      "               conductor's own index-only clones — nothing human edits them, and",
      "               nothing here creates them. Run `omp-conductor graph-setup` after",
      "               setup: it prints the clone, index and systemd-timer commands.",
    );
  }

  lines.push("", "caps (effective)");
  for (const [key, value] of Object.entries(effective)) {
    const answered = Object.hasOwn(project.caps, key) ? "  (answered)" : "";
    lines.push(`  ${key.padEnd(22)}${String(value)}${answered}`);
  }
  if (a.workerModel !== undefined && a.workerModel.trim().length > 0) {
    lines.push(`  ${"worker model".padEnd(22)}${a.workerModel.trim()}  (answered)`);
  }

  lines.push("", "escalation");
  if (a.telegramChatId !== undefined && a.telegramChatId.trim().length > 0) {
    lines.push(
      `  tier 2         Telegram chat ${a.telegramChatId.trim()}` +
        (tg.hasToken ? "" : "  — WARNING: no bot token found, this will not send"),
      `  via            omp-telegram at ${tg.stateDir}`,
    );
  } else {
    lines.push(
      "  tier 2         issue comment only",
      tg.available && tg.hasToken
        ? `  note           omp-telegram is installed at ${tg.stateDir} but no chat was chosen`
        : `  note           no omp-telegram install found at ${tg.stateDir}`,
    );
  }
  lines.push(`  fallback       ${a.fallbackToIssueComment ? "comment on the issue as well" : "disabled"}`);
  lines.push(
    `  triage         ${
      a.orchestratorMode === "external"
        ? "external — the daemon starts no session; an operator's own drains tier 1 off the tracker"
        : "embedded — the daemon runs its own orchestrator session"
    }`,
  );

  const delegated = a.authority.merge === "orchestrator" || a.authority.release === "orchestrator";
  lines.push(
    "",
    `authority      merge=${a.authority.merge}  release=${a.authority.release}`,
    delegated
      ? "               the brief tells that session so, and it must spell the procedure out before acting"
      : "               humans do both; workers and the conductor stop at a green PR",
  );

  const chosen = REPORT_SCOPE_CHOICES.find((c) => c.scope === a.reportScope);
  const briefPath = orchestratorBriefPath(a);
  lines.push(
    "",
    "reporting",
    `  scope          ${a.reportScope} — ${chosen?.description ?? "unknown scope"}`,
  );
  if (a.writeOrchestratorBrief) {
    const policyPath = briefPath.replace(/ORCHESTRATOR\.md$/, "POLICY.md");
    lines.push(
      existsSync(briefPath) || existsSync(policyPath)
        ? `  brief          would OVERWRITE ${briefPath} + POLICY.md`
        : `  brief          would write ${briefPath} + POLICY.md`,
      "                 POLICY.md is yours — Releases/Reporting/Amendments; floor recomposes each tick",
    );
  } else {
    lines.push(
      existsSync(briefPath)
        ? `  brief          not written — ${briefPath} is left exactly as it is`
        : `  brief          not written — no orchestrator brief at ${briefPath}`,
      "                 the package still stops at green PRs; releases stay a human action",
    );
  }

  return lines.join("\n");
}

/**
 * Gates as the wizard both shows and reads them back: `cmd`, or `cmd @ cwd` when
 * one runs from a subdirectory. One spelling, so the pre-filled prompt line and
 * the amend menu's current value cannot drift apart.
 */
export function formatGates(gates: readonly { cmd: string; cwd: string }[]): string {
  return gates.map((g) => (g.cwd === "." ? g.cmd : `${g.cmd} @ ${g.cwd}`)).join(", ");
}

/**
 * The wizard's questions, grouped as the areas a re-run can amend one of, in the
 * order the full interview asks them.
 *
 * Data rather than a switch so the menu, the exhaustiveness of the dialog table
 * in ./plugin.ts, and the amend summary all enumerate the same eight areas: an
 * added area fails to compile until it has a name, a current value and a set of
 * questions.
 */
export const AMEND_AREA_IDS = [
  "tracker",
  "gates",
  "caps",
  "graph",
  "authority",
  "escalation",
  "reporting",
  "brief",
] as const;

export type AmendAreaId = (typeof AMEND_AREA_IDS)[number];

/**
 * The pure half of amend mode: what each area is called, what choosing it asks,
 * and what it says right now.
 *
 * `describe` is the reason the pick-list is worth anything — an operator picking
 * blind from eight nouns cannot tell which one holds the setting they came to
 * change, so every row carries its own current value. It reads only the config,
 * so the whole menu can be rendered and reviewed without a terminal.
 */
export const AMEND_AREAS: {
  readonly [K in AmendAreaId]: {
    readonly name: string;
    readonly asks: string;
    readonly describe: (p: ProjectConfig) => string;
  };
} = {
  tracker: {
    name: "tracker & repos",
    asks: "tracker repo, queue and state labels, routing prefix, then every routed repo with its gates",
    describe: (p) => {
      const names = Object.values(p.routing.repos).map((r) => r.name);
      return (
        `${p.tracker.repo}, queue "${p.queueLabel}", ` +
        `"${p.routing.labelPrefix}" → ${names.join(", ") || "no repos"}`
      );
    },
  },
  gates: {
    name: "gates",
    asks: "the pre-push commands for each configured repo, and nothing else",
    describe: (p) => {
      const repos = Object.values(p.routing.repos);
      if (repos.length === 0) return "no repos configured";
      return repos.map((r) => `${r.name}: ${r.gates.length === 0 ? "none" : formatGates(r.gates)}`).join("; ");
    },
  },
  caps: {
    // The model rides with the caps because it is the other per-worker knob, and
    // an area no menu offers is a setting only a full re-interview can reach.
    name: "caps & worker model",
    asks: "concurrency, spend, turns, wall clock, attempts per issue — then the worker model",
    describe: (p) => {
      const c = resolveCaps(p, DEFAULT_CAPS);
      const answered = Object.keys(p.caps).length > 0;
      const spend =
        c.dailySpendUsd === null ? "no spend cap" : `$${c.dailySpendUsd}/day`;
      return (
        `${c.maxConcurrentWorkers} workers, ${c.workerMaxTurns} turns, ` +
        `${Math.round(c.workerWallClockMs / 60000)}m, ${spend}, ` +
        `${c.maxAttemptsPerIssue} attempts${answered ? "" : " (all defaults)"} — ` +
        `${p.workerModel === undefined ? "harness default model" : `model ${p.workerModel}`}`
      );
    },
  },
  graph: {
    name: "code graph",
    asks: "whether workers query a code-graph index, and the root its one-clone-per-repo lives under",
    describe: (p) => {
      const graphed = graphRepos(p);
      const first = graphed[0];
      if (first === undefined) return "not configured — workers grep";
      return `${dirname(first.graphProject)} — ${graphed.length} clone(s): ${graphed.map((r) => r.name).join(", ")}`;
    },
  },
  authority: {
    name: "authority",
    asks: "who lands green PRs, and who cuts releases",
    describe: (p) => `merge=${p.authority.merge}, release=${p.authority.release}`,
  },
  escalation: {
    name: "escalation & triage",
    asks: "the tier-2 Telegram chat, whether escalations also comment, and where the orchestrator session lives",
    describe: (p) =>
      [
        p.escalation.telegramChatId === undefined
          ? "tier 2 by issue comment only"
          : `tier 2 pages Telegram ${p.escalation.telegramChatId}`,
        p.escalation.fallbackToIssueComment ? "comments too" : "no comment fallback",
        `triage ${p.escalation.orchestrator}`,
      ].join(", "),
  },
  reporting: {
    name: "reporting scope",
    asks: "how much the orchestrator says unprompted",
    describe: (p) => {
      const scope = p.reporting?.scope ?? DEFAULT_REPORT_SCOPE;
      const choice = REPORT_SCOPE_CHOICES.find((c) => c.scope === scope);
      return `${scope} — ${choice?.description ?? "unknown scope"}`;
    },
  },
  brief: {
    name: "orchestrator brief",
    asks: `whether to write ${ORCHESTRATOR_BRIEF_NAME} + ${POLICY_BRIEF_NAME} — the one area that writes no config key`,
    describe: (p) => {
      const path = briefPathForProject(p);
      return existsSync(path) ? `written at ${path}` : `none at ${path}`;
    },
  },
};

/**
 * How much of a current value fits on a menu row before it costs more than it
 * tells. Chosen so a four-repo fleet's tracker row — the longest one worth
 * keeping whole — survives intact. The full text is never lost either way: the
 * amend summary prints it unelided, and the area's own prompts pre-fill from it.
 */
const AMEND_LABEL_MAX = 96;

/**
 * The amend pick-list, rendered.
 *
 * The label carries the current value because the harness's select resolves to
 * the label it showed, so the row an operator picked has to be recognisable from
 * its own text alone — and it is the value, not the noun, that tells them
 * whether this is the row they came for.
 */
export function amendChoices(p: ProjectConfig): { id: AmendAreaId; label: string; description: string }[] {
  return AMEND_AREA_IDS.map((id) => {
    const area = AMEND_AREAS[id];
    const current = area.describe(p);
    return {
      id,
      label: `${area.name} — ${current.length > AMEND_LABEL_MAX ? `${current.slice(0, AMEND_LABEL_MAX - 1).trimEnd()}…` : current}`,
      description: area.asks,
    };
  });
}

/**
 * What an amend leads its consent screen with: the area, what it said, what it
 * would say, and the seven areas nobody was asked about.
 *
 * The whole plan still follows this, because the confirm has to name every
 * mutation it authorises — creating labels, writing the config, replacing a
 * brief — and a delta alone names none of them. What this adds is the sentence
 * the operator is actually looking for: one area changed, everything else came
 * back off disk.
 */
export function summariseAmend(area: AmendAreaId, before: ProjectConfig, a: SetupAnswers): string {
  const it = AMEND_AREAS[area];
  const was = it.describe(before);
  // The brief is a decision, not a config key, so its "after" is what the wizard
  // is about to do rather than what a rebuilt project would say.
  const now =
    area === "brief"
      ? a.writeOrchestratorBrief
        ? `would ${existsSync(orchestratorBriefPath(a)) ? "OVERWRITE" : "write"} ${orchestratorBriefPath(a)}`
        : "not written — left exactly as it is"
      : it.describe(buildProject(a));

  const others = AMEND_AREA_IDS.filter((o) => o !== area).map((o) => AMEND_AREAS[o].name);
  const lines = [`amending       ${it.name}  —  project ${before.name}`];
  if (was === now) {
    lines.push(`  no change      ${was}`, "                 you answered through without changing anything here");
  } else {
    lines.push(`  was            ${was}`, `  now            ${now}`);
  }
  lines.push(
    `  carried over   ${others.join(", ")}`,
    `                 read back from ${configPath()} and rewritten unchanged`,
    "",
    "The whole project as it would then be written:",
    "",
  );
  return lines.join("\n");
}
