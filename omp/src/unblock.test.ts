import { afterEach, beforeEach, expect, test } from "bun:test";

import { openStore } from "./store.ts";
import { DEFAULT_AUTHORITY, DEFAULT_CAPS } from "./types.ts";
import type { Caps, ProjectConfig, RunRecord, Store, Tracker } from "./types.ts";
import { formatUnblock, unblockIssue } from "./unblock.ts";

const project: ProjectConfig = {
  name: "demo",
  tracker: { kind: "github", repo: "acme/demo" },
  queueLabel: "agent-ready",
  stateLabels: { inProgress: "agent:running", blocked: "agent:blocked", failed: "agent:failed" },
  routing: { labelPrefix: "repo:", repos: {} },
  caps: {},
  escalation: { fallbackToIssueComment: true, orchestrator: "external" },
  authority: { ...DEFAULT_AUTHORITY },
  workspaceRoot: "/tmp/conductor/work",
  mirrorRoot: "/tmp/conductor/mirrors",
};

/** Every method but `removeLabel` throws: unblocking is a label removal and
 *  nothing else, and a verb that quietly commented or relabelled would be
 *  writing tracker state on an operator's behalf. */
function makeTracker(): { tracker: Tracker; removed: { issue: number; label: string }[] } {
  const removed: { issue: number; label: string }[] = [];
  const refuse = (name: string) => async () => {
    throw new Error(`${name} is not part of the unblock path`);
  };
  const tracker: Tracker = {
    listReady: refuse("listReady"),
    addLabel: refuse("addLabel"),
    removeLabel: async (issue: number, label: string) => {
      removed.push({ issue, label });
    },
    comment: refuse("comment"),
    close: refuse("close"),
    linkParent: refuse("linkParent"),
    parentOf: refuse("parentOf"),
    openCloserFor: refuse("openCloserFor"),
    prState: refuse("prState"),
    verifyPr: refuse("verifyPr"),
  };
  return { tracker, removed };
}

function draft(over: Partial<Omit<RunRecord, "id">> = {}): Omit<RunRecord, "id"> {
  return {
    project: project.name,
    issue: 221,
    repo: "api",
    branch: "feat/add-widget",
    worktree: "/tmp/conductor/work/221",
    state: "blocked",
    attempt: 1,
    turns: 12,
    spendUsd: 1.5,
    startedAt: 1_000,
    ...over,
  };
}

function caps(over: Partial<Caps> = {}): Caps {
  return { ...DEFAULT_CAPS, ...over };
}

let store!: Store;

beforeEach(() => {
  store = openStore(":memory:");
});

afterEach(() => {
  store.close();
});

test("clears both terminal state labels, and only those", async () => {
  const { tracker, removed } = makeTracker();

  const outcome = await unblockIssue(project, tracker, store, 221);

  // Both unconditionally: the Tracker port cannot read an issue's labels back,
  // and removing one it does not carry is a no-op, so asking for both is the
  // only answer that is right whichever one the daemon wrote.
  expect(removed).toEqual([
    { issue: 221, label: "agent:blocked" },
    { issue: 221, label: "agent:failed" },
  ]);
  expect(outcome.cleared).toEqual(["agent:blocked", "agent:failed"]);
  // in-progress means a worker process exists, which is not something an answer
  // changes; clearing it is how two workers end up on one issue.
  expect(removed.some((r) => r.label === project.stateLabels.inProgress)).toBe(false);
});

test("leaves the attempt history exactly as the last worker left it", async () => {
  const first = store.createRun(draft({ attempt: 1, state: "failed" }));
  const second = store.createRun(draft({ attempt: 2, state: "blocked", startedAt: 2_000 }));
  const { tracker } = makeTracker();

  const outcome = await unblockIssue(project, tracker, store, 221);

  // An answered block still spent a worker's whole budget, so it still counts:
  // a question answered twice is the loop `maxAttemptsPerIssue` exists to stop.
  expect(outcome.attemptsUsed).toBe(2);
  expect(store.attemptsFor(project.name, 221)).toBe(2);
  expect(store.getRun(first.id)).toEqual(first);
  expect(store.getRun(second.id)).toEqual(second);
  expect(outcome.latest).toEqual(second);
});

test("clears an issue the store has never seen, and says so", async () => {
  const { tracker, removed } = makeTracker();

  const outcome = await unblockIssue(project, tracker, store, 999);

  // Eligibility is read off the tracker, never off a run row, so a label a
  // human applied by hand is still this verb's to clear.
  expect(removed.map((r) => r.issue)).toEqual([999, 999]);
  expect(outcome.latest).toBeUndefined();
  expect(outcome.attemptsUsed).toBe(0);
  expect(formatUnblock(999, outcome, project, caps())).toContain("none recorded");
});

test("promises a re-claim only when the next tick could actually make one", () => {
  const spent: RunRecord = { id: "run_a", ...draft({ attempt: 2 }) };

  const eligible = formatUnblock(221, { cleared: ["agent:blocked"], attemptsUsed: 1, latest: spent }, project, caps());
  expect(eligible).toContain("eligible again");
  // The queue label is the other half of eligibility, and this verb does not
  // add it — an operator who took the issue off the queue must be told.
  expect(eligible).toContain("agent-ready");

  // The failure this guards: an operator reads "eligible again", walks away, and
  // the next tick escalates the attempt cap instead of dispatching anything.
  const exhausted = formatUnblock(
    221,
    { cleared: ["agent:blocked"], attemptsUsed: 2, latest: spent },
    project,
    caps({ maxAttemptsPerIssue: 2 }),
  );
  expect(exhausted).toContain("not eligible");
  expect(exhausted).toContain("all 2 attempts are spent");
});

test("says nothing is re-claimed while a worker still owns the issue", () => {
  const live: RunRecord = { id: "run_b", ...draft({ attempt: 1, state: "running" }) };

  const text = formatUnblock(221, { cleared: ["agent:blocked"], attemptsUsed: 1, latest: live }, project, caps());

  // The issue keeps agent:running, so eligibility is still false and a promised
  // re-claim would be a lie the operator only discovers by waiting for it.
  expect(text).toContain("in flight");
  expect(text).toContain("agent:running");
  expect(text).not.toContain("eligible again");
});
