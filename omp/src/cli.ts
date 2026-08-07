#!/usr/bin/env bun
/**
 * Standalone entry point. Everything here is argument handling and printing —
 * the loop, the caps and the state all live in ./daemon.ts and the background
 * process lifecycle in ./lifecycle.ts, so the CLI and the `/conductor` plugin
 * cannot drift apart.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkBrief, formatBriefStatus, writeMergedBrief } from "./brief-upgrade.ts";
import { findProject, loadConfig, resolveCaps, stateDir } from "./config.ts";
import { dbPath, formatStatus, runDaemon, setPaused, statusSnapshot } from "./daemon.ts";
import { formatGraphSetup, graphRepos, writeGraphSetup, type GraphSetupWrite } from "./graph.ts";
import {
  clearRecord,
  DEFAULT_PORT,
  healthCheck,
  livingDaemon,
  restartDaemon,
  startDaemon,
  stopDaemon,
  writeRecord,
} from "./lifecycle.ts";
import { STALL_MARKER_FILE } from "./orchestrator-tick.ts";
import { briefPathForProject, renderBriefForProject, shippedBriefTemplate } from "./setup.ts";
import { LIVE_STATES, openStore } from "./store.ts";
import { makeTracker } from "./tracker/github.ts";
import type { ProjectConfig } from "./types.ts";
import { formatUnblock, unblockIssue } from "./unblock.ts";

const USAGE = `omp-conductor — dispatch ready issues to omp coding sessions

usage:
  omp-conductor start [--port N] [--project NAME]
  omp-conductor stop
  omp-conductor restart [--port N] [--project NAME]
  omp-conductor status [--project NAME]
  omp-conductor tail <issue> [--project NAME]
  omp-conductor unblock <issue> [--project NAME]
  omp-conductor daemon [--once] [--port N] [--project NAME]
  omp-conductor pause
  omp-conductor resume
  omp-conductor graph-setup [--project NAME] [--write]
  omp-conductor brief-upgrade [--apply] [--file PATH] [--project NAME]
  omp-conductor help

  start    run the dispatch loop in the background and wait until it answers
           GET /healthz on :8787 (override with --port). Refuses if one is
           already running.
  stop     stop the running daemon. Uses systemctl when the omp-conductor
           unit owns the process (so Restart=on-failure cannot bring it back);
           otherwise SIGTERM then SIGKILL.
  restart  stop then start, keeping the running daemon's port and project
           unless a flag overrides them. On boot the new process salvages any
           dirty live worktrees before orphaning those rows — see README
           "Deploying a new package onto a busy fleet". Goes through systemctl
           when the unit owns the live pid.
  status   show pause state, caps, active runs, today's usage, and whether a
           daemon is alive.
  tail     follow the newest run for <issue>: the worker's assistant text and
           the tools it calls, printed as they land. Workers are sessions inside
           the daemon rather than terminals, so this is the only way to watch
           one live. Runs until Ctrl-C, or until the run has finished and its
           transcript has stopped growing.
  unblock  clear <issue>'s blocked and failed labels so the next tick can claim
           it again — the supported way back for an escalation you answered,
           and why the brief's "never hand-edit a state label" rule can stay
           absolute. Attempts already spent are kept: an answered block still
           cost a worker.
  daemon   run the dispatch loop in the foreground; --once runs a single tick
           and exits. This is what \`start\` launches.
  pause    stop claiming new work. The running daemon notices on its next tick.
  resume   allow claiming again.
  graph-setup
           print how to set up the code-graph indexes workers query instead of
           grepping: the clone commands for any missing index-only clone, the
           index command per repo, and a systemd service+timer that keeps them
           current. --write writes the two units and the script they run, and
           prints the systemctl line to run — it never runs systemctl itself.
           Exits 1 when no repo in the project has graphProject configured.
  brief-upgrade
           compare a project's ORCHESTRATOR.md against the brief this version of
           the package ships. Reports by default; --apply replaces the half above
           the YOURS TO EDIT banner and keeps everything below it, backing the old
           file up first. --file checks a brief that is not where the wizard would
           have put it, on a host that may have no config at all. Nothing is
           written for a brief with no banner, or when no config resolved and the
           template still carries its {{PLACEHOLDER}} coordinates.
  help     print this text (also --help, -h).

Pause is a flag file under the state directory, so it applies to every project
and survives a daemon restart. A running daemon is tracked by a pidfile under
$OMP_CONDUCTOR_RUNTIME_DIR (default ~/.omp/run/daemons/omp-conductor), written
whether it was started in the background or in the foreground, and probed for
liveness on every read — a stale one never blocks a start.`;

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
 * The daemon half of `status`. Kept separate from `formatStatus` because the
 * pidfile and the endpoint are the CLI's business, not the dispatcher's, and
 * because a pid without a `/healthz` answer is a distinct — and interesting —
 * state: the process is up but the loop is not serving.
 */
async function daemonSection(): Promise<string> {
  const rec = livingDaemon();
  if (rec === undefined) return "daemon    not running";
  const health = await healthCheck(rec.port);
  return [
    "daemon",
    `  pid       ${rec.pid}`,
    `  uptime    ${humanDuration(Date.now() - rec.startedAt)}`,
    `  port      ${rec.port}`,
    ...(rec.project === undefined ? [] : [`  project   ${rec.project}`]),
    `  healthz   ${health.ok ? `ok  ${health.body ?? ""}`.trimEnd() : "unreachable — the process is up but not serving"}`,
    `  log       ${rec.logFile}`,
  ].join("\n");
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
      const rec = await startDaemon({ port: portFlag(argv), project: flag(argv, "project") });
      process.stdout.write(
        `started — pid ${rec.pid}, /healthz on :${rec.port}` +
          `${rec.project === undefined ? "" : `, project ${rec.project}`}\nlog ${rec.logFile}\n`,
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
      const snapshot = formatStatus(statusSnapshot(flag(argv, "project")));
      const stalled = stallLine();
      process.stdout.write(`${snapshot}\n\n${await daemonSection()}\n${stalled === undefined ? "" : `\n${stalled}\n`}`);
      break;
    }

    case "tail": {
      const issue = issueArg("tail", argv[1]);
      await tailRun(findProject(loadConfig(), flag(argv, "project")).name, issue);
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
      process.stdout.write("paused — no new work will be claimed\n");
      break;

    case "resume":
      setPaused(false);
      process.stdout.write("resumed — work will be claimed on the next tick\n");
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
      // `--file` exists because a real fleet's brief is often not where the wizard
      // would have put it: the supervising session runs from its own directory, and
      // that host may never have configured a dispatch daemon at all. Without this
      // the command cannot check the one file it was written for.
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
          // No config here, or several projects and no name given. With an explicit
          // file we need neither, and refusing would make the command unusable on a
          // fleet host that runs only the supervising session.
          project = undefined;
        }
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

      // With no config there are no coordinates to substitute, so the template is
      // compared raw. Headings carry no placeholders, so the section-level report is
      // unaffected; the note below keeps the printed text honest.
      const status = checkBrief(live, project === undefined ? shippedBriefTemplate() : renderBriefForProject(project));
      // Report first, always: --apply on a brief with no banner must not be the
      // command that silently discards an operator's hand-written policy.
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
