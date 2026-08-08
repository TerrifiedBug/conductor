import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBoard, stripAnsi, summarizeUnblockOutput, type BoardCursor, type BoardSnapshot } from "./board.ts";
import { DEFAULT_AUTHORITY, DEFAULT_CAPS, type ProjectConfig, type RunRecord } from "./types.ts";

const NOW = Date.parse("2026-08-08T13:00:00Z");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): ProjectConfig {
  return {
    name: "demo",
    tracker: { kind: "github", repo: "acme/planning" },
    queueLabel: "ready-for-agent",
    stateLabels: { inProgress: "agent:in-progress", blocked: "agent:blocked", failed: "agent:failed" },
    routing: { labelPrefix: "repo:", repos: {} },
    caps: {},
    escalation: { fallbackToIssueComment: true, orchestrator: "external" },
    authority: { ...DEFAULT_AUTHORITY },
    workspaceRoot: "/tmp/worktrees",
    mirrorRoot: "/tmp/mirrors",
  };
}

function run(issue: number, state: RunRecord["state"], over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `run-${issue}`,
    project: "demo",
    issue,
    repo: "api",
    branch: `fix/issue-${issue}`,
    worktree: `/tmp/worktrees/${issue}`,
    state,
    attempt: 1,
    turns: 42,
    maxTurns: 120,
    spendUsd: 2.5,
    startedAt: NOW - 65 * 60_000,
    ...(state === "running" || state === "claimed" ? {} : { endedAt: NOW - 5 * 60_000 }),
    ...over,
  };
}

function snapshot(over: Partial<BoardSnapshot> = {}): BoardSnapshot {
  const runs = [
    run(101, "claimed"),
    run(102, "running"),
    run(103, "pushed-green", { prUrl: "https://github.com/acme/api/pull/103" }),
    run(104, "blocked", { lastError: "Needs operator input" }),
    run(105, "failed", { lastError: "Checks failed" }),
    run(106, "merged", { prUrl: "https://github.com/acme/api/pull/106" }),
  ];
  return {
    project: project(),
    status: {
      project: "demo",
      configPath: "/tmp/config.json",
      stateDir: "/tmp/state",
      paused: false,
      caps: { ...DEFAULT_CAPS },
      activeRuns: runs.slice(0, 3),
      liveWorkers: 2,
      runsToday: 6,
      spendTodayUsd: 8.25,
      dispatch: {
        completedAt: NOW,
        ready: 8,
        routed: 6,
        admitted: 2,
        degraded: true,
        holds: [{ reason: "sibling-active", count: 1, issues: [320] }],
      },
    },
    health: {
      layers: {
        dispatch: "running",
        ticks: "armed",
        pane: "live",
        recovery: "clear",
        herdr: "active",
        paused: false,
        daemon: { running: true, pid: 42, port: 8787 },
      },
      telegram: { kind: "ok", detail: "bot @fleet; inbound configured" },
      daemon: "ok",
      codeGraph: {
        configured: true,
        status: "healthy",
        checkedAt: new Date(NOW).toISOString(),
        prerequisites: { indexer: "present", mcpMount: "present" },
        repos: [{ name: "api", path: "/srv/api", clone: "present", index: "present" }],
        timer: { enabled: "enabled", active: "active" },
        refresh: { result: "success", fresh: true },
        reasons: [],
      },
    },
    runs,
    now: NOW,
    ...over,
  };
}

function cursor(over: Partial<BoardCursor> = {}): BoardCursor {
  return { column: 2, card: 0, detail: false, transcriptOffset: 0, ...over };
}

test("the wide board shows every lifecycle stage and authoritative header facts", () => {
  const text = stripAnsi(renderBoard(snapshot(), cursor(), 210, 36));

  expect(text).toContain("CONDUCTOR  DEMO");
  expect(text).toContain("dispatch running  ·  ticks armed");
  expect(text).toContain("8 ready · 6 routed · 2 admitted");
  expect(text).toContain("DEGRADED · 8 ready");
  expect(text).toContain("sibling-active 1");
  for (const title of ["QUEUE", "CLAIMED", "RUNNING", "GREEN", "BLOCKED", "FAILED", "MERGED"]) {
    expect(text).toContain(title);
  }
  expect(text).toContain("#320");
  expect(text).toContain("#102 · api");
  expect(text).toContain("42/120t");
  expect(text).toContain("$2.50 · 1h 05m");
  expect(text).toContain("Enter inspect");
  expect(text).toContain("recovery clear");
  expect(text).toContain("graph healthy 1/1 indexed  ·  telegram ok — bot @fleet; inbound configured");
});

test("an empty hold list is rendered as none", () => {
  const base = snapshot();
  const dispatch = { ...base.status.dispatch!, degraded: false, holds: [] };
  const text = stripAnsi(renderBoard({ ...base, status: { ...base.status, dispatch } }, cursor(), 120, 24));
  expect(text).toContain("holds none");
});

test("the board windows columns to the terminal and never emits over-wide rows", () => {
  const width = 80;
  const text = stripAnsi(renderBoard(snapshot(), cursor({ column: 5 }), width, 24));

  expect(text).toContain("FAILED");
  expect(text.split("\n").every((line) => line.length <= width)).toBe(true);
  expect(text).not.toContain("Terminal too small");
  expect(text).toContain("daemon ok");
  expect(text).toContain("telegram ok");
  expect(text).toContain("spend $8.25/$25.00");
});

test("detail view follows the selected run transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "conductor-board-"));
  tempDirs.push(dir);
  const transcript = join(dir, "session.jsonl");
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Reviewing the failing check." }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } }),
    ].join("\n") + "\n",
  );
  const base = snapshot();
  const runs = base.runs.map((value) => (value.issue === 102 ? { ...value, sessionFile: transcript } : value));
  const text = stripAnsi(renderBoard({ ...base, runs }, cursor({ detail: true }), 100, 24));

  expect(text).toContain("RUN #102  api  running");
  expect(text).toContain("assistant: Reviewing the failing check.");
  expect(text).toContain("tool: bash");
  expect(text).toContain("↑/↓ scroll  Esc back");
});

test("selection stays on the same run when a refresh inserts a newer card", () => {
  const base = snapshot();
  const selected = cursor({ column: 2 });
  renderBoard(base, selected, 100, 24);
  expect(selected.selection).toBe("run:run-102");

  const newer = run(107, "running", { id: "newer-run", startedAt: NOW - 1_000 });
  renderBoard({ ...base, runs: [newer, ...base.runs] }, selected, 100, 24);

  expect(selected.selection).toBe("run:run-102");
  expect(selected.card).toBe(1);
});

test("selection follows a run when its lifecycle column changes", () => {
  const base = snapshot();
  const selected = cursor({ column: 2, detail: true });
  renderBoard(base, selected, 100, 24);

  const runs = base.runs.map((value) =>
    value.issue === 102 ? { ...value, state: "pushed-green" as const, endedAt: NOW } : value,
  );
  const text = stripAnsi(renderBoard({ ...base, runs }, selected, 100, 24));

  expect(selected.selection).toBe("run:run-102");
  expect(selected.column).toBe(3);
  expect(text).toContain("RUN #102  api  pushed-green");
});

test("detail closes instead of retargeting when its selected run disappears", () => {
  const base = snapshot();
  const selected = cursor({ column: 2, detail: true });
  renderBoard(base, selected, 100, 24);

  const runs = base.runs.filter((value) => value.issue !== 102);
  const text = stripAnsi(renderBoard({ ...base, runs }, selected, 100, 24));

  expect(selected.detail).toBe(false);
  expect(selected.selection).toBeUndefined();
  expect(text).not.toContain("RUN #");
});

test("an overflowed column scrolls to keep its selected card visible", () => {
  const runs = Array.from({ length: 8 }, (_, index) =>
    run(200 + index, "running", { id: `scroll-${index}`, startedAt: NOW - index * 1_000 }),
  );
  const selected = cursor({ column: 2, card: 7, selection: "run:scroll-7" });
  const text = stripAnsi(renderBoard({ ...snapshot(), runs }, selected, 80, 20));

  expect(text).toContain("earlier");
  expect(text).toContain("> #207 · api");
});
test("unblock notices keep the decisive eligibility result visible", () => {
  const output = [
    "#307: cleared agent:blocked",
    "  runs       3, newest blocked",
    "  failures   1 of 2",
    "  continuations 2 of 2",
    "  next tick  eligible again, as long as the issue still carries \"ready-for-agent\"",
  ].join("\n");

  expect(summarizeUnblockOutput(307, output)).toBe(
    "#307: next tick  eligible again, as long as the issue still carries \"ready-for-agent\"",
  );
});


test("the minimum supported width wraps every required health fact", () => {
  const text = stripAnsi(renderBoard(snapshot(), cursor(), 50, 20));
  for (const fact of ["daemon ok", "telegram ok", "inbound configured", "spend $8.25/$25.00"]) {
    expect(text).toContain(fact);
  }
  expect(text.split("\n").every((line) => line.length <= 50)).toBe(true);
});

test("small terminals get one actionable message", () => {
  const text = stripAnsi(renderBoard(snapshot(), cursor(), 49, 19));
  expect(text).toContain("Terminal too small: 49x19; need at least 50x20.");
});
