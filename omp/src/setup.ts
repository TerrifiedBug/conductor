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
import { configPath, resolveCaps, stateDir } from "./config.ts";
import {
  CONFIG_VERSION,
  DEFAULT_CAPS,
  type Caps,
  type ConductorConfig,
  type ProjectConfig,
  type ReportScope,
  type RepoTarget,
} from "./types.ts";
import { renderBrief } from "./worker.ts";

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

/** The operator's own brief, rendered into the project's workspace root. */
export const ORCHESTRATOR_BRIEF_NAME = "ORCHESTRATOR.md";

/** Shipped in `files[]`, so this resolves in an installed package too. */
const ORCHESTRATOR_TEMPLATE_PATH = join(import.meta.dir, "briefs", "orchestrator.md");

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
 * without assembling a whole config and indexing back into its array.
 */
function buildProject(a: SetupAnswers): ProjectConfig {
  const dir = stateDir();

  const repos: Record<string, RepoTarget> = {};
  for (const r of a.targetRepos) {
    repos[r.name] = {
      name: r.name,
      cloneUrl: r.cloneUrl,
      defaultBranch: r.defaultBranch,
      gates: r.gates.map((g) => ({ cmd: g.cmd, cwd: g.cwd })),
    };
  }

  const escalation: ProjectConfig["escalation"] = { fallbackToIssueComment: a.fallbackToIssueComment };
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
 * Where the operator's own brief lands: beside the worktrees, under the state
 * directory, so it is on the same disk the fleet already owns and survives a
 * reinstall of the package. Derived from the answers rather than fixed, so a
 * project that ever gains a chosen workspace root keeps its brief with it.
 */
export function orchestratorBriefPath(a: SetupAnswers): string {
  return join(buildProject(a).workspaceRoot, ORCHESTRATOR_BRIEF_NAME);
}

/**
 * The shipped template with this project's real values in it.
 *
 * Only the coordinates and the chosen scope are substituted: the policy text is
 * left exactly as shipped, because from here on the file is the operator's to
 * edit and nothing in this package reads it back.
 */
export function renderOrchestratorBrief(a: SetupAnswers): string {
  return renderBrief(readFileSync(ORCHESTRATOR_TEMPLATE_PATH, "utf8"), {
    PROJECT: a.projectName,
    TRACKER_REPO: a.trackerRepo,
    QUEUE_LABEL: a.queueLabel,
    REPORT_SCOPE: a.reportScope,
  });
}

/**
 * Writes the rendered brief and returns where it went.
 *
 * Unconditional by design: the "do not clobber my edits" decision belongs to the
 * operator, is asked in the wizard, and arrives here as
 * `answers.writeOrchestratorBrief`. A second existence check in here would make
 * that dialog's answer un-actionable — an operator who says "yes, overwrite it"
 * must get an overwrite.
 */
export function writeOrchestratorBrief(a: SetupAnswers): string {
  const path = orchestratorBriefPath(a);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderOrchestratorBrief(a));
  return path;
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

  const chosen = REPORT_SCOPE_CHOICES.find((c) => c.scope === a.reportScope);
  const briefPath = orchestratorBriefPath(a);
  lines.push(
    "",
    "reporting",
    `  scope          ${a.reportScope} — ${chosen?.description ?? "unknown scope"}`,
  );
  if (a.writeOrchestratorBrief) {
    lines.push(
      existsSync(briefPath)
        ? `  brief          would OVERWRITE ${briefPath}`
        : `  brief          would write ${briefPath}`,
      "                 yours to edit afterwards — release policy lives there, not in this package",
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
