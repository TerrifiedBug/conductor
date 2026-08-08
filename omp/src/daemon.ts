/**
 * The dispatcher loop.
 *
 * One tick turns the tracker's ready queue into running omp sessions. Every
 * limit that decides whether work starts is read from the store, never asked of
 * the model: a worker told to respect a budget will eventually talk itself out
 * of it, so concurrency, daily volume, spend and per-issue attempts are counted
 * here and enforced before anything is claimed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { configPath, findProject, loadConfig, resolveCaps, resolveReleasePolicy, stateDir } from "./config.ts";
import { createEscalator, escalationIssueRef } from "./escalate.ts";
import { graphHint } from "./graph.ts";
import { livingDaemon } from "./lifecycle.ts";
import { STALL_MARKER_FILE } from "./orchestrator-tick.ts";
import { startOrchestrator } from "./orchestrator.ts";
import type { OrchestratorHandle } from "./orchestrator.ts";
import { recordReleaseBlock } from "./release-policy.ts";
import { branchName, route } from "./routing.ts";
import type { Routed, UnroutableReason } from "./routing.ts";
import { openStore } from "./store.ts";
import { makeTracker } from "./tracker/github.ts";
import type {
  AdmissionHoldReason,
  Caps,
  DispatchSummary,
  Escalation,
  PrState,
  ProjectConfig,
  ReadyIssue,
  RepoTarget,
  RunRecord,
  RunState,
  Store,
  Tracker,
} from "./types.ts";
import { type KilledBy, type WorkerResult, renderBrief, runWorker } from "./worker.ts";
import {
  addWorktree,
  mirrorPathFor,
  removeWorktree,
  salvageWip,
  type SalvageOutcome,
  worktreePathFor,
} from "./worktree.ts";

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
  turnLimits: TurnLimitRegistry;
  integrity: IntegrityGate;
  stall: StallGate;
}

// ---------------------------------------------------------------- paths & pause

/** Single database for every project; the store partitions by project name. */
export function dbPath(): string {
  return join(stateDir(), "conductor.db");
}

// ------------------------------------------------------- orchestrator liveness

/**
 * Whether the wedged-orchestrator page has already gone out for the stall
 * currently on disk. One page per episode: the marker persists until a tick is
 * consumed, so paging per five minutes would be paging forever.
 */
export interface StallGate {
  paged: boolean;
}

export interface StallVerdict {
  /** The marker's own line, when one is there. */
  since?: string;
  page: boolean;
}

/**
 * Reads the orchestrator's stall marker and decides whether this tick pages.
 *
 * The marker is written by the tick extension inside the orchestrator session
 * ({@link STALL_MARKER_FILE}) when two of its own prompts go unconsumed — the
 * one signal that separates "the process is alive" from "the loop is reading
 * its queue". Every other guard in this system reads healthy through a wedge:
 * the herdr recovery plugin tests for a live process and an agent label, both
 * of which survive it, and `/healthz` describes this daemon, which is a
 * different process entirely.
 *
 * The daemon is the natural watcher precisely because it is that different
 * process: it already wakes every five minutes, it owns a working escalation
 * path, and nothing about its health depends on the session that is stuck. A
 * wedged loop cannot page for itself, and the herdr plugin only runs on session
 * lifecycle events — a session that stays alive and stops working emits none.
 *
 * Resets when the marker disappears, so a second stall days later pages again.
 */
export function checkStall(gate: StallGate, marker: string): StallVerdict {
  if (!existsSync(marker)) {
    gate.paged = false;
    return { page: false };
  }
  const page = !gate.paged;
  let since: string | undefined;
  try {
    const body = readFileSync(marker, "utf8").split("\n")[0]?.trim();
    if (body !== undefined && body !== "") since = body;
  } catch {
    // An unreadable marker still means stalled; the timestamp is a nicety.
  }
  return { ...(since === undefined ? {} : { since }), page };
}

/**
 * Pages tier 2 once when the orchestrator session stops draining its queue.
 *
 * Deliberately does not restart anything. A wedge lands mid-turn, this process
 * cannot tell a half-applied edit from an idle loop, and killing the session
 * could destroy work an operator would rather read first — the same refusal to
 * guess that the recovery plugin is built on.
 */
async function watchOrchestrator(d: Deps): Promise<void> {
  const marker = join(stateDir(), STALL_MARKER_FILE);
  const verdict = checkStall(d.stall, marker);
  if (!verdict.page) return;

  log(`ERROR: the orchestrator session is not draining its queue — ${verdict.since ?? "no timestamp"}`);
  const delivered = await safeEscalate(d, {
    tier: 2,
    project: d.project.name,
    issue: NO_ISSUE,
    // Keyed on the marker's own timestamp, not the date. The dedup ledger keys
    // on this summary, and two wedges in one day is not a hypothetical — the
    // failure mode is a session that gets stuck, gets restarted, and gets stuck
    // again on the same cause an hour later. A day-keyed summary would report
    // the first and silently swallow every one after it.
    summary:
      `Orchestrator session wedged (${verdict.since ?? `marker at ${marker}`}) — ` +
      `it has stopped reading its queue (${d.project.name})`,
    detail: [
      verdict.since ?? "Marker present with no readable timestamp.",
      `Marker: ${marker}`,
      "",
      "Its process and its herdr agent label are both healthy, which is why nothing else noticed:",
      "the loop is alive and consuming nothing, so ticks and your messages queue behind it unread.",
      "",
      "Attach and look before you act — a wedge lands mid-turn. Then SIGTERM the omp process:",
      "herdr-conductor resumes it by exact identity, and the first consumed tick clears this marker.",
      "",
      "Dispatch is unaffected: workers keep running. What stops is drain, groom, report and merge.",
    ].join("\n"),
  });
  markPaged(d.stall, delivered);
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

// ----------------------------------------------------------- package integrity

/** Enough differing paths to tell a deploy from a tamper at a glance; the full
 *  list is on the host, and the answer is always "go look at the host". */
const INTEGRITY_SAMPLE = 5;

/**
 * What the daemon booted with, and whether it has already paged about losing
 * it. Lives exactly as long as one `runDaemon()` call — which is the whole
 * trick: a restart re-records both.
 */
export interface IntegrityGate {
  baseline: Map<string, string>;
  paged: boolean;
}

export interface IntegrityVerdict {
  /** Labelled, sorted differences; empty when the package is untouched. */
  diff: string[];
  /** Any difference at all stops the fleet. */
  pause: boolean;
  /** First divergent tick only — a page every five minutes is a page nobody reads. */
  page: boolean;
}

/**
 * sha256 of every source file the running package is made of, keyed by path
 * relative to `root`.
 *
 * `import.meta.dir` is the installed `src/` of the code executing right now, so
 * this is a self-portrait: what was actually deployed, not what some checkout
 * on disk happens to contain. `.ts` and `.md` because both are executable in
 * this package — the briefs under `src/briefs/` are the sessions' instructions,
 * and rewriting one of those buys more than rewriting the dispatcher does.
 * (A checkout also carries `*.test.ts`, which the published package excludes, so
 * a daemon started from one is watching its tests too. That is the honest
 * answer — its code did change — and it costs nothing on a real install.)
 *
 * Walking and hashing the ~30 files of this package measures 0.6 ms warm, once
 * per five-minute tick, so a tick does it inline. No cache and no mtime
 * shortcut on purpose: a cache is a second thing that can be wrong, and mtime
 * is the first field anyone covering their tracks restores.
 */
export function packageManifest(root: string = import.meta.dir): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".md")))
        out.set(relative(root, full), createHash("sha256").update(readFileSync(full)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

/**
 * Labelled rather than three arrays because every consumer — the log line, the
 * page, the test — wants one readable list of what moved.
 */
export function manifestDiff(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [path, hash] of before) {
    const now = after.get(path);
    if (now === undefined) out.push(`removed ${path}`);
    else if (now !== hash) out.push(`changed ${path}`);
  }
  for (const path of after.keys()) if (!before.has(path)) out.push(`added ${path}`);
  return out.sort();
}

/**
 * The tick's decision, split from its effects so the once-only page is a thing
 * a test can hold.
 *
 * `pause` stays true on every divergent tick, deliberately: an operator who
 * resumes without restarting gets re-paused, because the boundary is still
 * broken. `page` asks whether this tick should *try* — the caller latches the
 * gate with {@link markPaged} only once a page actually went out, so a Telegram
 * outage during the one tick that noticed does not buy permanent silence.
 */
export function checkIntegrity(gate: IntegrityGate, current: Map<string, string>): IntegrityVerdict {
  const diff = manifestDiff(gate.baseline, current);
  if (diff.length === 0) return { diff, pause: false, page: false };
  return { diff, pause: true, page: !gate.paged };
}

/** Latch a once-only page, after delivery is confirmed and never before. */
export function markPaged(gate: { paged: boolean }, delivered: boolean): void {
  if (delivered) gate.paged = true;
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
 *
 * Returns whether it actually went out, because "page once" and "page once
 * *successfully*" are different promises: a caller that latches a once-only
 * gate on the attempt turns one failed delivery into permanent silence about a
 * condition that is still true.
 */
async function safeEscalate(d: Pick<Deps, "escalate">, e: Escalation): Promise<boolean> {
  try {
    await d.escalate(e);
    return true;
  } catch (err) {
    log(`escalation for ${escalationIssueRef(e.issue)} could not be delivered: ${errText(err)}`);
    return false;
  }
}

/**
 * What a salvage attempt contributes to the escalation: where the work went, or
 * that it went nowhere. Split from the effects below for the same reason
 * `checkIntegrity` is — this wording is the whole thing a human acts on, so it
 * is worth a test holding it, and the sha in it is the only pointer to work
 * that no longer has any other copy.
 */
export function salvageLines(outcome: SalvageOutcome, worktree: string): string[] {
  const kept = `Worktree kept for inspection: ${worktree}`;

  if (outcome.kind === "nothing") return [`${kept} — nothing uncommitted to salvage`];

  if (outcome.kind === "failed") {
    return [
      `WIP SALVAGE FAILED: ${outcome.error}`,
      `Uncommitted work in ${worktree} is the only copy of it, and the next attempt removes that tree.`,
    ];
  }

  const where =
    `WIP committed to ${outcome.branch} @ ${outcome.sha}` +
    (outcome.pushed
      ? " and pushed — the work outlives this worktree"
      : ` but NOT pushed (${outcome.pushError ?? "no reason given"}) — it lives only in this host's mirror`);
  // Manifest belongs in the escalation too: opening the commit is how the
  // orchestrator talked itself into scrubbing a worker tree (#38).
  const n = outcome.files.length;
  const count = `${n} file${n === 1 ? "" : "s"}`;
  const manifest =
    outcome.newPaths.length === 0
      ? `${count} (all modifications to tracked paths)`
      : `${count}; new: ${outcome.newPaths.slice(0, 12).join(", ")}${
          outcome.newPaths.length > 12 ? `, … +${outcome.newPaths.length - 12} more` : ""
        }`;
  return [where, manifest, kept];
}

/**
 * Commits and pushes whatever a dead run left uncommitted, logs the outcome and
 * returns the escalation lines that say where that work now lives.
 *
 * Only ever called on a non-graceful end — a cap kill, a crashed session, a
 * dispatch error. A `blocked` run stopped on purpose, with turns still in hand
 * and a brief that tells it to report rather than push, so nothing is committed
 * behind its back. The rest never got the chance: the kill is external and
 * lands mid-edit, in the tree the next attempt removes `--force`.
 */
async function salvage(
  issue: number,
  attempt: number,
  reason: string,
  worktree: string,
): Promise<string[]> {
  const lines = salvageLines(await salvageWip(worktree, issue, attempt, reason), worktree);
  log(`#${issue} salvage: ${lines.join(" ")}`);
  return lines;
}

/** How a run's end is named — in the salvage commit, and to whoever reads it. */
function endedBy(killedBy: KilledBy | undefined): string {
  if (killedBy === "turns") return "the turns cap";
  if (killedBy === "wallclock") return "the wall-clock cap";
  return "a failed run";
}

/**
 * The worker's opening prompt.
 *
 * Exported for the same reason `salvageLines` is: this text is the entire
 * context a session with the host's credentials gets, so the two things a test
 * can hold it to are worth holding — that a configured graph reaches the worker,
 * and that a project without one gets the brief this package has always shipped,
 * to the byte.
 */
export async function buildBrief(
  project: ProjectConfig,
  r: Routed,
  branch: string,
  worktree: string,
  opts: { continuation?: boolean; defaultBranch?: string } = {},
): Promise<string> {
  // Read per dispatch rather than caching: editing the brief then takes effect
  // on the next issue instead of needing a daemon restart.
  const template = await Bun.file(BRIEF_TEMPLATE_PATH).text();
  const defaultBranch = opts.defaultBranch ?? r.repo.defaultBranch;
  const continuation =
    opts.continuation === true
      ? [
          "",
          "## Continuation — do not start from zero",
          "",
          `You are **resuming** issue #${r.issue.number}. Branch \`${branch}\` already exists`,
          "and was reattached with prior commits (and possibly a salvaged WIP tip).",
          "Before writing anything:",
          "",
          "```bash",
          "git log --oneline origin/" + defaultBranch + "..HEAD",
          "git diff --stat origin/" + defaultBranch + "...HEAD",
          "git status --porcelain",
          "```",
          "",
          "Read that history. **Do not recreate work that already exists.** Finish",
          "what remains against the same acceptance criteria. If a prior attempt",
          "left a `wip(#…): … auto-salvaged` commit, treat it as your starting",
          "point, not as trash to rewrite from scratch.",
          "",
        ].join("\n")
      : "";
  return renderBrief(template, {
    ISSUE_NUMBER: String(r.issue.number),
    ISSUE_TITLE: r.issue.title,
    TRACKER_REPO: project.tracker.repo,
    REPO: repoSlug(r.repo),
    BRANCH: branch,
    WORKTREE: worktree,
    ACCEPTANCE_CRITERIA: acceptanceCriteria(r.issue),
    GATES: gatesBlock(r.repo),
    // Empty for a repo with no `graphProject`, and empty means *nothing*: the
    // placeholder sits flush against the next list item in the template, so an
    // unconfigured render leaves no blank line where a hint would have gone.
    GRAPH_HINT: graphHint(r.repo),
    CONTINUATION: continuation,
  });
}

// ------------------------------------------------------------------- one issue

/** `stops` are the operational ends that each require one resume. */
export function hasContinuationBudget(stops: number, maxContinuations: number): boolean {
  return stops <= maxContinuations;
}

export type ExtendTurnLimitResult =
  | { kind: "extended"; runId: string; maxTurns: number }
  | { kind: "not-increase"; runId: string; maxTurns: number }
  | { kind: "not-active" };

export interface TurnLimitController {
  maxTurns(): number;
  close(): void;
}

export interface TurnLimitRegistry {
  open(project: string, issue: number, runId: string, maxTurns: number): TurnLimitController;
  extend(project: string, issue: number, maxTurns: number): ExtendTurnLimitResult;
}

/**
 * Authoritative live-run turn controls. Persistence happens synchronously
 * before the in-memory ceiling changes, so no turn event can interleave.
 */
export function createTurnLimitRegistry(
  persist: (runId: string, maxTurns: number) => void,
): TurnLimitRegistry {
  const active = new Map<string, { runId: string; maxTurns: number }>();
  const key = (project: string, issue: number): string => `${project}\0${issue}`;
  return {
    open(project, issue, runId, maxTurns) {
      const k = key(project, issue);
      if (active.has(k)) throw new Error(`#${issue} already has a live turn controller`);
      const entry = { runId, maxTurns };
      active.set(k, entry);
      return {
        maxTurns: () => entry.maxTurns,
        close: () => {
          if (active.get(k) === entry) active.delete(k);
        },
      };
    },
    extend(project, issue, maxTurns) {
      if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
        throw new RangeError(`turn ceiling must be a positive integer, got ${maxTurns}`);
      }
      const entry = active.get(key(project, issue));
      if (entry === undefined) return { kind: "not-active" };
      if (maxTurns <= entry.maxTurns) {
        return { kind: "not-increase", runId: entry.runId, maxTurns: entry.maxTurns };
      }
      persist(entry.runId, maxTurns);
      entry.maxTurns = maxTurns;
      return { kind: "extended", runId: entry.runId, maxTurns };
    },
  };
}

export async function verifyPushedGreenClaim(
  tracker: Pick<Tracker, "verifyPr">,
  claim: Pick<WorkerResult, "prUrl" | "headSha">,
): Promise<{
  state: "pushed-green" | "pushed-pending" | "failed";
  reason?: string;
}> {
  if (claim.prUrl === undefined || claim.headSha === undefined) {
    return { state: "failed", reason: "Worker did not report a PR URL and observed head SHA" };
  }
  const verification = await tracker.verifyPr(claim.prUrl, claim.headSha);
  if (verification === undefined) {
    return { state: "pushed-pending", reason: "GitHub PR verification unavailable; retrying" };
  }
  if (verification.status === "green") return { state: "pushed-green" };
  return {
    state: verification.status === "pending" ? "pushed-pending" : "failed",
    reason: verification.reason,
  };
}

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
  // Hoisted out of the try so the catch path can still name the tree: a crash
  // mid-dispatch is one of the non-graceful ends whose uncommitted work has to
  // be salvaged too, and it is the path least likely to have committed first.
  let worktreePath: string | undefined;
  let turnLimit: TurnLimitController | undefined;

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
      maxTurns: caps.workerMaxTurns,
      startedAt: Date.now(),
    });
    const runId = run.id;
    turnLimit = d.turnLimits.open(project.name, issue, runId, caps.workerMaxTurns);

    // A run's tree is <workspaceRoot>/<issue> and addWorktree refuses to reuse
    // an existing path, so a retry — or a tree kept from a failed attempt — has
    // to be cleared first. Both helpers are pure path math and removeWorktree
    // tolerates a mirror or tree that is not there yet, so this is safe on a
    // first attempt. addWorktree does its own ensureMirror; calling it here too
    // would cost a second network fetch per attempt.
    const mirrorPath = mirrorPathFor(r.repo, project.mirrorRoot);
    await removeWorktree(mirrorPath, worktreePathFor(project.workspaceRoot, issue));
    const provisioned = await addWorktree(
      r.repo,
      project.mirrorRoot,
      project.workspaceRoot,
      issue,
      branch,
    );
    worktreePath = provisioned.path;

    // The SDK names the transcript itself, so the daemon supplies the parent
    // directory and learns the real path back from the result. Inventing one
    // here would put a file that never gets written into an escalation.
    const sessionDir = join(stateDir(), "sessions");
    mkdirSync(sessionDir, { recursive: true });
    store.updateRun(runId, { worktree: worktreePath, state: "running" });

    log(
      `#${issue} attempt ${attempt} → ${r.repo.name} ${branch}` +
        (provisioned.reattached ? " (continuation: reattached existing branch)" : ""),
    );

    let result: WorkerResult;
    try {
      result = await runWorker({
        brief: await buildBrief(project, r, branch, worktreePath, {
          continuation: provisioned.reattached,
          defaultBranch: r.repo.defaultBranch,
        }),
        cwd: worktreePath,
        caps,
        maxTurns: () => turnLimit?.maxTurns() ?? caps.workerMaxTurns,
        sessionDir,
        ...(project.workerModel === undefined ? {} : { model: project.workerModel }),
        releasePolicy: resolveReleasePolicy(project),
        onReleaseBlocked: (shape) => recordReleaseBlock(project.name, "worker", shape),
        onTurn: (n) => store.updateRun(runId, { turns: n }),
        onSpend: (usd) => store.updateRun(runId, { spendUsd: usd }),
        onKilled: () => {
          turnLimit?.close();
          turnLimit = undefined;
        },
        // Recorded the moment the session opens its transcript, not when the run
        // ends: `omp-conductor tail` resolves an issue to a file through this row,
        // and a path written at completion is a path nobody can follow live. The
        // completion-time update below writes the same value again, harmlessly.
        onSessionFile: (f) => store.updateRun(runId, { sessionFile: f }),
      });
    } finally {
      // This is the authoritative settlement edge for `extend`: close before
      // PR verification or terminal row writes can leave stale `running` state.
      turnLimit?.close();
      turnLimit = undefined;
    }

    // A configured model the harness could not honour means this run was done by
    // a different model than the operator chose. Logged per run, because it is
    // the only place that fact is still attached to the issue it affected.
    if (result.modelFallbackMessage !== undefined) {
      log(`#${issue} model fallback: ${result.modelFallbackMessage}`);
    }

    const verified: { state: RunState; reason?: string } =
      result.state === "pushed-green"
        ? await verifyPushedGreenClaim(tracker, result)
        : { state: result.state };
    const state = verified.state;
    const finalReport =
      verified.reason === undefined ? result.report : `${verified.reason}\n\n${result.report}`;

    store.updateRun(runId, {
      state,
      endedAt: Date.now(),
      turns: result.turns,
      spendUsd: result.spendUsd,
      prUrl: result.prUrl,
      headSha: result.headSha,
      sessionFile: result.sessionFile,
      ...(verified.reason === undefined ? {} : { lastError: verified.reason }),
    });

    if (state === "blocked") {
      await swapLabel(tracker, issue, inProgress, project.stateLabels.blocked);
      await safeEscalate(d, {
        tier: 1,
        project: project.name,
        issue,
        runId,
        summary: `#${issue} is blocked on attempt ${attempt} and needs a decision`,
        detail: [`${r.issue.title}`, r.issue.url, "", result.report].join("\n"),
      });
    } else if (state === "failed" || state === "killed") {
      // A turns cap consumes the independent continuation budget, not an
      // implementation-failure attempt. The row is already `killed`, so this
      // count includes the segment that just ended.
      const continuation = store.continuationsFor(project.name, issue);
      const continueTurns =
        result.killedBy === "turns" &&
        hasContinuationBudget(continuation, caps.maxContinuationsPerIssue);
      const salvaged = await salvage(issue, attempt, endedBy(result.killedBy), worktreePath);

      if (continueTurns) {
        await tracker.removeLabel(issue, inProgress);
        await tracker.addLabel(issue, project.queueLabel);
        log(
          `#${issue} turns-cap on run ${attempt}, continuation ` +
            `${continuation}/${caps.maxContinuationsPerIssue} — salvaged and re-queued`,
        );
        await safeEscalate(d, {
          tier: 1,
          project: project.name,
          issue,
          runId,
          summary: `#${issue} hit the turns cap on attempt ${attempt} — auto-requeued for continuation`,
          detail: [
            `${r.issue.title}`,
            r.issue.url,
            ...salvaged,
            `Session: ${result.sessionFile ?? "(no transcript)"}`,
            "",
            "The queue label is back on; the next tick should reattach the branch",
            "and open a continuation brief. No failed label was applied.",
            "",
            result.report,
          ].join("\n"),
        });
      } else {
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
            ...salvaged,
            `Session: ${result.sessionFile ?? "(no transcript)"}`,
            "",
            finalReport,
          ].join("\n"),
        });
      }
    } else {
      // A verified or still-pending PR keeps the in-progress label until its
      // checks or merge settle, preventing another worker from duplicating it.
      log(`#${issue} ${state}${result.prUrl ? ` ${result.prUrl}` : ""}`);
    }

    // A failed or killed tree is evidence — keep it. Anything else is just
    // disk, and the mirror means re-provisioning is cheap. (The kept tree is
    // wiped by the next attempt, not left to accumulate forever.)
    if (state !== "failed" && state !== "killed") {
      await removeWorktree(mirrorPath, worktreePath);
    }
  } catch (err) {
    // Dispatch setup can fail after the controller opens but before runWorker's
    // inner settlement guard exists. Latch it before any terminal write or await.
    turnLimit?.close();
    turnLimit = undefined;
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
    // A crash lands anywhere, including mid-edit in a tree holding the only
    // copy of real work. Nothing else on this path so much as looks at it.
    const salvaged =
      worktreePath === undefined
        ? []
        : await salvage(issue, attempt, "a dispatch error", worktreePath);

    await safeEscalate(d, {
      tier: 1,
      project: project.name,
      issue,
      runId: run?.id,
      summary: `#${issue} could not be dispatched on attempt ${attempt}`,
      detail: salvaged.length === 0 ? detail : [detail, "", ...salvaged].join("\n"),
    });
    // The worktree, if one was created, is deliberately left in place: this is
    // a failure path, and whatever it still held is now a commit on the branch.
  } finally {
    turnLimit?.close();
  }
}

// ------------------------------------------------------------------- settlement

/** What a resolved PR turns its `pushed-green` row into. */
export interface Settlement {
  state: "merged" | "failed";
  /** The log line after `#<n> settled: `, and — for a rejection — the row's own
   *  `lastError`, because a `failed` row whose worker succeeded has to say so. */
  reason: string;
}

/**
 * What one `pushed-green` row becomes now its PR has an answer, or undefined to
 * leave the row exactly as it is.
 *
 * A `pushed-green` row is the only one nothing ever revisited: the worker is
 * finished, `reconcileOrphanedRuns` only settles rows that held a process, and
 * `merged` went unwritten from day one. So they accumulated — three of them on
 * the reference fleet on 2026-08-07, every PR merged and every issue closed,
 * with `/healthz` still reporting three active runs and their issues
 * permanently unclaimable, because the busy set *is* the active set (#18).
 *
 * The mapping, and why each answer is the only honest one:
 *
 * - `merged` — the work landed. That is what `merged` was reserved for.
 * - `closed` — a human read the work and said no. Leaving it `pushed-green`
 *   strands the issue forever behind a PR nobody will ever merge, and calling it
 *   `merged` is simply a lie about work that does not exist on the base branch.
 *   `failed` is true — the attempt did not land — and it releases the busy guard,
 *   so an issue a human re-queues can be attempted again. The attempt counter is
 *   untouched either way: this row was a real attempt, and pretending otherwise
 *   would let a rejected issue cycle past `maxAttemptsPerIssue`.
 * - `open`, and undefined — nothing changes. Undefined is "could not tell": a
 *   flaky network, a revoked token, a deleted PR. Settling on it would record a
 *   merge that never happened, and the next tick asks again for free. An
 *   ambiguous answer must never settle a row.
 */
export function settlementFor(pr: PrState | undefined, prUrl: string): Settlement | undefined {
  if (pr === "merged") return { state: "merged", reason: `${prUrl} merged` };
  if (pr === "closed") return { state: "failed", reason: `${prUrl} closed without merging` };
  return undefined;
}

/**
 * Asks the tracker about every `pushed-green` PR and settles the ones that
 * resolved.
 *
 * Effects at the call site, decision in {@link settlementFor} — the same split
 * as `checkIntegrity`/`watchOrchestrator`. Exported like `admitCandidates`
 * rather than kept private, because half of what has to hold is about the sweep
 * and not the mapping: that a row without a PR costs no API call, and that one
 * unreachable PR does not stop the others from settling.
 *
 * Tracker labels are deliberately not touched, exactly as
 * {@link reconcileOrphanedRuns} does not touch them. A merge normally closes the
 * issue, and a human who closed a PR is already looking at it; deciding what an
 * issue's labels should say next is the orchestrator's drain duty, which reads
 * these very rows through `omp-conductor status`.
 */
export async function settlePushedGreen(
  d: Pick<Deps, "project" | "tracker" | "store">,
): Promise<void> {
  const { project, tracker, store } = d;
  // Filtered from the active set rather than asked for with a new query: active
  // is live workers plus these, so the list is bounded by the worker cap plus
  // the number of PRs awaiting a merge — a handful, by construction. A fleet
  // where that is not a handful has a merge problem, not a dispatch one.
  const pending = store
    .activeRuns(project.name)
    .filter((r) => r.state === "pushed-green" || r.state === "pushed-pending");

  for (const run of pending) {
    // Nothing to ask about. A pushed result requires a PR, so a malformed row
    // must not buy a `gh` call every five minutes forever.
    if (run.prUrl === undefined) continue;

    let pr: PrState | undefined;
    try {
      pr = await tracker.prState(run.prUrl);
    } catch (err) {
      // Per row, like admission's held candidate. The GitHub adapter already
      // answers undefined instead of throwing, so this catch is the port's
      // contract rather than that adapter's behaviour — and a tracker that does
      // throw must cost its own row, not the whole sweep.
      log(`#${run.issue} not settled: PR state lookup failed (${errText(err)}) — retrying next tick`);
      continue;
    }

    const settlement = settlementFor(pr, run.prUrl);
    if (settlement !== undefined) {
      const patch: Partial<RunRecord> = { state: settlement.state, endedAt: Date.now() };
      if (settlement.state === "failed") patch.lastError = settlement.reason;
      store.updateRun(run.id, patch);
      log(`#${run.issue} settled: ${settlement.reason}`);
      continue;
    }

    if (run.state !== "pushed-pending" || pr !== "open" || run.headSha === undefined) continue;
    let verification;
    try {
      verification = await tracker.verifyPr(run.prUrl, run.headSha);
    } catch (err) {
      log(`#${run.issue} checks not settled (${errText(err)}) — retrying next tick`);
      continue;
    }
    if (verification === undefined) continue;
    if (verification.status === "green") {
      store.updateRun(run.id, { state: "pushed-green", lastError: undefined });
      log(`#${run.issue} checks settled: ${verification.reason}`);
    } else if (verification.status === "failed") {
      store.updateRun(run.id, { state: "failed", lastError: verification.reason });
      log(`#${run.issue} checks failed: ${verification.reason}`);
    } else {
      store.updateRun(run.id, { lastError: verification.reason });
    }
  }
}

// -------------------------------------------------------------------- admission

/** A candidate cleared for dispatch, with the attempt number it will run as. */
export interface Admission {
  r: Routed;
  attempt: number;
}

export interface AdmissionHold {
  issue: number;
  reason: AdmissionHoldReason;
}

export interface AdmissionPass {
  admitted: Admission[];
  holds: AdmissionHold[];
}

const HOLD_SAMPLE_SIZE = 5;
const DEGRADED_HOLDS: ReadonlySet<AdmissionHoldReason> = new Set([
  "parent-lookup-error",
  "open-pr-lookup-error",
]);

/** Groups transient decisions into the bounded record exposed by status. */
export function summarizeDispatch(
  ready: number,
  routed: number,
  admitted: number,
  holds: readonly AdmissionHold[],
  completedAt = Date.now(),
): DispatchSummary {
  const groups = new Map<AdmissionHoldReason, { count: number; issues: number[] }>();
  for (const hold of holds) {
    const group = groups.get(hold.reason) ?? { count: 0, issues: [] };
    group.count += 1;
    if (group.issues.length < HOLD_SAMPLE_SIZE) group.issues.push(hold.issue);
    groups.set(hold.reason, group);
  }
  return {
    completedAt,
    ready,
    routed,
    admitted,
    degraded: holds.some((hold) => DEGRADED_HOLDS.has(hold.reason)),
    holds: [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, group]) => ({ reason, ...group })),
  };
}

/**
 * Which routed candidates get a worker this tick — in queue order, never more
 * than `slots` of them. Every non-admission receives a stable reason code.
 *
 * Exported so the admission rules can be pinned without spawning a worker.
 * Every one of them exists because of a live incident, and each guards a
 * different way the same issue gets worked twice — including epic siblings
 * racing onto the same files (#48).
 *
 * Takes the slice of `Deps` it actually reads rather than the whole thing: what
 * admission is allowed to consult is the point of the function, and a `Deps`
 * that grows a field has no business breaking these tests.
 */
export async function admitCandidates(
  d: Pick<Deps, "project" | "caps" | "tracker" | "store" | "escalate">,
  routed: Routed[],
  slots: number,
): Promise<AdmissionPass> {
  const { project, caps, tracker, store } = d;
  const busyIssues = store.activeRuns(project.name).map((r) => r.issue);
  const busy = new Set(busyIssues);
  const holds: AdmissionHold[] = [];
  const hold = (issue: number, reason: AdmissionHoldReason): void => {
    holds.push({ issue, reason });
  };

  // parent -> blocking issue. Seeded from active runs (including pushed-green),
  // then extended by candidates admitted earlier in this same pass so two
  // siblings never both clear the gate in one tick.
  const occupiedParents = new Map<number, number>();
  const parentCache = new Map<number, number | undefined>();

  const resolveParent = async (issue: number): Promise<number | undefined> => {
    if (parentCache.has(issue)) return parentCache.get(issue);
    const parent = await tracker.parentOf(issue);
    parentCache.set(issue, parent);
    return parent;
  };

  // Bounded by concurrent workers, not queue depth. A failed lookup here cannot
  // mark an epic occupied; candidates still fail closed on their own parentOf.
  for (const issue of busyIssues) {
    try {
      const parent = await resolveParent(issue);
      if (parent !== undefined && !occupiedParents.has(parent)) {
        occupiedParents.set(parent, issue);
      }
    } catch (err) {
      log(`#${issue} parent lookup failed while seeding epic occupancy (${errText(err)})`);
    }
  }

  const admitted: Admission[] = [];
  for (const r of routed) {
    const issue = r.issue.number;
    if (admitted.length >= slots) {
      hold(issue, "capacity");
      continue;
    }
    if (busy.has(issue)) {
      hold(issue, "issue-active");
      continue;
    }

    const priorRuns = store.attemptsFor(project.name, issue);
    const failures = store.failuresFor(project.name, issue);
    if (failures >= caps.maxAttemptsPerIssue) {
      hold(issue, "failed-attempts");
      await safeEscalate(d, {
        tier: 1,
        project: project.name,
        issue,
        summary: `#${issue} has used all ${caps.maxAttemptsPerIssue} failed attempts`,
        detail: [
          r.issue.title,
          r.issue.url,
          "Another implementation attempt almost always means the issue itself is underspecified.",
          "Rewrite the acceptance criteria, or take it off the queue.",
        ].join("\n"),
      });
      continue;
    }

    const continuations = store.continuationsFor(project.name, issue);
    if (!hasContinuationBudget(continuations, caps.maxContinuationsPerIssue)) {
      hold(issue, "continuations");
      await safeEscalate(d, {
        tier: 1,
        project: project.name,
        issue,
        summary: `#${issue} exceeded its ${caps.maxContinuationsPerIssue}-continuation budget`,
        detail: [
          r.issue.title,
          r.issue.url,
          "Repeated cap kills, daemon orphans, or answered blocks need an operator to inspect progress.",
        ].join("\n"),
      });
      continue;
    }

    // Soft concurrency per epic: at most one in-flight child of a given parent.
    // No parent means today's concurrent admission. Cheap local filters already
    // ran; this sits before the open-PR API call so a held sibling frees the
    // slot for unrelated work without spending a closers query.
    let parent: number | undefined;
    try {
      parent = await resolveParent(issue);
    } catch (err) {
      hold(issue, "parent-lookup-error");
      log(`#${issue} held: parent check failed (${errText(err)}) — retrying next tick`);
      continue;
    }
    if (parent !== undefined) {
      const blocker = occupiedParents.get(parent);
      if (blocker !== undefined) {
        hold(issue, "sibling-active");
        log(`#${issue} skipped: sibling #${blocker} in flight under epic #${parent}`);
        continue;
      }
    }

    // The busy set is built from run rows, so it can only speak for work this
    // database recorded. Work pushed before this store existed — a migration, a
    // wiped or relocated state dir, a restore onto a new host — looks exactly
    // like fresh work, and a worker sent at it re-implements a finished PR. The
    // tracker is the only party that remembers, so it is asked. The cost is
    // bounded by free slots, not by queue depth: the call sits behind the two
    // cheap local filters and candidates beyond capacity skip it.
    let closer: string | undefined;
    try {
      closer = await tracker.openCloserFor(issue);
    } catch (err) {
      // Fail closed, per candidate. An API error means "unknown whether
      // finished work exists", and admitting on unknown recreates precisely the
      // duplicate-work failure this guard exists to kill: the worst case of
      // holding is a five-minute delay, the worst case of admitting is a burned
      // attempt and a second PR on the same issue. Holding one candidate rather
      // than aborting the loop keeps a transient GitHub failure from deadlocking
      // the whole dispatcher; the next tick retries by itself.
      hold(issue, "open-pr-lookup-error");
      log(`#${issue} held: open-PR check failed (${errText(err)}) — retrying next tick`);
      continue;
    }
    if (closer !== undefined) {
      hold(issue, "open-pr");
      log(`#${issue} skipped: open PR ${closer} already closes it`);
      continue;
    }

    admitted.push({ r, attempt: priorRuns + 1 });
    if (parent !== undefined) occupiedParents.set(parent, issue);
  }

  return { admitted, holds };
}

export interface WorkerPool {
  launch(work: Promise<void>): void;
  activeCount(): number;
  drain(): Promise<void>;
}

/** Keeps background workers alive without making the five-minute tick await them. */
export function createWorkerPool(): WorkerPool {
  const active = new Set<Promise<void>>();
  return {
    launch(work) {
      active.add(work);
      void work.then(
        () => active.delete(work),
        () => active.delete(work),
      );
    },
    activeCount: () => active.size,
    async drain() {
      await Promise.allSettled(active);
    },
  };
}

/** `--once` awaits workers; the resident daemon registers them for shutdown. */
export async function dispatchAdmissions(
  admitted: readonly Admission[],
  run: (admission: Admission) => Promise<void>,
  pool?: WorkerPool,
): Promise<void> {
  if (pool !== undefined) {
    for (const admission of admitted) pool.launch(run(admission));
    return;
  }
  await Promise.allSettled(admitted.map(run));
}

// ----------------------------------------------------------------------- a tick

export async function tick(d: Deps, workers?: WorkerPool): Promise<void> {
  // Before the pause check, deliberately. This one is not about dispatch: the
  // orchestrator is a different process, and it can be wedged while this fleet
  // is paused — which is exactly the state the reference fleet was in when the
  // failure happened. A pause silences claiming, not the operator's right to
  // know their supervising session stopped reading its queue.
  await watchOrchestrator(d);

  // A paused fleet claims nothing. Checked first so pausing takes effect on the
  // next tick without signalling the process.
  if (isPaused()) return;

  const { project, caps, store } = d;

  // "Nobody patches the running conductor" is a hard boundary in both briefs —
  // which makes it prompt text, and prompt text is a request. This is the half
  // that does not negotiate: the package that dispatched the last worker must
  // still be the package on disk, or nothing else this tick does is
  // attributable. A legitimate deploy never trips it, because installing a new
  // build and restarting the unit re-records the baseline from the new files;
  // only an edit *underneath* a live daemon diverges from it.
  //
  // Below the pause gate on purpose, unlike the stall watch above. The property
  // being defended is that no work is dispatched under a package the operator
  // did not install — and a paused fleet dispatches nothing, so nothing needs
  // attributing yet. Tampering during a pause is not missed, only deferred: the
  // baseline is boot's, so the first tick after `resume` compares against it and
  // pauses again before claiming anything. Checking above the gate instead would
  // page on every legitimate build an operator deploys into a parked fleet,
  // which is exactly when they deploy them.
  const integrity = checkIntegrity(d.integrity, packageManifest());
  if (integrity.pause) {
    const shown = integrity.diff.slice(0, INTEGRITY_SAMPLE);
    log(
      `ERROR: the installed conductor changed under this daemon — ${integrity.diff.length} file(s) differ ` +
        `(${shown.join(", ")}${integrity.diff.length > shown.length ? ", …" : ""}) — pausing`,
    );
    setPaused(true);
    if (integrity.page) {
      const delivered = await safeEscalate(d, {
        tier: 2,
        project: project.name,
        issue: NO_ISSUE,
        // Dated for the same reason the spend cap is: the dedup key is the
        // summary, and a second tamper months later must not be swallowed as a
        // repeat of the first.
        summary:
          `Installed conductor changed under a running daemon on ${new Date().toISOString().slice(0, 10)}: ` +
          `${integrity.diff.length} file(s) differ (first: ${integrity.diff[0]}) — ${project.name} is paused`,
        detail: [
          `Package root: ${import.meta.dir}`,
          ...shown,
          ...(integrity.diff.length > shown.length ? [`… and ${integrity.diff.length - shown.length} more`] : []),
          "",
          "If you deployed a new build, restart the daemon — the restart re-records the baseline.",
          "If you did not, the host edited itself while it was dispatching work: treat every run since",
          "the last known-good restart as unattributable before resuming.",
          "`omp-conductor resume` alone will not hold — the next tick re-pauses while the files differ.",
        ].join("\n"),
      });
      markPaged(d.integrity, delivered);
    }
    return;
  }

  // Above admission on purpose: a row settled this tick frees its issue for
  // this same tick, so a merge and a re-queue no longer cost five minutes each.
  // Above the spend cap too, which returns early — settling is bookkeeping about
  // work already paid for, and a fleet that halts itself is exactly when an
  // operator reads `status` and needs it to be true.
  await settlePushedGreen(d);

  // route() filters the queue through isEligible() itself, so anything already
  // carrying a state label is gone before it gets here.
  const ready = await d.tracker.listReady();
  const { routed, unroutable } = route(ready, project);
  const routingHolds: AdmissionHold[] = unroutable.map((u) => ({
    issue: u.issue.number,
    reason: `unroutable:${u.reason}`,
  }));
  const recordDispatch = (admitted: number, holds: readonly AdmissionHold[]): void => {
    store.recordDispatch(
      project.name,
      summarizeDispatch(ready.length, routed.length, admitted, holds),
    );
  };

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
  // notice tomorrow is how a runaway becomes expensive. `null` means the
  // operator opted out — turns and wall-clock still brake every run (#46).
  const spent = store.spendSince(project.name, since);
  if (caps.dailySpendUsd !== null && spent >= caps.dailySpendUsd) {
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
    recordDispatch(0, [
      ...routingHolds,
      ...routed.map((r) => ({ issue: r.issue.number, reason: "daily-spend-cap" as const })),
    ]);
    return;
  }

  // Two different questions, deliberately two queries. Capacity counts worker
  // *processes*, so a green PR awaiting a human merge must not consume a slot —
  // two of those would otherwise stop the fleet. That same PR's *issue* must
  // still be occupied, which is what `admitCandidates`' busy set is for.
  const live = store.liveRuns(project.name);
  const slots = caps.maxConcurrentWorkers - live.length;
  if (slots <= 0) {
    log(`at capacity: ${live.length}/${caps.maxConcurrentWorkers} workers`);
    recordDispatch(0, [
      ...routingHolds,
      ...routed.map((r) => ({ issue: r.issue.number, reason: "capacity" as const })),
    ]);
    return;
  }

  const pass = await admitCandidates(d, routed, slots);
  recordDispatch(pass.admitted.length, [...routingHolds, ...pass.holds]);

  if (pass.admitted.length === 0) return;

  log(`dispatching ${pass.admitted.map((a) => `#${a.r.issue.number}`).join(" ")}`);
  await dispatchAdmissions(
    pass.admitted,
    (a) => handleIssue(d, a.r, a.attempt),
    workers,
  );
}

// --------------------------------------------------------------- read-only views

export interface DaemonHealthSnapshot {
  ok: true;
  paused: boolean;
  activeRuns: number;
  project: string;
  /** Resident set of this daemon; workers are in-process omp sessions. */
  rssBytes: number;
  dispatch?: DispatchSummary;
}

export function daemonHealthSnapshot(
  store: Store,
  project: string,
  paused = isPaused(),
  rssBytes = process.memoryUsage().rss,
): DaemonHealthSnapshot {
  const dispatch = store.latestDispatch(project);
  return {
    ok: true,
    paused,
    activeRuns: store.activeRuns(project).length,
    project,
    rssBytes,
    ...(dispatch === undefined ? {} : { dispatch }),
  };
}

export async function turnLimitResponse(
  req: Request,
  project: string,
  store: Pick<Store, "latestRun">,
  registry: TurnLimitRegistry,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const match = /^\/runs\/(\d+)\/turn-limit$/.exec(url.pathname);
  if (req.method !== "PUT" || match === null) return undefined;
  if (!req.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "content-type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  if (body === null || typeof body !== "object") {
    return Response.json({ error: "request body must be a JSON object" }, { status: 400 });
  }
  const requestedProject = Reflect.get(body, "project");
  if (typeof requestedProject !== "string" || requestedProject.length === 0) {
    return Response.json({ error: "project must be a non-empty string" }, { status: 400 });
  }
  if (requestedProject !== project) {
    return Response.json(
      { error: `daemon serves project "${project}", not requested project "${requestedProject}"` },
      { status: 409 },
    );
  }
  const maxTurns = Reflect.get(body, "maxTurns");
  if (!Number.isSafeInteger(maxTurns) || (maxTurns as number) < 1) {
    return Response.json({ error: "maxTurns must be a positive integer" }, { status: 400 });
  }

  const issue = Number(match[1]);
  const outcome = registry.extend(project, issue, maxTurns as number);
  if (outcome.kind === "extended") return Response.json(outcome);
  if (outcome.kind === "not-increase") {
    return Response.json(
      { error: `#${issue} already has a ${outcome.maxTurns}-turn ceiling` },
      { status: 409 },
    );
  }

  const latest = store.latestRun(project, issue);
  if (latest === undefined) {
    return Response.json({ error: `no run recorded for #${issue}` }, { status: 404 });
  }
  return Response.json(
    {
      error:
        `#${issue} has no live worker controller; its session already settled ` +
        `or belongs to another daemon (stored state: ${latest.state})`,
    },
    { status: 409 },
  );
}

export interface StatusSnapshot {
  project: string;
  configPath: string;
  stateDir: string;
  paused: boolean;
  caps: Caps;
  /** Occupied issues: live workers plus green PRs awaiting a human merge. */
  activeRuns: RunRecord[];
  /** Runs backed by a worker process — the number capacity compares against. */
  liveWorkers: number;
  runsToday: number;
  spendTodayUsd: number;
  dispatch?: DispatchSummary;
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
    const dispatch = store.latestDispatch(p.name);
    return {
      project: p.name,
      configPath: configPath(),
      stateDir: stateDir(),
      paused: isPaused(),
      caps: resolveCaps(p, cfg.defaults),
      activeRuns: store.activeRuns(p.name),
      liveWorkers: store.liveRuns(p.name).length,
      runsToday: store.runsStartedSince(p.name, since),
      spendTodayUsd: store.spendSince(p.name, since),
      ...(dispatch === undefined ? {} : { dispatch }),
    };
  } finally {
    store.close();
  }
}

export function formatDispatchSummary(summary?: DispatchSummary): string {
  if (summary === undefined) return "last dispatch  (none recorded)";
  const lines = [
    `last dispatch  ${new Date(summary.completedAt).toISOString()}${summary.degraded ? "  DEGRADED" : ""}`,
    `  candidates    ${summary.ready} ready / ${summary.routed} routed`,
    `  admitted      ${summary.admitted}`,
  ];
  if (summary.holds.length === 0) {
    lines.push("  held          0");
  } else {
    lines.push("  held");
    for (const hold of summary.holds) {
      const sample =
        hold.issues.length === 0
          ? ""
          : ` (#${hold.issues.join(", #")}${hold.count > hold.issues.length ? ", …" : ""})`;
      lines.push(`    ${hold.reason}  ${hold.count}${sample}`);
    }
  }
  return lines.join("\n");
}

export function formatStatus(s: StatusSnapshot): string {
  const lines = [
    `project   ${s.project}${s.paused ? "  (PAUSED)" : ""}`,
    `config    ${s.configPath}`,
    `state     ${s.stateDir}`,
    "",
    "caps",
    `  workers            ${s.liveWorkers} / ${s.caps.maxConcurrentWorkers}`,
    `  issues today       ${s.runsToday}`,
    s.caps.dailySpendUsd === null
      ? `  spend today        $${s.spendTodayUsd.toFixed(2)} (no daily cap)`
      : `  spend today        $${s.spendTodayUsd.toFixed(2)} / $${s.caps.dailySpendUsd.toFixed(2)}`,
    `  new worker turns   ${s.caps.workerMaxTurns}`,
    `  worker wall clock  ${Math.round(s.caps.workerWallClockMs / 60_000)}m`,
    `  failed attempts    ${s.caps.maxAttemptsPerIssue}`,
    `  continuations      ${s.caps.maxContinuationsPerIssue}`,
    "",
    formatDispatchSummary(s.dispatch),
    "",
  ];
  if (s.activeRuns.length === 0) {
    lines.push("active runs  (none)");
  } else {
    lines.push("active runs");
    for (const r of s.activeRuns) {
      lines.push(
        `  #${r.issue}  ${r.repo}  ${r.state}  attempt ${r.attempt}  ` +
          `${r.turns}/${r.maxTurns} turns  $${r.spendUsd.toFixed(2)}  ${r.branch}` +
          (r.prUrl ? `  ${r.prUrl}` : ""),
      );
    }
  }
  // Deploy hint: a restart while workers are live orphans them (salvage runs
  // first — #35). Prefer pause + drain to zero live workers when you can wait.
  if (s.liveWorkers > 0) {
    lines.push(
      "",
      `deploy    ${s.liveWorkers} live worker(s) — restart salvages dirty trees then orphans the rows; ` +
        `pause and wait for workers 0/${s.caps.maxConcurrentWorkers} when you can drain instead`,
    );
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

/**
 * Settles `claimed`/`running` rows left by a dead daemon process and, before
 * marking each one `orphaned`, salvages any dirty worktree.
 *
 * Found live after a host restart killed two workers mid-run, and again on
 * every package deploy that restarted while workers were live (#35): without
 * the salvage call the next attempt's `worktree remove --force` destroyed
 * uncommitted edits that had no other copy. Cap-kills already salvaged (#27);
 * this is the same call site for the restart path.
 *
 * Only the rows change. The issue keeps its in-progress label — that label is
 * the crash guard against double-dispatch, and deciding what a dead worker's
 * remains are worth (an open PR? a salvaged sha? a clean tree?) is the
 * orchestrator's drain-duty judgement, not something to automate here. The
 * rows also keep counting toward `maxAttemptsPerIssue`, so a loop of deaths
 * still escalates instead of retrying forever.
 *
 * `pushed-green` rows are deliberately left alone: they hold no process — they
 * are finished work waiting on a human merge, and they must keep occupying the
 * issue so a second attempt cannot land on a live PR. What eventually settles
 * them is {@link settlePushedGreen}, on the tick, by asking the tracker what
 * became of the PR — the one question a restart cannot answer by inference.
 */
export async function reconcileOrphanedRuns(
  store: Store,
  project: string,
): Promise<RunRecord[]> {
  // Live runs only: `pushed-green` holds no process, so it cannot be orphaned by
  // a process dying — it is finished work waiting on a human merge.
  const stale = store.liveRuns(project);
  const endedAt = Date.now();
  for (const r of stale) {
    // Salvage before the row flips: the worktree path is on the record, and
    // salvageWip is a no-op for a missing/clean tree. Reason string matches
    // the cap-kill wording so triage reads the same either way.
    if (r.worktree !== "") {
      await salvage(r.issue, r.attempt, "a daemon restart", r.worktree);
    }
    store.updateRun(r.id, { state: "orphaned", endedAt });
  }
  return stale;
}

// ------------------------------------------------------------------- the daemon

export async function runDaemon(o: DaemonOpts = {}): Promise<void> {
  const cfg = loadConfig();
  const project = findProject(cfg, o.project);
  const caps = resolveCaps(project, cfg.defaults);
  const store = openStore(dbPath());
  const tracker = makeTracker(project);

  // Recorded here, before a single tick runs, so that the deploy an operator
  // *means* to do never trips the tripwire: installing a new build and
  // restarting the unit re-records this from the new files. What it catches is
  // the other thing — the package changing while the daemon that dispatches
  // work is holding it open, whether that is a worker that wandered out of its
  // worktree or a human editing the live install "just to test something".
  const integrity: IntegrityGate = { baseline: packageManifest(), paged: false };
  log(`package integrity baseline: ${integrity.baseline.size} files under ${import.meta.dir}`);

  // Before the first tick, settle what the last process left behind — unless
  // another daemon is alive (a foreground `daemon --once` beside a running
  // daemon must not orphan that daemon's real, live workers).
  const alive = livingDaemon();
  if (alive === undefined || alive.pid === process.pid) {
    for (const r of await reconcileOrphanedRuns(store, project.name)) {
      log(
        `#${r.issue} orphaned by a previous daemon (attempt ${r.attempt}, was ${r.state}, worktree ${r.worktree}) — ` +
          `slot freed; the ${project.stateLabels.inProgress} label stays until the orchestrator triages what the worker left`,
      );
    }
  } else {
    log(`skipping orphan reconciliation: daemon pid ${alive.pid} is alive and owns the active runs`);
  }

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
    "tier 2 and let the human decide.",
    // Worded from `authority.merge` rather than fixed, so the standing orders
    // and the Releases section of the rendered brief cannot disagree about who
    // is holding the merge button. The daemon still merges nothing itself.
    project.authority.merge === "orchestrator"
      ? "You never edit product code or push a branch — a worker session does that. Merging is yours: one PR at " +
        "a time, freshness-checked against the base branch, per the Releases section of your POLICY.md."
      : "You never edit product code, push a branch, or merge a PR — a worker session edits and pushes, and a " +
        "human merges.",
    `Release tool gate: releasePolicy=${resolveReleasePolicy(project)}. ` +
      (resolveReleasePolicy(project) === "none"
        ? "Release and deploy tool calls are mechanically blocked."
        : "Release and deploy tool calls are permitted only by the operator brief."),
    "Handle each escalation below before the next one.",
  ].join("\n");

  // One orchestrator per daemon run, not per tick: it is a persistent session
  // whose whole value is remembering what it has already escalated, and a fresh
  // one every five minutes would remember nothing. Its cwd is the state
  // directory, deliberately not a checkout — the orchestrator re-briefs workers
  // and talks to the tracker, it does not edit product code.
  let orchestrator: OrchestratorHandle | undefined;
  if (project.escalation.orchestrator === "external") {
    // An operator already runs the brain — typically a visible TUI session that
    // drains `blocked`/`failed` off the tracker as one of its standing duties.
    // Starting a second one here would re-triage the same issues from a
    // transcript nobody is watching, and the two would undo each other.
    log("orchestrator: external — tier-1 escalations post as issue comments for the external session's drain duty");
  } else {
    try {
      orchestrator = await startOrchestrator({
        cwd: stateDir(),
        brief,
        releasePolicy: resolveReleasePolicy(project),
        onReleaseBlocked: (shape) => recordReleaseBlock(project.name, "orchestrator", shape),
      });
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
  }

  const escalator = createEscalator(project, tracker, store, orchestrator);
  const turnLimits = createTurnLimitRegistry((runId, maxTurns) => {
    store.updateRun(runId, { maxTurns });
  });
  const d: Deps = {
    project,
    caps,
    tracker,
    store,
    escalate: (e) => escalator.escalate(e),
    turnLimits,
    integrity,
    // Fresh per daemon run, like the integrity gate: a restart is entitled to
    // page again about a stall that is still on disk.
    stall: { paged: false },
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

  const workers = createWorkerPool();
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    log("shutting down after active workers finish");
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: o.port ?? DEFAULT_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json(daemonHealthSnapshot(store, project.name));
      }
      const control = await turnLimitResponse(req, project.name, store, turnLimits);
      return control ?? new Response("not found\n", { status: 404 });
    },
  });
  log(`serving /healthz on :${server.port}, project ${project.name}`);

  try {
    while (!stopping) {
      try {
        await tick(d, workers);
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
    await workers.drain();
    await server.stop(true);
    // Before the store closes: a queued injection that rejects on the way out
    // falls back to an issue comment, and that path writes the dedup marker.
    await orchestrator?.dispose();
    store.close();
    log("stopped");
    // A handled SIGTERM still leaves some runtimes with a non-zero default
    // (historically 128+signal). Under systemd `Restart=on-failure` that looks
    // like a crash and the unit comes straight back — the exact failure mode
    // `omp-conductor stop` hit on the reference fleet. Force success so a
    // graceful drain is not a restart.
    process.exitCode = 0;
  }
}
