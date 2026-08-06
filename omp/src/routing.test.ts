import { describe, expect, test } from "bun:test";

import { branchName, isEligible, route } from "./routing.ts";
import type { ProjectConfig, ReadyIssue, RepoTarget } from "./types.ts";

const QUEUE = "agent-ready";
const IN_PROGRESS = "agent:in-progress";

function target(name: string): RepoTarget {
  return {
    name,
    cloneUrl: `git@github.com:acme/${name}.git`,
    defaultBranch: "main",
    gates: [{ cmd: "bun run check", cwd: "." }],
  };
}

const api = target("api");
const worker = target("worker");

const project: ProjectConfig = {
  name: "demo",
  tracker: { kind: "github", repo: "acme/queue" },
  queueLabel: QUEUE,
  stateLabels: {
    inProgress: IN_PROGRESS,
    blocked: "agent:blocked",
    failed: "agent:failed",
  },
  routing: { labelPrefix: "repo:", repos: { api, worker } },
  caps: {},
  escalation: { fallbackToIssueComment: true },
  workspaceRoot: "/tmp/conductor/ws",
  mirrorRoot: "/tmp/conductor/mirrors",
};

/** Queued by default, so each test only states the labels it cares about. */
function issue(
  number: number,
  title: string,
  labels: string[] = [],
  opts: { queued?: boolean } = {},
): ReadyIssue {
  return {
    number,
    title,
    body: "",
    labels: [...(opts.queued === false ? [] : [QUEUE]), ...labels],
    url: `https://github.com/acme/queue/issues/${number}`,
    updatedAt: "2026-08-06T00:00:00Z",
  };
}

describe("isEligible", () => {
  test("requires the queue label", () => {
    expect(isEligible(issue(1, "t", ["repo:api"]), project)).toBe(true);
    expect(
      isEligible(issue(1, "t", ["repo:api"], { queued: false }), project),
    ).toBe(false);
  });

  test("any state label disqualifies", () => {
    for (const state of Object.values(project.stateLabels)) {
      expect(isEligible(issue(2, "t", [state]), project)).toBe(false);
    }
  });
});

describe("route", () => {
  test("exactly one known repo label routes to that target", () => {
    const i = issue(10, "Fix percolator drift", ["repo:api"]);
    const { routed, unroutable } = route([i], project);

    expect(unroutable).toEqual([]);
    expect(routed).toHaveLength(1);
    expect(routed[0]!.issue.number).toBe(10);
    expect(routed[0]!.repo).toBe(api);
  });

  test("zero prefixed labels is no-repo-label", () => {
    const i = issue(11, "Something vague", ["priority:high"]);
    const { routed, unroutable } = route([i], project);

    expect(routed).toEqual([]);
    expect(unroutable).toHaveLength(1);
    expect(unroutable[0]!.reason).toBe("no-repo-label");
    expect(unroutable[0]!.labels).toEqual([]);
  });

  test("two prefixed labels is multiple-repo-labels and is never routed", () => {
    const i = issue(12, "Bump shared package everywhere", [
      "repo:api",
      "repo:worker",
    ]);
    const { routed, unroutable } = route([i], project);

    expect(routed).toEqual([]);
    expect(unroutable).toHaveLength(1);
    expect(unroutable[0]!.reason).toBe("multiple-repo-labels");
    // Reported verbatim so the escalation can name what it saw.
    expect(unroutable[0]!.labels).toEqual(["repo:api", "repo:worker"]);
  });

  test("one prefixed label with an unknown suffix is unknown-repo", () => {
    const i = issue(13, "Retire the old shim", ["repo:frontend"]);
    const { routed, unroutable } = route([i], project);

    expect(routed).toEqual([]);
    expect(unroutable[0]!.reason).toBe("unknown-repo");
    expect(unroutable[0]!.labels).toEqual(["repo:frontend"]);
  });

  test("an in-progress issue is in neither bucket", () => {
    // Otherwise perfectly routable: the state label is the only difference.
    const i = issue(14, "Already claimed", ["repo:api", IN_PROGRESS]);
    const { routed, unroutable } = route([i], project);

    expect(routed).toEqual([]);
    expect(unroutable).toEqual([]);
  });

  test("inherited Object keys are not repos", () => {
    const { routed, unroutable } = route(
      [issue(15, "Prototype probe", ["repo:constructor"])],
      project,
    );

    expect(routed).toEqual([]);
    expect(unroutable[0]!.reason).toBe("unknown-repo");
  });

  test("a bare prefix is unknown-repo, not a match", () => {
    const { routed, unroutable } = route(
      [issue(16, "Empty suffix", ["repo:"])],
      project,
    );

    expect(routed).toEqual([]);
    expect(unroutable[0]!.reason).toBe("unknown-repo");
  });

  test("a repeated label is one repo, not an ambiguity", () => {
    const { routed, unroutable } = route(
      [issue(17, "Dup label", ["repo:api", "repo:api"])],
      project,
    );

    expect(unroutable).toEqual([]);
    expect(routed[0]!.repo).toBe(api);
  });

  test("each issue is decided independently within one batch", () => {
    const { routed, unroutable } = route(
      [
        issue(20, "Good", ["repo:worker"]),
        issue(21, "Ambiguous", ["repo:api", "repo:worker"]),
        issue(22, "Claimed", ["repo:api", IN_PROGRESS]),
        issue(23, "Unlabelled"),
      ],
      project,
    );

    expect(routed.map((r) => r.issue.number)).toEqual([20]);
    expect(unroutable.map((u) => [u.issue.number, u.reason])).toEqual([
      [21, "multiple-repo-labels"],
      [23, "no-repo-label"],
    ]);
  });
});

describe("branchName", () => {
  test("a bug label yields fix/, anything else feat/", () => {
    expect(branchName(issue(30, "Alerts never fire", ["bug"]))).toBe(
      "fix/alerts-never-fire",
    );
    expect(branchName(issue(31, "Alerts never fire", ["enhancement"]))).toBe(
      "feat/alerts-never-fire",
    );
    // Namespaced conventions mean the same thing.
    expect(branchName(issue(32, "Crash on boot", ["type:bug"]))).toBe(
      "fix/crash-on-boot",
    );
  });

  test("a punctuation-only title falls back to issue-<number>", () => {
    expect(branchName(issue(42, "!!! ??? ---"))).toBe("feat/issue-42");
    expect(branchName(issue(43, "   ", ["bug"]))).toBe("fix/issue-43");
  });

  test("a long title is capped at 60 chars and never ends in -", () => {
    const title =
      "load save sync emit walk bind hash pool fold tick wrap zoom seek";
    const branch = branchName(issue(50, title));

    // The 60-char boundary lands exactly on a separator here, so the trailing
    // hyphen must be stripped rather than shipped as an invalid-looking ref.
    expect(branch).toBe(
      "feat/load-save-sync-emit-walk-bind-hash-pool-fold-tick-wrap",
    );
    expect(branch.length).toBeLessThanOrEqual(60);
    expect(branch.endsWith("-")).toBe(false);
  });

  test("emits nothing git rejects and is deterministic", () => {
    const i = issue(51, "Handle ..dotted/ref: café ~^?*[ names\\ now", ["bug"]);
    const branch = branchName(i);

    expect(branch).toBe(branchName(i));
    expect(branch).toMatch(/^(?:fix|feat)\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(branch).toBe("fix/handle-dotted-ref-cafe-names-now");
  });
});
