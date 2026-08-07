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
import { firstOpenCloser } from "./github.ts";

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
