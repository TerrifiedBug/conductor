/**
 * The open-PR guard's state filter, against payloads recorded from a real host.
 *
 * The filter exists because two plausible spellings of this query are wrong in
 * opposite directions, and both were measured on `gh 2.86.0` (2026-08-06) before
 * this code was written: `gh issue view --json closedByPullRequestsReferences`
 * returns no state at all, and `includeClosedPrs:false` does not exclude merged
 * references. A guard that trusted either one would either hold a reopened issue
 * forever or admit an issue whose work is already pushed. So the payloads below
 * are transcripts, not inventions.
 */

import { expect, test } from "bun:test";
import { DEFAULT_AUTHORITY } from "../types.ts";
import { firstOpenCloser, makeTracker, parentNumberFrom, prStateFrom, prVerificationFrom } from "./github.ts";

/** The `gh api graphql` envelope, with whatever references the test needs. */
function reply(nodes: unknown[] | null): string {
  return JSON.stringify({
    data: { repository: { issue: { closedByPullRequestsReferences: { nodes } } } },
  });
}

test("the recorded cross-repo OPEN reference is the closer", () => {
  // Verbatim from veltro#288 on the fleet that found this gap: the closing PR
  // lives in a different repo from the issue, which is the normal shape for a
  // tracker-and-modules project and must not confuse the lookup.
  const raw = reply([
    {
      number: 419,
      state: "OPEN",
      isDraft: false,
      url: "https://github.com/veltrosecurity/chad/pull/419",
      repository: { nameWithOwner: "veltrosecurity/chad" },
    },
  ]);

  expect(firstOpenCloser(raw)).toBe("https://github.com/veltrosecurity/chad/pull/419");
});

test("a MERGED reference is not a closer, however the API was asked", () => {
  // veltro#260 returned 269:MERGED with `includeClosedPrs` both true and false,
  // so the argument is not a filter and the state has to be read. Holding here
  // would strand every issue that has ever been worked — and a reopened issue,
  // whose reference is merged or closed-unmerged, would never be dispatched.
  const raw = reply([
    {
      number: 269,
      state: "MERGED",
      isDraft: false,
      url: "https://github.com/veltrosecurity/veltro/pull/269",
      repository: { nameWithOwner: "veltrosecurity/veltro" },
    },
    {
      number: 270,
      state: "CLOSED",
      isDraft: false,
      url: "https://github.com/veltrosecurity/veltro/pull/270",
      repository: { nameWithOwner: "veltrosecurity/veltro" },
    },
  ]);

  expect(firstOpenCloser(raw)).toBeUndefined();
});

test("an OPEN draft is a closer, and wins over a merged reference", () => {
  // Draft means "not ready to review", not "not pushed": the branch behind it is
  // the only copy of the work. A second worker on the issue duplicates that work
  // exactly as much as it would with a ready PR.
  const raw = reply([
    {
      number: 269,
      state: "MERGED",
      isDraft: false,
      url: "https://github.com/acme/api/pull/269",
      repository: { nameWithOwner: "acme/api" },
    },
    {
      number: 419,
      state: "OPEN",
      isDraft: true,
      url: "https://github.com/acme/api/pull/419",
      repository: { nameWithOwner: "acme/api" },
    },
  ]);

  expect(firstOpenCloser(raw)).toBe("https://github.com/acme/api/pull/419");
});

test("an issue with no references, and one the API answers null for, are both open season", () => {
  expect(firstOpenCloser(reply([]))).toBeUndefined();
  expect(firstOpenCloser(reply(null))).toBeUndefined();
  // Every level of the reply is nullable: a deleted or renumbered issue answers
  // `null` rather than erroring, and that must read as "no closer", not crash a
  // tick.
  expect(firstOpenCloser(JSON.stringify({ data: { repository: null } }))).toBeUndefined();
});

test("MERGED, CLOSED and OPEN are the only answers; anything else is 'could not tell'", () => {
  // The three spellings `gh pr view --json state` emits, verified on gh 2.97.0
  // against a merged, a closed-unmerged and an open PR.
  expect(prStateFrom("MERGED\n")).toBe("merged");
  expect(prStateFrom("CLOSED\n")).toBe("closed");
  expect(prStateFrom("OPEN\n")).toBe("open");

  // Undefined is "could not tell", and the settle sweep leaves a row alone on
  // it. Coercing unknown text to any of the three would settle a run on a guess
  // — and `merged` is unwritten history that no other record can correct.
  expect(prStateFrom("")).toBeUndefined();
  expect(prStateFrom("merged")).toBeUndefined();
  expect(prStateFrom("DRAFT")).toBeUndefined();
});


const HEAD_SHA = "a".repeat(40);

function verificationReply(
  checks: unknown[],
  over: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    state: "OPEN",
    isDraft: false,
    headRefOid: HEAD_SHA,
    statusCheckRollup: checks,
    ...over,
  });
}

test("an open PR at the observed head with terminal successful checks is green", () => {
  expect(
    prVerificationFrom(
      verificationReply([
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
      ]),
      HEAD_SHA,
    ),
  ).toEqual({ status: "green", reason: "2 checks succeeded or were skipped" });
});

test("missing or nonterminal checks are pending, never green", () => {
  expect(prVerificationFrom(verificationReply([]), HEAD_SHA).status).toBe("pending");
  expect(
    prVerificationFrom(
      verificationReply([
        { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "" },
      ]),
      HEAD_SHA,
    ),
  ).toEqual({ status: "pending", reason: "Checks pending: test" });
});

test("a late PR head change invalidates the worker's green observation", () => {
  const actual = "b".repeat(40);
  expect(
    prVerificationFrom(
      verificationReply(
        [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
        { headRefOid: actual },
      ),
      HEAD_SHA,
    ),
  ).toEqual({
    status: "failed",
    reason: `PR head changed: expected ${HEAD_SHA}, found ${actual}`,
  });
});

test("cancelled and red checks return a concise job digest", () => {
  expect(
    prVerificationFrom(
      verificationReply([
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "CANCELLED" },
      ]),
      HEAD_SHA,
    ),
  ).toEqual({
    status: "failed",
    reason: "Checks failed: test (FAILURE), lint (CANCELLED)",
  });
});

test("the tracker appends bounded failed-step logs to a failed check digest", async () => {
  const calls: string[][] = [];
  const tracker = makeTracker(
    {
      name: "demo",
      tracker: { kind: "github", repo: "acme/planning" },
      queueLabel: "ready-for-agent",
      stateLabels: {
        inProgress: "agent:in-progress",
        blocked: "agent:blocked",
        failed: "agent:failed",
      },
      routing: { labelPrefix: "repo:", repos: {} },
      caps: {},
      escalation: { fallbackToIssueComment: true, orchestrator: "embedded" },
      authority: { ...DEFAULT_AUTHORITY },
      workspaceRoot: "/tmp/conductor/work",
      mirrorRoot: "/tmp/conductor/mirrors",
    },
    async (argv) => {
      calls.push(argv);
      if (argv[0] === "pr") {
        return verificationReply([
          {
            __typename: "CheckRun",
            name: "test",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://github.com/acme/api/actions/runs/123/job/456",
          },
        ]);
      }
      return "test\tFAIL\tAssertionError: expected 2, received 3\n";
    },
  );

  const result = await tracker.verifyPr("https://github.com/acme/api/pull/7", HEAD_SHA);
  expect(result?.reason).toContain("test (FAILURE)");
  expect(result?.reason).toContain("AssertionError: expected 2, received 3");
  expect(calls[1]).toEqual([
    "run",
    "view",
    "123",
    "--repo",
    "acme/api",
    "--job",
    "456",
    "--log-failed",
  ]);
});
test("a prUrl that is not a pull request URL is never handed to gh", async () => {
  // `gh pr view` also accepts a bare number or a *branch name*, and resolves
  // those against whatever repository the current directory belongs to. The
  // daemon runs from its own state directory while the PR lives in a routed
  // repo, so an unguarded lookup would not fail loudly — it would answer,
  // confidently, about some other repository's pull request, and the settle
  // sweep would mark the wrong run merged. Counting spawns rather than only the
  // answer, because `gh` returns undefined for most of these too: the property
  // worth pinning is that the process is never started at all.
  const tracker = makeTracker({
    name: "demo",
    tracker: { kind: "github", repo: "acme/planning" },
    queueLabel: "ready-for-agent",
    stateLabels: {
      inProgress: "agent:in-progress",
      blocked: "agent:blocked",
      failed: "agent:failed",
    },
    routing: { labelPrefix: "repo:", repos: {} },
    caps: {},
    escalation: { fallbackToIssueComment: true, orchestrator: "embedded" },
    authority: { ...DEFAULT_AUTHORITY },
    workspaceRoot: "/tmp/conductor/work",
    mirrorRoot: "/tmp/conductor/mirrors",
  });

  const realSpawn = Bun.spawn;
  let spawned = 0;
  Bun.spawn = ((...args: Parameters<typeof realSpawn>) => {
    spawned += 1;
    return realSpawn(...args);
  }) as typeof realSpawn;
  try {
    for (const bad of [
      "conductor/issue-140",
      "293",
      "https://github.com/acme/api/issues/293",
      "https://github.com/acme/api/pull/",
      "",
    ]) {
      expect(await tracker.prState(bad)).toBeUndefined();
    }
  } finally {
    Bun.spawn = realSpawn;
  }

  expect(spawned).toBe(0);
});

function parentReply(parent: unknown): string {
  return JSON.stringify({ data: { repository: { issue: { parent } } } });
}

test("a linked sub-issue reports its parent number from raw GraphQL", () => {
  const raw = parentReply({ number: 47 });
  expect(parentNumberFrom(raw)).toBe(47);
});

test("an issue with no parent is not epic-serialized", () => {
  expect(parentNumberFrom(parentReply(null))).toBeUndefined();
});

test("a parent payload without a usable number fails closed", () => {
  expect(() => parentNumberFrom(parentReply({ title: "Epic" }))).toThrow(
    /unexpected parent number/,
  );
});

test("parent lookup uses raw GraphQL supported by gh 2.86", async () => {
  const calls: string[][] = [];
  const tracker = makeTracker(
    {
      name: "demo",
      tracker: { kind: "github", repo: "acme/planning" },
      queueLabel: "ready-for-agent",
      stateLabels: {
        inProgress: "agent:in-progress",
        blocked: "agent:blocked",
        failed: "agent:failed",
      },
      routing: { labelPrefix: "repo:", repos: {} },
      caps: {},
      escalation: { fallbackToIssueComment: true, orchestrator: "embedded" },
      authority: { ...DEFAULT_AUTHORITY },
      workspaceRoot: "/tmp/conductor/work",
      mirrorRoot: "/tmp/conductor/mirrors",
    },
    async (argv) => {
      calls.push(argv);
      return parentReply({ number: 47 });
    },
  );

  expect(await tracker.parentOf(305)).toBe(47);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.slice(0, 2)).toEqual(["api", "graphql"]);
  expect(calls[0]).not.toContain("view");
  expect(calls[0]).not.toContain("parent");
  expect(calls[0]).toContain("n=305");
});
