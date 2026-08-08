import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { findProject, loadConfig, resolveCaps } from "./config.ts";
import { statusSnapshotFromStore, type StatusSnapshot } from "./daemon.ts";
import {
  codeGraphFromHealthz,
  fleetLayers,
  probeTelegramHealth,
  type FleetLayers,
  type TelegramHealth,
} from "./fleet.ts";
import { probeCodeGraph, type CodeGraphHealth } from "./graph-health.ts";
import { healthCheck, livingDaemon } from "./lifecycle.ts";
import { dbPath, openStore } from "./store.ts";
import { formatTranscriptLine } from "./transcript.ts";
import type { AdmissionHoldReason, ProjectConfig, RunRecord, RunState, Store } from "./types.ts";

const REFRESH_MS = 1_000;
const HEALTH_REFRESH_MS = 10_000;
const MERGED_HISTORY_MS = 24 * 60 * 60_000;
const TRANSCRIPT_BYTES = 64 * 1024;
const MIN_WIDTH = 50;
const MIN_HEIGHT = 20;
const MIN_COLUMN_WIDTH = 22;

const CSI = "\x1b[";
const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const REVERSE = `${CSI}7m`;
const CYAN = `${CSI}36m`;
const GREEN = `${CSI}32m`;
const YELLOW = `${CSI}33m`;
const RED = `${CSI}31m`;
const MAGENTA = `${CSI}35m`;

const COLUMN_DEFS = [
  { key: "queue", title: "QUEUE", states: [] },
  { key: "claimed", title: "CLAIMED", states: ["claimed"] },
  { key: "running", title: "RUNNING", states: ["running"] },
  { key: "green", title: "GREEN", states: ["pushed-pending", "pushed-green"] },
  { key: "blocked", title: "BLOCKED", states: ["blocked"] },
  { key: "failed", title: "FAILED", states: ["failed", "killed", "orphaned"] },
  { key: "merged", title: "MERGED", states: ["merged"] },
] as const satisfies readonly { key: string; title: string; states: readonly RunState[] }[];

type ColumnKey = (typeof COLUMN_DEFS)[number]["key"];
type DaemonBoardState = "stopped" | "ok" | "unreachable" | "other-project";

interface QueueCard {
  kind: "queue";
  issue: number;
  reason: AdmissionHoldReason;
}

interface RunCard {
  kind: "run";
  run: RunRecord;
}

type BoardCard = QueueCard | RunCard;

export interface BoardHealth {
  layers: FleetLayers;
  telegram: TelegramHealth;
  daemon: DaemonBoardState;
  codeGraph?: CodeGraphHealth;
}

export interface BoardSnapshot {
  project: ProjectConfig;
  status: StatusSnapshot;
  health: BoardHealth;
  runs: RunRecord[];
  now: number;
}

export interface BoardCursor {
  column: number;
  card: number;
  detail: boolean;
  transcriptOffset: number;
  selection?: string;
  selectionIssue?: number;
}

interface KeyInput {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}

function ansiColor(key: ColumnKey): string {
  switch (key) {
    case "running":
      return CYAN;
    case "green":
    case "merged":
      return GREEN;
    case "claimed":
    case "blocked":
      return YELLOW;
    case "failed":
      return RED;
    default:
      return MAGENTA;
  }
}

function clip(value: string, width: number): string {
  if (width < 1) return "";
  if (value.length <= width) return value.padEnd(width);
  if (width === 1) return value.slice(0, 1);
  return `${value.slice(0, width - 1)}…`;
}

function styledCell(value: string, width: number, style = ""): string {
  const clipped = clip(value, width);
  return style === "" ? clipped : `${style}${clipped}${RESET}`;
}

function wrapDelimited(value: string, width: number, delimiter: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const segment of value.split(delimiter)) {
    const candidate = current === "" ? segment : `${current}${delimiter}${segment}`;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    const wrapped = wrap(segment, width);
    lines.push(...wrapped.slice(0, -1));
    current = wrapped.at(-1) ?? "";
  }
  if (current !== "") lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

function humanDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function queueCards(snapshot: BoardSnapshot): QueueCard[] {
  const cards: QueueCard[] = [];
  const seen = new Set<number>();
  for (const hold of snapshot.status.dispatch?.holds ?? []) {
    for (const issue of hold.issues) {
      if (seen.has(issue)) continue;
      seen.add(issue);
      cards.push({ kind: "queue", issue, reason: hold.reason });
    }
  }
  return cards;
}

function cardsFor(snapshot: BoardSnapshot, key: ColumnKey): BoardCard[] {
  if (key === "queue") return queueCards(snapshot);
  const states: readonly RunState[] = COLUMN_DEFS.find((column) => column.key === key)?.states ?? [];
  return snapshot.runs.filter((run) => states.includes(run.state)).map((run) => ({ kind: "run", run }));
}

function columnCount(snapshot: BoardSnapshot, key: ColumnKey): number {
  if (key === "queue") return snapshot.status.dispatch?.ready ?? 0;
  return cardsFor(snapshot, key).length;
}

function cardIssue(card: BoardCard): number {
  return card.kind === "queue" ? card.issue : card.run.issue;
}

function cardKey(card: BoardCard): string {
  return card.kind === "queue" ? `queue:${card.issue}` : `run:${card.run.id}`;
}

function focusedCard(snapshot: BoardSnapshot, cursor: BoardCursor): BoardCard | undefined {
  const column = COLUMN_DEFS[cursor.column];
  if (column === undefined) return undefined;
  return cardsFor(snapshot, column.key)[cursor.card];
}

function selectCard(snapshot: BoardSnapshot, cursor: BoardCursor, requested: number): void {
  const column = COLUMN_DEFS[cursor.column]!;
  const cards = cardsFor(snapshot, column.key);
  cursor.card = Math.max(0, Math.min(Math.max(0, cards.length - 1), requested));
  const card = cards[cursor.card];
  if (card === undefined) {
    delete cursor.selection;
    delete cursor.selectionIssue;
  } else {
    cursor.selection = cardKey(card);
    cursor.selectionIssue = cardIssue(card);
  }
}

function normalizeCursor(snapshot: BoardSnapshot, cursor: BoardCursor): void {
  cursor.column = Math.max(0, Math.min(COLUMN_DEFS.length - 1, cursor.column));
  const hadSelection = cursor.selection !== undefined || cursor.selectionIssue !== undefined;
  let foundColumn = -1;
  let foundCard = -1;

  if (cursor.selection !== undefined) {
    for (const [columnIndex, column] of COLUMN_DEFS.entries()) {
      const cardIndex = cardsFor(snapshot, column.key).findIndex((card) => cardKey(card) === cursor.selection);
      if (cardIndex < 0) continue;
      foundColumn = columnIndex;
      foundCard = cardIndex;
      break;
    }
  }
  if (foundColumn < 0 && cursor.selectionIssue !== undefined) {
    for (const [columnIndex, column] of COLUMN_DEFS.entries()) {
      const cardIndex = cardsFor(snapshot, column.key).findIndex((card) => cardIssue(card) === cursor.selectionIssue);
      if (cardIndex < 0) continue;
      foundColumn = columnIndex;
      foundCard = cardIndex;
      break;
    }
  }

  if (foundColumn >= 0) {
    cursor.column = foundColumn;
    selectCard(snapshot, cursor, foundCard);
  } else {
    if (hadSelection) cursor.detail = false;
    selectCard(snapshot, cursor, cursor.card);
  }
  cursor.transcriptOffset = Math.max(0, cursor.transcriptOffset);
}

function runCardLines(run: RunRecord, snapshot: BoardSnapshot): string[] {
  const endedAt = run.endedAt ?? snapshot.now;
  const duration = humanDuration(endedAt - run.startedAt);
  const lines = [
    `#${run.issue} · ${run.repo}`,
    `attempt ${run.attempt} · ${run.turns}/${run.maxTurns}t`,
    `$${run.spendUsd.toFixed(2)} · ${duration}`,
  ];
  if (run.state === "pushed-pending") lines.push("checks pending");
  else if (run.lastError !== undefined) lines.push(run.lastError.replace(/\s+/g, " "));
  else if (run.prUrl !== undefined) lines.push(run.prUrl.replace(/^https?:\/\//, ""));
  else lines.push(run.branch);
  return lines;
}

function queueCardLines(card: QueueCard): string[] {
  return [`#${card.issue}`, card.reason.replaceAll("-", " "), "held in latest tick"];
}

function renderColumn(
  snapshot: BoardSnapshot,
  key: ColumnKey,
  title: string,
  selectedColumn: boolean,
  selectedCard: number,
  width: number,
  height: number,
): string[] {
  const cards = cardsFor(snapshot, key);
  const count = columnCount(snapshot, key);
  const color = ansiColor(key);
  const slots = Math.max(1, Math.floor(Math.max(0, height - 2) / 5));
  const start = selectedColumn
    ? Math.max(0, Math.min(Math.max(0, cards.length - slots), selectedCard - Math.floor(slots / 2)))
    : 0;
  const shown = cards.slice(start, start + slots);
  const lines = [
    styledCell(` ${title} ${count}`, width, `${BOLD}${color}`),
    styledCell(start === 0 ? "─".repeat(width) : ` ↑ ${start} earlier`, width, DIM),
  ];

  if (cards.length === 0) {
    const empty = key === "queue" && count > 0 ? `${count} ready; no hold sample` : "(empty)";
    lines.push(styledCell(` ${empty}`, width, DIM));
  } else {
    for (const [offset, card] of shown.entries()) {
      const raw = card.kind === "run" ? runCardLines(card.run, snapshot) : queueCardLines(card);
      while (raw.length < 4) raw.push("");
      const selected = selectedColumn && start + offset === selectedCard;
      for (const [lineIndex, value] of raw.entries()) {
        const prefix = lineIndex === 0 ? (selected ? "> " : "  ") : "  ";
        lines.push(styledCell(`${prefix}${value}`, width, selected ? REVERSE : ""));
      }
      lines.push(" ".repeat(width));
    }
  }

  const hiddenAfter = Math.max(0, cards.length - start - shown.length);
  if (hiddenAfter > 0) lines[lines.length - 1] = styledCell(` ↓ ${hiddenAfter} more`, width, DIM);
  while (lines.length < height) lines.push(" ".repeat(width));
  return lines.slice(0, height);
}

function healthLine(snapshot: BoardSnapshot): string {
  const { layers, daemon } = snapshot.health;
  const dispatch = daemon === "other-project" ? "other-project" : layers.dispatch;
  let nextTick = "";
  if (layers.nextTickAt !== undefined) {
    const parsed = Date.parse(layers.nextTickAt);
    nextTick = ` next ${Number.isNaN(parsed) ? layers.nextTickAt : new Date(parsed).toISOString().slice(11, 19)}`;
  }
  return [
    `dispatch ${dispatch}`,
    `ticks ${layers.ticks}${nextTick}`,
    `pane ${layers.pane}`,
    `recovery ${layers.recovery}`,
    `herdr ${layers.herdr}`,
    `daemon ${daemon}`,
  ].join("  ·  ");
}

function integrationLine(snapshot: BoardSnapshot): string {
  const { telegram, codeGraph } = snapshot.health;
  const graph = codeGraph?.configured
    ? `${codeGraph.status} ${codeGraph.repos.filter((repo) => repo.index === "present").length}/${codeGraph.repos.length} indexed`
    : "off";
  const telegramDetail = telegram.detail?.replace(/\s+/g, " ").slice(0, 80);
  return `graph ${graph}  ·  telegram ${telegram.kind}${telegramDetail === undefined ? "" : ` — ${telegramDetail}`}`;
}

function admissionLine(snapshot: BoardSnapshot): string {
  const dispatch = snapshot.status.dispatch;
  const cap = snapshot.status.caps.dailySpendUsd;
  const queue =
    dispatch === undefined
      ? "dispatch not recorded"
      : `${dispatch.degraded ? "DEGRADED · " : ""}${dispatch.ready} ready · ${dispatch.routed} routed · ${dispatch.admitted} admitted`;
  const holdText = dispatch?.holds.map((hold) => `${hold.reason} ${hold.count}`).join(", ");
  const holds = holdText === undefined || holdText === "" ? "none" : holdText;
  return `${queue}  |  holds ${holds}  |  workers ${snapshot.status.liveWorkers}/${snapshot.status.caps.maxConcurrentWorkers}  |  spend $${snapshot.status.spendTodayUsd.toFixed(2)}${cap === null ? "" : `/$${cap.toFixed(2)}`}`;
}

function header(snapshot: BoardSnapshot, width: number): string[] {
  const at = new Date(snapshot.now).toISOString().slice(11, 19);
  const degradedStyle = snapshot.status.dispatch?.degraded === true ? `${BOLD}${RED}` : DIM;
  return [
    styledCell(` CONDUCTOR  ${snapshot.project.name.toUpperCase()} ${" ".repeat(Math.max(1, width - snapshot.project.name.length - 22))}${at} `, width, `${BOLD}${REVERSE}`),
    ...wrapDelimited(healthLine(snapshot), width, "  ·  ").map((line) => styledCell(line, width)),
    ...wrapDelimited(integrationLine(snapshot), width, "  ·  ").map((line) => styledCell(line, width)),
    ...wrapDelimited(admissionLine(snapshot), width, "  |  ").map((line) => styledCell(line, width, degradedStyle)),
  ];
}

function renderBoardColumns(snapshot: BoardSnapshot, cursor: BoardCursor, width: number, height: number): string[] {
  const visible = Math.max(1, Math.min(COLUMN_DEFS.length, Math.floor((width + 1) / (MIN_COLUMN_WIDTH + 1))));
  const start = Math.max(0, Math.min(COLUMN_DEFS.length - visible, cursor.column - Math.floor(visible / 2)));
  const shown = COLUMN_DEFS.slice(start, start + visible);
  const columnWidth = Math.floor((width - (shown.length - 1)) / shown.length);
  const columns = shown.map((column, offset) =>
    renderColumn(
      snapshot,
      column.key,
      column.title,
      start + offset === cursor.column,
      cursor.card,
      columnWidth,
      height,
    ),
  );
  return Array.from({ length: height }, (_, row) => columns.map((column) => column[row]).join(" "));
}

function readTranscript(run: RunRecord): string[] {
  if (run.sessionFile === undefined) return [`No transcript yet (state: ${run.state}).`];
  let fd: number | undefined;
  try {
    const size = statSync(run.sessionFile).size;
    const start = Math.max(0, size - TRANSCRIPT_BYTES);
    const buffer = Buffer.allocUnsafe(size - start);
    fd = openSync(run.sessionFile, "r");
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    const raw = buffer.subarray(0, bytes).toString("utf8");
    const source = start === 0 ? raw : raw.slice(Math.max(0, raw.indexOf("\n") + 1));
    return source
      .split("\n")
      .flatMap((line) => formatTranscriptLine(line)?.split("\n") ?? []);
  } catch (err) {
    return [`Transcript unavailable: ${err instanceof Error ? err.message : String(err)}`];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function wrap(value: string, width: number): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line === "") {
      line = word;
    } else if (line.length + word.length + 1 <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.length === 0 ? [""] : lines;
}

function renderDetail(snapshot: BoardSnapshot, cursor: BoardCursor, width: number, height: number): string[] {
  const card = focusedCard(snapshot, cursor);
  if (card === undefined) return [styledCell("No card selected.", width, DIM)];
  if (card.kind === "queue") {
    return [
      styledCell(` QUEUED ISSUE #${card.issue} `, width, `${BOLD}${REVERSE}`),
      styledCell(`Latest hold: ${card.reason}`, width),
      "",
      styledCell("No run exists yet, so there is no transcript to inspect.", width, DIM),
    ];
  }

  const run = card.run;
  const metadata = [
    styledCell(` RUN #${run.issue}  ${run.repo}  ${run.state} `, width, `${BOLD}${REVERSE}`),
    styledCell(`attempt ${run.attempt}  ·  ${run.turns}/${run.maxTurns} turns  ·  $${run.spendUsd.toFixed(2)}  ·  ${humanDuration((run.endedAt ?? snapshot.now) - run.startedAt)}`, width),
    styledCell(`branch ${run.branch}`, width, DIM),
    styledCell(`worktree ${run.worktree || "removed"}`, width, DIM),
    styledCell("─".repeat(width), width, DIM),
  ];
  const bodyHeight = Math.max(1, height - metadata.length);
  const wrapped = readTranscript(run).flatMap((line) => wrap(line, width));
  const end = Math.max(0, wrapped.length - cursor.transcriptOffset);
  const start = Math.max(0, end - bodyHeight);
  const body = wrapped.slice(start, end).map((line) => styledCell(line, width, line.startsWith("tool:") ? CYAN : ""));
  while (body.length < bodyHeight) body.unshift(" ".repeat(width));
  return [...metadata, ...body];
}

function renderHelp(width: number, height: number): string[] {
  const lines = [
    "FLEET BOARD KEYS",
    "",
    "←/→ or h/l   select column",
    "↑/↓ or k/j   select card",
    "Enter         inspect/follow transcript",
    "u             unblock selected failed or blocked issue",
    "i             open selected issue",
    "p             open selected pull request",
    "r             refresh health now",
    "?             close help",
    "Esc           back, then quit",
    "q / Ctrl-C    back, then quit",
  ];
  const top = Math.max(0, Math.floor((height - lines.length) / 2));
  return [
    ...Array.from({ length: top }, () => " ".repeat(width)),
    ...lines.map((line, index) => styledCell(line, width, index === 0 ? `${BOLD}${CYAN}` : "")),
  ].slice(0, height);
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

export function renderBoard(
  snapshot: BoardSnapshot,
  cursor: BoardCursor,
  width: number,
  height: number,
  notice = "",
  help = false,
): string {
  normalizeCursor(snapshot, cursor);
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return [
      styledCell("omp-conductor board", width, `${BOLD}${REVERSE}`),
      styledCell(`Terminal too small: ${width}x${height}; need at least ${MIN_WIDTH}x${MIN_HEIGHT}.`, width),
    ].join("\n");
  }

  const top = header(snapshot, width);
  const footerHeight = 2;
  const bodyHeight = height - top.length - footerHeight;
  const body = help
    ? renderHelp(width, bodyHeight)
    : cursor.detail
      ? renderDetail(snapshot, cursor, width, bodyHeight)
      : renderBoardColumns(snapshot, cursor, width, bodyHeight);
  while (body.length < bodyHeight) body.push(" ".repeat(width));
  const footer = cursor.detail
    ? "↑/↓ scroll  Esc back  u unblock  i issue  p PR  r refresh  ? help  q quit"
    : "←/→ column  ↑/↓ card  Enter inspect  u unblock  i issue  p PR  r refresh  ? help  q quit";
  return [
    ...top,
    ...body.slice(0, bodyHeight),
    styledCell(notice === "" ? " " : ` ${notice}`, width, notice.toLowerCase().includes("failed") ? RED : DIM),
    styledCell(` ${footer}`, width, REVERSE),
  ].join("\n");
}

async function probeBoardHealth(project: ProjectConfig): Promise<BoardHealth> {
  const layers = fleetLayers(project.name);
  const record = livingDaemon();
  const wrongRecord = record?.project !== undefined && record.project !== project.name;
  const [telegram, health] = await Promise.all([
    probeTelegramHealth(project.name),
    record === undefined || wrongRecord ? undefined : healthCheck(record.port),
  ]);
  let daemon: DaemonBoardState;
  if (record === undefined) daemon = "stopped";
  else if (wrongRecord) daemon = "other-project";
  else if (health?.ok !== true) daemon = "unreachable";
  else {
    try {
      const payload = JSON.parse(health.body ?? "null") as { project?: unknown };
      daemon = payload.project === project.name ? "ok" : "other-project";
    } catch {
      daemon = "unreachable";
    }
  }
  const cachedGraph = daemon === "ok" ? codeGraphFromHealthz(health?.body, project.name) : undefined;
  return { layers, telegram, daemon, codeGraph: cachedGraph ?? (await probeCodeGraph(project)) };
}

function issueUrl(project: ProjectConfig, issue: number): string {
  return `https://github.com/${project.tracker.repo}/issues/${issue}`;
}

async function openUrl(url: string): Promise<boolean> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    return (await Bun.spawn([command, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
}

export function summarizeUnblockOutput(issue: number, output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? `#${issue}: unblock completed` : `#${issue}: ${lines.at(-1)}`;
}

async function unblock(project: ProjectConfig, issue: number): Promise<string> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "cli.ts"), "unblock", String(issue), "--project", project.name],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) return (stderr || stdout).trim().replace(/\s+/g, " ") || `#${issue}: unblock failed`;
  return summarizeUnblockOutput(issue, stdout);
}
function enqueue(queue: KeyInput[], key: KeyInput, wake: (() => void) | undefined): void {
  queue.push(key);
  wake?.();
}

async function waitForInput(queue: KeyInput[], setWake: (wake?: () => void) => void): Promise<KeyInput> {
  if (queue.length > 0) return queue.shift()!;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, REFRESH_MS);
    setWake(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  setWake(undefined);
  return queue.shift() ?? { name: "refresh" };
}

export async function runBoard(projectName?: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("board needs an interactive terminal (TTY)");
  }

  const cfg = loadConfig();
  const project = findProject(cfg, projectName);
  const caps = resolveCaps(project, cfg.defaults);
  const store: Store = openStore(dbPath());
  const cursor: BoardCursor = { column: 2, card: 0, detail: false, transcriptOffset: 0 };
  const queue: KeyInput[] = [];
  let wake: (() => void) | undefined;
  let stopping = false;
  let help = false;
  let notice = "";
  let health = await probeBoardHealth(project);
  let healthAt = Date.now();
  let healthRefresh: Promise<void> | undefined;

  emitKeypressEvents(process.stdin);
  const onKey = (_text: string, key: KeyInput): void => enqueue(queue, key, wake);
  const onResize = (): void => enqueue(queue, { name: "resize" }, wake);
  const onStop = (): void => {
    stopping = true;
    wake?.();
  };
  process.stdin.on("keypress", onKey);
  process.stdout.on("resize", onResize);
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(`${CSI}?1049h${CSI}?25l${CSI}2J`);

  try {
    while (!stopping) {
      const now = Date.now();
      if (now - healthAt >= HEALTH_REFRESH_MS && healthRefresh === undefined) {
        healthAt = now;
        healthRefresh = probeBoardHealth(project)
          .then((next) => {
            health = next;
            enqueue(queue, { name: "refresh" }, wake);
          })
          .catch((err: unknown) => {
            notice = `health refresh failed: ${err instanceof Error ? err.message : String(err)}`;
          })
          .finally(() => {
            healthRefresh = undefined;
          });
      }
      const snapshot: BoardSnapshot = {
        project,
        status: statusSnapshotFromStore(project, caps, store),
        health,
        runs: store.recentRuns(project.name, now - MERGED_HISTORY_MS),
        now,
      };
      normalizeCursor(snapshot, cursor);
      process.stdout.write(`${CSI}H${renderBoard(snapshot, cursor, process.stdout.columns, process.stdout.rows, notice, help)}${CSI}J`);
      notice = "";

      const key = await waitForInput(queue, (next) => {
        wake = next;
      });
      const name = key.name ?? key.sequence;
      if (name === "refresh" || name === "resize") continue;
      if (name === "?" || key.sequence === "?") {
        help = !help;
        continue;
      }
      if (help) {
        if (name === "escape" || name === "q") help = false;
        continue;
      }
      if (name === "q" || (key.ctrl === true && name === "c")) {
        if (cursor.detail) cursor.detail = false;
        else stopping = true;
        continue;
      }
      if (name === "escape") {
        if (cursor.detail) cursor.detail = false;
        else stopping = true;
        continue;
      }
      if (name === "r") {
        healthAt = 0;
        notice = "refresh requested";
        continue;
      }
      if (cursor.detail && (name === "up" || name === "k")) {
        cursor.transcriptOffset += 1;
        continue;
      }
      if (cursor.detail && (name === "down" || name === "j")) {
        cursor.transcriptOffset = Math.max(0, cursor.transcriptOffset - 1);
        continue;
      }
      if (!cursor.detail && (name === "left" || name === "h")) {
        cursor.column = Math.max(0, cursor.column - 1);
        delete cursor.selection;
        selectCard(snapshot, cursor, 0);
        continue;
      }
      if (!cursor.detail && (name === "right" || name === "l")) {
        cursor.column = Math.min(COLUMN_DEFS.length - 1, cursor.column + 1);
        delete cursor.selection;
        selectCard(snapshot, cursor, 0);
        continue;
      }
      if (!cursor.detail && (name === "up" || name === "k")) {
        selectCard(snapshot, cursor, cursor.card - 1);
        continue;
      }
      if (!cursor.detail && (name === "down" || name === "j")) {
        selectCard(snapshot, cursor, cursor.card + 1);
        continue;
      }

      const card = focusedCard(snapshot, cursor);
      if (name === "return" || name === "enter") {
        if (card === undefined) notice = "no card selected";
        else {
          cursor.detail = !cursor.detail;
          cursor.transcriptOffset = 0;
        }
        continue;
      }
      if (name === "i" && card !== undefined) {
        const url = issueUrl(project, cardIssue(card));
        notice = (await openUrl(url)) ? `opened ${url}` : `failed to open ${url}`;
        continue;
      }
      if (name === "p") {
        const url = card?.kind === "run" ? card.run.prUrl : undefined;
        if (url === undefined) notice = "selected run has no pull request";
        else notice = (await openUrl(url)) ? `opened ${url}` : `failed to open ${url}`;
        continue;
      }
      if (name === "u") {
        const state = card?.kind === "run" ? card.run.state : undefined;
        if (card === undefined || card.kind !== "run" || !["blocked", "failed", "killed", "orphaned"].includes(state!)) {
          notice = "unblock is available for blocked or failed runs";
        } else {
          notice = await unblock(project, card.run.issue);
          healthAt = 0;
        }
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.off("keypress", onKey);
    process.stdout.off("resize", onResize);
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    process.stdout.write(`${CSI}?25h${CSI}?1049l`);
    store.close();
  }
}
