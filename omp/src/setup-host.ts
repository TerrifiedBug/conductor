import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { configPath, stateDir } from "./config.ts";
import { isPaused, runDaemon, statusSnapshot, type StatusSnapshot } from "./daemon.ts";
import { DEFAULT_FLEET_AGENT_NAME } from "./fleet.ts";
import {
  DEFAULT_PORT,
  healthCheck,
  livingDaemon,
  startDaemon,
  stopDaemon,
  type DaemonRecord,
  type StopResult,
} from "./lifecycle.ts";
import {
  readTickConfig,
  TICK_CONFIG_FILE,
  type TickConfig,
} from "./orchestrator-tick.ts";
import type { Caps, ProjectConfig } from "./types.ts";

export const DEFAULT_TICK_INTERVAL_SECONDS = 900;
export const STAGED_SERVICE_NAME = "omp-conductor.service";
export const SYSTEMD_UNIT_DIR = "/etc/systemd/system";

export type PlannedWrite<T> = {
  path: string;
  action: "create" | "update" | "keep";
  content: string;
  value: T;
};

export interface HostRuntimePlan {
  service: PlannedWrite<string>;
  tick?: PlannedWrite<TickConfig>;
  installCommands: readonly string[];
  cliSource: "global" | "plugin";
}

export interface ServiceRuntime {
  username: string;
  home: string;
  path: string;
  bun: string;
  cli?: string;
  packageCli: string;
  conductorHome: string;
  telegramStateDir: string;
}

function systemdQuote(value: string): string {
  if (/\r|\n/.test(value)) throw new Error("systemd values cannot contain newlines");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function actionFor(path: string, content: string): PlannedWrite<string>["action"] {
  if (!existsSync(path)) return "create";
  try {
    return readFileSync(path, "utf8") === content ? "keep" : "update";
  } catch {
    return "update";
  }
}

function defaultServiceRuntime(telegramStateDir: string): ServiceRuntime {
  const home = homedir();
  const bun = process.execPath;
  const globalCli = Bun.which("omp-conductor");
  const pathParts = [dirname(bun), ...(process.env["PATH"] ?? "").split(":")].filter(
    (value, index, all) => value.length > 0 && all.indexOf(value) === index,
  );
  return {
    username: userInfo().username,
    home,
    path: pathParts.join(":"),
    bun,
    ...(globalCli === null ? {} : { cli: globalCli }),
    packageCli: join(import.meta.dir, "cli.ts"),
    conductorHome: dirname(configPath()),
    telegramStateDir,
  };
}

export function renderDaemonService(
  project: ProjectConfig,
  caps: Caps,
  runtime: ServiceRuntime,
): string {
  const command =
    runtime.cli === undefined
      ? [runtime.bun, runtime.packageCli, "daemon", "--project", project.name, "--port", String(DEFAULT_PORT)]
      : [runtime.cli, "daemon", "--project", project.name, "--port", String(DEFAULT_PORT)];
  const memoryMax = caps.maxConcurrentWorkers <= 1 ? "3G" : "5G";
  return [
    "[Unit]",
    "Description=omp-conductor dispatch daemon",
    "Documentation=https://github.com/TerrifiedBug/conductor",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${runtime.username}`,
    `Environment=${systemdQuote(`HOME=${runtime.home}`)}`,
    `Environment=${systemdQuote(`PATH=${runtime.path}`)}`,
    `Environment=${systemdQuote(`OMP_CONDUCTOR_HOME=${runtime.conductorHome}`)}`,
    `Environment=${systemdQuote(`OMP_TELEGRAM_STATE_DIR=${runtime.telegramStateDir}`)}`,
    `WorkingDirectory=${systemdQuote(stateDir())}`,
    `ExecStart=${command.map(systemdQuote).join(" ")}`,
    "Restart=on-failure",
    "SuccessExitStatus=0 143",
    "MemoryAccounting=yes",
    `MemoryMax=${memoryMax}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function tickSearchRoots(project: ProjectConfig): string[] {
  const roots = [stateDir(), dirname(project.workspaceRoot), project.workspaceRoot];
  return roots.filter((root, index) => roots.indexOf(root) === index);
}

function planTick(project: ProjectConfig, telegramStateDir: string): PlannedWrite<TickConfig> {
  let existing: { path: string; config: TickConfig } | undefined;
  for (const root of tickSearchRoots(project)) {
    const result = readTickConfig(root);
    if (result.kind === "invalid") {
      throw new Error(`tick config invalid at ${result.path}: ${result.problem}; fix or remove it before setup`);
    }
    if (result.kind === "ok") {
      existing = { path: result.path, config: result.config };
      break;
    }
  }

  const path = existing?.path ?? join(project.workspaceRoot, TICK_CONFIG_FILE);
  const config: TickConfig = existing === undefined
    ? {
        intervalSeconds: DEFAULT_TICK_INTERVAL_SECONDS,
        armedFile: join(stateDir(), "armed"),
        accessFile: join(telegramStateDir, "access.json"),
        agentName: DEFAULT_FLEET_AGENT_NAME,
      }
    : {
        ...existing.config,
        armedFile: existing.config.armedFile ?? join(stateDir(), "armed"),
        accessFile: existing.config.accessFile ?? join(telegramStateDir, "access.json"),
      };
  const content = `${JSON.stringify(config, null, 2)}\n`;
  return { path, action: actionFor(path, content), content, value: config };
}

export function planHostRuntime(
  project: ProjectConfig,
  caps: Caps,
  telegramStateDir: string,
  runtime: ServiceRuntime = defaultServiceRuntime(telegramStateDir),
): HostRuntimePlan {
  const servicePath = join(stateDir(), STAGED_SERVICE_NAME);
  const serviceContent = renderDaemonService(project, caps, runtime);
  const service: PlannedWrite<string> = {
    path: servicePath,
    action: actionFor(servicePath, serviceContent),
    content: serviceContent,
    value: serviceContent,
  };
  const installedPath = join(SYSTEMD_UNIT_DIR, STAGED_SERVICE_NAME);
  return {
    service,
    ...(project.escalation.orchestrator === "external"
      ? { tick: planTick(project, telegramStateDir) }
      : {}),
    installCommands: [
      `sudo install -m 0644 ${shellQuote(servicePath)} ${shellQuote(installedPath)}`,
      "sudo systemctl daemon-reload",
      `sudo systemctl enable ${STAGED_SERVICE_NAME}`,
      `sudo systemctl restart ${STAGED_SERVICE_NAME}`,
    ],
    cliSource: runtime.cli === undefined ? "plugin" : "global",
  };
}

export function formatHostRuntimePlan(plan: HostRuntimePlan): string {
  const lines = [
    "host runtime",
    `  service        ${plan.service.action} ${plan.service.path}`,
    `  daemon entry   ${plan.cliSource === "global" ? "installed omp-conductor CLI" : "current installed plugin"}`,
  ];
  if (plan.tick !== undefined) {
    lines.push(
      `  heartbeat      ${plan.tick.action} ${plan.tick.path}`,
      `  interval       ${plan.tick.value.intervalSeconds}s`,
      `  arm gate       ${plan.tick.value.armedFile}`,
      `  channel gate   ${plan.tick.value.accessFile}`,
    );
  } else {
    lines.push("  heartbeat      embedded orchestrator — no external tick config");
  }
  lines.push("  install        staged only; the final result prints the systemd install commands");
  return lines.join("\n");
}

function atomicWrite(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, content, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
    chmodSync(path, mode);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function writeHostRuntime(plan: HostRuntimePlan): string[] {
  const written: string[] = [];
  if (plan.service.action !== "keep") {
    atomicWrite(plan.service.path, plan.service.content, 0o644);
    written.push(plan.service.path);
  }
  if (plan.tick !== undefined && plan.tick.action !== "keep") {
    atomicWrite(plan.tick.path, plan.tick.content, 0o600);
    written.push(plan.tick.path);
  }
  return written;
}

export interface SetupSmokeResult {
  mode: "temporary" | "existing";
  status: StatusSnapshot;
  daemon: DaemonRecord;
}

export interface SetupSmokeDeps {
  paused(): boolean;
  runOnce(project: string): Promise<void>;
  living(): DaemonRecord | undefined;
  health(port: number): Promise<{ ok: boolean; body?: string }>;
  start(project: string): Promise<DaemonRecord>;
  stop(): Promise<StopResult>;
  status(project: string): StatusSnapshot;
}

const DEFAULT_SMOKE_DEPS: SetupSmokeDeps = {
  paused: isPaused,
  runOnce: async (project) => await runDaemon({ once: true, project }),
  living: livingDaemon,
  health: healthCheck,
  start: async (project) => await startDaemon({ project }),
  stop: stopDaemon,
  status: statusSnapshot,
};

export async function runSetupSmoke(
  project: string,
  deps: SetupSmokeDeps = DEFAULT_SMOKE_DEPS,
): Promise<SetupSmokeResult> {
  if (!deps.paused()) throw new Error("setup smoke requires paused dispatch");
  await deps.runOnce(project);
  const existing = deps.living();
  if (existing !== undefined) {
    const health = await deps.health(existing.port);
    if (!health.ok) throw new Error(`existing daemon on :${existing.port} did not answer /healthz`);
    return { mode: "existing", status: deps.status(project), daemon: existing };
  }

  const daemon = await deps.start(project);
  try {
    const health = await deps.health(daemon.port);
    if (!health.ok) throw new Error(`temporary daemon on :${daemon.port} did not answer /healthz`);
    return { mode: "temporary", status: deps.status(project), daemon };
  } finally {
    await deps.stop();
  }
}
