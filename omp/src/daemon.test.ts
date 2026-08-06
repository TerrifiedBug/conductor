/**
 * The two restart deadlocks, as contracts.
 *
 * Found live, in one incident: a host restart killed two workers mid-run, and
 * the fleet then sat "at capacity" forever. Two separate mechanisms conspired —
 * dead `running` rows stayed in the active set because nothing reconciled them
 * at startup, and `pushed-green` rows consumed worker slots even though their
 * workers were finished. These tests pin the fixes independently, against a
 * real store, because the failure was a disagreement between what the store
 * persisted and what the dispatcher believed it meant.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { reconcileOrphanedRuns } from "./daemon.ts";
import { openStore } from "./store.ts";
import type { RunRecord, Store } from "./types.ts";

const PROJECT = "demo";

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

describe("reconcileOrphanedRuns", () => {
  let store!: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("settles claimed and running rows from a dead process and frees their slots", () => {
    const running = store.createRun(draft({ issue: 1, state: "running" }));
    const claimed = store.createRun(draft({ issue: 2, state: "claimed", startedAt: 2_000 }));

    const orphaned = reconcileOrphanedRuns(store, PROJECT);

    // The function reports what it settled, pre-transition, so the caller can
    // log each one with the state it died in.
    expect(orphaned.map((r) => r.id).sort()).toEqual([running.id, claimed.id].sort());

    // The rows are terminal now: a fresh daemon must start with every slot free,
    // or the fleet resumes exactly as deadlocked as it crashed.
    expect(store.getRun(running.id)?.state).toBe("orphaned");
    expect(store.getRun(running.id)?.endedAt).toBeNumber();
    expect(store.liveRuns(PROJECT)).toEqual([]);
    expect(store.activeRuns(PROJECT)).toEqual([]);
  });

  it("leaves a green PR awaiting merge exactly as it was", () => {
    const pushed = store.createRun(draft({ issue: 3, state: "pushed-green" }));

    expect(reconcileOrphanedRuns(store, PROJECT)).toEqual([]);

    // pushed-green holds no process, so a process dying cannot orphan it — and
    // its issue must stay occupied or a second attempt lands on the live PR.
    expect(store.getRun(pushed.id)?.state).toBe("pushed-green");
    expect(store.getRun(pushed.id)?.endedAt).toBeUndefined();
    expect(store.activeRuns(PROJECT).map((r) => r.id)).toEqual([pushed.id]);
  });

  it("never touches another project's runs", () => {
    const other = store.createRun(draft({ project: "neighbour", state: "running" }));

    reconcileOrphanedRuns(store, PROJECT);

    // One daemon serves one project; reconciling a neighbour's live workers
    // would be the --once-beside-a-daemon hazard in another costume.
    expect(store.getRun(other.id)?.state).toBe("running");
  });

  it("orphaned attempts still count toward the attempt cap", () => {
    store.createRun(draft({ issue: 9, attempt: 1, state: "running" }));
    reconcileOrphanedRuns(store, PROJECT);
    store.createRun(draft({ issue: 9, attempt: 2, state: "running", startedAt: 2_000 }));
    reconcileOrphanedRuns(store, PROJECT);

    // A worker that keeps dying on one issue is indistinguishable from a worker
    // that keeps failing on it: the cap must escalate it to a human rather than
    // let a crash loop redispatch forever.
    expect(store.attemptsFor(PROJECT, 9)).toBe(2);
  });
});
