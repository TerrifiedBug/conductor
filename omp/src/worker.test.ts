/**
 * Deterministic worker logic: brief rendering, the report -> state derivation,
 * the `agent_end` completion rule, and what `runWorker` hands its session
 * factory. Nothing here reaches the omp peer dependency — the session factory is
 * injected, so the tests exercise the real `runWorker` against a fake harness
 * rather than a fake of themselves. Whether two *real* sessions run side by side
 * stays an integration question.
 */

import { describe, expect, test } from "bun:test";
import type { AgentSessionLike } from "./omp.ts";
import { openStore } from "./store.ts";
import { costUsdFromMessage, deriveResult, renderBrief, runWorker, shouldComplete, type WorkerOpts } from "./worker.ts";
import { DEFAULT_CAPS } from "./types.ts";

const HEAD_SHA = "a".repeat(40);
const GREEN_REPORT = [
  "pr: https://github.com/acme/api/pull/1487",
  `head: ${HEAD_SHA}`,
  "state: pushed-green",
].join("\n");

/**
 * A session that settles immediately with the report it was handed. Records the
 * options it was created with, which is the only way to prove `runWorker` passes
 * a configured model through instead of dropping it.
 *
 * `gated` holds `prompt()` open until `release()` is called, so a test can
 * inspect what the run has already done while it is provably still in flight.
 * `started` resolves the moment `prompt()` is entered, which makes that
 * inspection a handshake rather than a sleep.
 */
function fakeHarness(opts?: {
  report?: string;
  modelFallbackMessage?: string;
  sessionFile?: string;
  gated?: boolean;
}) {
  const received: {
    cwd?: string;
    sessionDir?: string;
    model?: string;
    confineToCwd?: boolean;
    releasePolicy?: "none" | "operator-brief";
    onReleaseBlocked?: (shape: never) => void;
  }[] = [];
  const handlers = new Map<string, ((e: unknown) => void)[]>();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();

  const session: AgentSessionLike = {
    prompt: async () => {
      entered.resolve();
      if (opts?.gated === true) await gate.promise;
      for (const cb of handlers.get("message_end") ?? []) {
        cb({ message: { role: "assistant", content: opts?.report ?? GREEN_REPORT } });
      }
      for (const cb of handlers.get("agent_end") ?? []) cb({ isTerminal: true });
    },
    on: (event, cb) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    abort: () => {},
    ...(opts?.sessionFile === undefined ? {} : { sessionFile: opts.sessionFile }),
    ...(opts?.modelFallbackMessage === undefined
      ? {}
      : { modelFallbackMessage: opts.modelFallbackMessage }),
  };

  return {
    received,
    /** Resolves once the run is under way — `prompt()` has been entered. */
    started: entered.promise,
    release: () => gate.resolve(),
    deps: {
      createSession: async (o: (typeof received)[number]) => {
        received.push(o);
        return session;
      },
    },
  };
}

function controlledTurnHarness(onAbort: () => void = () => {}) {
  const handlers = new Map<string, ((e: unknown) => void)[]>();
  const entered = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  let aborts = 0;
  const session = {
    prompt: async () => {
      entered.resolve();
      await stopped.promise;
    },
    on: (event: string, cb: (e: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    abort: () => {
      onAbort();
      aborts += 1;
      stopped.resolve();
    },
  };
  return {
    started: entered.promise,
    emitTurn: () => {
      for (const cb of handlers.get("turn_start") ?? []) cb({});
    },
    aborts: () => aborts,
    deps: { createSession: async () => session as never },
  };
}

const workerOpts = (over: Partial<WorkerOpts> = {}): WorkerOpts => ({
  brief: "Fix the flaky gate.",
  cwd: "/tmp/worktree",
  caps: DEFAULT_CAPS,
  ...over,
});

describe("runWorker session options", () => {
  test("passes a configured model pattern to the session factory", async () => {
    const harness = fakeHarness();

    await runWorker(workerOpts({ model: "smol" }), harness.deps);

    // The whole point of the per-project setting: omp resolves the pattern, so
    // dropping it here is invisible until someone reads a transcript.
    expect(harness.received).toHaveLength(1);
    expect(harness.received[0]?.model).toBe("smol");
  });

  test("omits the model entirely when the project pinned none", async () => {
    const harness = fakeHarness();

    await runWorker(workerOpts(), harness.deps);

    // Absent, not empty-string: the harness reads its own default only when the
    // key is missing.
    expect(harness.received[0]).not.toHaveProperty("model");
  });

  test("asks createSession to confine structured tools to the worktree", async () => {
    const harness = fakeHarness();

    await runWorker(workerOpts(), harness.deps);

    // Prevention half of #24: without this flag the harness extension is never
    // installed and write/edit/read can leave the checkout.
    expect(harness.received[0]?.confineToCwd).toBe(true);
  });

  test("passes the effective release policy and audit sink into the worker session", async () => {
    const harness = fakeHarness();
    const blocked = () => {};

    await runWorker(workerOpts({ releasePolicy: "none", onReleaseBlocked: blocked }), harness.deps);

    expect(harness.received[0]?.releasePolicy).toBe("none");
    expect(harness.received[0]?.onReleaseBlocked).toBe(blocked);
  });

  test("carries a model downgrade out on the result so the daemon can log it", async () => {
    const harness = fakeHarness({ modelFallbackMessage: "opus unavailable, used sonnet" });

    const result = await runWorker(workerOpts({ model: "opus" }), harness.deps);

    // A run done by a different model than the operator chose is a fact about
    // that run; swallowing it makes a downgraded run look merely unlucky.
    expect(result.modelFallbackMessage).toBe("opus unavailable, used sonnet");
    expect(result.state).toBe("pushed-green");
  });

  test("leaves the downgrade field absent when the harness honoured the model", async () => {
    const harness = fakeHarness();

    const result = await runWorker(workerOpts({ model: "smol" }), harness.deps);

    expect(result.modelFallbackMessage).toBeUndefined();
  });

  test("hands the transcript path over while the run is still in flight", async () => {
    const transcript = "/tmp/sessions/2026-08-06T00-00-00-000Z_run.jsonl";
    const harness = fakeHarness({ gated: true, sessionFile: transcript });
    const seen: string[] = [];
    let settled = false;

    const run = runWorker(
      workerOpts({ onSessionFile: (p) => seen.push(p) }),
      harness.deps,
    ).finally(() => {
      settled = true;
    });

    // The gate holds `prompt()` open, so this is the middle of the run, not a
    // guess about timing. Ordering is the whole point of the seam: `tail`
    // resolves an issue to a transcript through the row this callback writes,
    // and a path that only lands with the result arrives once there is nothing
    // left to follow.
    await harness.started;
    expect(seen).toEqual([transcript]);
    expect(settled).toBe(false);

    harness.release();
    await run;
    // Once, not once per turn: the callback names a file, not an event.
    expect(seen).toEqual([transcript]);
  });

  test("never calls onSessionFile for a session that opened no transcript", async () => {
    const harness = fakeHarness();
    const seen: string[] = [];

    const result = await runWorker(workerOpts({ onSessionFile: (p) => seen.push(p) }), harness.deps);

    // An empty string is a path that fails to open, not an absence — so the
    // callback stays silent and the result reports no transcript either.
    expect(seen).toEqual([]);
    expect(result.sessionFile).toBeUndefined();
  });
});

describe("renderBrief", () => {
  test("substitutes every known placeholder, including repeats", () => {
    const rendered = renderBrief(
      "Fix #{{ISSUE_NUMBER}} in {{REPO}} on branch {{BRANCH}}.\nPR must target {{REPO}}.",
      { ISSUE_NUMBER: "412", REPO: "api", BRANCH: "fix/flaky-gate" },
    );

    expect(rendered).toBe("Fix #412 in api on branch fix/flaky-gate.\nPR must target api.");
  });

  test("leaves an unknown placeholder verbatim", () => {
    const rendered = renderBrief("Repo {{REPO}}, acceptance {{ACCEPTANCE_CRITERIA}}.", {
      REPO: "worker",
    });

    expect(rendered).toBe("Repo worker, acceptance {{ACCEPTANCE_CRITERIA}}.");
    expect(rendered).not.toContain("undefined");
  });
});

describe("deriveResult", () => {
  test("reads structured green evidence from the final report", () => {
    expect(deriveResult(GREEN_REPORT)).toEqual({
      state: "pushed-green",
      prUrl: "https://github.com/acme/api/pull/1487",
      headSha: HEAD_SHA,
    });
  });

  test("a textual pushed-green claim without a PR head fails closed", () => {
    expect(
      deriveResult("Everything is pushed-green.\nstate: pushed-green\npr: https://github.com/acme/api/pull/1487"),
    ).toEqual({
      state: "failed",
      prUrl: "https://github.com/acme/api/pull/1487",
    });
  });

  test("treats ci-red as a failure", () => {
    expect(deriveResult("state: ci-red\nbackend pytest failed on the second gate")).toEqual({
      state: "failed",
    });
  });

  test("reports blocked when the worker says it is blocked", () => {
    expect(deriveResult("state: blocked\nreason: acceptance criteria name no such flag")).toEqual({
      state: "blocked",
    });
  });

  test("fails closed on an empty or unreadable report, with no PR url", () => {
    // A run whose outcome cannot be read is a failed run: defaulting the other
    // way is exactly how unverified work reaches a merge queue.
    const empty = deriveResult("");
    expect(empty.state).toBe("failed");
    expect(empty.prUrl).toBeUndefined();

    const gibberish = deriveResult("...thinking... asdfqwer 0x1f");
    expect(gibberish.state).toBe("failed");
    expect(gibberish.prUrl).toBeUndefined();
  });
});

describe("shouldComplete", () => {
  test("a non-terminal agent_end does not complete the run", () => {
    // The harness resumes this session afterwards, so its messages so far are
    // a snapshot. Completing here reports a truncated run as the final result.
    expect(shouldComplete({ isTerminal: false })).toBe(false);
  });

  test("a terminal agent_end completes the run", () => {
    expect(shouldComplete({ isTerminal: true })).toBe(true);
  });

  test("an agent_end with no isTerminal field completes, for older harnesses", () => {
    // Back-compat, and it fails safe in the right direction: reading an absent
    // field as non-terminal would hang every run on a harness that never sets
    // it, until the wall-clock cap killed a session that had already finished.
    expect(shouldComplete({})).toBe(true);
  });
});


describe("runWorker turn ceiling", () => {
  test("observes an extension immediately before the old boundary", async () => {
    const harness = controlledTurnHarness();
    let maxTurns = 2;
    const run = runWorker(
      workerOpts({
        caps: { ...DEFAULT_CAPS, workerMaxTurns: 2 },
        maxTurns: () => maxTurns,
      }),
      harness.deps,
    );
    await harness.started;

    harness.emitTurn();
    harness.emitTurn();
    maxTurns = 3;
    harness.emitTurn();
    expect(harness.aborts()).toBe(0);

    harness.emitTurn();
    expect(await run).toMatchObject({ state: "killed", killedBy: "turns", turns: 4 });
    expect(harness.aborts()).toBe(1);
  });

  test("latches the cap before abort begins", async () => {
    let latched = false;
    let abortSawLatch = false;
    const harness = controlledTurnHarness(() => {
      abortSawLatch = latched;
    });
    const run = runWorker(
      workerOpts({
        caps: { ...DEFAULT_CAPS, workerMaxTurns: 2 },
        onKilled: () => {
          latched = true;
        },
      }),
      harness.deps,
    );
    await harness.started;

    harness.emitTurn();
    harness.emitTurn();
    harness.emitTurn();
    expect(abortSawLatch).toBe(true);

    expect(latched).toBe(true);
    expect(await run).toMatchObject({ state: "killed", killedBy: "turns", turns: 3 });
    expect(harness.aborts()).toBe(1);
  });
});

describe("costUsdFromMessage", () => {
  test("reads usage.cost.total from a live-shaped assistant message", () => {
    expect(
      costUsdFromMessage({
        role: "assistant",
        usage: {
          cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
        },
      }),
    ).toBe(0.1);
  });

  test("sums components when total is absent", () => {
    expect(
      costUsdFromMessage({
        role: "assistant",
        usage: { cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 } },
      }),
    ).toBeCloseTo(0.03);
  });

  test("returns undefined without a cost block", () => {
    expect(costUsdFromMessage({ role: "assistant", content: "hi" })).toBeUndefined();
  });
});

describe("runWorker spend metering", () => {
  test("accumulates message.usage.cost.total across assistant messages", async () => {
    const handlers = new Map<string, ((e: unknown) => void)[]>();
    const session = {
      prompt: async () => {
        for (const cb of handlers.get("message_end") ?? []) {
          cb({
            message: {
              role: "assistant",
              content: "working",
              usage: { cost: { total: 0.12 } },
            },
          });
          cb({
            message: {
              role: "assistant",
              content: GREEN_REPORT,
              usage: { cost: { total: 0.08 } },
            },
          });
        }
        for (const cb of handlers.get("agent_end") ?? []) cb({ isTerminal: true });
      },
      on: (event: string, cb: (e: unknown) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
      },
      abort: () => {},
    };
    const result = await runWorker(workerOpts(), {
      createSession: async () => session as never,
    });
    expect(result.spendUsd).toBeCloseTo(0.2);
    expect(result.state).toBe("pushed-green");
  });

  test("persists cumulative spend before the worker settles", async () => {
    const handlers = new Map<string, ((e: unknown) => void)[]>();
    const messageHandled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const store = openStore(":memory:");
    const record = store.createRun({
      project: "demo",
      issue: 42,
      repo: "api",
      branch: "fix/live-spend",
      worktree: "/tmp/demo-42",
      state: "running",
      attempt: 1,
      turns: 0,
      maxTurns: DEFAULT_CAPS.workerMaxTurns,
      spendUsd: 0,
      startedAt: 1_000,
    });
    const session = {
      prompt: async () => {
        for (const cb of handlers.get("message_end") ?? []) {
          cb({
            message: {
              role: "assistant",
              content: "still working",
              usage: { cost: { total: 0.12 } },
            },
          });
        }
        messageHandled.resolve();
        await release.promise;
        for (const cb of handlers.get("agent_end") ?? []) cb({ isTerminal: true });
      },
      on: (event: string, cb: (e: unknown) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
      },
      abort: () => {},
    };
    let settled = false;
    const run = runWorker(
      workerOpts({
        onSpend: (spendUsd) => store.updateRun(record.id, { spendUsd }),
      }),
      { createSession: async () => session as never },
    ).finally(() => {
      settled = true;
    });

    await messageHandled.promise;
    expect(settled).toBe(false);
    expect(store.getRun(record.id)?.spendUsd).toBeCloseTo(0.12);
    expect(store.spendSince("demo", 0)).toBeCloseTo(0.12);

    release.resolve();
    const result = await run;
    store.updateRun(record.id, { spendUsd: result.spendUsd });
    expect(store.spendSince("demo", 0)).toBeCloseTo(0.12);
    store.close();
  });
});
