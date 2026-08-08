/**
 * Giving an answered block a way back into the queue.
 *
 * A blocked or failed run leaves its state label on the issue, and eligibility
 * treats any state label as disqualifying (`routing.isEligible`). That is the
 * right interlock — it is what stops a second worker landing on live work
 * across a daemon restart — but until this verb existed it had no exit: the
 * orchestrator's brief tells it never to hand-edit a state label, so an issue
 * whose question it had just answered could only be left labelled, which means
 * never re-claimed and the answer inert. Nothing surfaces that either: the
 * issue does not fail, it simply stops existing as far as dispatch is
 * concerned.
 *
 * So the clearing is a daemon-owned act, through the same tracker port the
 * dispatcher writes labels with, and the brief's rule stays absolute. That
 * absoluteness is worth more than the exception it replaces: orphan detection
 * is only trustworthy while every state label on the tracker was written by
 * this package.
 *
 * Nothing here writes to the store, and that is a decision rather than an
 * omission. `RunState` describes what a worker process did; an answer is the
 * one event that happens outside every run, so no member fits it — folding it
 * into `merged` or `killed` would make `status` describe a run that never
 * reached either. Eligibility is read off the tracker's labels and never off a
 * run row, so the store has nothing to say here. Leaving history alone keeps
 * both budgets honest: a block consumes an operational continuation, while a
 * real implementation failure consumes the separate failed-attempt budget.
 */

import { LIVE_STATES } from "./store.ts";
import type { Caps, ProjectConfig, RunRecord, Store, Tracker } from "./types.ts";

/** What one `unblock` did, and the state it found around it. */
export interface UnblockOutcome {
  /** State labels the tracker was asked to drop. */
  cleared: string[];
  /** Total run segments, retained for history and sequence numbering. */
  attemptsUsed: number;
  failuresUsed: number;
  continuationsUsed: number;
  /** Newest attempt, when the store has one for this issue at all. */
  latest?: RunRecord;
}

/**
 * Drop both terminal state labels, whichever the issue is actually carrying.
 *
 * Both unconditionally, because the tracker is the only source of truth for
 * which one is set and this process cannot read that back through the Tracker
 * port — inferring it from the newest run row would be a guess that goes wrong
 * exactly when a human has relabelled something by hand. Removing a label an
 * issue does not carry is a no-op: `gh issue edit --remove-label` exits 0 on an
 * absent label (verified against gh 2.97.0), and the adapter swallows the 404
 * older paths return for one.
 *
 * `agent:in-progress` is deliberately not in the set. It means a worker process
 * exists, which is not something an operator can answer away, and clearing it
 * from under a live run is how two workers end up on one issue.
 */
export async function unblockIssue(
  project: ProjectConfig,
  tracker: Tracker,
  store: Store,
  issue: number,
): Promise<UnblockOutcome> {
  const cleared: string[] = [];
  for (const label of new Set([project.stateLabels.blocked, project.stateLabels.failed])) {
    await tracker.removeLabel(issue, label);
    cleared.push(label);
  }

  const latest = store.latestRun(project.name, issue);
  return {
    cleared,
    attemptsUsed: store.attemptsFor(project.name, issue),
    failuresUsed: store.failuresFor(project.name, issue),
    continuationsUsed: store.continuationsFor(project.name, issue),
    ...(latest === undefined ? {} : { latest }),
  };
}

/**
 * What the operator reads back. It promises a re-claim only when one can
 * actually happen: a live run still owns the issue through `agent:in-progress`,
 * and a spent attempt budget makes the next tick escalate rather than dispatch.
 * Either promised blindly would send someone away believing work had resumed.
 */
export function formatUnblock(
  issue: number,
  o: UnblockOutcome,
  project: ProjectConfig,
  caps: Caps,
): string {
  const latest = o.latest;
  const lines = [`#${issue}: cleared ${o.cleared.join(", ")}`];

  if (latest === undefined) {
    lines.push("  runs       none recorded — the labels were cleared anyway; eligibility is read off the tracker");
  } else {
    lines.push(`  runs       ${o.attemptsUsed}, newest ${latest.state}`);
    lines.push(`  failures   ${o.failuresUsed} of ${caps.maxAttemptsPerIssue}`);
    lines.push(`  continuations ${o.continuationsUsed} of ${caps.maxContinuationsPerIssue}`);
  }

  if (latest !== undefined && LIVE_STATES.includes(latest.state)) {
    lines.push(
      `  in flight  attempt ${latest.attempt} is ${latest.state}, so the issue keeps ` +
        `"${project.stateLabels.inProgress}" until it ends — nothing is re-claimed before then`,
    );
  } else if (o.failuresUsed >= caps.maxAttemptsPerIssue) {
    lines.push(
      `  next tick  not eligible: all ${caps.maxAttemptsPerIssue} failed attempts are spent. ` +
        "Rewrite the issue or raise maxAttemptsPerIssue.",
    );
  } else if (o.continuationsUsed > caps.maxContinuationsPerIssue) {
    lines.push(
      `  next tick  not eligible: the ${caps.maxContinuationsPerIssue}-continuation budget was exceeded. ` +
        "Inspect progress or raise maxContinuationsPerIssue.",
    );
  } else {
    lines.push(`  next tick  eligible again, as long as the issue still carries "${project.queueLabel}"`);
  }

  return lines.join("\n");
}
