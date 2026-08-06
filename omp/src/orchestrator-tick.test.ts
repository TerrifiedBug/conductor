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
import { configPath, stateDir } from "./config.ts";
import { setPaused } from "./daemon.ts";
import orchestratorTickExtension, {
  MIN_INTERVAL_SECONDS,
  readTickConfig,
  TICK_CONFIG_FILE,
  TICK_CUSTOM_TYPE,
  TICK_DELIVERY_RULE,
  TICK_SCOPE_CONSTRAINTS,
  defaultTickMessage,
  tickDecision,
} from "./orchestrator-tick.ts";
import type { ReportScope } from "./types.ts";

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
 *
 * `hasUI`/`activeTools` describe the session shape the extension is loaded
 * into. The defaults are an interactive root session with no `yield` — the
 * operator sitting at the orchestrator terminal — so every pre-existing test
 * keeps describing the case it was written for.
 */
function fakeHost(options: { pending?: boolean; hasUI?: boolean; activeTools?: string[] } = {}) {
  const logs: string[] = [];
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
    getActiveTools: () => options.activeTools ?? [],
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

test("the default message carries the tick timestamp", () => {
  const at = new Date("2026-08-06T12:00:00.000Z");
  // No reporting clause of its own: the scope line below owns that contract, and
  // two spellings of it would contradict each other inside one prompt.
  expect(defaultTickMessage(at)).toBe(
    "Tick 2026-08-06T12:00:00.000Z: run your standing loop from ORCHESTRATOR.md now.",
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
