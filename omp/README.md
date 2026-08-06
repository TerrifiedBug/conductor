# omp-conductor

A 24/7 dispatcher that takes `ready-for-agent` GitHub issues to green, mergeable
PRs using omp coding sessions. When a run cannot finish on its own it escalates in
tiers: first to an orchestrator session that can re-brief the worker, then to you.

## What it is

You label an issue. Within one tick the conductor claims it on the tracker, cuts a
worktree, hands one omp session a self-contained brief, watches it to a green PR —
and then stops. Merging is a human act; the conductor never performs it.

### Scope

One issue, one green PR. That is the whole remit.

Merging is a human act, and so is releasing. Releases are **batched** — cut from a
coherent group of merged work by a human-supervised decision, never one per PR — so
nothing in this package tags, pins, deploys or publishes, and no worker is ever
asked to. A worker whose change needs releasing reports that and stops.

Every limit that decides whether work starts is counted in code, not asked of the
model: concurrency, issues per day, dollars per day, turns and wall clock per
worker, attempts per issue. A worker asked to respect a budget eventually talks
itself out of it, so the dispatcher enforces the budget before anything is claimed
and kills anything over the line.

When a run does get stuck, the first responder is not you. A tier-1 escalation is
injected into a long-lived **orchestrator session** that can read the issue and the
run's transcript and then either re-brief the worker or decide the problem genuinely
needs a human. It never edits product code, pushes or merges. Only tier 2 pages you
directly.

The package ships two deployables:

| Deployable | Entry | What it is for |
| --- | --- | --- |
| omp plugin | `/conductor` slash command | Inspect and arm the conductor from inside an omp session: dry-run the queue, read status, pause, resume. |
| Standalone daemon | `omp-conductor` binary | The dispatch loop, managed as a background process (`start` / `stop` / `restart`) with a `/healthz` endpoint for a supervisor. |

Both are thin wrappers over the same `daemon.ts`, so the plugin and the CLI cannot
disagree about what a cap means or where the state lives.

## Install

```bash
omp plugin install omp-conductor
```

`@oh-my-pi/pi-coding-agent` (`>=17.1.4`) is a **peer dependency** and must already
be present. If you run omp, it is.

Also required on the host:

- `bun` — the CLI and the daemon run on it (`Bun.serve` backs `/healthz`).
- `gh`, already authenticated — every tracker operation shells out to it, so the
  daemon never handles a GitHub token itself.
- `git` — mirrors and worktrees.

## Quick start

1. Write a config (see [Configuration](#configuration)) at
   `~/.omp/conductor/config.json`.
2. From an omp session:

   ```text
   /conductor setup
   ```

   This is a **dry run first**. It reads the tracker through the same routing code
   the loop uses and prints exactly what the next tick would pick up, which repo
   each issue routes to, the branch it would cut, and every issue that cannot be
   routed. **Nothing is mutated** — no label written, no run row, no worktree —
   until you answer the "Arm omp-conductor?" confirmation. Arming does exactly two
   things: create the state database, and clear the pause flag. Declining leaves
   the machine untouched.

3. Start the daemon in the background:

   ```bash
   omp-conductor start
   ```

   `start` does not report success until the daemon actually answers
   `GET /healthz`. Spawning is not starting: a daemon whose config is broken, whose
   port is taken or whose database is locked exits within a second, and a `start`
   that printed "started" for it would hand you a lie you discover only when work
   silently fails to be picked up. On failure the error quotes the tail of
   `daemon.log`. It refuses to start a second daemon, naming the pid of the live one.

   For a first run, take a single tick in the foreground and watch it:

   ```bash
   omp-conductor daemon --once
   ```

The loop ticks every 5 minutes. `omp-conductor stop` sends `SIGTERM`, and the loop
shuts down after the current tick rather than mid-run.

## How one tick works

Per tick, for the daemon's project:

1. **Paused?** If the pause sentinel exists, the tick claims nothing and returns.
   Pause is checked first, so `omp-conductor pause` takes effect on the next tick
   without signalling the process.
2. **List the queue.** Open issues in `tracker.repo` labelled `queueLabel`.
3. **Filter and route.** An issue is eligible only if it carries the queue label
   and none of the three state labels (`inProgress`, `blocked`, `failed`). Eligible
   issues are partitioned into routable and unroutable.
4. **Escalate the unroutable** at Tier 1, quoting the repo labels actually seen and
   the configured repo names. These are never dispatched.
5. **Check spend.** If spend since local midnight has reached `dailySpendUsd`, the
   daemon **pauses itself**, pages at Tier 2, and returns.
6. **Check capacity.** `maxConcurrentWorkers` minus active runs gives the free
   slots; `maxIssuesPerDay` minus runs started today gives the day budget. If
   either is exhausted, the tick logs and returns.
7. **Admit issues** up to those two counters, skipping any issue that already has
   an active run. An issue that has used `maxAttemptsPerIssue` escalates at Tier 1
   instead of being admitted.
8. **Dispatch** the admitted issues concurrently.

Then, per admitted issue:

1. **Apply the `agent:in-progress` label — before any worktree or session exists.**
   This ordering is the whole crash-safety story: the label, not the local
   database, is the guard against dispatching the same issue twice. If the process
   dies at any later point, the next daemon sees the label, eligibility filters the
   issue out, and a human decides what to do with the orphan. A store that is lost
   can be rebuilt from the tracker; a label that was written too late cannot undo a
   duplicate PR.
2. Create the run row (`claimed`).
3. Clear any stale tree for this issue, then add a fresh worktree at
   `<workspaceRoot>/<issue>` cut from the bare mirror at `<mirrorRoot>/<repo>.git`,
   on the run's branch off the repo's default branch.
4. Allocate a session transcript under `<state dir>/sessions/`, one per attempt,
   and move the run to `running`. The run record keeps the exact path and a
   failure escalation quotes it, so you can read what the worker actually did.
5. Run one omp session with the rendered brief, under the turn and wall-clock caps.
6. Record the outcome:

   | Outcome | Labels | Worktree | Escalation |
   | --- | --- | --- | --- |
   | `pushed-green` | `agent:in-progress` stays until the merge closes the issue | removed | none |
   | `blocked` | swapped to `agent:blocked` | removed | Tier 1 |
   | `failed` / `killed` | swapped to `agent:failed` | **kept** as evidence | Tier 1 |
   | unexpected error | swapped to `agent:failed` | kept | Tier 1 |

   Label swaps add the new label before removing the old one: the reverse order
   leaves a window in which the issue carries no state label at all, which is
   exactly the shape eligibility reads as fresh work.

### Branch names

`<type>/<slug>`, where the type is `fix` when any label's last segment (after `:`
or `/`) is `bug`, and `feat` otherwise. The slug is the issue title folded to
`[a-z0-9-]`, and the whole ref is capped at 60 characters. It is computed from the
issue alone, so a retried run recomputes the same branch and finds its own work
instead of forking a second one.

## Routing

An issue must carry **exactly one** `repo:<name>` label naming a repo in
`routing.repos`. The prefix is `routing.labelPrefix` and defaults to `repo:`.

Routing never guesses. An issue it cannot resolve to a single configured checkout
is handed back as unroutable:

| Reason | Condition |
| --- | --- |
| `no-repo-label` | The issue carries no label starting with the prefix. |
| `multiple-repo-labels` | It carries two or more distinct prefixed labels. A repeated identical label is deduplicated, not treated as an ambiguity. |
| `unknown-repo` | Its single prefixed label names a repo that is not in `routing.repos`. |

In all three cases the issue is **escalated at Tier 1 and never dispatched**. The
fix is always the same, and the escalation says so: put exactly one
`repo:<name>` label on the issue.

This is deliberate. A request that spans two repos, taken whole by one worker, is
the precise failure this guard exists to prevent: the worker cannot open a PR
against two checkouts, so it improvises — it vendors a copy, edits the wrong repo,
or produces a PR that cannot be merged without the other half. Splitting a
multi-repo request is a human decision about contracts, not something to infer from
a label. Sending the issue back costs a label edit; guessing costs a bad merge.

## Caps

Caps resolve per project: the global `defaults` block, then the project's own
`caps` layered on field by field, so a project that pins one cap still inherits the
rest. `0` is a real value (a hard stop), not "unset".

| Cap | Default | What it protects |
| --- | --- | --- |
| `maxConcurrentWorkers` | `2` | Parallel omp sessions. Two, because **CI runner slots, not model tokens, are the usual throughput ceiling** — a third worker would starve its own PR checks on a small self-hosted runner pool. Raise it only if you actually have the runners. |
| `maxIssuesPerDay` | `6` | Blast radius per rolling day: how much unattended churn a bad label sweep can push into the tracker before a human sees it. |
| `dailySpendUsd` | `25` | Rolling-day spend ceiling. The one cap that stops the fleet rather than deferring work. |
| `workerMaxTurns` | `120` | Turn ceiling for one worker. Catches a session looping without converging. |
| `workerWallClockMs` | `5400000` (90 minutes) | Wall-clock ceiling for one worker. A session that is merely stuck spends no turns, so turns alone cannot detect it. |
| `maxAttemptsPerIssue` | `2` | Retries per issue before it escalates. One clean retry recovers from flaky CI; a third attempt almost always means the issue itself is underspecified. |

Days are counted from **local midnight**, matching how a human reads "today".

Hitting `dailySpendUsd` is not the same as hitting the other caps. Concurrency and
daily-volume limits simply defer work to a later tick. The spend cap **pauses the
daemon and pages at Tier 2**: a loop that is burning money has to halt itself,
because waiting for someone to notice tomorrow is how a runaway becomes expensive.
Work resumes only after `omp-conductor resume` (or `/conductor resume`).

`workerMaxTurns` and `workerWallClockMs` are enforced inside the session driver: the
run is aborted, recorded as `killed`, and the escalation names which ceiling fired.

## Escalation tiers

| Tier | Meaning | Raised by | Delivered to |
| --- | --- | --- | --- |
| 1 | "Not a human's problem yet" — the run is parked and safe. | Unroutable issue, blocked run, failed or killed run, dispatch error, attempts exhausted. | The orchestrator session, as an injected prompt. Falls back to an issue comment when no orchestrator is running, or when it will not accept the injection. |
| 2 | "The fleet is stopped until you look." | Daily spend cap reached; the project is already paused. | Telegram, when `escalation.telegramChatId` is set and a bot token is readable; otherwise it falls back to the issue comment. |

**The orchestrator** is one persistent, file-backed session per daemon run, resumed
across restarts so it remembers what it has already handled. Its `cwd` is the state
directory, deliberately not a checkout. Delivery resolves when the harness *accepts*
the prompt, not when the model answers it, so a tick never parks behind a model; an
injection arriving mid-thought queues as a follow-up instead of interrupting the
turn in flight. Its standing orders are explicit: re-brief the worker, file or
comment on issues, or promote to tier 2 — and never edit product code, push a branch
or merge a PR. If it fails to start, the daemon logs a warning and runs on, with
tier-1 escalations degraded to issue comments.

Tier 2 borrows the bot token that `omp-telegram` already owns, at
`~/.omp/agent/telegram/.env` (or `$OMP_TELEGRAM_STATE_DIR/.env`). If you run that
bot, Tier 2 needs no extra configuration beyond the chat id. If the token is
absent, Tier 2 degrades to the issue comment rather than failing. The token is
never logged, and it is redacted out of any error text that could reach a public
issue comment.

**Escalations are deduplicated.** The dispatcher re-notices the same unroutable
issue on every poll, so a ledger in the store — keyed by project, issue, tier and
summary — makes a recurring condition page **once**, not every five minutes. The
marker is recorded only on successful delivery, so a page that could not be
delivered is retried on the next tick instead of being written off as sent. The
spend-cap summary carries the date, so the same cap pages again tomorrow but only
once per day.

If `fallbackToIssueComment` is off and no Telegram transport is configured,
delivery throws rather than dropping silently — the failure is logged and retried,
because a swallowed escalation looks exactly like a healthy fleet.

## Configuration

The config lives at `$OMP_CONDUCTOR_HOME/config.json`, or
`~/.omp/conductor/config.json` when that variable is unset. It is written with mode
`0600` in a directory created `0700`, because it carries chat ids and clone URLs.
That same directory holds the SQLite store (`conductor.db`), the `paused` sentinel,
the `sessions/` worker transcripts and the `orchestrator/` session directory.

Runtime state lives elsewhere, under `$OMP_CONDUCTOR_RUNTIME_DIR` (default
`~/.omp/run/daemons/omp-conductor`): `daemon.json`, a mode-`0600` pidfile written
atomically, and `daemon.log`, appended across every boot so the previous failure is
still there when you go looking. It is kept apart from the config directory because
it is meaningless after a reboot, and the pidfile's liveness is probed on every
read — a stale one never blocks a `start`.

The file is validated on every read. A malformed config produces one readable error
listing every fault, and the daemon refuses to start rather than running with half
a project.

A complete, valid config for one project with two target repos:

```json
{
  "version": 1,
  "defaults": {
    "maxConcurrentWorkers": 2,
    "maxIssuesPerDay": 6,
    "dailySpendUsd": 25,
    "workerMaxTurns": 120,
    "workerWallClockMs": 5400000,
    "maxAttemptsPerIssue": 2
  },
  "projects": [
    {
      "name": "veltro",
      "tracker": { "kind": "github", "repo": "TerrifiedBug/veltro" },
      "queueLabel": "ready-for-agent",
      "stateLabels": {
        "inProgress": "agent:in-progress",
        "blocked": "agent:blocked",
        "failed": "agent:failed"
      },
      "routing": {
        "labelPrefix": "repo:",
        "repos": {
          "chad": {
            "name": "chad",
            "cloneUrl": "git@github.com:TerrifiedBug/chad.git",
            "defaultBranch": "main",
            "gates": [
              { "cmd": "bun run lint", "cwd": "frontend" },
              { "cmd": "bun run typecheck", "cwd": "frontend" },
              { "cmd": "pytest -q", "cwd": "backend" }
            ]
          },
          "warden": {
            "name": "warden",
            "cloneUrl": "git@github.com:TerrifiedBug/warden.git",
            "defaultBranch": "main",
            "gates": [
              { "cmd": "ruff check .", "cwd": "." },
              { "cmd": "pytest -q", "cwd": "backend" }
            ]
          }
        }
      },
      "caps": {
        "maxIssuesPerDay": 4,
        "dailySpendUsd": 15
      },
      "escalation": {
        "telegramChatId": "123456789",
        "fallbackToIssueComment": true
      },
      "workspaceRoot": "~/.omp/conductor/worktrees",
      "mirrorRoot": "~/.omp/conductor/mirrors"
    }
  ]
}
```

Field notes:

| Field | Notes |
| --- | --- |
| `version` | Must be `1`. Present from day one so a format change can be migrated instead of silently misread. |
| `defaults` | Every `Caps` field. Anything omitted falls back to the built-in default. |
| `tracker.repo` | `owner/repo`. `tracker.kind` may be omitted; `"github"` is the only accepted value. |
| `queueLabel` | The one label meaning "a human has signed this off as agent-ready". Matched exactly, case-sensitively. |
| `stateLabels` | Optional; defaults to `agent:in-progress`, `agent:blocked`, `agent:failed`. |
| `routing.labelPrefix` | Optional; defaults to `repo:`. |
| `routing.repos` | At least one entry, or nothing can be routed. `name` defaults to the map key, `defaultBranch` to `main`. |
| `gates` | The exact cheap commands CI also runs, each with the `cwd` it runs from (`cwd` defaults to `.`). Running the real gate locally is what makes an unattended push safe — a subset lets an error outside the source dir reach the runners. |
| `caps` | Per-project overrides; omit it or pin only the fields you want to change. |
| `escalation.fallbackToIssueComment` | Defaults to `true`. Absent means "yes, still tell me". |
| `workspaceRoot` / `mirrorRoot` | Optional; default to `worktrees/` and `mirrors/` under the state directory. `~` is expanded. |

Prefer an SSH `cloneUrl`, or an https URL backed by a credential helper. A clone URL
with credentials embedded is persisted into the mirror's git config, exactly as it
would be for a hand-run clone.

## CLI reference

```bash
omp-conductor start [--port N] [--project NAME]
omp-conductor stop
omp-conductor restart [--port N] [--project NAME]
omp-conductor status [--project NAME]
omp-conductor daemon [--once] [--port N] [--project NAME]
omp-conductor pause
omp-conductor resume
omp-conductor help
```

| Command | Behaviour |
| --- | --- |
| `start` | Spawn the loop in the background, detached, and wait until it answers `GET /healthz` on `:8787`. Refuses if one is already live, naming its pid. If the process dies or never serves, `start` cleans up after it and quotes the tail of `daemon.log`. |
| `stop` | `SIGTERM`, then `SIGKILL` after a 10-second grace period. Prints `not running` when there is nothing to stop. |
| `restart` | `stop` then `start`, inheriting the running daemon's port and project unless a flag overrides them — a restart that quietly moved to the default port would leave every existing health check pointing at nothing. |
| `status [--project NAME]` | Pause state, config and state paths, resolved caps, active runs and today's usage, plus a `daemon` block: pid, uptime, port, project, `/healthz` result and log path. Reads while a daemon in another process writes. |
| `daemon` | Run the loop in the **foreground**, ticking every 5 minutes and serving `/healthz`. This is what `start` launches. |
| `daemon --once` | Run a single tick and exit. No HTTP server. |
| `--port N` | Accepted by `start`, `restart` and `daemon`. Both `--port 9000` and `--port=9000` work; missing or out of range exits `2` rather than falling back to the default, because probing the wrong endpoint is worse than a hard failure. |
| `--project NAME` | Pick the project to service. One daemon process serves exactly one project; with several configured projects the name is required. |
| `pause` | Stop claiming new work. The running daemon notices on its next tick; runs already in flight finish. |
| `resume` | Allow claiming again. |
| `help`, `--help`, `-h` | Print usage. An unknown or missing verb prints it too, and exits `2`. |

Pause is a flag file under the state directory, so it applies to every project and
survives a daemon restart.

Four of these are available in-session as `/conductor setup`, `/conductor status`,
`/conductor pause` and `/conductor resume`, each taking an optional project name as
a second word. Background-process management is CLI-only: the plugin does not
start, stop or restart the daemon.

### Health endpoint

```bash
curl -s localhost:8787/healthz
```

```json
{ "ok": true, "paused": false, "activeRuns": 1, "project": "veltro" }
```

Any other path or method returns `404`. Note that `ok` reports that the process is
serving, not that the fleet is doing work — read `paused` to tell those apart.

## What a worker may and may not do

Each worker gets one brief, one worktree, one branch, and no knowledge of the
dispatcher. The brief is explicit about the boundary:

| It may | It must not |
| --- | --- |
| Read the issue and the repo's own guidance (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, relevant ADRs) before writing anything. | Touch any path outside its worktree, or switch branches. |
| Edit code inside its own worktree. | Weaken, skip, delete or loosen **any test it did not write** — that is a design question to escalate, and it is checked by diff review before the push. |
| Add or update tests for behaviour it introduced. | Suppress a warning, delete an assertion, or special-case an input to make a check pass. |
| Run the repo's configured cheap gates, each from its listed `cwd`, over the whole tree. | Run docker or image builds, production builds, browser/e2e suites, or the full test suite on the shared host — CI owns the heavy gates. |
| Review its whole diff, then commit and **push once**. One corrective push if CI is red. | Force-push, `git add -f`, or add AI/co-author attribution. Red twice means stop and report, not push a third time. |
| Open a PR that links the issue, and watch CI to a verdict with `gh pr checks --watch`. | Run `gh pr merge`. **Merge authority is a human's alone**, so PRs land one at a time with a freshness re-check — two workers merging concurrently is how agent PRs clobber each other. |
| Escalate: ambiguity, a cross-repo contract, a needed credential, a product or data-migration decision, a blocking existing test, CI red twice, or most of the wall-clock budget burned. | **Cut a release**, push a tag, publish to npm, edit a deployment pin, deploy, or touch infrastructure or secrets — permanently out of scope. Releases are batched and decided outside this loop, so "this needs releasing" is a thing to report, never a task to take on. |

The worker ends with a six-line evidence report (issue, pr, state, gates, changed,
next). `pushed-green` means it watched the checks go green, not that it expects
them to.

## Limitations

Known and deliberate in this version:

- **`gh` is shelled out to.** Every tracker operation spawns a process and does its
  own TLS handshake (roughly 200-400 ms each), and failures are classified by
  matching human-readable stderr rather than a status code. The upside is that no
  token is ever handled, stored or logged by the daemon.
- **`listReady` fetches a single page of 100 issues.** A queue deeper than 100
  ready issues truncates silently. A backlog that size is a staffing problem before
  it is a paging one.
- **Spend accounting depends on harness telemetry.** Cost arrives only when the
  harness run carries it; without it `spendUsd` reads `0`, `status` shows `$0.00`,
  and the daily-spend cap never fires — the turn and wall-clock ceilings are what
  actually bound a runaway in that case. Do not treat `$0.00` as proof that nothing
  was spent.
- **GitHub is the only tracker.** The internal `Tracker` port is deliberately
  provider-neutral, but `tracker.kind` accepts only `"github"` today.
- **One project per daemon process.** Several projects means several processes,
  each with `--project` and its own `--port`.
- **Labels are matched exactly and case-sensitively.** `Ready-For-Agent` is not
  `ready-for-agent`, and the mismatch is silent — the issue is simply never picked
  up.
- **No cross-process lock on the mirrors.** Two dispatch loops fetching the same
  repo at the same instant can collide on git's ref locks; the run fails and is
  retried rather than corrupted.
- **Mirrors grow one branch ref per run.** Unpushed work is never discarded, so
  refs accumulate until you reap them.
- **`stop` is a deadline, not a clean drain.** `SIGTERM` asks the loop to finish the
  tick it is on, and a tick with a worker in flight can run for that worker's whole
  wall clock; after 10 seconds it is `SIGKILL`. There is no "stop once the current
  worker lands".
- **A failed orchestrator degrades quietly.** The daemon logs a warning and keeps
  running, but tier-1 escalations then land in issue comments — which is exactly the
  "nobody reads it until morning" path the orchestrator exists to avoid. The warning
  is in `daemon.log`; nothing pages you about it.
- **Merges, releases and deploys are human-only, by design.** The conductor
  produces green PRs and stops.

## License

MIT
