/**
 * The dispatcher loop.
 *
 * One tick turns the tracker's ready queue into running omp sessions. Every
 * limit that decides whether work starts is read from the store, never asked of
 * the model: a worker told to respect a budget will eventually talk itself out
 * of it, so concurrency, daily volume, spend and per-issue attempts are counted
 * here and enforced before anything is claimed.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath, findProject, loadConfig, resolveCaps, stateDir } from "./config.ts";
import { createEscalator } from "./escalate.ts";
import { startOrchestrator } from "./orchestrator.ts";
import type { OrchestratorHandle } from "./orchestrator.ts";
import { branchName, route } from "./routing.ts";
import type { Routed, UnroutableReason } from "./routing.ts";
import { openStore } from "./store.ts";
import { makeTracker } from "./tracker/github.ts";
import type {
  Caps,
  Escalation,
  ProjectConfig,
  ReadyIssue,
  RepoTarget,
  RunRecord,
  Store,
  Tracker,
} from "./types.ts";
import { renderBrief, runWorker } from "./worker.ts";
import { addWorktree, mirrorPathFor, removeWorktree, worktreePathFor } from "./worktree.ts";

/** Long enough that the tracker is not polled raw, short enough that a human
 *  who labels an issue sees it picked up within a coffee break. */
const TICK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_PORT = 8787;
const BRIEF_TEMPLATE_PATH = join(import.meta.dir, "briefs", "worker.md");

/** Fleet-wide escalations still need an issue number in the payload; 0 is the
 *  sentinel that reads as "no issue" in every renderer. */
const NO_ISSUE = 0;

const UNROUTABLE_TEXT: Record<UnroutableReason, string> = {
  "no-repo-label": "it carries no repo label",
  "multiple-repo-labels": "it carries more than one repo label",
  "unknown-repo": "its repo label maps to no configured repo",
};

export interface DaemonOpts {
  once?: boolean;
  port?: number;
  project?: string;
}

/** Everything one tick touches, resolved once at startup so a tick never
 *  re-reads config mid-flight and changes its own limits underneath itself. */
interface Deps {
  project: ProjectConfig;
  caps: Caps;
  tracker: Tracker;
  store: Store;
  escalate(e: Escalation): Promise<void>;
}

// ---------------------------------------------------------------- paths & pause

/** Single database for every project; the store partitions by project name. */
export function dbPath(): string {
  return join(stateDir(), "conductor.db");
}

/**
 * Pause is a file rather than process state on purpose: `omp-conductor pause`
 * and `/conductor pause` run in a different process from the daemon, and a flag
 * on disk needs no IPC and survives a restart. A daemon that crashed while
 * paused comes back paused.
 */
export function isPaused(): boolean {
  return existsSync(join(stateDir(), "paused"));
}

export function setPaused(v: boolean): void {
  const f = join(stateDir(), "paused");
  if (v) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `${new Date().toISOString()}\n`);
  } else {
    rmSync(f, { force: true });
  }
}

// ---------------------------------------------------------------------- helpers

function log(msg: string): void {
  process.stderr.write(`[conductor ${new Date().toISOString()}] ${msg}\n`);
}

function errText(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

/**
 * Local midnight, matching how a human reads "today".
 *
 * ponytail: a rolling 24h window would be fairer to a run that started at
 * 23:50, but midnight is what someone checking a morning spend report expects.
 * Upgrade path is a `capWindow: "day" | "rolling24h"` config key.
 */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * `owner/repo` for `gh`, derived from the clone URL.
 *
 * ponytail: RepoTarget has no explicit slug, so it is parsed off the URL and
 * falls back to the routing name. Upgrade path is an optional `slug` field once
 * a non-GitHub remote actually shows up.
 */
function repoSlug(repo: RepoTarget): string {
  const m = /(?:[:/])([^/:]+\/[^/]+?)(?:\.git)?$/.exec(repo.cloneUrl);
  return m?.[1] ?? repo.name;
}

function gatesBlock(repo: RepoTarget): string {
  if (repo.gates.length === 0) {
    return "_No pre-push gates are configured for this repo. Say so in your report rather than inventing one._";
  }
  return repo.gates.map((g) => `- \`${g.cmd}\` — run from \`${g.cwd}\``).join("\n");
}

function acceptanceCriteria(issue: ReadyIssue): string {
  const body = issue.body.trim();
  // ponytail: the whole issue body stands in for a criteria section. Upgrade
  // path is parsing the "## Acceptance criteria" heading once issue templates
  // are consistent enough to trust; a fuzzy extraction today would silently
  // drop context the worker needs, and the brief already tells it to read the
  // issue itself.
  return body.length > 0
    ? body
    : "_The issue body is empty. Read the issue and its comments, and escalate if it is genuinely underspecified._";
}

/**
 * Add the new label before dropping the old one. The reverse order leaves a
 * window where the issue carries no state label at all, which is exactly the
 * shape `isEligible` treats as fresh work.
 */
async function swapLabel(tracker: Tracker, issue: number, from: string, to: string): Promise<void> {
  await tracker.addLabel(issue, to);
  await tracker.removeLabel(issue, from);
}

/**
 * The escalator throws when no transport is configured or Telegram rejects, and
 * only records the dedup marker on success. A page that cannot be delivered
 * must not take the tick down with it — log it and let the next tick retry.
 */
async function safeEscalate(d: Deps, e: Escalation): Promise<void> {
  try {
    await d.escalate(e);
  } catch (err) {
    log(`escalation for #${e.issue} could not be delivered: ${errText(err)}`);
  }
}

async function buildBrief(
  project: ProjectConfig,
  r: Routed,
  branch: string,
  worktree: string,
): Promise<string> {
  // Read per dispatch rather than caching: editing the brief then takes effect
  // on the next issue instead of needing a daemon restart.
  const template = await Bun.file(BRIEF_TEMPLATE_PATH).text();
  return renderBrief(template, {
    ISSUE_NUMBER: String(r.issue.number),
    ISSUE_TITLE: r.issue.title,
    TRACKER_REPO: project.tracker.repo,
    REPO: repoSlug(r.repo),
    BRANCH: branch,
    WORKTREE: worktree,
    ACCEPTANCE_CRITERIA: acceptanceCriteria(r.issue),
    GATES: gatesBlock(r.repo),
  });
}

// ------------------------------------------------------------------- one issue

/**
 * One attempt at one issue, from claim to terminal state. Everything is inside
 * a single try/catch so that a bad issue costs its own run and nothing else.
 */
async function handleIssue(d: Deps, r: Routed, attempt: number): Promise<void> {
  const { project, caps, tracker, store } = d;
  const issue = r.issue.number;
  const branch = branchName(r.issue);
  const inProgress = project.stateLabels.inProgress;

  let claimed = false;
  let run: RunRecord | undefined;

  try {
    // Claim on the tracker FIRST, before any local work. The label — not the
    // store — is the crash-safe guard against double dispatch: if this process
    // dies mid-run, the next daemon sees the label, `isEligible` filters the
    // issue out, and a human decides what to do with the orphan.
    await tracker.addLabel(issue, inProgress);
    claimed = true;

    run = store.createRun({
      project: project.name,
      issue,
      repo: r.repo.name,
      branch,
      worktree: "",
      state: "claimed",
      attempt,
      turns: 0,
      spendUsd: 0,
      startedAt: Date.now(),
    });
    const runId = run.id;

    // A run's tree is <workspaceRoot>/<issue> and addWorktree refuses to reuse
    // an existing path, so a retry — or a tree kept from a failed attempt — has
    // to be cleared first. Both helpers are pure path math and removeWorktree
    // tolerates a mirror or tree that is not there yet, so this is safe on a
    // first attempt. addWorktree does its own ensureMirror; calling it here too
    // would cost a second network fetch per attempt.
    const mirrorPath = mirrorPathFor(r.repo, project.mirrorRoot);
    await removeWorktree(mirrorPath, worktreePathFor(project.workspaceRoot, issue));

    const worktreePath = await addWorktree(
      r.repo,
      project.mirrorRoot,
      project.workspaceRoot,
      issue,
      branch,
    );

    // The SDK names the transcript itself, so the daemon supplies the parent
    // directory and learns the real path back from the result. Inventing one
    // here would put a file that never gets written into an escalation.
    const sessionDir = join(stateDir(), "sessions");
    mkdirSync(sessionDir, { recursive: true });
    store.updateRun(runId, { worktree: worktreePath, state: "running" });

    log(`#${issue} attempt ${attempt} → ${r.repo.name} ${branch}`);

    const result = await runWorker({
      brief: await buildBrief(project, r, branch, worktreePath),
      cwd: worktreePath,
      caps,
      sessionDir,
      onTurn: (n) => store.updateRun(runId, { turns: n }),
    });

    store.updateRun(runId, {
      state: result.state,
      endedAt: Date.now(),
      turns: result.turns,
      spendUsd: result.spendUsd,
      prUrl: result.prUrl,
      sessionFile: result.sessionFile,
    });

    if (result.state === "blocked") {
      await swapLabel(tracker, issue, inProgress, project.stateLabels.blocked);
      await safeEscalate(d, {
        tier: 1,
        project: project.name,
        issue,
        runId,
        summary: `#${issue} is blocked on attempt ${attempt} and needs a decision`,
        detail: [`${r.issue.title}`, r.issue.url, "", result.report].join("\n"),
      });
    } else if (result.state === "failed" || result.state === "killed") {
      await swapLabel(tracker, issue, inProgress, project.stateLabels.failed);
      await safeEscalate(d, {
        tier: 1,
        project: project.name,
        issue,
        runId,
        // The dedup key includes the summary, so the attempt number is what
        // lets a genuine second failure page again while a tick that keeps
        // seeing the same dead issue stays quiet.
        summary: result.killedBy
          ? `#${issue} was killed on attempt ${attempt} by the ${result.killedBy} cap`
          : `#${issue} failed on attempt ${attempt}`,
        detail: [
          `${r.issue.title}`,
          r.issue.url,
          `Worktree kept for inspection: ${worktreePath}`,
          `Session: ${result.sessionFile ?? "(no transcript)"}`,
          "",
          result.report,
        ].join("\n"),
      });
    } else {
      // pushed-green: the PR belongs to a human now. The in-progress label
      // stays on until the merge closes the issue, which is also what keeps
      // the next tick from re-claiming it.
      log(`#${issue} ${result.state}${result.prUrl ? ` ${result.prUrl}` : ""}`);
    }

    // A failed or killed tree is evidence — keep it. Anything else is just
    // disk, and the mirror means re-provisioning is cheap. (The kept tree is
    // wiped by the next attempt, not left to accumulate forever.)
    if (result.state !== "failed" && result.state !== "killed") {
      await removeWorktree(mirrorPath, worktreePath);
    }
  } catch (err) {
    const detail = errText(err);
    log(`#${issue} errored: ${detail}`);
    if (run) {
      store.updateRun(run.id, { state: "failed", endedAt: Date.now(), lastError: detail });
    }
    if (claimed) {
      // Leaving the issue stuck as in-progress would hide it from both the
      // queue and the human, so relabel even on the error path.
      try {
        await swapLabel(tracker, issue, inProgress, project.stateLabels.failed);
      } catch (relabelErr) {
        log(`#${issue} could not be relabelled: ${errText(relabelErr)}`);
      }
    }
    await safeEscalate(d, {
      tier: 1,
      project: project.name,
      issue,
      runId: run?.id,
      summary: `#${issue} could not be dispatched on attempt ${attempt}`,
      detail,
    });
    // The worktree, if one was created, is deliberately left in place: this is
    // a failure path.
  }
}

// ----------------------------------------------------------------------- a tick

async function tick(d: Deps): Promise<void> {
  // A paused fleet claims nothing. Checked first so pausing takes effect on the
  // next tick without signalling the process.
  if (isPaused()) return;

  const { project, caps, store } = d;

  // route() filters the queue through isEligible() itself, so anything already
  // carrying a state label is gone before it gets here.
  const { routed, unroutable } = route(await d.tracker.listReady(), project);

  // An issue nobody can route never reaches a worker: guessing the target repo
  // is exactly the kind of improvisation this system exists to prevent. The
  // summary is stable so a queue left unfixed pages once, not every tick.
  for (const u of unroutable) {
    await safeEscalate(d, {
      tier: 1,
      project: project.name,
      issue: u.issue.number,
      summary: `#${u.issue.number} cannot be routed: ${UNROUTABLE_TEXT[u.reason]}`,
      detail: [
        u.issue.title,
        u.issue.url,
        `Repo labels seen: ${u.labels.length > 0 ? u.labels.join(", ") : "(none)"}`,
        `Configured repos: ${Object.keys(project.routing.repos).join(", ") || "(none)"}`,
        `Fix: put exactly one \`${project.routing.labelPrefix}<repo>\` label on the issue.`,
      ].join("\n"),
    });
  }

  const since = startOfToday();

  // Spend is the one cap that stops the fleet instead of merely deferring work.
  // A loop that is burning money has to halt itself; waiting for a human to
  // notice tomorrow is how a runaway becomes expensive.
  const spent = store.spendSince(project.name, since);
  if (spent >= caps.dailySpendUsd) {
    setPaused(true);
    await safeEscalate(d, {
      tier: 2,
      project: project.name,
      issue: NO_ISSUE,
      // Dated so the same cap pages again tomorrow, but only once per day.
      summary: `Daily spend cap reached on ${new Date().toISOString().slice(0, 10)} — ${project.name} is paused`,
      detail: [
        `Spent $${spent.toFixed(2)} of the $${caps.dailySpendUsd.toFixed(2)} daily cap.`,
        "No further work will be claimed until `omp-conductor resume` (or /conductor resume).",
      ].join("\n"),
    });
    return;
  }

  const active = store.activeRuns(project.name);
  let slots = caps.maxConcurrentWorkers - active.length;
  let dayBudget = caps.maxIssuesPerDay - store.runsStartedSince(project.name, since);
  if (slots <= 0 || dayBudget <= 0) {
    log(
      `at capacity: ${active.length}/${caps.maxConcurrentWorkers} workers, ` +
        `${caps.maxIssuesPerDay - dayBudget}/${caps.maxIssuesPerDay} issues today`,
    );
    return;
  }

  // activeRuns includes pushed-green work that is still waiting on a human
  // merge, so this also stops a second attempt landing on a live PR.
  const busy = new Set(active.map((r) => r.issue));

  const admitted: { r: Routed; attempt: number }[] = [];
  for (const r of routed) {
    if (slots <= 0 || dayBudget <= 0) break;
    if (busy.has(r.issue.number)) continue;

    const prior = store.attemptsFor(project.name, r.issue.number);
    if (prior >= caps.maxAttemptsPerIssue) {
      await safeEscalate(d, {
        tier: 1,
        project: project.name,
        issue: r.issue.number,
        summary: `#${r.issue.number} has used all ${caps.maxAttemptsPerIssue} attempts`,
        detail: [
          r.issue.title,
          r.issue.url,
          "Another attempt almost always means the issue itself is underspecified.",
          "Rewrite the acceptance criteria, or take it off the queue.",
        ].join("\n"),
      });
      continue;
    }

    admitted.push({ r, attempt: prior + 1 });
    slots -= 1;
    dayBudget -= 1;
  }

  if (admitted.length === 0) return;

  log(`dispatching ${admitted.map((a) => `#${a.r.issue.number}`).join(" ")}`);
  // handleIssue never rejects; allSettled is the belt to that braces.
  await Promise.allSettled(admitted.map((a) => handleIssue(d, a.r, a.attempt)));
}

// --------------------------------------------------------------- read-only views

export interface StatusSnapshot {
  project: string;
  configPath: string;
  stateDir: string;
  paused: boolean;
  caps: Caps;
  activeRuns: RunRecord[];
  runsToday: number;
  spendTodayUsd: number;
}

/** Opens and closes its own store handle so the CLI and the plugin can read
 *  status while a daemon in another process is writing (the store runs in WAL
 *  mode for exactly this). */
export function statusSnapshot(project?: string): StatusSnapshot {
  const cfg = loadConfig();
  const p = findProject(cfg, project);
  const store = openStore(dbPath());
  try {
    const since = startOfToday();
    return {
      project: p.name,
      configPath: configPath(),
      stateDir: stateDir(),
      paused: isPaused(),
      caps: resolveCaps(p, cfg.defaults),
      activeRuns: store.activeRuns(p.name),
      runsToday: store.runsStartedSince(p.name, since),
      spendTodayUsd: store.spendSince(p.name, since),
    };
  } finally {
    store.close();
  }
}

export function formatStatus(s: StatusSnapshot): string {
  const lines = [
    `project   ${s.project}${s.paused ? "  (PAUSED)" : ""}`,
    `config    ${s.configPath}`,
    `state     ${s.stateDir}`,
    "",
    "caps",
    `  workers            ${s.activeRuns.length} / ${s.caps.maxConcurrentWorkers}`,
    `  issues today       ${s.runsToday} / ${s.caps.maxIssuesPerDay}`,
    `  spend today        $${s.spendTodayUsd.toFixed(2)} / $${s.caps.dailySpendUsd.toFixed(2)}`,
    `  worker max turns   ${s.caps.workerMaxTurns}`,
    `  worker wall clock  ${Math.round(s.caps.workerWallClockMs / 60_000)}m`,
    `  attempts per issue ${s.caps.maxAttemptsPerIssue}`,
    "",
  ];
  if (s.activeRuns.length === 0) {
    lines.push("active runs  (none)");
  } else {
    lines.push("active runs");
    for (const r of s.activeRuns) {
      lines.push(
        `  #${r.issue}  ${r.repo}  ${r.state}  attempt ${r.attempt}  ` +
          `${r.turns} turns  $${r.spendUsd.toFixed(2)}  ${r.branch}` +
          (r.prUrl ? `  ${r.prUrl}` : ""),
      );
    }
  }
  return lines.join("\n");
}

export interface QueuePreview {
  project: string;
  configPath: string;
  queueDescription: string;
  paused: boolean;
  ready: { number: number; title: string; repo: string; branch: string }[];
  unroutable: { number: number; title: string; reason: string; labels: string[] }[];
}

/**
 * Exactly what the next tick would pick up, computed without touching a single
 * label, run row or worktree. This is what makes `/conductor setup` honest: the
 * dry run is the same routing code the loop uses, not a description of it.
 */
export async function previewQueue(project?: string): Promise<QueuePreview> {
  const cfg = loadConfig();
  const p = findProject(cfg, project);
  const { routed, unroutable } = route(await makeTracker(p).listReady(), p);
  const states = Object.values(p.stateLabels).join(", ");
  return {
    project: p.name,
    configPath: configPath(),
    queueDescription:
      `open issues in ${p.tracker.repo} labelled "${p.queueLabel}", ` +
      `minus anything already labelled ${states}, ` +
      `routed by one "${p.routing.labelPrefix}<repo>" label`,
    paused: isPaused(),
    ready: routed.map((r) => ({
      number: r.issue.number,
      title: r.issue.title,
      repo: r.repo.name,
      branch: branchName(r.issue),
    })),
    unroutable: unroutable.map((u) => ({
      number: u.issue.number,
      title: u.issue.title,
      reason: UNROUTABLE_TEXT[u.reason],
      labels: u.labels,
    })),
  };
}

/**
 * The one mutation `/conductor setup` performs, and only after the operator has
 * seen the dry run: create the state directory and schema, then clear the pause
 * flag so the daemon is allowed to claim work.
 */
export function armConductor(): void {
  openStore(dbPath()).close();
  setPaused(false);
}

// ------------------------------------------------------------------- the daemon

export async function runDaemon(o: DaemonOpts = {}): Promise<void> {
  const cfg = loadConfig();
  const project = findProject(cfg, o.project);
  const caps = resolveCaps(project, cfg.defaults);
  const store = openStore(dbPath());
  const tracker = makeTracker(project);

  // Standing orders. The orchestrator holds none of this file's context, so
  // everything it needs to act — which tracker, which labels, what the fleet
  // does — has to be said once, in words.
  const brief = [
    `You are the omp-conductor orchestrator for project "${project.name}".`,
    `Tracker: ${project.tracker.repo}. Pass --repo ${project.tracker.repo} to every gh command:`,
    "this working directory is the conductor's state directory, not a checkout.",
    `Labels: queue=${project.queueLabel}, running=${project.stateLabels.inProgress}, ` +
      `blocked=${project.stateLabels.blocked}, failed=${project.stateLabels.failed}.`,
    "The dispatcher claims queue-labelled issues, runs one worker session per attempt in its own",
    "worktree under hard turn/wallclock/spend caps, and escalates to you when a worker blocks or",
    "fails twice, its gates stay red, its branch conflicts, or a tripwire fires.",
    "Your job when that happens: re-brief the issue (comment what the next worker must do",
    `differently, then put ${project.queueLabel} back on it), file follow-up issues, or promote to`,
    "tier 2 and let the human decide. You never edit product code, push a branch, or merge a PR —",
    "a worker session does all of that. Handle each escalation below before the next one.",
  ].join("\n");

  // One orchestrator per daemon run, not per tick: it is a persistent session
  // whose whole value is remembering what it has already escalated, and a fresh
  // one every five minutes would remember nothing. Its cwd is the state
  // directory, deliberately not a checkout — the orchestrator re-briefs workers
  // and talks to the tracker, it does not edit product code.
  let orchestrator: OrchestratorHandle | undefined;
  try {
    orchestrator = await startOrchestrator({ cwd: stateDir(), brief });
    const transcript = orchestrator.sessionFile();
    log(`orchestrator session ready${transcript === undefined ? "" : ` · ${transcript}`}`);
  } catch (err) {
    // Loudly, but not fatally: tier-1 escalations degrade to issue comments,
    // which a human still reads. A dispatcher that refuses to run because its
    // re-briefing channel is down helps nobody.
    log(
      `WARNING: orchestrator session failed to start; tier-1 escalations will fall back to issue comments: ${errText(err)}`,
    );
  }

  const escalator = createEscalator(project, tracker, store, orchestrator);
  const d: Deps = {
    project,
    caps,
    tracker,
    store,
    escalate: (e) => escalator.escalate(e),
  };

  if (o.once) {
    try {
      await tick(d);
    } finally {
      await orchestrator?.dispose();
      store.close();
    }
    return;
  }

  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    log("shutting down after the current tick");
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const server = Bun.serve({
    port: o.port ?? DEFAULT_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          ok: true,
          paused: isPaused(),
          activeRuns: store.activeRuns(project.name).length,
          project: project.name,
        });
      }
      return new Response("not found\n", { status: 404 });
    },
  });
  log(`serving /healthz on :${server.port}, project ${project.name}`);

  try {
    while (!stopping) {
      try {
        await tick(d);
      } catch (err) {
        // A tick that blows up outside an issue (the tracker is down, say) must
        // not end the daemon; the next one will retry.
        log(`tick failed: ${errText(err)}`);
      }
      if (stopping) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, TICK_INTERVAL_MS);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = undefined;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await server.stop(true);
    // Before the store closes: a queued injection that rejects on the way out
    // falls back to an issue comment, and that path writes the dedup marker.
    await orchestrator?.dispose();
    store.close();
    log("stopped");
  }
}
