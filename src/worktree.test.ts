import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RepoTarget } from "./types.ts";
import {
  addWorktree,
  ensureMirror,
  mirrorPathFor,
  removeWorktree,
  worktreePathFor,
} from "./worktree.ts";

/** Real git runs here — clone, fetch, checkout — so be generous. */
const TIMEOUT_MS = 60_000;

/** The file the origin repo is seeded with, present in every checkout. */
const SEED_FILE = "README.md";

let root: string;
let repo: RepoTarget;

/**
 * Runs git for the test, throwing on failure.
 *
 * Identity and `commit.gpgsign` are injected on *every* call rather than
 * configured once: worktrees share the mirror's config, and the mirror is
 * created inside `addWorktree` where the test never gets to configure it. `-c`
 * makes committing work on a machine with no global identity and on one whose
 * global config signs every commit.
 */
function git(args: string[], cwd: string): string {
  const res = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.email=conductor@test.invalid",
      "-c",
      "user.name=Conductor Test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );

  if (res.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} (cwd ${cwd}) exited ${res.exitCode}: ` +
        `${res.stderr.toString().trim() || "no output"}`,
    );
  }
  return res.stdout.toString().trim();
}

/** A per-case pair of roots, so no test can inherit another's mirror or tree. */
function sandbox(name: string): { mirrorRoot: string; workspaceRoot: string } {
  return {
    mirrorRoot: join(root, `${name}-mirrors`),
    workspaceRoot: join(root, `${name}-workspace`),
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "conductor-worktree-"));

  // A bare repo on the filesystem is a perfectly good origin: `cloneUrl` is
  // just a path, so the whole suite runs with no network and no credentials.
  const origin = join(root, "origin.git");
  git(["init", "--bare", "--initial-branch=main", origin], root);

  const scratch = join(root, "scratch");
  git(["clone", origin, scratch], root);
  git(["config", "user.email", "conductor@test.invalid"], scratch);
  git(["config", "user.name", "Conductor Test"], scratch);
  git(["config", "commit.gpgsign", "false"], scratch);
  writeFileSync(join(scratch, SEED_FILE), "seed\n");
  git(["add", SEED_FILE], scratch);
  git(["commit", "-m", "seed"], scratch);
  git(["push", "origin", "main"], scratch);

  repo = {
    name: "sample",
    cloneUrl: origin,
    defaultBranch: "main",
    gates: [],
  };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ensureMirror", () => {
  it(
    "is idempotent: the second call refreshes the same mirror",
    async () => {
      const { mirrorRoot } = sandbox("mirror-idempotent");

      const first = await ensureMirror(repo, mirrorRoot);
      const second = await ensureMirror(repo, mirrorRoot);

      expect(second).toBe(first);
      expect(first).toBe(mirrorPathFor(repo, mirrorRoot));
      expect(existsSync(join(first, "HEAD"))).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe("addWorktree", () => {
  it(
    "cuts a first attempt onto the requested branch with the repo contents",
    async () => {
      const { mirrorRoot, workspaceRoot } = sandbox("first-attempt");
      const branch = "conductor/issue-101";

      const tree = await addWorktree(repo, mirrorRoot, workspaceRoot, 101, branch);

      expect(tree).toBe(worktreePathFor(workspaceRoot, 101));
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], tree)).toBe(branch);
      expect(existsSync(join(tree, SEED_FILE))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "reattaches the preserved branch on a second attempt, keeping attempt 1's commits",
    async () => {
      const { mirrorRoot, workspaceRoot } = sandbox("retry");
      const branch = "conductor/issue-202";
      const mirrorPath = mirrorPathFor(repo, mirrorRoot);

      const first = await addWorktree(repo, mirrorRoot, workspaceRoot, 202, branch);
      writeFileSync(join(first, "attempt-1.txt"), "never pushed anywhere\n");
      git(["add", "attempt-1.txt"], first);
      git(["commit", "-m", "attempt 1 work"], first);
      const attemptOneHead = git(["rev-parse", "HEAD"], first);

      await removeWorktree(mirrorPath, first);
      expect(existsSync(first)).toBe(false);

      // Same issue, same deterministic branch name: this is exactly what the
      // dispatcher does on a retry, and what used to die with "a branch named
      // '<branch>' already exists".
      const second = await addWorktree(repo, mirrorRoot, workspaceRoot, 202, branch);

      expect(second).toBe(first);
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], second)).toBe(branch);
      expect(existsSync(join(second, "attempt-1.txt"))).toBe(true);
      expect(git(["rev-parse", "HEAD"], second)).toBe(attemptOneHead);
    },
    TIMEOUT_MS,
  );

  it(
    "recovers from a stale worktree registration left by a crash",
    async () => {
      const { mirrorRoot, workspaceRoot } = sandbox("stale-registration");
      const branch = "conductor/issue-303";

      const tree = await addWorktree(repo, mirrorRoot, workspaceRoot, 303, branch);
      // A hard crash, or a tmpdir reaper: the directory is gone but the mirror
      // still believes `branch` is checked out there.
      rmSync(tree, { recursive: true, force: true });

      const again = await addWorktree(repo, mirrorRoot, workspaceRoot, 303, branch);

      expect(again).toBe(tree);
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], again)).toBe(branch);
    },
    TIMEOUT_MS,
  );

  it(
    "refuses a path that already exists, naming it",
    async () => {
      const { mirrorRoot, workspaceRoot } = sandbox("existing-path");
      const branch = "conductor/issue-404";

      const tree = await addWorktree(repo, mirrorRoot, workspaceRoot, 404, branch);

      await expect(
        addWorktree(repo, mirrorRoot, workspaceRoot, 404, branch),
      ).rejects.toThrow(tree);
      expect(existsSync(tree)).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe("removeWorktree", () => {
  it(
    "is idempotent: removing an already-removed tree resolves",
    async () => {
      const { mirrorRoot, workspaceRoot } = sandbox("remove-idempotent");
      const mirrorPath = mirrorPathFor(repo, mirrorRoot);

      const tree = await addWorktree(
        repo,
        mirrorRoot,
        workspaceRoot,
        505,
        "conductor/issue-505",
      );

      await removeWorktree(mirrorPath, tree);
      await removeWorktree(mirrorPath, tree);

      expect(existsSync(tree)).toBe(false);
    },
    TIMEOUT_MS,
  );
});
