import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { openStore } from "./store.ts";
import type { RunRecord, Store } from "./types.ts";

const PROJECT = "veltro";

/** A complete, boring run; each test overrides only what it is asserting on. */
function draft(over: Partial<Omit<RunRecord, "id">> = {}): Omit<RunRecord, "id"> {
  return {
    project: PROJECT,
    issue: 42,
    repo: "chad",
    branch: "feat/add-widget",
    worktree: "/tmp/conductor/veltro-42",
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
    const created = store.createRun(draft({ sessionFile: "/tmp/session.jsonl" }));

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
    const pushed = store.createRun(draft({ issue: 5, state: "pushed-green", startedAt: 3_000 }));
    // Another project's work must never consume this project's slots.
    store.createRun(draft({ project: "other", issue: 6, state: "running" }));

    expect(store.activeRuns(PROJECT).map((r) => r.id)).toEqual([
      live.id,
      claimed.id,
      pushed.id,
    ]);
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
    expect(store.wasNotified("veltro/42/tier2")).toBe(false);

    store.markNotified("veltro/42/tier2");

    expect(store.wasNotified("veltro/42/tier2")).toBe(true);
    expect(store.wasNotified("veltro/43/tier2")).toBe(false);
    // Re-marking is the whole point of the guard: it must stay idempotent.
    expect(() => store.markNotified("veltro/42/tier2")).not.toThrow();
    expect(store.wasNotified("veltro/42/tier2")).toBe(true);
  });

  it("ignores an update for an unknown id instead of throwing", () => {
    expect(() => store.updateRun("no-such-run", { state: "merged" })).not.toThrow();
    expect(store.getRun("no-such-run")).toBeUndefined();
  });
});
