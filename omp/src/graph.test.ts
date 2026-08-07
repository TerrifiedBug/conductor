/**
 * Behavioural tests for code-graph discovery.
 *
 * Two of these are the whole reason the feature is not worse than nothing.
 *
 * The first is the *target* of a query. An index is keyed by the realpath of the
 * directory it was built from, so a worker that asks about its own worktree gets
 * an empty answer and concludes there is no graph — the brief has to name the
 * indexed clone, and only the indexed clone.
 *
 * The second is that the generated refresh fails loudly. The version this
 * replaced was hand-written on a live host with `git fetch … || true`, which
 * meant a fetch that had been broken for a week still indexed the stale tree and
 * still exited 0: a green timer serving a month-old graph. So the script is
 * asserted to set `-e` and to contain no swallowed failure anywhere.
 *
 * `$OMP_CONDUCTOR_HOME` is redirected per test, so the generated paths are the
 * test's own and nothing here can read or write a real install.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  cloneCommand,
  defaultGraphRoot,
  formatGraphSetup,
  graphHint,
  graphProjectPath,
  graphRepos,
  indexCommand,
  mcpEntry,
  resolvePrereqs,
  reindexScript,
  reindexScriptPath,
  installCommands,
  reindexService,
  reindexTimer,
  unitPaths,
  writeGraphSetup,
} from "./graph.ts";
import { stateDir } from "./config.ts";
import { DEFAULT_AUTHORITY } from "./types.ts";
import type { ProjectConfig, RepoTarget } from "./types.ts";

const ENV_KEY = "OMP_CONDUCTOR_HOME";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env[ENV_KEY];
  home = mkdtempSync(join(tmpdir(), "omp-conductor-graph-"));
  process.env[ENV_KEY] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function repo(name: string, over: Partial<RepoTarget> = {}): RepoTarget {
  return {
    name,
    cloneUrl: `https://github.com/acme/${name}.git`,
    defaultBranch: "main",
    gates: [],
    ...over,
  };
}

/** The shape this was built for: several repos, one org, one graph root. */
function project(...repos: RepoTarget[]): ProjectConfig {
  return {
    name: "demo",
    tracker: { kind: "github", repo: "acme/planning" },
    queueLabel: "ready-for-agent",
    stateLabels: { inProgress: "agent:in-progress", blocked: "agent:blocked", failed: "agent:failed" },
    routing: { labelPrefix: "repo:", repos: Object.fromEntries(repos.map((r) => [r.name, r])) },
    caps: {},
    escalation: { fallbackToIssueComment: true, orchestrator: "external" },
    authority: { ...DEFAULT_AUTHORITY },
    workspaceRoot: join(home, "worktrees"),
    mirrorRoot: join(home, "mirrors"),
  };
}

function graphed(name: string, over: Partial<RepoTarget> = {}): RepoTarget {
  return repo(name, { graphProject: `/srv/graph/acme/${name}`, ...over });
}

// ------------------------------------------------------------------ the target

test("the default root is a cache directory, not anywhere a human keeps checkouts", () => {
  // The whole point of the field: these clones are hard-reset on every refresh.
  // A default under ~/projects would eventually reset a directory somebody was
  // working in, and destroying uncommitted work is not a recoverable default.
  const root = defaultGraphRoot("veltrosecurity/veltro");

  expect(root).toBe(join(homedir(), ".cache", "conductor-graph", "veltrosecurity"));
  expect(root).not.toContain("projects");
  expect(graphProjectPath(root, "chad")).toBe(join(root, "chad"));
});

test("a root typed with a ~ resolves to the same absolute path the validator accepts", () => {
  expect(graphProjectPath("~/graphs", "api")).toBe(join(homedir(), "graphs", "api"));
});

test("only repos with a configured clone are graph repos", () => {
  const p = project(graphed("api"), repo("web"), graphed("jobs"));

  expect(graphRepos(p).map((r) => r.name)).toEqual(["api", "jobs"]);
});

test("the hint names the indexed clone and forbids the worktree, or says nothing at all", () => {
  const hint = graphHint(graphed("api"));

  // The exact path, so the worker matches `root_path` rather than guessing a
  // project name from a slug it cannot derive.
  expect(hint).toContain("/srv/graph/acme/api");
  expect(hint).toContain("list_projects");
  expect(hint).toContain("root_path");
  // The two failure modes this text exists to prevent, both stated outright.
  expect(hint).toContain("never pass your own cwd");
  expect(hint).toContain("does not contain your edits");

  // And an unconfigured repo contributes nothing — not a heading, not a caveat,
  // not a blank line. See the brief test in daemon.test.ts for the render.
  expect(graphHint(repo("web"))).toBe("");
});

// ------------------------------------------------------- the generated refresh

test("the refresh script fails loudly and swallows nothing", () => {
  const script = reindexScript(project(graphed("api"), graphed("jobs")));

  // The bug this replaced: `|| true` on the fetch meant a week-old tree indexed
  // clean and the unit still exited 0.
  expect(script).not.toContain("|| true");
  expect(script).not.toContain("|| :");
  expect(script).toContain("set -euo pipefail");
  // `-e` must be real, not a comment about wanting it.
  expect(script.split("\n").some((l) => /^set -[a-z]*e/.test(l))).toBe(true);
});

test("the refresh resets each clone to its own configured branch", () => {
  const script = reindexScript(project(graphed("api"), graphed("legacy", { defaultBranch: "master" })));

  expect(script).toContain('cd "/srv/graph/acme/api"');
  expect(script).toContain("git fetch --prune origin");
  expect(script).toContain("git reset --hard origin/main");
  // A hardcoded `main` would silently index nothing for a repo on `master`, and
  // the reset would still exit 0 because the ref simply would not move.
  expect(script).toContain("git reset --hard origin/master");
  expect(script).not.toContain("git pull");
});

test("every configured repo is indexed, and nothing else is", () => {
  const script = reindexScript(project(graphed("api"), repo("web"), graphed("jobs")));

  expect(script).toContain(indexCommand({ ...graphed("api"), graphProject: "/srv/graph/acme/api" }));
  expect(script).toContain('index_repository \'{"repo_path": "/srv/graph/acme/jobs"}\'');
  // `web` has no clone to index, so naming it here would be a command that
  // fails every night under `set -e`.
  expect(script).not.toContain("web");
});

test("the service spells out HOME and PATH, because systemd supplies neither", () => {
  const unit = reindexService(project(graphed("api")), "/state/cbm-reindex.sh");

  expect(unit).toContain("Type=oneshot");
  expect(unit).toContain("ExecStart=/bin/bash /state/cbm-reindex.sh");
  // HOME: the indexer resolves its store from it, so an unset HOME builds a
  // second index nobody queries. PATH: systemd's default has no ~/.local/bin,
  // and the indexer shells out to git.
  expect(unit).toContain(`Environment=HOME=${homedir()}`);
  expect(unit).toContain(`Environment=PATH=${join(homedir(), ".local/bin")}`);
  expect(unit).toContain("/usr/bin");
  // No [Install]: enabling the service instead of the timer runs it once at boot
  // and never again, which looks exactly like a working install.
  expect(unit).not.toContain("[Install]");
});

test("the timer refreshes on an interval a busy fleet can trust", () => {
  const unit = reindexTimer(project(graphed("api")));

  // The contract is "minutes, not a day". A graph that predates the code a
  // worker was just dispatched to change is the one state in which this
  // feature misleads rather than merely underperforms, so the schedule is
  // load-bearing, not cosmetic.
  expect(unit).toContain("OnUnitActiveSec=20min");
  expect(unit).toContain("OnBootSec=3min");
  expect(unit).not.toContain("OnCalendar=");

  expect(unit).toContain("Persistent=true");
  expect(unit).toContain("Unit=cbm-reindex.service");
  expect(unit).toContain("WantedBy=timers.target");
});

// -------------------------------------------------------------- the plan, text

test("the plan names every repo, its clone, and the ones that do not exist yet", () => {
  const p = project(graphed("api"), graphed("jobs"), repo("web"));
  const text = formatGraphSetup(p);

  expect(text).toContain('code-graph discovery for project "demo"');
  expect(text).toContain("/srv/graph/acme/api");
  expect(text).toContain("/srv/graph/acme/jobs");
  // Neither clone exists, so both are offered as clone commands rather than
  // being quietly assumed present by the timer.
  expect(text).toContain(cloneCommand({ ...graphed("api"), graphProject: "/srv/graph/acme/api" }));
  expect(text).toContain("(missing)");
  // An ungraphed repo is absent from the plan entirely.
  expect(text).not.toContain("acme/web");
});

test("an existing clone is not offered for cloning again", () => {
  const existing = join(home, "already-there");
  mkdirSync(existing, { recursive: true });
  const text = formatGraphSetup(project(graphed("api", { graphProject: existing })));

  expect(text).not.toContain("git clone");
  expect(text).toContain("already exists");
});

test("the plan carries the whole refresh, so a host with no root can still be set up by hand", () => {
  const p = project(graphed("api"));
  const text = formatGraphSetup(p);

  expect(text).toContain(reindexScript(p).trimEnd());
  expect(text).toContain(reindexTimer(p).trimEnd());
  expect(text).toContain("sudo install -m 0644");
  expect(text).toContain("enable --now cbm-reindex.timer");
  // The plan has to warn about the account too, since a reader who copies it by
  // hand under sudo lands in exactly the state --write refuses to create.
  expect(text).toContain("never under");
});

test("--write stages every file unprivileged and leaves the install to the operator", () => {
  const p = project(graphed("api"));

  const result = writeGraphSetup(p, "/etc/systemd/system");

  // All three under the state directory this account owns — not the unit dir.
  // Writing units directly would force a sudo run, and a sudo run resolves the
  // config, HOME and User= as root, indexing into a store no worker reads.
  const { service, timer } = unitPaths(stateDir());
  expect(result.written).toEqual([reindexScriptPath(), service, timer]);
  expect(readFileSync(service, "utf8")).toBe(reindexService(p, reindexScriptPath()));
  expect(readFileSync(timer, "utf8")).toBe(reindexTimer(p));
  // Executable so an operator can run one refresh by hand before trusting a
  // timer with it.
  expect(statSync(reindexScriptPath()).mode & 0o111).not.toBe(0);

  // The one thing this command must never do: it needs root, and a package that
  // enables system timers behind an operator's back cannot be audited by
  // reading its output.
  expect(result.next).toContain("installed, enabled or started");
  expect(result.next).toContain("sudo install -m 0644");
  // The clone does not exist, and the script fails rather than skipping it, so
  // the missing step is named here instead of on the next tick.
  expect(result.next).toContain("do not exist yet");
});

// ------------------------------------------------------- host prerequisites

test("an indexed-but-unmounted host is called out, because nothing else says so", () => {
  // The exact fresh-install trap: indexing succeeds, the databases are real and
  // correct, and worker sessions still have no graph tools — so every worker
  // silently falls back to grepping and the feature looks like it did nothing.
  const prereqs = { indexer: "/usr/local/bin/codebase-memory-mcp", mcpConfig: join(home, "mcp.json"), mounted: false };
  const text = formatGraphSetup(project(graphed("api")), "/etc/systemd/system", prereqs);

  expect(text).toContain("0. host prerequisites");
  expect(text).toContain("[x] indexer: /usr/local/bin/codebase-memory-mcp");
  expect(text).toContain("NOT mounted");
  // The remedy, not just the diagnosis: the entry is printed ready to paste,
  // pointed at the binary that was actually found rather than a guess.
  expect(text).toContain('"command": "/usr/local/bin/codebase-memory-mcp"');
});

test("a missing binary names the source instead of inventing an install command", () => {
  const prereqs = { indexer: null, mcpConfig: join(home, "mcp.json"), mounted: true };
  const text = formatGraphSetup(project(graphed("api")), "/etc/systemd/system", prereqs);

  expect(text).toContain("is NOT on your PATH");
  expect(text).toContain("github.com/DeusData/codebase-memory-mcp");
  expect(text).toContain("[x] mounted for sessions");
});

test("resolvePrereqs reads a real mcp.json, and tolerates one it cannot parse", () => {
  const agent = join(home, ".omp", "agent");
  mkdirSync(agent, { recursive: true });
  const cfg = join(agent, "mcp.json");

  writeFileSync(cfg, JSON.stringify({ "codebase-memory-mcp": { command: "/x" } }));
  expect(resolvePrereqs(home).mounted).toBe(true);

  // Wrapped form, which is the other shape in the wild.
  writeFileSync(cfg, JSON.stringify({ mcpServers: { "codebase-memory-mcp": { command: "/x" } } }));
  expect(resolvePrereqs(home).mounted).toBe(true);

  // Garbage must read as "not mounted" and never throw: this runs inside a
  // plan an operator asked to *see*, and crashing on their config helps no one.
  writeFileSync(cfg, "{ not json");
  expect(resolvePrereqs(home).mounted).toBe(false);
  expect(resolvePrereqs(home).mcpConfig).toBe(cfg);
});

test("the pasted entry falls back to a plausible path when the binary is absent", () => {
  expect(mcpEntry({ indexer: null, mcpConfig: "x", mounted: false })).toContain("/usr/local/bin/");
  expect(JSON.parse(mcpEntry({ indexer: "/opt/cbm", mcpConfig: "x", mounted: false }))).toEqual({
    "codebase-memory-mcp": { type: "stdio", command: "/opt/cbm" },
  });
});

// ------------------------------------------------------ the account boundary

test("the unit pins itself to the generating account, not systemd's root default", () => {
  const unit = reindexService(project(graphed("api")), "/x/cbm-reindex.sh");

  // Without `User=`, systemd runs this as root: the indexer writes its store to
  // /root/.cache, a private fetch uses root's SSH keys, and every worker session
  // queries a different account's cache and finds nothing. All three are silent,
  // which is why the assertion is on the unit rather than on documentation.
  expect(unit).toContain(`User=${userInfo().username}`);
  expect(unit).toContain(`Environment=HOME=${homedir()}`);
});

test("units are staged in the state dir, so nothing here ever needs root", () => {
  const p = project(graphed("api"));
  const result = writeGraphSetup(p, "/etc/systemd/system");

  // Every written path is under this account's own state directory. A --write
  // that targeted /etc would only succeed under sudo, and a sudo run resolves
  // config, HOME and User= as root — the failure this layout removes entirely.
  for (const f of result.written) expect(f.startsWith(home)).toBe(true);
  expect(result.written).toHaveLength(3);

  // The privileged step is named, separated, and is the only sudo in the output.
  expect(result.next).toContain("only privileged step");
  expect(result.next).toContain("sudo install -m 0644");
  expect(result.next).toContain("/etc/systemd/system/");
});

test("install commands copy from the staging dir into the unit dir", () => {
  const [copy, enable] = installCommands("/etc/systemd/system", "/home/fleet/.omp/conductor");

  expect(copy).toBe(
    "sudo install -m 0644 /home/fleet/.omp/conductor/cbm-reindex.service " +
      "/home/fleet/.omp/conductor/cbm-reindex.timer /etc/systemd/system/",
  );
  expect(enable).toContain("enable --now cbm-reindex.timer");
});
