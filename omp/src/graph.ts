/**
 * Code-graph discovery: the indexes workers query instead of grepping, and the
 * commands that create and refresh them.
 *
 * Why this exists at all, measured on the dogfood fleet rather than assumed:
 * workers spend roughly four fifths of a 120-turn budget *finding* code — 30–62
 * `read` calls and 32–69 `bash` calls against 9–24 edits per run, 215–390k
 * characters of tool output. A code graph answers "who calls this" and "where is
 * this defined" in one call, which is the difference between a run that lands
 * and a run that dies mid-refactor with the work unfinished.
 *
 * Two hard boundaries hold everything here together:
 *
 * - **This package never builds or mutates an index, and never depends on the
 *   indexer for dispatch.** The optional health surface runs the indexer's
 *   read-only `list_projects` query; nothing spawns the graph server or imports
 *   it. `graph-setup` prints commands, and with `--write` writes two systemd
 *   units — it does not enable them, because a package that silently writes
 *   root-level state is not one you can trust with a fleet.
 * - **A worker never queries its own worktree.** An index is keyed by the
 *   realpath of the directory it was built from, with no git-worktree awareness,
 *   so a run's `worktrees/<issue>` path is always an empty project. Workers are
 *   pointed at {@link RepoTarget.graphProject} — a conductor-owned clone nothing
 *   human edits — and {@link graphHint} is the text that makes that unmissable.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { expandHome, stateDir } from "./config.ts";
import type { ProjectConfig, RepoTarget } from "./types.ts";

/**
 * The indexer's own CLI, invoked by name rather than by path so the generated
 * unit's explicit `PATH` is the single place a host's install location is
 * spelled out. `cli <tool> <json>` runs one tool without an MCP session.
 */
const INDEXER = "codebase-memory-mcp";

/** Both units and the script share this stem; `cbm` is the indexer's own prefix. */
export const REINDEX_UNIT = "cbm-reindex";

/** Where a system timer has to live to be enabled by `systemctl`. */
export const SYSTEMD_UNIT_DIR = "/etc/systemd/system";

/** Where the upstream indexer lives, for an operator who has to go install it. */
const INDEXER_SOURCE = "https://github.com/DeusData/codebase-memory-mcp";

/**
 * The two things that must be true of the *host* before any index is useful,
 * neither of which conductor installs: the indexer has to be on PATH, and the
 * agent has to mount it as an MCP server or worker sessions get no graph tools
 * at all. Indexing without the mount produces a perfectly good database that
 * nothing can read — the failure this preflight exists to make visible.
 */
export interface GraphPrereqs {
  /** Resolved indexer path, or null when nothing on PATH answers to the name. */
  indexer: string | null;
  /** The agent's MCP server config, whether or not it exists yet. */
  mcpConfig: string;
  /** Whether that config already mounts the indexer for sessions. */
  mounted: boolean;
}

/** Reads the host. Split from {@link formatGraphSetup} so the plan stays pure. */
export function resolvePrereqs(home: string = homedir()): GraphPrereqs {
  const onPath = (process.env["PATH"] ?? "")
    .split(":")
    .filter((d) => d !== "")
    .map((d) => join(d, INDEXER))
    .find((c) => existsSync(c));

  const mcpConfig = join(home, ".omp", "agent", "mcp.json");
  let mounted = false;
  try {
    // Any mention of the binary counts as mounted. Parsing the whole schema to
    // decide would make this preflight fail on configs it does not understand,
    // and a false "not mounted" costs an operator a confusing duplicate entry.
    const raw = JSON.parse(readFileSync(mcpConfig, "utf8")) as Record<string, unknown>;
    const servers = (raw["mcpServers"] ?? raw) as Record<string, unknown>;
    mounted = Object.keys(servers).some((k) => k.includes(INDEXER));
  } catch {
    // No file, or unreadable: not mounted, and the plan says how to add it.
  }
  return { indexer: onPath ?? null, mcpConfig, mounted };
}

/** The `mcp.json` entry a fresh host needs, using the resolved path when known. */
export function mcpEntry(prereqs: GraphPrereqs): string {
  const command = prereqs.indexer ?? `/usr/local/bin/${INDEXER}`;
  return JSON.stringify({ [INDEXER]: { type: "stdio", command } }, null, 2);
}

/**
 * Default parent of every index-only clone, under the cache directory because
 * that is exactly what these are: derived data, disposable, re-creatable from a
 * clone URL. Deliberately *not* `~/projects/<org>` — that is where a human's own
 * checkouts live, and pointing a reindexer at one either destroys their
 * uncommitted work or indexes whatever branch they left checked out.
 *
 * `trackerRepo` supplies the org so a fleet's clones land together, which is
 * also the answer for the common case where the tracker and the code share one
 * GitHub organisation.
 */
export function defaultGraphRoot(trackerRepo: string): string {
  const org = trackerRepo.split("/")[0] ?? trackerRepo;
  return join(homedir(), ".cache", "conductor-graph", org);
}

/** One repo's clone under a chosen root. `~` is expanded here so a path an
 *  operator typed matches the absolute path the validator accepts. */
export function graphProjectPath(root: string, repoName: string): string {
  return join(expandHome(root.trim()), repoName);
}

/** A repo that has a graph, narrowed so callers need no further guard. */
export type GraphRepo = RepoTarget & { graphProject: string };

/** The project's repos that have a graph configured, in config order. */
export function graphRepos(p: ProjectConfig): GraphRepo[] {
  return Object.values(p.routing.repos).filter((r): r is GraphRepo => r.graphProject !== undefined);
}

/**
 * The paragraph a worker's brief carries about its repo's graph, or `""` when
 * the repo has none — in which case the rendered brief is byte-for-byte the one
 * this package shipped before graphs existed.
 *
 * The leading newline and the three-space indent are load-bearing: the
 * placeholder sits immediately before the next numbered item in
 * `briefs/worker.md`, so an empty value leaves no blank line behind and a
 * non-empty one reads as a continuation of the item above it.
 *
 * Every sentence here is defending against one specific failure. A worker that
 * passes its own cwd gets an empty answer and concludes there is no graph. A
 * worker that trusts the graph as current edits against a snapshot that predates
 * its own branch. Both end the same way — a confident diff in the wrong place —
 * so the wording says the quiet part out loud rather than describing the tool.
 */
export function graphHint(repo: RepoTarget): string {
  const path = repo.graphProject;
  if (path === undefined) return "";

  return (
    "\n" +
    "   **This repo has a code graph, and it was not built from your worktree.**\n" +
    "   Call `list_projects` first, find the single entry whose `root_path` is\n" +
    "   exactly\n" +
    `   \`${path}\`\n` +
    "   and pass that entry's `name` as the `project` argument to every graph\n" +
    "   tool. Never pass a path, and never pass your own cwd: that clone is what\n" +
    "   was indexed, your worktree has no index and never will, so a cwd-based\n" +
    "   lookup answers nothing and you lose the run to grep.\n" +
    "\n" +
    "   Read what it tells you as a snapshot of that clone's default branch at\n" +
    "   the last reindex: it does not contain your edits, and it can be hours\n" +
    "   behind the branch you are on. So orient with the graph, then read the\n" +
    "   real file in your worktree before you change it. If those tools are not\n" +
    "   mounted in this session, say so in your report and fall back to grep.\n"
  );
}

/** Where the generated refresh script lands: conductor state, not a unit
 *  directory, because it is ours to regenerate and needs no root to write. */
export function reindexScriptPath(): string {
  return join(stateDir(), `${REINDEX_UNIT}.sh`);
}

/** Both unit files, from the one stem `systemctl enable` will be given. */
export function unitPaths(unitDir = SYSTEMD_UNIT_DIR): { service: string; timer: string } {
  return {
    service: join(unitDir, `${REINDEX_UNIT}.service`),
    timer: join(unitDir, `${REINDEX_UNIT}.timer`),
  };
}

/**
 * `git clone` for one repo's index-only clone.
 *
 * `--single-branch` so the working tree can only ever hold the branch the graph
 * claims to describe, and the destination is quoted because the root is
 * operator-typed and a space in it would otherwise clone into two directories.
 */
export function cloneCommand(r: GraphRepo): string {
  return `git clone --single-branch --branch ${r.defaultBranch} ${r.cloneUrl} "${r.graphProject}"`;
}

/** The one-shot index command, as a human would run it to seed a clone. */
export function indexCommand(r: GraphRepo): string {
  return `${INDEXER} cli index_repository '{"repo_path": "${r.graphProject}"}'`;
}

/**
 * The refresh-and-reindex script both the timer and a human run.
 *
 * It fails loudly on purpose, and that is the one thing about it worth
 * protecting. A first draft of this — hand-written on the live host — used
 * `git fetch … || true; git pull --ff-only || true`, which meant a fetch that
 * failed for a week still indexed the stale tree and still exited 0: a green
 * timer serving a month-old graph, and workers orienting against code that no
 * longer exists. So: `set -euo pipefail`, no swallowed failures anywhere, and
 * the first broken repo takes the whole run non-zero where `systemctl status`
 * and `systemctl is-failed` will report it.
 *
 * `git reset --hard origin/<defaultBranch>` rather than a merge or a pull is
 * safe *because* of what these clones are — conductor's own, never edited by a
 * human — and it is the only refresh with no failure mode of its own: no
 * conflict, no divergence, no detached state to recover from. Each repo's own
 * configured branch is used, because a fleet with a `master` repo in it would
 * otherwise silently index nothing.
 */
export function reindexScript(p: ProjectConfig): string {
  const lines = [
    "#!/usr/bin/env bash",
    `# Refresh and reindex the code graphs for omp-conductor project "${p.name}".`,
    "#",
    "# Generated by \`omp-conductor graph-setup\`. Regenerate it rather than editing:",
    "# the repo list, branches and paths all come from that project's config.json.",
    "#",
    "# Every clone below is conductor's own, index-only and never edited by a human,",
    "# which is what makes the hard reset safe. Do not point one at a checkout you",
    "# work in: the reset would destroy uncommitted work.",
    "#",
    "# Fails loud and stops at the first problem, deliberately. A refresh that",
    "# swallowed its errors would index a stale tree and still exit 0 — a green",
    "# timer serving a month-old graph is worse than no graph at all.",
    "set -euo pipefail",
    "",
  ];

  for (const r of graphRepos(p)) {
    lines.push(
      `# ${r.name} — ${r.cloneUrl} @ ${r.defaultBranch}`,
      `cd "${r.graphProject}"`,
      "git fetch --prune origin",
      `git reset --hard origin/${r.defaultBranch}`,
      indexCommand(r),
      "",
    );
  }

  return lines.join("\n");
}

/**
 * The service half. `Type=oneshot` with no `[Install]` section: it is started by
 * its timer, and a service enabled on its own would run once at boot and never
 * again, which looks exactly like a working install.
 */
export function reindexService(p: ProjectConfig, scriptPath = reindexScriptPath()): string {
  const home = homedir();
  const user = userInfo().username;
  return [
    "[Unit]",
    `Description=Reindex the code graphs omp-conductor project "${p.name}" hands its workers`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=/bin/bash ${scriptPath}`,
    "# Pinned to the account that generated this, and it has to be the account the",
    "# fleet runs as. A systemd service defaults to root, and root is wrong three",
    "# ways at once here: the indexer would write its store under /root/.cache",
    "# where no worker session ever looks, a private clone would fetch with root's",
    "# SSH credentials rather than the fleet's, and every path below points into a",
    "# different account's home. All three fail silently — the timer goes green",
    "# and the graph a worker queries is simply never the graph this built.",
    `User=${user}`,
    "# Both of these are spelled out because systemd supplies neither usefully.",
    `# The indexer resolves its store from HOME (${join(home, ".cache", "codebase-memory-mcp")}),`,
    "# so an unset HOME would build a second index nobody queries; and systemd's",
    "# default PATH has no ~/.local/bin, while the indexer itself shells out to git.",
    `Environment=HOME=${home}`,
    `Environment=PATH=${["/.local/bin", "/.bun/bin"].map((d) => join(home, d)).join(":")}` +
      ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "# Indexing is CPU- and IO-heavy, and this host is also running the fleet whose",
    "# workers read the result.",
    "Nice=10",
    "IOSchedulingClass=idle",
    "# A wedged index must fail rather than hold its timer open indefinitely.",
    "TimeoutStartSec=1h",
    "",
  ].join("\n");
}

/**
 * The timer half — and the reason there is a timer at all.
 *
 * The graph server's own auto-watch lives inside a connected MCP session and
 * dies with it, and v0.9.0 ships no daemon. An ephemeral worker session
 * therefore keeps nothing fresh: whatever it mounts, it un-mounts minutes later.
 * So the refresh has to come from outside the fleet entirely, on a schedule
 * nothing in a run can influence.
 */
export function reindexTimer(p: ProjectConfig): string {
  return [
    "[Unit]",
    `Description=Periodic code-graph reindex for omp-conductor project "${p.name}"`,
    "",
    "[Timer]",
    "# Twenty minutes, because the measured cost is small and the cost of",
    "# staleness is not: refreshing four repos takes ~40s of CPU, which at this",
    "# interval is roughly 3% of one core, and the service runs at Nice=10 with",
    "# idle IO so it yields to the fleet. A nightly refresh would be cheaper and",
    "# much worse — a fleet merging several PRs a day would spend most of its",
    "# dispatches querying a graph that predates the code the worker was sent to",
    "# change, which is the one way this feature actively misleads. Lengthen it",
    "# for quiet repos; the brief has workers verify against the real file",
    "# regardless, so staleness degrades the graph rather than making it lie.",
    "OnBootSec=3min",
    "OnUnitActiveSec=20min",
    "# Persistent catches a host that was down; the jitter keeps every install",
    "# of this unit off the same second.",
    "Persistent=true",
    "RandomizedDelaySec=2m",
    "AccuracySec=1min",
    `Unit=${REINDEX_UNIT}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

/**
 * The privileged tail, and the only part of this feature that needs root.
 *
 * Split out deliberately. Running the whole CLI under `sudo` looks convenient
 * and is wrong: `loadConfig`, `stateDir`, `homedir` and `userInfo` would all
 * resolve as root, so the config would be missed or the wrong one, the script
 * would land in root's state directory, and the generated unit would bake
 * root's HOME with no `User=` — indexes written where no worker reads them.
 * So generation runs unprivileged as the fleet user, and only the copy into
 * the unit directory is elevated.
 */
export function installCommands(unitDir = SYSTEMD_UNIT_DIR, from = stateDir()): string[] {
  const { service, timer } = unitPaths(from);
  return [
    `sudo install -m 0644 ${service} ${timer} ${unitDir}/`,
    `sudo systemctl daemon-reload && sudo systemctl enable --now ${REINDEX_UNIT}.timer`,
  ];
}

function block(title: string, body: string): string[] {
  return [`--- ${title} ---`, "", body.trimEnd(), ""];
}

/**
 * The whole plan as text, with nothing done. This is the default mode of
 * `graph-setup`, and it is a plan an operator can read, paste, or ignore —
 * including on a host where they are not root and `--write` would fail.
 */
export function formatGraphSetup(
  p: ProjectConfig,
  unitDir = SYSTEMD_UNIT_DIR,
  prereqs: GraphPrereqs = resolvePrereqs(),
): string {
  const repos = graphRepos(p);
  const missing = repos.filter((r) => !existsSync(r.graphProject));
  // Seeded with 0 so these are still widths when the caller ignored the exit-1
  // guard and asked for a plan for a project with no graph at all.
  const nameWidth = Math.max(0, ...repos.map((r) => r.name.length));
  const pathWidth = Math.max(0, ...repos.map((r) => r.graphProject.length));

  const lines = [
    `code-graph discovery for project "${p.name}"`,
    "",
    "Workers spend most of a run finding code rather than changing it. These",
    'indexes answer "who calls this" and "where is this defined" in one call, so',
    "the turns go into the work instead. Nothing below has been run.",
    "",
    `repos with a graph configured (${repos.length}):`,
  ];
  for (const r of repos) {
    // Padded so the (missing) markers line up: which clones do not exist yet is
    // the one thing an operator scans this list for.
    const marker = missing.includes(r) ? "  (missing)" : "";
    lines.push(`  ${r.name.padEnd(nameWidth)}  ${r.graphProject.padEnd(marker === "" ? 0 : pathWidth)}${marker}`);
  }

  // Before anything else, because both of these are host state conductor does
  // not own and neither failure is self-announcing: a missing binary surfaces
  // as command-not-found halfway down the plan, and a missing mount surfaces
  // as workers that never mention the graph and quietly grep instead.
  lines.push("", "0. host prerequisites", "");
  lines.push(
    prereqs.indexer === null
      ? `   [ ] ${INDEXER} is NOT on your PATH. Install it first — conductor never
       does, and never depends on it: ${INDEXER_SOURCE}`
      : `   [x] indexer: ${prereqs.indexer}`,
  );
  if (prereqs.mounted) {
    lines.push(`   [x] mounted for sessions in ${prereqs.mcpConfig}`);
  } else {
    lines.push(
      `   [ ] NOT mounted as an MCP server, so worker sessions have no graph`,
      `       tools and every index below would be unreadable. Add to`,
      `       ${prereqs.mcpConfig}:`,
      "",
      ...mcpEntry(prereqs)
        .split("\n")
        .map((l) => `       ${l}`),
    );
  }

  lines.push("", "1. create the clones that are missing", "");
  if (missing.length === 0) {
    lines.push("   every clone above already exists — nothing to create.");
  } else {
    lines.push(
      "   These are conductor's, not yours. Nothing human edits them, which is what",
      "   makes step 3's hard reset both safe and deterministic — so never point a",
      "   graphProject at a checkout you work in.",
      "",
    );
    for (const r of missing) lines.push(`   ${cloneCommand(r)}`);
  }

  lines.push(
    "",
    "2. index each one once now, so the first worker does not wait for the timer",
    "",
  );
  for (const r of repos) lines.push(`   ${indexCommand(r)}`);
  lines.push(
    "",
    "   Then check what a worker will see. Each root_path below must match a path",
    "   above exactly, and the name beside it is what a worker passes as `project`:",
    "",
    `   ${INDEXER} cli list_projects`,
    "",
    "3. keep them current",
    "",
  );

  const script = reindexScriptPath();
  const { service, timer } = unitPaths(stateDir());
  lines.push(
    `   \`graph-setup --write\` writes these three files for you, all under`,
    `   ${stateDir()}. Run it as the account the fleet runs as — never under`,
    "   sudo, which would resolve the config, the state directory and the unit's",
    "   own User= as root and quietly build indexes no worker can read.",
    "",
    ...block(script, reindexScript(p)),
    ...block(service, reindexService(p, script)),
    ...block(timer, reindexTimer(p)),
    `   then install them, which is the only step that needs root:`,
    "",
    ...installCommands(unitDir).map((c) => `   ${c}`),
  );

  return lines.join("\n");
}

/** What `graph-setup --write` did, and the root-only steps it deliberately left. */
export interface GraphSetupWrite {
  written: string[];
  next: string;
}

/**
 * Writes the script and both units, and returns what to do next.
 *
 * Deliberately stops there. Running `systemctl` would need root the wizard and
 * the CLI may not have, and a package that enables system timers behind an
 * operator's back is one you cannot audit by reading its output.
 */
export function writeGraphSetup(p: ProjectConfig, unitDir = SYSTEMD_UNIT_DIR): GraphSetupWrite {
  const script = reindexScriptPath();
  // All three land in the state directory, which this account owns — so the
  // whole command runs unprivileged and there is no sudo path that could
  // resolve HOME, the config or the unit's User= as the wrong account.
  const { service, timer } = unitPaths(stateDir());

  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, reindexScript(p));
  // Executable so an operator can run the refresh by hand before trusting a
  // timer with it; the unit calls bash explicitly either way.
  chmodSync(script, 0o755);
  writeFileSync(service, reindexService(p, script));
  writeFileSync(timer, reindexTimer(p));

  const missing = graphRepos(p).filter((r) => !existsSync(r.graphProject));
  const next = [
    "nothing has been installed, enabled or started — this command needs no root",
    `and takes none. The units are staged in ${stateDir()}.`,
    "",
    "to install them, which is the only privileged step:",
    "",
    ...installCommands(unitDir).map((c) => `  ${c}`),
    "",
    "then watch one real run before trusting the schedule (it takes minutes per repo):",
    "",
    `  sudo systemctl start ${REINDEX_UNIT}.service && systemctl status ${REINDEX_UNIT}.service`,
    ...(missing.length === 0
      ? []
      : [
          "",
          `first, though: ${missing.length} clone(s) do not exist yet, and the script fails`,
          "loudly rather than skipping them —",
          "",
          ...missing.map((r) => `  ${cloneCommand(r)}`),
        ]),
  ].join("\n");

  return { written: [script, service, timer], next };
}
