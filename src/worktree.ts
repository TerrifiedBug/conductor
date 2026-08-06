/**
 * Checkout provisioning for one run.
 *
 * Every issue gets its own working tree so two workers can never see each
 * other's half-finished edits. The trees are cut from a per-repo bare mirror
 * that is cloned once and refreshed, rather than a fresh full clone per issue:
 * a module repo's history is fetched one time and every later run pays only
 * for the delta.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { RepoTarget } from "./types.ts";

/**
 * Normal-clone fetch semantics. Deliberately *not* the mirror's own
 * `+refs/*:refs/*`: see `configureMirror`.
 */
const TRACKING_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

/** Matches the `user:token@` part of any URL, so it can be blanked out. */
const URL_USERINFO = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/g;

/**
 * The on-disk layout, in one place. Both are pure functions of config, so a
 * caller that has to clean up *before* provisioning — the dispatcher on a
 * retry, or reconciling orphaned trees at startup — can name a mirror or a
 * tree without a network hop, and cannot drift from what `ensureMirror` and
 * `addWorktree` will actually create.
 */
export function mirrorPathFor(repo: RepoTarget, mirrorRoot: string): string {
  return join(mirrorRoot, `${repo.name}.git`);
}

/** One tree per issue: a retry reuses the number, never the contents. */
export function worktreePathFor(workspaceRoot: string, issue: number): string {
  return join(workspaceRoot, String(issue));
}

/**
 * The one way this module runs git. Non-zero exit throws with the argv, the
 * exit code and stderr, because a bare "git failed" in a daemon log is worth
 * nothing at 3am.
 */
async function git(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // An unattended dispatcher must fail loudly rather than block forever on a
    // credential prompt nobody is there to answer.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    const where = cwd === undefined ? "" : ` (cwd ${cwd})`;
    const detail = stderr.trim() || stdout.trim() || "no output";
    // A clone URL can carry a token, and it lands in both our argv and git's
    // own error text; this string reaches logs and humans, so scrub it.
    throw new Error(
      `git ${args.join(" ")}${where} exited ${code}: ${detail}`.replace(
        URL_USERINFO,
        "$1***@",
      ),
    );
  }

  return stdout.trim();
}

/**
 * Rewrites the two `clone --mirror` defaults that are actively dangerous for a
 * cache we cut worktrees from. Applied on every `ensureMirror` so a mirror left
 * by an older build heals itself instead of behaving differently forever.
 *
 * - `remote.origin.mirror=true` makes a bare `git push` from *any* worktree of
 *   this repository behave as `push --mirror`, force-updating the remote from
 *   our local refs and deleting whatever we do not happen to have. Worktrees
 *   share the mirror's config, so that footgun is pointed straight at the
 *   worker.
 * - `fetch=+refs/*:refs/*` puts the upstream branches and our per-run branches
 *   in the same namespace, so a `--prune` refresh would try to delete every run
 *   branch that has not been pushed yet.
 *
 * With normal-clone semantics a refresh only ever moves `refs/remotes/origin/*`
 * and cannot touch a live run.
 */
async function configureMirror(mirrorPath: string): Promise<void> {
  await git(
    ["config", "--replace-all", "remote.origin.mirror", "false"],
    mirrorPath,
  );
  await git(
    ["config", "--replace-all", "remote.origin.fetch", TRACKING_REFSPEC],
    mirrorPath,
  );
}

/**
 * Returns the path of the bare mirror for `repo`, cloning it on first use and
 * refreshing it otherwise.
 *
 * ponytail: no cross-process lock. Two dispatch loops that call this for the
 * same repo at the same instant can collide on git's ref locks and one will
 * throw; the run is retried rather than corrupted. Upgrade path is a lockfile
 * in `mirrorRoot` keyed by repo name.
 *
 * ponytail: if `repo.cloneUrl` embeds credentials, `git clone` persists them in
 * the mirror's config, exactly as it would for a hand-run clone. Prefer an SSH
 * URL or an https URL backed by a credential helper.
 */
export async function ensureMirror(
  repo: RepoTarget,
  mirrorRoot: string,
): Promise<string> {
  mkdirSync(mirrorRoot, { recursive: true });
  const mirrorPath = mirrorPathFor(repo, mirrorRoot);

  if (existsSync(mirrorPath)) {
    await configureMirror(mirrorPath);
    await git(["remote", "update", "--prune"], mirrorPath);
    return mirrorPath;
  }

  try {
    await git(["clone", "--mirror", repo.cloneUrl, mirrorPath]);
  } catch (err) {
    // A half-written mirror would be seen as "present" by the next call and
    // fail in a much more confusing place. Retry from scratch instead.
    rmSync(mirrorPath, { recursive: true, force: true });
    throw err;
  }
  await configureMirror(mirrorPath);
  return mirrorPath;
}

/**
 * Provisions `<workspaceRoot>/<issue>` as a fresh worktree of `repo` on a new
 * branch cut from the upstream tip of its default branch, and returns the path.
 */
export async function addWorktree(
  repo: RepoTarget,
  mirrorRoot: string,
  workspaceRoot: string,
  issue: number,
  branch: string,
): Promise<string> {
  const mirrorPath = await ensureMirror(repo, mirrorRoot);
  mkdirSync(workspaceRoot, { recursive: true });

  const worktreePath = worktreePathFor(workspaceRoot, issue);
  if (existsSync(worktreePath)) {
    // Reusing a tree is how one worker silently inherits another attempt's
    // uncommitted edits and pushes them under this issue's name.
    throw new Error(
      `worktree path already exists: ${worktreePath}. Refusing to reuse it — ` +
        `it may hold a previous attempt's uncommitted work. Call ` +
        `removeWorktree(${mirrorPath}, ${worktreePath}) first.`,
    );
  }

  // The base ref has to be fetched by hand. The mirror's own copy of
  // `refs/heads/<defaultBranch>` is whatever the last refresh left behind (and
  // under normal-clone semantics is no longer refreshed at all), so branching
  // off it would silently start a run on a stale tip.
  const base = `refs/remotes/origin/${repo.defaultBranch}`;
  await git(
    [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${repo.defaultBranch}:${base}`,
    ],
    mirrorPath,
  );

  // `--no-track` because the start point is a remote-tracking ref: without it
  // git would set the run branch's upstream to the default branch, and the
  // worker's `git push` would then argue with `push.default` instead of
  // publishing the branch.
  await git(
    ["worktree", "add", "--no-track", "-b", branch, worktreePath, base],
    mirrorPath,
  );

  return worktreePath;
}

/**
 * Removes a run's worktree and its registration in the mirror. Idempotent: a
 * path that is already gone resolves, so cleanup can be retried and can run on
 * a run that never got as far as a checkout.
 *
 * ponytail: the run's branch stays in the mirror's `refs/heads/*`, since it may
 * be the only copy of work that has not been pushed. Mirrors therefore grow one
 * ref per run; upgrade path is reaping branches that are merged or have a
 * closed PR.
 */
export async function removeWorktree(
  mirrorPath: string,
  worktreePath: string,
): Promise<void> {
  if (!existsSync(mirrorPath)) {
    // No mirror means no registration left to clean up, and deleting a tree we
    // can no longer prove we created is not this function's call.
    return;
  }

  if (existsSync(worktreePath)) {
    try {
      await git(["worktree", "remove", "--force", worktreePath], mirrorPath);
    } catch (err) {
      // A path git does not recognise (hand-deleted, never registered) is fine
      // for cleanup's purposes. A path that survives the attempt is not: the
      // next run for this issue would trip over it.
      if (existsSync(worktreePath)) throw err;
    }
  }

  await git(["worktree", "prune"], mirrorPath);
}
