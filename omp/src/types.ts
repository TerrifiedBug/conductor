/**
 * Shared contract for omp-conductor.
 *
 * Every later slice (tracker adapters, the store, the dispatcher loop, the
 * worker driver, the plugin and the CLI) imports from here and nothing else,
 * so this file stays free of imports and runtime code — the single exception
 * is `DEFAULT_CAPS`, which is data, not behaviour.
 */

/**
 * Hard limits enforced in code, never by the model. A worker that is asked to
 * respect a budget will eventually talk itself out of it, so the dispatcher
 * counts turns, wall clock and dollars itself and kills anything over the line.
 */
export interface Caps {
  /** Parallel omp sessions. Two by default: on a small self-hosted runner pool
   *  a third worker would starve its own PR checks. */
  maxConcurrentWorkers: number;
  /**
   * Rolling-day spend ceiling. `null` means no spend gate (turns + wall-clock
   * still apply). `0` is a hard stop — deliberate, not "unset".
   */
  dailySpendUsd: number | null;
  /** Turn ceiling for one worker — catches loops that are burning tokens
   *  without converging. */
  workerMaxTurns: number;
  /** Wall-clock ceiling for one worker (90 min): a session that is merely
   *  stuck spends no turns, so turns alone cannot detect it. */
  workerWallClockMs: number;
  /** Retries per issue before it escalates (2): one clean retry recovers from
   *  flaky CI, a third almost always means the issue itself is underspecified. */
  maxAttemptsPerIssue: number;
}

/**
 * One module checkout a routed issue can target. A project is usually several
 * repos (module images, shared packages), and the dispatcher must know how to
 * clone and validate each one without asking the model.
 */
export interface RepoTarget {
  /** Short routing key that appears in the issue label, e.g. "api". */
  name: string;
  cloneUrl: string;
  /** Branch worktrees are cut from and PRs target. */
  defaultBranch: string;
  /**
   * Exact cheap pre-push commands CI also runs, with the cwd each runs from.
   * Running the real gate locally is what makes an unattended push safe — a
   * subset lets lint errors outside the source dir reach the runners.
   */
  gates: { cmd: string; cwd: string }[];
  /**
   * Absolute path of the **conductor-owned, index-only clone** of this repo
   * whose code-graph index workers query. Optional: absent means this repo has
   * no graph, and the worker brief says nothing about one.
   *
   * Two things it deliberately is not, and both were paid for:
   *
   * - **Not a worker's worktree.** A code-graph index is keyed by the realpath
   *   of the directory it was built from, with no git-worktree awareness, so a
   *   run's throwaway `worktrees/<issue>` path is always an empty project. A
   *   worker that queried its own cwd would find nothing, conclude there is no
   *   graph, and go back to grepping — which is the entire cost this field
   *   exists to remove.
   * - **Not a human's checkout.** Refreshing an index means hard-resetting the
   *   clone to its default branch. Doing that where somebody works destroys
   *   their uncommitted edits; making it safe instead (a fast-forward pull)
   *   means the graph reflects whatever feature branch they left checked out.
   *   So this names a disposable clone nothing human ever edits, which is what
   *   makes the reset both safe and deterministic.
   *
   * `omp-conductor graph-setup` prints how to create and refresh it. Nothing in
   * this package reads an index itself: the daemon only passes this path into
   * the worker brief.
   */
  graphProject?: string;
}

/**
 * How much the orchestrator says out loud without being asked. Declared as data
 * so the validator, the wizard and the brief all enumerate the same two values:
 * a third scope cannot be added while one of them still knows only two.
 */
export const REPORT_SCOPES = ["escalations", "material"] as const;

export type ReportScope = (typeof REPORT_SCOPES)[number];

/**
 * What a project that never answered the question gets. `material` rather than
 * `escalations` because a config written before this key existed was serviced by
 * a brief that reported material events, and quietly muting an existing fleet is
 * the kind of change nobody notices until the week it mattered.
 */
export const DEFAULT_REPORT_SCOPE: ReportScope = "material";

/**
 * Who holds an authority the daemon itself never exercises. Declared as data
 * for the same reason as {@link REPORT_SCOPES}: the validator, the wizard and
 * the brief renderer all enumerate the same two holders, so a third one cannot
 * be added while any of them still knows only two.
 */
export const AUTHORITY_HOLDERS = ["human", "orchestrator"] as const;

export type AuthorityHolder = (typeof AUTHORITY_HOLDERS)[number];

/**
 * What a project that never answered the question gets: humans keep both. A
 * default that delegated merging would hand a fresh fleet write access to its
 * own main branch on the strength of an unread config file.
 */
export const DEFAULT_AUTHORITY: ProjectConfig["authority"] = { merge: "human", release: "human" };

/**
 * Where the session that triages escalations lives. `embedded` is the daemon's
 * own child session; `external` means an operator already runs one — a visible
 * TUI session, say — and the daemon must not start a second brain that would
 * re-triage the same issues from a different transcript.
 */
export const ORCHESTRATOR_MODES = ["embedded", "external"] as const;

export type OrchestratorMode = (typeof ORCHESTRATOR_MODES)[number];

/**
 * Everything the dispatcher needs to service one product: where work comes
 * from, where code goes, and what it may spend doing it. Config is per project
 * so unrelated products cannot consume each other's budget.
 */
export interface ProjectConfig {
  name: string;
  /** Issue source. Kind is pinned to "github" today but kept explicit so a
   *  second tracker is a config change rather than a schema change. */
  tracker: { kind: "github"; repo: string };
  /** The one label that means "a human has signed this off as agent-ready". */
  queueLabel: string;
  /** Labels the dispatcher writes back so the tracker alone shows live state
   *  to a human who never opens the daemon's logs. */
  stateLabels: { inProgress: string; blocked: string; failed: string };
  /** Maps a `${labelPrefix}${name}` label on an issue to the checkout it
   *  belongs in, so routing is declared by humans, not guessed. */
  routing: { labelPrefix: string; repos: Record<string, RepoTarget> };
  /** Per-project overrides layered on the global defaults. */
  caps: Partial<Caps>;
  /**
   * Model pattern for worker sessions, in omp's model/role syntax. Omitted
   * leaves the harness default in place, which is what a project that never
   * answered the question wants.
   */
  workerModel?: string;
  /**
   * How a stuck run reaches a human, what to do when it cannot, and who runs
   * the session that triages it. See {@link ORCHESTRATOR_MODES}.
   */
  escalation: { telegramChatId?: string; fallbackToIssueComment: boolean; orchestrator: OrchestratorMode };
  /**
   * Who lands green PRs and who cuts releases. The daemon never acts on this
   * itself — it words the orchestrator's standing orders and the rendered brief
   * scaffold with it, so config and prompt can never disagree about which of
   * them is holding the merge button.
   */
  authority: { merge: AuthorityHolder; release: AuthorityHolder };
  /**
   * How loud the orchestrator is. Optional on disk — a config written before
   * this key existed loads as {@link DEFAULT_REPORT_SCOPE} — so read it through
   * `resolveReportScope` rather than reaching for `.scope` directly.
   */
  reporting?: { scope: ReportScope };
  /** Parent directory for per-run worktrees. */
  workspaceRoot: string;
  /** Cache of bare clones, so N runs share one fetch instead of N. */
  mirrorRoot: string;
}

/**
 * The config format this conductor writes. Bumped from 1 when a daily-volume cap
 * was retired: a v1 file may still carry cap keys this version no longer
 * enforces, so it is read leniently and normalised up, while a v2 file is held
 * to the current key set exactly.
 */
export const CONFIG_VERSION = 2;

/**
 * Versions this conductor can read. A v1 file loads, drops the caps that no
 * longer exist, and is rewritten as v2 the next time anything saves.
 */
export const READABLE_CONFIG_VERSIONS = [1, CONFIG_VERSION] as const;

/**
 * On-disk root config. `version` is present from day one so a format change
 * can be migrated instead of silently misread by an older daemon.
 */
export interface ConductorConfig {
  version: typeof CONFIG_VERSION;
  defaults: Caps;
  projects: ProjectConfig[];
}

/**
 * The tracker-agnostic view of a queued issue: only the fields the dispatcher
 * actually reads, so adapters never have to fabricate provider metadata.
 */
export interface ReadyIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
  /** Used to detect an issue edited mid-run, which invalidates the claim. */
  updatedAt: string;
}

/**
 * How a pull request ended, in tracker-agnostic terms. Lowercase because the
 * loop's vocabulary is lowercase; mapping GitHub's `MERGED`/`CLOSED`/`OPEN` onto
 * it is the adapter's job.
 *
 * `closed` is closed *without* merging — a human looked at the work and said no.
 */
export type PrState = "merged" | "closed" | "open";

/** Result of independently checking a worker's claimed green pull request. */
export interface PrVerification {
  status: "green" | "pending" | "failed";
  reason: string;
}

/**
 * Deliberately narrow so a Gitea or local-file tracker can drop in later.
 * Nothing here is GitHub-shaped; the GitHub adapter owns `gh` entirely.
 */
export interface Tracker {
  listReady(): Promise<ReadyIssue[]>;
  addLabel(issue: number, label: string): Promise<void>;
  removeLabel(issue: number, label: string): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
  close(issue: number): Promise<void>;
  /** Records that a worker split its issue, so follow-up work stays traceable
   *  to the request that spawned it. */
  linkParent(child: number, parent: number): Promise<void>;
  /**
   * The parent epic/issue number when `issue` is a linked sub-issue, or
   * undefined when it has no parent.
   *
   * Admission serializes siblings under one parent (at most one in flight). A
   * missing parent means "not epic-serialized" and keeps today's concurrent
   * admission. A thrown error is fail-closed for that candidate — same posture
   * as {@link Tracker.openCloserFor}.
   */
  parentOf(issue: number): Promise<number | undefined>;
  /**
   * The URL of an OPEN pull request that already closes `issue`, or undefined
   * when none does.
   *
   * Admission has to ask the tracker because the store cannot answer. The busy
   * set is built from run rows, so it only knows work *this* database recorded:
   * a migration onto the daemon, a wiped or relocated state directory, a
   * restore onto a new host, or simply a database younger than the PRs all
   * present pushed-and-open work as an untouched queue item. The tracker is the
   * only party that remembers across all of those.
   */
  openCloserFor(issue: number): Promise<string | undefined>;
  /**
   * The state of one specific pull request, or undefined when this adapter
   * could not tell — a network failure, a deleted PR, a URL it cannot parse.
   * Undefined never means "no".
   *
   * Deliberately separate from {@link Tracker.openCloserFor}, which answers a
   * different question: that one asks "should this candidate be admitted", and
   * answers undefined for merged, closed-unmerged, no PR at all and a deleted
   * PR alike, because admission treats all four the same. This one asks "did
   * *this* run's PR land", where those answers are opposites. Collapsing them
   * is how a PR a human rejected gets recorded as merged.
   */
  prState(url: string): Promise<PrState | undefined>;
  /**
   * Verify that a worker's pull request is open, ready, still at the reported
   * head, and has a non-empty terminal-success check rollup.
   */
  verifyPr(url: string, expectedHead: string): Promise<PrVerification | undefined>;
}

/**
 * Execution state is separate from the tracker's own labels on purpose: labels
 * are coarse and human-editable, while the loop needs to distinguish "pushed
 * and green, waiting on merge" from "merged" to decide what to do on restart.
 */
export type RunState =
  | "claimed"
  | "running"
  | "pushed-green"
  /** Worker finished, but GitHub has not yet produced a terminal check verdict. */
  | "pushed-pending"
  /** Its PR landed. Written by the tick's settle sweep, never by a worker: only
   *  the tracker knows, and it knows minutes to days after the run ended. */
  | "merged"
  | "blocked"
  | "failed"
  | "killed"
  /** In flight when its daemon process died; reconciled at the next startup. */
  | "orphaned";

/**
 * One attempt at one issue. Persisted so a daemon restart can reconcile
 * orphaned worktrees and branches instead of leaking them.
 */
export interface RunRecord {
  id: string;
  project: string;
  issue: number;
  /** `RepoTarget.name` this attempt was routed to. */
  repo: string;
  branch: string;
  worktree: string;
  state: RunState;
  /** 1-based attempt number, checked against `Caps.maxAttemptsPerIssue`. */
  attempt: number;
  turns: number;
  spendUsd: number;
  /** omp session transcript, so a human can read what the worker actually did. */
  sessionFile?: string;
  prUrl?: string;
  /** Pull request head the worker observed after its deterministic CI watcher exited. */
  headSha?: string;
  startedAt: number;
  endedAt?: number;
  /** Last failure text, surfaced verbatim in escalations. */
  lastError?: string;
}

/**
 * Bookkeeping only — GitHub labels remain the source of truth. The store
 * exists to answer cap questions cheaply and to survive a restart; if it is
 * ever lost, the tracker can rebuild the world.
 */
export interface Store {
  createRun(r: Omit<RunRecord, "id">): RunRecord;
  updateRun(id: string, patch: Partial<RunRecord>): void;
  getRun(id: string): RunRecord | undefined;
  /** Runs whose issue is occupied: a live worker, or a green PR awaiting merge. */
  activeRuns(project: string): RunRecord[];
  /** Runs backed by a worker process — what capacity counts. Subset of {@link Store.activeRuns}. */
  liveRuns(project: string): RunRecord[];
  attemptsFor(project: string, issue: number): number;
  /** Newest attempt for one issue, whatever state it reached. `omp-conductor
   *  tail` resolves an issue number to a transcript through this; the number is
   *  what an operator has, the run id is not. */
  latestRun(project: string, issue: number): RunRecord | undefined;
  runsStartedSince(project: string, sinceEpochMs: number): number;
  spendSince(project: string, sinceEpochMs: number): number;
  /** Idempotence guard so a retry loop cannot page a human repeatedly for the
   *  same event. */
  wasNotified(key: string): boolean;
  markNotified(key: string): void;
  close(): void;
}

/**
 * How loudly to interrupt: tier 1 is "answer when you can" (the run is parked
 * and safe), tier 2 is "the fleet is stopped until you look".
 */
export type EscalationTier = 1 | 2;

/**
 * A message to a human, carrying enough identity to find the run without
 * pasting logs into a chat window.
 */
export interface Escalation {
  tier: EscalationTier;
  project: string;
  issue: number;
  summary: string;
  detail?: string;
  runId?: string;
}

/**
 * Baseline limits used when a project omits `caps`. Data, not behaviour: kept
 * beside the type so the defaults cannot drift out of shape with it.
 */
export const DEFAULT_CAPS: Caps = {
  maxConcurrentWorkers: 2,
  dailySpendUsd: 25,
  workerMaxTurns: 120,
  workerWallClockMs: 90 * 60 * 1000,
  maxAttemptsPerIssue: 2,
};
