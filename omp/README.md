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

Merging is a human act, and so is releasing. Releases are **batched**: cut from a
coherent group of merged work by a human-supervised decision, never one per PR. So
nothing in this package tags, pins, deploys or publishes, and no worker is ever
asked to. A worker whose change needs releasing reports that and stops.

Code counts every limit that decides whether work starts: concurrency, dollars per
day, turns and wall clock per worker, attempts per issue. None of it is left to the
model. A worker asked to respect a budget eventually talks itself out of it, so the
dispatcher enforces the budget before anything is claimed and kills anything over
the line.

When a run does get stuck, the first responder is not you. A tier-1 escalation is
injected into a long-lived **orchestrator session** that can read the issue and the
run's transcript and then either re-brief the worker or decide the problem genuinely
needs a human. It never edits product code and never pushes a branch; whether it
may *merge* is a setup answer (`authority`), and it defaults to no. Only tier 2
pages you directly.

The package ships three deployables, plus one skill:

| Deployable | Entry | What it is for |
| --- | --- | --- |
| omp plugin | `/conductor` slash command | Inspect and arm the conductor from inside an omp session: dry-run the queue, read status, pause, resume. |
| Standalone daemon | `omp-conductor` binary | The dispatch loop, managed as a background process (`start` / `stop` / `restart`) with a `/healthz` endpoint for a supervisor. |
| Orchestrator heartbeat | omp extension, activated by `.conductor-tick.json` | Prompts a 24/7 orchestrator session on a fixed interval so its standing loop actually runs, and marks the session stalled when its prompts stop being consumed. Inert in every other session — including a second session opened in the fleet's own directory. See [Orchestrator tick](#orchestrator-tick). |
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
enforces a word of it. What you write there binds your orchestrator session and
nothing else in this package.

`/conductor setup` offers to render the shipped template
(`src/briefs/orchestrator.md`) to `<workspaceRoot>/ORCHESTRATOR.md` with your
project's coordinates filled in, and never replaces an existing file without a
second, explicit confirmation. It is a starting point rather than a contract:

| Section | Whose |
| --- | --- |
| Duties (drain, groom, report), escalation tiers, hard boundaries | **Fixed** — they describe how this package already behaves. |
| Releases | **Yours.** Its opening paragraph is rendered from the `authority` you answered in setup — by default "humans release, and you do not merge". Everything under it is the procedure, and a delegated session is told not to cut a release until you have written one: what, when, on what proof, and what stays permanently forbidden. |
| Reporting | **Yours**, seeded from the scope you chose in setup. |

Reporting is the one half of that the config also knows about, because the wizard
has to ask something in order to seed the brief, and it is the one half the
runtime acts on:

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
yet, an unreadable or invalid one, and several projects with none named (the same
ambiguity `status` refuses to guess through). Stopping the heartbeat over a
reporting preference would be the worse trade, so it ticks on the default and
logs the reason once.

**What it does not do:** there is no hard outbound filter. Nothing inspects the
orchestrator's messages and drops the ones your scope did not ask for, so a
session that ignores its constraint line still reaches you. Scope is a
constraint the model is handed each turn. It is not a gate the model is held to.
The enforcement roadmap (a tool-call tripwire, and config-versus-behaviour drift
in the daily digest) is
[issue #11](https://github.com/TerrifiedBug/conductor/issues/11).

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
| `queueLabel` | Open issues in `tracker.repo` carrying this label are the work queue. Nothing else is ever read. Required: the wizard pre-fills `ready-for-agent`, but a config that omits the key is rejected, not defaulted. |
| `routing.repos` + `repo:<name>` labels | Each queued issue must also carry exactly one routing label naming which code repo the work lands in. The conductor cuts the worktree and PR there, from `routing.repos[name].cloneUrl`. An issue with zero or two routing labels is reported as unroutable and skipped — never guessed. |

So: one tracker repo supplies the queue, routing labels fan issues out to any
number of code repos, and both label names are yours to configure.

## Install

```bash
omp plugin install omp-conductor
```

From a checkout of the monorepo, `./setup.sh` links this plugin and the Herdr half
after checking everything below.

### Prerequisites

`@oh-my-pi/pi-coding-agent` (`>=17.1.4`) is a **peer dependency** and must already
be present. If you run omp, it is.

Also required on the host:

- `bun`: the CLI and the daemon run on it (`Bun.serve` backs `/healthz`).
- `gh`, already authenticated: every tracker operation shells out to it, so the
  daemon never handles a GitHub token itself.
- `git`: mirrors and worktrees.
- **[omp-telegram](https://www.npmjs.com/package/omp-telegram)**, for the
  escalation channel. It is a separate package and is not vendored here.

  Two different things depend on it, and they need different amounts of it:

  - **Tier-2 paging** needs only its bot token. This package reads
    `TELEGRAM_BOT_TOKEN` out of `$OMP_TELEGRAM_STATE_DIR/.env` (default
    `~/.omp/agent/telegram/.env`) and posts to the chat id you configure. No
    pairing required, and no token ever passes through this package's own config.
  - **The interactive channel** — replying to an escalation, approving a brief
    amendment from your phone — needs omp-telegram actually paired, which is what
    writes `access.json`. The fleet heartbeat also reads that file and refuses to
    tick unless exactly one owner is paired, on the grounds that unattended
    dispatch is only defensible while a tier-2 page can reach a person.

  With neither, tier 2 degrades to a comment on the issue. Nothing is broken in
  that configuration: it is supported, just slower to reach you.

## Onboarding

Onboarding this package has two layers, and installing it gives you both.

| Layer | What it is | What it owns |
| --- | --- | --- |
| **`/conductor setup`** | The deterministic wizard. Closed questions, a label plan, a dry run, one confirm. On a project it already knows, it offers to amend one area instead of re-asking everything — see [Changing one setting](#changing-one-setting). | **Mechanical config.** It is the only thing that writes `config.json`, and it mutates nothing before you confirm. |
| **`skill://conductor-onboarding`** | A skill bundled in this package (`skills/conductor-onboarding/SKILL.md`), discovered automatically by any omp session once the plugin is installed. | **Brief authoring.** The judgement the wizard cannot prompt for. |

The split exists because the two halves fail differently. A wrong config value is
a run that errors on the next tick; a wrong release boundary is a fleet that
publishes something at 03:00. The first is worth a text prompt with validation.
The second is worth an interview.

So the skill does the part a dialog cannot:

- **Interviews you** on release policy — humans release (the default), the agent
  releases to a named boundary, or the agent releases fully — pressing on the one
  question that makes a delegated release safe: *where does the agent's leg end?*
  The answer becomes the [`authority`](#configuration) pair `/conductor setup`
  records, and the brief is worded from it. Plus escalation taste, and which of
  the two [`reporting.scope`](#your-workflow-vs-the-package)
  values your answer actually maps to.
- **Reads your repos instead of asking about them.** It opens each routing repo's
  CI workflows, `package.json` scripts and `Makefile`/`justfile`, then *proposes*
  the exact pre-push [gates](#configuration) with the `cwd` each runs from, so the
  gates match what CI runs.
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

From an omp session with the plugin installed, just say what you want: "help me
set up conductor", "onboard me", "configure the fleet" all reach it, because that
is what the skill's description matches on. With `skills.enableSkillCommands`
turned on you can also invoke it directly:

```text
/skill:conductor-onboarding
```

Nothing about the wizard changes: `/conductor setup` on its own remains a
complete, supported path, and the brief it renders is safe unedited.

### Changing one setting

`config.json` is wizard-written, so changing a value means running the wizard —
and a wizard that re-asks twenty questions to add one key is a wizard people edit
the file behind instead. So a re-run against a project that is already configured
opens with one question:

```text
"veltro" is already configured — what would you like to do?
> Change one area
    asks one area's questions; every other answer is carried through from the saved config
  Walk every question again
    the full interview, every prompt pre-filled with what is configured now
```

Amending is the default. Pick it and the eight areas are listed with what each one
says right now, so the row you want is the row you can see:

```text
Which area? Each row shows what it says now
  tracker & repos — veltrosecurity/veltro, queue "ready-for-agent", "repo:" → veltro, chad, warden, vectorflow
  gates — veltro: none; chad: ruff check . @ backend, pnpm lint @ frontend; warden: ruff check . @ backen…
  caps & worker model — 2 workers, 120 turns, 90m, $25/day, 2 attempts (all defaults) — harness default model
  code graph — not configured — workers grep
  authority — merge=orchestrator, release=orchestrator
  escalation & triage — tier 2 pages Telegram 8236653927, comments too, triage external
  reporting scope — material — escalations, plus green PRs, second failures, and anything that stops the fleet
  orchestrator brief — none at /root/.omp/conductor/worktrees/ORCHESTRATOR.md
```

Only that area's questions are asked. Every other answer is read back out of
`config.json` and written again unchanged — the same answers, the same builder,
the same single confirm, so there is still exactly one thing in this package that
writes a config, and it still writes nothing before you agree. The consent screen
leads with the delta and then shows the whole project as it would be written:

```text
amending       code graph  —  project veltro
  was            not configured — workers grep
  now            /root/.cache/conductor-graph/veltrosecurity — 4 clone(s): veltro, chad, warden, vectorflow
  carried over   tracker & repos, gates, caps & worker model, authority, escalation & triage, reporting scope, orchestrator brief
                 read back from /root/.omp/conductor/config.json and rewritten unchanged
```

A first run, or a project name this config has never seen, never sees either
question: there is nothing to amend, so it is the full interview exactly as
before. Choosing *Walk every question again* is also unchanged — every prompt
pre-filled with what is configured, Enter to keep it — with one wrinkle worth
knowing: the two authority confirms and the orchestrator-session confirm cannot
start on "yes", so Entering through the full interview **revokes** a delegation
rather than renewing it. Amending the `authority` area names the current grant in
the question, which is the safer way to leave one alone.

### Keeping a brief current

The standing prompt is two layers:

| Layer | File | Updates how? |
| --- | --- | --- |
| Package floor | `src/briefs/orchestrator.md` | Every tick recomposes it into `ORCHESTRATOR.md` from the installed package. Upgrade the package in this host's existing install root + restart is enough. |
| Fleet policy | `POLICY.md` | Yours. Setup writes the scaffold once; the Learning loop edits only this file. |
| Composed view | `ORCHESTRATOR.md` | Regenerated from floor + `POLICY.md` on each tick (and at setup). Do not hand-amend it for durable policy. |
| Worker brief | `src/briefs/worker.md` | Read per run from the package. |
| Onboarding skill | `skills/conductor-onboarding/SKILL.md` | Read from the installed package. |

```bash
omp-conductor brief-upgrade                 # report overlay / legacy state
omp-conductor brief-upgrade --migrate       # dry-run: bannered ORCHESTRATOR.md → POLICY.md
omp-conductor brief-upgrade --migrate --apply
omp-conductor brief-upgrade --retrofit      # #20: propose YOURS TO EDIT cut on a hand-written brief
omp-conductor brief-upgrade --retrofit --apply
```

- **Overlay already active** (`POLICY.md` present): protocol updates need no brief-upgrade.
- **Legacy bannered brief**: `--migrate` lifts the owned half into `POLICY.md` and recomposes, with backups.
- **Hand-written brief** (no banner): `--retrofit` inserts the banner before the first Releases / Project context / Reporting / Amendments heading; then `--migrate`.
- **Legacy `--apply`**: still merges a bannered single-file brief when you need the old path.

`--file PATH` checks a brief that is not where the wizard would have put it.

The **Learning loop** proposes diffs against `POLICY.md` for you to approve over Telegram.

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
   `ORCHESTRATOR.md` you then own. See
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

The loop ticks every 5 minutes. `omp-conductor stop` shuts the loop down after
the current tick rather than mid-run. When the live process is the MainPID of
`omp-conductor.service`, stop goes through `systemctl stop` so a unit with
`Restart=on-failure` cannot bring it straight back; otherwise it is a raw
`SIGTERM` (then `SIGKILL` after 10 seconds).


### Stop the conductor (hold / halt)

Four control planes used to answer "stop" differently. The package verbs:

| Verb | Claiming | Tick sends | Dispatch daemon | Conductor pane |
| --- | --- | --- | --- | --- |
| `hold` | paused | disarmed | left running | left running |
| `halt` | paused | disarmed | stopped (systemctl-aware) | left running |
| `halt --pane` | paused | disarmed | stopped | stopped + recovery pinned off |
| `pause` | paused | **still armed** | left running | left running |

`resume` clears pause only and **never re-arms**. `arm` is proof-gated: it sends a Telegram challenge and writes the arm marker only after your reply appears as a *user* turn in the orchestrator transcript. `halt --pane` targets the configured conductor agent only — it does **not** run `systemctl stop herdr-fleet`.

`status` prints a layered header (`dispatch` / `ticks` / `pane` / `recovery` / `herdr` / `daemon`) so a paused fleet cannot hide an armed orchestrator still spending turns.

`halt --pane` is **fail-closed**: it exits `0` only when the conductor agent is
*proven* gone. It writes the recovery pin first, so a failed stop still cannot be
undone by `herdr-conductor` respawning the agent, and then refuses (nonzero exit,
message on stderr) on every uncertainty:

- the tick config does not parse — the agent name would be a guess
- `herdr agent list` is unreachable, prints nothing, or prints output with no
  explicit `agents` array; only a real `agents: []` means "no agents"
- the configured agent name is not unique, or the claimed pane runs some other agent
- `pane process-info` fails, or the claim is live `omp` but names no recognizable
  omp foreground PID — "cannot see it" is never reported as "it is stopped"
- the process is still alive after `SIGTERM` then `SIGKILL`

The pin is written to the pane's own directory (the one holding
`.conductor-tick.json`, which is `FLEET_CWD` — the only place `recover.sh` looks),
including when that tick config is the thing that failed to parse.

Clear the pin with `omp-conductor release-pane` when you want recovery again.


## How one tick works

Per tick, for the daemon's project:

1. **Paused?** If the pause sentinel exists, the tick claims nothing and returns.
   Pause is checked first, so `omp-conductor pause` takes effect on the next tick
   without signalling the process.
2. **Settle the green PRs.** For every run in `pushed-green`, ask the tracker
   what became of its PR. Merged → the row becomes `merged`; closed without
   merging → `failed`, with the PR named in the row's `lastError`. Still open, or
   an answer that could not be obtained at all → the row is left exactly as it
   is. Bounded by the number of green PRs awaiting a merge, which is a handful by
   construction. This runs above admission so a row settled here frees its issue
   in the same tick. See [what settles a green PR](#what-settles-a-green-pr).
3. **List the queue.** Open issues in `tracker.repo` labelled `queueLabel`.
4. **Filter and route.** An issue is eligible only if it carries the queue label
   and none of the three state labels (`inProgress`, `blocked`, `failed`). Eligible
   issues are partitioned into routable and unroutable.
5. **Escalate the unroutable** at Tier 1, quoting the repo labels actually seen and
   the configured repo names. These are never dispatched.
6. **Check spend.** If spend since local midnight has reached `dailySpendUsd`, the
   daemon **pauses itself**, pages at Tier 2, and returns.
7. **Check capacity.** `maxConcurrentWorkers` minus *live* workers (runs in
   `claimed` or `running`) gives the free slots. A green PR awaiting a human
   merge occupies its issue but not a slot: its worker is finished, and counting
   it would let two green PRs stop the fleet. If no slot is free, the tick logs
   and returns.
8. **Admit issues** up to the free slots, skipping any issue that already has
   an active run — including a green PR, so a second attempt can never land on a
   live PR. An issue that has used `maxAttemptsPerIssue` escalates at Tier 1
   instead of being admitted.
9. **Ask the tracker whether the work already exists.** For each candidate that
   survived step 8 — so at most one API call per free slot, never one per queued
   issue — the daemon asks whether an **open** PR already closes the issue. If one
   does, the issue is skipped with its PR named in the log. Drafts count: a draft
   PR's branch still holds the only copy of the work. This is the guard the store
   cannot provide, because a store younger than the PRs (a migration, a wiped or
   relocated state directory, a restore onto a new host) has no row to object
   with. If the check itself fails, the candidate is **held**, not admitted, and
   retried next tick: the cost of holding is five minutes, the cost of admitting
   on an unknown is a burned attempt and a duplicate PR. Only that candidate is
   held, so a flaky API cannot stall the rest of the queue.
10. **Dispatch** the admitted issues concurrently.

Then, per admitted issue:

1. **Apply the `agent:in-progress` label — before any worktree or session exists.**
   This ordering is the whole crash-safety story: the label, not the local
   database, is the guard against dispatching the same issue twice. If the process
   dies at any later point, the next daemon sees the label, eligibility filters the
   issue out, and the orchestrator's drain duty triages the orphan (see below). A
   store that is lost can be rebuilt from the tracker; a label that was written too
   late cannot undo a duplicate PR.
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
   | `failed` / `killed` | swapped to `agent:failed` | dirty tree committed to the branch, then **kept** as evidence | Tier 1 |
   | unexpected error | swapped to `agent:failed` | same | Tier 1 |

   `pushed-green` is not the end of the row: a later tick settles it once the PR
   resolves. See [what settles a green PR](#what-settles-a-green-pr).

   Label swaps add the new label before removing the old one: the reverse order
   leaves a window in which the issue carries no state label at all, which is
   exactly the shape eligibility reads as fresh work.

   **A non-graceful end salvages the tree first.** A turns-cap kill, a
   wall-clock kill and a crash are all external and unannounced: they land
   mid-edit, and only the run's *branch* is preserved across attempts — the tree
   is removed `--force` by the next one. So before the escalation is written,
   a dirty tree is committed to the run's own branch as
   `wip(#<issue>): attempt <n> killed by <reason> — auto-salvaged` (everything,
   including files git has never seen) and pushed, and the escalation says where
   it went: `WIP committed to <branch> @ <sha>`. A push that is refused leaves
   the commit in this host's mirror and says so; a salvage that fails outright
   says that, loudly, naming the tree that now holds the only copy. A `blocked`
   run is deliberately *not* salvaged — it stopped on purpose, with turns still
   in hand to commit for itself.

### What a restart does to runs that were in flight

A `claimed` or `running` row is a promise that a worker process exists, and a
daemon that just started knows that promise is broken: its workers died with the
previous process. At startup — unless another daemon is alive, so a foreground
`daemon --once` cannot orphan a running daemon's real workers — every such row is
**salvaged first** (dirty tree → `wip(#N): attempt N killed by a daemon restart —
auto-salvaged` on the run's branch, same path as a turns-cap kill), then moved to
`orphaned`, with a log line naming the issue, the attempt and the worktree. That
frees the slots immediately; a fleet must never resume as deadlocked as it
crashed, and uncommitted edits must not wait for a human with `bun -e`.

Only the rows change after salvage. The issue keeps `agent:in-progress` — the
label is the crash guard against double-dispatch — and deciding what the dead
worker's remains are worth is the orchestrator's drain-duty judgement, spelled
out in its brief: an open green PR goes to the merge path, a salvaged sha is a
continuation hand-off, and a clean orphan has its label released so the next
tick re-claims it. Orphaned attempts still count toward `maxAttemptsPerIssue`,
so a crash loop escalates instead of redispatching forever.

### Deploying a new package onto a busy fleet

`systemctl restart` / `omp-conductor restart` is safe for **work product** once
this version is installed: startup salvage commits dirty trees before orphaning
rows, and salvage rewrites the mirror's managed `info/exclude` to the package's
current list before `git add` so a narrowed ignore cannot hide deliverables.

It is still disruptive for **in-flight sessions** (the worker process dies; the
attempt is spent). Prefer draining when you can wait:

1. `omp-conductor pause` — stop new claims; live workers finish.
2. Wait until `omp-conductor status` shows `workers 0 / N` (no `deploy` hint line).
3. Install the new package (`bun add -g omp-conductor@…`, `omp plugin install …`).
4. `systemctl restart omp-conductor` (or `omp-conductor restart`).
5. `omp-conductor resume` if you left it paused.

If you cannot wait:

1. `omp-conductor pause` (optional but keeps new claims off during the swap).
2. Install.
3. Restart — salvage runs on boot for every live worktree, then rows go `orphaned`.
4. Resume; the pane orchestrator triages `agent:in-progress` orphans (continuation
   / merge / release label). Status prints a `deploy` line while live workers > 0
   so you can see the risk before you restart.

Do **not** edit files under the running install and expect the daemon to keep
dispatching — the integrity tripwire pauses and pages. Install, then restart, so
the new process records a fresh baseline.

### What settles a green PR

`pushed-green` means the worker finished, pushed, and watched the checks go green.
What happens next is a human's decision, taken minutes to days later and never
announced to the daemon — so every tick asks the tracker about every green PR it
is still holding, and settles the ones that resolved:

| PR | Row becomes | Why |
| --- | --- | --- |
| merged | `merged` | The work landed. This is the state `merged` was reserved for. |
| closed without merging | `failed`, with the PR in `lastError` | A human read the work and said no. Leaving it `pushed-green` strands the issue forever behind a PR nobody will merge, and calling it `merged` is a lie about code that is not on the base branch. `failed` is true, and it releases the issue so a re-queue can be attempted again. |
| still open | unchanged | The normal steady state. Its issue must stay occupied, or a second attempt lands on the live PR. |
| could not be determined | unchanged | A flaky network, a revoked token, a deleted PR. An unknown answer never settles a row; the next tick asks again for free. |

The attempt counter is untouched either way, because both were real attempts. Run
rows are the only thing that changes: a merge normally closes the issue, and a
human who closed a PR is already looking at it, so what an issue's labels should
say next is the orchestrator's drain-duty judgement — the same division of labour
as a restart, above. One unreachable PR costs its own row and nothing else; the
rest of the sweep still settles.

Until this existed, nothing ever revisited a `pushed-green` row: the startup
reconciler only settles rows that held a process, and `merged` went unwritten. On
2026-08-07 the reference fleet reported three active runs whose PRs were all
merged and whose issues were all closed, through two daemon restarts — and because
the active set *is* the busy set, those three issues were permanently unclaimable.
A status page that has stopped being evidence is worse than no status page.

### Continuation runs

When a worktree is provisioned onto a branch that already exists in the mirror
(reattach after a prior attempt, orphan, or turns-cap auto-requeue), the worker
brief includes a **Continuation** section: read `git log` / `git diff` against
the default branch first, and do not recreate work already on the branch.

A **turns-cap kill with attempts remaining** salvages the tree, puts the queue
label back on, and skips the failed label so the next tick reclaims as a
continuation automatically.

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
multi-repo request is a human decision about contracts; it is not something to
infer from a label. Sending the issue back costs a label edit; guessing costs a
bad merge.

## Caps

Caps resolve per project: the global `defaults` block, then the project's own
`caps` layered on field by field, so a project that pins one cap still inherits the
rest. `0` is a real value (a hard stop), not "unset".

| Cap | Default | What it protects |
| --- | --- | --- |
| `maxConcurrentWorkers` | `2` | Parallel omp sessions. Two, because **CI runner slots, not model tokens, are the usual throughput ceiling** — a third worker would starve its own PR checks on a small self-hosted runner pool. Raise it only if you actually have the runners. |
| `dailySpendUsd` | `25` | Rolling-day spend ceiling in USD, or `null` for no spend gate. `0` is a hard stop. Metered from assistant `usage.cost.total`. |
| `workerMaxTurns` | `120` | Turn ceiling for one worker. Catches a session looping without converging. |
| `workerWallClockMs` | `5400000` (90 minutes) | Wall-clock ceiling for one worker. A session that is merely stuck spends no turns, so turns alone cannot detect it. |
| `maxAttemptsPerIssue` | `2` | Retries per issue before it escalates. One clean retry recovers from flaky CI; a third attempt almost always means the issue itself is underspecified. |

Days are counted from **local midnight**, matching how a human reads "today".

Set `dailySpendUsd` to `null` (wizard: blank) for no money gate — turns and wall-clock still apply. Hitting a numeric `dailySpendUsd` is not the same as hitting the other caps. A concurrency
limit simply defers work to a later tick. The spend cap **pauses the daemon and
pages at Tier 2**: a loop that is burning money has to halt itself, because
waiting for someone to notice tomorrow is how a runaway becomes expensive.
Work resumes only after `omp-conductor resume` (or `/conductor resume`).

`workerMaxTurns` and `workerWallClockMs` are enforced inside the session driver: the
run is aborted, recorded as `killed`, and the escalation names which ceiling fired.

## Worker model

`workerModel` on a project pins the model its workers run on, as a pattern in
omp's own model/role syntax (whatever `/model` accepts). It sits beside `caps`
rather than inside them, because it is not a ceiling:

```json
"workerModel": "smol"
```

Omit it and the harness picks, which is the right answer until you have a reason.
The pattern is passed through unresolved: omp resolves it after its extensions
load, so a name this package has never heard of still works. If the harness cannot
honour the pattern it says so, and the daemon logs that per run:

```text
#412 model fallback: <what the harness substituted>
```

Worth reading the log for. A run that quietly used a weaker model than you chose
otherwise looks like a run that was merely unlucky.

## Code-graph discovery

Optional, off unless you answer yes in the wizard, and worth answering yes to for
one measured reason: **workers spend most of a run finding code, not changing it.**
On the dogfood fleet a single run typically spends 30–62 `read` calls and 32–69
`bash` calls against 9–24 edits — 215–390k characters of tool output, roughly four
fifths of a 120-turn budget — and the runs that died at the turns cap died with
the work unfinished. A code graph answers "who calls this" and "where is this
defined" in one call instead of twenty greps.

### Two things this package does not do for you

`omp-conductor` never installs, spawns, imports or depends on the indexer — with
`graphProject` unset, nothing about dispatch, caps or escalation changes. That
means a fresh host needs both of these before an index is worth anything, and
`graph-setup` reports them as step 0:

1. **`codebase-memory-mcp` on PATH** — a separate project,
   [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp).
2. **Mounted as an MCP server** in `~/.omp/agent/mcp.json`, on the account the
   daemon runs as. Miss this and the failure is silent: every index builds
   correctly, no worker session can read any of them, so workers fall back to
   grepping and the feature looks like a no-op. `graph-setup` prints the entry.

Say yes and the wizard asks for one root, then derives one clone per routed repo
underneath it (default `~/.cache/conductor-graph/<org>/<repo>`) and writes it to
each repo's [`graphProject`](#configuration). Nothing else changes: this package
never runs an indexer, never imports one, and behaves identically with the graph
server absent — dispatch, caps and escalation do not know it exists. On a fleet
that was configured before this key existed, `/conductor setup` and the `code
graph` area add it in two prompts — see
[Changing one setting](#changing-one-setting).

### Why the clone, and not your checkout or the worktree

This is the part that decides whether the feature helps or hurts, so it is worth
being blunt about all three candidates.

| Directory | Why not |
| --- | --- |
| **The worker's worktree** | An index is keyed by the realpath of the directory it was built from, and has no git-worktree awareness. A run's `worktrees/<issue>` path is therefore *always* an empty project — a worker that queried its own cwd would get silence, conclude there is no graph, and spend the run grepping. This is why `graphProject` is an absolute path in the config and not something derived at run time. |
| **Your own checkout** | Refreshing an index means resetting the clone to its default branch. In a directory you work in, that either destroys uncommitted work or — if it is made safe instead — indexes whatever feature branch you left checked out, so the fleet orients against your WIP. |
| **A conductor mirror** | The daemon's mirrors are bare. There is no working tree to index. |

So `graphProject` names a fourth thing: a clone that exists only to be indexed,
that nothing human ever edits, and that is therefore safe to `git reset --hard`
every night. The worker brief names that path, tells the session to match it
against `list_projects`' `root_path` and query by the `name` beside it, and says
plainly that the graph is a snapshot which does **not** contain the worker's own
edits — orient with it, then read the real file before changing it.

### Creating and refreshing them

```bash
omp-conductor graph-setup            # print the plan: clones, index commands, units
omp-conductor graph-setup --write        # stage the script and the two units (no root)
```

`graph-setup` prints a `git clone` for every clone that does not exist yet, the
one-shot index command per repo, and a `cbm-reindex.service` + `cbm-reindex.timer`
pair built from the project's own repos and branches. `--write` stages all three
in the state directory and prints the two `sudo` lines that install and enable
them; it never runs `systemctl`.

**Run it as the account the fleet runs as, never under `sudo`** — it refuses if
you try. Everything it derives resolves per-account: the config it loads, the
state directory it stages into, and the `HOME`/`User=` it bakes into the unit.
Under root you get a timer that goes green while writing indexes into
`/root/.cache`, where no worker session looks — silent, and indistinguishable
from the feature simply not helping. Only installing the units needs root, which
is why that is two separate printed commands.

Two properties of the generated unit are deliberate:

- **It is a timer, not the server's own watcher.** That watcher lives inside a
  connected MCP session and dies with it, so an ephemeral worker session keeps
  nothing fresh. The refresh has to come from outside the fleet.
- **It fails loudly.** The refresh is `set -euo pipefail`, then per repo
  `git fetch --prune origin` and `git reset --hard origin/<its own defaultBranch>`
  before indexing. Nothing is `|| true`-ed, so a fetch that has been broken for a
  week turns the unit red instead of quietly re-indexing a stale tree and exiting
  `0` — a green timer serving a month-old graph is worse than no graph at all.

The unit spells out `HOME` and an explicit `PATH`, because systemd supplies
neither usefully: the indexer resolves its store from `HOME`, systemd's default
`PATH` has no `~/.local/bin`, and the indexer shells out to `git`. Both are the
user that ran `graph-setup`; the unit sets no `User=`, so check them if that is
not the account the timer runs as.

## Escalation tiers

| Tier | Meaning | Raised by | Delivered to |
| --- | --- | --- | --- |
| 1 | "Not a human's problem yet" — the run is parked and safe. | Unroutable issue, blocked run, failed or killed run, dispatch error, attempts exhausted. | The orchestrator session, as an injected prompt. Falls back to an issue comment when no orchestrator is running, or when it will not accept the injection. |
| 2 | "The fleet is stopped until you look." | Daily spend cap reached; the installed package changed under the running daemon. Either way the project is already paused. | Telegram, when `escalation.telegramChatId` is set and a bot token is readable; otherwise it falls back to the issue comment. |

**The orchestrator** is one persistent, file-backed session per daemon run, resumed
across restarts so it remembers what it has already handled. Its `cwd` is the state
directory, deliberately not a checkout. Delivery resolves when the harness *accepts*
the prompt, not when the model answers it, so a tick never parks behind a model; an
injection arriving mid-thought queues as a follow-up instead of interrupting the
turn in flight. Its standing orders are explicit: re-brief the worker, file or
comment on issues, or promote to tier 2, and never edit product code or push a
branch. Merging is the one line worded from config — see [`authority`](#configuration).
If it fails to start, the daemon logs a warning and runs on, with tier-1
escalations degraded to issue comments.

**Or no orchestrator at all.** Set `escalation.orchestrator` to `"external"` when
you already run your own supervising session — a visible TUI session in a pane,
typically. The daemon then starts none of its own and every tier-1 escalation
posts as an issue comment, which is what that session drains. One brain, and it
is the one you can watch.

**Answering a tier 1 is only half of it.** A blocked or failed run leaves its state
label on the issue, and eligibility reads any state label as disqualifying, so an
answered issue that keeps one is never re-claimed and the answer is inert — nothing
fails, the issue just stops existing as far as dispatch is concerned.
[`omp-conductor unblock <issue>`](#cli-reference) is the way back: it clears the
label through the same tracker the dispatcher writes with. The brief tells the
orchestrator to run that verb rather than edit the label itself, and that is not a
formality — orphan detection works by comparing `agent:in-progress` labels against
live runs, and it is only trustworthy while every state label on the tracker was
written by this package.

Tier 2 borrows the bot token that `omp-telegram` already owns, at
`~/.omp/agent/telegram/.env` (or `$OMP_TELEGRAM_STATE_DIR/.env`). If you run that
bot, Tier 2 needs no extra configuration beyond the chat id. If the token is
absent, Tier 2 degrades to the issue comment instead of failing. The token is
never logged, and it is redacted out of any error text that could reach a public
issue comment.

**Escalations are deduplicated.** The dispatcher re-notices the same unroutable
issue on every poll, so a ledger in the store — keyed by project, issue, tier and
summary — makes a recurring condition page **once** and suppresses the five-minute
repeats. The marker is recorded only on successful delivery, so a page that could
not be delivered is retried on the next tick instead of being written off as sent.
The spend-cap and integrity-tripwire summaries carry the date, so the same
condition pages again tomorrow but only once per day.

If `fallbackToIssueComment` is off and no Telegram transport is configured,
delivery throws instead of dropping silently. The failure is logged and retried,
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
read — a stale one never blocks a `start`. Both `start` and a bare `daemon` write
the pidfile, so a daemon run in the foreground under systemd is as visible to
`status` as a backgrounded one; `daemon --once` writes nothing, because that drill
is exactly what the orphan-reconciliation guard reads the pidfile to protect.

The file is validated on every read. A malformed config produces one readable error
listing every fault, and the daemon refuses to start rather than running with half
a project.

`/conductor setup` is the only thing here that writes this file, and on a project
it already knows it can rewrite one area of it without re-asking the rest — see
[Changing one setting](#changing-one-setting).

`version` is `2`. A `version: 1` file still loads: caps it names that this build no
longer enforces are dropped rather than treated as typos, and the next save writes
it back as `2`. In a `version: 2` file an unrecognised cap key **is** an error,
because there is nothing left to retire — a mistyped `dailySpendUSD` would
otherwise read as configured while the real ceiling stayed the default.

A complete, valid config for one project with two target repos:

```json
{
  "version": 2,
  "defaults": {
    "maxConcurrentWorkers": 2,
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
            ],
            "graphProject": "~/.cache/conductor-graph/acme/api"
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
        "maxConcurrentWorkers": 1,
        "dailySpendUsd": 15
      },
      "workerModel": "smol",
      "escalation": {
        "telegramChatId": "123456789",
        "fallbackToIssueComment": true,
        "orchestrator": "embedded"
      },
      "authority": {
        "merge": "human",
        "release": "human"
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
| `version` | Must be `2`. A `version: 1` file still loads, drops the caps this build no longer enforces, and is rewritten as `2` on the next save. Present from day one so a format change can be migrated instead of silently misread. |
| `defaults` | Every `Caps` field. Anything omitted falls back to the built-in default. |
| `tracker.repo` | `owner/repo`. `tracker.kind` may be omitted; `"github"` is the only accepted value. |
| `queueLabel` | The one label meaning "a human has signed this off as agent-ready". Matched exactly, case-sensitively. |
| `stateLabels` | Optional; defaults to `agent:in-progress`, `agent:blocked`, `agent:failed`. |
| `routing.labelPrefix` | Optional; defaults to `repo:`. |
| `routing.repos` | At least one entry, or nothing can be routed. `name` defaults to the map key, `defaultBranch` to `main`. |
| `gates` | The exact cheap commands CI also runs, each with the `cwd` it runs from (`cwd` defaults to `.`). Running the real gate locally is what makes an unattended push safe — a subset lets an error outside the source dir reach the runners. |
| `graphProject` | Optional, per repo. Absolute path of the **index-only clone** whose code graph this repo's workers query — conductor's own disposable clone, pinned to the repo's default branch, never a checkout you work in and never a worker's worktree. Written by the wizard; `~` is expanded, and a relative path is an error rather than something resolved against whichever cwd happened to read the file. Absent means this repo has no graph and its briefs say nothing about one. See [Code-graph discovery](#code-graph-discovery). |
| `caps` | Per-project overrides; omit it or pin only the fields you want to change. |
| `escalation.fallbackToIssueComment` | Defaults to `true`. Absent means "yes, still tell me". |
| `escalation.orchestrator` | Optional; `"embedded"` (default) or `"external"`. `external` means an orchestrator session already runs elsewhere: the daemon starts none, and tier-1 escalations post as issue comments for that session to drain. Any other value is an error. |
| `authority` | Optional; `{ "merge": …, "release": … }`, each `"human"` (default) or `"orchestrator"`. It grants nothing to the daemon — it words the orchestrator's standing orders and the Releases paragraph of the rendered brief, so the config and the prompt cannot disagree about who holds the merge button. Unknown keys and any other value are errors, never folded to the default. |
| `reporting.scope` | Optional; `"material"` (default) or `"escalations"`. Every orchestrator tick appends the matching constraint line to its prompt, re-read from this file each tick — see [Your workflow vs. the package](#your-workflow-vs-the-package). It constrains what the session is told to report; it is not an outbound filter. A config written without the key keeps reporting material events. Any other value is an error, never folded to the default. |
| `workspaceRoot` / `mirrorRoot` | Optional; default to `worktrees/` and `mirrors/` under the state directory. `~` is expanded. |

Prefer an SSH `cloneUrl`, or an https URL backed by a credential helper. A clone URL
with credentials embedded is persisted into the mirror's git config, exactly as it
would be for a hand-run clone.

## Orchestrator tick

The escalation path above assumes an orchestrator session that is actually
running its loop. A 24/7 omp session with a standing brief and nobody typing into
it never gets prompted, so it never runs anything. Installing
`omp plugin install omp-conductor` also installs a heartbeat that prompts it.

The heartbeat is **inert unless the session's cwd contains
`.conductor-tick.json`**, so it costs an ordinary session nothing. Drop the file
in the orchestrator's working directory:

```json
{
  "intervalSeconds": 900,
  "armedFile": "state/armed",
  "accessFile": "/home/fleet/.omp/agent/telegram/access.json",
  "message": "Run your standing loop from ORCHESTRATOR.md now."
}
```

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `intervalSeconds` | yes | — | Whole seconds between ticks, minimum `60`. A tick costs a full turn of a frontier model, so a sub-minute period is refused rather than obeyed. |
| `armedFile` | no | none — the gate passes | Path to the arm marker. A tick does nothing while the file is missing. Relative paths resolve against the session cwd, so `state/armed` means `<cwd>/state/armed`. |
| `accessFile` | no | none — the gate passes | Path to the Telegram bridge's `access.json`. Every tick re-reads it and requires `enabled: true` with exactly one entry in `allowFrom`. Relative paths resolve against the session cwd. **Configure this on any fleet deploy** — see below. |
| `message` | no | `Tick <ISO timestamp>: re-read <workspaceRoot>/ORCHESTRATOR.md from disk, then run your standing loop from it.`, then the `reporting.scope` line, then the delivery rule | Sent verbatim when set — and then it owns the whole contract: neither the scope line nor the delivery rule is appended to a prompt you wrote yourself. Re-read from disk on **every** tick, so rewording it binds the next heartbeat instead of waiting for a session restart; a re-read that fails — caught mid-edit, removed, or invalid — keeps the value read at session start rather than stopping the heartbeat. `intervalSeconds` is *not* re-read: rescheduling a live timer still needs a restart. The default *orders* the session to re-read its brief, naming the path resolved from the project's `workspaceRoot`, because a standing prompt drifts out of a long-lived session's context while the file on disk does not. |
| `agentName` | no | `fleet` | The herdr agent name the orchestrator's pane is registered under. Under herdr this is the whole of the identity check below, and the default matches `AGENT_NAME=${AGENT_NAME:-fleet}` in the recovery plugin's `recover.sh`, so both halves key on one name. Rename the agent and set this to match. |

A tick sends one message (`customType` `omp-conductor.tick`, attributed to the
user): the standing-loop prompt, the one constraint line the project's
[`reporting.scope`](#your-workflow-vs-the-package) resolves to, re-read from the
conductor config on every tick, and a delivery rule. That last line is there
because end-of-turn text reaches the operator's Telegram only on a turn that
*began* as an inbound Telegram message: a tick is injected locally, so anything
the session merely writes at the end of one is read by nobody, and a reportable
event has to be delivered by an explicit `telegram_send` call the session
watched succeed. The tick starts a turn if the session is idle; while a turn is
streaming it is queued as a follow-up and consumed when that turn ends.
It sends **nothing** when:

- `armedFile` is configured and missing;
- `accessFile` is configured and the escalation channel is not verifiably up;
- an earlier tick is still queued. Ticks coalesce rather than stack, so a slow
  turn cannot leave a backlog of heartbeats behind it — and two coalesced ticks
  in a row are the signal that the session is not slow but wedged, which is
  what the [stall marker](#a-wedged-session-and-the-marker-that-notices) is for.

### One session per directory ticks, and it says which

Activation is a property of the *directory*, so before it arms anything the
heartbeat asks whether this session is the orchestrator or merely a session
standing in its directory. It has to: opening a second omp session in the fleet's
cwd — a shell to read state, say — used to arm a second heartbeat that prompted
*that* session with the standing loop, and with
[`authority`](#configuration) delegated it would consider itself entitled to
merge PRs and cut releases. Two brains, one queue, and nothing in the log to tell
them apart.

**Under herdr** (`HERDR_ENV=1` with a `HERDR_PANE_ID`), the answer is the pane's
registered agent name: the heartbeat asks `herdr agent list` for the entry whose
`pane_id` is this pane's and ticks only when its `name` equals `agentName`. Fleetness
is the *session* — every pane in it shares `HERDR_SESSION` and the cwd — and
herdr's `agent` field is the *runtime*, `omp` for the orchestrator and for the
shell beside it, so neither can tell them apart. The registered name can, it is
what `herdr agent start fleet --kind omp --pane <id>` sets, and it is the same
identity the recovery plugin keys on. A pane with a different name, or no name at
all, stays inert.

**Without herdr**, the session claims the directory in a sibling
`.conductor-tick-owner.json` (pid, session file, claim time) and ticks only while
it is the live claimant. Liveness is a **pid check, never a timestamp**: a crashed
orchestrator's claim is reclaimed by the next session rather than wedging the
fleet until somebody deletes a file, and a slow-but-running orchestrator never
loses its claim to a lease that expired.

Declining is logged once, at session start, naming the holder — which is the whole
point, because the original failure was that the second ticker was
indistinguishable from the first:

```text
[omp-conductor] orchestrator tick inactive: pane w1:p1 (agent "fleet") owns the fleet tick here — this session will not tick
[omp-conductor] orchestrator tick inactive: this pane is agent "scratch", not the fleet agent "fleet" — this session will not tick
[omp-conductor] orchestrator tick inactive: pid 4147344 (claimed 2026-08-07T07:55:36.001Z, session …/fleet.jsonl) owns the fleet tick in /root/.omp/conductor — this session will not tick
```

A `herdr agent list` that does not answer also declines, for the same reason the
escalation channel fails closed: under herdr this session is one pane of several
in that directory, and an unproven identity is exactly the case the check exists
for. That includes `herdr` not being on the session's `PATH` — worth checking on a
fleet host, where the orchestrator's environment comes from a unit file rather
than a login shell — and `HERDR_BIN_PATH` names the binary when it is not, the
same escape hatch the recovery plugin's `recover.sh` has. On a host with no herdr
and no prior claimant — the ordinary single-session case — nothing changes.

### The escalation channel is a gate, and it fails closed

Unattended dispatch is only defensible while a tier-2 escalation can reach a
person. So `accessFile` is checked on **every** tick and never cached at session
start: the bridge is reconfigured out-of-band, and a heartbeat that trusted a
startup snapshot would keep dispatching for days after the channel went away. A
stale arm marker must not outlive the channel that makes running unattended safe.

The check passes only when the file parses to an object with `enabled: true` and
exactly one `allowFrom` entry. Everything else stops the heartbeat: file missing,
unreadable or truncated; not JSON, or JSON that is not an object; `enabled`
absent or false; zero owners paired (nobody to page) or more than one (ambiguous:
the conductor refuses to guess which human is on the hook). Failure modes are
deliberately not distinguished in the decision: each one means a page lands
nowhere.

Leaving `accessFile` unset passes the gate, because an ordinary developer session
that happens to have a `.conductor-tick.json` has no bridge to check. It is not an
off switch for the check: **a fleet deploy always sets it.**

Every tick — sent or skipped — is logged with its reason (`not armed`,
`escalation channel down`, `tick already pending`) to the omp log. `/conductor
pause` is deliberately **not** one of the gates: pause stops the *dispatcher*
claiming work, and the tick drives a different session — one whose duties
(grooming the queue, draining escalations, reporting) are exactly what stays
useful while dispatch is stopped. Its own off switch is the arm marker. Skips
are deliberately silent in the UI: a disarmed fleet would otherwise raise a
notification every interval, forever. The one exception is a malformed
`.conductor-tick.json`,
which notifies once at session start and leaves the heartbeat off; silent failure
there is the failure mode the heartbeat exists to prevent. A conductor config that
cannot supply a reporting scope logs `tick reporting scope: using material` once
per session. The interval does not re-log it, because the file is unlikely to fix
itself between two ticks.

### A wedged session, and the marker that notices

Coalescing is also the only wedge detector this package has. On 2026-08-07 the
dogfood fleet's orchestrator finished a turn, logged `ui.loop-blocked` right
after an auto-compaction threshold decision, and never started another. The
process stayed alive, so herdr's recovery — agent listed AND a non-shell
foreground process — read healthy. The dispatch daemon is a separate process and
kept working, so `/healthz` was green all night, while the one brain holding
merge authority sat on a green PR it never merged. A tick injected two minutes
into the wedge and an operator's Telegram message five minutes later both went
unconsumed for 23 minutes, until a manual `SIGTERM`. The heartbeat logged `tick
skipped: tick already pending` throughout, which is exactly what a merely slow
turn looks like.

So the heartbeat counts them. Two consecutive coalesced ticks — a full hour at
the reference 1800-second interval, generous by construction — mean the last
prompt was never consumed, and the extension:

- writes `<session cwd>/.conductor-stalled`, one line of `<ISO timestamp>
  <diagnosis>`.
- logs at **error** level: `orchestrator stalled: 2 ticks queued unconsumed —
  the agent loop is not draining; see .conductor-stalled`.

Both escapes deliberately leave the session, because a loop that cannot drain
its queue cannot report on itself — that is the whole failure.

**The daemon reads it.** A marker nobody consumes is an artifact, not an alert,
so the dispatch daemon checks it on its own five-minute tick — and *before* its
pause check. The orchestrator is a different process and can be wedged while
the fleet is deliberately paused, which is precisely the state the dogfood
fleet was in when this happened. One tier-2 page per stall, keyed on the
marker's own timestamp so a second wedge the same day is not swallowed as a
repeat, re-armed when the marker clears, and latched only once the page is
confirmed delivered — an escalation channel that fails on the one tick that
noticed must not buy permanent silence.

It restarts nothing. A wedge lands mid-turn, and no other process can tell a
half-applied edit from an idle loop; the operator attaches, looks, and decides.

**herdr-conductor deliberately does not read it**, though its liveness test
(agent listed AND a non-shell foreground process) passes straight through a
wedge. That plugin only runs on `startup`, `pane.exited` and
`pane.agent_detected`, and a session that stays alive and stops working emits
none of them — so the check could never fire during the wedge itself. What it
*would* catch is the recovery afterwards: the marker survives a restart until
the new session consumes a tick, so every operator SIGTERM-and-resume would
page about the healthy session they just fixed. Telling those apart needs the
process start time against the marker's, and herdr's `pane process-info`
reports pids, not start times. The daemon gives up at most one tick of
coverage and never cries wolf.

The first tick that actually sends clears the counter and deletes the marker,
and it deletes one it did not write: recovery normally arrives as a fresh
process resuming the same transcript, so the session doing the clearing is not
the session that stalled. Nothing else removes the file. Neither the write nor
the delete can take the heartbeat down — a filesystem error is logged and the
tick carries on.

`omp-conductor status` reads the same marker from the **state directory** and
prints one more line under the daemon block:

```text
orchestrator   STALLED since 2026-08-07T06:27:55.123Z — 2 ticks queued unconsumed — the agent loop is not draining
```

That reading is the reference deploy's convention — the orchestrator session
runs from `~/.omp/conductor`, which is the state directory — and it is
one-directional: a line there proves a wedge, and its absence proves nothing,
least of all on a fleet whose session lives somewhere else.

## CLI reference

```bash
omp-conductor start [--port N] [--project NAME]
omp-conductor stop
omp-conductor restart [--port N] [--project NAME]
omp-conductor status [--project NAME]
omp-conductor tail <issue> [--project NAME]
omp-conductor unblock <issue> [--project NAME]
omp-conductor daemon [--once] [--port N] [--project NAME]
omp-conductor pause
omp-conductor resume
omp-conductor graph-setup [--project NAME] [--write]
omp-conductor brief-upgrade [--migrate|--retrofit] [--apply] [--file PATH] [--project NAME]
omp-conductor help
```

| Command | Behaviour |
| --- | --- |
| `start` | Spawn the loop in the background, detached, and wait until it answers `GET /healthz` on `:8787`. Refuses if one is already live, naming its pid. If the process dies or never serves, `start` cleans up after it and quotes the tail of `daemon.log`. |
| `stop` | Prefer `systemctl stop omp-conductor.service` when that unit's MainPID is the live daemon — systemd then owns the stop and will not schedule a restart for the exit it just requested. Otherwise `SIGTERM`, then `SIGKILL` after a 10-second grace period. Prints `not running` when there is nothing to stop, and tags the confirmation with `(via systemctl)` when the unit path was used. |
| `restart` | Prefer `systemctl restart` when the unit owns the live pid so the replacement stays supervised; otherwise `stop` then `start`, inheriting the running daemon's port and project unless a flag overrides them. The new process **salvages dirty live worktrees before orphaning** those rows — see [Deploying a new package onto a busy fleet](#deploying-a-new-package-onto-a-busy-fleet). |
| `status [--project NAME]` | Pause state, config and state paths, resolved caps, active runs and today's usage, plus a `daemon` block: pid, uptime, port, project, `/healthz` result and log path. While live workers > 0, prints a `deploy` line naming the count so a busy restart is visible before you take it. A `.conductor-stalled` marker in the state directory adds an `orchestrator   STALLED since …` line — see [the stall marker](#a-wedged-session-and-the-marker-that-notices). Reads while a daemon in another process writes. |
| `tail <issue>` | Follow the newest run for that issue: the worker's assistant text as `assistant: …` and each tool it calls as `tool: <name>`, printed as they land. Workers are omp sessions inside the daemon rather than terminals, so this is the only way to watch one live — a herdr pane running it becomes an observation window. Starts from the top of the transcript, not the end, so attaching to a run that is already ten turns in shows those ten turns. Exits `1` with `no run recorded for #N` when the issue has never been dispatched, or `no transcript yet (state: …)` when the attempt has not opened one. Otherwise it runs until `Ctrl-C`, or until the run has finished and its transcript has been silent for five seconds, and prints `run ended: <state>`. |
| `unblock <issue>` | Remove that issue's `blocked` and `failed` state labels through the tracker, so the next tick can claim it again. This is the supported way back for an escalation you answered: eligibility disqualifies any issue carrying a state label, so an answered issue that keeps one is never re-claimed and the answer is inert. Removing a label the issue does not carry is a no-op, so both are always cleared and neither has to be looked up first. `agent:in-progress` is deliberately not touched — it means a worker process exists, which is not something an answer changes. The run history is left exactly as it is: an answered block still spent a worker, so it still counts toward `maxAttemptsPerIssue`, and the output says how many attempts remain — or warns that the next tick will escalate instead of dispatching, when none do. Exits `2` with `unblock needs an issue number` on a missing or malformed positional. |
| `daemon` | Run the loop in the **foreground**, ticking every 5 minutes and serving `/healthz`. This is what `start` launches, and what a systemd unit should call. Writes the pidfile itself, and refuses with `another daemon is alive (pid N); stop it first` rather than becoming a second dispatcher. |
| `daemon --once` | Run a single tick and exit. No HTTP server, and no pidfile — a drill must not register itself as the daemon, or the next reader believes it and the real daemon's in-flight runs get reconciled as orphans. |
| `--port N` | Accepted by `start`, `restart` and `daemon`. Both `--port 9000` and `--port=9000` work; missing or out of range exits `2` rather than falling back to the default, because probing the wrong endpoint is worse than a hard failure. |
| `--project NAME` | Pick the project to service. One daemon process serves exactly one project; with several configured projects the name is required. |
| `pause` | Stop claiming new work. The running daemon notices on its next tick; runs already in flight finish. The orchestrator heartbeat keeps ticking — its gate is the arm marker, not this flag. |
| `resume` | Allow claiming again. |
| `graph-setup` | Print how to set up the code-graph indexes workers query instead of grepping: a `git clone` for every index-only clone that does not exist yet, the one-shot index command per repo, and a `cbm-reindex.service` + `cbm-reindex.timer` pair generated from the project's own repos and branches. Reads only, so it is safe on a host where you are not root. Exits `1` when no repo in the project has [`graphProject`](#configuration) set, because the fix is a wizard answer rather than a flag. See [Code-graph discovery](#code-graph-discovery). |
| `--write` | Only for `graph-setup`. Writes the refresh script into the state directory and the two units into `/etc/systemd/system`, then prints the exact `systemctl daemon-reload && systemctl enable --now cbm-reindex.timer` to run. It never runs `systemctl` itself and never enables anything: that needs root, and a package that enables system timers behind your back is one you cannot audit by reading its output. |
| `brief-upgrade` | Inspect the package-floor + `POLICY.md` overlay. Reports by default; see [Keeping a brief current](#keeping-a-brief-current). |
| `--migrate` | Only for `brief-upgrade`. Lift a bannered `ORCHESTRATOR.md` owned half into `POLICY.md` and recompose. Dry-run unless `--apply`. |
| `--retrofit` | Only for `brief-upgrade`. Propose (or with `--apply`, write) a `YOURS TO EDIT` banner before the first owned-topic heading on a hand-written brief. |
| `--apply` | Only for `brief-upgrade`. Confirms `--migrate` / `--retrofit`, or legacy single-file merge above the banner. |
| `--file PATH` | Only for `brief-upgrade`. Check a brief that is not where the wizard would have put it, on a host that may have no config at all. |
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

Any other path or method returns `404`. Note that `ok` reports only that the
process is serving. It does not report that the fleet is doing work: read
`paused` to tell those apart.

`activeRuns` counts occupied issues — live workers plus green PRs still awaiting a
merge — and each of those is settled by the tick once its PR resolves, so the
number goes back down on its own. A count that only ever grows is the bug this
used to have: read [what settles a green PR](#what-settles-a-green-pr).

## What a worker may and may not do

Each worker gets one brief, one worktree, one branch, and no knowledge of the
dispatcher. The brief is explicit about the boundary:

| It may | It must not |
| --- | --- |
| Read the issue and the repo's own guidance (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, relevant ADRs) before writing anything. | Touch any path outside its worktree, or switch branches. |
| Query its repo's [code graph](#code-graph-discovery), when one is configured, by the project name whose `root_path` matches the clone its brief names. | Query that graph by its own cwd or worktree path — no index of a worktree exists — or treat what it returns as current. It is a snapshot of the clone's default branch; the real file in the worktree wins. |
| Edit code inside its own worktree. | Weaken, skip, delete or loosen **any test it did not write** — that is a design question to escalate, and it is checked by diff review before the push. |
| Add or update tests for behaviour it introduced. | Suppress a warning, delete an assertion, or special-case an input to make a check pass. |
| Run the repo's configured cheap gates, each from its listed `cwd`, over the whole tree. | Run docker or image builds, production builds, browser/e2e suites, or the full test suite on the shared host — CI owns the heavy gates. |
| Review its whole diff, then commit and **push once**. One corrective push if CI is red. | Force-push, `git add -f`, or add AI/co-author attribution. Red twice means stop and report, not push a third time. |
| Open a PR that links the issue, and watch CI to a verdict with `gh pr checks --watch`. | Run `gh pr merge`. **A worker never merges** — that one is absolute, whoever else holds the authority — so PRs land one at a time with a freshness re-check; two workers merging concurrently is how agent PRs clobber each other. Who *may* merge is the [`authority`](#configuration) answer, and it is never the worker. |
| Escalate: ambiguity, a cross-repo contract, a needed credential, a product or data-migration decision, a blocking existing test, CI red twice, or most of the wall-clock budget burned. | **Cut a release**, push a tag, publish to npm, edit a deployment pin, deploy, or touch infrastructure or secrets — permanently out of scope. Releases are batched and decided outside this loop, so "this needs releasing" is a thing to report, never a task to take on. |

The worker ends with a six-line evidence report (issue, pr, state, gates, changed,
next). `pushed-green` means it watched the checks go green rather than expecting
them to.

### The boundary is prompt text — and one tripwire

A worker session gets a `cwd` and nothing else: the harness applies no filesystem
or network restriction, so "touch any path outside its worktree" is a rule the
session is asked to keep, not one the process cannot break. Target selection *is*
mechanical — only a repo in `routing.repos` is ever checked out — and so are the
caps, but between them they bound where work starts and how much of it happens,
not how far a wandering or prompt-injected session can reach.

The one path that is checked mechanically is the conductor itself. At startup the
daemon sha256s every `.ts` and `.md` file of its own installed `src/` — the
dispatcher and the briefs both, since rewriting a brief buys more than rewriting
the loop — and re-walks that tree on every tick (about 0.6 ms). Any difference at
all, changed or added or removed, is read as the package having been modified
underneath a running daemon: the tick claims nothing, the fleet is paused, and a
tier-2 escalation naming the first few differing paths pages you **once**, not
every five minutes.

**A normal deploy never trips it.** The baseline is recorded per daemon process,
so installing a new build and restarting the unit re-records it from the new
files; only a change that lands *while* a daemon is holding the package open can
diverge from it. That also means `omp-conductor resume` on its own will not hold
— the next tick re-walks, still differs, and pauses again. Put the files back, or
restart onto the build you meant to be running.

This is detection, not prevention. It catches the worker that wandered, and it
catches the human who edited the live install "just to test something", which in
practice is the commoner of the two.

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
  and the daily-spend cap never fires. The turn and wall-clock ceilings are what
  actually bound a runaway in that case. Do not treat `$0.00` as proof that nothing
  was spent.
- **GitHub is the only tracker.** The internal `Tracker` port is deliberately
  provider-neutral, but `tracker.kind` accepts only `"github"` today.
- **One project per daemon process.** Several projects means several processes,
  each with `--project` and its own `--port`.
- **Labels are matched exactly and case-sensitively.** `Ready-For-Agent` is not
  `ready-for-agent`, and the mismatch is silent: the issue is simply never picked
  up.
- **No cross-process lock on the mirrors.** Two dispatch loops fetching the same
  repo at the same instant can collide on git's ref locks; the run fails and is
  retried rather than corrupted.
- **Mirrors grow one branch ref per run.** Unpushed work is never discarded, so
  refs accumulate until you reap them.
- **`stop` is a deadline, not a clean drain.** Whether it goes through
  `systemctl` or a raw signal, the loop is asked to finish the tick it is on, and
  a tick with a worker in flight can run for that worker's whole wall clock; the
  signal path escalates to `SIGKILL` after 10 seconds. There is no "stop once the
  current worker lands". A unit that supervises the daemon should set
  `SuccessExitStatus=0 143` (belt-and-braces for a handled `SIGTERM` exit) and
  operators should prefer `omp-conductor stop` / `systemctl stop` over a raw
  `kill`, so `Restart=on-failure` cannot misread a deliberate stop as a crash.
- **A failed orchestrator degrades quietly.** The daemon logs a warning and keeps
  running, but tier-1 escalations then land in issue comments — which is exactly the
  "nobody reads it until morning" path the orchestrator exists to avoid. The warning
  is in `daemon.log`; nothing pages you about it.
- **Workers are not terminal panes, so you cannot watch them.** A worker is an
  in-process omp session inside the daemon, started by `createSession` and driven
  concurrently via `Promise.allSettled`. Herdr therefore shows exactly one pane
  (the orchestrator's) no matter how many workers are running, and no amount of
  `maxConcurrentWorkers` changes that.

  The cap does work. The admission loop (`admitCandidates` in `src/daemon.ts`) computes
  `slots = maxConcurrentWorkers - live workers`, admits at most that many issues
  per tick, and dispatches them together. To see them, read `omp-conductor
  status`, which lists every occupied issue, or follow `daemon.log`.
- **Merges, releases and deploys are human-only, by design.** The conductor
  produces green PRs and stops.
- **Worker confinement is behavioural.** `runWorker` hands the session a `cwd` and
  a brief; nothing stops it reading or writing elsewhere on the host, and on a
  single-user deploy that includes the state directory and the host's `gh`
  credentials. The [integrity tripwire](#the-boundary-is-prompt-text--and-one-tripwire)
  turns one case of this into a paused, paged fleet after the fact; the prevention
  half is a deployment concern — run workers as a least-privileged uid whose write
  access ends at its worktree and mirror.

## License

MIT
