/**
 * Daemon invariants that were paid for.
 *
 * The first describes the restart deadlocks. Found live, in one incident: a
 * host restart killed two workers mid-run, and the fleet then sat "at capacity"
 * forever. Two separate mechanisms conspired — dead `running` rows stayed in
 * the active set because nothing reconciled them at startup, and `pushed-green`
 * rows consumed worker slots even though their workers were finished. These
 * tests pin the fixes independently, against a real store, because the failure
 * was a disagreement between what the store persisted and what the dispatcher
 * believed it meant.
 *
 * The other two describe the integrity tripwire, whose whole job is to notice a
 * disagreement of the same shape one layer down: the package the daemon booted
 * with versus the package on disk.
 *
 * The next describes admission, whose failure was the mirror image of the
 * first: a store that is right about every row it holds and simply has no row
 * for work that already exists on the tracker.
 *
 * Then settlement, which is the other half of that first failure: a
 * `pushed-green` row is the one row nothing ever revisited, so on 2026-08-07
 * three merged-and-closed issues were still being reported as active runs after
 * two daemon restarts, and their issues were permanently unclaimable.
 *
 * The last describes what a non-graceful end tells a human. Two turns-cap kills
 * left ~1,600 lines of work as uncommitted edits in trees the next attempt is
 * built to destroy, under an escalation that said only "Worktree kept for
 * inspection"; the sha these lines carry is now the only pointer to work that
 * has no other copy, so the wording is a contract, not prose.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  admitCandidates,
  buildBrief,
  checkIntegrity,
  checkStall,
  manifestDiff,
  markPaged,
  packageManifest,
  reconcileOrphanedRuns,
  salvageLines,
  settlePushedGreen,
} from "./daemon.ts";
import type { IntegrityGate, StallGate } from "./daemon.ts";
import type { Routed } from "./routing.ts";
import { openStore } from "./store.ts";
import { DEFAULT_AUTHORITY, DEFAULT_CAPS } from "./types.ts";
import type {
  Caps,
  Escalation,
  ProjectConfig,
  RepoTarget,
  RunRecord,
  Store,
  Tracker,
} from "./types.ts";

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

  it("settles claimed and running rows from a dead process and frees their slots", async () => {
    const running = store.createRun(draft({ issue: 1, state: "running" }));
    const claimed = store.createRun(draft({ issue: 2, state: "claimed", startedAt: 2_000 }));

    const orphaned = await reconcileOrphanedRuns(store, PROJECT);

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

  it("leaves a green PR awaiting merge exactly as it was", async () => {
    const pushed = store.createRun(draft({ issue: 3, state: "pushed-green" }));

    expect(await reconcileOrphanedRuns(store, PROJECT)).toEqual([]);

    // pushed-green holds no process, so a process dying cannot orphan it — and
    // its issue must stay occupied or a second attempt lands on the live PR.
    expect(store.getRun(pushed.id)?.state).toBe("pushed-green");
    expect(store.getRun(pushed.id)?.endedAt).toBeUndefined();
    expect(store.activeRuns(PROJECT).map((r) => r.id)).toEqual([pushed.id]);
  });

  it("never touches another project's runs", async () => {
    const other = store.createRun(draft({ project: "neighbour", state: "running" }));

    await reconcileOrphanedRuns(store, PROJECT);

    // One daemon serves one project; reconciling a neighbour's live workers
    // would be the --once-beside-a-daemon hazard in another costume.
    expect(store.getRun(other.id)?.state).toBe("running");
  });

  it("orphaned attempts still count toward the attempt cap", async () => {
    store.createRun(draft({ issue: 9, attempt: 1, state: "running" }));
    await reconcileOrphanedRuns(store, PROJECT);
    store.createRun(draft({ issue: 9, attempt: 2, state: "running", startedAt: 2_000 }));
    await reconcileOrphanedRuns(store, PROJECT);

    // A worker that keeps dying on one issue is indistinguishable from a worker
    // that keeps failing on it: the cap must escalate it to a human rather than
    // let a crash loop redispatch forever.
    expect(store.attemptsFor(PROJECT, 9)).toBe(2);
  });

  it("salvages a dirty worktree before marking the row orphaned", async () => {
    // #35: restart used to flip the row and leave dirty edits for the next
    // attempt's `worktree remove --force`. The path must commit first.
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "orphan-salvage-"));
    try {
      const origin = join(root, "origin.git");
      const tree = join(root, "tree");
      const run = (args: string[], cwd: string) => {
        const res = Bun.spawnSync(
          [
            "git",
            "-c",
            "user.email=t@t.invalid",
            "-c",
            "user.name=t",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        );
        if (res.exitCode !== 0) {
          throw new Error(res.stderr.toString() || res.stdout.toString());
        }
        return res.stdout.toString().trim();
      };
      run(["init", "--bare", "--initial-branch=main", origin], root);
      run(["clone", origin, tree], root);
      writeFileSync(join(tree, "README.md"), "seed\n");
      run(["add", "README.md"], tree);
      run(["commit", "-m", "seed"], tree);
      run(["checkout", "-b", "feat/orphan-wip"], tree);
      run(["push", "-u", "origin", "feat/orphan-wip"], tree);
      writeFileSync(join(tree, "wip.py"), "print(1)\n");

      const row = store.createRun(
        draft({ issue: 35, state: "running", worktree: tree, branch: "feat/orphan-wip" }),
      );
      await reconcileOrphanedRuns(store, PROJECT);

      expect(store.getRun(row.id)?.state).toBe("orphaned");
      expect(run(["status", "--porcelain"], tree)).toBe("");
      expect(run(["log", "-1", "--format=%s"], tree)).toContain("daemon restart");
      expect(run(["show", "--name-only", "--format=", "HEAD"], tree)).toContain("wip.py");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** A miniature of the package's own `src/`: a module, and the briefs that are
 *  every bit as executable as the module is. */
const BASE: Record<string, string> = {
  "daemon.ts": "export const dispatch = 1;\n",
  "briefs/worker.md": "# worker\n\nIt must not touch any path outside its worktree.\n",
  "briefs/orchestrator.md": "# orchestrator\n",
};

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
}

describe("packageManifest", () => {
  let root!: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "conductor-integrity-"));
    writeTree(root, BASE);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("hashes an unchanged tree to the same manifest twice", () => {
    const first = packageManifest(root);

    // The baseline is compared against a fresh walk every five minutes for as
    // long as the daemon lives. Anything unstable in here — iteration order,
    // absolute paths, a timestamp — is a tripwire that pages about nothing.
    expect(Object.fromEntries(first)).toEqual(Object.fromEntries(packageManifest(root)));
    expect([...first.keys()].sort()).toEqual(["briefs/orchestrator.md", "briefs/worker.md", "daemon.ts"]);
    expect(manifestDiff(first, packageManifest(root))).toEqual([]);
  });

  it("sees a rewritten brief", () => {
    const before = packageManifest(root);
    writeTree(root, { "briefs/worker.md": "# worker\n\nIt may touch anything it likes.\n" });

    // Same path, same length of file, different instructions to a session with
    // the host's credentials: the case the whole tripwire exists for.
    expect(manifestDiff(before, packageManifest(root))).toEqual(["changed briefs/worker.md"]);
  });

  it("sees a new module", () => {
    const before = packageManifest(root);
    writeTree(root, { "helper.ts": "export const extra = 1;\n" });

    expect(manifestDiff(before, packageManifest(root))).toEqual(["added helper.ts"]);
  });

  it("sees a deleted file", () => {
    const before = packageManifest(root);
    rmSync(join(root, "briefs", "orchestrator.md"));

    expect(manifestDiff(before, packageManifest(root))).toEqual(["removed briefs/orchestrator.md"]);
  });

  it("ignores everything that is not source", () => {
    const before = packageManifest(root);
    writeTree(root, { "conductor.db-wal": "junk", "notes.txt": "junk" });

    // The manifest covers what the package *runs*. A daemon that paged because
    // something dropped a log file beside it would be turned off within a week.
    expect(manifestDiff(before, packageManifest(root))).toEqual([]);
  });
});

describe("checkIntegrity", () => {
  const baseline = (): Map<string, string> => new Map([["daemon.ts", "aaa"]]);

  it("lets an untouched package through", () => {
    const gate: IntegrityGate = { baseline: baseline(), paged: false };

    expect(checkIntegrity(gate, baseline())).toEqual({ diff: [], pause: false, page: false });
    expect(gate.paged).toBe(false);
  });

  it("pauses every divergent tick, and keeps asking to page until one is delivered", () => {
    const gate: IntegrityGate = { baseline: baseline(), paged: false };
    const tampered = new Map([["daemon.ts", "bbb"]]);

    expect(checkIntegrity(gate, tampered)).toEqual({ diff: ["changed daemon.ts"], pause: true, page: true });

    // The gate does NOT latch itself. A page Telegram refused is a page nobody
    // got, and latching on the attempt would trade one delivery outage for
    // permanent silence about a boundary that is still broken.
    markPaged(gate, false);
    expect(checkIntegrity(gate, tampered).page).toBe(true);

    // Delivered: now it latches. Pause stays true either way — an operator who
    // resumes without restarting is re-paused, because the files still differ.
    markPaged(gate, true);
    expect(checkIntegrity(gate, tampered)).toEqual({ diff: ["changed daemon.ts"], pause: true, page: false });
    expect(checkIntegrity(gate, tampered).page).toBe(false);
  });

  it("compares against the boot baseline, not the previous tick", () => {
    const gate: IntegrityGate = { baseline: baseline(), paged: false };
    checkIntegrity(gate, new Map([["daemon.ts", "bbb"]]));

    // Restoring the file is not enough to un-ring the bell, but it does stop
    // the pausing: the baseline is what boot recorded, so a daemon whose
    // package is put back exactly as it was can be resumed without a restart.
    expect(checkIntegrity(gate, baseline()).pause).toBe(false);
  });
});

const REPO: RepoTarget = {
  name: "api",
  cloneUrl: "https://example.invalid/acme/api.git",
  defaultBranch: "main",
  gates: [],
};

function candidate(number: number): Routed {
  return {
    issue: {
      number,
      title: `Ship widget ${number}`,
      body: "Acceptance: it ships.",
      labels: ["ready-for-agent", "repo:api"],
      url: `https://example.invalid/acme/planning/issues/${number}`,
      updatedAt: "2026-08-06T21:22:22Z",
    },
    repo: REPO,
  };
}

function project(): ProjectConfig {
  return {
    name: PROJECT,
    tracker: { kind: "github", repo: "acme/planning" },
    queueLabel: "ready-for-agent",
    stateLabels: {
      inProgress: "agent:in-progress",
      blocked: "agent:blocked",
      failed: "agent:failed",
    },
    routing: { labelPrefix: "repo:", repos: { api: REPO } },
    caps: {},
    escalation: { fallbackToIssueComment: true, orchestrator: "embedded" },
    authority: { ...DEFAULT_AUTHORITY },
    workspaceRoot: "/tmp/conductor/work",
    mirrorRoot: "/tmp/conductor/mirrors",
  };
}

/** The path under test consults exactly one tracker method. Every other one
 *  throws, so a claim or a sweep that starts reaching for the network fails
 *  loudly here first. */
function fakeTracker(over: Partial<Tracker>): Tracker {
  const off = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} is not part of the path under test`);
  };
  return {
    listReady: off("listReady"),
    addLabel: off("addLabel"),
    removeLabel: off("removeLabel"),
    comment: off("comment"),
    close: off("close"),
    linkParent: off("linkParent"),
    openCloserFor: off("openCloserFor"),
    prState: off("prState"),
    ...over,
  };
}

function deps(store: Store, tracker: Tracker, caps: Partial<Caps> = {}) {
  const escalated: Escalation[] = [];
  return {
    d: {
      project: project(),
      caps: { ...DEFAULT_CAPS, ...caps },
      tracker,
      store,
      escalate: async (e: Escalation): Promise<void> => {
        escalated.push(e);
      },
    },
    escalated,
  };
}

/** The decisions are only half the contract: an operator reading the log is how
 *  a held or skipped issue gets explained, so the lines are asserted too. */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ value: T; log: string }> {
  const chunks: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), log: chunks.join("") };
  } finally {
    process.stderr.write = real;
  }
}

describe("admitCandidates", () => {
  let store!: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("holds an issue whose work is already pushed, naming the PR", async () => {
    const { d } = deps(
      store,
      fakeTracker({ openCloserFor: async () => "https://github.com/acme/api/pull/419" }),
    );

    const { value, log } = await captureLog(() => admitCandidates(d, [candidate(288)], 2));

    // The store holds no row for #288 — the database was created after the PR
    // was pushed — so the busy set cannot possibly object. Only the tracker
    // knows, and a worker sent here re-implements a finished PR, burns an
    // attempt, and opens a second PR on the same issue.
    expect(value).toEqual([]);
    expect(log).toContain(
      "#288 skipped: open PR https://github.com/acme/api/pull/419 already closes it",
    );
  });

  it("admits an issue whose closers are all merged or closed", async () => {
    const { d } = deps(store, fakeTracker({ openCloserFor: async () => undefined }));

    // A merged reference means the work landed and the issue was reopened for
    // more; a closed-unmerged one means it was abandoned. Either way there is no
    // live PR to collide with. (That MERGED and CLOSED read as "no closer" is
    // the adapter's contract, pinned in tracker/github.test.ts.)
    const admitted = await admitCandidates(d, [candidate(260)], 2);

    expect(admitted.map((a) => a.r.issue.number)).toEqual([260]);
    expect(admitted[0]?.attempt).toBe(1);
  });

  it("holds only the candidate whose check failed, and keeps evaluating the rest", async () => {
    const { d } = deps(
      store,
      fakeTracker({
        openCloserFor: async (issue) => {
          if (issue === 288) throw new Error("HTTP 502: Bad gateway");
          return undefined;
        },
      }),
    );

    const { value, log } = await captureLog(() =>
      admitCandidates(d, [candidate(288), candidate(289)], 2),
    );

    // A failed check means "unknown whether finished work exists", and admitting
    // on unknown is the duplicate-work failure this guard exists to kill: the
    // worst case of holding is a five-minute delay, the worst case of admitting
    // is a burned attempt and a second PR. Holding one candidate rather than
    // aborting is what stops a flaky API from deadlocking the whole dispatcher.
    expect(value.map((a) => a.r.issue.number)).toEqual([289]);
    expect(log).toContain("#288 held: open-PR check failed");
    expect(log).toContain("retrying next tick");
  });

  it("asks the tracker once per free slot, not once per queued issue", async () => {
    const asked: number[] = [];
    const { d } = deps(
      store,
      fakeTracker({
        openCloserFor: async (issue) => {
          asked.push(issue);
          return undefined;
        },
      }),
    );

    const admitted = await admitCandidates(d, [candidate(1), candidate(2), candidate(3)], 1);

    // One call per admitted candidate is the entire cost of the guard. Per
    // queued issue it would scale with the backlog instead: two dozen API calls
    // every five minutes, to admit two.
    expect(admitted.map((a) => a.r.issue.number)).toEqual([1]);
    expect(asked).toEqual([1]);
  });

  it("spends no API call on an issue the store already answers for", async () => {
    store.createRun(draft({ issue: 500, state: "running" }));
    store.createRun(draft({ issue: 600, attempt: 1, state: "failed" }));
    store.createRun(draft({ issue: 600, attempt: 2, state: "failed", startedAt: 2_000 }));

    const asked: number[] = [];
    const { d, escalated } = deps(
      store,
      fakeTracker({
        openCloserFor: async (issue) => {
          asked.push(issue);
          return undefined;
        },
      }),
    );

    const admitted = await admitCandidates(d, [candidate(500), candidate(600)], 2);

    // #500 has a live run and #600 has spent both attempts: the store settles
    // both without leaving the process. Order matters for more than cost — an
    // exhausted issue has to escalate to a human, not be silently held.
    expect(admitted).toEqual([]);
    expect(asked).toEqual([]);
    expect(escalated.map((e) => e.issue)).toEqual([600]);
  });
});

// --------------------------------------------------------- settlePushedGreen

describe("settlePushedGreen", () => {
  const PR = "https://github.com/acme/api/pull/293";
  let store!: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("settles a merged PR to merged, and frees its issue in the same tick", async () => {
    const run = store.createRun(draft({ issue: 261, state: "pushed-green", prUrl: PR }));
    const { d } = deps(store, fakeTracker({ prState: async () => "merged" }));

    const { log } = await captureLog(() => settlePushedGreen(d));

    expect(store.getRun(run.id)?.state).toBe("merged");
    expect(store.getRun(run.id)?.endedAt).toBeNumber();
    // The whole of #18: the row leaves the active set, so `status` and
    // `/healthz` stop reporting merged-and-closed work as active — three such
    // rows survived two daemon restarts on the reference fleet — and the issue
    // becomes claimable again if a human ever re-queues it.
    expect(store.activeRuns(PROJECT)).toEqual([]);
    expect(log).toContain(`#261 settled: ${PR} merged`);
  });

  it("settles a PR a human closed to failed, and records why on the row", async () => {
    const run = store.createRun(draft({ issue: 262, state: "pushed-green", prUrl: PR }));
    const { d } = deps(store, fakeTracker({ prState: async () => "closed" }));

    const { log } = await captureLog(() => settlePushedGreen(d));

    // Not `merged`: nothing landed on the base branch, and a row claiming
    // otherwise is a lie about code that does not exist. Not `pushed-green`
    // either — that strands the issue forever behind a PR nobody will merge.
    // `failed` is true, and it releases the issue for a re-queue.
    expect(store.getRun(run.id)?.state).toBe("failed");
    expect(store.getRun(run.id)?.lastError).toBe(`${PR} closed without merging`);
    expect(store.activeRuns(PROJECT)).toEqual([]);
    expect(log).toContain(`#262 settled: ${PR} closed without merging`);
    // The attempt still counts. It was a real attempt, and forgetting it would
    // let a rejected issue cycle past `maxAttemptsPerIssue` unnoticed.
    expect(store.attemptsFor(PROJECT, 262)).toBe(1);
  });

  it("leaves a row whose PR is still open exactly as it was", async () => {
    const run = store.createRun(draft({ issue: 263, state: "pushed-green", prUrl: PR }));
    const { d } = deps(store, fakeTracker({ prState: async () => "open" }));

    await settlePushedGreen(d);

    // An open PR is the normal steady state of a green run, and its issue must
    // stay occupied or a second attempt lands on the live PR.
    expect(store.getRun(run.id)?.state).toBe("pushed-green");
    expect(store.getRun(run.id)?.endedAt).toBeUndefined();
    expect(store.activeRuns(PROJECT).map((r) => r.id)).toEqual([run.id]);
  });

  it("leaves a row alone when the tracker cannot tell", async () => {
    const run = store.createRun(draft({ issue: 264, state: "pushed-green", prUrl: PR }));
    const { d } = deps(store, fakeTracker({ prState: async () => undefined }));

    await settlePushedGreen(d);

    // Undefined is "could not tell" — a flaky network, a revoked token, a
    // deleted PR — never "no". Settling on it would record a merge that never
    // happened, or fail a PR that is sitting there green. The next tick asks
    // again for free.
    expect(store.getRun(run.id)?.state).toBe("pushed-green");
    expect(store.getRun(run.id)?.endedAt).toBeUndefined();
  });

  it("never asks about a row that has no PR url", async () => {
    const run = store.createRun(draft({ issue: 265, state: "pushed-green" }));
    const asked: string[] = [];
    const { d } = deps(
      store,
      fakeTracker({
        prState: async (url) => {
          asked.push(url);
          return "merged";
        },
      }),
    );

    await settlePushedGreen(d);

    // Such a row should not exist — a green push means a PR — but one that does
    // must not buy a `gh` call every five minutes forever to be told nothing.
    expect(asked).toEqual([]);
    expect(store.getRun(run.id)?.state).toBe("pushed-green");
  });

  it("settles the rest of the sweep when one lookup throws", async () => {
    const broken = store.createRun(draft({ issue: 266, state: "pushed-green", prUrl: PR }));
    const good = store.createRun(
      draft({ issue: 267, state: "pushed-green", prUrl: PR, startedAt: 2_000 }),
    );
    // The sweep walks the active set in `startedAt` order, so #266 is first.
    let calls = 0;
    const { d } = deps(
      store,
      fakeTracker({
        prState: async () => {
          calls += 1;
          if (calls === 1) throw new Error("HTTP 502: Bad gateway");
          return "merged";
        },
      }),
    );

    const { log } = await captureLog(() => settlePushedGreen(d));

    // One unreachable PR must cost its own row and nothing else. The alternative
    // — aborting the sweep — lets a single deleted PR keep every later row stale
    // forever, which is the bug this whole function exists to end.
    expect(store.getRun(broken.id)?.state).toBe("pushed-green");
    expect(store.getRun(good.id)?.state).toBe("merged");
    expect(log).toContain("#266 not settled: PR state lookup failed");
    expect(log).toContain("retrying next tick");
  });
});

describe("salvageLines", () => {
  const TREE = "/root/.omp/conductor/workspace/140";

  it("names the branch and sha a killed run's work was committed to", () => {
    const lines = salvageLines(
      {
        kind: "salvaged",
        sha: "9f2c1ab",
        branch: "conductor/issue-140",
        pushed: true,
        files: ["src/a.ts", ".scratch82/env.sh"],
        newPaths: [".scratch82/env.sh"],
      },
      TREE,
    );

    // The sha is the whole point: it is what turns "kept for inspection" into
    // something an operator can `git show` next week instead of tonight.
    expect(lines[0]).toBe(
      "WIP committed to conductor/issue-140 @ 9f2c1ab and pushed — the work outlives this worktree",
    );
    expect(lines[1]).toBe("2 files; new: .scratch82/env.sh");
    expect(lines[2]).toBe(`Worktree kept for inspection: ${TREE}`);
  });

  it("still reports the sha when the push was refused, and says it is local", () => {
    const lines = salvageLines(
      {
        kind: "salvaged",
        sha: "9f2c1ab",
        branch: "conductor/issue-140",
        pushed: false,
        pushError: "non-fast-forward",
        files: ["src/a.ts"],
        newPaths: [],
      },
      TREE,
    );

    // A refused push does not lose the commit, and must not read as if it did.
    expect(lines[0]).toContain("@ 9f2c1ab");
    expect(lines[0]).toContain("NOT pushed (non-fast-forward)");
    expect(lines[0]).toContain("this host's mirror");
    expect(lines[1]).toBe("1 file (all modifications to tracked paths)");
  });

  it("says plainly when there was nothing to salvage", () => {
    expect(salvageLines({ kind: "nothing" }, TREE)).toEqual([
      `Worktree kept for inspection: ${TREE} — nothing uncommitted to salvage`,
    ]);
  });

  it("is loud when the salvage itself failed, naming the only copy", () => {
    const lines = salvageLines({ kind: "failed", error: "git commit exited 128" }, TREE);

    expect(lines[0]).toBe("WIP SALVAGE FAILED: git commit exited 128");
    // The one case where a human has to act tonight: the tree is the only copy
    // and the next attempt removes it.
    expect(lines[1]).toContain(TREE);
    expect(lines[1]).toContain("only copy");
  });
});

// --------------------------------------------------------------- checkStall

describe("checkStall", () => {
  let dir = "";
  let marker = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conductor-stall-"));
    marker = join(dir, ".conductor-stalled");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("says nothing while the orchestrator is draining its queue", () => {
    const gate: StallGate = { paged: false };
    expect(checkStall(gate, marker)).toEqual({ page: false });
  });

  it("pages once per stall, carrying the marker's own timestamp line", () => {
    writeFileSync(marker, "2026-08-07T06:27:55.123Z 2 ticks queued unconsumed\nsecond line ignored\n");
    const gate: StallGate = { paged: false };

    const first = checkStall(gate, marker);
    expect(first.page).toBe(true);
    expect(first.since).toBe("2026-08-07T06:27:55.123Z 2 ticks queued unconsumed");

    markPaged(gate, true);
    expect(checkStall(gate, marker).page).toBe(false);
  });

  it("keeps asking to page until one is actually delivered", () => {
    writeFileSync(marker, "2026-08-07T06:27:55.123Z stalled\n");
    const gate: StallGate = { paged: false };

    // The wedge is the moment the escalation channel matters most, and it is
    // exactly when a page can fail. Silence after one failed send would leave
    // the fleet's only supervisor stuck with nobody told.
    expect(checkStall(gate, marker).page).toBe(true);
    markPaged(gate, false);
    expect(checkStall(gate, marker).page).toBe(true);
    markPaged(gate, false);
    expect(checkStall(gate, marker).page).toBe(true);
  });

  it("re-arms once the marker clears, so a second wedge pages again", () => {
    writeFileSync(marker, "first stall\n");
    const gate: StallGate = { paged: false };
    markPaged(gate, checkStall(gate, marker).page);
    expect(checkStall(gate, marker).page).toBe(false);

    // The orchestrator consumed a tick: the extension deletes its own marker.
    rmSync(marker);
    expect(checkStall(gate, marker)).toEqual({ page: false });
    expect(gate.paged).toBe(false);

    writeFileSync(marker, "second stall, days later\n");
    expect(checkStall(gate, marker).page).toBe(true);
  });

  it("still reports a stall whose marker cannot be read", () => {
    writeFileSync(marker, "");
    const gate: StallGate = { paged: false };

    const verdict = checkStall(gate, marker);
    expect(verdict.page).toBe(true);
    expect(verdict.since).toBeUndefined();
  });
});

/**
 * The brief is the entire context a session with the host's credentials gets, so
 * the two things worth holding are: a configured graph reaches the worker with
 * the right target, and a project without one gets exactly the brief this
 * package has always shipped.
 */
describe("buildBrief", () => {
  const routed = candidate(42);
  const shipped = join(import.meta.dir, "briefs", "worker.md");

  it("says nothing at all about a graph the project has not configured", async () => {
    const brief = await buildBrief(project(), routed, "feat/widget", "/tmp/conductor/work/42");
    const template = readFileSync(shipped, "utf8");

    // Byte-identical to the template with the placeholder simply gone — no blank
    // line, no heading, no "no graph configured" caveat. The placeholder sits
    // flush against the next numbered item precisely so that this holds; a
    // maintainer who gives it its own line breaks this test and nothing else.
    expect(brief).toContain("smallest diff in the wrong place is a second bug.\n2. **One read per file");
    expect(brief).not.toContain("{{");
    expect(brief).not.toContain("list_projects");
    expect(brief).not.toContain("Continuation");
    expect(brief.split("\n").length).toBe(template.split("\n").length);
  });

  it("points a configured worker at the indexed clone, never at its own worktree", async () => {
    const graphed: Routed = {
      issue: routed.issue,
      repo: { ...REPO, graphProject: "/srv/graph/acme/api" },
    };

    const brief = await buildBrief(project(), graphed, "feat/widget", "/tmp/conductor/work/42");

    // The clone's path, and the lookup that turns it into a project name. An
    // index is keyed by the realpath it was built from, so the worktree named
    // two lines below in the same brief has no index and never will.
    expect(brief).toContain("/srv/graph/acme/api");
    expect(brief).toContain("list_projects");
    expect(brief).toContain("never pass your own cwd");
    // Still one list, still no orphaned placeholder.
    expect(brief).toContain("\n2. **One read per file");
    expect(brief).not.toContain("{{");
  });

  it("injects a continuation section when the branch was reattached", async () => {
    const brief = await buildBrief(project(), routed, "feat/widget", "/tmp/conductor/work/42", {
      continuation: true,
      defaultBranch: "main",
    });

    expect(brief).toContain("## Continuation — do not start from zero");
    expect(brief).toContain("git log --oneline origin/main..HEAD");
    expect(brief).toContain("Do not recreate work that already exists");
    expect(brief).not.toContain("{{");
  });
});
