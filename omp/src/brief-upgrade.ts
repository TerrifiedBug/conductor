/**
 * Keeping a live `ORCHESTRATOR.md` current with the shipped template.
 *
 * The wizard renders the template once and then never touches the file again,
 * because from that moment it is the operator's. That is the right ownership
 * rule and it has one consequence nobody notices until months later: every
 * later improvement to the *shipped* half of the brief — a new duty, a protocol
 * like the amendment loop — is invisible to every fleet already running. The
 * package updates; the standing prompt does not.
 *
 * This module is the missing half of that story. It never guesses: the brief has
 * an explicit banner separating the package's text from the operator's, so when
 * that banner is present the split is exact and the merge is mechanical. When it
 * is absent — a hand-written brief, or one predating the split — there is no
 * honest way to know which lines are the operator's, so nothing is rewritten and
 * the missing sections are reported instead.
 */

import { readFileSync, writeFileSync } from "node:fs";

/**
 * The line that divides the two halves. Matched on this substring rather than
 * the whole comment banner so a reflowed or re-decorated banner still splits.
 */
const EDIT_BANNER = "YOURS TO EDIT";

/**
 * A brief split into the package's half and the operator's half.
 *
 * `shipped` runs to the end of the banner line; `owned` is everything after it.
 * Concatenating them reproduces the input byte for byte, which is what makes a
 * merge safe to write back.
 */
export interface BriefHalves {
  shipped: string;
  owned: string;
}

/**
 * Splits on the banner, or returns `undefined` when there is none.
 *
 * `undefined` is a real answer, not a failure: it means this brief cannot be
 * merged mechanically, and every caller is expected to degrade to reporting
 * rather than to assume a boundary.
 */
export function splitBrief(text: string): BriefHalves | undefined {
  const at = text.indexOf(EDIT_BANNER);
  if (at < 0) return undefined;
  // Keep the whole banner line on the shipped side: the operator's half starts
  // at the first line they own, so a merge never has to reconstruct the banner.
  const lineEnd = text.indexOf("\n", at);
  const cut = lineEnd < 0 ? text.length : lineEnd + 1;
  return { shipped: text.slice(0, cut), owned: text.slice(cut) };
}

/** A `## Heading` in the shipped half, by its exact text. */
function headings(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) out.push(line.slice(3).trim());
  }
  return out;
}

/**
 * The comparable part of a heading: everything before the first dash, colon or
 * bracket, lowercased.
 *
 * Operators retitle sections freely — `## Reporting` becomes `## Reporting (low
 * noise, evidence-backed)`, `## Duty 1 — drain` becomes `## Duty 1 — the dispatch
 * loop (run this on every tick)` — and an exact match would report all of those as
 * absent. Ten reported sections when four are genuinely missing is a list nobody
 * reads, which is the same as reporting nothing.
 */
function topicKey(heading: string): string {
  const cut = heading.search(/[—–:(-]/u);
  return (cut < 0 ? heading : heading.slice(0, cut)).trim().toLowerCase();
}

/**
 * Shipped sections the live brief has no heading for.
 *
 * Matched on {@link topicKey}, so a retitled section counts as present. The
 * remaining bias is deliberate: this decides what to *offer* for a hand-merge, and
 * a section reported that the operator already covers costs them one read, while a
 * new protocol silently counted as present costs them the protocol.
 */
export function missingSections(live: string, rendered: string): string[] {
  const present = new Set(headings(live).map(topicKey));
  return headings(rendered).filter((h) => !present.has(topicKey(h)));
}

/** Section bodies from a rendered template, keyed by heading, for reporting. */
export function sectionText(rendered: string, heading: string): string {
  const lines = rendered.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## ") && l.slice(3).trim() === heading);
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

/** An unfilled `{{KEY}}` coordinate in a template nobody rendered. */
const PLACEHOLDER_PATTERN = /\{\{[A-Za-z0-9_]+\}\}/;

/** What a check found, and what a caller may do about it. */
export type BriefStatus =
  | { kind: "current" }
  /** Banner present and the shipped half differs: a merge is exact. */
  | { kind: "mergeable"; merged: string; liveShipped: string; freshShipped: string }
  /** No banner, so the boundary is unknown and only reporting is honest. */
  | { kind: "unsplittable"; missing: string[] }
  /** Template never rendered, so merging it would write `{{PROJECT}}` into a brief. */
  | { kind: "unrendered"; missing: string[] };

/**
 * Compares a live brief against the freshly rendered template.
 *
 * `rendered` should come from `renderBriefForProject`, so the coordinates already
 * match and a diff reflects policy changes rather than substitution noise. A raw
 * template is accepted — a host that runs only the supervising session has no
 * config to render from — but it can only ever produce a report.
 */
export function checkBrief(live: string, rendered: string): BriefStatus {
  const liveHalves = splitBrief(live);
  const freshHalves = splitBrief(rendered);

  // A template without the banner is a packaging error, not an operator problem,
  // so treat it the same as an unmergeable live brief rather than inventing a cut.
  if (liveHalves === undefined || freshHalves === undefined) {
    return { kind: "unsplittable", missing: missingSections(live, rendered) };
  }

  // Enforced here rather than at each caller: merging an unrendered template would
  // write `{{PROJECT}}` into a live standing prompt, and a session reading its own
  // coordinates as a literal placeholder is worse than an out-of-date brief.
  if (PLACEHOLDER_PATTERN.test(freshHalves.shipped)) {
    return { kind: "unrendered", missing: missingSections(live, rendered) };
  }

  if (liveHalves.shipped === freshHalves.shipped) return { kind: "current" };

  return {
    kind: "mergeable",
    // The operator's half is carried across untouched. This is the whole safety
    // property: an upgrade that reformats one of their sections is an upgrade
    // nobody runs twice.
    merged: freshHalves.shipped + liveHalves.owned,
    liveShipped: liveHalves.shipped,
    freshShipped: freshHalves.shipped,
  };
}

/**
 * Line-level diff of the two shipped halves, for a human to read before saying
 * yes. Deliberately not a real diff algorithm: the shipped half changes by whole
 * sections between versions, so listing removed and added lines in order is both
 * enough to review and impossible to misread as a merge preview.
 */
export function shippedDiff(before: string, after: string): string {
  const old = new Set(before.split("\n"));
  const now = new Set(after.split("\n"));
  const lines: string[] = [];
  for (const line of before.split("\n")) {
    if (!now.has(line) && line.trim() !== "") lines.push(`- ${line}`);
  }
  for (const line of after.split("\n")) {
    if (!old.has(line) && line.trim() !== "") lines.push(`+ ${line}`);
  }
  return lines.join("\n");
}

/**
 * Writes the merged brief, leaving the previous one beside it.
 *
 * The backup is not optional and not configurable: this file is a standing
 * prompt an operator may have spent an hour on, and the one thing an upgrade
 * must never do is be the reason it is gone.
 */
export function writeMergedBrief(path: string, merged: string): string {
  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  writeFileSync(backup, readFileSync(path));
  writeFileSync(path, merged);
  return backup;
}

/** The check rendered for a terminal, including what to do next. */
export function formatBriefStatus(path: string, status: BriefStatus): string {
  if (status.kind === "current") {
    return [`brief ${path}`, "", "up to date — its shipped half matches this version of the template."].join("\n");
  }

  if (status.kind === "mergeable") {
    return [
      `brief ${path}`,
      "",
      "This version of the package ships a different brief above the YOURS TO EDIT",
      "banner. Everything below the banner is yours and would be carried across",
      "unchanged.",
      "",
      shippedDiff(status.liveShipped, status.freshShipped),
      "",
      "Apply it with:  omp-conductor brief-upgrade --apply",
      "The previous file is kept beside it as ORCHESTRATOR.md.bak-<timestamp>.",
    ].join("\n");
  }

  const lines = [`brief ${path}`, ""];
  lines.push(
    ...(status.kind === "unrendered"
      ? [
          "The shipped template still carries its {{PLACEHOLDER}} coordinates, because no",
          "project config resolved on this host. Merging it would write those literals",
          "into a live standing prompt, so this can only be reported on. Run it with",
          "--project on a host that has the config to apply an upgrade.",
        ]
      : [
          "This brief has no YOURS TO EDIT banner, so it was written by hand or predates",
          "the template split. There is no way to tell which lines are yours, so nothing",
          "will be rewritten automatically.",
        ]),
  );
  if (status.missing.length === 0) {
    lines.push("", "It already has a heading for every section the template ships.");
    return lines.join("\n");
  }
  lines.push(
    "",
    `Sections the shipped template has and this brief does not (${status.missing.length}):`,
    ...status.missing.map((h) => `  - ${h}`),
    "",
    "Merge the ones you want by hand, or ask the session running from this brief to",
    "propose them through its own amendment protocol.",
  );
  return lines.join("\n");
}
