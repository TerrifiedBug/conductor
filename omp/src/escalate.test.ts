import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEscalator, escalationIssueRef, formatEscalation } from "./escalate.ts";
import type { OrchestratorHandle } from "./orchestrator.ts";
import { DEFAULT_AUTHORITY } from "./types.ts";
import type { Escalation, OrchestratorMode, ProjectConfig, Store, Tracker } from "./types.ts";

/** Obvious junk: this must never reach the network, a log or an assertion. */
const FAKE_TOKEN = "1234567:AA-fake-test-token-not-a-secret";

const realFetch = globalThis.fetch;
const realStateDir = process.env.OMP_TELEGRAM_STATE_DIR;
let tokenDir: string;

beforeAll(() => {
  // Point the token reader at a throwaway dir so no test can read — let alone
  // send with — the developer's real omp-telegram credentials.
  tokenDir = mkdtempSync(join(tmpdir(), "conductor-escalate-"));
  writeFileSync(join(tokenDir, ".env"), `TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}\n`, { mode: 0o600 });
});

afterAll(() => {
  rmSync(tokenDir, { recursive: true, force: true });
  if (realStateDir === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = realStateDir;
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  process.env.OMP_TELEGRAM_STATE_DIR = tokenDir;
  // Default deny: any unexpected network call fails the test that made it.
  globalThis.fetch = (async () => {
    throw new Error("unexpected network call");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

type FetchCall = { url: string; body: string };

/** Stubs fetch with one canned reply and records what was sent. */
function stubFetch(reply: () => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    calls.push({ url: String(args[0]), body: String(args[1]?.body ?? "") });
    return reply();
  }) as typeof fetch;
  return calls;
}

/** `orchestrator` defaults to `embedded`: these tests are about where an
 *  escalation goes, and every one of them predates the external mode. */
function makeProject(
  escalation: Omit<ProjectConfig["escalation"], "orchestrator"> & { orchestrator?: OrchestratorMode },
): ProjectConfig {
  return {
    name: "demo",
    tracker: { kind: "github", repo: "acme/demo" },
    queueLabel: "agent-ready",
    stateLabels: { inProgress: "agent:running", blocked: "agent:blocked", failed: "agent:failed" },
    routing: { labelPrefix: "repo:", repos: {} },
    caps: {},
    escalation: { orchestrator: "embedded", ...escalation },
    authority: { ...DEFAULT_AUTHORITY },
    workspaceRoot: "/tmp/conductor/work",
    mirrorRoot: "/tmp/conductor/mirrors",
  };
}

function makeTracker(opts: { commentThrows?: boolean } = {}) {
  const comments: { issue: number; body: string }[] = [];
  const tracker: Tracker = {
    listReady: async () => [],
    addLabel: async () => {},
    removeLabel: async () => {},
    comment: async (issue: number, body: string) => {
      comments.push({ issue, body });
      if (opts.commentThrows) throw new Error("tracker unreachable");
    },
    close: async () => {},
    linkParent: async () => {},
    parentOf: async () => undefined,
    openCloserFor: async () => undefined,
    prState: async () => undefined,
    verifyPr: async () => undefined,
  };
  return { tracker, comments };
}

function makeStore() {
  const notified = new Set<string>();
  const marked: string[] = [];
  const store: Store = {
    createRun: () => {
      throw new Error("createRun is not part of the escalation path");
    },
    updateRun: () => {
      throw new Error("updateRun is not part of the escalation path");
    },
    getRun: () => undefined,
    activeRuns: () => [],
    liveRuns: () => [],
    attemptsFor: () => 0,
    failuresFor: () => 0,
    continuationsFor: () => 0,
    latestRun: () => undefined,
    runsStartedSince: () => 0,
    spendSince: () => 0,
    wasNotified: (key: string) => notified.has(key),
    markNotified: (key: string) => {
      notified.add(key);
      marked.push(key);
    },
    close: () => {},
  };
  return { store, marked };
}

const tier1: Escalation = {
  tier: 1,
  project: "demo",
  issue: 4211,
  summary: "gate `bun test` failed twice on the same assertion",
  detail: "https://github.com/acme/demo/pull/99",
  runId: "run_abc",
};

const tier2: Escalation = {
  tier: 2,
  project: "demo",
  issue: 4212,
  summary: "worker killed by wallclock cap with a dirty worktree",
  runId: "run_def",
};

test("tier 1 with the issue-comment fallback comments exactly once", async () => {
  const { tracker, comments } = makeTracker();
  const { store, marked } = makeStore();
  const p = makeProject({ fallbackToIssueComment: true });

  await createEscalator(p, tracker, store).escalate(tier1);

  expect(comments.length).toBe(1);
  expect(comments[0]?.issue).toBe(4211);
  expect(comments[0]?.body).toContain("#4211");
  expect(comments[0]?.body).toContain(tier1.summary);
  expect(marked.length).toBe(1);
});

test("the same escalation twice notifies once", async () => {
  const { tracker, comments } = makeTracker();
  const { store } = makeStore();
  const escalator = createEscalator(makeProject({ fallbackToIssueComment: true }), tracker, store);

  await escalator.escalate(tier1);
  await escalator.escalate({ ...tier1 });

  expect(comments.length).toBe(1);
});

test("a failed transport is not marked notified, so the next tick retries", async () => {
  const failing = makeTracker({ commentThrows: true });
  const { store, marked } = makeStore();
  const p = makeProject({ fallbackToIssueComment: true });

  await expect(createEscalator(p, failing.tracker, store).escalate(tier1)).rejects.toThrow(
    "tracker unreachable",
  );
  expect(marked.length).toBe(0);

  // Same store, working tracker: the event is still owed to the human.
  const working = makeTracker();
  await createEscalator(p, working.tracker, store).escalate(tier1);
  expect(working.comments.length).toBe(1);
  expect(marked).toEqual(["demo:4211:1:gate `bun test` failed twice on the same assertion"]);
});

test("tier 2 with a chat id sends one Telegram request and no issue comment", async () => {
  const calls = stubFetch(() => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
  const { tracker, comments } = makeTracker();
  const { store, marked } = makeStore();
  const p = makeProject({ telegramChatId: "123456789", fallbackToIssueComment: true });

  await createEscalator(p, tracker, store).escalate(tier2);

  expect(calls.length).toBe(1);
  expect(calls[0]?.url).toStartWith("https://api.telegram.org/bot");
  expect(calls[0]?.url).toEndWith("/sendMessage");
  expect(comments.length).toBe(0);
  expect(marked.length).toBe(1);

  const sent: unknown = JSON.parse(calls[0]?.body ?? "{}");
  expect(sent).toMatchObject({ chat_id: "123456789", text: formatEscalation(tier2, "demo") });
});

test("a long page that Telegram accepted is not reported as rejected", async () => {
  // Telegram echoes the whole message back inside `result.text`, so a real
  // tier-2 body puts the success response well past 400 characters. The
  // delivery check used to parse the *truncated* diagnostic string, so exactly
  // the pages worth sending came back as `sendMessage rejected` — after they
  // had already arrived. Live on 2026-08-07: message_id 99 reached the operator
  // and the daemon logged "could not be delivered". Because the dedup marker is
  // only written on success, that also re-sent the same page every tick.
  // Shaped on the real integrity-tripwire page: a summary, a package root, the
  // differing files, and the four lines telling an operator what to do about
  // it. The fixtures above are one-liners, which is why nothing here ever hit
  // the 400-char cap and the bug survived to production.
  const bigPage: Escalation = {
    tier: 2,
    project: "demo",
    issue: 0,
    summary: "Installed conductor changed under a running daemon on 2026-08-07: 4 file(s) differ (first: changed daemon.ts) — demo is paused",
    detail: [
      "Package root: /root/node_modules/omp-conductor/src",
      "changed daemon.ts",
      "changed briefs/orchestrator.md",
      "changed cli.ts",
      "added evil.ts",
      "",
      "If you deployed a new build, restart the daemon — the restart re-records the baseline.",
      "If you did not, the host edited itself while it was dispatching work: treat every run since",
      "the last known-good restart as unattributable before resuming.",
      "`omp-conductor resume` alone will not hold — the next tick re-pauses while the files differ.",
    ].join("\n"),
  };
  const body = JSON.stringify({
    ok: true,
    result: { message_id: 99, chat: { id: 123456789 }, text: formatEscalation(bigPage, "demo") },
  });
  expect(body.length).toBeGreaterThan(400);

  const calls = stubFetch(() => new Response(body, { status: 200 }));
  const { tracker, comments } = makeTracker();
  const { store, marked } = makeStore();
  const p = makeProject({ telegramChatId: "123456789", fallbackToIssueComment: true });

  await createEscalator(p, tracker, store).escalate(bigPage);

  expect(calls.length).toBe(1);
  // Delivered exactly once, no fallback comment, and marked notified — the
  // three things a false rejection got wrong.
  expect(comments.length).toBe(0);
  expect(marked.length).toBe(1);
});

test("tier 2 with no chat id and no fallback throws instead of dropping the page", async () => {
  const { tracker, comments } = makeTracker();
  const { store, marked } = makeStore();
  const p = makeProject({ fallbackToIssueComment: false });

  await expect(createEscalator(p, tracker, store).escalate(tier2)).rejects.toThrow(
    /no escalation transport configured/,
  );
  expect(comments.length).toBe(0);
  expect(marked.length).toBe(0);
});

test("formatEscalation names the tier, issue number and summary", () => {
  const text = formatEscalation(tier2, "demo");

  expect(text).toContain("tier 2");
  expect(text).toContain("#4212");
  expect(text).toContain(tier2.summary);
  expect(text).toContain("demo");
  expect(text).toContain("run_def");
});

test("fleet-scoped pages render as 'fleet', never as '#0'", () => {
  expect(escalationIssueRef(0)).toBe("fleet");
  expect(escalationIssueRef(82)).toBe("#82");
  const text = formatEscalation({ ...tier2, issue: 0, summary: "integrity tripwire" }, "demo");
  expect(text).toContain("issue: fleet");
  expect(text).not.toContain("#0");
});

test("fleet-scoped pages cannot fall back to commenting on issue #0", async () => {
  const { tracker, comments } = makeTracker();
  const { store, marked } = makeStore();
  const p = makeProject({ fallbackToIssueComment: true });
  const fleetPage = {
    tier: 2 as const,
    project: "demo",
    issue: 0,
    summary: "Installed conductor changed under a running daemon — demo is paused",
  };

  await expect(createEscalator(p, tracker, store).escalate(fleetPage)).rejects.toThrow(
    /fleet-scoped|no issue to comment on/,
  );
  expect(comments.length).toBe(0);
  expect(marked.length).toBe(0);
});

test("a Telegram failure never leaks the bot token", async () => {
  // Worst case: the API echoes the full request URL — token and all — back at us.
  stubFetch(
    () =>
      new Response(`{"ok":false,"description":"bad request at https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage"}`, {
        status: 400,
      }),
  );
  const { tracker } = makeTracker();
  const { store, marked } = makeStore();
  const p = makeProject({ telegramChatId: "123456789", fallbackToIssueComment: false });

  const err = await createEscalator(p, tracker, store).escalate(tier2).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(Error);
  const message = err instanceof Error ? err.message : String(err);
  expect(message).not.toContain(FAKE_TOKEN);
  expect(message).not.toContain("AA-fake-test-token-not-a-secret");
  expect(message).toContain("<redacted>");
  expect(marked.length).toBe(0);
});

test("tier 2 falls back to an issue comment when the token file is missing", async () => {
  process.env.OMP_TELEGRAM_STATE_DIR = join(tokenDir, "does-not-exist");
  const { tracker, comments } = makeTracker();
  const { store } = makeStore();
  const p = makeProject({ telegramChatId: "123456789", fallbackToIssueComment: true });

  await createEscalator(p, tracker, store).escalate(tier2);

  expect(comments.length).toBe(1);
  expect(comments[0]?.body).toContain("tier 2");
});

test("a 200 response with ok:false is treated as a failure", async () => {
  stubFetch(() => new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 200 }));
  const { tracker } = makeTracker();
  const { store, marked } = makeStore();
  const p = makeProject({ telegramChatId: "123456789", fallbackToIssueComment: false });

  await expect(createEscalator(p, tracker, store).escalate(tier2)).rejects.toThrow(/rejected/);
  expect(marked.length).toBe(0);
});

/**
 * A handle whose `deliver` either accepts or refuses, and counts either way.
 * When it accepts, `settlesLater` hands the test control of the orchestrator's
 * turn for that injection — accepted now, failed whenever `failTurn` says.
 */
function makeOrchestrator(opts: { deliverRejects?: boolean; settlesLater?: boolean } = {}) {
  const delivered: { issue: number; project: string }[] = [];
  let failTurn: (cause: Error) => void = () => {
    throw new Error("this orchestrator settles immediately; pass settlesLater");
  };
  // The executor runs synchronously, so `failTurn` is live by the time this
  // returns — no timer anywhere in the settlement path.
  const settled = new Promise<void>((resolve, reject) => {
    if (!opts.settlesLater) {
      resolve();
      return;
    }
    failTurn = (cause: Error): void => {
      reject(cause);
    };
  });
  // The escalator attaches its handler a microtask later; nothing may crash the
  // runner in between.
  settled.catch(() => {});

  const orchestrator: OrchestratorHandle = {
    deliver: async (e, project) => {
      delivered.push({ issue: e.issue, project });
      if (opts.deliverRejects) throw new Error("orchestrator session is disposed");
      return { settled };
    },
    busy: () => false,
    sessionFile: () => undefined,
    dispose: async () => {},
  };
  return { orchestrator, delivered, failTurn };
}

/**
 * Runs the settlement tail to completion. It is a short chain of already-
 * settled promises, so draining the microtask queue is enough — a timer would
 * only add flakiness on a loaded machine.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test("tier 1 goes to the orchestrator, not to a human-facing issue comment", async () => {
  const { tracker, comments } = makeTracker();
  const { store, marked } = makeStore();
  const { orchestrator, delivered } = makeOrchestrator();
  const p = makeProject({ fallbackToIssueComment: true });

  await createEscalator(p, tracker, store, orchestrator).escalate(tier1);

  // Acceptance is the escalation: the run is parked and the orchestrator owns
  // it now, so nobody needs a comment about it.
  expect(delivered).toEqual([{ issue: 4211, project: "demo" }]);
  expect(comments.length).toBe(0);
  expect(marked.length).toBe(1);
});

test("an orchestrator that refuses the injection falls back to an issue comment", async () => {
  const { tracker, comments } = makeTracker();
  const { store, marked } = makeStore();
  const { orchestrator, delivered } = makeOrchestrator({ deliverRejects: true });
  const p = makeProject({ fallbackToIssueComment: true });

  await createEscalator(p, tracker, store, orchestrator).escalate(tier1);

  expect(delivered.length).toBe(1);
  // The re-briefing channel is down, so a human reads it instead. What must not
  // happen is the escalation disappearing between the two.
  expect(comments.length).toBe(1);
  expect(comments[0]?.body).toContain(tier1.summary);
  expect(marked.length).toBe(1);
});

test("a lone tier-1 injection that fails after acceptance falls back for itself", async () => {
  const { tracker, comments } = makeTracker();
  const { store, marked } = makeStore();
  const { orchestrator, delivered, failTurn } = makeOrchestrator({ settlesLater: true });
  const p = makeProject({ fallbackToIssueComment: true });

  // One escalation and nothing behind it. The bug this defends against lost
  // exactly this item — marked notified on acceptance — and then pushed the
  // *next*, unrelated escalation to the fallback in its place.
  await createEscalator(p, tracker, store, orchestrator).escalate(tier1);

  // Accepted, so the tick moved on. Nothing is owed to a human yet, and
  // nothing may be marked: acceptance is not delivery.
  expect(delivered).toEqual([{ issue: 4211, project: "demo" }]);
  expect(comments.length).toBe(0);
  expect(marked.length).toBe(0);

  // The orchestrator's turn for this injection dies minutes later.
  failTurn(new Error("orchestrator session died mid-turn"));
  await flushMicrotasks();

  expect(comments.length).toBe(1);
  expect(comments[0]?.issue).toBe(4211);
  expect(comments[0]?.body).toContain(tier1.summary);
  // Marked only once the fallback actually landed, never before.
  expect(marked).toEqual(["demo:4211:1:gate `bun test` failed twice on the same assertion"]);
});

test("a settlement failure with no fallback stays unmarked and stays visible", async () => {
  const { tracker, comments } = makeTracker();
  const { store, marked } = makeStore();
  const { orchestrator, failTurn } = makeOrchestrator({ settlesLater: true });
  const p = makeProject({ fallbackToIssueComment: false });

  const written: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await createEscalator(p, tracker, store, orchestrator).escalate(tier1);
    failTurn(new Error("orchestrator session died mid-turn"));
    await flushMicrotasks();
  } finally {
    process.stderr.write = realWrite;
  }

  expect(comments.length).toBe(0);
  // Deliberately unmarked: the next tick re-escalates. Writing the marker here
  // would be the daemon telling itself a human was paged when none was.
  expect(marked.length).toBe(0);
  // And it is not silent either — the daemon's log is its stderr.
  expect(written.join("")).toContain("#4211");
});