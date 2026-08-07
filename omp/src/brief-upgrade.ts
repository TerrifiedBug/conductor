/**
 * Package floor + fleet POLICY.md overlay.
 *
 * The shipped orchestrator floor lives in the package and is re-rendered into a
 * composed `ORCHESTRATOR.md` on every tick. Fleet-specific policy lives in
 * `POLICY.md` and is the only file Learning-loop / operator edits should touch.
 *
 * Legacy single-file briefs with a `YOURS TO EDIT` banner still split exactly;
 * `migrate` lifts the owned half into `POLICY.md`. Hand-written briefs without a
 * banner can `retrofit` one at a classified cut before migrating.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The line that divides the two halves. Matched on this substring rather than
 * the whole comment banner so a reflowed or re-decorated banner still splits.
 */
export const EDIT_BANNER = "YOURS TO EDIT";

/** Fleet-owned overlay beside the composed orchestrator brief. */
export const POLICY_BRIEF_NAME = "POLICY.md";

/** Composed view the session / AGENTS.md symlink historically pointed at. */
export const ORCHESTRATOR_BRIEF_NAME = "ORCHESTRATOR.md";

/** Topic keys that belong in POLICY.md (matched like {@link topicKey}). */
export const OWNED_TOPIC_KEYS = ["releases", "project context", "reporting", "amendments"] as const;

/** Banner written into composed ORCHESTRATOR.md between floor and policy. */
export const COMPOSE_BANNER = [
  "<!-- ==================================================================== -->",
  "<!-- YOURS TO EDIT — live copy of POLICY.md. Edit POLICY.md, not here.   -->",
  "<!-- This composed ORCHESTRATOR.md is regenerated from package floor +   -->",
  "<!-- POLICY.md; hand-edits above or below the banner will not last.      -->",
  "<!-- ==================================================================== -->",
].join("\n");

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
 */
export function topicKey(heading: string): string {
  const cut = heading.search(/[—–:(-]/u);
  return (cut < 0 ? heading : heading.slice(0, cut)).trim().toLowerCase();
}

/** True when a heading's topic is one of the owned POLICY sections. */
export function isOwnedTopic(heading: string): boolean {
  const key = topicKey(heading);
  return (OWNED_TOPIC_KEYS as readonly string[]).includes(key);
}

/**
 * Shipped sections the live brief has no heading for.
 *
 * Matched on {@link topicKey}, so a retitled section counts as present.
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
const PLACEHOLDER_REPLACE = /\{\{([A-Za-z0-9_]+)\}\}/g;

/**
 * Tiny template renderer kept here so the tick path never imports `worker.ts`
 * (and through it the session SDK).
 */
export function renderBriefTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER_REPLACE, (placeholder, key: string) => {
    if (!Object.hasOwn(vars, key)) return placeholder;
    const value = vars[key];
    return value === undefined ? placeholder : value;
  });
}

/** What a check found, and what a caller may do about it. */
export type BriefStatus =
  | { kind: "current" }
  /** Banner present and the shipped half differs: a merge is exact. */
  | { kind: "mergeable"; merged: string; liveShipped: string; freshShipped: string }
  /** No banner, so the boundary is unknown and only reporting is honest. */
  | { kind: "unsplittable"; missing: string[] }
  /** Template never rendered, so merging it would write `{{PROJECT}}` into a brief. */
  | { kind: "unrendered"; missing: string[] }
  /** Overlay already active: floor refreshes from package; policy is POLICY.md. */
  | { kind: "overlay"; policyPath: string; orchestratorPath: string };

/**
 * Compares a live brief against the freshly rendered template.
 *
 * Prefer {@link inspectBriefLayout} once a fleet has `POLICY.md`. This path
 * remains for pre-overlay single-file briefs.
 */
export function checkBrief(live: string, rendered: string): BriefStatus {
  const liveHalves = splitBrief(live);
  const freshHalves = splitBrief(rendered);

  // A template without the banner is expected in the overlay world (floor-only).
  // When the *live* brief still has a banner, compare using composed rendered text
  // that includes the compose banner so migrate remains available.
  if (liveHalves === undefined) {
    return { kind: "unsplittable", missing: missingSections(live, rendered) };
  }
  if (freshHalves === undefined) {
    // Floor-only rendered template: live bannered brief wants migrate, not merge.
    return { kind: "unsplittable", missing: missingSections(live, rendered) };
  }

  if (PLACEHOLDER_PATTERN.test(freshHalves.shipped)) {
    return { kind: "unrendered", missing: missingSections(live, rendered) };
  }

  if (liveHalves.shipped === freshHalves.shipped) return { kind: "current" };

  return {
    kind: "mergeable",
    merged: freshHalves.shipped + liveHalves.owned,
    liveShipped: liveHalves.shipped,
    freshShipped: freshHalves.shipped,
  };
}

/** Layout of brief files under a workspace root. */
export type BriefLayout =
  | { kind: "overlay"; policyPath: string; orchestratorPath: string }
  | { kind: "legacy-bannered"; orchestratorPath: string; owned: string }
  | { kind: "legacy-handwritten"; orchestratorPath: string; missing: string[] }
  | { kind: "missing" };

export function policyPathForRoot(workspaceRoot: string): string {
  return join(workspaceRoot, POLICY_BRIEF_NAME);
}

export function orchestratorPathForRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ORCHESTRATOR_BRIEF_NAME);
}

/**
 * Classifies what sits in the workspace: overlay, migratable legacy, or absent.
 *
 * `floorHeadings` is the rendered floor (or composed) heading list used only to
 * report missing sections for handwritten briefs.
 */
export function inspectBriefLayout(
  workspaceRoot: string,
  floorOrComposedForReport: string,
): BriefLayout {
  const policyPath = policyPathForRoot(workspaceRoot);
  const orchestratorPath = orchestratorPathForRoot(workspaceRoot);
  if (existsSync(policyPath)) {
    return { kind: "overlay", policyPath, orchestratorPath };
  }
  if (!existsSync(orchestratorPath)) return { kind: "missing" };
  const live = readFileSync(orchestratorPath, "utf8");
  const halves = splitBrief(live);
  if (halves !== undefined) {
    return { kind: "legacy-bannered", orchestratorPath, owned: halves.owned };
  }
  return {
    kind: "legacy-handwritten",
    orchestratorPath,
    missing: missingSections(live, floorOrComposedForReport),
  };
}

/** Join rendered floor + live policy into the composed session brief. */
export function composeOrchestrator(floor: string, policy: string): string {
  const f = floor.replace(/\s+$/, "\n");
  const p = policy.replace(/^\s+/, "").replace(/\s+$/, "\n");
  return `${f}\n${COMPOSE_BANNER}\n\n${p}`;
}

/**
 * Line-level diff of the two shipped halves, for a human to read before saying
 * yes.
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
 * Writes content, leaving the previous file beside it when one existed.
 */
export function writeWithBackup(path: string, content: string): string | undefined {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    writeFileSync(backup, readFileSync(path));
  }
  writeFileSync(path, content);
  return backup;
}

/**
 * Writes the merged brief, leaving the previous one beside it.
 *
 * @deprecated Prefer {@link migrateToPolicy} / overlay refresh. Kept for
 * pre-overlay `--apply` on bannered single-file briefs.
 */
export function writeMergedBrief(path: string, merged: string): string {
  const backup = writeWithBackup(path, merged);
  return backup ?? `${path}.bak-missing`;
}

/** Result of migrating a bannered ORCHESTRATOR.md into POLICY.md. */
export interface MigrateResult {
  policyPath: string;
  orchestratorPath: string;
  policyBackup?: string;
  orchestratorBackup?: string;
  ownedBytes: number;
}

/**
 * Lifts the owned half of a bannered orchestrator brief into `POLICY.md`, then
 * writes a composed orchestrator from `floor` + that policy.
 */
export function migrateToPolicy(opts: {
  orchestratorPath: string;
  policyPath: string;
  floor: string;
  /** When set, use this owned text instead of splitting the live file. */
  owned?: string;
}): MigrateResult {
  const live = readFileSync(opts.orchestratorPath, "utf8");
  const owned = opts.owned ?? splitBrief(live)?.owned;
  if (owned === undefined) {
    throw new Error(`cannot migrate ${opts.orchestratorPath}: no ${EDIT_BANNER} banner`);
  }
  const policyBody = owned.replace(/^\s+/, "");
  const policyBackup = writeWithBackup(opts.policyPath, policyBody.endsWith("\n") ? policyBody : `${policyBody}\n`);
  const composed = composeOrchestrator(opts.floor, readFileSync(opts.policyPath, "utf8"));
  const orchestratorBackup = writeWithBackup(opts.orchestratorPath, composed);
  return {
    policyPath: opts.policyPath,
    orchestratorPath: opts.orchestratorPath,
    policyBackup,
    orchestratorBackup,
    ownedBytes: policyBody.length,
  };
}

/**
 * Refresh composed ORCHESTRATOR.md from rendered floor + existing POLICY.md.
 * Creates nothing when POLICY.md is absent (caller should migrate first).
 */
export function refreshComposedBrief(opts: {
  orchestratorPath: string;
  policyPath: string;
  floor: string;
}): boolean {
  if (!existsSync(opts.policyPath)) return false;
  const policy = readFileSync(opts.policyPath, "utf8");
  writeFileSync(opts.orchestratorPath, composeOrchestrator(opts.floor, policy));
  return true;
}

/** A proposed banner insertion for a hand-written brief (#20). */
export interface RetrofitProposal {
  /** Byte offset in the live text where the banner block should be inserted. */
  cut: number;
  /** Heading that starts the owned half. */
  atHeading: string;
  /** Owned-topic headings (Releases / Project context / Reporting / Amendments). */
  ownedHeadings: string[];
  /** Non-owned headings that appear *before* the cut — stay on the floor side. */
  floorAbove: string[];
  /** Live text with the compose banner inserted at `cut`. */
  retrofitted: string;
}

/**
 * Why a retrofit cannot be applied automatically.
 *
 * `interleaved` means a floor-like heading (Duty, Learning loop, Hard boundaries,
 * …) appears *below* the first owned-topic cut. Applying the banner there would
 * push that floor section into POLICY.md on migrate — silent ownership theft.
 */
export type RetrofitRefusal = {
  kind: "interleaved";
  atHeading: string;
  ownedHeadings: string[];
  floorAbove: string[];
  floorBelow: string[];
};

export type RetrofitResult =
  | { kind: "ok"; proposal: RetrofitProposal }
  | { kind: "no-cut" }
  | RetrofitRefusal;

/**
 * Propose inserting the YOURS TO EDIT banner before the first owned-topic
 * heading.
 *
 * Headings are classified by **position relative to that cut**, not globally:
 * floor-like headings above the cut stay above; any floor-like heading below
 * the cut is a refuse — the operator must reorder or hand-classify before apply.
 */
export function proposeRetrofit(live: string): RetrofitResult {
  const lines = live.split("\n");
  const ownedHeadings: string[] = [];
  const floorAbove: string[] = [];
  const floorBelow: string[] = [];
  let cutLine = -1;
  let atHeading: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || !line.startsWith("## ")) continue;
    const heading = line.slice(3).trim();
    if (isOwnedTopic(heading)) {
      ownedHeadings.push(heading);
      if (cutLine < 0) {
        cutLine = i;
        atHeading = heading;
      }
      continue;
    }
    // Position relative to the (eventual) cut — headings before any owned topic
    // are tentatively "above"; once the cut is known, later floor headings are
    // "below" and block apply.
    if (cutLine < 0) floorAbove.push(heading);
    else floorBelow.push(heading);
  }
  if (cutLine < 0 || atHeading === undefined) return { kind: "no-cut" };

  if (floorBelow.length > 0) {
    return {
      kind: "interleaved",
      atHeading,
      ownedHeadings,
      floorAbove,
      floorBelow,
    };
  }

  // Byte offset: sum of prior lines + newlines.
  let cut = 0;
  for (let i = 0; i < cutLine; i++) {
    const line = lines[i];
    cut += (line?.length ?? 0) + 1;
  }
  const retrofitted = `${live.slice(0, cut)}${COMPOSE_BANNER}\n\n${live.slice(cut)}`;
  return {
    kind: "ok",
    proposal: { cut, atHeading, ownedHeadings, floorAbove, retrofitted },
  };
}

/** Insert the banner into a hand-written brief (with backup). */
export function applyRetrofit(path: string, proposal: RetrofitProposal): string {
  const backup = writeWithBackup(path, proposal.retrofitted);
  return backup ?? `${path}.bak-missing`;
}

/** The check rendered for a terminal, including what to do next. */
export function formatBriefStatus(path: string, status: BriefStatus): string {
  if (status.kind === "overlay") {
    return [
      `brief overlay active`,
      "",
      `  floor        package template → recomposed into ${status.orchestratorPath} each tick`,
      `  policy       ${status.policyPath} (Learning loop / operator edits)`,
      "",
      "Protocol updates: npm install omp-conductor@… and restart — no brief-upgrade --apply.",
      "Legacy migrate:   omp-conductor brief-upgrade --migrate",
    ].join("\n");
  }

  if (status.kind === "current") {
    return [`brief ${path}`, "", "up to date — its shipped half matches this version of the template."].join("\n");
  }

  if (status.kind === "mergeable") {
    return [
      `brief ${path}`,
      "",
      "Legacy single-file brief: this version ships a different half above the YOURS TO EDIT",
      "banner. Prefer migrating to the POLICY.md overlay:",
      "",
      shippedDiff(status.liveShipped, status.freshShipped),
      "",
      "Migrate:  omp-conductor brief-upgrade --migrate",
      "Or apply the old single-file merge:  omp-conductor brief-upgrade --apply",
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
          "",
          "Retrofit a banner at the first Releases/Project context/Reporting/Amendments",
          "heading, then migrate:",
          "  omp-conductor brief-upgrade --retrofit",
          "  omp-conductor brief-upgrade --migrate",
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

export function formatRetrofitProposal(path: string, proposal: RetrofitProposal): string {
  return [
    `retrofit ${path}`,
    "",
    `Insert the YOURS TO EDIT banner before ## ${proposal.atHeading}.`,
    "",
    `Owned-topic headings (${proposal.ownedHeadings.length}):`,
    ...proposal.ownedHeadings.map((h) => `  - ${h}`),
    `Floor-like headings above the banner (${proposal.floorAbove.length}):`,
    ...(proposal.floorAbove.length === 0
      ? ["  (none)"]
      : proposal.floorAbove.map((h) => `  - ${h}`)),
    "",
    "Apply:  omp-conductor brief-upgrade --retrofit --apply",
    "Then:   omp-conductor brief-upgrade --migrate",
  ].join("\n");
}

export function formatRetrofitRefusal(path: string, refusal: RetrofitRefusal): string {
  return [
    `retrofit ${path}`,
    "",
    `Refused: floor-like heading(s) appear below the proposed cut at ## ${refusal.atHeading}.`,
    "Applying the banner here would put those sections into POLICY.md on migrate.",
    "",
    `Owned-topic headings (${refusal.ownedHeadings.length}):`,
    ...refusal.ownedHeadings.map((h) => `  - ${h}`),
    `Floor-like headings above the cut (${refusal.floorAbove.length}):`,
    ...(refusal.floorAbove.length === 0
      ? ["  (none)"]
      : refusal.floorAbove.map((h) => `  - ${h}`)),
    `Floor-like headings BELOW the cut — must move or reclassify (${refusal.floorBelow.length}):`,
    ...refusal.floorBelow.map((h) => `  - ${h}`),
    "",
    "Reorder so all Duties / Hard boundaries / Learning loop sit above Releases,",
    "or hand-insert the YOURS TO EDIT banner at the line you intend, then migrate.",
    "Nothing was written.",
  ].join("\n");
}

export function formatMigrateResult(result: MigrateResult): string {
  return [
    "migrated to POLICY.md overlay",
    "",
    `  policy       ${result.policyPath} (${result.ownedBytes} bytes)`,
    ...(result.policyBackup ? [`  policy bak   ${result.policyBackup}`] : []),
    `  composed     ${result.orchestratorPath}`,
    ...(result.orchestratorBackup ? [`  brief bak    ${result.orchestratorBackup}`] : []),
    "",
    "Next ticks recompose ORCHESTRATOR.md from the package floor + POLICY.md.",
    "Edit only POLICY.md going forward.",
  ].join("\n");
}
