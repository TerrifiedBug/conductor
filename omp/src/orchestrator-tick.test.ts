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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPaused } from "./daemon.ts";
import orchestratorTickExtension, {
  MIN_INTERVAL_SECONDS,
  readTickConfig,
  TICK_CONFIG_FILE,
  TICK_CUSTOM_TYPE,
  defaultTickMessage,
  tickDecision,
} from "./orchestrator-tick.ts";

const HOME_KEY = "OMP_CONDUCTOR_HOME";

let cwd = "";
let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env[HOME_KEY];
  cwd = mkdtempSync(join(tmpdir(), "omp-conductor-tick-cwd-"));
  home = mkdtempSync(join(tmpdir(), "omp-conductor-tick-home-"));
  process.env[HOME_KEY] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env[HOME_KEY];
  else process.env[HOME_KEY] = previousHome;
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
 */
function fakeHost(options: { pending?: boolean } = {}) {
  const logs: string[] = [];
  const notices: { message: string; type?: string }[] = [];
  const sent: SentMessage[] = [];
  const intervals: { ms?: number; callback: () => void }[] = [];
  const state = { pending: options.pending ?? false };

  const ctx = {
    cwd,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notices.push({ message, type });
      },
    },
    hasPendingMessages: () => state.pending,
    setInterval(callback: () => void, ms?: number): unknown {
      intervals.push({ callback, ms });
      return { id: intervals.length };
    },
  };

  let handler: ((event: { type: "session_start" }, ctx: typeof pi.ctx) => void) | undefined;

  const pi = {
    logger: {
      info: (message: string) => logs.push(message),
      error: (message: string) => logs.push(message),
    },
    on(_event: "session_start", h: (event: { type: "session_start" }, c: typeof ctx) => void) {
      handler = h as typeof handler;
    },
    sendMessage(message: SentMessage["message"], opts: SentMessage["options"]) {
      sent.push({ message, options: opts });
    },
    ctx,
    logs,
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
const READY = { paused: false, armed: true, channelOk: true, hasPending: false };

test("tickDecision sends when armed, unpaused, channel up and nothing queued", () => {
  expect(tickDecision(READY)).toEqual({ send: true, reason: "armed, nothing pending" });
});

test("tickDecision skips while paused, and pause outranks every other fact", () => {
  expect(tickDecision({ ...READY, paused: true })).toEqual({ send: false, reason: "paused" });
  expect(tickDecision({ paused: true, armed: false, channelOk: false, hasPending: true })).toEqual({
    send: false,
    reason: "paused",
  });
});

test("tickDecision skips when the arm gate is unsatisfied, ahead of the channel and queue", () => {
  expect(tickDecision({ ...READY, armed: false })).toEqual({ send: false, reason: "not armed" });
  expect(tickDecision({ paused: false, armed: false, channelOk: false, hasPending: true })).toEqual({
    send: false,
    reason: "not armed",
  });
});

test("tickDecision skips when the escalation channel is down, ahead of the queue check", () => {
  expect(tickDecision({ ...READY, channelOk: false })).toEqual({
    send: false,
    reason: "escalation channel down",
  });
  expect(tickDecision({ paused: false, armed: true, channelOk: false, hasPending: true })).toEqual({
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

test("a configured message is sent verbatim in place of the default", () => {
  writeTickConfig({ intervalSeconds: 600, message: "loop now" });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();
  pi.fire();

  expect(pi.sent[0]?.message.content).toBe("loop now");
});

test("the default message carries the tick timestamp", () => {
  const at = new Date("2026-08-06T12:00:00.000Z");
  expect(defaultTickMessage(at)).toBe(
    "Tick 2026-08-06T12:00:00.000Z: run your standing loop from ORCHESTRATOR.md now. Report only material events.",
  );
});

test("a tick sends nothing while /conductor pause holds the flag", () => {
  writeTickConfig({ intervalSeconds: 600 });
  const pi = fakeHost();
  orchestratorTickExtension(pi);
  pi.start();

  setPaused(true);
  pi.fire();
  expect(pi.sent).toHaveLength(0);
  expect(pi.logs.join("\n")).toContain("paused");

  setPaused(false);
  pi.fire();
  expect(pi.sent).toHaveLength(1);
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
