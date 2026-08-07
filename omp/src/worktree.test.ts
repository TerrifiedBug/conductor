import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RepoTarget } from "./types.ts";
import {
  addWorktree,
  ensureMirror,
  mirrorPathFor,
  removeWorktree,
  salvageWip,
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

describe("salvageWip", () => {
  it(
    "commits a killed attempt's uncommitted work to its branch and pushes it",
    async () => {
      const { mirrorRoot, workspaceRoot } = sandbox("salvage-dirty");
      const branch = "conductor/issue-606";

      const tree = await addWorktree(repo, mirrorRoot, workspaceRoot, 606, branch);
      // Exactly the shape of the losses this exists for: a large new file git
      // has never seen, plus an edit on top of a tracked one.
      writeFileSync(join(tree, "detection_pipeline.py"), "# 696 lines of it\n");
      writeFileSync(join(tree, SEED_FILE), "seed, rewritten\n");

      const outcome = await salvageWip(tree, 606, 1, "the turns cap");

      expect(outcome).toMatchObject({ kind: "salvaged", branch, pushed: true });
      if (outcome.kind !== "salvaged") throw new Error("unreachable");

      // On the branch, not merely in the object database: the branch is what
      // survives `worktree remove --force` and what the next attempt reattaches.
      expect(git(["rev-parse", branch], tree)).toBe(outcome.sha);
      expect(git(["log", "-1", "--format=%s", branch], tree)).toBe(
        "wip(#606): attempt 1 killed by the turns cap — auto-salvaged",
      );
      expect(git(["show", "--name-only", "--format=", outcome.sha], tree).split("\n")).toEqual([
        SEED_FILE,
        "detection_pipeline.py",
      ]);
      expect(git(["status", "--porcelain"], tree)).toBe("");

      // Pushed, so the work survives the host and not just the worktree.
      expect(git(["rev-parse", `refs/heads/${branch}`], repo.cloneUrl)).toBe(outcome.sha);
    },
    TIMEOUT_MS,
  );

  it(
    "commits nothing when the tree is clean",
    async () => {
      const { mirrorRoot, workspaceRoot } = sandbox("salvage-clean");
      const branch = "conductor/issue-707";

      const tree = await addWorktree(repo, mirrorRoot, workspaceRoot, 707, branch);
      const before = git(["rev-parse", "HEAD"], tree);

      expect(await salvageWip(tree, 707, 1, "the wall-clock cap")).toEqual({ kind: "nothing" });
      expect(git(["rev-parse", "HEAD"], tree)).toBe(before);
    },
    TIMEOUT_MS,
  );

  it(
    "keeps the work but leaves a worker's own scratch behind",
    async () => {
      const { mirrorRoot, workspaceRoot } = sandbox("salvage-scratch");
      const branch = "conductor/issue-808";

      const tree = await addWorktree(repo, mirrorRoot, workspaceRoot, 808, branch);
      writeFileSync(join(tree, "detection_gates.py"), "# the actual work\n");
      // The 2026-08-07 shape: a loopback env helper a worker wrote to run the
      // test suite. Harmless, and still expensive — it read enough like a
      // leaked secret to cost an orchestrator tick and a boundary violation.
      mkdirSync(join(tree, ".scratch808"), { recursive: true });
      writeFileSync(join(tree, ".scratch808/env.sh"), "export POSTGRES_PASSWORD=devpass\n");
      writeFileSync(join(tree, ".env.local"), "DEBUG=true\n");

      const outcome = await salvageWip(tree, 808, 1, "the turns cap");

      expect(outcome).toMatchObject({ kind: "salvaged", pushed: true });
      if (outcome.kind !== "salvaged") throw new Error("unreachable");
      expect(git(["show", "--name-only", "--format=", outcome.sha], tree).split("\n")).toEqual([
        "detection_gates.py",
      ]);

      // Left on disk, not deleted: skipping it is a judgement about what to
      // publish, not licence to destroy something the worker may still want.
      expect(existsSync(join(tree, ".scratch808/env.sh"))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "reports nothing, not a failure, when only scratch is dirty",
    async () => {
      const { mirrorRoot, workspaceRoot } = sandbox("salvage-only-scratch");

      const tree = await addWorktree(repo, mirrorRoot, workspaceRoot, 909, "conductor/issue-909");
      const before = git(["rev-parse", "HEAD"], tree);
      writeFileSync(join(tree, ".env.local"), "DEBUG=true\n");

      // The tree is dirty by `status`, empty by the index once excludes apply.
      // Committing an empty index exits non-zero, so without the second check
      // a tree holding nothing worth keeping escalates as a salvage failure.
      expect(await salvageWip(tree, 909, 1, "the turns cap")).toEqual({ kind: "nothing" });
      expect(git(["rev-parse", "HEAD"], tree)).toBe(before);
    },
    TIMEOUT_MS,
  );

  it(
    "never throws, whatever state the tree is in",
    async () => {
      // A run that died before it had a checkout, and one whose tree a crash or
      // a tmpdir reaper left as a directory git knows nothing about. Salvage is
      // the last step of an already-failing run: throwing here would take the
      // escalation and the run record down with it.
      const gone = join(root, "salvage-missing", "808");
      expect(await salvageWip(gone, 808, 2, "a dispatch error")).toEqual({ kind: "nothing" });

      const notARepo = join(root, "salvage-not-a-repo");
      mkdirSync(notARepo, { recursive: true });
      writeFileSync(join(notARepo, "work.txt"), "unsaved\n");

      const outcome = await salvageWip(notARepo, 909, 1, "the turns cap");

      expect(outcome.kind).toBe("failed");
      // The reason has to reach the escalation, or the operator learns only
      // that something did not happen.
      if (outcome.kind === "failed") expect(outcome.error).toContain("git status");
    },
    TIMEOUT_MS,
  );
});
