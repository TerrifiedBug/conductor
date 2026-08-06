#!/usr/bin/env bun
/**
 * Standalone entry point. Everything here is argument handling and printing —
 * the loop, the caps and the state all live in ./daemon.ts and the background
 * process lifecycle in ./lifecycle.ts, so the CLI and the `/conductor` plugin
 * cannot drift apart.
 */
import { formatStatus, runDaemon, setPaused, statusSnapshot } from "./daemon.ts";
import { healthCheck, livingDaemon, startDaemon, stopDaemon } from "./lifecycle.ts";

const USAGE = `omp-conductor — dispatch ready issues to omp coding sessions

usage:
  omp-conductor start [--port N] [--project NAME]
  omp-conductor stop
  omp-conductor restart [--port N] [--project NAME]
  omp-conductor status [--project NAME]
  omp-conductor daemon [--once] [--port N] [--project NAME]
  omp-conductor pause
  omp-conductor resume
  omp-conductor help

  start    run the dispatch loop in the background and wait until it answers
           GET /healthz on :8787 (override with --port). Refuses if one is
           already running.
  stop     signal the running daemon and wait for it to exit.
  restart  stop then start, keeping the running daemon's port and project
           unless a flag overrides them.
  status   show pause state, caps, active runs, today's usage, and whether a
           daemon is alive.
  daemon   run the dispatch loop in the foreground; --once runs a single tick
           and exits. This is what \`start\` launches.
  pause    stop claiming new work. The running daemon notices on its next tick.
  resume   allow claiming again.
  help     print this text (also --help, -h).

Pause is a flag file under the state directory, so it applies to every project
and survives a daemon restart. The background daemon is tracked by a pidfile
under $OMP_CONDUCTOR_RUNTIME_DIR (default ~/.omp/run/daemons/omp-conductor),
whose liveness is probed on every read — a stale one never blocks a start.`;

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

const argv = process.argv.slice(2);
const cmd = argv[0];

try {
  switch (cmd) {
    case "daemon": {
      await runDaemon({
        once: argv.includes("--once"),
        port: portFlag(argv),
        project: flag(argv, "project"),
      });
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
      // Read the pid before it stops existing, so the confirmation can name it.
      const pid = livingDaemon()?.pid;
      const result = await stopDaemon();
      process.stdout.write(result === "stopped" ? `stopped — pid ${pid ?? "?"}\n` : "not running\n");
      break;
    }

    case "restart": {
      // Inherit the running daemon's port and project: a restart that quietly
      // moved to the default port would leave every existing health check
      // pointing at nothing.
      const previous = livingDaemon();
      const result = await stopDaemon();
      if (result === "stopped") process.stdout.write(`stopped — pid ${previous?.pid ?? "?"}\n`);
      const rec = await startDaemon({
        port: portFlag(argv) ?? previous?.port,
        project: flag(argv, "project") ?? previous?.project,
      });
      process.stdout.write(
        `started — pid ${rec.pid}, /healthz on :${rec.port}` +
          `${rec.project === undefined ? "" : `, project ${rec.project}`}\nlog ${rec.logFile}\n`,
      );
      break;
    }

    case "status": {
      const snapshot = formatStatus(statusSnapshot(flag(argv, "project")));
      process.stdout.write(`${snapshot}\n\n${await daemonSection()}\n`);
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
