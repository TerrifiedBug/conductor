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
import { dirname, join } from "node:path";
import { DEFAULT_CAPS, type Caps, type ConductorConfig, type ProjectConfig, type RepoTarget } from "./types.ts";

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
 * Default routing prefix. Namespaced rather than empty: a bare `chad` label
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
 * deliberate `dailySpendUsd: 0` is a hard stop, not "unset". Spelled out per
 * field so adding a `Caps` member fails to compile here instead of resolving
 * to `undefined` at a call site.
 */
export function resolveCaps(p: ProjectConfig, defaults: Caps): Caps {
  const o: Partial<Caps> = p.caps ?? {};
  return {
    maxConcurrentWorkers: o.maxConcurrentWorkers ?? defaults.maxConcurrentWorkers,
    maxIssuesPerDay: o.maxIssuesPerDay ?? defaults.maxIssuesPerDay,
    dailySpendUsd: o.dailySpendUsd ?? defaults.dailySpendUsd,
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
  if (version !== 1) {
    problems.push(
      `"version" must be 1, found ${JSON.stringify(version)} — this config was written by a different conductor`,
    );
  }

  const defaults: Caps = { ...DEFAULT_CAPS, ...coerceCaps(root["defaults"], `"defaults"`, problems) };

  const rawProjects = root["projects"];
  const projects: ProjectConfig[] = [];
  if (!Array.isArray(rawProjects) || rawProjects.length === 0) {
    problems.push(`"projects" must be a non-empty array — the dispatcher has nothing to service otherwise`);
  } else {
    rawProjects.forEach((p: unknown, i) => {
      const project = normalizeProject(p, i, problems);
      if (project !== undefined) projects.push(project);
    });
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid conductor config at ${path}:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
        `Fix the file or run /conductor setup.`,
    );
  }

  return { version: 1, defaults, projects };
}

/** Returns `undefined` when the project was too broken to shape; problems are appended. */
function normalizeProject(parsed: unknown, index: number, problems: string[]): ProjectConfig | undefined {
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

  const escalationIn = raw["escalation"] as Raw | undefined;
  const chatId = escalationIn?.["telegramChatId"];
  const escalation: ProjectConfig["escalation"] = {
    // Absent means "yes, still tell me": a silently stuck run is the worst case.
    fallbackToIssueComment: escalationIn?.["fallbackToIssueComment"] !== false,
  };
  if (nonEmptyString(chatId)) escalation.telegramChatId = chatId;

  const caps = coerceCaps(raw["caps"], `${label}: caps`, problems);

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
    escalation,
    workspaceRoot: expandHome(pickString(raw["workspaceRoot"], join(stateDir(), "worktrees"))),
    mirrorRoot: expandHome(pickString(raw["mirrorRoot"], join(stateDir(), "mirrors"))),
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
    repos[key] = {
      name: pickString(value?.["name"], key),
      cloneUrl,
      defaultBranch: pickString(value?.["defaultBranch"], "main"),
      gates: normalizeGates(value?.["gates"], `${label}: routing.repos.${key}`, problems),
    };
  }

  return repos;
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

/** Keeps only well-formed numeric caps; anything else is reported, not coerced. */
function coerceCaps(parsed: unknown, label: string, problems: string[]): Partial<Caps> {
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
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      problems.push(`${label}.${key} must be a non-negative finite number, found ${JSON.stringify(v)}`);
      continue;
    }
    out[key] = v;
  }

  const unknownKeys = Object.keys(raw).filter((k) => !(CAP_KEYS as string[]).includes(k));
  if (unknownKeys.length > 0) {
    // Loud, because a typo'd cap key otherwise reads as "budget enforced" while
    // the real ceiling is still the default.
    problems.push(`${label} has unknown key(s): ${unknownKeys.join(", ")}`);
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

/** `~/x` in a hand-written config must not create a literal `~` directory. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
