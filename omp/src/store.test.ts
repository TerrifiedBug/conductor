import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "./store.ts";
import type { RunRecord, Store } from "./types.ts";

const PROJECT = "demo";

/** A complete, boring run; each test overrides only what it is asserting on. */
function draft(over: Partial<Omit<RunRecord, "id">> = {}): Omit<RunRecord, "id"> {
  return {
    project: PROJECT,
    issue: 42,
    repo: "api",
    branch: "feat/add-widget",
    worktree: "/tmp/conductor/demo-42",
    state: "running",
    attempt: 1,
    turns: 0,
    spendUsd: 0,
    startedAt: 1_000,
    ...over,
  };
}

describe("openStore", () => {
  let store!: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("creates a run with a generated id that reads back intact", () => {
    const created = store.createRun(
      draft({ sessionFile: "/tmp/session.jsonl", headSha: "a".repeat(40) }),
    );

    expect(created.id).toBeString();
    expect(created.id.length).toBeGreaterThan(0);
    expect(store.getRun(created.id)).toEqual(created);

    // Two runs for the same issue must not collide on the primary key.
    expect(store.createRun(draft()).id).not.toBe(created.id);
  });

  it("counts a running run as active but not a merged one", () => {
    const live = store.createRun(draft({ issue: 1, state: "running" }));
    store.createRun(draft({ issue: 2, state: "merged" }));
    store.createRun(draft({ issue: 3, state: "failed" }));
    const claimed = store.createRun(draft({ issue: 4, state: "claimed", startedAt: 2_000 }));
    const pending = store.createRun(
      draft({ issue: 7, state: "pushed-pending", startedAt: 2_500 }),
    );
    const pushed = store.createRun(draft({ issue: 5, state: "pushed-green", startedAt: 3_000 }));
    // Another project's work must never consume this project's slots.
    store.createRun(draft({ project: "other", issue: 6, state: "running" }));

    expect(store.activeRuns(PROJECT).map((r) => r.id)).toEqual([
      live.id,
      claimed.id,
      pending.id,
      pushed.id,
    ]);
  });

  it("counts a green PR as an occupied issue but never as a live worker", () => {
    const running = store.createRun(draft({ issue: 1, state: "running" }));
    const claimed = store.createRun(draft({ issue: 2, state: "claimed", startedAt: 2_000 }));
    const pushed = store.createRun(draft({ issue: 3, state: "pushed-green", startedAt: 3_000 }));
    store.createRun(draft({ issue: 4, state: "orphaned", startedAt: 4_000 }));

    // The busy set must contain the green PR (a second attempt on that issue
    // would land on a live PR)...
    expect(store.activeRuns(PROJECT).map((r) => r.id)).toEqual([running.id, claimed.id, pushed.id]);
    // ...but capacity must not: a green PR holds no worker process, and with a
    // cap of 2, two green PRs awaiting a human merge would otherwise stop the
    // fleet forever.
    expect(store.liveRuns(PROJECT).map((r) => r.id)).toEqual([running.id, claimed.id]);
  });

  it("counts every attempt for an issue, including terminal ones", () => {
    store.createRun(draft({ issue: 7, attempt: 1, state: "failed" }));
    store.createRun(draft({ issue: 7, attempt: 2, state: "merged" }));
    store.createRun(draft({ issue: 7, attempt: 3, state: "running" }));
    store.createRun(draft({ issue: 8, attempt: 1, state: "running" }));

    expect(store.attemptsFor(PROJECT, 7)).toBe(3);
    expect(store.attemptsFor(PROJECT, 8)).toBe(1);
    expect(store.attemptsFor(PROJECT, 999)).toBe(0);
    expect(store.attemptsFor("other", 7)).toBe(0);
  });

  it("resolves an issue to its newest attempt, tie included", () => {
    store.createRun(draft({ issue: 7, attempt: 1, state: "failed", startedAt: 1_000 }));
    const newest = store.createRun(draft({ issue: 7, attempt: 2, state: "running", startedAt: 2_000 }));
    store.createRun(draft({ issue: 8, attempt: 1, state: "running", startedAt: 3_000 }));

    // `tail` follows whatever this returns, so the older attempt's transcript —
    // finished, and never growing again — must never win.
    expect(store.latestRun(PROJECT, 7)?.id).toBe(newest.id);
    expect(store.latestRun(PROJECT, 999)).toBeUndefined();
    expect(store.latestRun("other", 7)).toBeUndefined();

    // Two attempts inside one millisecond is unlikely but not impossible, and
    // "either one" is not an answer a follower can use.
    const sameMs = store.createRun(draft({ issue: 7, attempt: 3, state: "claimed", startedAt: 2_000 }));
    expect(store.latestRun(PROJECT, 7)?.id).toBe(sameMs.id);
  });

  it("patches only the fields given to updateRun", () => {
    const created = store.createRun(draft({ turns: 4, spendUsd: 1.25, branch: "fix/thing" }));

    store.updateRun(created.id, { state: "pushed-green" });
    store.updateRun(created.id, { prUrl: "https://example.test/pr/1" });

    expect(store.getRun(created.id)).toEqual({
      ...created,
      state: "pushed-green",
      prUrl: "https://example.test/pr/1",
    });
  });

  it("sums spend at or after the bound and returns 0 when empty", () => {
    expect(store.spendSince(PROJECT, 0)).toBe(0);

    store.createRun(draft({ issue: 1, startedAt: 1_000, spendUsd: 1.5 }));
    store.createRun(draft({ issue: 2, startedAt: 3_000, spendUsd: 2.25 }));
    store.createRun(draft({ project: "other", issue: 3, startedAt: 3_000, spendUsd: 99 }));

    expect(store.spendSince(PROJECT, 1_000)).toBe(3.75);
    expect(store.spendSince(PROJECT, 3_000)).toBe(2.25);
    expect(store.spendSince(PROJECT, 3_001)).toBe(0);

    expect(store.runsStartedSince(PROJECT, 1_000)).toBe(2);
    expect(store.runsStartedSince(PROJECT, 3_000)).toBe(1);
    expect(store.runsStartedSince(PROJECT, 3_001)).toBe(0);
  });

  it("reports a notification key only after it is marked", () => {
    expect(store.wasNotified("demo/42/tier2")).toBe(false);

    store.markNotified("demo/42/tier2");

    expect(store.wasNotified("demo/42/tier2")).toBe(true);
    expect(store.wasNotified("demo/43/tier2")).toBe(false);
    // Re-marking is the whole point of the guard: it must stay idempotent.
    expect(() => store.markNotified("demo/42/tier2")).not.toThrow();
    expect(store.wasNotified("demo/42/tier2")).toBe(true);
  });

  it("adds headSha to a pre-0.3.19 run database without losing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-store-"));
    const path = join(dir, "runs.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, issue INTEGER NOT NULL,
        repo TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL,
        state TEXT NOT NULL, attempt INTEGER NOT NULL, turns INTEGER NOT NULL,
        spendUsd REAL NOT NULL, sessionFile TEXT, prUrl TEXT,
        startedAt INTEGER NOT NULL, endedAt INTEGER, lastError TEXT
      );
    `);
    legacy.close();

    const migrated = openStore(path);
    const created = migrated.createRun(draft({ headSha: "a".repeat(40) }));
    expect(migrated.getRun(created.id)?.headSha).toBe("a".repeat(40));
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores an update for an unknown id instead of throwing", () => {
    expect(() => store.updateRun("no-such-run", { state: "merged" })).not.toThrow();
    expect(store.getRun("no-such-run")).toBeUndefined();
  });
});
