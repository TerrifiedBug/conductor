/**
 * Run bookkeeping on bun:sqlite.
 *
 * The tracker's labels remain the source of truth for *what* the fleet is
 * doing; this store exists so the dispatcher can answer cap questions ("am I
 * already at two workers?", "have I spent $25 today?") without a round-trip to
 * GitHub on every tick, and so a restart can reconcile the runs it left
 * mid-flight. Losing the file is survivable — it is a cache with a memory, not
 * a ledger.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateDir } from "./config.ts";
import { DEFAULT_CAPS } from "./types.ts";
import type {
  DispatchSummary,
  FrictionAdmissionReason,
  FrictionKind,
  FrictionObservation,
  FrictionSignal,
  RunRecord,
  RunState,
  Store,
} from "./types.ts";

/**
 * States backed by a worker process. These are what worker capacity counts:
 * a slot is a process, and only a claimed or running attempt has one.
 *
 * Exported because it is also the answer to "is anything still writing to this
 * run's transcript?" — `omp-conductor tail` needs that and must not re-derive
 * it, or the two definitions drift the first time a state is added.
 */
export const LIVE_STATES: readonly RunState[] = ["claimed", "running"];

/**
 * States that keep an *issue* occupied. Pending and green pushes belong here
 * but not in {@link LIVE_STATES}: their workers are finished and their
 * worktrees removed, so they must not consume slots, while their live PRs must
 * still block duplicate attempts.
 */
const ACTIVE_STATES: readonly RunState[] = [...LIVE_STATES, "pushed-pending", "pushed-green"];

const LIVE_PLACEHOLDERS = LIVE_STATES.map(() => "?").join(", ");
const ACTIVE_PLACEHOLDERS = ACTIVE_STATES.map(() => "?").join(", ");

const FRICTION_HOLD_REASONS: ReadonlySet<FrictionAdmissionReason> = new Set([
  "failed-attempts",
  "continuations",
  "parent-lookup-error",
  "open-pr-lookup-error",
  "unroutable:no-repo-label",
  "unroutable:multiple-repo-labels",
  "unroutable:unknown-repo",
]);

const FRICTION_ISSUE_SAMPLES = 5;
const FRICTION_TEXT_SAMPLES = 3;
const FRICTION_TEXT_LIMIT = 160;

function isFrictionHoldReason(reason: string): reason is FrictionAdmissionReason {
  return FRICTION_HOLD_REASONS.has(reason as FrictionAdmissionReason);
}

/**
 * Allowlist for `updateRun`'s dynamic SET clause. Column names cannot be bound
 * as parameters, so they are matched against this table rather than
 * interpolated from caller input. `id` is deliberately absent: it is the
 * address of the row, not one of its fields.
 */
const UPDATABLE_COLUMNS: Record<string, true> = {
  project: true,
  issue: true,
  repo: true,
  branch: true,
  worktree: true,
  state: true,
  attempt: true,
  turns: true,
  maxTurns: true,
  spendUsd: true,
  sessionFile: true,
  prUrl: true,
  headSha: true,
  startedAt: true,
  endedAt: true,
  lastError: true,
};

/** Everything SQLite will accept from us. */
type SqlValue = string | number | null;

/** The `runs` table exactly as SQLite hands it back: optional means NULL. */
interface RunRow {
  id: string;
  project: string;
  issue: number;
  repo: string;
  branch: string;
  worktree: string;
  state: string;
  attempt: number;
  turns: number;
  maxTurns: number;
  spendUsd: number;
  sessionFile: string | null;
  prUrl: string | null;
  headSha: string | null;
  startedAt: number;
  endedAt: number | null;
  lastError: string | null;
}

interface FrictionRollupRow {
  project: string;
  day: string;
  kind: string;
  observations: number;
  occurrences: number;
  issues: string;
  samples: string;
  latestAt: number;
}

interface FrictionSurfaceRow {
  kind: string;
  at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT    PRIMARY KEY,
  project     TEXT    NOT NULL,
  issue       INTEGER NOT NULL,
  repo        TEXT    NOT NULL,
  branch      TEXT    NOT NULL,
  worktree    TEXT    NOT NULL,
  state       TEXT    NOT NULL,
  attempt     INTEGER NOT NULL,
  turns       INTEGER NOT NULL,
  maxTurns    INTEGER NOT NULL,
  spendUsd    REAL    NOT NULL,
  sessionFile TEXT,
  prUrl       TEXT,
  headSha     TEXT,
  startedAt   INTEGER NOT NULL,
  endedAt     INTEGER,
  lastError   TEXT
);
CREATE INDEX IF NOT EXISTS runs_project_issue ON runs (project, issue);
CREATE INDEX IF NOT EXISTS runs_project_state ON runs (project, state);

CREATE TABLE IF NOT EXISTS notifications (
  "key" TEXT    PRIMARY KEY,
  at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dispatch_summaries (
  project   TEXT PRIMARY KEY,
  summary   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS friction_rollups (
  project       TEXT    NOT NULL,
  day           TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  observations  INTEGER NOT NULL,
  occurrences   INTEGER NOT NULL,
  issues        TEXT    NOT NULL,
  samples       TEXT    NOT NULL,
  latestAt      INTEGER NOT NULL,
  PRIMARY KEY (project, day, kind)
);
CREATE INDEX IF NOT EXISTS friction_rollups_project_day
  ON friction_rollups (project, day);

CREATE TABLE IF NOT EXISTS friction_surfaces (
  project TEXT NOT NULL,
  kind    TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (project, kind)
);
`;

/**
 * `undefined` is not a legal binding, and a boolean is only accepted by some
 * bun:sqlite builds, so both are normalised before they reach the driver.
 */
function toSql(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SqlValue;
}

/**
 * A NULL column becomes an absent property rather than an `undefined` one, so
 * a record read back out of the store deep-equals the one that went in.
 */
function toRecord(row: RunRow): RunRecord {
  const record: RunRecord = {
    id: row.id,
    project: row.project,
    issue: row.issue,
    repo: row.repo,
    branch: row.branch,
    worktree: row.worktree,
    state: row.state as RunState,
    attempt: row.attempt,
    turns: row.turns,
    maxTurns: row.maxTurns,
    spendUsd: row.spendUsd,
    startedAt: row.startedAt,
  };
  if (row.sessionFile !== null) record.sessionFile = row.sessionFile;
  if (row.prUrl !== null) record.prUrl = row.prUrl;
  if (row.headSha !== null) record.headSha = row.headSha;
  if (row.endedAt !== null) record.endedAt = row.endedAt;
  if (row.lastError !== null) record.lastError = row.lastError;
  return record;
}

function toDispatchSummary(text: string): DispatchSummary | undefined {
  try {
    const value = JSON.parse(text) as DispatchSummary;
    const counts = [value.completedAt, value.ready, value.routed, value.admitted];
    if (
      !counts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
      typeof value.degraded !== "boolean" ||
      !Array.isArray(value.holds) ||
      value.holds.some(
        (hold) =>
          typeof hold !== "object" ||
          hold === null ||
          typeof hold.reason !== "string" ||
          !Number.isSafeInteger(hold.count) ||
          hold.count < 0 ||
          !Array.isArray(hold.issues) ||
          hold.issues.length > 5 ||
          hold.count < hold.issues.length ||
          !hold.issues.every((issue) => Number.isSafeInteger(issue) && issue > 0),
      )
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function parseNumberList(text: string): number[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is number => Number.isSafeInteger(item) && item > 0)
      : [];
  } catch {
    return [];
  }
}

function parseTextList(text: string): string[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

function boundedUnique<T>(current: readonly T[], additions: readonly T[], limit: number): T[] {
  return [...new Set([...current, ...additions])].slice(0, limit);
}

function isFrictionKind(value: string): value is FrictionKind {
  if (value.startsWith("admission:")) {
    return isFrictionHoldReason(value.slice("admission:".length));
  }
  return (
    value === "feedback:escalation-should-digest" ||
    value === "feedback:report-noise" ||
    value === "feedback:report-surprise"
  );
}

/** Single database for every project; every table partitions by project name. */
export function dbPath(): string {
  return join(stateDir(), "conductor.db");
}

/**
 * Open (creating if needed) the run store at `dbPath`; `:memory:` is honoured
 * for tests. Safe to call on a fresh path — the schema is applied on open, so
 * there is no separate migration step to forget.
 */
export function openStore(dbPath: string): Store {
  if (dbPath !== ":memory:" && !dbPath.startsWith("file:")) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath, { create: true });

  // WAL lets the plugin read status while the daemon is mid-write; the busy
  // timeout covers the single writer lock they still contend for.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // Additive migrations are idempotent and preserve every existing row.
  // Historical rows predate per-run ceilings, so the package default is the
  // only truthful recoverable value; every new run persists its actual cap.
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(runs)").all();
  if (!columns.some((column) => column.name === "maxTurns")) {
    db.exec(
      `ALTER TABLE runs ADD COLUMN maxTurns INTEGER NOT NULL DEFAULT ${DEFAULT_CAPS.workerMaxTurns}`,
    );
  }
  // v0.3.18 and earlier created `runs` without the worker-observed PR head.
  if (!columns.some((column) => column.name === "headSha")) {
    db.exec("ALTER TABLE runs ADD COLUMN headSha TEXT");
  }

  const insertRun = db.query<unknown, SqlValue[]>(
    `INSERT INTO runs (
       id, project, issue, repo, branch, worktree, state, attempt, turns,
       maxTurns, spendUsd, sessionFile, prUrl, headSha, startedAt, endedAt, lastError
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectRun = db.query<RunRow, [string]>(`SELECT * FROM runs WHERE id = ?`);
  const selectActive = db.query<RunRow, SqlValue[]>(
    `SELECT * FROM runs
      WHERE project = ? AND state IN (${ACTIVE_PLACEHOLDERS})
      ORDER BY startedAt ASC`,
  );
  const selectLive = db.query<RunRow, SqlValue[]>(
    `SELECT * FROM runs
      WHERE project = ? AND state IN (${LIVE_PLACEHOLDERS})
      ORDER BY startedAt ASC`,
  );
  const selectRetained = db.query<RunRow, [string]>(
    `SELECT * FROM runs
      WHERE project = ?
        AND state IN ('failed', 'killed', 'orphaned')
        AND worktree <> ''
      ORDER BY endedAt ASC, startedAt ASC`,
  );
  const selectRecentRuns = db.query<RunRow, [string, number]>(
    `SELECT * FROM runs
      WHERE rowid IN (
        SELECT MAX(rowid) FROM runs
        WHERE project = ?
        GROUP BY issue
      )
        AND (state <> 'merged' OR COALESCE(endedAt, startedAt) >= ?)
      ORDER BY startedAt DESC`,
  );
  const countAttempts = db.query<{ n: number }, [string, number]>(
    `SELECT COUNT(*) AS n FROM runs WHERE project = ? AND issue = ?`,
  );
  const countFailures = db.query<{ n: number }, [string, number]>(
    `SELECT COUNT(*) AS n FROM runs
      WHERE project = ? AND issue = ? AND state = 'failed'`,
  );
  const countContinuations = db.query<{ n: number }, [string, number]>(
    `SELECT COUNT(*) AS n FROM runs
      WHERE project = ? AND issue = ? AND state IN ('killed', 'orphaned', 'blocked')`,
  );
  // Newest attempt for one issue. `startedAt` is millisecond-resolution and two
  // attempts could in principle share one, so rowid breaks the tie by insertion
  // order — a `tail` that attached to the older of two same-millisecond attempts
  // would follow a transcript nobody is writing to any more.
  const selectLatestRun = db.query<RunRow, [string, number]>(
    `SELECT * FROM runs
      WHERE project = ? AND issue = ?
      ORDER BY startedAt DESC, rowid DESC
      LIMIT 1`,
  );
  const countStartedSince = db.query<{ n: number }, [string, number]>(
    `SELECT COUNT(*) AS n FROM runs WHERE project = ? AND startedAt >= ?`,
  );
  const sumSpendSince = db.query<{ total: number }, [string, number]>(
    `SELECT COALESCE(SUM(spendUsd), 0) AS total
       FROM runs WHERE project = ? AND startedAt >= ?`,
  );
  const countNotified = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM notifications WHERE "key" = ?`,
  );
  // First notification wins, so the row records when a human was actually
  // paged rather than when the newest retry re-reported the same event.
  const insertNotified = db.query<unknown, [string, number]>(
    `INSERT OR IGNORE INTO notifications ("key", at) VALUES (?, ?)`,
  );
  const upsertDispatch = db.query<unknown, [string, string]>(
    `INSERT INTO dispatch_summaries (project, summary) VALUES (?, ?)
     ON CONFLICT(project) DO UPDATE SET summary = excluded.summary`,
  );
  const selectDispatch = db.query<{ summary: string }, [string]>(
    `SELECT summary FROM dispatch_summaries WHERE project = ?`,
  );
  const selectFrictionRollup = db.query<FrictionRollupRow, [string, string, string]>(
    `SELECT * FROM friction_rollups WHERE project = ? AND day = ? AND kind = ?`,
  );
  const upsertFrictionRollup = db.query<
    unknown,
    [string, string, string, number, number, string, string, number]
  >(
    `INSERT INTO friction_rollups
       (project, day, kind, observations, occurrences, issues, samples, latestAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project, day, kind) DO UPDATE SET
       observations = excluded.observations,
       occurrences = excluded.occurrences,
       issues = excluded.issues,
       samples = excluded.samples,
       latestAt = excluded.latestAt`,
  );
  const selectFrictionSince = db.query<FrictionRollupRow, [string, string]>(
    `SELECT * FROM friction_rollups
      WHERE project = ? AND day >= ?
      ORDER BY latestAt DESC`,
  );
  const selectFrictionSurfaces = db.query<FrictionSurfaceRow, [string]>(
    `SELECT kind, at FROM friction_surfaces WHERE project = ?`,
  );
  const upsertFrictionSurface = db.query<unknown, [string, string, number]>(
    `INSERT INTO friction_surfaces (project, kind, at) VALUES (?, ?, ?)
     ON CONFLICT(project, kind) DO UPDATE SET at = excluded.at`,
  );

  const recordFriction = (project: string, observation: FrictionObservation): void => {
    if (
      !Number.isSafeInteger(observation.occurrences) ||
      observation.occurrences < 1 ||
      !Number.isSafeInteger(observation.at) ||
      observation.at < 0
    ) {
      return;
    }
    const day = new Date(observation.at).toISOString().slice(0, 10);
    const prior = selectFrictionRollup.get(project, day, observation.kind);
    const issues = boundedUnique(
      prior === null ? [] : parseNumberList(prior.issues),
      [
        ...(observation.issues ?? []),
        ...(observation.issue === undefined || observation.issue <= 0 ? [] : [observation.issue]),
      ],
      FRICTION_ISSUE_SAMPLES,
    );
    const sample = observation.sample?.replace(/\s+/g, " ").trim().slice(0, FRICTION_TEXT_LIMIT);
    const samples = boundedUnique(
      prior === null ? [] : parseTextList(prior.samples),
      sample === undefined || sample.length === 0 ? [] : [sample],
      FRICTION_TEXT_SAMPLES,
    );
    upsertFrictionRollup.run(
      project,
      day,
      observation.kind,
      (prior?.observations ?? 0) + 1,
      (prior?.occurrences ?? 0) + observation.occurrences,
      JSON.stringify(issues),
      JSON.stringify(samples),
      Math.max(prior?.latestAt ?? 0, observation.at),
    );
  };

  return {
    createRun(r: Omit<RunRecord, "id">): RunRecord {
      const record: RunRecord = { ...r, id: crypto.randomUUID() };
      insertRun.run(
        record.id,
        record.project,
        record.issue,
        record.repo,
        record.branch,
        record.worktree,
        record.state,
        record.attempt,
        record.turns,
        record.maxTurns,
        record.spendUsd,
        toSql(record.sessionFile),
        toSql(record.prUrl),
        toSql(record.headSha),
        record.startedAt,
        toSql(record.endedAt),
        toSql(record.lastError),
      );
      return record;
    },

    updateRun(id: string, patch: Partial<RunRecord>): void {
      const assignments: string[] = [];
      const values: SqlValue[] = [];
      for (const [column, value] of Object.entries(patch)) {
        if (!UPDATABLE_COLUMNS[column]) continue;
        assignments.push(`${column} = ?`);
        values.push(toSql(value));
      }
      if (assignments.length === 0) return;
      values.push(id);
      // An unknown id matches no row: zero changes, no error, by design — the
      // dispatcher patches runs a restart may already have reaped.
      db.query<unknown, SqlValue[]>(
        `UPDATE runs SET ${assignments.join(", ")} WHERE id = ?`,
      ).run(...values);
    },

    getRun(id: string): RunRecord | undefined {
      const row = selectRun.get(id);
      return row ? toRecord(row) : undefined;
    },

    activeRuns(project: string): RunRecord[] {
      return selectActive.all(project, ...ACTIVE_STATES).map(toRecord);
    },

    liveRuns(project: string): RunRecord[] {
      return selectLive.all(project, ...LIVE_STATES).map(toRecord);
    },

    retainedRuns(project: string): RunRecord[] {
      return selectRetained.all(project).map(toRecord);
    },

    recentRuns(project: string, mergedSinceEpochMs: number): RunRecord[] {
      return selectRecentRuns.all(project, mergedSinceEpochMs).map(toRecord);
    },

    attemptsFor(project: string, issue: number): number {
      return countAttempts.get(project, issue)?.n ?? 0;
    },

    failuresFor(project: string, issue: number): number {
      return countFailures.get(project, issue)?.n ?? 0;
    },

    continuationsFor(project: string, issue: number): number {
      return countContinuations.get(project, issue)?.n ?? 0;
    },

    latestRun(project: string, issue: number): RunRecord | undefined {
      const row = selectLatestRun.get(project, issue);
      return row ? toRecord(row) : undefined;
    },


    runsStartedSince(project: string, sinceEpochMs: number): number {
      return countStartedSince.get(project, sinceEpochMs)?.n ?? 0;
    },

    spendSince(project: string, sinceEpochMs: number): number {
      return sumSpendSince.get(project, sinceEpochMs)?.total ?? 0;
    },

    wasNotified(key: string): boolean {
      return (countNotified.get(key)?.n ?? 0) > 0;
    },

    markNotified(key: string): void {
      // ponytail: notifications is append-only and never pruned. It gains one
      // short row per escalation, so it is decades from mattering; prune by
      // `at` if it ever does.
      insertNotified.run(key, Date.now());
    },

    recordDispatch(project: string, summary: DispatchSummary): void {
      const previous = selectDispatch.get(project);
      upsertDispatch.run(project, JSON.stringify(summary));
      if (
        previous !== null &&
        toDispatchSummary(previous.summary)?.completedAt === summary.completedAt
      ) {
        return;
      }
      for (const hold of summary.holds) {
        if (!isFrictionHoldReason(hold.reason)) continue;
        recordFriction(project, {
          kind: `admission:${hold.reason}`,
          occurrences: hold.count,
          issues: hold.issues,
          ...(hold.issues.length === 0
            ? {}
            : { sample: `issues ${hold.issues.map((issue) => `#${issue}`).join(", ")}` }),
          at: summary.completedAt,
        });
      }
    },

    latestDispatch(project: string): DispatchSummary | undefined {
      const row = selectDispatch.get(project);
      return row === null ? undefined : toDispatchSummary(row.summary);
    },

    recordFriction,

    pendingFriction(
      project: string,
      sinceEpochMs: number,
      minimumObservations: number,
      surfacedBeforeEpochMs: number,
    ): FrictionSignal[] {
      const sinceDay = new Date(sinceEpochMs).toISOString().slice(0, 10);
      const surfaces = new Map(selectFrictionSurfaces.all(project).map((row) => [row.kind, row.at]));
      const combined = new Map<FrictionKind, FrictionSignal>();
      for (const row of selectFrictionSince.all(project, sinceDay)) {
        if (
          !isFrictionKind(row.kind) ||
          row.latestAt < sinceEpochMs ||
          row.observations < 1 ||
          row.occurrences < 1
        ) {
          continue;
        }
        const prior = combined.get(row.kind);
        combined.set(row.kind, {
          kind: row.kind,
          observations: (prior?.observations ?? 0) + row.observations,
          occurrences: (prior?.occurrences ?? 0) + row.occurrences,
          issues: boundedUnique(
            prior?.issues ?? [],
            parseNumberList(row.issues),
            FRICTION_ISSUE_SAMPLES,
          ),
          samples: boundedUnique(
            prior?.samples ?? [],
            parseTextList(row.samples),
            FRICTION_TEXT_SAMPLES,
          ),
          latestAt: Math.max(prior?.latestAt ?? 0, row.latestAt),
        });
      }
      return [...combined.values()]
        .filter(
          (signal) =>
            signal.observations >= minimumObservations &&
            (surfaces.get(signal.kind) ?? 0) <= surfacedBeforeEpochMs,
        )
        .sort(
          (a, b) =>
            b.observations - a.observations ||
            b.occurrences - a.occurrences ||
            b.latestAt - a.latestAt,
        );
    },

    markFrictionSurfaced(project: string, kinds: readonly FrictionKind[], at: number): void {
      for (const kind of new Set(kinds)) upsertFrictionSurface.run(project, kind, at);
    },

    close(): void {
      db.close(false);
    },
  };
}
