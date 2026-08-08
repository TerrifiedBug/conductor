/**
 * Behavioural tests for the orchestrator heartbeat.
 *
 * No real timers and no sleeps: the fake `ctx` captures the callback handed to
 * `setInterval` and the test calls it, so a tick is a function call and the
 * suite stays deterministic. `$OMP_CONDUCTOR_HOME` points at a temp directory
 * per test, which is what makes the *real* `isPaused()` — the one
 * `/conductor pause` writes for — safe to exercise here instead of stubbed.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, stateDir } from "./config.ts";
import { setPaused } from "./daemon.ts";
import orchestratorTickExtension, {
  DEFAULT_FLEET_AGENT_NAME,
  MIN_INTERVAL_SECONDS,
  readTickConfig,
  readTickRuntimeStatus,
  STALL_MARKER_FILE,
  STALL_TICKS,
  TICK_CONFIG_FILE,
  TICK_REQUESTED_FILE,
  TICK_STATUS_FILE,
  TICK_CUSTOM_TYPE,
  TICK_DELIVERY_RULE,
  TICK_OWNER_FILE,
  TICK_SCOPE_CONSTRAINTS,
  claimTickOwner,
  defaultTickMessage,
  paneOwnership,
  parseHerdrAgents,
  resolveTickOwnership,
  tickDecision,
} from "./orchestrator-tick.ts";
import type { ReportScope } from "./types.ts";

const HOME_KEY = "OMP_CONDUCTOR_HOME";
/**
 * The pane identity herdr injects. Cleared per test — the suite itself may well
 * be running inside a herdr pane, and an inherited `HERDR_ENV` would send every
 * activation test down the pane-ownership path and out to a real `herdr`.
 */
const HERDR_KEYS = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_BIN_PATH"] as const;

let cwd = "";
let home = "";
let previousHome: string | undefined;
let previousHerdr: Record<string, string | undefined> = {};

beforeEach(() => {
  previousHome = process.env[HOME_KEY];
  cwd = mkdtempSync(join(tmpdir(), "omp-conductor-tick-cwd-"));
  home = mkdtempSync(join(tmpdir(), "omp-conductor-tick-home-"));
  process.env[HOME_KEY] = home;
  previousHerdr = {};
  for (const key of HERDR_KEYS) {
    previousHerdr[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  if (previousHome === undefined) delete process.env[HOME_KEY];
  else process.env[HOME_KEY] = previousHome;
  for (const key of HERDR_KEYS) {
    const value = previousHerdr[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fake host

interface SentMessage {
  message: { customType: string; content: string; display: boolean; attribution: string };
  options: { triggerTurn?: boolean; deliverAs?: string };
}

/**
 * Stands in for the extension host. `fire()` is the captured managed-timer
 * callback; it is undefined exactly when no timer was registered, which is what
 * the activation-gate tests assert on.
 *
 * `hasUI`/`activeTools` describe the session shape the extension is loaded
 * into. The defaults are an interactive root session with no `yield` — the
 * operator sitting at the orchestrator terminal — so every pre-existing test
 * keeps describing the case it was written for.
 */
function fakeHost(
  options: { pending?: boolean; hasUI?: boolean; activeTools?: string[]; sessionFile?: string } = {},
) {
  const logs: string[] = [];
  const errors: string[] = [];
  const notices: { message: string; type?: string }[] = [];
  const sent: SentMessage[] = [];
  const intervals: { ms?: number; callback: () => void }[] = [];
  const state = { pending: options.pending ?? false };

  const ctx = {
    hasUI: options.hasUI ?? true,
    cwd,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notices.push({ message, type });
      },
    },
    hasPendingMessages: () => state.pending,
    sessionManager: { getSessionFile: () => options.sessionFile },
    setInterval(callback: () => void, ms?: number): unknown {
      intervals.push({ callback, ms });
      return { id: intervals.length };
    },
  };

  let handler: ((event: { type: "session_start" }, ctx: typeof pi.ctx) => void) | undefined;

  const pi = {
    logger: {
      // `errors` is the subset logged at error level. The stall detector's line
      // has to be one a log scraper can match on level alone, so the level is
      // part of the contract rather than an incidental of the message text.
      info: (message: string) => logs.push(message),
      error: (message: string) => {
        logs.push(message);
        errors.push(message);
      },
    },
    getActiveTools: () => options.activeTools ?? [],
    on(_event: "session_start", h: (event: { type: "session_start" }, c: typeof ctx) => void) {
      handler = h as typeof handler;
    },
    sendMessage(message: SentMessage["message"], opts: SentMessage["options"]) {
      sent.push({ message, options: opts });
    },
    ctx,
    logs,
    errors,
    notices,
    sent,
    intervals,
    state,
    start() {
      if (handler === undefined) throw new Error("extension never registered session_start");
      handler({ type: "session_start" }, ctx);
    },
    fire(): void {
      const first = intervals[0];
      if (first === undefined) throw new Error("no interval registered");
      first.callback();
    },
  };

  return pi;
}

function writeTickConfig(body: unknown): void {
  writeFileSync(join(cwd, TICK_CONFIG_FILE), typeof body === "string" ? body : JSON.stringify(body));
}

// ----------------------------------------------------------------- decision

/** Every gate satisfied — each case below breaks exactly one of them. */
const READY = { armed: true, channelOk: true, hasPending: false };

test("tickDecision sends when armed, channel up and nothing queued", () => {
  expect(tickDecision(READY)).toEqual({ send: true, reason: "armed, nothing pending" });
});

test("tickDecision skips when the arm gate is unsatisfied, ahead of the channel and queue", () => {
  expect(tickDecision({ ...READY, armed: false })).toEqual({ send: false, reason: "not armed" });
  expect(tickDecision({ armed: false, channelOk: false, hasPending: true })).toEqual({
    send: false,
    reason: "not armed",
  });
});

test("tickDecision skips when the escalation channel is down, ahead of the queue check", () => {
  expect(tickDecision({ ...READY, channelOk: false })).toEqual({
    send: false,
    reason: "escalation channel down",
  });
  expect(tickDecision({ armed: true, channelOk: false, hasPending: true })).toEqual({
    send: false,
    reason: "escalation channel down",
  });
});

test("tickDecision coalesces: a queued tick suppresses the next one", () => {
  expect(tickDecision({ ...READY, hasPending: true })).toEqual({
    send: false,
    reason: "tick already pending",
  });
});

// ------------------------------------------------------------------- config

test("readTickConfig reports an absent activation file", () => {
  const result = readTickConfig(cwd);
  expect(result.kind).toBe("absent");
});

test("readTickConfig resolves relative armedFile/accessFile against cwd and keeps absolute ones", () => {
  writeTickConfig({
    intervalSeconds: 300,
    armedFile: "state/armed",
    accessFile: "bridge/access.json",
    message: "custom",
  });
  expect(readTickConfig(cwd)).toEqual({
    kind: "ok",
    path: join(cwd, TICK_CONFIG_FILE),
    config: {
      intervalSeconds: 300,
      armedFile: join(cwd, "state", "armed"),
      accessFile: join(cwd, "bridge", "access.json"),
      message: "custom",
    },
  });

  writeTickConfig({
    intervalSeconds: 300,
    armedFile: "/root/fleet/state/armed",
    accessFile: "/root/.omp/agent/telegram/access.json",
  });
  const absolute = readTickConfig(cwd);
  expect(absolute.kind === "ok" && absolute.config.armedFile).toBe("/root/fleet/state/armed");
  expect(absolute.kind === "ok" && absolute.config.accessFile).toBe("/root/.omp/agent/telegram/access.json");
});

test("readTickConfig rejects a sub-minute, fractional or non-numeric interval", () => {
  for (const interval of [30, 59, 60.5, "300", null]) {
    writeTickConfig({ intervalSeconds: interval });
    const result = readTickConfig(cwd);
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.problem).toContain("intervalSeconds");
  }

  writeTickConfig({ intervalSeconds: MIN_INTERVAL_SECONDS });
  expect(readTickConfig(cwd).kind).toBe("ok");
});

test("readTickConfig collects every fault in one message", () => {
  writeTickConfig({ intervalSeconds: 10, armedFile: "", accessFile: 3, message: 7 });
  const result = readTickConfig(cwd);
  expect(result.kind).toBe("invalid");
  const problem = result.kind === "invalid" ? result.problem : "";
  expect(problem).toContain("intervalSeconds");
  expect(problem).toContain("armedFile");
  expect(problem).toContain("accessFile");
  expect(problem).toContain("message");
});

test("readTickConfig rejects malformed JSON and non-objects without throwing", () => {
  writeTickConfig("{ not json");
  expect(readTickConfig(cwd).kind).toBe("invalid");

  writeTickConfig([1, 2, 3]);
  const array = readTickConfig(cwd);
  expect(array.kind === "invalid" && array.problem).toBe("must be a JSON object");
});

// ------------------------------------------------------------ activation gate

test("no activation file registers no timer and raises no notification", () => {
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();

  expect(pi.intervals).toHaveLength(0);
  expect(pi.notices).toHaveLength(0);
  expect(pi.logs.join("\n")).toContain("inactive");
});

test("an invalid interval registers no timer and notifies once", () => {
  writeTickConfig({ intervalSeconds: 5 });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();

  expect(pi.intervals).toHaveLength(0);
  expect(pi.notices).toHaveLength(1);
  expect(pi.notices[0]?.type).toBe("error");
  expect(pi.notices[0]?.message).toContain("intervalSeconds");
});

test("a valid config registers exactly one managed timer at the configured period", () => {
  writeTickConfig({ intervalSeconds: 600 });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();

  expect(pi.intervals).toHaveLength(1);
  expect(pi.intervals[0]?.ms).toBe(600_000);
});

test("a second session_start does not install a second heartbeat", () => {
  writeTickConfig({ intervalSeconds: 600 });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();
  pi.start();

  expect(pi.intervals).toHaveLength(1);
});

// ------------------------------------------------------------- session shape
//
// A worker subagent runs in the orchestrator's own cwd, so the activation file
// is present and valid for it too. Only the session shape separates the two,
// and it takes both halves: headless *and* holding `yield`.

test("a subagent never arms, even with a valid activation file in its cwd", () => {
  writeTickConfig({ intervalSeconds: 600 });
  const pi = fakeHost({ hasUI: false, activeTools: ["read", "edit", "yield"] });
  orchestratorTickExtension(pi);
  pi.start();

  expect(pi.intervals).toHaveLength(0);
  expect(pi.notices).toHaveLength(0);
  expect(pi.sent).toHaveLength(0);
  expect(pi.logs).toEqual(["[omp-conductor] tick inert: subagent session"]);
});

test("a headless root session arms: no UI alone is print/RPC mode, not a subagent", () => {
  writeTickConfig({ intervalSeconds: 600 });
  const pi = fakeHost({ hasUI: false, activeTools: ["read", "edit"] });
  orchestratorTickExtension(pi);
  pi.start();

  expect(pi.intervals).toHaveLength(1);
  expect(pi.intervals[0]?.ms).toBe(600_000);
});

test("an interactive session arms even while `yield` is active: tools alone disqualify nothing", () => {
  writeTickConfig({ intervalSeconds: 600 });
  const pi = fakeHost({ hasUI: true, activeTools: ["read", "edit", "yield"] });
  orchestratorTickExtension(pi);
  pi.start();

  expect(pi.intervals).toHaveLength(1);
  expect(pi.intervals[0]?.ms).toBe(600_000);
});

// -------------------------------------------------------------- timer wiring

test("firing the captured callback sends one tick with the documented delivery", () => {
  writeTickConfig({ intervalSeconds: 600 });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();
  pi.fire();

  expect(pi.sent).toHaveLength(1);
  const tick = pi.sent[0];
  expect(tick?.message.customType).toBe(TICK_CUSTOM_TYPE);
  expect(tick?.message.display).toBe(true);
  expect(tick?.message.attribution).toBe("user");
  expect(tick?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  expect(tick?.message.content).toContain("ORCHESTRATOR.md");
  expect(pi.logs.join("\n")).toContain("tick sent");
});

test("heartbeat publishes its next due time for out-of-process status", () => {
  writeTickConfig({ intervalSeconds: 600 });
  const before = Date.now();
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();

  const status = readTickRuntimeStatus(cwd);
  expect(status?.pid).toBe(process.pid);
  expect(status?.intervalSeconds).toBe(600);
  const due = Date.parse(status?.nextTickAt ?? "");
  expect(due).toBeGreaterThanOrEqual(before + 600_000);
  expect(due).toBeLessThanOrEqual(Date.now() + 600_000);
  expect(existsSync(join(cwd, TICK_STATUS_FILE))).toBe(true);
});

test("a recover tick request fires immediately on arm and clears the sentinel", () => {
  writeTickConfig({ intervalSeconds: 600 });
  writeFileSync(join(cwd, TICK_REQUESTED_FILE), "2026-08-07T15:00:00Z recover\n");
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();

  expect(pi.sent).toHaveLength(1);
  expect(pi.logs.join("\n")).toContain("tick requested by recover");
  expect(existsSync(join(cwd, TICK_REQUESTED_FILE))).toBe(false);
});

test("a recover tick request survives a not-armed skip so a later arm can still send", () => {
  writeTickConfig({ intervalSeconds: 600, armedFile: "state/armed" });
  mkdirSync(join(cwd, "state"), { recursive: true });
  writeFileSync(join(cwd, TICK_REQUESTED_FILE), "recover\n");
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();

  // Gates fail: no send, sentinel stays for when the operator arms.
  expect(pi.sent).toHaveLength(0);
  expect(existsSync(join(cwd, TICK_REQUESTED_FILE))).toBe(true);

  writeFileSync(join(cwd, "state", "armed"), "");
  pi.fire();
  expect(pi.sent).toHaveLength(1);
  expect(existsSync(join(cwd, TICK_REQUESTED_FILE))).toBe(false);
});


test("a configured message is sent verbatim in place of the default", () => {
  writeTickConfig({ intervalSeconds: 600, message: "loop now" });
  // A scope that would otherwise append a line of its own: an operator who
  // wrote their own prompt gets exactly that prompt, contract included.
  writeConductorConfig({ name: "fleet", scope: "escalations" });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();
  pi.fire();

  expect(pi.sent[0]?.message.content).toBe("loop now");
  // Not even the delivery rule is appended: the operator's prompt is the whole
  // contract, and it is theirs to get wrong.
  expect(pi.sent[0]?.message.content).not.toContain(TICK_DELIVERY_RULE);
});

test("a custom message tick still recomposes ORCHESTRATOR.md from POLICY.md", () => {
  // Refresh used to live only inside resolveTickScope(), which custom-message
  // ticks never call. Package-floor updates would stay stale forever on a
  // supported custom heartbeat config.
  writeConductorConfig({ name: "fleet", scope: "escalations" });
  const worktrees = join(home, "worktrees");
  mkdirSync(worktrees, { recursive: true });
  writeFileSync(join(worktrees, "POLICY.md"), "## Releases\nCUSTOM POLICY MARKER.\n");
  writeFileSync(join(worktrees, "ORCHESTRATOR.md"), "STALE BRIEF — must be replaced\n");
  writeTickConfig({ intervalSeconds: 600, message: "loop now" });

  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();
  pi.fire();

  expect(pi.sent[0]?.message.content).toBe("loop now");
  const composed = readFileSync(join(worktrees, "ORCHESTRATOR.md"), "utf8");
  expect(composed).not.toContain("STALE BRIEF");
  expect(composed).toContain("CUSTOM POLICY MARKER.");
  expect(composed).toContain("YOURS TO EDIT");
  expect(composed).toContain("package floor");
});

test("a configured message is re-read every tick, so an edit binds the next heartbeat", () => {
  writeTickConfig({ intervalSeconds: 600, message: "loop now" });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();

  pi.fire();
  expect(pi.sent[0]?.message.content).toBe("loop now");

  // The operator rewords the prompt hours later, without restarting anything.
  writeTickConfig({ intervalSeconds: 600, message: "loop now, and report with telegram_send" });
  pi.fire();
  expect(pi.sent[1]?.message.content).toBe("loop now, and report with telegram_send");

  // Dropping the key hands the prompt back to the shipped default, delivery rule
  // included: a re-read that succeeds owns the whole answer, absences included.
  writeTickConfig({ intervalSeconds: 600 });
  pi.fire();
  expect(pi.sent[2]?.message.content).toContain(TICK_DELIVERY_RULE);

  // The period is not re-read, and says so: rescheduling a live managed timer is
  // a restart's job, so the one registered interval keeps its startup value.
  writeTickConfig({ intervalSeconds: 1800, message: "loop now" });
  pi.fire();
  expect(pi.sent[3]?.message.content).toBe("loop now");
  expect(pi.intervals).toHaveLength(1);
  expect(pi.intervals[0]?.ms).toBe(600_000);
});

test("a message re-read that fails keeps the startup prompt, and keeps ticking", () => {
  writeTickConfig({ intervalSeconds: 600, message: "loop now" });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();

  // Caught mid-edit: the file on disk is truncated.
  writeTickConfig('{ "intervalSeconds": 600, "message": ');
  pi.fire();
  expect(pi.sent[0]?.message.content).toBe("loop now");

  // Parseable but invalid — the validator refuses a sub-minute interval, and one
  // bad field must not cost the operator the prompt they are still editing.
  writeTickConfig({ intervalSeconds: 5, message: "never sent" });
  pi.fire();
  expect(pi.sent[1]?.message.content).toBe("loop now");

  // Gone entirely: the heartbeat is not the thing that stops.
  rmSync(join(cwd, TICK_CONFIG_FILE));
  pi.fire();
  expect(pi.sent[2]?.message.content).toBe("loop now");
  expect(pi.notices).toHaveLength(0);
});

test("the default message orders a disk re-read of the resolved brief and carries the timestamp", () => {
  const at = new Date("2026-08-06T12:00:00.000Z");
  // "Re-read … from disk" is load-bearing, and it is an observed failure, not a
  // hypothetical: a session's context copy of the brief dates from its start
  // (resume included), so a tick that merely says "run your loop" can act on a
  // brief the operator has since amended — and a standing task added between
  // ticks never binds. The path is resolved from the config because the brief
  // lives at <workspaceRoot>/ORCHESTRATOR.md, not in the session cwd; the bare
  // name is only the no-config fallback.
  expect(defaultTickMessage(at)).toBe(
    "Tick 2026-08-06T12:00:00.000Z: re-read ORCHESTRATOR.md (composed package floor + policy) and POLICY.md (editable fleet policy) from disk, then run your standing loop from them. Learning-loop amendments edit only POLICY.md — never the package floor.",
  );
  expect(defaultTickMessage(at, "/data/fleet/worktrees/ORCHESTRATOR.md", "/data/fleet/worktrees/POLICY.md")).toBe(
    "Tick 2026-08-06T12:00:00.000Z: re-read /data/fleet/worktrees/ORCHESTRATOR.md (composed package floor + policy) and /data/fleet/worktrees/POLICY.md (editable fleet policy) from disk, then run your standing loop from them. Learning-loop amendments edit only /data/fleet/worktrees/POLICY.md — never the package floor.",
  );
});

test("a tick fires regardless of /conductor pause — that flag gates dispatch, not this session", () => {
  writeTickConfig({ intervalSeconds: 600 });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();

  // Pause once silenced the heartbeat too, which starved the external
  // orchestrator of the duties that stay useful while dispatch is stopped —
  // grooming, draining, even reporting that the fleet IS paused. The operator's
  // lever for this session is the arm marker, tested below.
  setPaused(true);
  try {
    pi.fire();
    expect(pi.sent).toHaveLength(1);
  } finally {
    setPaused(false);
  }
});

test("a tick sends nothing until the arm marker exists", () => {
  writeTickConfig({ intervalSeconds: 600, armedFile: "state/armed" });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();

  pi.fire();
  expect(pi.sent).toHaveLength(0);
  expect(pi.logs.join("\n")).toContain("not armed");

  mkdirSync(join(cwd, "state"), { recursive: true });
  writeFileSync(join(cwd, "state", "armed"), "");
  pi.fire();
  expect(pi.sent).toHaveLength(1);
});

test("a tick that is still queued suppresses the next one, no UI noise either way", () => {
  writeTickConfig({ intervalSeconds: 600 });
  const pi = fakeHost({ pending: true });
  orchestratorTickExtension(pi);
  pi.start();

  pi.fire();
  expect(pi.sent).toHaveLength(0);
  expect(pi.logs.join("\n")).toContain("tick already pending");

  pi.state.pending = false;
  pi.fire();
  expect(pi.sent).toHaveLength(1);
  expect(pi.notices).toHaveLength(0);
});

// ------------------------------------------------------------ stall detector

/** An armed session whose queue never drains — the wedge of 2026-08-07. */
function stallHost() {
  writeTickConfig({ intervalSeconds: 1800 });
  const pi = fakeHost({ pending: true });
  orchestratorTickExtension(pi);
  pi.start();
  return pi;
}

/** The marker the detector writes, under this test's own temp cwd. */
const marker = () => join(cwd, STALL_MARKER_FILE);

test("two consecutive queued ticks write the stall marker and say so at error level", () => {
  const pi = stallHost();

  // One skip is ordinary backpressure: a turn that outran the interval.
  pi.fire();
  expect(existsSync(marker())).toBe(false);
  expect(pi.errors).toHaveLength(0);

  pi.fire();
  const written = readFileSync(marker(), "utf8").trim();
  const [stamp, ...diagnosis] = written.split(" ");
  expect(Number.isNaN(Date.parse(stamp ?? ""))).toBe(false);
  expect(diagnosis.join(" ")).toBe(`${STALL_TICKS} ticks queued unconsumed — the agent loop is not draining`);
  expect(pi.errors.join("\n")).toContain(
    `[omp-conductor] orchestrator stalled: ${STALL_TICKS} ticks queued unconsumed — ` +
      `the agent loop is not draining; see ${STALL_MARKER_FILE}`,
  );
  // Still no prompt and still no UI noise: the point of the marker is that the
  // wedged session cannot be the one to report on itself.
  expect(pi.sent).toHaveLength(0);
  expect(pi.notices).toHaveLength(0);

  // A third skip must not rewrite it. "STALLED since" walking forward every
  // interval would hide exactly the duration a watchdog reads the file for.
  writeFileSync(marker(), "SENTINEL\n");
  pi.fire();
  expect(readFileSync(marker(), "utf8")).toBe("SENTINEL\n");
  expect(pi.errors).toHaveLength(1);
});

test("a consumed tick resets the counter, so alternating skips never trip the detector", () => {
  const pi = stallHost();

  pi.fire();
  pi.state.pending = false;
  pi.fire();
  pi.state.pending = true;
  pi.fire();

  // Two skips, but not two in a row: the queue drained in between, which is a
  // slow orchestrator rather than a stopped one.
  expect(pi.sent).toHaveLength(1);
  expect(existsSync(marker())).toBe(false);
  expect(pi.errors).toHaveLength(0);
});

test("the first consumed tick after a stall clears the marker", () => {
  const pi = stallHost();
  pi.fire();
  pi.fire();
  expect(existsSync(marker())).toBe(true);

  pi.state.pending = false;
  pi.fire();

  expect(pi.sent).toHaveLength(1);
  expect(existsSync(marker())).toBe(false);
  expect(pi.logs.join("\n")).toContain("orchestrator stall cleared");
});

test("a marker left by a wedged predecessor is cleared by the first tick this session sends", () => {
  // The real recovery shape: the wedged process was killed and its transcript
  // resumed, so the session that clears the marker is never the one that wrote
  // it and starts with a zero counter.
  writeTickConfig({ intervalSeconds: 1800 });
  writeFileSync(marker(), "2026-08-07T06:27:55.000Z 2 ticks queued unconsumed — the agent loop is not draining\n");
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();

  pi.fire();
  expect(pi.sent).toHaveLength(1);
  expect(existsSync(marker())).toBe(false);
});

// ------------------------------------------------------- escalation channel

/**
 * The Telegram bridge's access file, shaped like the real one on the fleet host
 * (`enabled`, `dmPolicy`, `allowFrom`, ...). Only the two fields the gate reads
 * are varied; the rest is there so a fixture that passes is a plausible file
 * rather than the minimum the check happens to accept.
 */
function writeAccess(overrides: Record<string, unknown>): void {
  mkdirSync(join(cwd, "bridge"), { recursive: true });
  writeFileSync(
    join(cwd, "bridge", "access.json"),
    JSON.stringify({ enabled: true, dmPolicy: "pairing", allowFrom: ["4242424242"], groups: {}, ...overrides }),
  );
}

/** An armed, unpaused session whose only variable is the access file. */
function channelHost() {
  writeTickConfig({ intervalSeconds: 600, accessFile: "bridge/access.json" });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();
  return pi;
}

test("a tick sends when the bridge is enabled with exactly one paired owner", () => {
  writeAccess({});
  const pi = channelHost();

  pi.fire();
  expect(pi.sent).toHaveLength(1);
  expect(pi.notices).toHaveLength(0);
});

test("a disabled bridge stops ticking, and re-enabling it resumes", () => {
  writeAccess({ enabled: false });
  const pi = channelHost();

  pi.fire();
  expect(pi.sent).toHaveLength(0);
  expect(pi.logs.join("\n")).toContain("escalation channel down");

  writeAccess({ enabled: true });
  pi.fire();
  expect(pi.sent).toHaveLength(1);
});

test("the owner count must be exactly one: zero pages nobody, two is ambiguous", () => {
  writeAccess({ allowFrom: [] });
  const pi = channelHost();
  pi.fire();
  expect(pi.sent).toHaveLength(0);

  writeAccess({ allowFrom: ["4242424242", "9999999999"] });
  pi.fire();
  expect(pi.sent).toHaveLength(0);

  writeAccess({ allowFrom: "4242424242" });
  pi.fire();
  expect(pi.sent).toHaveLength(0);

  writeAccess({ allowFrom: ["4242424242"] });
  pi.fire();
  expect(pi.sent).toHaveLength(1);
  expect(pi.notices).toHaveLength(0);
});

test("an unreadable, truncated or non-object access file fails closed", () => {
  const pi = channelHost();

  // Never written: the bridge was never configured, or the file was removed.
  pi.fire();
  expect(pi.sent).toHaveLength(0);
  expect(pi.logs.join("\n")).toContain("escalation channel down");

  mkdirSync(join(cwd, "bridge"), { recursive: true });
  writeFileSync(join(cwd, "bridge", "access.json"), '{ "enabled": true, "allowFrom": [');
  pi.fire();
  expect(pi.sent).toHaveLength(0);

  writeFileSync(join(cwd, "bridge", "access.json"), "[]");
  pi.fire();
  expect(pi.sent).toHaveLength(0);

  // A hand-edit that dropped `enabled` entirely, rather than setting it false.
  writeFileSync(join(cwd, "bridge", "access.json"), JSON.stringify({ allowFrom: ["4242424242"] }));
  pi.fire();
  expect(pi.sent).toHaveLength(0);

  writeAccess({});
  pi.fire();
  expect(pi.sent).toHaveLength(1);
});

test("the channel is re-read every tick, not cached at session start", () => {
  writeAccess({});
  const pi = channelHost();

  pi.fire();
  expect(pi.sent).toHaveLength(1);

  // The operator unpairs hours later; the next tick must notice.
  writeAccess({ allowFrom: [] });
  pi.fire();
  expect(pi.sent).toHaveLength(1);
  expect(pi.logs.join("\n")).toContain("escalation channel down");
});

test("an unconfigured accessFile leaves the channel gate open", () => {
  writeTickConfig({ intervalSeconds: 600 });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();

  pi.fire();
  expect(pi.sent).toHaveLength(1);
});

// --------------------------------------------------------- reporting scope
//
// The scope comes from the conductor config (`$OMP_CONDUCTOR_HOME/config.json`),
// not from `.conductor-tick.json`, and is read again on every tick: an operator
// re-runs `/conductor setup` while the orchestrator session lives.

/** A conductor config the loader accepts, carrying the scope under test. */
function writeConductorConfig(...projects: { name: string; scope?: ReportScope }[]): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(
    configPath(),
    JSON.stringify({
      version: 1,
      projects: projects.map((p) => ({
        name: p.name,
        tracker: { kind: "github", repo: `acme/${p.name}` },
        queueLabel: "ready-for-agent",
        routing: { repos: { api: { cloneUrl: "git@github.com:acme/api.git" } } },
        ...(p.scope === undefined ? {} : { reporting: { scope: p.scope } }),
      })),
    }),
  );
}

/** An armed, unpaused session whose only variable is the conductor config. */
function scopeHost() {
  writeTickConfig({ intervalSeconds: 600 });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();
  return pi;
}

test("both constraint lines are pinned verbatim: they are the contract the turn reads", () => {
  expect(TICK_SCOPE_CONSTRAINTS.material).toBe("Report material events per your brief.");
  expect(TICK_SCOPE_CONSTRAINTS.escalations).toBe(
    "Report NOTHING this turn except a Tier 1 or Tier 2 escalation; everything else -- releases included -- waits for the daily digest.",
  );
});

test("scope escalations sends the silence-by-default line, and only that one", () => {
  writeConductorConfig({ name: "fleet", scope: "escalations" });
  const pi = scopeHost();

  pi.fire();
  const content = pi.sent[0]?.message.content ?? "";
  expect(content).toContain(TICK_SCOPE_CONSTRAINTS.escalations);
  expect(content).not.toContain(TICK_SCOPE_CONSTRAINTS.material);
  // Appended to the standing prompt, not in place of it.
  expect(content).toContain("ORCHESTRATOR.md");
  expect(content).toContain(TICK_DELIVERY_RULE);
});

test("scope material — and a config written before the key existed — send the material line", () => {
  writeConductorConfig({ name: "fleet", scope: "material" });
  const pi = scopeHost();

  pi.fire();
  expect(pi.sent[0]?.message.content).toContain(TICK_SCOPE_CONSTRAINTS.material);

  writeConductorConfig({ name: "fleet" });
  pi.fire();
  expect(pi.sent[1]?.message.content).toContain(TICK_SCOPE_CONSTRAINTS.material);
});

test("no conductor config at all: the tick still fires on the default scope, and says so once", () => {
  // `$OMP_CONDUCTOR_HOME` is an empty temp directory — `loadConfig()` throws.
  const pi = scopeHost();

  expect(() => pi.fire()).not.toThrow();
  expect(pi.sent[0]?.message.content).toContain(TICK_SCOPE_CONSTRAINTS.material);

  pi.fire();
  expect(pi.sent).toHaveLength(2);
  expect(pi.sent[1]?.message.content).toContain(TICK_SCOPE_CONSTRAINTS.material);
  // One line per session about the missing config, not one per interval forever.
  expect(pi.logs.filter((l) => l.includes("tick reporting scope"))).toHaveLength(1);
});

test("an unparseable conductor config falls back instead of stopping the heartbeat", () => {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(configPath(), '{ "version": 1, "projects": [');
  const pi = scopeHost();

  pi.fire();
  expect(pi.sent[0]?.message.content).toContain(TICK_SCOPE_CONSTRAINTS.material);
  expect(pi.notices).toHaveLength(0);
});

test("several projects with none named is ambiguous, so the default scope is used", () => {
  writeConductorConfig({ name: "fleet", scope: "escalations" }, { name: "homelab", scope: "escalations" });
  const pi = scopeHost();

  pi.fire();
  // Guessing between them would inject one project's reporting contract into a
  // session that supervises both.
  expect(pi.sent[0]?.message.content).toContain(TICK_SCOPE_CONSTRAINTS.material);
});

test("the scope is re-read every tick, so a setup re-run binds the next heartbeat", () => {
  writeConductorConfig({ name: "fleet", scope: "material" });
  const pi = scopeHost();

  pi.fire();
  expect(pi.sent[0]?.message.content).toContain(TICK_SCOPE_CONSTRAINTS.material);

  // The operator turns the volume down hours later, without restarting anything.
  writeConductorConfig({ name: "fleet", scope: "escalations" });
  pi.fire();
  expect(pi.sent[1]?.message.content).toContain(TICK_SCOPE_CONSTRAINTS.escalations);
  expect(pi.sent[1]?.message.content).not.toContain(TICK_SCOPE_CONSTRAINTS.material);
});

// ---------------------------------------------------------- delivery rule
//
// End-of-turn text reaches the operator's Telegram only on a turn that began as
// an inbound Telegram message, and a locally-injected tick is never one. The
// rule rides in the prompt itself so that no fleet re-learns it the way this one
// did on 2026-08-06, when a release report and two tier-2 escalations were
// written as end-of-turn text and read by nobody.

test("the delivery rule is pinned verbatim: it is what makes a report real", () => {
  expect(TICK_DELIVERY_RULE).toBe(
    "This tick was injected locally, not sent from Telegram, so your end-of-turn text does NOT reach your operator. Deliver anything reportable this turn by calling the telegram_send tool and confirming success; never claim a report was sent otherwise.",
  );
});

test("the default tick is three lines: the prompt, the scope contract, the delivery rule", () => {
  writeConductorConfig({ name: "fleet", scope: "material" });
  const pi = scopeHost();

  pi.fire();
  const lines = (pi.sent[0]?.message.content ?? "").split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("ORCHESTRATOR.md");
  expect(lines[1]).toBe(TICK_SCOPE_CONSTRAINTS.material);
  expect(lines[2]).toBe(TICK_DELIVERY_RULE);
});

// ---------------------------------------------------------------- tick owner
//
// Activation is the presence of `.conductor-tick.json` in the cwd, which is a
// property of the *directory*: every omp session started there armed a
// heartbeat, and with merge and release delegated in config, a shell opened
// beside the orchestrator to read state believed it held both (issue #40,
// observed live on 2026-08-07 as panes w1:p1 and w1:p5 both ticking).

/** herdr's own answer shape, envelope and all — `name` is `null`, not absent,
 *  on a pane it has no registered agent name for. */
function agentListJson(rows: { pane: string; name?: string | null }[]): string {
  return JSON.stringify({
    id: "cli:agent:list",
    result: {
      agents: rows.map((r) => ({
        agent: "omp",
        agent_status: "idle",
        cwd,
        name: r.name ?? null,
        pane_id: r.pane,
      })),
    },
  });
}

/** A stand-in `herdr` on PATH-free terms: `HERDR_BIN_PATH` names it, exactly as
 *  herdr/bin/recover.sh allows, so the subprocess path is exercised for real. */
function fakeHerdrBin(body: string, exitCode = 0): string {
  const path = join(cwd, "fake-herdr");
  writeFileSync(path, `#!/bin/sh\ncat <<'JSON'\n${body}\nJSON\nexit ${String(exitCode)}\n`, { mode: 0o755 });
  return path;
}

test("the fleet's own pane ticks, and the discriminator is the name and not the runtime", () => {
  const agents = [
    { paneId: "w1:p1", name: "fleet" },
    { paneId: "w1:p5" },
  ];

  expect(paneOwnership({ paneId: "w1:p1", agentName: "fleet", agents })).toEqual({ kind: "owner" });
});

test("an ad-hoc pane in the fleet cwd declines, naming the pane that owns the tick", () => {
  const agents = [
    { paneId: "w1:p1", name: "fleet" },
    { paneId: "w1:p5" },
  ];

  // The wording is the deliverable: the failure was never that a second session
  // could exist, it was that nobody could tell which one was driving the fleet.
  expect(paneOwnership({ paneId: "w1:p5", agentName: "fleet", agents })).toEqual({
    kind: "declined",
    reason: 'pane w1:p1 (agent "fleet") owns the fleet tick here — this session will not tick',
  });
});

test("a named pane that is not this fleet's agent declines, and says which agent it is", () => {
  const agents = [
    { paneId: "w1:p1", name: "fleet" },
    { paneId: "w1:p5", name: "scratch" },
  ];

  // Requiring merely *a* name would arm every registered omp agent herdr keeps
  // in this directory, which is the same bug with a nicer log line.
  expect(paneOwnership({ paneId: "w1:p5", agentName: "fleet", agents })).toEqual({
    kind: "declined",
    reason: 'this pane is agent "scratch", not the fleet agent "fleet" — this session will not tick',
  });
});

test("an unnamed pane with no fleet agent anywhere declines, and names the fix", () => {
  const decision = paneOwnership({ paneId: "w1:p5", agentName: "fleet", agents: [{ paneId: "w1:p5" }] });

  // Fail closed: this is the ad-hoc shell the issue is about. An orchestrator
  // that lost its registration is one `herdr agent start` from ticking again, so
  // the decline says so rather than leaving an operator to guess.
  expect(decision.kind).toBe("declined");
  const reason = decision.kind === "declined" ? decision.reason : "";
  expect(reason).toContain("not a registered herdr agent");
  expect(reason).toContain("herdr agent start fleet --kind omp --pane w1:p5");
  expect(reason.endsWith("this session will not tick")).toBe(true);
});

test("a renamed fleet agent is honoured on both halves, not just recover.sh's default", () => {
  const agents = [{ paneId: "w2:p1", name: "veltro-fleet" }];

  expect(paneOwnership({ paneId: "w2:p1", agentName: "veltro-fleet", agents })).toEqual({ kind: "owner" });
  expect(paneOwnership({ paneId: "w2:p1", agentName: DEFAULT_FLEET_AGENT_NAME, agents }).kind).toBe("declined");
});

test("herdr's agent list parses through its envelope, and a null name is no name", () => {
  expect(parseHerdrAgents(agentListJson([{ pane: "w1:p1", name: "fleet" }, { pane: "w1:p5" }]))).toEqual({
    kind: "ok",
    agents: [{ paneId: "w1:p1", name: "fleet" }, { paneId: "w1:p5" }],
  });

  // An unparseable list proves nothing about who owns the tick, so it is a
  // reported fact rather than an empty list that would read as "nobody owns it".
  expect(parseHerdrAgents("not json").kind).toBe("unavailable");
  expect(parseHerdrAgents('{"result":{}}').kind).toBe("unavailable");
});

test("a herdr that does not answer is unresolved, not declined — the difference is retryability", () => {
  const decision = resolveTickOwnership({
    cwd,
    agentName: "fleet",
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p5" },
    pid: process.pid,
    now: new Date(),
    listAgents: () => ({ kind: "unavailable", problem: "socket refused" }),
  });

  // Both outcomes refuse to tick. Only this one may be retried: herdr failing to
  // answer says nothing about who this pane is, so latching it would let a
  // single CLI timeout stop the real orchestrator until a human restarts it.
  expect(decision).toEqual({
    kind: "unresolved",
    reason: 'cannot yet prove this pane is the fleet agent "fleet" — socket refused — not ticking until it can',
  });
  // And it wrote no claim: under herdr the pane name is the answer, and a claim
  // file would be a second, disagreeing source of truth.
  expect(existsSync(join(cwd, TICK_OWNER_FILE))).toBe(false);
});

test("with no herdr, the first session claims the directory and ticks", () => {
  const decision = claimTickOwner({ cwd, pid: 4242, sessionFile: "/tmp/session.jsonl", now: new Date(0) });

  expect(decision).toEqual({ kind: "owner" });
  expect(JSON.parse(readFileSync(join(cwd, TICK_OWNER_FILE), "utf8"))).toEqual({
    pid: 4242,
    sessionFile: "/tmp/session.jsonl",
    claimedAt: "1970-01-01T00:00:00.000Z",
  });
});

test("a live owner's claim is honoured, and the decline names the holder", () => {
  claimTickOwner({ cwd, pid: 4242, sessionFile: "/tmp/first.jsonl", now: new Date(0) });

  const decision = claimTickOwner({ cwd, pid: 9999, now: new Date(1000), alive: (pid) => pid === 4242 });

  expect(decision.kind).toBe("declined");
  const reason = decision.kind === "declined" ? decision.reason : "";
  expect(reason).toContain("pid 4242");
  expect(reason).toContain("/tmp/first.jsonl");
  expect(reason).toContain(cwd);
  // The claim is untouched: a live owner keeps it.
  expect(JSON.parse(readFileSync(join(cwd, TICK_OWNER_FILE), "utf8")).pid).toBe(4242);
});

test("a dead owner's claim is reclaimed — liveness is a pid check, never a timestamp", () => {
  claimTickOwner({ cwd, pid: 4242, now: new Date(0) });

  // The claim is ancient and the pid is gone: a crashed pane must not wedge the
  // fleet, and an age-based lease would have handed ownership away while a slow
  // orchestrator was still running.
  const decision = claimTickOwner({ cwd, pid: 9999, now: new Date(10_000), alive: () => false });

  expect(decision).toEqual({ kind: "owner" });
  expect(JSON.parse(readFileSync(join(cwd, TICK_OWNER_FILE), "utf8")).pid).toBe(9999);
});

test("the owner re-claiming its own directory still owns it", () => {
  claimTickOwner({ cwd, pid: 4242, now: new Date(0) });

  expect(claimTickOwner({ cwd, pid: 4242, now: new Date(5000), alive: () => true })).toEqual({ kind: "owner" });
});

test("a corrupt or partial claim file is no claim at all", () => {
  for (const body of ["{ not json", "[]", '{"pid":"nine"}', '{"claimedAt":"now"}']) {
    writeFileSync(join(cwd, TICK_OWNER_FILE), body);
    expect(claimTickOwner({ cwd, pid: 4242, now: new Date(0), alive: () => true })).toEqual({ kind: "owner" });
  }
});

test("under herdr, the fleet pane arms through a real `herdr agent list` call", () => {
  writeTickConfig({ intervalSeconds: 600 });
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "w1:p1";
  process.env["HERDR_BIN_PATH"] = fakeHerdrBin(agentListJson([{ pane: "w1:p1", name: "fleet" }, { pane: "w1:p5" }]));
  const pi = fakeHost();

  orchestratorTickExtension(pi);
  pi.start();

  expect(pi.intervals).toHaveLength(1);
  expect(pi.logs.join("\n")).toContain("orchestrator tick active");
  // The pane name decided it, so no claim file was written beside the config.
  expect(existsSync(join(cwd, TICK_OWNER_FILE))).toBe(false);
});

test("under herdr, a second pane in the same cwd arms nothing and says so exactly once", () => {
  writeTickConfig({ intervalSeconds: 600 });
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "w1:p5";
  process.env["HERDR_BIN_PATH"] = fakeHerdrBin(agentListJson([{ pane: "w1:p1", name: "fleet" }, { pane: "w1:p5" }]));
  const pi = fakeHost();

  orchestratorTickExtension(pi);
  pi.start();
  pi.start();

  expect(pi.intervals).toHaveLength(0);
  expect(pi.sent).toHaveLength(0);
  expect(pi.notices).toHaveLength(0);
  expect(pi.logs).toEqual([
    '[omp-conductor] orchestrator tick inactive: pane w1:p1 (agent "fleet") owns the fleet tick here — this session will not tick',
  ]);
});

test("under herdr, the expected agent name comes from the activation config", () => {
  writeTickConfig({ intervalSeconds: 600, agentName: "veltro-fleet" });
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "w1:p1";
  process.env["HERDR_BIN_PATH"] = fakeHerdrBin(agentListJson([{ pane: "w1:p1", name: "veltro-fleet" }]));
  const pi = fakeHost();

  orchestratorTickExtension(pi);
  pi.start();

  expect(pi.intervals).toHaveLength(1);
});

test("a `herdr agent list` that exits non-zero withholds the heartbeat but keeps asking", () => {
  writeTickConfig({ intervalSeconds: 600 });
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "w1:p1";
  process.env["HERDR_BIN_PATH"] = fakeHerdrBin('{"error":"no such session"}', 2);
  const pi = fakeHost();

  orchestratorTickExtension(pi);
  pi.start();

  // One interval, and it is the ownership retry — not the heartbeat. An
  // unproven identity still must not tick.
  expect(pi.intervals).toHaveLength(1);
  expect(pi.logs.join("\n")).toContain("cannot yet prove this pane is the fleet agent");
  expect(pi.logs.join("\n")).toContain("tick pending");
  expect(pi.logs.join("\n")).not.toContain("tick active");
});

test("a herdr blip costs a retry, not the fleet: the heartbeat arms once it answers", () => {
  // The regression this exists for. Ownership used to latch on any failure, so a
  // single 3-second CLI timeout at session start disabled the real orchestrator
  // until a human noticed and restarted the pane — silent, and indistinguishable
  // from a fleet that was never meant to tick.
  writeTickConfig({ intervalSeconds: 600 });
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "w1:p1";
  process.env["HERDR_BIN_PATH"] = fakeHerdrBin('{"error":"socket refused"}', 2);
  const pi = fakeHost();

  orchestratorTickExtension(pi);
  pi.start();
  expect(pi.intervals).toHaveLength(1); // the retry only

  // herdr comes back, and this pane is the fleet.
  process.env["HERDR_BIN_PATH"] = fakeHerdrBin(agentListJson([{ pane: "w1:p1", name: "fleet" }]));
  pi.intervals[0]?.callback();

  expect(pi.intervals).toHaveLength(2); // heartbeat armed
  expect(pi.logs.join("\n")).toContain("ownership resolved on retry");

  // And the retry disarms itself rather than arming a second heartbeat: the
  // harness owns timer lifecycle, so this is a flag, not a clearInterval.
  pi.intervals[0]?.callback();
  expect(pi.intervals).toHaveLength(2);
});

test("a retry that proves this pane is NOT the fleet latches, and never arms", () => {
  writeTickConfig({ intervalSeconds: 600 });
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "w1:p5";
  process.env["HERDR_BIN_PATH"] = fakeHerdrBin('{"error":"socket refused"}', 2);
  const pi = fakeHost();

  orchestratorTickExtension(pi);
  pi.start();

  process.env["HERDR_BIN_PATH"] = fakeHerdrBin(agentListJson([{ pane: "w1:p1", name: "fleet" }]));
  pi.intervals[0]?.callback();

  expect(pi.intervals).toHaveLength(1); // still just the retry; no heartbeat
  expect(pi.logs.join("\n")).toContain("owns the fleet tick here");

  // Definitive, so it stops asking — a rival must not keep re-testing its luck.
  const before = pi.logs.length;
  pi.intervals[0]?.callback();
  expect(pi.logs).toHaveLength(before);
});

test("with no herdr at all, a lone session behaves exactly as it did — and records its claim", () => {
  writeTickConfig({ intervalSeconds: 600 });
  const pi = fakeHost({ sessionFile: "/tmp/lone.jsonl" });

  orchestratorTickExtension(pi);
  pi.start();

  expect(pi.intervals).toHaveLength(1);
  const claim = JSON.parse(readFileSync(join(cwd, TICK_OWNER_FILE), "utf8"));
  expect(claim.pid).toBe(process.pid);
  expect(claim.sessionFile).toBe("/tmp/lone.jsonl");
});

test("readTickConfig carries agentName through, and rejects an empty one", () => {
  writeTickConfig({ intervalSeconds: 600, agentName: " fleet " });
  const ok = readTickConfig(cwd);
  expect(ok.kind === "ok" && ok.config.agentName).toBe("fleet");

  writeTickConfig({ intervalSeconds: 600, agentName: "" });
  const bad = readTickConfig(cwd);
  expect(bad.kind === "invalid" && bad.problem).toContain("agentName");
});
