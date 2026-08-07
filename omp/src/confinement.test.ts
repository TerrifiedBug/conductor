import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confineToolCall,
  isInsideWorktree,
  pathFromToolInput,
  worktreeConfinement,
  type ConfinementPi,
} from "./confinement.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "confine-"));
  writeFileSync(join(root, "in.ts"), "ok\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isInsideWorktree", () => {
  test("allows relative and absolute paths under the root", () => {
    expect(isInsideWorktree(root, "in.ts")).toBe(true);
    expect(isInsideWorktree(root, join(root, "in.ts"))).toBe(true);
    expect(isInsideWorktree(root, "./nested/../in.ts")).toBe(true);
  });

  test("rejects escapes by .. and by absolute outside paths", () => {
    expect(isInsideWorktree(root, "../secrets")).toBe(false);
    expect(isInsideWorktree(root, "/etc/passwd")).toBe(false);
    expect(isInsideWorktree(root, join(root, "..", "outside"))).toBe(false);
  });

  test("allows a not-yet-created path whose parent is inside", () => {
    expect(isInsideWorktree(root, "new/file.ts")).toBe(true);
  });

  test("rejects a symlink that points outside the worktree", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "secret"), "x\n");
    symlinkSync(outside, join(root, "leak"));
    try {
      expect(isInsideWorktree(root, "leak/secret")).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("confineToolCall", () => {
  test("blocks write/edit/read outside, allows inside", () => {
    expect(confineToolCall(root, "write", { path: "in.ts" })).toBeUndefined();
    expect(confineToolCall(root, "edit", { path: join(root, "in.ts") })).toBeUndefined();
    expect(confineToolCall(root, "read", { path: "../x" })?.block).toBe(true);
    expect(confineToolCall(root, "write", { path: "/etc/passwd" })?.reason).toContain("outside");
  });

  test("ignores bash and tools without a path", () => {
    expect(confineToolCall(root, "bash", { command: "cat /etc/passwd" })).toBeUndefined();
    expect(confineToolCall(root, "write", {})).toBeUndefined();
  });

  test("pathFromToolInput reads path or target_directory", () => {
    expect(pathFromToolInput("glob", { target_directory: "src" })).toBe("src");
    expect(pathFromToolInput("bash", { command: "ls" })).toBeUndefined();
  });
});

test("worktreeConfinement installs a blocking tool_call handler", async () => {
  let handler:
    | ((
        event: { toolName: string; input: Record<string, unknown> },
        ctx: unknown,
      ) => unknown)
    | undefined;
  const pi: ConfinementPi = {
    on(_event, h) {
      handler = h;
    },
  };
  worktreeConfinement(root)(pi);
  expect(handler).toBeDefined();
  const blocked = await handler!({ toolName: "read", input: { path: "/etc/hosts" } }, undefined);
  expect(blocked).toEqual(expect.objectContaining({ block: true }));
  const allowed = await handler!({ toolName: "read", input: { path: "in.ts" } }, undefined);
  expect(allowed).toBeUndefined();
});
