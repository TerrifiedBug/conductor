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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneCommand,
  defaultGraphRoot,
  formatGraphSetup,
  graphHint,
  graphProjectPath,
  graphRepos,
  indexCommand,
  reindexScript,
  reindexScriptPath,
  reindexService,
  reindexTimer,
  unitPaths,
  writeGraphSetup,
} from "./graph.ts";
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

test("the timer says why it exists, since the server has a watcher of its own", () => {
  const unit = reindexTimer(project(graphed("api")));

  expect(unit).toContain("OnCalendar=");
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
  expect(text).toContain("systemctl daemon-reload && systemctl enable --now cbm-reindex.timer");
});

test("--write leaves the files and the systemctl step, and runs neither", () => {
  const unitDir = join(home, "units");
  mkdirSync(unitDir, { recursive: true });
  const p = project(graphed("api"));

  const result = writeGraphSetup(p, unitDir);

  const { service, timer } = unitPaths(unitDir);
  expect(result.written).toEqual([reindexScriptPath(), service, timer]);
  expect(readFileSync(service, "utf8")).toBe(reindexService(p, reindexScriptPath()));
  expect(readFileSync(timer, "utf8")).toBe(reindexTimer(p));
  // Executable so an operator can run one refresh by hand before trusting a
  // timer with it.
  expect(statSync(reindexScriptPath()).mode & 0o111).not.toBe(0);

  // The one thing this command must never do: it needs root, and a package that
  // enables system timers behind an operator's back cannot be audited by
  // reading its output.
  expect(result.next).toContain("never runs systemctl");
  expect(result.next).toContain("systemctl daemon-reload && systemctl enable --now cbm-reindex.timer");
  // The clone does not exist, and the script fails rather than skipping it, so
  // the missing step is named here instead of at 03:30.
  expect(result.next).toContain("do not exist yet");
});
