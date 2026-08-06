/**
 * Behavioural tests for keeping a live brief current.
 *
 * The property worth defending is narrow and absolute: an upgrade may replace the
 * package's half of a brief and must never touch the operator's. Everything else
 * here exists to prove the command degrades to reporting when it cannot tell the
 * two halves apart.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkBrief,
  formatBriefStatus,
  missingSections,
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
  expect(mergeable).toContain("brief-upgrade --apply");
  expect(mergeable).toContain("carried across");

  // An unsplittable brief must not advertise --apply: it would do nothing, and an
  // operator who ran it would reasonably believe their brief had been upgraded.
  const hand = formatBriefStatus("/x/ORCHESTRATOR.md", checkBrief("# mine\n\n## Duty 1\nx\n", rendered));
  expect(hand).not.toContain("--apply");
  expect(hand).toContain("no YOURS TO EDIT banner");

  const current = formatBriefStatus("/x/ORCHESTRATOR.md", checkBrief(live, live));
  expect(current).toContain("up to date");
  expect(current).not.toContain("--apply");
});
