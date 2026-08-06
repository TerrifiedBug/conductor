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
  /** Parallel omp sessions. Two, because the homelab only has 3 CI runners and
   *  a third worker would starve its own PR checks. */
  maxConcurrentWorkers: number;
  /** Blast radius per rolling day: caps how much unattended churn a bad label
   *  sweep can push into the tracker before a human sees it. */
  maxIssuesPerDay: number;
  /** Rolling-day spend ceiling; the loop stops claiming work once it is hit. */
  dailySpendUsd: number;
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
  /** How a stuck run reaches a human, and what to do when it cannot. */
  escalation: { telegramChatId?: string; fallbackToIssueComment: boolean };
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
 * On-disk root config. `version` is present from day one so a format change
 * can be migrated instead of silently misread by an older daemon.
 */
export interface ConductorConfig {
  version: 1;
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
  | "merged"
  | "blocked"
  | "failed"
  | "killed";

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
  activeRuns(project: string): RunRecord[];
  attemptsFor(project: string, issue: number): number;
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
  maxIssuesPerDay: 6,
  dailySpendUsd: 25,
  workerMaxTurns: 120,
  workerWallClockMs: 90 * 60 * 1000,
  maxAttemptsPerIssue: 2,
};
