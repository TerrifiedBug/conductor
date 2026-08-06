/**
 * The orchestrator's wiring, driven against a hand-written session.
 *
 * Everything worth testing here is timing and event bookkeeping — is a busy
 * session followed up rather than interrupted, do two escalations in one tick
 * stay two prompts, does a non-terminal `agent_end` still count as working — and
 * none of it needs a model. The fake is injected through
 * `OrchestratorOpts.createSessionImpl`, so no test touches the omp peer
 * dependency, the network, or the operator's real state directory.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSessionLike } from "./omp.ts";
import { formatInjection, nextStreamingBehavior, startOrchestrator } from "./orchestrator.ts";
import type { CreateSessionFn } from "./orchestrator.ts";
import type { Escalation } from "./types.ts";

const FAKE_TRANSCRIPT = "/tmp/conductor-fake-orchestrator.jsonl";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type PromptCall = { text: string; opts: Record<string, unknown> };

/**
 * A session the test drives directly: every `prompt()` is recorded, every
 * `on()` handler is kept so `emit()` can fire the harness events the
 * orchestrator reads, `failNextPrompt()` reproduces a session that has stopped
 * accepting work, and `failNextPromptLater()` reproduces the nastier one — a
 * session that accepts the injection and only then dies mid-turn.
 */
function makeFake() {
  const prompts: PromptCall[] = [];
  const created: Parameters<CreateSessionFn>[0][] = [];
  const handlers = new Map<string, ((e: unknown) => void)[]>();
  let promptFailure: Error | undefined;
  let pendingSettlement: Promise<void> | undefined;

  const session: AgentSessionLike = {
    // Deliberately not `async`: a dead harness session rejects the call itself,
    // and the orchestrator's acceptance rule turns on that being synchronous.
    prompt(text, opts) {
      prompts.push({ text, opts: opts ?? {} });
      const failure = promptFailure;
      if (failure !== undefined) {
        promptFailure = undefined;
        throw failure;
      }
      const deferred = pendingSettlement;
      if (deferred !== undefined) {
        pendingSettlement = undefined;
        return deferred;
      }
      return Promise.resolve(undefined);
    },
    on(event, cb) {
      const list = handlers.get(event);
      if (list) list.push(cb);
      else handlers.set(event, [cb]);
    },
    abort() {},
    sessionFile: FAKE_TRANSCRIPT,
  };

  const create: CreateSessionFn = (opts) => {
    created.push(opts);
    return Promise.resolve(session);
  };

  return {
    prompts,
    created,
    create,
    emit(type: string, payload: Record<string, unknown> = {}): void {
      for (const cb of handlers.get(type) ?? []) cb({ type, ...payload });
    },
    failNextPrompt(error: Error): void {
      promptFailure = error;
    },
    /**
     * The next prompt is *accepted*; its turn fails only when the returned
     * handle is called. This is the failure that used to be carried forward
     * and blamed on whichever escalation happened to arrive next.
     */
    failNextPromptLater(): (cause: Error) => void {
      let fail!: (cause: Error) => void;
      pendingSettlement = new Promise<void>((_resolve, reject) => {
        fail = (cause: Error): void => {
          reject(cause);
        };
      });
      return fail;
    },
  };
}

/** A throwaway session directory, so no test writes into `~/.omp/conductor`. */
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "conductor-orchestrator-"));
  tempDirs.push(dir);
  return dir;
}

const blocked: Escalation = {
  tier: 1,
  project: "veltro",
  issue: 4211,
  summary: "worker blocked twice on the same failing gate",
  detail: "bun test: 2 failing in warden/tests/test_runbooks.py",
  runId: "run_abc",
};

const conflict: Escalation = {
  tier: 1,
  project: "veltro",
  issue: 4300,
  summary: "branch conflicts with main after a force-push",
  runId: "run_def",
};

describe("startOrchestrator", () => {
  test("an escalation delivered to an idle session prompts once, with no streamingBehavior", async () => {
    const fake = makeFake();
    const dir = scratchDir();

    const orchestrator = await startOrchestrator({
      cwd: dir,
      sessionDir: dir,
      createSessionImpl: fake.create,
    });
    await orchestrator.deliver(blocked, "veltro");

    // Resumed, not fresh: a restarted daemon must not forget what it escalated.
    expect(fake.created.length).toBe(1);
    expect(fake.created[0]?.resume).toBe(true);
    expect(fake.created[0]?.sessionDir).toBe(dir);

    expect(fake.prompts.length).toBe(1);
    // An idle session takes a plain prompt; asking for a behaviour it has no
    // stream to attach to is how a harness bump starts rejecting injections.
    expect("streamingBehavior" in (fake.prompts[0]?.opts ?? {})).toBe(false);
    expect(fake.prompts[0]?.text).toContain("#4211");
    expect(orchestrator.sessionFile()).toBe(FAKE_TRANSCRIPT);
  });

  test("a turn still in flight makes the next injection a follow-up", async () => {
    const fake = makeFake();
    const dir = scratchDir();

    const orchestrator = await startOrchestrator({
      cwd: dir,
      sessionDir: dir,
      createSessionImpl: fake.create,
    });
    // A turn started and never ended: the orchestrator is mid-thought.
    fake.emit("turn_start");
    expect(orchestrator.busy()).toBe(true);

    await orchestrator.deliver(blocked, "veltro");

    expect(fake.prompts.length).toBe(1);
    // Queued behind the turn in flight rather than interrupting it — a bare
    // prompt against a streaming session throws the escalation away.
    expect(fake.prompts[0]?.opts["streamingBehavior"]).toBe("followUp");
  });

  test("busy is cleared only by a terminal agent_end", async () => {
    const fake = makeFake();
    const dir = scratchDir();

    const orchestrator = await startOrchestrator({
      cwd: dir,
      sessionDir: dir,
      createSessionImpl: fake.create,
    });
    fake.emit("turn_start");

    // The harness will resume this session, so it is still working. Reading
    // this as idle is what makes the next injection a bare prompt.
    fake.emit("agent_end", { isTerminal: false });
    expect(orchestrator.busy()).toBe(true);

    fake.emit("agent_end", { isTerminal: true });
    expect(orchestrator.busy()).toBe(false);

    // `agent_start` is the other busy signal, and an absent `isTerminal` is
    // terminal — older harnesses never set it.
    fake.emit("agent_start");
    expect(orchestrator.busy()).toBe(true);
    fake.emit("agent_end");
    expect(orchestrator.busy()).toBe(false);
  });

  test("two escalations delivered without awaiting produce two prompts, in order", async () => {
    const fake = makeFake();
    const dir = scratchDir();

    const orchestrator = await startOrchestrator({
      cwd: dir,
      sessionDir: dir,
      createSessionImpl: fake.create,
    });
    // Exactly what one tick does when it finds two stuck runs: fire both and
    // await them together. Neither may be dropped or merged into the other.
    const first = orchestrator.deliver(blocked, "veltro");
    const second = orchestrator.deliver(conflict, "veltro");
    await Promise.all([first, second]);

    expect(fake.prompts.length).toBe(2);
    expect(fake.prompts[0]?.text).toContain("#4211");
    expect(fake.prompts[1]?.text).toContain("#4300");
  });

  test("a rejected prompt rejects that delivery and leaves the queue usable", async () => {
    const fake = makeFake();
    const dir = scratchDir();

    const orchestrator = await startOrchestrator({
      cwd: dir,
      sessionDir: dir,
      createSessionImpl: fake.create,
    });
    fake.failNextPrompt(new Error("session is not accepting prompts"));

    // Rejected, never thrown synchronously: the escalator catches this and
    // falls back to an issue comment instead of losing the escalation.
    await expect(orchestrator.deliver(blocked, "veltro")).rejects.toThrow(/not accepting/);
    // One bad injection must not poison the queue behind it.
    await orchestrator.deliver(conflict, "veltro");
    expect(fake.prompts.length).toBe(2);
  });

  test("the standing-orders brief rides the first injection and only that one", async () => {
    const fake = makeFake();
    const dir = scratchDir();

    const orchestrator = await startOrchestrator({
      cwd: dir,
      sessionDir: dir,
      brief: "STANDING ORDERS: re-brief workers, never edit product code.",
      createSessionImpl: fake.create,
    });
    await orchestrator.deliver(blocked, "veltro");
    await orchestrator.deliver(conflict, "veltro");

    expect(fake.prompts[0]?.text).toContain("STANDING ORDERS");
    expect(fake.prompts[0]?.text).toContain("#4211");
    expect(fake.prompts[1]?.text).not.toContain("STANDING ORDERS");
  });

  test("after dispose a delivery rejects rather than vanishing", async () => {
    const fake = makeFake();
    const dir = scratchDir();

    const orchestrator = await startOrchestrator({
      cwd: dir,
      sessionDir: dir,
      createSessionImpl: fake.create,
    });
    // Idempotent, and a fake session the harness never registered a disposer
    // for must not make shutdown throw.
    await orchestrator.dispose();
    await orchestrator.dispose();

    await expect(orchestrator.deliver(blocked, "veltro")).rejects.toThrow(/disposed/);
    expect(fake.prompts.length).toBe(0);
  });

  test("a prompt that fails after acceptance rejects only its own receipt", async () => {
    const fake = makeFake();
    const dir = scratchDir();

    const orchestrator = await startOrchestrator({
      cwd: dir,
      sessionDir: dir,
      createSessionImpl: fake.create,
    });
    const failTurn = fake.failNextPromptLater();

    // Accepted: the harness took the prompt, so the tick is free to move on
    // even though this turn will run for minutes.
    const receipt = await orchestrator.deliver(blocked, "veltro");
    expect(fake.prompts.length).toBe(1);

    // ...and then the turn dies. The failure belongs to #4211 and comes back on
    // #4211's own receipt, which is what lets the escalator fall *this* item
    // back rather than dropping it and blaming the next escalation for it.
    failTurn(new Error("session died mid-turn"));
    await expect(receipt.settled).rejects.toThrow(/died mid-turn/);

    // The next escalation carries none of that: accepted, and clean.
    const next = await orchestrator.deliver(conflict, "veltro");
    await next.settled;
    expect(fake.prompts.length).toBe(2);
    expect(fake.prompts[1]?.text).toContain("#4300");
  });

  test("a prompt that throws synchronously rejects deliver itself, with no receipt", async () => {
    const fake = makeFake();
    const dir = scratchDir();

    const orchestrator = await startOrchestrator({
      cwd: dir,
      sessionDir: dir,
      createSessionImpl: fake.create,
    });
    fake.failNextPrompt(new Error("session is not accepting prompts"));

    // Never accepted, so there is no receipt to watch: the caller's catch is
    // the whole signal, and it fires before the escalator has marked anything.
    await expect(orchestrator.deliver(blocked, "veltro")).rejects.toThrow(/not accepting/);

    // The session is usable again, and the next delivery gets a real receipt.
    const receipt = await orchestrator.deliver(conflict, "veltro");
    await receipt.settled;
    expect(fake.prompts.length).toBe(2);
  });
});

describe("formatInjection", () => {
  test("names the tier, the issue, the summary and the no-editing rule", () => {
    const text = formatInjection(blocked, "veltro");

    expect(text).toContain("tier 1");
    expect(text).toContain("#4211");
    expect(text).toContain(blocked.summary);
    expect(text).toContain("run_abc");
    // The session has no other context: without this it will happily open the
    // worktree and start editing, which is a worker's job.
    expect(text).toContain("Do not edit product code");
    // Both options a tier-1 escalation may end in are stated, so the choice is
    // the orchestrator's rather than whatever it improvises.
    expect(text).toContain("RE-BRIEF");
    expect(text).toContain("TIER 2");
  });

  test("a tier-2 injection says the human is already being paged", () => {
    const text = formatInjection({ ...blocked, tier: 2 }, "veltro");

    expect(text).toContain("tier 2");
    expect(text).toContain("Do not edit product code");
    expect(text).not.toContain("RE-BRIEF");
  });
});

describe("nextStreamingBehavior", () => {
  test("queues behind a busy session and stays absent for an idle one", () => {
    expect(nextStreamingBehavior(true)).toBe("followUp");
    expect(nextStreamingBehavior(false)).toBeUndefined();
  });
});
