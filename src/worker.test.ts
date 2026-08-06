/**
 * Deterministic worker logic only: brief rendering and the report -> state
 * derivation. Nothing here starts a session, so the suite never touches the
 * network or the omp peer dependency.
 */

import { describe, expect, test } from "bun:test";
import { deriveResult, renderBrief } from "./worker.ts";

describe("renderBrief", () => {
  test("substitutes every known placeholder, including repeats", () => {
    const rendered = renderBrief(
      "Fix #{{ISSUE_NUMBER}} in {{REPO}} on branch {{BRANCH}}.\nPR must target {{REPO}}.",
      { ISSUE_NUMBER: "412", REPO: "chad", BRANCH: "fix/flaky-gate" },
    );

    expect(rendered).toBe("Fix #412 in chad on branch fix/flaky-gate.\nPR must target chad.");
  });

  test("leaves an unknown placeholder verbatim", () => {
    const rendered = renderBrief("Repo {{REPO}}, acceptance {{ACCEPTANCE_CRITERIA}}.", {
      REPO: "warden",
    });

    expect(rendered).toBe("Repo warden, acceptance {{ACCEPTANCE_CRITERIA}}.");
    expect(rendered).not.toContain("undefined");
  });
});

describe("deriveResult", () => {
  test("reads pushed-green and the PR url out of a green report", () => {
    const report = [
      "state: pushed-green",
      "pr: https://github.com/TerrifiedBug/chad/pull/1487",
      "gates: all green",
    ].join("\n");

    expect(deriveResult(report)).toEqual({
      state: "pushed-green",
      prUrl: "https://github.com/TerrifiedBug/chad/pull/1487",
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
