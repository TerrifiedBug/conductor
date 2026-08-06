/**
 * Eligibility, repo routing and branch naming.
 *
 * Pure by design: every decision here is a function of the issue plus the
 * project config, so the dispatcher's riskiest choice — "which checkout does
 * this issue belong in" — is testable without a tracker, a clone or a network.
 * The module refuses to guess. An issue that names two repos, or none, is
 * handed back as unroutable rather than dispatched somewhere plausible,
 * because a multi-repo request silently taken whole by one worker is exactly
 * the failure this guard exists to prevent.
 */

import type { ProjectConfig, ReadyIssue, RepoTarget } from "./types.ts";

/** An issue paired with the single checkout its labels unambiguously name. */
export type Routed = { issue: ReadyIssue; repo: RepoTarget };

/**
 * Why an otherwise-eligible issue could not be dispatched. All three are
 * human-fixable label problems, which is why they escalate rather than fail.
 */
export type UnroutableReason =
  | "no-repo-label"
  | "multiple-repo-labels"
  | "unknown-repo";

/**
 * `labels` carries the prefixed labels actually seen, so the escalation can
 * quote them back ("saw repo:chad, repo:warden") instead of telling a human to
 * go and look.
 */
export type Unroutable = {
  issue: ReadyIssue;
  reason: UnroutableReason;
  labels: string[];
};

/** Git refs stay short enough to read in a PR list without wrapping. */
const MAX_BRANCH_LEN = 60;

/**
 * True only when a human has queued the issue and no run already owns it.
 *
 * The state labels are the interlock against double-dispatch across daemon
 * restarts: the tracker, not the local store, is the source of truth for
 * "someone is already on this".
 */
export function isEligible(issue: ReadyIssue, p: ProjectConfig): boolean {
  // ponytail: label comparison is exact and case-sensitive. Ceiling — a human
  // typing `Agent-Ready` gets silently ignored. Upgrade path: case-fold both
  // sides here, which is the only place labels are matched.
  const labels = new Set(issue.labels);
  if (!labels.has(p.queueLabel)) return false;
  const { inProgress, blocked, failed } = p.stateLabels;
  return !labels.has(inProgress) && !labels.has(blocked) && !labels.has(failed);
}

/**
 * Partition eligible issues into dispatchable and needs-a-human.
 *
 * Ineligible issues appear in neither bucket — they are not this loop's
 * business, and reporting them as unroutable would escalate every in-flight
 * run on every poll.
 */
export function route(
  issues: ReadyIssue[],
  p: ProjectConfig,
): { routed: Routed[]; unroutable: Unroutable[] } {
  const routed: Routed[] = [];
  const unroutable: Unroutable[] = [];
  const { labelPrefix, repos } = p.routing;

  for (const issue of issues) {
    if (!isEligible(issue, p)) continue;

    // Deduplicated: a repeated label is one repo, not an ambiguity.
    const matched = [
      ...new Set(issue.labels.filter((l) => l.startsWith(labelPrefix))),
    ];

    if (matched.length === 0) {
      unroutable.push({ issue, reason: "no-repo-label", labels: matched });
      continue;
    }
    if (matched.length > 1) {
      unroutable.push({
        issue,
        reason: "multiple-repo-labels",
        labels: matched,
      });
      continue;
    }

    const key = matched[0]!.slice(labelPrefix.length);
    // hasOwn, not truthiness: a `repo:constructor` label would otherwise
    // resolve off Object.prototype and route work into a bogus target.
    if (!Object.hasOwn(repos, key)) {
      unroutable.push({ issue, reason: "unknown-repo", labels: matched });
      continue;
    }
    routed.push({ issue, repo: repos[key]! });
  }

  return { routed, unroutable };
}

/**
 * `bug` → `fix`, everything else → `feat`.
 *
 * The label may be namespaced (`type:bug`, `kind/bug`), so only its last
 * segment is compared — the same label means the same thing whichever
 * convention a repo uses.
 */
function inferType(labels: string[]): "fix" | "feat" {
  for (const label of labels) {
    const lower = label.toLowerCase().trim();
    const cut = Math.max(lower.lastIndexOf(":"), lower.lastIndexOf("/"));
    if (lower.slice(cut + 1).trim() === "bug") return "fix";
  }
  return "feat";
}

/**
 * Title → `[a-z0-9-]`, runs of `-` collapsed, ends trimmed.
 *
 * Every character git dislikes in a ref (`.`, `:`, `~`, `^`, `?`, `*`, `[`,
 * `\`, whitespace) is outside the allow-list, so a slug cannot produce an
 * invalid ref — no `..`, no leading or trailing dot, no space.
 */
function slugify(title: string): string {
  return (
    title
      // Fold accents so "Café crash" keeps its words instead of dissolving.
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

/**
 * Deterministic `<type>/<slug>` branch name, capped whole at 60 characters and
 * never ending in `-`.
 *
 * Determinism matters beyond tidiness: a resumed or retried run recomputes the
 * same branch and finds its own work instead of forking a second one.
 */
export function branchName(issue: ReadyIssue): string {
  const type = inferType(issue.labels);
  // ponytail: a CJK or emoji-only title slugifies to nothing and lands on
  // `issue-<n>`. Ceiling — such branches read as opaque. Upgrade path:
  // transliterate here, or use the tracker's own slug when it exposes one.
  const fallback = `issue-${issue.number}`;
  const budget = Math.max(MAX_BRANCH_LEN - type.length - 1, 1);
  const slug = (slugify(issue.title) || fallback)
    .slice(0, budget)
    .replace(/-+$/, "");
  return `${type}/${slug || fallback.slice(0, budget)}`;
}
