import { existsSync } from "node:fs";
import { graphRepos, REINDEX_UNIT, resolvePrereqs, type GraphPrereqs } from "./graph.ts";
import type { ProjectConfig } from "./types.ts";

export const GRAPH_PROBE_TIMEOUT_MS = 1_000;
export const GRAPH_FRESHNESS_MS = 45 * 60_000;

type CheckState = "present" | "missing" | "unknown";

export interface CodeGraphRepoHealth {
  name: string;
  path: string;
  clone: CheckState;
  index: CheckState;
}

export type CodeGraphHealth =
  | { configured: false }
  | {
      configured: true;
      status: "healthy" | "degraded" | "unknown";
      checkedAt: string;
      prerequisites: {
        indexer: CheckState;
        mcpMount: CheckState;
      };
      repos: CodeGraphRepoHealth[];
      timer: {
        enabled: "enabled" | "disabled" | "unknown";
        active: "active" | "inactive" | "unknown";
      };
      refresh: {
        result: "success" | "failed" | "unknown";
        fresh: boolean | null;
        lastSuccessAt?: string;
        ageMs?: number;
      };
      reasons: string[];
    };

export type ReadOnlyCommandResult =
  | { kind: "completed"; exitCode: number; stdout: string }
  | { kind: "timeout" }
  | { kind: "unavailable" };

/** Immediate cache value while the first bounded host probe is in flight. */
export function pendingCodeGraph(project: ProjectConfig, now = Date.now()): CodeGraphHealth {
  const repos = graphRepos(project);
  if (repos.length === 0) return { configured: false };
  return {
    configured: true,
    status: "unknown",
    checkedAt: new Date(now).toISOString(),
    prerequisites: { indexer: "unknown", mcpMount: "unknown" },
    repos: repos.map((repo) => ({
      name: repo.name,
      path: repo.graphProject,
      clone: "unknown",
      index: "unknown",
    })),
    timer: { enabled: "unknown", active: "unknown" },
    refresh: { result: "unknown", fresh: null },
    reasons: ["graph health probe pending"],
  };
}

export interface CodeGraphProbeDeps {
  prereqs(): GraphPrereqs;
  exists(path: string): boolean;
  run(command: string, args: readonly string[]): Promise<ReadOnlyCommandResult>;
  now(): number;
}

async function runReadOnly(command: string, args: readonly string[]): Promise<ReadOnlyCommandResult> {
  try {
    const proc = Bun.spawn([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, GRAPH_PROBE_TIMEOUT_MS);
    try {
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      if (timedOut) return { kind: "timeout" };
      return { kind: "completed", exitCode, stdout };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { kind: "unavailable" };
  }
}

const DEFAULT_DEPS: CodeGraphProbeDeps = {
  prereqs: resolvePrereqs,
  exists: existsSync,
  run: runReadOnly,
  now: Date.now,
};

function indexedRoots(raw: string): Set<string> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const projects = Reflect.get(value, "projects");
  if (!Array.isArray(projects)) return undefined;
  const roots = new Set<string>();
  for (const project of projects) {
    if (project === null || typeof project !== "object" || Array.isArray(project)) return undefined;
    const root = Reflect.get(project, "root_path");
    if (typeof root !== "string" || root.length === 0) return undefined;
    roots.add(root);
  }
  return roots;
}

function timerEnabled(result: ReadOnlyCommandResult): "enabled" | "disabled" | "unknown" {
  if (result.kind !== "completed") return "unknown";
  switch (result.stdout.trim()) {
    case "enabled":
    case "enabled-runtime":
      return "enabled";
    case "disabled":
    case "masked":
    case "masked-runtime":
    case "not-found":
    case "static":
      return "disabled";
    default:
      return "unknown";
  }
}

function timerActive(result: ReadOnlyCommandResult): "active" | "inactive" | "unknown" {
  if (result.kind !== "completed") return "unknown";
  switch (result.stdout.trim()) {
    case "active":
      return "active";
    case "inactive":
    case "failed":
    case "activating":
    case "deactivating":
      return "inactive";
    default:
      return "unknown";
  }
}

interface RefreshResult {
  health: Extract<CodeGraphHealth, { configured: true }>["refresh"];
  reason?: string;
  uncertain: boolean;
}

function refreshResult(result: ReadOnlyCommandResult, now: number): RefreshResult {
  const unknown = (reason: string, uncertain: boolean): RefreshResult => ({
    health: { result: "unknown", fresh: null },
    reason,
    uncertain,
  });
  if (result.kind === "timeout") return unknown("refresh service probe timed out", true);
  if (result.kind === "unavailable") return unknown("refresh service state unavailable", true);
  if (result.exitCode !== 0) return unknown("refresh service state unavailable", true);

  const fields = new Map<string, string>();
  for (const line of result.stdout.trim().split("\n")) {
    const equals = line.indexOf("=");
    if (equals < 1) return unknown("refresh service returned an unrecognized result", true);
    fields.set(line.slice(0, equals), line.slice(equals + 1));
  }
  const serviceResult = fields.get("Result");
  const exitStatus = fields.get("ExecMainStatus");
  const completedAt = fields.get("ExecMainExitTimestamp");
  if (serviceResult === undefined || exitStatus === undefined || completedAt === undefined) {
    return unknown("refresh service returned an unrecognized result", true);
  }
  if (serviceResult !== "success" || exitStatus !== "0") {
    return {
      health: { result: "failed", fresh: false },
      reason: `refresh service failed (${serviceResult || "no result"}, exit ${exitStatus || "unknown"})`,
      uncertain: false,
    };
  }
  if (completedAt === "" || completedAt === "n/a") {
    return unknown("no successful refresh has been recorded", false);
  }
  const completedMs = Date.parse(completedAt);
  const ageMs = now - completedMs;
  if (!Number.isFinite(completedMs) || ageMs < 0) {
    return unknown("refresh service returned an invalid completion time", true);
  }
  const lastSuccessAt = new Date(completedMs).toISOString();
  if (ageMs > GRAPH_FRESHNESS_MS) {
    return {
      health: { result: "success", fresh: false, lastSuccessAt, ageMs },
      reason: `last successful refresh is stale (${Math.round(ageMs / 60_000)}m old)`,
      uncertain: false,
    };
  }
  return {
    health: { result: "success", fresh: true, lastSuccessAt, ageMs },
    uncertain: false,
  };
}

/**
 * Read-only, bounded evidence for the optional code graph. Every child command
 * is a query; this module never clones, fetches, indexes, or changes systemd.
 */
export async function probeCodeGraph(
  project: ProjectConfig,
  deps: CodeGraphProbeDeps = DEFAULT_DEPS,
): Promise<CodeGraphHealth> {
  const configured = graphRepos(project);
  if (configured.length === 0) return { configured: false };

  const checkedAt = new Date(deps.now()).toISOString();
  const prereqs = deps.prereqs();
  const reasons: string[] = [];
  let uncertain = false;

  const indexer: CheckState = prereqs.indexer === null ? "missing" : "present";
  const mcpMount: CheckState = prereqs.mounted ? "present" : "missing";
  if (indexer === "missing") reasons.push("indexer is not present on PATH");
  if (mcpMount === "missing") reasons.push("worker MCP configuration does not mount the indexer");

  const [projectsResult, enabledResult, activeResult, serviceResult] = await Promise.all([
    prereqs.indexer === null
      ? Promise.resolve<ReadOnlyCommandResult>({ kind: "unavailable" })
      : deps.run(prereqs.indexer, ["cli", "list_projects", "{}"]),
    deps.run("systemctl", ["is-enabled", `${REINDEX_UNIT}.timer`]),
    deps.run("systemctl", ["is-active", `${REINDEX_UNIT}.timer`]),
    deps.run("systemctl", [
      "show",
      `${REINDEX_UNIT}.service`,
      "--property=Result",
      "--property=ExecMainStatus",
      "--property=ExecMainExitTimestamp",
    ]),
  ]);

  let roots: Set<string> | undefined;
  if (prereqs.indexer !== null) {
    if (projectsResult.kind === "completed" && projectsResult.exitCode === 0) {
      roots = indexedRoots(projectsResult.stdout);
      if (roots === undefined) {
        uncertain = true;
        reasons.push("indexer returned malformed project data");
      }
    } else {
      uncertain = true;
      reasons.push(projectsResult.kind === "timeout" ? "indexer project probe timed out" : "indexer project state unavailable");
    }
  }

  const repos: CodeGraphRepoHealth[] = configured.map((repo) => {
    const clone: CheckState = deps.exists(repo.graphProject) ? "present" : "missing";
    const index: CheckState = roots === undefined ? "unknown" : roots.has(repo.graphProject) ? "present" : "missing";
    if (clone === "missing") reasons.push(`${repo.name}: configured clone is missing`);
    if (index === "missing") reasons.push(`${repo.name}: no indexed project exactly matches ${repo.graphProject}`);
    return { name: repo.name, path: repo.graphProject, clone, index };
  });

  const enabled = timerEnabled(enabledResult);
  const active = timerActive(activeResult);
  if (enabled === "unknown" || active === "unknown") {
    uncertain = true;
    reasons.push("refresh timer state is unavailable or unrecognized");
  } else {
    if (enabled === "disabled") reasons.push("refresh timer is disabled");
    if (active === "inactive") reasons.push("refresh timer is inactive");
  }

  const refresh = refreshResult(serviceResult, deps.now());
  if (refresh.reason !== undefined) reasons.push(refresh.reason);
  uncertain ||= refresh.uncertain;

  return {
    configured: true,
    status: uncertain ? "unknown" : reasons.length === 0 ? "healthy" : "degraded",
    checkedAt,
    prerequisites: { indexer, mcpMount },
    repos,
    timer: { enabled, active },
    refresh: refresh.health,
    reasons,
  };
}
