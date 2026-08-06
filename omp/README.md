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

The package ships three deployables, plus one skill:

| Deployable | Entry | What it is for |
| --- | --- | --- |
| omp plugin | `/conductor` slash command | Inspect and arm the conductor from inside an omp session: dry-run the queue, read status, pause, resume. |
| Standalone daemon | `omp-conductor` binary | The dispatch loop, managed as a background process (`start` / `stop` / `restart`) with a `/healthz` endpoint for a supervisor. |
| Orchestrator heartbeat | omp extension, activated by `.conductor-tick.json` | Prompts a 24/7 orchestrator session on a fixed interval so its standing loop actually runs. Inert in every other session. See [Orchestrator tick](#orchestrator-tick). |
| Onboarding skill | `skill://conductor-onboarding` | Directs an omp session to interview you, read your repos for real CI gates, and tailor `ORCHESTRATOR.md` — then finish through the wizard. Discovered automatically once the plugin is installed. See [Onboarding](#onboarding). |

The first two are thin wrappers over the same `daemon.ts`, so the plugin and the
CLI cannot disagree about what a cap means or where the state lives. The heartbeat
reads the same pause flag both of them write.

## Your workflow vs. the package

**This package stops at green PRs.** The boundary is in the worker brief and in
the loop itself: no worker merges, tags, pins, deploys or publishes, and neither
does the orchestrator. Everything past a green PR — when to merge, what to batch
into a release, what to deploy — is *your* workflow, and the package deliberately
holds no opinion about it that it could act on.

Your opinion goes in `ORCHESTRATOR.md`, the standing prompt for the long-lived
session that supervises the fleet. That file is yours: the conductor renders it
once, on request, and then never reads it back, never rewrites it and never
enforces a word of it. What you write there binds your orchestrator session, not
this package.

`/conductor setup` offers to render the shipped template
(`src/briefs/orchestrator.md`) to `<workspaceRoot>/ORCHESTRATOR.md` with your
project's coordinates filled in, and never replaces an existing file without a
second, explicit confirmation. It is a starting point, not a contract:

| Section | Whose |
| --- | --- |
| Duties (drain, groom, report), escalation tiers, hard boundaries | **Fixed** — they describe how this package already behaves. |
| Releases | **Yours.** Ships defaulting to "humans release; the conductor and its workers never tag, pin, deploy, or publish". Replace it only if you are deliberately delegating releases to that session — and then be specific about what, when, on what proof, and what stays permanently forbidden. |
| Reporting | **Yours**, seeded from the scope you chose in setup. |

Reporting is the one half of that the config also knows about, because the wizard
has to ask something in order to seed the brief — and the one half the runtime
acts on:

| `reporting.scope` | What the orchestrator says unprompted | The line every tick carries |
| --- | --- | --- |
| `material` (default) | Escalations, plus every material event: a run reaching a green PR, a run that failed twice, an issue pulled off the queue, a cap that stopped the fleet. | `Report material events per your brief.` |
| `escalations` | Escalations when they happen, plus one daily digest. Silent otherwise. | `Report NOTHING this turn except a Tier 1 or Tier 2 escalation; everything else -- releases included -- waits for the daily digest.` |

**What the scope does:** the [orchestrator heartbeat](#orchestrator-tick) appends
that line to every tick it sends, so the reporting contract arrives with the
prompt instead of only in a brief the session read hours ago. It is re-read from
`~/.omp/conductor/config.json` on **every** tick, so turning the volume up or
down — `/conductor setup` again, or an edit to the file — binds the next tick
without restarting the session. Three cases fall back to `material`: no config
yet, an unreadable or invalid one, and several projects with none named — the
same ambiguity `status` refuses to guess through. Stopping the heartbeat over a
reporting preference would be the worse trade, so it ticks on the default and
logs the reason once.

**What it does not do:** there is no hard outbound filter. Nothing inspects the
orchestrator's messages and drops the ones your scope did not ask for, so a
session that ignores its constraint line still reaches you. Scope is a
constraint the model is handed each turn, not a gate it is held to — the
enforcement roadmap (a tool-call tripwire, and config-versus-behaviour drift in
the daily digest) is
[issue #4](https://github.com/TerrifiedBug/conductor/issues/4).

Changing the key later does not rewrite an `ORCHESTRATOR.md` you already have:
the tick line changes, the brief does not. Edit its Reporting section too, or the
session is carrying two versions of your policy.

## Where issues come from

**GitHub Issues is the only supported tracker in v1.** `tracker.kind` accepts
exactly one value, `"github"`, and every tracker operation shells out to your
already-authenticated `gh` CLI — the conductor never stores a token of its own.
Gitea, Jira, and file-based trackers are not supported yet; the seam for them is
`src/tracker/github.ts`, which implements the whole six-method `Tracker`
interface in `src/types.ts` (`listReady`, `addLabel`, `removeLabel`, `comment`,
`close`, `linkParent`) that a future backend would swap in.

You tell the conductor where to look with three keys, all in
`~/.omp/conductor/config.json` (the [Configuration](#configuration) section has
the full annotated example, and `/conductor setup` will interview you for these
and create any missing labels):

| Key | Meaning |
| --- | --- |
| `tracker.repo` | The **one** `owner/repo` whose issue list is the queue. This is your planning repo — it does not have to contain any code. |
| `queueLabel` | Open issues in `tracker.repo` carrying this label (default `ready-for-agent`) are the work queue. Nothing else is ever read. |
| `routing.repos` + `repo:<name>` labels | Each queued issue must also carry exactly one routing label naming which code repo the work lands in. The conductor cuts the worktree and PR there, from `routing.repos[name].cloneUrl`. An issue with zero or two routing labels is reported as unroutable and skipped — never guessed. |

So: one tracker repo supplies the queue, routing labels fan issues out to any
number of code repos, and both label names are yours to configure.

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

## Onboarding

Onboarding this package has two layers, and installing it gives you both.

| Layer | What it is | What it owns |
| --- | --- | --- |
| **`/conductor setup`** | The deterministic wizard. Closed questions, a label plan, a dry run, one confirm. | **Mechanical config.** It is the only thing that writes `config.json`, and it mutates nothing before you confirm. |
| **`skill://conductor-onboarding`** | A skill bundled in this package (`skills/conductor-onboarding/SKILL.md`), discovered automatically by any omp session once the plugin is installed. | **Brief authoring.** The judgement the wizard cannot prompt for. |

The split exists because the two halves fail differently. A wrong config value is
a run that errors on the next tick; a wrong release boundary is a fleet that
publishes something at 03:00. The first is worth a text prompt with validation.
The second is worth an interview.

So the skill does the part a dialog cannot:

- **Interviews you** on release policy — humans release (the default), the agent
  releases to a named boundary, or the agent releases fully — pressing on the one
  question that makes a delegated release safe: *where does the agent's leg end?*
  Plus escalation taste, and which of the two [`reporting.scope`](#your-workflow-vs-the-package)
  values your answer actually maps to.
- **Reads your repos instead of asking about them.** It opens each routing repo's
  CI workflows, `package.json` scripts and `Makefile`/`justfile`, then *proposes*
  the exact pre-push [gates](#configuration) with the `cwd` each runs from — so
  the gates match what CI runs, rather than what you remembered it runs.
- **Tailors `ORCHESTRATOR.md`** from the shipped template. The template is the
  floor: it rewrites the Releases and Reporting sections from your answers, adds
  the hard boundaries only you know about (infra directories, off-limits repos),
  leaves the fixed sections alone, and shows you the diff before writing.
- **Verifies the worker brief's assumptions** against reality: default branch per
  repo, whether the branch names the conductor cuts survive your branch
  protection, whether each proposed gate exists and exits 0 on a clean checkout,
  and whether `pull_request` actually fires — a workflow that never triggers on a
  PR gives a worker no checks to watch and no verdict to reach.
- **Then finishes through the wizard**, so the dry run and the consent gate still
  do the writing.

From an omp session with the plugin installed, just say what you want — "help me
set up conductor", "onboard me", "configure the fleet" all reach it, because that
is what the skill's description matches on. With `skills.enableSkillCommands`
turned on you can also invoke it directly:

```text
/skill:conductor-onboarding
```

Nothing about the wizard changes: `/conductor setup` on its own remains a
complete, supported path, and the brief it renders is safe unedited.

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

   Two of its questions are about you rather than the fleet: how loud the
   orchestrator should be (`reporting.scope`), and whether to write an
   `ORCHESTRATOR.md` you then own — see
   [Your workflow vs. the package](#your-workflow-vs-the-package). If you would
   rather be interviewed through those two, and have the brief tailored and your
   gates read out of your CI config, start from
   [Onboarding](#onboarding) instead.

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
      "name": "demo",
      "tracker": { "kind": "github", "repo": "acme/planning" },
      "queueLabel": "ready-for-agent",
      "stateLabels": {
        "inProgress": "agent:in-progress",
        "blocked": "agent:blocked",
        "failed": "agent:failed"
      },
      "routing": {
        "labelPrefix": "repo:",
        "repos": {
          "api": {
            "name": "api",
            "cloneUrl": "git@github.com:acme/api.git",
            "defaultBranch": "main",
            "gates": [
              { "cmd": "bun run lint", "cwd": "." },
              { "cmd": "bun test", "cwd": "." }
            ]
          },
          "worker": {
            "name": "worker",
            "cloneUrl": "git@github.com:acme/worker.git",
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
      "reporting": {
        "scope": "material"
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
| `reporting.scope` | Optional; `"material"` (default) or `"escalations"`. Every orchestrator tick appends the matching constraint line to its prompt, re-read from this file each tick — see [Your workflow vs. the package](#your-workflow-vs-the-package). It constrains what the session is told to report; it is not an outbound filter. A config written without the key keeps reporting material events. Any other value is an error, never folded to the default. |
| `workspaceRoot` / `mirrorRoot` | Optional; default to `worktrees/` and `mirrors/` under the state directory. `~` is expanded. |

Prefer an SSH `cloneUrl`, or an https URL backed by a credential helper. A clone URL
with credentials embedded is persisted into the mirror's git config, exactly as it
would be for a hand-run clone.

## Orchestrator tick

The escalation path above assumes an orchestrator session that is actually
running its loop. A 24/7 omp session with a standing brief and nobody typing into
it never gets prompted, so it never runs anything — installing
`omp plugin install omp-conductor` also installs a heartbeat that prompts it.

The heartbeat is **inert unless the session's cwd contains
`.conductor-tick.json`**, so it costs an ordinary session nothing. Drop the file
in the orchestrator's working directory (on the fleet host, `/root/fleet`):

```json
{
  "intervalSeconds": 900,
  "armedFile": "state/armed",
  "accessFile": "/root/.omp/agent/telegram/access.json",
  "message": "Run your standing loop from ORCHESTRATOR.md now."
}
```

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `intervalSeconds` | yes | — | Whole seconds between ticks, minimum `60`. A tick costs a full turn of a frontier model, so a sub-minute period is refused rather than obeyed. |
| `armedFile` | no | none — the gate passes | Path to the arm marker. A tick does nothing while the file is missing. Relative paths resolve against the session cwd, so `state/armed` means `<cwd>/state/armed`. |
| `accessFile` | no | none — the gate passes | Path to the Telegram bridge's `access.json`. Every tick re-reads it and requires `enabled: true` with exactly one entry in `allowFrom`. Relative paths resolve against the session cwd. **Configure this on any fleet deploy** — see below. |
| `message` | no | `Tick <ISO timestamp>: run your standing loop from ORCHESTRATOR.md now.` followed by the `reporting.scope` line | Sent verbatim when set — and then it owns the whole contract: no scope line is appended to a prompt you wrote yourself. The default carries the timestamp, which is what makes two consecutive ticks distinguishable in the session log. |

A tick sends one message (`customType` `omp-conductor.tick`, attributed to the
user): the standing-loop prompt, plus the one constraint line the project's
[`reporting.scope`](#your-workflow-vs-the-package) resolves to, re-read from the
conductor config on every tick. It starts a turn if the session is idle; while a
turn is streaming it is queued as a follow-up and consumed when that turn ends.
It sends **nothing** when:

- `/conductor pause` (or `omp-conductor pause`) holds the pause flag — the same
  flag the dispatch loop reads, so pausing the fleet pauses its heartbeat;
- `armedFile` is configured and missing;
- `accessFile` is configured and the escalation channel is not verifiably up;
- an earlier tick is still queued. Ticks coalesce rather than stack, so a slow
  turn cannot leave a backlog of heartbeats behind it.

### The escalation channel is a gate, and it fails closed

Unattended dispatch is only defensible while a tier-2 escalation can reach a
person. So `accessFile` is checked on **every** tick, not cached at session start:
the bridge is reconfigured out-of-band, and a heartbeat that trusted a startup
snapshot would keep dispatching for days after the channel went away. A stale arm
marker must not outlive the channel that makes running unattended safe.

The check passes only when the file parses to an object with `enabled: true` and
exactly one `allowFrom` entry. Everything else stops the heartbeat: file missing,
unreadable or truncated; not JSON, or JSON that is not an object; `enabled`
absent or false; zero owners paired (nobody to page) or more than one (ambiguous
— the conductor refuses to guess which human is on the hook). Failure modes are
deliberately not distinguished in the decision: each one means a page lands
nowhere.

Leaving `accessFile` unset passes the gate, because an ordinary developer session
that happens to have a `.conductor-tick.json` has no bridge to check. It is not an
off switch for the check: **a fleet deploy always sets it.**

Every tick — sent or skipped — is logged with its reason (`paused`, `not armed`,
`escalation channel down`, `tick already pending`) to the omp log. Skips are
deliberately silent in the UI: a paused fleet would otherwise raise a notification
every interval, forever. The one exception is a malformed `.conductor-tick.json`,
which notifies once at session start and leaves the heartbeat off; silent failure
there is the failure mode the heartbeat exists to prevent. A conductor config that
cannot supply a reporting scope logs `tick reporting scope: using material` once
per session — once, not once per interval, because the file is unlikely to fix
itself between two ticks.

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
{ "ok": true, "paused": false, "activeRuns": 1, "project": "demo" }
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
