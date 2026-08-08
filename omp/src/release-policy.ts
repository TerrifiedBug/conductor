import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "./config.ts";
import type { ReleasePolicy } from "./types.ts";

export const RELEASE_POLICY_AUDIT_FILE = "release-policy-blocks.jsonl";

export type ReleaseShape =
  | "git-tag"
  | "git-push-tags"
  | "package-publish"
  | "github-release"
  | "deploy";

export interface ReleaseBlock {
  project: string;
  source: "worker" | "orchestrator";
  shape: ReleaseShape;
  at: string;
}

export type ReleaseDecision = { block: true; reason: string };

function commandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||[;\n|])/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function stripCommandPrefix(segment: string): string {
  return segment
    .replace(/^env\s+/, "")
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, "")
    .replace(/^sudo\s+/, "");
}

/** Recognise the explicit release/deploy command shapes this policy promises to gate. */
export function releaseShapeFromCommand(command: string): ReleaseShape | undefined {
  for (const raw of commandSegments(command)) {
    const segment = stripCommandPrefix(raw);
    if (/^git(?:\s+-[Cc]\s+\S+)*\s+tag(?:\s|$)/.test(segment)) return "git-tag";
    if (
      /^git(?:\s+-[Cc]\s+\S+)*\s+push\b/.test(segment) &&
      /(?:--tags\b|--follow-tags\b|refs\/tags\/)/.test(segment)
    ) {
      return "git-push-tags";
    }
    if (/^(?:npm|pnpm|bun)\s+(?:publish|stage\s+publish)\b/.test(segment)) {
      return "package-publish";
    }
    if (/^yarn\s+npm\s+publish\b/.test(segment)) return "package-publish";
    if (/^gh\s+release\s+create\b/.test(segment)) return "github-release";
    if (
      /^(?:kubectl\s+(?:apply|create|replace)|helm\s+(?:install|upgrade)|terraform\s+apply|pulumi\s+up|(?:fly|vercel|wrangler)\s+deploy|docker\s+push)\b/.test(
        segment,
      )
    ) {
      return "deploy";
    }
  }
  return undefined;
}

/** Release-shaped device/tool invocations that do not pass through a shell. */
export function releaseShapeFromTool(
  toolName: string,
  input: Record<string, unknown> | undefined,
): ReleaseShape | undefined {
  if (input === undefined) return undefined;
  if (toolName === "bash") {
    return typeof input.command === "string" ? releaseShapeFromCommand(input.command) : undefined;
  }

  const path = typeof input.path === "string" ? input.path : "";
  if (toolName === "write" && path.startsWith("xd://")) {
    if (/create[_-]release/i.test(path)) return "github-release";
    if (/publish/i.test(path)) return "package-publish";
    if (/deploy/i.test(path)) return "deploy";
  }

  const normalized = toolName.toLowerCase().replaceAll("-", "_");
  if (/create_?release|release_?create/.test(normalized)) return "github-release";
  if (/(?:^|_)publish(?:$|_)/.test(normalized)) return "package-publish";
  if (/(?:^|_)deploy(?:$|_)/.test(normalized)) return "deploy";
  return undefined;
}

export function releaseDecision(
  policy: ReleasePolicy,
  toolName: string,
  input: Record<string, unknown>,
): { shape: ReleaseShape; decision: ReleaseDecision } | undefined {
  if (policy !== "none") return undefined;
  const shape = releaseShapeFromTool(toolName, input);
  if (shape === undefined) return undefined;
  return {
    shape,
    decision: {
      block: true,
      reason:
        `Blocked by releasePolicy=none (${shape}). ` +
        "Only a human may change the project to operator-brief before release or deploy tools can run.",
    },
  };
}

interface ReleasePolicyPi {
  on(
    event: "tool_call",
    handler: (
      event: { toolName: string; input: Record<string, unknown> },
      ctx: unknown,
    ) => ReleaseDecision | undefined,
  ): void;
}

/** Inline session extension used by workers and the embedded orchestrator. */
export function releasePolicyTripwire(
  policy: ReleasePolicy,
  onBlocked: (shape: ReleaseShape) => void = () => {},
): (pi: ReleasePolicyPi) => void {
  return (pi) => {
    pi.on("tool_call", (event) => {
      const blocked = releaseDecision(policy, event.toolName, event.input);
      if (blocked === undefined) return undefined;
      try {
        onBlocked(blocked.shape);
      } catch {
        // Audit is evidence, not the gate. A full disk must not turn a deny into allow.
      }
      return blocked.decision;
    });
  };
}

export function recordReleaseBlock(
  project: string,
  source: ReleaseBlock["source"],
  shape: ReleaseShape,
  root = stateDir(),
  now = new Date(),
): void {
  mkdirSync(root, { recursive: true });
  const record: ReleaseBlock = { project, source, shape, at: now.toISOString() };
  appendFileSync(join(root, RELEASE_POLICY_AUDIT_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export interface ReleaseDriftSummary {
  count: number;
  latest: ReleaseBlock;
}

/** Aggregate today's blocked attempts for the orchestrator's daily digest. */
export function releaseDriftToday(
  project: string,
  root = stateDir(),
  now = new Date(),
): ReleaseDriftSummary | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, RELEASE_POLICY_AUDIT_FILE), "utf8");
  } catch {
    return undefined;
  }
  const day = now.toISOString().slice(0, 10);
  let count = 0;
  let latest: ReleaseBlock | undefined;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const value = JSON.parse(line) as Partial<ReleaseBlock>;
      if (
        value.project === project &&
        typeof value.at === "string" &&
        value.at.startsWith(day) &&
        (value.source === "worker" || value.source === "orchestrator") &&
        typeof value.shape === "string"
      ) {
        count += 1;
        latest = value as ReleaseBlock;
      }
    } catch {
      // One torn line does not hide later valid audit records.
    }
  }
  return latest === undefined ? undefined : { count, latest };
}

export function releaseDriftDigestLine(project: string, root = stateDir(), now = new Date()): string | undefined {
  const drift = releaseDriftToday(project, root, now);
  if (drift === undefined) return undefined;
  return (
    `Release-policy drift today: ${drift.count} release/deploy tool call(s) were blocked ` +
    `(latest: ${drift.latest.source} ${drift.latest.shape} at ${drift.latest.at}). ` +
    "Include this divergence from releasePolicy=none in today's digest."
  );
}
