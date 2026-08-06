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
import { dirname } from "node:path";

import type { RunRecord, RunState, Store } from "./types.ts";

/**
 * States that consume a worker slot. `pushed-green` counts: the branch is
 * pushed and CI is green but nothing is merged, so the worktree, the branch
 * and the issue claim are all still held.
 */
const ACTIVE_STATES: readonly RunState[] = ["claimed", "running", "pushed-green"];

const ACTIVE_PLACEHOLDERS = ACTIVE_STATES.map(() => "?").join(", ");

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
  spendUsd: true,
  sessionFile: true,
  prUrl: true,
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
  spendUsd: number;
  sessionFile: string | null;
  prUrl: string | null;
  startedAt: number;
  endedAt: number | null;
  lastError: string | null;
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
  spendUsd    REAL    NOT NULL,
  sessionFile TEXT,
  prUrl       TEXT,
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
    spendUsd: row.spendUsd,
    startedAt: row.startedAt,
  };
  if (row.sessionFile !== null) record.sessionFile = row.sessionFile;
  if (row.prUrl !== null) record.prUrl = row.prUrl;
  if (row.endedAt !== null) record.endedAt = row.endedAt;
  if (row.lastError !== null) record.lastError = row.lastError;
  return record;
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
  // ponytail: the schema is created if absent and never migrated — a column
  // change means hand-editing or deleting the file. Upgrade path for the first
  // shape change: PRAGMA user_version plus an ordered migration list here.
  db.exec(SCHEMA);

  const insertRun = db.query<unknown, SqlValue[]>(
    `INSERT INTO runs (
       id, project, issue, repo, branch, worktree, state, attempt, turns,
       spendUsd, sessionFile, prUrl, startedAt, endedAt, lastError
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectRun = db.query<RunRow, [string]>(`SELECT * FROM runs WHERE id = ?`);
  const selectActive = db.query<RunRow, SqlValue[]>(
    `SELECT * FROM runs
      WHERE project = ? AND state IN (${ACTIVE_PLACEHOLDERS})
      ORDER BY startedAt ASC`,
  );
  const countAttempts = db.query<{ n: number }, [string, number]>(
    `SELECT COUNT(*) AS n FROM runs WHERE project = ? AND issue = ?`,
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
        record.spendUsd,
        toSql(record.sessionFile),
        toSql(record.prUrl),
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

    attemptsFor(project: string, issue: number): number {
      return countAttempts.get(project, issue)?.n ?? 0;
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

    close(): void {
      db.close(false);
    },
  };
}
