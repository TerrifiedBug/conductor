/**
 * The orchestrator: one long-lived session that receives tier-1 escalations as
 * injected prompts.
 *
 * Without it, a tier-1 escalation dead-ends in a GitHub comment nobody reads
 * until morning — which is the same as a blocked worker staying blocked. With
 * it, the escalation lands in a session that can re-brief the worker, file the
 * follow-up issue, or decide the problem really does need a human.
 *
 * Three properties are load-bearing:
 *
 *  1. **Persistent.** The session is file-backed and *resumed*, so restarting
 *     the daemon does not erase the orchestrator's memory of what it has
 *     already escalated, re-briefed and given up on.
 *  2. **Non-blocking.** `deliver()` resolves when the harness has *accepted* the
 *     prompt, never when the model has answered it. The dispatcher tick that
 *     produced the escalation must not sit behind a model for ten minutes.
 *  3. **Serialised.** Two escalations noticed in the same tick become two
 *     prompts, in order — never two concurrent `prompt()` calls racing over
 *     which of them is the follow-up to a busy session.
 *
 * It does not edit product code. That is a worker's job, and every injection
 * says so out loud, because the session has no other context to infer it from.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "./config.ts";
import { formatEscalation } from "./escalate.ts";
import { createSession, disposeSession } from "./omp.ts";
import type { AgentSessionLike } from "./omp.ts";
import type { Escalation } from "./types.ts";

/**
 * The session factory {@link startOrchestrator} uses. Named so the test seam
 * below has a type to satisfy without reaching into the harness.
 */
export type CreateSessionFn = (opts: {
  cwd: string;
  sessionDir?: string;
  model?: string;
  resume?: boolean;
}) => Promise<AgentSessionLike>;

export interface OrchestratorHandle {
  /** Inject an escalation as a prompt. Resolves once accepted, not once answered. */
  deliver(e: Escalation, project: string): Promise<void>;
  busy(): boolean;
  sessionFile(): string | undefined;
  dispose(): Promise<void>;
}

export interface OrchestratorOpts {
  cwd: string;
  sessionDir?: string;
  model?: string;
  /**
   * Standing orders — which repo, which labels, what the fleet is. Prepended to
   * the *first* injection rather than sent as its own prompt on startup: a
   * daemon that boots, is briefed and escalates nothing has then paid for a
   * model turn that did no work. The brief is not lost, it just waits for
   * something to attach itself to.
   */
  brief?: string;
  /**
   * Test seam, and only that. Production always wants the real
   * {@link createSession}; the unit suite substitutes a hand-written
   * {@link AgentSessionLike} so it can drive the event stream and read back
   * every `prompt()` call without the harness or the network.
   */
  createSessionImpl?: CreateSessionFn;
}

/**
 * `streamingBehavior` for the next prompt.
 *
 * A busy session rejects a bare `prompt()` — that is work thrown away, and the
 * escalation with it. `"followUp"` queues the injection behind the turn in
 * flight, which is what an escalation arriving mid-thought should do: the
 * orchestrator finishes its current reasoning, then reads the new one. `"steer"`
 * would interrupt it, and interrupting the session that is already handling the
 * previous escalation is how two escalations become one confused answer.
 */
export function nextStreamingBehavior(busy: boolean): "followUp" | undefined {
  return busy ? "followUp" : undefined;
}

/**
 * The injected prompt.
 *
 * Self-contained by necessity: the orchestrator holds none of the dispatcher's
 * state, so an injection that says only "issue #4211 is blocked" is unactionable.
 * It carries the same body a human would have received ({@link formatEscalation},
 * so the two never disagree) plus an explicit statement of what this session is
 * expected to *do* about it.
 */
export function formatInjection(e: Escalation, project: string): string {
  const expectation =
    e.tier === 1
      ? [
          "What is expected of you (tier 1 — yours to resolve; no human has been paged):",
          `  1. Read issue #${e.issue} and the run's transcript before deciding anything.`,
          "  2. Then choose exactly one:",
          `     (a) RE-BRIEF — say concretely what to change in the worker's brief for issue #${e.issue}:`,
          "         what to do differently, what to leave alone, which gate to satisfy first. Then re-queue it.",
          "     (b) PROMOTE TO TIER 2 — only when this needs a decision, a credential or an approval",
          "         a human owns. Say why re-briefing cannot work.",
          "  3. Do not edit product code yourself, and do not push or merge. You re-brief workers,",
          "     file and comment on issues, and page the human. A worker session does the editing.",
        ]
      : [
          "What is expected of you (tier 2 — the human is being paged directly):",
          "  Leave the issue in a state they can pick up: record what happened and what you already tried.",
          "  Do not edit product code yourself, and do not act on the fleet until they answer.",
        ];

  return [
    formatEscalation(e, project),
    "",
    `You are the omp-conductor orchestrator for project "${project}". The dispatcher`,
    "could not resolve the above on its own and has handed it to you.",
    "",
    ...expectation,
  ].join("\n");
}

export async function startOrchestrator(o: OrchestratorOpts): Promise<OrchestratorHandle> {
  const sessionDir = o.sessionDir ?? join(stateDir(), "orchestrator");
  // Its own directory, separate from the workers': `resume: true` continues the
  // most recent transcript *for this directory*, so sharing one with two dozen
  // worker sessions would resume whichever worker last wrote. Created here
  // because a missing parent is a session-startup failure, not a harness bug.
  mkdirSync(sessionDir, { recursive: true });

  const create = o.createSessionImpl ?? createSession;
  const session = await create({
    cwd: o.cwd,
    sessionDir,
    ...(o.model === undefined ? {} : { model: o.model }),
    // The whole point of a persistent orchestrator: a daemon restart must not
    // reset what it knows it has already escalated, or the first tick after a
    // deploy re-litigates every parked issue from scratch.
    resume: true,
  });

  // Busy tracked from the harness's own events, never guessed from our prompt
  // calls: an injection can trigger a turn that outlives the call, and the
  // session also turns on its own (resumed maintenance, async delivery).
  let streaming = false;
  for (const started of ["turn_start", "agent_start"]) {
    session.on(started, () => {
      streaming = true;
    });
  }
  session.on("agent_end", (event) => {
    // The event union lives in the peer dependency, so read the one field this
    // needs off the raw payload. `isTerminal: false` means the harness will
    // resume this session: it is still working, and reading that as idle makes
    // the very next injection a bare `prompt()` against a streaming session —
    // thrown-away work. Absent is terminal, for harnesses that never set it.
    const isTerminal =
      event !== null && typeof event === "object" ? Reflect.get(event, "isTerminal") : undefined;
    if (isTerminal === false) return;
    streaming = false;
  });

  let disposed = false;
  /** Tail of the delivery queue. Always settled-or-settling, never rejected. */
  let queue: Promise<void> = Promise.resolve();
  /** Consumed by the first injection; see {@link OrchestratorOpts.brief}. */
  let standingOrders = o.brief;
  /**
   * A prompt that failed *after* acceptance. Reported to the next `deliver()`
   * and then cleared, so a session that has started rejecting routes the
   * following escalation to the caller's fallback instead of swallowing it. The
   * previous escalation is already lost by then — that is the price of not
   * blocking the tick — and this is what stops it becoming every escalation.
   */
  let carriedFailure: Error | undefined;

  /**
   * Issue one prompt. Runs inside the queue, so the streaming flag is read at
   * the moment the prompt is actually handed over rather than when it was
   * queued — the escalation ahead of it in the queue may have started a turn.
   */
  const issue = (e: Escalation, project: string): void => {
    if (disposed) {
      throw new Error(
        `orchestrator session is disposed; tier ${e.tier} escalation on issue #${e.issue} was not injected`,
      );
    }
    const failure = carriedFailure;
    if (failure !== undefined) {
      carriedFailure = undefined;
      throw new Error(`orchestrator session rejected its previous injection: ${failure.message}`, {
        cause: failure,
      });
    }

    const injection = formatInjection(e, project);
    const text = standingOrders === undefined ? injection : `${standingOrders}\n\n${injection}`;
    const behavior = nextStreamingBehavior(streaming);
    const opts = behavior === undefined ? {} : { streamingBehavior: behavior };

    // Accepted, not answered. `prompt()` resolves when the turn ends, which for
    // a re-brief is minutes; the tick that found this escalation has other
    // issues to service. A synchronous throw is therefore the only failure the
    // caller can see in time to fall back — later ones are carried above.
    const pending = session.prompt(text, opts);
    // Only reached once the harness took the prompt, so the brief has landed.
    standingOrders = undefined;
    void Promise.resolve(pending).catch((cause: unknown) => {
      carriedFailure = cause instanceof Error ? cause : new Error(String(cause));
    });
  };

  return {
    deliver(e: Escalation, project: string): Promise<void> {
      // Never throws synchronously, by construction: `issue()` runs inside the
      // chain below, so a transport problem always arrives as a rejected
      // promise the caller can catch and route to its own fallback. The caller
      // decides what an unreachable orchestrator means; this module does not.
      const accepted = queue.then(() => {
        issue(e, project);
      });
      // The queue outlives a rejected delivery: one unreachable injection must
      // not poison every escalation queued behind it.
      queue = accepted.then(
        () => {},
        () => {},
      );
      return accepted;
    },
    busy: () => streaming,
    // The path the harness actually opened, read live: the transcript is how a
    // human audits what the orchestrator decided on their behalf.
    sessionFile: () => session.sessionFile,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Anything already queued still runs — it either got its prompt in, or it
      // rejects on the `disposed` check above and its caller falls back. Both
      // beat dropping it silently during shutdown.
      await queue;
      // Tolerates a session the harness never gave us a disposer for (a
      // hand-written fake, an older harness build with no `dispose()`): a
      // teardown crash here would take the daemon's shutdown path with it.
      try {
        await disposeSession(session);
      } catch {
        // Teardown noise must not fail a shutdown that is otherwise clean.
      }
    },
  };
}
