import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  recordReleaseBlock,
  releaseDecision,
  releaseDriftDigestLine,
  releaseDriftToday,
  releasePolicyTripwire,
  releaseShapeFromCommand,
} from "./release-policy.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "conductor-release-policy-"));
  dirs.push(dir);
  return dir;
}

describe("release policy tripwire", () => {
  test("recognises the promised release and deploy command shapes", () => {
    expect(releaseShapeFromCommand("git tag v1.2.3")).toBe("git-tag");
    expect(releaseShapeFromCommand("git push origin --follow-tags")).toBe("git-push-tags");
    expect(releaseShapeFromCommand("git push origin v1.2.3")).toBe("git-push-tags");
    expect(releaseShapeFromCommand("git push origin tag v1.2.3")).toBe("git-push-tags");
    expect(releaseShapeFromCommand("npm publish --provenance")).toBe("package-publish");
    expect(releaseShapeFromCommand("gh release create v1.2.3")).toBe("github-release");
    expect(releaseShapeFromCommand("kubectl apply -f deploy.yml")).toBe("deploy");
    expect(releaseShapeFromCommand("bun run check && npm publish")).toBe("package-publish");
  });

  test("does not confuse ordinary source pushes and package installs with releases", () => {
    expect(releaseShapeFromCommand("git push -u origin feat/widget")).toBeUndefined();
    expect(releaseShapeFromCommand("git push origin feat/v1.2.3")).toBeUndefined();
    expect(releaseShapeFromCommand("npm install")).toBeUndefined();
    expect(releaseShapeFromCommand("bun run deploy:test")).toBeUndefined();
  });

  test("blocks shell and direct GitHub release calls under none", () => {
    expect(releaseDecision("none", "bash", { command: "npm publish" })?.decision.block).toBe(true);
    expect(
      releaseDecision("none", "write", {
        path: "xd://mcp__github_create_release",
        content: "{}",
      })?.shape,
    ).toBe("github-release");
  });

  test("does not block source files whose names mention deployment", () => {
    expect(
      releaseDecision("none", "write", {
        path: "src/deploy.ts",
        content: "export function deploy() {}",
      }),
    ).toBeUndefined();
  });

  test("operator-brief permits the same calls", () => {
    expect(releaseDecision("operator-brief", "bash", { command: "npm publish" })).toBeUndefined();
  });

  test("inline extension records and rejects before the tool runs", () => {
    let handler:
      | ((event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => unknown)
      | undefined;
    const blocked: string[] = [];
    releasePolicyTripwire("none", (shape) => blocked.push(shape))({
      on: (_event, next) => {
        handler = next;
      },
    });

    expect(handler?.({ toolName: "bash", input: { command: "gh release create v1" } }, {})).toMatchObject({
      block: true,
    });
    expect(blocked).toEqual(["github-release"]);
  });
});

describe("release policy drift audit", () => {
  test("aggregates only the named project's current UTC day", () => {
    const root = tempDir();
    recordReleaseBlock("alpha", "worker", "package-publish", root, new Date("2026-08-08T01:00:00Z"));
    recordReleaseBlock("beta", "worker", "deploy", root, new Date("2026-08-08T02:00:00Z"));
    recordReleaseBlock("alpha", "orchestrator", "github-release", root, new Date("2026-08-08T03:00:00Z"));
    recordReleaseBlock("alpha", "worker", "git-tag", root, new Date("2026-08-07T23:00:00Z"));

    expect(releaseDriftToday("alpha", root, new Date("2026-08-08T23:00:00Z"))).toEqual({
      count: 2,
      latest: {
        project: "alpha",
        source: "orchestrator",
        shape: "github-release",
        at: "2026-08-08T03:00:00.000Z",
      },
    });
    expect(releaseDriftDigestLine("alpha", root, new Date("2026-08-08T23:00:00Z"))).toContain(
      "2 release/deploy tool call(s) were blocked",
    );
  });
});
