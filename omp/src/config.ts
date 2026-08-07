/**
 * On-disk configuration for omp-conductor.
 *
 * The dispatcher runs unattended, so a malformed config must fail loudly at
 * load time rather than surface hours later as `undefined.inProgress` inside a
 * worker. `loadConfig` therefore validates and normalises in one pass and
 * reports *every* problem it found, because fixing a hand-written config one
 * error per run is miserable.
 *
 * The whole config tree lives under `$OMP_CONDUCTOR_HOME` (default
 * `~/.omp/conductor`), read on every call so a test — or a second fleet on the
 * same machine — can redirect it without reloading the module.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  AUTHORITY_HOLDERS,
  CONFIG_VERSION,
  DEFAULT_AUTHORITY,
  DEFAULT_CAPS,
  DEFAULT_REPORT_SCOPE,
  ORCHESTRATOR_MODES,
  READABLE_CONFIG_VERSIONS,
  REPORT_SCOPES,
  type Caps,
  type ConductorConfig,
  type ProjectConfig,
  type ReportScope,
  type RepoTarget,
} from "./types.ts";

/**
 * A JSON node whose fields are all still unproven. Reading a field off a
 * non-object (string, number, null) yields `undefined` at runtime, so every
 * field read below is safe and the `typeof` checks on the values do the real
 * validating — no structural guard needed.
 *
 * ponytail: this is hand-rolled validation, not a schema. It stays honest only
 * because `ConductorConfig` is small; the upgrade path when it grows is to
 * parse with zod/valibot at this one boundary and delete `validate` below.
 */
type Raw = { readonly [key: string]: unknown };

/** Derived from the data so a new `Caps` field cannot be silently ignored. */
const CAP_KEYS = Object.keys(DEFAULT_CAPS) as (keyof Caps)[];

/** Quoted for error messages, from the same data the guards below read. */
const REPORT_SCOPE_LIST = quoteList(REPORT_SCOPES);
const AUTHORITY_HOLDER_LIST = quoteList(AUTHORITY_HOLDERS);
const ORCHESTRATOR_MODE_LIST = quoteList(ORCHESTRATOR_MODES);

/** `owner/repo`, the only tracker spelling `gh` accepts without a host. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Used when a project omits `stateLabels`. Namespaced so a human scanning the
 * tracker can tell dispatcher-written labels from their own.
 */
const DEFAULT_STATE_LABELS: ProjectConfig["stateLabels"] = {
  inProgress: "agent:in-progress",
  blocked: "agent:blocked",
  failed: "agent:failed",
};

/**
 * Default routing prefix. Namespaced rather than empty: a bare `api` label
 * would collide with ordinary topic labels and route work by accident.
 */
const DEFAULT_LABEL_PREFIX = "repo:";

/** Absolute path of the config file, honouring `$OMP_CONDUCTOR_HOME`. */
export function configPath(): string {
  const override = process.env["OMP_CONDUCTOR_HOME"];
  const home = override !== undefined && override.length > 0 ? override : join(homedir(), ".omp", "conductor");
  return join(home, "config.json");
}

/** Directory holding the config, the sqlite store, and the pause sentinel. */
export function stateDir(): string {
  return dirname(configPath());
}

/**
 * Reads, validates and normalises the config. Throws an `Error` naming the
 * path and the fix; never returns a partially-shaped `ConductorConfig`.
 */
export function loadConfig(): ConductorConfig {
  const path = configPath();

  if (!existsSync(path)) {
    throw new Error(`No conductor config at ${path} — run /conductor setup to create one.`);
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read conductor config at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(
      `Conductor config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return validate(parsed, path);
}

/**
 * Persists the config atomically: a temp file in the same directory, then
 * `rename`, so a crash mid-write leaves the previous config intact instead of
 * a truncated one. Mode 0600 because a config carries chat ids and clone URLs.
 */
export function saveConfig(c: ConductorConfig): void {
  const dir = stateDir();
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask; chmod only what we just created so an
  // existing directory keeps whatever the user chose for it.
  if (created !== undefined) chmodSync(dir, 0o700);

  const target = configPath();
  const tmp = join(dir, `.config.json.${process.pid.toString(36)}.${Date.now().toString(36)}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  chmodSync(target, 0o600);
}

/**
 * Layers a project's overrides on the global defaults, field by field, so a
 * project that pins one cap still inherits the other five. `??` not `||`: a
 * deliberate `dailySpendUsd: 0` is a hard stop, not "unset", and `null` is a
 * deliberate "no spend gate" that must not fall through to the default.
 * Spelled out per field so adding a `Caps` member fails to compile here.
 */
export function resolveCaps(p: ProjectConfig, defaults: Caps): Caps {
  const o: Partial<Caps> = p.caps ?? {};
  return {
    maxConcurrentWorkers: o.maxConcurrentWorkers ?? defaults.maxConcurrentWorkers,
    // nullish only — `null` means off; do not coalesce it to the default.
    dailySpendUsd: o.dailySpendUsd !== undefined ? o.dailySpendUsd : defaults.dailySpendUsd,
    workerMaxTurns: o.workerMaxTurns ?? defaults.workerMaxTurns,
    workerWallClockMs: o.workerWallClockMs ?? defaults.workerWallClockMs,
    maxAttemptsPerIssue: o.maxAttemptsPerIssue ?? defaults.maxAttemptsPerIssue,
  };
}

/**
 * Resolves a project by name, or the only project when the name is omitted.
 * Refuses to guess between several: picking one silently would spend the wrong
 * project's budget.
 */
export function findProject(c: ConductorConfig, name?: string): ProjectConfig {
  const names = c.projects.map((p) => p.name);

  if (name === undefined) {
    const only = c.projects[0];
    if (c.projects.length !== 1 || only === undefined) {
      throw new Error(
        `Ambiguous project: config has ${c.projects.length} projects (${names.join(", ") || "none"}) — name one explicitly.`,
      );
    }
    return only;
  }

  const hit = c.projects.find((p) => p.name === name);
  if (hit === undefined) {
    throw new Error(`Unknown project "${name}" — configured projects: ${names.join(", ") || "none"}.`);
  }
  return hit;
}

// ---------------------------------------------------------------------------
// validation / normalisation
// ---------------------------------------------------------------------------

function validate(parsed: unknown, path: string): ConductorConfig {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Conductor config at ${path} must be a JSON object — run /conductor setup to recreate it.`);
  }
  const root = parsed as Raw;
  const problems: string[] = [];

  const version = root["version"];
  // A v1 file predates the retirement of a cap key, so its caps are read
  // leniently and the result is normalised up to v2. Any other version is a
  // config this build cannot honestly claim to understand.
  const legacyCaps = version === 1;
  if (!READABLE_CONFIG_VERSIONS.some((v) => v === version)) {
    problems.push(
      `"version" must be ${READABLE_CONFIG_VERSIONS.join(" or ")}, found ${JSON.stringify(version)} — this config was written by a different conductor`,
    );
  }

  const defaults: Caps = {
    ...DEFAULT_CAPS,
    ...coerceCaps(root["defaults"], `"defaults"`, problems, legacyCaps),
  };

  const rawProjects = root["projects"];
  const projects: ProjectConfig[] = [];
  if (!Array.isArray(rawProjects) || rawProjects.length === 0) {
    problems.push(`"projects" must be a non-empty array — the dispatcher has nothing to service otherwise`);
  } else {
    rawProjects.forEach((p: unknown, i) => {
      const project = normalizeProject(p, i, problems, legacyCaps);
      if (project !== undefined) projects.push(project);
    });
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid conductor config at ${path}:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
        `Fix the file or run /conductor setup.`,
    );
  }

  // Always v2 out: a loaded v1 config is migrated in memory, and the next
  // `saveConfig` is what persists the migration. `loadConfig` stays read-only.
  return { version: CONFIG_VERSION, defaults, projects };
}

/** Returns `undefined` when the project was too broken to shape; problems are appended. */
function normalizeProject(
  parsed: unknown,
  index: number,
  problems: string[],
  legacyCaps: boolean,
): ProjectConfig | undefined {
  const at = `projects[${index}]`;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    problems.push(`${at} must be an object`);
    return undefined;
  }
  const raw = parsed as Raw;
  const before = problems.length;

  const rawName = raw["name"];
  let name = "";
  if (nonEmptyString(rawName)) name = rawName;
  else problems.push(`${at}.name must be a non-empty string`);
  const label = name === "" ? at : `project "${name}"`;

  const tracker = raw["tracker"] as Raw | undefined;
  const rawRepo = tracker?.["repo"];
  let trackerRepo = "";
  if (nonEmptyString(rawRepo) && REPO_RE.test(rawRepo)) trackerRepo = rawRepo;
  else problems.push(`${label}: tracker.repo must look like "owner/repo", found ${JSON.stringify(rawRepo)}`);
  const rawKind = tracker?.["kind"];
  if (rawKind !== undefined && rawKind !== "github") {
    problems.push(`${label}: tracker.kind must be "github", found ${JSON.stringify(rawKind)}`);
  }

  const rawQueueLabel = raw["queueLabel"];
  let queueLabel = "";
  if (nonEmptyString(rawQueueLabel)) queueLabel = rawQueueLabel;
  else problems.push(`${label}: queueLabel must be a non-empty string — it is the human sign-off gate`);

  const routing = raw["routing"] as Raw | undefined;
  const rawPrefix = routing?.["labelPrefix"];
  const labelPrefix = typeof rawPrefix === "string" ? rawPrefix : DEFAULT_LABEL_PREFIX;
  const repos = normalizeRepos(routing?.["repos"], label, problems);

  const stateLabels = raw["stateLabels"] as Raw | undefined;

  const escalation = normalizeEscalation(raw["escalation"], label, problems);
  const authority = normalizeAuthority(raw["authority"], label, problems);

  const caps = coerceCaps(raw["caps"], `${label}: caps`, problems, legacyCaps);
  const reporting = normalizeReporting(raw["reporting"], label, problems);
  // A hint passed to the harness, not a budget guard: an unusable value is
  // dropped rather than reported, and the session's own model-fallback notice
  // (logged by `runWorker`) is what tells the operator the pattern missed.
  const rawWorkerModel = raw["workerModel"];
  const workerModel = nonEmptyString(rawWorkerModel) ? rawWorkerModel : undefined;

  if (problems.length > before) return undefined;

  return {
    name,
    tracker: { kind: "github", repo: trackerRepo },
    queueLabel,
    stateLabels: {
      inProgress: pickString(stateLabels?.["inProgress"], DEFAULT_STATE_LABELS.inProgress),
      blocked: pickString(stateLabels?.["blocked"], DEFAULT_STATE_LABELS.blocked),
      failed: pickString(stateLabels?.["failed"], DEFAULT_STATE_LABELS.failed),
    },
    routing: { labelPrefix, repos },
    caps,
    ...(workerModel === undefined ? {} : { workerModel }),
    escalation,
    authority,
    reporting,
    workspaceRoot: expandHome(pickString(raw["workspaceRoot"], join(stateDir(), "worktrees"))),
    mirrorRoot: expandHome(pickString(raw["mirrorRoot"], join(stateDir(), "mirrors"))),
  };
}

/**
 * Reporting scope decides whether the orchestrator speaks up or stays quiet, so
 * a typo is rejected rather than folded to the default: a misspelt `"materal"`
 * that silently resolved to `"material"` would read as configured on the day the
 * operator meant to turn the volume down, and the config would keep lying.
 */
function normalizeReporting(parsed: unknown, label: string, problems: string[]): ProjectConfig["reporting"] {
  if (parsed === undefined) return { scope: DEFAULT_REPORT_SCOPE };
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    problems.push(`${label}: reporting must be an object with a "scope" of ${REPORT_SCOPE_LIST}`);
    return { scope: DEFAULT_REPORT_SCOPE };
  }
  const raw = parsed as Raw;

  const unknownKeys = Object.keys(raw).filter((k) => k !== "scope");
  if (unknownKeys.length > 0) {
    // Stricter than caps, which tolerate a retired key: `reporting` has exactly
    // one member, so an unrecognised key here is a typo every time, and the
    // block that ignores it looks configured either way.
    problems.push(`${label}: reporting has unknown key(s): ${unknownKeys.join(", ")}`);
  }

  return {
    scope: pickLiteral(
      raw["scope"],
      REPORT_SCOPES,
      DEFAULT_REPORT_SCOPE,
      `${label}: reporting.scope`,
      REPORT_SCOPE_LIST,
      problems,
    ),
  };
}

/**
 * Who triages escalations, and how they are delivered when nobody answers.
 *
 * `orchestrator` is validated rather than folded to the default for the reason
 * `reporting.scope` is: a misspelt `"externl"` that quietly resolved to
 * `"embedded"` would start a second brain beside the operator's own session,
 * and both of them would triage the same issue from different transcripts.
 */
function normalizeEscalation(parsed: unknown, label: string, problems: string[]): ProjectConfig["escalation"] {
  let raw: Raw = {};
  if (parsed !== undefined) {
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) raw = parsed as Raw;
    else problems.push(`${label}: escalation must be an object`);
  }

  const escalation: ProjectConfig["escalation"] = {
    // Absent means "yes, still tell me": a silently stuck run is the worst case.
    fallbackToIssueComment: raw["fallbackToIssueComment"] !== false,
    orchestrator: pickLiteral(
      raw["orchestrator"],
      ORCHESTRATOR_MODES,
      "embedded",
      `${label}: escalation.orchestrator`,
      ORCHESTRATOR_MODE_LIST,
      problems,
    ),
  };
  const chatId = raw["telegramChatId"];
  if (nonEmptyString(chatId)) escalation.telegramChatId = chatId;
  return escalation;
}

/**
 * Who lands PRs and who cuts releases. Both default to the human: this is the
 * one config value that decides whether an unattended session may write to a
 * main branch, so it is granted explicitly or not at all.
 *
 * Unknown keys are rejected outright, as in `reporting` and for the same
 * reason: the object has exactly two members, so an unrecognised one is a typo
 * every time — and a `authority: { merges: "orchestrator" }` that loaded
 * cleanly would read as delegated while the orchestrator was still told to keep
 * its hands off.
 */
function normalizeAuthority(parsed: unknown, label: string, problems: string[]): ProjectConfig["authority"] {
  if (parsed === undefined) return { ...DEFAULT_AUTHORITY };
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    problems.push(`${label}: authority must be an object with "merge" and "release" of ${AUTHORITY_HOLDER_LIST}`);
    return { ...DEFAULT_AUTHORITY };
  }
  const raw = parsed as Raw;

  const unknownKeys = Object.keys(raw).filter((k) => k !== "merge" && k !== "release");
  if (unknownKeys.length > 0) {
    problems.push(`${label}: authority has unknown key(s): ${unknownKeys.join(", ")}`);
  }

  return {
    merge: pickLiteral(
      raw["merge"],
      AUTHORITY_HOLDERS,
      DEFAULT_AUTHORITY.merge,
      `${label}: authority.merge`,
      AUTHORITY_HOLDER_LIST,
      problems,
    ),
    release: pickLiteral(
      raw["release"],
      AUTHORITY_HOLDERS,
      DEFAULT_AUTHORITY.release,
      `${label}: authority.release`,
      AUTHORITY_HOLDER_LIST,
      problems,
    ),
  };
}

function normalizeRepos(parsed: unknown, label: string, problems: string[]): Record<string, RepoTarget> {
  const repos: Record<string, RepoTarget> = {};

  const raw = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Raw) : undefined;
  const entries = raw === undefined ? [] : Object.entries(raw);
  if (entries.length === 0) {
    problems.push(`${label}: routing.repos needs at least one repo entry, or no issue can be routed`);
    return repos;
  }

  for (const [key, entry] of entries) {
    const value = entry as Raw | undefined;
    const cloneUrl = value?.["cloneUrl"];
    if (!nonEmptyString(cloneUrl)) {
      problems.push(`${label}: routing.repos.${key}.cloneUrl must be a non-empty string`);
      continue;
    }
    const target: RepoTarget = {
      name: pickString(value?.["name"], key),
      cloneUrl,
      defaultBranch: pickString(value?.["defaultBranch"], "main"),
      gates: normalizeGates(value?.["gates"], `${label}: routing.repos.${key}`, problems),
    };
    const graph = normalizeGraphProject(value?.["graphProject"], `${label}: routing.repos.${key}`, problems);
    if (graph !== undefined) target.graphProject = graph;
    repos[key] = target;
  }

  return repos;
}

/**
 * The path of the index-only clone whose code graph this repo's workers query,
 * or `undefined` when the repo has none.
 *
 * A relative path is rejected rather than resolved, and that rejection is the
 * whole reason this is validated here: the value is written in one process and
 * *used* in another, by a session whose cwd is its own throwaway worktree. So
 * `../graph/api` would name a different directory for every reader, and none of
 * them the one that was indexed. There is no cwd this file could honestly
 * resolve it against, so it says so rather than guessing.
 */
function normalizeGraphProject(parsed: unknown, label: string, problems: string[]): string | undefined {
  if (parsed === undefined) return undefined;
  if (!nonEmptyString(parsed)) {
    problems.push(`${label}.graphProject must be a non-empty absolute path, found ${JSON.stringify(parsed)}`);
    return undefined;
  }

  const path = expandHome(parsed.trim());
  if (isAbsolute(path)) return path;
  problems.push(
    `${label}.graphProject must be an absolute path — it is read by sessions whose cwd is their own ` +
      `worktree — found ${JSON.stringify(parsed)}`,
  );
  return undefined;
}

/**
 * Gates are the pre-push CI equivalent, so a malformed entry is an error, not
 * something to drop quietly: a skipped gate is exactly how a lint failure
 * reaches the runners unattended.
 */
function normalizeGates(parsed: unknown, label: string, problems: string[]): { cmd: string; cwd: string }[] {
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    problems.push(`${label}.gates must be an array of { cmd, cwd }`);
    return [];
  }

  const gates: { cmd: string; cwd: string }[] = [];
  parsed.forEach((entry: unknown, i) => {
    const gate = entry as Raw | undefined;
    const cmd = gate?.["cmd"];
    if (!nonEmptyString(cmd)) {
      problems.push(`${label}.gates[${i}] must be { cmd, cwd } with a non-empty cmd`);
      return;
    }
    gates.push({ cmd, cwd: pickString(gate?.["cwd"], ".") });
  });
  return gates;
}

/**
 * Keeps only well-formed numeric caps; a value of the wrong shape is always
 * reported, because a ceiling the daemon cannot read is worth stopping for.
 *
 * `legacy` decides what an *unrecognised* key means. In a v1 file it is a cap
 * this version retired, so it is dropped and the config still loads — refusing
 * would strand a fleet on upgrade. In a v2 file every key this build writes is
 * current, so an unknown one is a typo and is reported: otherwise a mistyped
 * `dailySpendUsd` reads as configured while the real ceiling is the default.
 */
function coerceCaps(parsed: unknown, label: string, problems: string[], legacy: boolean): Partial<Caps> {
  const out: Partial<Caps> = {};
  if (parsed === undefined) return out;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    problems.push(`${label} must be an object`);
    return out;
  }
  const raw = parsed as Raw;

  for (const key of CAP_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    // Spend is the only cap that may be null (= no gate). Every other ceiling
    // is a non-negative number; 0 remains a hard stop where it already was.
    if (key === "dailySpendUsd" && v === null) {
      out.dailySpendUsd = null;
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      problems.push(
        key === "dailySpendUsd"
          ? `${label}.${key} must be a non-negative finite number or null (no cap), found ${JSON.stringify(v)}`
          : `${label}.${key} must be a non-negative finite number, found ${JSON.stringify(v)}`,
      );
      continue;
    }
    out[key] = v;
  }

  if (!legacy) {
    const unknownKeys = Object.keys(raw).filter((k) => !(CAP_KEYS as string[]).includes(k));
    if (unknownKeys.length > 0) {
      problems.push(
        `${label} has unknown key(s): ${unknownKeys.join(", ")} — remove them, or drop "version" to 1 if they are caps an older conductor wrote`,
      );
    }
  }

  return out;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** One rule for "a usable string, else the documented default", used throughout. */
function pickString(v: unknown, fallback: string): string {
  return nonEmptyString(v) ? v : fallback;
}

/** Quoted alternatives for an error message, from the same data the guard reads. */
function quoteList(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(" or ");
}

/**
 * One rule for "a declared literal out of a closed set, else the documented
 * default", used by every such field here.
 *
 * Absent takes the default silently; a value outside the set is always
 * reported and never folded. Each of these sets decides something the operator
 * would otherwise believe they had configured — who merges, who triages, how
 * loud the fleet is — and a typo that resolves to the default reads exactly
 * like a deliberate choice in the file afterwards.
 */
function pickLiteral<T extends string>(
  v: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
  quoted: string,
  problems: string[],
): T {
  if (v === undefined) return fallback;
  const hit = allowed.find((a) => a === v);
  if (hit === undefined) {
    problems.push(`${field} must be ${quoted}, found ${JSON.stringify(v)}`);
    return fallback;
  }
  return hit;
}

/**
 * `~/x` in a hand-written config must not create a literal `~` directory.
 *
 * Exported because the wizard and `graph-setup` derive paths the operator may
 * have typed with a `~` in them, and one spelling of this rule in the package
 * is the only way a path shown in a plan matches the path a validator accepts.
 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
