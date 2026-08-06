#!/usr/bin/env bun
/**
 * Standalone entry point. Everything here is argument handling and printing —
 * the loop, the caps and the state all live in ./daemon.ts, so the CLI and the
 * `/conductor` plugin cannot drift apart.
 */
import { formatStatus, runDaemon, setPaused, statusSnapshot } from "./daemon.ts";

const USAGE = `omp-conductor — dispatch ready issues to omp coding sessions

usage:
  omp-conductor daemon [--once] [--port N] [--project NAME]
  omp-conductor status [--project NAME]
  omp-conductor pause
  omp-conductor resume

  daemon   run the dispatch loop; --once runs a single tick and exits.
           Without --once it serves GET /healthz on :8787 (override with --port).
  status   show pause state, caps, active runs and today's usage.
  pause    stop claiming new work. The running daemon notices on its next tick.
  resume   allow claiming again.

Pause is a flag file under the state directory, so it applies to every project
and survives a daemon restart.`;

/** Accepts both `--port 9000` and `--port=9000`; returns undefined when absent. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const prefixed = argv.find((a) => a.startsWith(`--${name}=`));
  return prefixed?.slice(name.length + 3);
}

const argv = process.argv.slice(2);
const cmd = argv[0];

try {
  switch (cmd) {
    case "daemon": {
      const raw = flag(argv, "port");
      const port = raw === undefined ? undefined : Number.parseInt(raw, 10);
      const valueless = raw === undefined && argv.includes("--port");
      if (valueless || (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))) {
        process.stderr.write(`omp-conductor: --port needs a port number, got "${raw ?? ""}"\n`);
        process.exit(2);
      }
      await runDaemon({
        once: argv.includes("--once"),
        port,
        project: flag(argv, "project"),
      });
      break;
    }

    case "status":
      process.stdout.write(`${formatStatus(statusSnapshot(flag(argv, "project")))}\n`);
      break;

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
  // Config and `gh` errors are written to be read by a human, so surface the
  // message rather than a stack.
  process.stderr.write(`omp-conductor: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
