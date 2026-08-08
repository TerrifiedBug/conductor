#!/usr/bin/env bun
/**
 * Standalone entry point. Everything here is argument handling and printing —
 * the loop, the caps and the state all live in ./daemon.ts and the background
 * process lifecycle in ./lifecycle.ts, so the CLI and the `/conductor` plugin
 * cannot drift apart.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applyRetrofit,
  checkBrief,
  formatBriefStatus,
  formatMigrateResult,
  formatRetrofitProposal,
  formatRetrofitRefusal,
  inspectBriefLayout,
  migrateToPolicy,
  proposeRetrofit,
  repairPolicyBannerCrumbs,
  writeMergedBrief,
} from "./brief-upgrade.ts";
import { findProject, loadConfig, resolveCaps, stateDir } from "./config.ts";
import { dbPath, runDaemon, setPaused } from "./daemon.ts";
import {
  armTicks,
  clearPaneHalt,
  disarmTicks,
  halt,
  haltWithPane,
  hold,
  releaseHold,
  renderStatus,
  startHerdrFleet,
} from "./fleet.ts";
import { formatGraphSetup, graphRepos, writeGraphSetup, type GraphSetupWrite } from "./graph.ts";
import {
  clearRecord,
  DEFAULT_PORT,
  livingDaemon,
  restartDaemon,
  startDaemon,
  stopDaemon,
  writeRecord,
} from "./lifecycle.ts";
import { STALL_MARKER_FILE } from "./orchestrator-tick.ts";
import {
  briefPathForProject,
  policyPathForProject,
  renderBriefForProject,
  renderFloorForProject,
  shippedBriefTemplate,
} from "./setup.ts";
import { LIVE_STATES, openStore } from "./store.ts";
import { makeTracker } from "./tracker/github.ts";
import type { ProjectConfig } from "./types.ts";
import { formatUnblock, unblockIssue } from "./unblock.ts";

function packageVersion(): string {
  const parsed = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("installed package.json has no version");
  }
  return parsed.version;
}

const USAGE = `omp-conductor — dispatch ready issues to omp coding sessions

usage:
  omp-conductor start [--port N] [--project NAME]
  omp-conductor --version
  omp-conductor stop
  omp-conductor restart [--port N] [--project NAME]
  omp-conductor status [--project NAME]
  omp-conductor hold [--project NAME]
  omp-conductor halt [--pane] [--project NAME]
  omp-conductor arm [--project NAME]
  omp-conductor disarm [--project NAME]
  omp-conductor release-pane [--project NAME]
  omp-conductor tail <issue> [--project NAME]
  omp-conductor extend <issue> --turns N [--project NAME]
  omp-conductor unblock <issue> [--project NAME]
  omp-conductor daemon [--once] [--port N] [--project NAME]
  omp-conductor pause
  omp-conductor resume
  omp-conductor graph-setup [--project NAME] [--write]
  omp-conductor brief-upgrade [--migrate|--retrofit] [--apply] [--file PATH] [--project NAME]
  omp-conductor help

  start    start the installed herdr-fleet.service when present, then run the
           dispatch loop in the background and wait until it answers GET
           /healthz on :8787 (override with --port). Refuses if one is running.
  stop     stop the running daemon. Uses systemctl when the omp-conductor
           unit owns the process (so Restart=on-failure cannot bring it back);
           otherwise SIGTERM then SIGKILL.
  restart  stop then start, keeping the running daemon's port and project
           unless a flag overrides them. On boot the new process salvages any
           dirty live worktrees before orphaning those rows — see README
           "Deploying a new package onto a busy fleet". Goes through systemctl
           when the unit owns the live pid.
  status   layered fleet report: dispatch (running|paused|stopped), ticks and
           next due time, pane, herdr, Telegram bot/API health, daemon, caps
           and active runs.
  hold     soft stop: pause claiming AND disarm ticks. Daemon and pane stay up.
           This is "stop the conductor overnight" without killing processes.
  halt     hold, then stop the dispatch daemon (systemctl-aware). Pane stays up
           unless --pane is passed.
  halt --pane
           halt, then pin herdr-conductor recovery off for the conductor agent
           only — does NOT stop herdr-fleet.service or any other herdr session.
           Clear the pin with release-pane when you want recovery again.
  arm      proof-gated: send a Telegram challenge and write the arm marker only
           after your reply appears as a user turn in the orchestrator transcript.
           Never auto-armed by resume/hold.
  disarm   remove the arm marker so ticks skip. Processes untouched.
  release-pane
           clear the halt --pane recovery pin so herdr-conductor may resume again.
  tail     follow the newest run for <issue>: the worker's assistant text and
           the tools it calls, printed as they land. Workers are sessions inside
           the daemon rather than terminals, so this is the only way to watch
           one live. Runs until Ctrl-C, or until the run has finished and its
           transcript has stopped growing.
  extend   monotonically raise a live run's turn ceiling without restarting its
           session. Refuses settled runs and values at or below its current cap.
  unblock  clear <issue>'s blocked and failed labels so the next tick can claim
           it again — the supported way back for an escalation you answered,
           and why the brief's "never hand-edit a state label" rule can stay
           absolute. Run history is kept; answered blocks consume the separate
           operational-continuation budget, not failed implementation attempts.
  daemon   run the dispatch loop in the foreground; --once runs a single tick
           and exits. This is what \`start\` launches.
  pause    stop claiming new work only (ticks keep firing if armed). Prefer hold.
  resume   clear pause only — does NOT re-arm. Prefer hold's inverse: resume + arm.
  graph-setup
           print how to set up the code-graph indexes workers query instead of
           grepping: the clone commands for any missing index-only clone, the
           index command per repo, and a systemd service+timer that keeps them
           current. --write writes the two units and the script they run, and
           prints the systemctl line to run — it never runs systemctl itself.
           Exits 1 when no repo in the project has graphProject configured.
  brief-upgrade
           inspect the brief overlay (package floor + POLICY.md). Reports by
           default. --migrate lifts a bannered ORCHESTRATOR.md owned half into
           POLICY.md and recomposes. --retrofit proposes inserting the YOURS TO
           EDIT banner before the first Releases/Project context/Reporting/
           Amendments heading (#20); --retrofit --apply writes it. Legacy
           --apply still merges a bannered single-file brief. --file checks a
           brief that is not where the wizard would have put it.
  help     print this text (also --help, -h).
  --version
           print the installed omp-conductor package version (also -V, version).

Pause is a flag file under the state directory, so it applies to every project
and survives a daemon restart. Hold also removes the arm marker the heartbeat
reads, so both brains go quiet without killing processes. A running daemon is
tracked by a pidfile under $OMP_CONDUCTOR_RUNTIME_DIR (default
~/.omp/run/daemons/omp-conductor), written whether it was started in the
background or in the foreground, and probed for liveness on every read — a
stale one never blocks a start.

Stop the conductor:
  hold              no claims, no tick sends (inspectable)
  halt              hold + stop dispatch daemon
  halt --pane       halt + pin conductor-pane recovery off
  resume && arm     clear pause, then prove inbound Telegram before ticks resume`;

/** Accepts both `--port 9000` and `--port=9000`; returns undefined when absent. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const prefixed = argv.find((a) => a.startsWith(`--${name}=`));
  return prefixed?.slice(name.length + 3);
}

/**
 * `--port` for the three verbs that take one. Exits 2 rather than defaulting,
 * because silently ignoring a typo'd port would leave the operator probing an
 * endpoint the daemon is not on.
 */
function portFlag(argv: string[]): number | undefined {
  const raw = flag(argv, "port");
  const port = raw === undefined ? undefined : Number.parseInt(raw, 10);
  const valueless = raw === undefined && argv.includes("--port");
  if (valueless || (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))) {
    process.stderr.write(`omp-conductor: --port needs a port number, got "${raw ?? ""}"\n`);
    process.exit(2);
  }
  return port;
}

/** Required positive integer for `extend`; no partial parses such as `180x`. */
function turnsFlag(argv: string[]): number {
  const raw = flag(argv, "turns");
  const turns = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(turns) || turns < 1) {
    process.stderr.write(`omp-conductor: extend needs --turns with a positive integer, got "${raw ?? ""}"\n`);
    process.exit(2);
  }
  return turns;
}

function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, "0")}h`;
}


/**
 * The orchestrator half, and the one thing `status` has ever known about the
 * supervising session: the stall marker its heartbeat writes when its own
 * prompts stop being consumed (see {@link STALL_MARKER_FILE}).
 *
 * The marker is written in the *session's* cwd, which this process has no way
 * to discover — so this reads the state directory, on the reference deploy's
 * convention that the orchestrator session runs from exactly there. That makes
 * the reading one-directional: a line printed here is proof of a wedge, and no
 * line is proof of nothing at all. On a fleet whose session lives elsewhere the
 * check is simply inert, which is why it never prints a reassuring "healthy".
 */
function stallLine(): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(stateDir(), STALL_MARKER_FILE), "utf8").trim();
  } catch {
    return undefined;
  }
  // "<ISO timestamp> <one-line diagnosis>". A file truncated by something else
  // still gets reported: that the marker exists at all is the news.
  const cut = raw.indexOf(" ");
  const since = cut < 0 ? raw : raw.slice(0, cut);
  const diagnosis = cut < 0 ? "" : ` — ${raw.slice(cut + 1)}`;
  return `orchestrator   STALLED since ${since === "" ? "an unrecorded time" : since}${diagnosis}`;
}

/**
 * `DaemonRecord.logFile` for a daemon nobody spawned. The field is required and
 * `status` prints it, so it has to say something true: a foreground daemon
 * opened no log of its own — whoever started it owns its stdout, be that
 * systemd's journal, a terminal, or a pane.
 */
const FOREGROUND_LOG = "<inherited stdout — started in the foreground>";

/** How often `tail` re-stats the transcript it is following. */
const TAIL_POLL_MS = 1_000;

/**
 * How long the transcript must stay unchanged, after its run has left the live
 * states, before `tail` calls it over. The state flips from the daemon's thread
 * while the harness may still be flushing its last message, so exiting on the
 * state alone truncates the ending an operator ran this command to watch.
 */
const TAIL_QUIET_MS = 5_000;

/**
 * The `<issue>` positional, for the two verbs that take one. Exits 2 rather
 * than following run #NaN or clearing the labels of issue #0; `verb` is named
 * in the message so the operator is told which of the two they mistyped.
 */
function issueArg(verb: string, raw: string | undefined): number {
  const issue = raw === undefined ? Number.NaN : Number.parseInt(raw.replace(/^#/, ""), 10);
  if (!Number.isInteger(issue) || issue < 1) {
    process.stderr.write(`omp-conductor: ${verb} needs an issue number, got "${raw ?? ""}"\n`);
    process.exit(2);
  }
  return issue;
}

/** Read one property off an unvalidated transcript entry. */
function prop(source: unknown, key: string): unknown {
  if (source === null || typeof source !== "object") return undefined;
  return Reflect.get(source, key);
}

/**
 * One transcript line rendered for somebody watching, or `undefined` for the
 * lines not worth a row: thinking blocks, tool results, session metadata, and
 * anything this parser does not recognise.
 *
 * Defensive throughout. The transcript is written by the harness, not by this
 * package, so its shape is a peer dependency's business and can gain entry
 * types without warning. A `tail` that dies on one unfamiliar line is strictly
 * worse than one that skips it — the operator is watching a run they have no
 * other window onto.
 */
function formatTranscriptLine(line: string): string | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (prop(entry, "type") !== "message") return undefined;
  const message = prop(entry, "message");
  if (prop(message, "role") !== "assistant") return undefined;

  const content = prop(message, "content");
  // The harness writes an array of blocks; a bare string is the degenerate form
  // some sessions still produce, and dropping it would silently lose the text.
  if (typeof content === "string") {
    return content.trim() === "" ? undefined : `assistant: ${content.trim()}`;
  }

  const blocks: readonly unknown[] = Array.isArray(content) ? content : [];
  const out: string[] = [];
  for (const block of blocks) {
    const type = prop(block, "type");
    if (type === "text") {
      const text = prop(block, "text");
      if (typeof text === "string" && text.trim() !== "") out.push(`assistant: ${text.trim()}`);
    } else if (type === "toolCall") {
      const name = prop(block, "name");
      if (typeof name === "string" && name !== "") out.push(`tool: ${name}`);
    }
  }
  return out.length === 0 ? undefined : out.join("\n");
}

/**
 * Follow one run's transcript the way `tail -f` follows a log.
 *
 * Reads from byte zero rather than from the end: attaching to a worker that is
 * already ten turns in and then showing nothing until turn eleven is not
 * watching the run. Polls `stat` instead of taking a file watcher because the
 * transcript is a plain append-only file that may sit on a filesystem where
 * change events are a polite fiction, and one stat a second costs nothing.
 *
 * SIGINT is deliberately left to its default, which is immediate exit. Nothing
 * here is buffered, and a handler could only add a poll interval of latency to
 * every Ctrl-C.
 */
async function tailRun(project: string, issue: number): Promise<void> {
  // Read-only in practice: the store is opened WAL with a busy timeout, so this
  // never contends with the daemon writing the same rows.
  const store = openStore(dbPath());
  try {
    const run = store.latestRun(project, issue);
    if (run === undefined) throw new Error(`no run recorded for #${issue}`);
    const path = run.sessionFile;
    // Claimed but not yet started, or an attempt whose session never opened one.
    if (path === undefined) throw new Error(`no transcript yet (state: ${run.state})`);

    const fd = openSync(path, "r");
    try {
      let offset = 0;
      let pending = Buffer.alloc(0);
      let lastChange = Date.now();

      for (;;) {
        let size = offset;
        try {
          size = statSync(path).size;
        } catch {
          // A transcript that vanishes mid-follow is not worth crashing over.
          // The run's own state, below, is what decides when this command ends.
        }
        // Shorter than what we have already read means truncated or replaced;
        // resuming from the old offset would read the middle of another file.
        if (size < offset) {
          offset = 0;
          pending = Buffer.alloc(0);
        }
        if (size > offset) {
          const chunk = Buffer.allocUnsafe(size - offset);
          const read = readSync(fd, chunk, 0, chunk.length, offset);
          offset += read;
          // Split on newlines as bytes, not as text: a UTF-8 sequence straddling
          // a read boundary would be mangled by decoding each chunk on its own.
          pending = Buffer.concat([pending, chunk.subarray(0, read)]);
          for (;;) {
            const nl = pending.indexOf(0x0a);
            if (nl < 0) break;
            const rendered = formatTranscriptLine(pending.subarray(0, nl).toString("utf8"));
            pending = pending.subarray(nl + 1);
            if (rendered !== undefined) process.stdout.write(`${rendered}\n`);
          }
          if (read > 0) lastChange = Date.now();
        }

        // Re-read this exact run every poll — not `latestRun`, which would jump
        // to a retry started meanwhile and report its state against the wrong
        // transcript. The daemon writes the row from another process, so looking
        // is the only way to notice the run finished.
        const state = store.getRun(run.id)?.state ?? run.state;
        if (!LIVE_STATES.includes(state) && Date.now() - lastChange >= TAIL_QUIET_MS) {
          process.stdout.write(`run ended: ${state}\n`);
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, TAIL_POLL_MS));
      }
    } finally {
      closeSync(fd);
    }
  } finally {
    store.close();
  }
}

const argv = process.argv.slice(2);
const cmd = argv[0];

try {
  switch (cmd) {
    case "--version":
    case "-V":
    case "version":
      process.stdout.write(`${packageVersion()}\n`);
      break;
    case "daemon": {
      // Until now only `lifecycle.startDaemon()` — the spawn path — wrote the
      // pidfile, which left a daemon started in the foreground (which is how
      // systemd runs it) invisible twice over: `omp-conductor status` reported
      // no daemon at all, and a `daemon --once` drill run beside it saw
      // `livingDaemon() === undefined`, concluded nothing else was dispatching,
      // and reconciled the live daemon's in-flight runs as orphans. Writing the
      // record here closes both holes.
      const once = argv.includes("--once");
      const port = portFlag(argv);
      const project = flag(argv, "project");

      // `--once` registers nothing, on purpose. It is precisely the single-tick
      // drill the orphan guard exists to protect, so a drill that announced
      // itself as the daemon would be the process that misleads the next reader
      // — and would clear the real daemon's record on its way out.
      if (once) {
        await runDaemon({ once, port, project });
        break;
      }

      const running = livingDaemon();
      if (running !== undefined && running.pid !== process.pid) {
        process.stderr.write(`omp-conductor: another daemon is alive (pid ${running.pid}); stop it first\n`);
        process.exit(1);
      }

      // A living record that already names this pid was written by the `start`
      // that spawned us, and it knows the log file our stdout is really going
      // to. Replacing it with a guess would be a downgrade.
      if (running === undefined) {
        writeRecord({
          pid: process.pid,
          port: port ?? DEFAULT_PORT,
          startedAt: Date.now(),
          logFile: FOREGROUND_LOG,
          ...(project === undefined ? {} : { project }),
        });
      }

      try {
        await runDaemon({ once, port, project });
      } finally {
        // The record names a pid that is about to stop existing. Leaving it
        // behind makes the next reader probe a ghost before believing us.
        clearRecord();
      }
      break;
    }

    case "start": {
      const project = flag(argv, "project");
      const herdr = startHerdrFleet(project);
      const rec = await startDaemon({ port: portFlag(argv), project });
      process.stdout.write(
        `started — pid ${rec.pid}, /healthz on :${rec.port}` +
          `${rec.project === undefined ? "" : `, project ${rec.project}`}\n` +
          `herdr ${herdr.kind === "active" ? `active (${herdr.unit})${herdr.recoveryReleased ? "; recovery pin cleared" : ""}` : `unmanaged (${herdr.reason})`}\n` +
          `log ${rec.logFile}\n`,
      );
      break;
    }

    case "stop": {
      const result = await stopDaemon();
      if (result.kind === "not-running") {
        process.stdout.write("not running\n");
      } else {
        process.stdout.write(
          `stopped — pid ${result.pid}${result.via === "systemctl" ? " (via systemctl)" : ""}\n`,
        );
      }
      break;
    }

    case "restart": {
      // Inherit the running daemon's port and project: a restart that quietly
      // moved to the default port would leave every existing health check
      // pointing at nothing. When the unit owns the live pid, restartDaemon
      // goes through systemctl so the replacement stays supervised.
      const { previous, record, via } = await restartDaemon({
        port: portFlag(argv),
        project: flag(argv, "project"),
      });
      if (previous !== undefined) {
        process.stdout.write(
          `stopped — pid ${previous.pid}${via === "systemctl" ? " (via systemctl)" : ""}\n`,
        );
      }
      process.stdout.write(
        `started — pid ${record.pid}, /healthz on :${record.port}` +
          `${record.project === undefined ? "" : `, project ${record.project}`}` +
          `${via === "systemctl" ? " (via systemctl)" : ""}\nlog ${record.logFile}\n`,
      );
      break;
    }

    case "status": {
      const project = flag(argv, "project");
      const text = await renderStatus(project);
      const stalled = stallLine();
      process.stdout.write(`${text}${stalled === undefined ? "\n" : `\n\n${stalled}\n`}`);
      break;
    }

    case "hold": {
      const r = hold(flag(argv, "project"));
      process.stdout.write(
        `held — claiming paused` +
          `${r.wasPaused ? " (already paused)" : ""}` +
          `; ticks disarmed at ${r.disarmed.path}` +
          `${r.disarmed.wasArmed ? "" : " (was already disarmed)"}\n` +
          `daemon and pane left running; halt to stop the daemon\n`,
      );
      break;
    }

    case "halt": {
      const project = flag(argv, "project");
      const withPane = argv.includes("--pane");
      if (withPane) {
        const r = await haltWithPane(project);
        const stopLine =
          r.stop.kind === "not-running"
            ? "daemon was not running"
            : `daemon stopped — pid ${r.stop.pid}${r.stop.via === "systemctl" ? " (via systemctl)" : ""}`;
        process.stdout.write(
          `halted — claiming paused; ticks disarmed at ${r.hold.disarmed.path}\n` +
            `${stopLine}\n` +
            `pane recovery pinned at ${r.pane.pinPath}\n` +
            `pane stop: ${r.pane.stopped} — ${r.pane.detail}\n` +
            `  (conductor agent "${r.pane.agentName}" only — herdr-fleet.service was NOT stopped;\n` +
            `   release-pane clears the pin when you want recovery again)\n`,
        );
      } else {
        const r = await halt(project);
        const stopLine =
          r.stop.kind === "not-running"
            ? "daemon was not running"
            : `daemon stopped — pid ${r.stop.pid}${r.stop.via === "systemctl" ? " (via systemctl)" : ""}`;
        process.stdout.write(
          `halted — claiming paused; ticks disarmed at ${r.hold.disarmed.path}\n` +
            `${stopLine}\n` +
            `pane left running (pass --pane to stop the conductor agent and pin recovery)\n`,
        );
      }
      break;
    }

    case "arm": {
      process.stdout.write("arm: sending inbound Telegram challenge…\n");
      const r = await armTicks(flag(argv, "project"));
      process.stdout.write(
        `ARMED — inbound round-trip proved with owner ${r.owner}; ticks are now live.\n` +
          `marker ${r.path}${r.alreadyArmed ? " (replaced previous marker)" : ""}\n`,
      );
      break;
    }

    case "disarm": {
      const r = disarmTicks(flag(argv, "project"));
      process.stdout.write(
        `disarmed — ticks will be skipped` +
          `${r.wasArmed ? "" : " (was already disarmed)"}\n` +
          `marker ${r.path}\n`,
      );
      break;
    }

    case "release-pane": {
      const r = clearPaneHalt(flag(argv, "project"));
      process.stdout.write(
        r.wasHalted
          ? `pane recovery pin cleared — ${r.path}\nherdr-conductor may resume the fleet agent again\n`
          : `no pane recovery pin at ${r.path}\n`,
      );
      break;
    }

    case "tail": {
      const issue = issueArg("tail", argv[1]);
      await tailRun(findProject(loadConfig(), flag(argv, "project")).name, issue);
      break;
    }

    case "extend": {
      const issue = issueArg("extend", argv[1]);
      const maxTurns = turnsFlag(argv);
      const project = findProject(loadConfig(), flag(argv, "project"));
      const daemon = livingDaemon();
      if (daemon === undefined) throw new Error("daemon is not running");
      if (daemon.project !== undefined && daemon.project !== project.name) {
        throw new Error(
          `daemon serves project "${daemon.project}", not requested project "${project.name}"`,
        );
      }
      const response = await fetch(
        `http://127.0.0.1:${daemon.port}/runs/${issue}/turn-limit`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: project.name, maxTurns }),
        },
      );
      const payload = (await response.json()) as {
        error?: unknown;
        runId?: unknown;
        maxTurns?: unknown;
      };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : `daemon returned HTTP ${response.status}`,
        );
      }
      if (typeof payload.runId !== "string" || typeof payload.maxTurns !== "number") {
        throw new Error("daemon returned an invalid turn-extension response");
      }
      process.stdout.write(
        `#${issue} turn ceiling extended to ${payload.maxTurns} (run ${payload.runId})\n`,
      );
      break;
    }

    case "unblock": {
      const issue = issueArg("unblock", argv[1]);
      const cfg = loadConfig();
      const project = findProject(cfg, flag(argv, "project"));
      const store = openStore(dbPath());
      try {
        const outcome = await unblockIssue(project, makeTracker(project), store, issue);
        process.stdout.write(`${formatUnblock(issue, outcome, project, resolveCaps(project, cfg.defaults))}\n`);
      } finally {
        store.close();
      }
      break;
    }

    case "pause":
      setPaused(true);
      process.stdout.write(
        "paused — no new work will be claimed\n" +
          "note: ticks keep firing if armed; use hold to silence both\n",
      );
      break;

    case "resume":
      releaseHold();
      process.stdout.write(
        "resumed — claiming allowed on the next tick\n" +
          "note: did NOT re-arm; run arm after an inbound Telegram proof to resume ticks\n",
      );
      break;

    case "graph-setup": {
      // Refused rather than accommodated. Under sudo every path this command
      // derives — the config it loads, the state directory it writes to, the
      // HOME and User= it bakes into the unit — resolves as root instead of the
      // fleet's account, and the result is a timer that goes green while
      // building indexes in a store no worker session ever reads. Nothing about
      // that announces itself, so the only safe answer is to stop.
      if (process.env["SUDO_USER"] !== undefined) {
        process.stderr.write(
          "omp-conductor: run graph-setup as the account the fleet runs as, not under sudo.\n" +
            `Under sudo the config, ~/.cache and the unit's User= all resolve as root, and the\n` +
            `indexes land where no worker can read them. Only installing the units needs root,\n` +
            "and this command prints those two lines for you at the end.\n",
        );
        process.exit(1);
      }

      const project = findProject(loadConfig(), flag(argv, "project"));
      if (graphRepos(project).length === 0) {
        // Not a warning: with nothing configured there is nothing to print, and
        // the fix is a wizard answer rather than a flag on this command.
        process.stderr.write(
          `omp-conductor: no repo in project "${project.name}" has graphProject set — re-run\n` +
            "/conductor setup and say yes to code-graph discovery.\n",
        );
        process.exit(1);
      }

      if (!argv.includes("--write")) {
        process.stdout.write(`${formatGraphSetup(project)}\n`);
        break;
      }

      let result: GraphSetupWrite;
      try {
        result = writeGraphSetup(project);
      } catch (err) {
        // No longer the permissions case — all three files go to this account's
        // own state directory — so this is a full disk, a read-only mount or a
        // state directory someone else owns. Say what failed and offer the
        // printed plan, which is a complete substitute for the write.
        process.stderr.write(
          `omp-conductor: could not stage the files (${err instanceof Error ? err.message : String(err)}).\n` +
            "Drop --write and copy the printed text yourself — it is the same content.\n",
        );
        process.exit(1);
      }
      process.stdout.write(`wrote:\n${result.written.map((f) => `  ${f}`).join("\n")}\n\n${result.next}\n`);
      break;
    }

    case "brief-upgrade": {
      const override = flag(argv, "file");
      let project: ProjectConfig | undefined;
      let path: string;
      if (override === undefined) {
        project = findProject(loadConfig(), flag(argv, "project"));
        path = briefPathForProject(project);
      } else {
        path = override;
        try {
          project = findProject(loadConfig(), flag(argv, "project"));
        } catch {
          project = undefined;
        }
      }

      const workspaceRoot = project?.workspaceRoot ?? dirname(path);
      const rendered =
        project === undefined ? shippedBriefTemplate() : renderBriefForProject(project);
      const floor = project === undefined ? shippedBriefTemplate() : renderFloorForProject(project);
      const layout = inspectBriefLayout(workspaceRoot, rendered);

      if (argv.includes("--retrofit")) {
        let live: string;
        try {
          live = readFileSync(path, "utf8");
        } catch {
          process.stderr.write(`omp-conductor: no brief at ${path}.\n`);
          process.exit(1);
        }
        const result = proposeRetrofit(live);
        if (result.kind === "no-cut") {
          process.stdout.write(
            `brief ${path}\n\nNo Releases / Project context / Reporting / Amendments heading found — cannot classify a cut.\n`,
          );
          process.exit(1);
        }
        if (result.kind === "interleaved") {
          process.stdout.write(`${formatRetrofitRefusal(path, result)}\n`);
          process.exit(1);
        }
        process.stdout.write(`${formatRetrofitProposal(path, result.proposal)}\n`);
        if (argv.includes("--apply")) {
          const backup = applyRetrofit(path, result.proposal);
          process.stdout.write(`\napplied retrofit — previous brief kept at ${backup}\n`);
        }
        break;
      }

      if (argv.includes("--migrate")) {
        if (layout.kind === "overlay") {
          if (!argv.includes("--apply")) {
            process.stdout.write(
              `${formatBriefStatus(path, layout)}\n\n` +
                "POLICY.md already present. --migrate --apply will strip any leading\n" +
                "banner-comment crumbs from POLICY.md and recompose ORCHESTRATOR.md.\n",
            );
            break;
          }
          if (project === undefined) {
            process.stderr.write(
              "omp-conductor: repairing an overlay needs --project (or a config) so the floor renders.\n",
            );
            process.exit(1);
          }
          const repaired = repairPolicyBannerCrumbs({
            orchestratorPath: layout.orchestratorPath,
            policyPath: layout.policyPath,
            floor: renderFloorForProject(project),
          });
          if (repaired === undefined) {
            process.stdout.write(
              `${formatBriefStatus(path, layout)}\n\nrecomposed ORCHESTRATOR.md — POLICY.md needed no crumb strip.\n`,
            );
          } else {
            process.stdout.write(`${formatMigrateResult(repaired)}\n`);
          }
          break;
        }
        if (layout.kind === "missing") {
          process.stderr.write(`omp-conductor: no brief at ${path} to migrate.\n`);
          process.exit(1);
        }
        if (layout.kind === "legacy-handwritten") {
          process.stdout.write(
            `${formatBriefStatus(path, { kind: "unsplittable", missing: layout.missing })}\n`,
          );
          process.exit(1);
        }
        if (project === undefined && /\{\{[A-Za-z0-9_]+\}\}/.test(floor)) {
          process.stderr.write(
            "omp-conductor: --migrate needs --project (or a config) so the floor renders without {{PLACEHOLDER}}s.\n",
          );
          process.exit(1);
        }
        if (!argv.includes("--apply")) {
          process.stdout.write(
            [
              `migrate ${layout.orchestratorPath}`,
              "",
              "Would write POLICY.md from the owned half below YOURS TO EDIT,",
              "then recompose ORCHESTRATOR.md from the package floor + that policy.",
              "",
              "Apply:  omp-conductor brief-upgrade --migrate --apply",
            ].join("\n") + "\n",
          );
          break;
        }
        const policyPath = project ? policyPathForProject(project) : join(workspaceRoot, "POLICY.md");
        const result = migrateToPolicy({
          orchestratorPath: layout.orchestratorPath,
          policyPath,
          floor: project ? renderFloorForProject(project) : floor,
          owned: layout.owned,
        });
        process.stdout.write(`${formatMigrateResult(result)}\n`);
        break;
      }

      let live: string;
      try {
        live = readFileSync(path, "utf8");
      } catch {
        process.stderr.write(
          `omp-conductor: no brief at ${path}` +
            `${override === undefined ? " — run /conductor setup and say yes to writing ORCHESTRATOR.md." : "."}\n`,
        );
        process.exit(1);
      }

      if (layout.kind === "overlay") {
        process.stdout.write(
          `${formatBriefStatus(path, { kind: "overlay", policyPath: layout.policyPath, orchestratorPath: layout.orchestratorPath })}\n`,
        );
        break;
      }

      const status = checkBrief(live, rendered);
      process.stdout.write(`${formatBriefStatus(path, status)}\n`);
      if (project === undefined) {
        process.stdout.write(
          "\nnote: no conductor config resolved on this host, so the template's\n" +
            "{{PLACEHOLDER}} coordinates are unsubstituted. Section names are unaffected.\n",
        );
      }
      if (argv.includes("--apply") && status.kind === "mergeable") {
        const backup = writeMergedBrief(path, status.merged);
        process.stdout.write(`\napplied — previous brief kept at ${backup}\n`);
      }
      break;
    }

    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${USAGE}\n`);
      break;

    default:
      process.stderr.write(
        `${cmd === undefined ? "omp-conductor: no subcommand" : `omp-conductor: unknown subcommand "${cmd}"`}\n\n${USAGE}\n`,
      );
      process.exit(2);
  }
} catch (err) {
  // Config, lifecycle and `gh` errors are written to be read by a human, so
  // surface the message rather than a stack.
  process.stderr.write(`omp-conductor: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
