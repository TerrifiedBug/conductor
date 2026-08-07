/**
 * Behavioural tests for keeping a live brief current.
 *
 * The property worth defending is narrow and absolute: an upgrade may replace the
 * package's half of a brief and must never touch the operator's. Everything else
 * here exists to prove the command degrades to reporting when it cannot tell the
 * two halves apart.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkBrief,
  composeOrchestrator,
  formatBriefStatus,
  inspectBriefLayout,
  formatRetrofitRefusal,
  migrateToPolicy,
  missingSections,
  proposeRetrofit,
  refreshComposedBrief,
  sectionText,
  shippedDiff,
  splitBrief,
  writeMergedBrief,
} from "./brief-upgrade.ts";

const BANNER = "<!-- YOURS TO EDIT — everything below is your policy. -->";

/** A brief in the shape the template ships: package half, banner, operator half. */
function brief(opts: { shipped: string; owned: string }): string {
  return `# Orchestrator brief\n\n${opts.shipped}\n\n${BANNER}\n\n${opts.owned}\n`;
}

test("splitBrief cuts at the banner and loses nothing", () => {
  const text = brief({ shipped: "## Duty 1\ndrain it.", owned: "## Releases\nhumans release." });

  const halves = splitBrief(text);

  // Concatenating the halves has to reproduce the input, because that identity is
  // what makes writing a merge back a safe operation rather than a reformat.
  expect(halves).toBeDefined();
  expect(`${halves?.shipped}${halves?.owned}`).toBe(text);
  expect(halves?.shipped).toContain("## Duty 1");
  expect(halves?.shipped).toContain(BANNER);
  expect(halves?.owned).toContain("## Releases");
  expect(halves?.owned).not.toContain("## Duty 1");
});

test("splitBrief reports no banner rather than guessing a boundary", () => {
  // A hand-written brief has no marked boundary, and inventing one would put an
  // operator's policy on the package's side of a merge.
  expect(splitBrief("# My own brief\n\n## Duty 1\nwhatever I decided.\n")).toBeUndefined();
});

test("an unchanged shipped half reads as current", () => {
  const rendered = brief({ shipped: "## Duty 1\ndrain it.", owned: "## Releases\ntemplate default." });
  const live = brief({ shipped: "## Duty 1\ndrain it.", owned: "## Releases\nMY OWN POLICY.\n\n## Amendments\n- one" });

  // The operator's half differs wildly, and that is irrelevant: only the package's
  // half decides whether an upgrade exists.
  expect(checkBrief(live, rendered).kind).toBe("current");
});

test("a merge replaces the shipped half and preserves the operator's byte for byte", () => {
  const owned = [
    "## Releases (yours to define)",
    "You may dispatch release-suite.yml and verify the run. You never touch Komodo.",
    "",
    "## Amendments",
    "- 2026-08-06 — operator correction — release leg ends at the suite pin",
  ].join("\n");
  const live = brief({ shipped: "## Duty 1\ndrain it.", owned });
  const rendered = brief({
    shipped: "## Duty 1\ndrain it.\n\n## Learning loop\nAmend this file.",
    owned: "## Releases (yours to define)\nDefault: humans release.",
  });

  const status = checkBrief(live, rendered);
  expect(status.kind).toBe("mergeable");
  if (status.kind !== "mergeable") return;

  // The new shipped section arrives...
  expect(status.merged).toContain("## Learning loop");
  // ...and the operator's half survives exactly, including their amendment log.
  // A merge that "helpfully" reflowed one of their sections is an upgrade nobody
  // runs a second time.
  expect(status.merged).toContain(owned);
  expect(status.merged).not.toContain("Default: humans release.");
  expect(splitBrief(status.merged)?.owned).toBe(splitBrief(live)?.owned);
});

test("a brief with no banner is unsplittable, and names the sections it lacks", () => {
  const live = [
    "# Fleet orchestrator — standing brief",
    "",
    "## Duty 1 — the dispatch loop",
    "run it.",
    "",
    "## Hard boundaries",
    "no force-push.",
  ].join("\n");
  const rendered = brief({
    shipped: "## Duty 1 — the dispatch loop\nrun it.\n\n## Hard boundaries\nno force-push.\n\n## Learning loop\namend.",
    owned: "## Reporting\nquiet.",
  });

  const status = checkBrief(live, rendered);
  expect(status.kind).toBe("unsplittable");
  if (status.kind !== "unsplittable") return;

  // Headings it already has are not reported; the ones it is missing are, so the
  // operator gets a hand-merge list rather than a diff they cannot apply.
  expect(status.missing).toContain("Learning loop");
  expect(status.missing).toContain("Reporting");
  expect(status.missing).not.toContain("Hard boundaries");
});

test("--apply cannot merge an unsplittable brief, because there is nothing to merge", () => {
  const live = "# Hand-written\n\n## Duty 1\nmine.\n";
  const rendered = brief({ shipped: "## Duty 1\nshipped.", owned: "## Releases\nx" });

  const status = checkBrief(live, rendered);

  // The CLI only writes on `kind === "mergeable"`, so this shape is the guard: an
  // unsplittable brief carries no merged text to write at all.
  expect(status.kind).toBe("unsplittable");
  expect(status).not.toHaveProperty("merged");
});

test("an unrendered template is never merged, so a brief cannot inherit {{PROJECT}}", () => {
  // Found live: on a host that runs only the supervising session there is no config
  // to render coordinates from, and applying the raw template wrote eight literal
  // {{PLACEHOLDER}} tokens into the brief. A session reading its own tracker repo as
  // "{{TRACKER_REPO}}" is worse off than one with a slightly stale brief.
  const live = brief({ shipped: "## Coordinates\n- Tracker: acme/planning", owned: "## Releases\nmine." });
  const raw = brief({ shipped: "## Coordinates\n- Tracker: {{TRACKER_REPO}}", owned: "## Releases\ndefault." });

  const status = checkBrief(live, raw);

  expect(status.kind).toBe("unrendered");
  expect(status).not.toHaveProperty("merged");
  const report = formatBriefStatus("/x/ORCHESTRATOR.md", status);
  expect(report).not.toContain("--apply");
  expect(report).toContain("{{PLACEHOLDER}} coordinates");
});

test("missingSections tolerates a retitled section, so the list stays readable", () => {
  expect(missingSections("## learning LOOP\nx", "## Learning loop\ny")).toEqual([]);
  expect(missingSections("## B\n## A", "## A\n## B")).toEqual([]);

  // Operators retitle freely. These are the real shapes from a live fleet brief:
  // a duty given a longer name, and a section with a parenthetical added. Reporting
  // them as absent buries the sections that genuinely are.
  const live = ["## Duty 1 — the dispatch loop (run this on every tick)", "## Reporting (low noise, evidence-backed)"].join("\n");
  const rendered = ["## Duty 1 — drain", "## Reporting", "## Learning loop"].join("\n");

  expect(missingSections(live, rendered)).toEqual(["Learning loop"]);
});

test("sectionText returns one section, stopping at the next heading", () => {
  const text = "## First\nalpha\nbeta\n\n## Second\ngamma\n";

  expect(sectionText(text, "First")).toBe("## First\nalpha\nbeta");
  expect(sectionText(text, "Second")).toBe("## Second\ngamma");
  expect(sectionText(text, "Absent")).toBe("");
});

test("shippedDiff shows what left and what arrived, ignoring blank lines", () => {
  const diff = shippedDiff("## A\nkept\ngone\n", "## A\nkept\n\nnew\n");

  expect(diff).toContain("- gone");
  expect(diff).toContain("+ new");
  expect(diff).not.toContain("kept");
});

test("writeMergedBrief leaves the previous brief on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "conductor-brief-"));
  const path = join(dir, "ORCHESTRATOR.md");
  writeFileSync(path, "original policy\n");

  try {
    const backup = writeMergedBrief(path, "upgraded policy\n");

    // Not optional and not configurable: this file is a standing prompt someone
    // may have spent an hour on, and an upgrade must never be why it is gone.
    expect(readFileSync(path, "utf8")).toBe("upgraded policy\n");
    expect(readFileSync(backup, "utf8")).toBe("original policy\n");
    expect(backup.startsWith(`${path}.bak-`)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the report tells the operator which command applies it, and only when it can", () => {
  const live = brief({ shipped: "## Duty 1\nold.", owned: "## Releases\nmine." });
  const rendered = brief({ shipped: "## Duty 1\nnew.", owned: "## Releases\ndefault." });

  const mergeable = formatBriefStatus("/x/ORCHESTRATOR.md", checkBrief(live, rendered));
  expect(mergeable).toContain("brief-upgrade --migrate");
  expect(mergeable).toContain("brief-upgrade --apply");

  // An unsplittable brief must not advertise a silent --apply merge.
  const hand = formatBriefStatus("/x/ORCHESTRATOR.md", checkBrief("# mine\n\n## Duty 1\nx\n", rendered));
  expect(hand).not.toContain("brief-upgrade --apply");
  expect(hand).toContain("no YOURS TO EDIT banner");
  expect(hand).toContain("brief-upgrade --retrofit");

  const current = formatBriefStatus("/x/ORCHESTRATOR.md", checkBrief(live, live));
  expect(current).toContain("up to date");
  expect(current).not.toContain("--apply");
});

test("migrateToPolicy lifts owned half into POLICY.md and recomposes", () => {
  const dir = mkdtempSync(join(tmpdir(), "brief-migrate-"));
  try {
    const orchestratorPath = join(dir, "ORCHESTRATOR.md");
    const policyPath = join(dir, "POLICY.md");
    writeFileSync(
      orchestratorPath,
      brief({ shipped: "## Duty 1\ndrain.", owned: "## Releases\nMY POLICY.\n\n## Amendments\n- one\n" }),
    );
    const result = migrateToPolicy({
      orchestratorPath,
      policyPath,
      floor: "# Floor\n\n## Duty 1\nnew drain.\n",
    });
    expect(existsSync(policyPath)).toBe(true);
    expect(readFileSync(policyPath, "utf8")).toContain("MY POLICY.");
    expect(readFileSync(orchestratorPath, "utf8")).toContain("new drain.");
    expect(readFileSync(orchestratorPath, "utf8")).toContain("MY POLICY.");
    expect(result.ownedBytes).toBeGreaterThan(10);
    expect(inspectBriefLayout(dir, "").kind).toBe("overlay");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proposeRetrofit inserts the banner before the first owned heading", () => {
  const live = [
    "# Hand written",
    "",
    "## Duty 1 — drain",
    "do the loop.",
    "",
    "## Releases",
    "humans release.",
    "",
    "## Reporting",
    "daily digest.",
    "",
  ].join("\n");
  const result = proposeRetrofit(live);
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.proposal.atHeading).toBe("Releases");
  expect(result.proposal.floorAbove).toEqual(["Duty 1 — drain"]);
  expect(result.proposal.retrofitted).toContain("YOURS TO EDIT");
  expect(result.proposal.retrofitted.indexOf("YOURS TO EDIT")).toBeLessThan(
    result.proposal.retrofitted.indexOf("## Releases"),
  );
  expect(result.proposal.ownedHeadings).toEqual(["Releases", "Reporting"]);
});

test("proposeRetrofit refuses when a floor-like heading sits below the owned cut", () => {
  // Interleaved order: Releases starts the owned half, then a Learning loop
  // (floor protocol) appears below it. Cutting before Releases would push
  // Learning loop into POLICY.md on migrate — that is ownership theft.
  const live = [
    "# Hand written",
    "",
    "## Duty 1 — drain",
    "do the loop.",
    "",
    "## Releases",
    "humans release.",
    "",
    "## Learning loop",
    "amend policy.",
    "",
    "## Reporting",
    "daily digest.",
    "",
  ].join("\n");
  const result = proposeRetrofit(live);
  expect(result.kind).toBe("interleaved");
  if (result.kind !== "interleaved") return;
  expect(result.atHeading).toBe("Releases");
  expect(result.floorAbove).toEqual(["Duty 1 — drain"]);
  expect(result.floorBelow).toEqual(["Learning loop"]);
  expect(result.ownedHeadings).toEqual(["Releases", "Reporting"]);
  const report = formatRetrofitRefusal("/x/ORCHESTRATOR.md", result);
  expect(report).toContain("Refused");
  expect(report).toContain("Learning loop");
  expect(report).toContain("Nothing was written");
  expect(report).not.toContain("brief-upgrade --retrofit --apply");
});

test("proposeRetrofit reports no-cut when no owned-topic heading exists", () => {
  expect(proposeRetrofit("# Mine\n\n## Duty 1\nloop.\n").kind).toBe("no-cut");
});

test("refreshComposedBrief rewrites ORCHESTRATOR.md from floor + POLICY.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "brief-refresh-"));
  try {
    const orchestratorPath = join(dir, "ORCHESTRATOR.md");
    const policyPath = join(dir, "POLICY.md");
    writeFileSync(policyPath, "## Releases\nlive policy.\n");
    writeFileSync(orchestratorPath, "stale\n");
    expect(
      refreshComposedBrief({ orchestratorPath, policyPath, floor: "# Floor\n\n## Duty 1\nx.\n" }),
    ).toBe(true);
    const composed = readFileSync(orchestratorPath, "utf8");
    expect(composed).toContain("# Floor");
    expect(composed).toContain("live policy.");
    expect(composeOrchestrator("# Floor\n", "## Releases\ny.\n")).toContain("YOURS TO EDIT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
