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

/** One git invocation, decoded. Nothing here judges the exit code. */
async function runGit(
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
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

  return { code, stdout, stderr };
}

/**
 * The one way this module runs git *for effect*. Non-zero exit throws with the
 * argv, the exit code and stderr, because a bare "git failed" in a daemon log
 * is worth nothing at 3am.
 */
async function git(args: string[], cwd?: string): Promise<string> {
  const { code, stdout, stderr } = await runGit(args, cwd);

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
 * The way this module runs git *as a question*. For plumbing like `show-ref`
 * a non-zero exit is the answer "no", not a failure, so it must not throw —
 * otherwise every probe needs a try/catch that also swallows real breakage.
 */
async function gitSucceeds(args: string[], cwd?: string): Promise<boolean> {
  const { code } = await runGit(args, cwd);
  return code === 0;
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
 * Provisions `<workspaceRoot>/<issue>` as a worktree of `repo` for `branch`,
 * and returns the path. On the first attempt the branch is cut from the
 * upstream tip of the default branch; on a retry the preserved branch is
 * reattached (see the comment on the add below).
 *
 * ponytail: reattachment is the only retry mode, so attempt 2 always inherits
 * attempt 1's tip — including a half-finished or broken state it might rather
 * start clean from. There is no "start from upstream but keep the old work"
 * option because that needs somewhere safe to park the old tip first. Upgrade
 * path: snapshot the branch to `refs/conductor/attempt/<issue>/<n>` before
 * resetting the run branch to `base`, and surface both refs in the escalation.
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

  // `--no-track` on the create path because the start point is a
  // remote-tracking ref: without it git would set the run branch's upstream to
  // the default branch, and the worker's `git push` would then argue with
  // `push.default` instead of publishing the branch. The reattach path must
  // *omit* the flag — git dies with "--[no-]track can only be used if a new
  // branch is created" — and does not need it, since checking out an existing
  // branch writes no tracking config at all.
  //
  // `-b` is only ever correct on the *first* attempt for an issue. Branch
  // names are a deterministic function of the issue number, `removeWorktree`
  // deliberately leaves the branch behind in the mirror, and `git worktree add
  // -b <existing>` is a hard error — so without this probe a second attempt
  // could never provision a tree and `maxAttemptsPerIssue` was fiction.
  //
  // The retry therefore *reattaches* the existing branch rather than doing
  // either of the two easier things. A fresh `<branch>-attempt2` would break
  // the fleet contract of one issue = one branch = one PR. A `branch -D` or a
  // force-reset to the upstream tip would be irreversible: that branch can
  // hold the only copy of work attempt 1 committed but never pushed. Attaching
  // to it hands the new worker attempt 1's commits, so it can continue or
  // recover them, and any destructive call stays a human's to make.
  const branchExists = await gitSucceeds(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    mirrorPath,
  );
  const addArgs = branchExists
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "--no-track", "-b", branch, worktreePath, base];

  try {
    await git(addArgs, mirrorPath);
  } catch (err) {
    // A hard crash can leave the branch registered to a worktree whose
    // directory is long gone, and git then refuses the add as "already checked
    // out". `prune` drops exactly that stale bookkeeping and never touches a
    // commit, so run it and retry once. It is not conditioned on git's wording
    // because that text is version- and locale-dependent; an add that is
    // broken for any other reason simply fails the same way twice.
    await git(["worktree", "prune"], mirrorPath);
    try {
      await git(addArgs, mirrorPath);
    } catch (retryErr) {
      const first = err instanceof Error ? err.message : String(err);
      const second =
        retryErr instanceof Error ? retryErr.message : String(retryErr);
      throw new Error(
        `failed to provision worktree ${worktreePath} for issue ${issue} on ` +
          `branch ${branch} (${branchExists ? "reattaching an existing branch" : "creating a new branch"}), ` +
          `both before and after \`git worktree prune\`: ${second} ` +
          `(first attempt: ${first})`,
      );
    }
  }

  return worktreePath;
}

/**
 * What one salvage attempt did. A failure is a *value* rather than a throw
 * because the only caller is a run that is already ending badly: it has to log
 * the outcome, word it into the escalation and still close its run record, and
 * none of that may be skipped by an exception from the last-ditch step.
 */
export type SalvageOutcome =
  | { kind: "salvaged"; sha: string; branch: string; pushed: boolean; pushError?: string }
  /** Nothing uncommitted was there to save — a clean tree, or no tree at all. */
  | { kind: "nothing" }
  /** There was work and git would not commit it. This is the loud one. */
  | { kind: "failed"; error: string };

/**
 * The salvage commit is the daemon's own, made unattended in a worktree whose
 * config it does not control. A machine with no global git identity, a global
 * `commit.gpgsign=true` whose key needs a passphrase nobody can type, or a repo
 * pre-commit hook that rejects half-finished code are all ordinary states — and
 * every one of them would turn "save the work" into "lose the work". So the
 * commit brings its own identity, signs nothing, and skips hooks: it is a
 * snapshot for a human to sort out, never something anyone merges.
 */
const SALVAGE_COMMIT_CONFIG = [
  "-c",
  "user.name=conductor",
  "-c",
  "user.email=conductor@invalid",
  "-c",
  "commit.gpgsign=false",
];

/**
 * Shapes a worker creates for itself and no one else ever wants committed: a
 * local env helper, a scratch directory, a debug dump, an editor's droppings.
 *
 * Excluded from salvage rather than left to each repo's `.gitignore`, because
 * salvage runs against whatever repo the fleet was pointed at and cannot assume
 * the operator has anticipated this. A repo that *does* ignore them loses
 * nothing here — the patterns simply never match.
 *
 * Deliberately narrow. Anything ambiguous belongs in the commit, because the
 * cost of over-keeping is a reviewer deleting a file, and the cost of
 * over-skipping is the destroyed work this whole mechanism exists to prevent.
 */
const SALVAGE_EXCLUDES = [
  ":(exclude).scratch*",
  ":(exclude)**/.scratch*",
  ":(exclude).env.local",
  ":(exclude)**/.env.local",
  ":(exclude)*.local.sh",
  ":(exclude)**/*.local.sh",
];

/**
 * Commits a dead run's uncommitted work to the run's own branch and pushes it,
 * so that the tree the next attempt destroys is no longer the only copy.
 *
 * This closes a deliberate asymmetry. `addWorktree` preserves the run branch
 * precisely because "that branch can hold the only copy of work attempt 1
 * committed but never pushed", while `removeWorktree` runs `worktree remove
 * --force` and `addWorktree` refuses to reuse a tree that "may hold a previous
 * attempt's uncommitted work" — committed work is kept by design, uncommitted
 * work is discarded by design. That trade is fair for a worker that *stops*:
 * blocking is a decision it makes with turns left to commit first. It is not
 * fair for one killed by the turns cap or the wall clock, or one that crashes:
 * that end is external, unannounced, mid-sentence, and it lands hardest on the
 * long refactors carrying the most unsaved work. So: non-graceful ends only.
 *
 * Never throws. Every outcome, including its own failure, comes back as a value
 * for the caller to log and to put in front of a human.
 *
 * The push is best-effort and deliberately last, after the sha exists: a
 * refused push (diverged branch, no credentials, no network) still leaves the
 * commit in this host's mirror, which is strictly better than nothing. It is a
 * plain fast-forward push — never a force — and if the run already had a PR
 * open, that PR gains the WIP commit and re-runs its checks. That is the price
 * of work outliving its host, and only a run that already failed ever pays it.
 */
export async function salvageWip(
  worktree: string,
  issue: number,
  attempt: number,
  reason: string,
): Promise<SalvageOutcome> {
  try {
    // A tree that is not there cannot be holding work. Checked before spawning
    // git, because a missing cwd fails at spawn time rather than as an exit
    // code, and "no tree" is not a salvage failure worth alarming anyone with.
    if (!existsSync(worktree)) return { kind: "nothing" };

    if ((await git(["status", "--porcelain"], worktree)) === "") return { kind: "nothing" };

    // The tree's own branch, not one the caller believes it should be on: this
    // string ends up in an escalation as the place to go looking.
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], worktree);

    // `-A` on purpose: the losses this exists for were mostly *new* files.
    // Everything except the shapes below, which are a worker's own scaffolding
    // — a local env helper, a scratch dir, a debug dump. They are worthless to
    // the next attempt and actively harmful in a pushed commit: on 2026-08-07 a
    // salvage swept up a `.scratch82/env.sh` of loopback dev defaults, which
    // read enough like a leaked secret that the orchestrator broke its own
    // "never touch a worker's branch" boundary trying to scrub it. Excluding
    // them is cheaper than every future reader having to judge them.
    await git(["add", "-A", "--", ".", ...SALVAGE_EXCLUDES], worktree);

    // The dirty check above ran before the excludes, so a tree whose only
    // changes were scratch had work by that test and has none by this one.
    // Without this, `commit` exits non-zero on an empty index and a tree
    // holding nothing worth keeping gets reported as a salvage *failure*.
    if ((await git(["diff", "--cached", "--name-only"], worktree)) === "") {
      return { kind: "nothing" };
    }
    await git(
      [
        ...SALVAGE_COMMIT_CONFIG,
        "commit",
        "--no-verify",
        "-m",
        `wip(#${issue}): attempt ${attempt} killed by ${reason} — auto-salvaged`,
      ],
      worktree,
    );
    const sha = await git(["rev-parse", "HEAD"], worktree);

    if (branch === "HEAD") {
      // Detached: the commit is real but reachable only by sha, and pushing
      // `HEAD` from here would publish a branch literally named HEAD.
      return {
        kind: "salvaged",
        sha,
        branch,
        pushed: false,
        pushError: "detached HEAD — no branch to push",
      };
    }

    const push = await runGit(["push", "origin", `HEAD:refs/heads/${branch}`], worktree);
    if (push.code === 0) return { kind: "salvaged", sha, branch, pushed: true };

    return {
      kind: "salvaged",
      sha,
      branch,
      pushed: false,
      pushError: (
        push.stderr.trim() ||
        push.stdout.trim() ||
        `git push exited ${push.code}`
      ).replace(URL_USERINFO, "$1***@"),
    };
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
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
