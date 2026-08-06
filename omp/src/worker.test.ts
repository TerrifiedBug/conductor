/**
 * Deterministic worker logic only: brief rendering, the report -> state
 * derivation, and the `agent_end` completion rule. Nothing here starts a
 * session, so the suite never touches the network or the omp peer dependency.
 * Whether two real sessions run side by side is an integration question — a
 * fake SDK here would only ever test the fake.
 */

import { describe, expect, test } from "bun:test";
import { deriveResult, renderBrief, shouldComplete } from "./worker.ts";

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
  test("reads pushed-green and the PR url out of a green report", () => {
    const report = [
      "state: pushed-green",
      "pr: https://github.com/acme/api/pull/1487",
      "gates: all green",
    ].join("\n");

    expect(deriveResult(report)).toEqual({
      state: "pushed-green",
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
