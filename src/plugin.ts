/**
 * The omp plugin surface: one `/conductor` command with four subcommands.
 *
 * Deliberately thin. Every subcommand is argument parsing plus printing over
 * ./daemon.ts, so the plugin and the `omp-conductor` CLI can never disagree
 * about what a cap means or where the state lives.
 */
import {
  armConductor,
  formatStatus,
  isPaused,
  previewQueue,
  setPaused,
  statusSnapshot,
} from "./daemon.ts";

/**
 * The slice of the omp extension API this plugin actually touches, mirroring
 * `RegisteredCommand` / `ExtensionUIContext` from `@oh-my-pi/pi-coding-agent`.
 *
 * Declared here rather than imported because the harness is a peer dependency:
 * the package has to type-check without it installed. Structural typing means
 * the real API object satisfies this on the way in, and narrowing the surface
 * to four members keeps the coupling visible.
 */
interface Completion {
  value: string;
  label: string;
  description?: string;
}

interface CommandContext {
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    confirm(title: string, message: string): Promise<boolean>;
  };
}

interface PluginApi {
  registerCommand(
    name: string,
    options: {
      description?: string;
      getArgumentCompletions?: (argumentPrefix: string) => Completion[] | null;
      handler: (args: string, ctx: CommandContext) => Promise<void>;
    },
  ): void;
}

const SUBCOMMANDS: Completion[] = [
  { value: "setup", label: "setup", description: "dry-run the queue, then arm the conductor" },
  { value: "status", label: "status", description: "pause state, caps, active runs, today's usage" },
  { value: "pause", label: "pause", description: "stop claiming new work" },
  { value: "resume", label: "resume", description: "allow claiming again" },
];

const USAGE = [
  "/conductor setup [project]   dry-run the queue, then arm after you confirm",
  "/conductor status [project]  pause state, caps, active runs, today's usage",
  "/conductor pause             stop claiming new work",
  "/conductor resume            allow claiming again",
].join("\n");

/**
 * The dry run. Reads the tracker through the same routing code the loop uses
 * and shows exactly what the next tick would do — no label written, no run row,
 * no worktree — so a mislabelled queue is caught before it becomes six wrong
 * PRs. Nothing is mutated until the confirm below comes back true.
 */
async function setup(ctx: CommandContext, project: string | undefined): Promise<void> {
  const p = await previewQueue(project);

  const lines = [
    `project      ${p.project}`,
    `config       ${p.configPath}`,
    `queue query  ${p.queueDescription}`,
    `state        ${p.paused ? "paused" : "armed"}`,
    "",
    p.ready.length === 0
      ? "Would pick up: nothing — the queue is empty."
      : `Would pick up ${p.ready.length} issue(s), caps permitting:`,
  ];
  for (const r of p.ready) lines.push(`  #${r.number}  → ${r.repo}  ${r.branch}  ${r.title}`);

  if (p.unroutable.length > 0) {
    lines.push(
      "",
      `Cannot route ${p.unroutable.length} issue(s) — these escalate instead of running:`,
    );
    for (const u of p.unroutable) {
      lines.push(`  #${u.number}  ${u.reason}  [${u.labels.join(", ") || "no labels"}]  ${u.title}`);
    }
  }

  lines.push("", "Nothing has been changed yet.");
  ctx.ui.notify(lines.join("\n"), "info");

  const armed = await ctx.ui.confirm(
    "Arm omp-conductor?",
    `Creates the state database and clears the pause flag for ${p.project}. ` +
      "Issues are only claimed once the daemon runs.",
  );
  if (!armed) {
    ctx.ui.notify("Left untouched — nothing was armed.", "info");
    return;
  }

  armConductor();
  ctx.ui.notify(
    "Armed. Start the loop with `omp-conductor daemon`, or `omp-conductor daemon --once` for a single tick.",
    "info",
  );
}

export default function conductorPlugin(pi: PluginApi): void {
  pi.registerCommand("conductor", {
    description: "Dispatch ready issues to omp coding sessions",
    getArgumentCompletions: (prefix) => SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.trim())),

    handler: async (args, ctx) => {
      // findProject() throws when the config holds several projects and none is
      // named, so the project name rides along as an optional second word.
      const [sub, project] = args.trim().split(/\s+/);

      try {
        switch (sub) {
          case "setup":
            await setup(ctx, project);
            break;

          case "status":
            ctx.ui.notify(formatStatus(statusSnapshot(project)), "info");
            break;

          case "pause":
            setPaused(true);
            ctx.ui.notify("Conductor paused — no new work will be claimed.", "info");
            break;

          case "resume":
            setPaused(false);
            ctx.ui.notify("Conductor resumed — work will be claimed on the next tick.", "info");
            break;

          default:
            ctx.ui.notify(
              `${sub ? `Unknown subcommand "${sub}".` : "Pick a subcommand."}\n\n${USAGE}` +
                (isPaused() ? "\n\nThe conductor is currently paused." : ""),
              sub ? "warning" : "info",
            );
        }
      } catch (err) {
        // Config problems arrive as a single readable message listing every
        // fault, which is more use to the operator than a stack.
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
}
