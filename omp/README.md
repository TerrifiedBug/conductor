# omp-conductor

A 24/7 dispatcher that takes `ready-for-agent` GitHub issues to green, mergeable
PRs using omp coding sessions. When a run cannot finish on its own it escalates in
tiers: first to an orchestrator session that can re-brief the worker, then to you.

## What it is

You label an issue. Within one tick the conductor claims it on the tracker, cuts a
worktree, hands one omp worker a self-contained brief, and watches it to a green
PR. The worker then stops: it never merges, tags, publishes or deploys.

### Scope

One issue, one green PR. That is the worker's whole remit. A change that needs a
merge or release is reported to the orchestrator, whose `merge` and `release`
authority are chosen during setup and default to `human`. Granting either action
to the orchestrator never grants it to a worker or the dispatch daemon. Releases
remain batched from coherent groups of merged work, never cut one per worker PR.

Code counts every limit that decides whether work starts: concurrency, dollars
per day, turns and wall clock per worker, failed implementation attempts, and
operational continuations per issue. None is left to the model. The dispatcher
enforces these budgets before anything is claimed and kills workers that exceed
their per-run limits.

When a run does get stuck, the first responder is not you. A tier-1 escalation is
injected into a long-lived **orchestrator session** that can read the issue and the
run's transcript and then either re-brief the worker or decide the problem genuinely
needs a human. It never edits product code and never pushes a branch; whether it
may merge or release is a setup answer (`authority`), and both default to no. Only
tier 2 pages you directly.

The package ships three deployables, plus two skills:

| Deployable | Entry | What it is for |
| --- | --- | --- |
| omp plugin | `/conductor` slash command | Inspect and control the fleet from inside an omp session: status, hold/halt, arm/disarm, pause/resume, setup. |
| Standalone daemon | `omp-conductor` binary | The dispatch loop, managed as a background process (`start` / `stop` / `restart`) with a `/healthz` endpoint for a supervisor. |
| Orchestrator heartbeat | omp extension, activated by `.conductor-tick.json` | Prompts a 24/7 orchestrator session on a fixed interval so its standing loop actually runs, and marks the session stalled when its prompts stop being consumed. Inert in every other session — including a second session opened in the fleet's own directory. See [Orchestrator tick](#orchestrator-tick). |
| Onboarding skill | `skill://conductor-onboarding` | Directs an omp session to interview you, read your repos for real CI gates, and tailor `ORCHESTRATOR.md` — then finish through the wizard. Discovered automatically once the plugin is installed. See [Onboarding](#onboarding). |
| Update skill | `skill://conductor-update` | Treats the Bun-global CLI, omp plugin, and Herdr plugin as one operation: pause claims, drain, install one pinned release, reload, verify twice, and restore the prior pause state. See [Updating](#updating). |

The first two are thin wrappers over the same `daemon.ts`, so the plugin and the
CLI cannot disagree about what a cap means or where the state lives. Claiming is
gated by the pause flag; tick sends are gated by the arm marker — they are not
the same switch. Prefer `hold` when you want both quiet.

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
`src/tracker/github.ts`, which implements the whole nine-method `Tracker`
interface in `src/types.ts` (`listReady`, `addLabel`, `removeLabel`, `comment`,
`close`, `linkParent`, `parentOf`, `openCloserFor`, `prState`) that a future
backend would swap in.

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

From a checkout of the monorepo, `./setup.sh` checks both plugins. It preserves
an existing npm-managed `omp-conductor` and links only the Herdr half, so running
setup on a release-based fleet cannot silently switch omp to mutable source.
`./setup.sh install --force-link` is the explicit opt-in to link both checkout
directories.

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

## Updating

Say “update conductor” from an operator shell or maintenance omp session outside
the target `herdr-fleet.service`. That is the whole operator interface. The bundled
`skill://conductor-update` discovers the installed and registry versions, pauses
new claims while active work drains, and pins one release across the Bun-global
CLI, omp plugin, and Herdr plugin. It converts an old local Herdr link to a managed
checkout when necessary, reloads the Herdr service and dispatch daemon, verifies
the layered status twice, and restores the original dispatch state.

Ticks remain in their existing armed or disarmed state, so an ordinary update
does not halt the exact pane or require another Telegram arm challenge. Any
installation, reload, or verification failure leaves dispatch paused instead of
bringing up a mixed fleet. The skill does not publish npm or edit an install root.
It also refuses to run from the fleet pane that Herdr must restart: an updater
that kills itself cannot verify the result. With skill commands enabled, invoke
it directly with:

```text
/skill:conductor-update
```

## Onboarding

Onboarding this package has two layers, and installing it gives you both.

| Layer | What it is | What it owns |
| --- | --- | --- |
| **`/conductor setup`** | The deterministic wizard. It shows the label, runtime, and dry-run plans before one consent step. A configured project can amend one area. | **Mechanical setup.** It writes `config.json`, labels, the brief, an external heartbeat config, and a staged systemd unit. It also completes the paused smoke and arm gates. |
| **`skill://conductor-onboarding`** | A skill bundled in this package (`skills/conductor-onboarding/SKILL.md`). Any omp session can discover it after plugin installation. | **Brief authoring.** It supplies the judgment that fixed prompts cannot. |

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
"platform" is already configured — what would you like to do?
> Change one area
    asks one area's questions; every other answer is carried through from the saved config
  Walk every question again
    the full interview, every prompt pre-filled with what is configured now
```

Amending is the default. Pick it and the eight areas are listed with what each one
says right now, so the row you want is the row you can see:

```text
Which area? Each row shows what it says now
  tracker & repos — acme/platform, queue "ready-for-agent", "repo:" → platform, api, web, worker
  gates — platform: bun run check; api: ruff check . @ backend; web: pnpm lint…
  caps & worker model — 2 workers, 120 turns, 90m, $25/day, 2 attempts (all defaults) — harness default model
  code graph — not configured — workers grep
  authority — merge=orchestrator, release=orchestrator
  escalation & triage — tier 2 pages Telegram 123456789, comments too, triage external
  reporting scope — material — escalations, plus green PRs, second failures, and anything that stops the fleet
  orchestrator brief — none at ~/.omp/conductor/worktrees/ORCHESTRATOR.md
```

Only that area's questions are asked. Every other answer is read back out of
`config.json` and written again unchanged — the same answers, the same builder,
the same single confirm, so there is still exactly one thing in this package that
writes a config, and it still writes nothing before you agree. The consent screen
leads with the delta and then shows the whole project as it would be written:

```text
amending       code graph  —  project platform
  was            not configured — workers grep
  now            ~/.cache/conductor-graph/acme — 4 clone(s): platform, api, web, worker
  carried over   tracker & repos, gates, caps & worker model, authority, escalation & triage, reporting scope, orchestrator brief
                 read back from ~/.omp/conductor/config.json and rewritten unchanged
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
- **Legacy bannered brief**: `--migrate` lifts the owned half into `POLICY.md`
  and recomposes. Previous brief and policy versions go to
  `$OMP_CONDUCTOR_HOME/backups/briefs/` (default
  `~/.omp/conductor/backups/briefs/`), named with their source filename and
  timestamp.
- **Hand-written brief** (no banner): `--retrofit` inserts the banner before the first Releases / Project context / Reporting / Amendments heading; then `--migrate`.
- **Legacy `--apply`**: still merges a bannered single-file brief when you need the old path.
- **Existing sidecars**: a composed refresh relocates conductor-generated
  `ORCHESTRATOR.md.bak-<timestamp>` and `POLICY.md.bak-<timestamp>` files into
  that backup directory. Other `.bak` files stay untouched.

`--file PATH` checks a brief that is not where the wizard would have put it.

The **Learning loop** proposes diffs against `POLICY.md` for you to approve over
Telegram. It also learns from repeated operational friction. The daemon
automatically rolls up repairable admission holds; the orchestrator records
judgments code cannot make with:

```bash
omp-conductor friction escalation-digest --detail "routine retry belonged in the digest" [--issue N]
omp-conductor friction report-noise --detail "green status repeated with no operator action"
omp-conductor friction report-surprise --detail "a material failure was missing from the report"
```

Three observations within seven days make a bounded signal eligible for one
tick. After it is surfaced, that signal cools down for seven days. A signal is
evidence to investigate, never an automatic policy edit: the existing one-at-a-
time Telegram approval, `POLICY.md`-only edit, Hard-boundary prohibition, and
**Amendments** log still apply.

## Quick start

1. Install `omp-conductor` and `omp-telegram`. Pair the Telegram bot and enable its bridge.
2. Open the long-lived omp session in the fleet workspace.

   The default workspace is `~/.omp/conductor/worktrees`. The wizard shows the actual path before it writes files.

3. Run the wizard:

   ```text
   /conductor setup
   ```

   The wizard reads the tracker with the same routing code as the daemon. It shows every issue that the next tick can route.

   Nothing changes before the consent step. After consent, setup does these actions:

   - creates the required labels;
   - writes `config.json` and the selected brief;
   - writes `.conductor-tick.json` for external orchestration;
   - stages `omp-conductor.service` under the conductor state directory;
   - runs `daemon --once` while dispatch is paused;
   - starts a temporary daemon and proves `/healthz` and stored status;
   - stops the temporary daemon;
   - proves the inbound Telegram path before it arms an external heartbeat;
   - clears the dispatch pause only after all required gates pass.

   If the arm proof cannot complete, setup keeps dispatch paused. The result shows the exact recovery commands.

4. On a systemd host, run the install commands that setup prints.

   The commands install the staged unit, reload systemd, enable the unit, and restart it. The generated unit contains the current user, paths, project, port, and memory ceiling.

   On a host without systemd, start the daemon directly:

   ```bash
   omp-conductor start
   ```

5. Read the layered status:

   ```bash
   omp-conductor status
   ```

   The result must show a running daemon, a healthy `/healthz`, armed ticks for external orchestration, and the configured project.

### First worker drill

Use a disposable target repository for this drill. Replace the values below with labels that the wizard showed.

```bash
TRACKER=acme/planning
QUEUE=ready-for-agent
ROUTE=repo:api

gh issue create --repo \"$TRACKER\" \
  --title \"Conductor setup drill: add a marker file\" \
  --body $'Add `conductor-smoke.txt` to the target repository.\\n\\nAcceptance: the file contains `setup path verified` and the pull request checks pass.' \
  --label \"$ROUTE\" \
  --label \"$QUEUE\"
```

The daemon claims the issue, creates a worktree, runs the configured gates, and opens a pull request. Follow it with:

```bash
omp-conductor status
omp-conductor tail <issue-number>
```

Merge the green pull request. Then make sure that status moves the run to `merged` and frees its worker slot.

The loop ticks every 5 minutes while workers remain active. Merge settlement and capacity checks do not wait for the longest worker.

`omp-conductor stop` drains active workers before it stops. On systemd, it uses `systemctl stop` to prevent an automatic restart.

The package also ships a generic unit at
[`systemd/omp-conductor.service.example`](systemd/omp-conductor.service.example).


### Stop the conductor (hold / halt)

Four control planes used to answer "stop" differently. The package verbs:

| Verb | Claiming | Tick sends | Dispatch daemon | Conductor pane |
| --- | --- | --- | --- | --- |
| `hold` | paused | disarmed | left running | left running |
| `halt` | paused | disarmed | stopped (systemctl-aware) | left running |
| `halt --pane` | paused | disarmed | stopped | stopped + recovery pinned off |
| `pause` | paused | **still armed** | left running | left running |

`resume` clears pause only and **never re-arms**. `arm` is proof-gated: it sends a Telegram challenge and writes the arm marker only after your reply appears as a *user* turn in the orchestrator transcript. `halt --pane` targets the configured conductor agent only — it does **not** run `systemctl stop herdr-fleet`.

`status` prints a layered header (`dispatch` / `ticks` / next tick time / `pane` / `recovery` / `herdr` / `telegram` / `daemon`) so a paused fleet cannot hide an armed orchestrator still spending turns. The Telegram line calls the official `getMe` endpoint to prove the token and API are usable without sending a message, then separately reports whether the inbound bridge is configured.

`omp-conductor board [--project NAME]` opens the same facts as a live terminal
kanban instead of a scrolling wall of status text. Its columns are Queue,
Claimed, Running, Green, Blocked, Failed, and Merged. Queue cards are the
bounded per-issue hold sample recorded by the latest dispatch; the Queue count
is the authoritative ready count even when there are more ready issues than
sampled cards. Run columns show the newest attempt for each issue. Merged keeps
only the last 24 hours so the board stays operational rather than becoming an
analytics archive.

The board refreshes run, spend, turn, and dispatch values from SQLite every
second. It refreshes the slower daemon, Herdr, Telegram, and code-graph health
layer every ten seconds or immediately with `r`. Use arrow keys or `h/j/k/l` to
select a card, `Enter` to inspect and follow its worker transcript, `u` to run
the normal unblock workflow, `i` / `p` to open the issue / pull request, `?` for
help, and `q`, `Esc`, or `Ctrl-C` to go back and quit. Narrow terminals show a
sliding subset of columns around the selection; terminals below 50×20 get a
single resize instruction instead of a broken layout. The board is read-only
except for the explicit `u` action: it never claims work or changes stages.

`halt --pane` is **fail-closed**: it exits `0` only when the conductor agent is
*proven* gone. It writes the recovery pin first, so a failed stop still cannot be
undone by `herdr-conductor` respawning the agent, and then refuses (nonzero exit,
message on stderr) on every uncertainty:

- no tick config exists at all — `recover.sh` reads only
  `$FLEET_CWD/.conductor-pane-halted`, and without that file the pane's own
  directory is unknown, so the pin would land somewhere recovery never looks and
  the agent would be respawned seconds later. `release-pane` refuses for the
  same reason, and `status` shows `recovery unpinnable` rather than `clear`
- the tick config does not parse — the agent name would be a guess
- `herdr agent list` is unreachable, prints nothing, or prints output with no
  explicit `agents` array; only a real `agents: []` means "no agents"
- an agent row is unreadable — a missing `name`/`pane_id`, or an `agent` field
  present with a non-string value. An *absent* or `null` `agent` is the sticky
  claim herdr reports after the agent exits, and stays a normal answer
- the configured agent name is not unique, or the claimed pane runs some other agent
- `pane process-info` fails, or the claim is live `omp` but names no recognizable
  omp foreground PID — "cannot see it" is never reported as "it is stopped"
- a signal cannot be delivered, or liveness cannot be probed — only `ESRCH`
  ("no such process") proves death, so `EPERM` reads as "exists, not ours",
  never as "stopped"
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
2. **Verify and settle pushed PRs.** For every run in `pushed-pending`, repeat
   the independent head/check verification; green → `pushed-green`, red →
   `failed`, and still pending stays occupied. For every verified
   `pushed-green` run, ask what became of its PR. Merged → `merged`; closed
   without merging → `failed`. Unknown answers leave the row unchanged. This
   runs above admission so a row settled here frees its issue in the same tick.
   See [what settles a green PR](#what-settles-a-green-pr).
3. **List the queue.** Open issues in `tracker.repo` labelled `queueLabel`.
4. **Filter and route.** An issue is eligible only if it carries the queue label
   and none of the three state labels (`inProgress`, `blocked`, `failed`). Eligible
   issues are partitioned into routable and unroutable.
5. **Escalate the unroutable** at Tier 1, quoting the repo labels actually seen and
   the configured repo names. These are never dispatched.
6. **Check spend.** If spend since local midnight has reached `dailySpendUsd`, the
   daemon **pauses itself**, pages at Tier 2, and returns.
7. **Check capacity.** `maxConcurrentWorkers` minus *live* workers (runs in
   `claimed` or `running`) gives the free slots. A pending or green PR occupies
   its issue but not a slot: its worker is finished, and counting pushed PRs
   would let two completed workers stop the fleet.
   If no slot is free, the tick logs and returns.
8. **Admit issues** up to the free slots, skipping any issue that already has
   an active run — including a pending or green PR, so a second attempt cannot
   land on a live PR. Repeated implementation failures consume
   `maxAttemptsPerIssue`; cap kills, daemon orphans and answered blocks consume
   the independent `maxContinuationsPerIssue`. Exhausting either escalates.
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
10. **Record the pass.** Persist ready/routed/admitted counts and group every hold
    under a stable reason code with at most five sample issue numbers. Tracker
    failures mark the summary `DEGRADED`; capacity, sibling, open-PR and budget
    holds remain normal policy state.
11. **Dispatch** the admitted issues concurrently.

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
   | `pushed-pending` | `agent:in-progress` stays while the daemon rechecks GitHub | removed | none |
   | `pushed-green` | `agent:in-progress` stays until the merge closes the issue | removed | none |
   | `blocked` | swapped to `agent:blocked` | removed | Tier 1 |
   | `failed` / `killed` | swapped to `agent:failed` | dirty tree committed to the branch, then retained until the PR or issue is terminal | Tier 1 |
   | unexpected error | swapped to `agent:failed` | same | Tier 1 |

   `pushed-pending` and `pushed-green` are not the end of the row: later ticks
   verify outstanding checks and settle the PR once it resolves. See
   [what settles a green PR](#what-settles-a-green-pr).

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

   Later ticks reap retained failure trees in bounded batches after the tracker
   proves their PR merged/closed or their issue closed, provided no live run or
   queued continuation owns the issue. Cleanup fetches remote refs first and
   keeps any dirty tree or branch with uniquely local commits. Only then does it
   remove the physical tree, prune registrations, and delete the obsolete local
   mirror branch. Unknown tracker, network, repo, or git state is a no-op.

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
tick re-claims it. Orphans consume `maxContinuationsPerIssue`, not failed
implementation attempts, so crashes cannot starve the retry needed for a real
code or CI failure — and a crash loop still escalates.

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

The worker watches CI, then reports the PR URL and the exact remote head SHA it
observed. The daemon independently reads the PR again and requires it to be open,
non-draft, still at that head, and backed by a non-empty check rollup in which
every check succeeded or was skipped. Missing or nonterminal checks become
`pushed-pending` and are rechecked on later ticks; red or cancelled checks become
`failed` with a bounded job/log digest. Only verified evidence becomes
`pushed-green`.

What happens after verification is a human's decision, taken minutes to days
later and never announced to the daemon — so every tick asks the tracker about
every pushed PR it is still holding:

| PR | Row becomes | Why |
| --- | --- | --- |
| merged | `merged` | The work landed. This is the state `merged` was reserved for. |
| closed without merging | `failed`, with the PR in `lastError` | A human read the work and said no. Leaving it `pushed-green` strands the issue forever behind a PR nobody will merge, and calling it `merged` is a lie about code that is not on the base branch. `failed` is true, and it releases the issue so a re-queue can be attempted again. |
| still open | unchanged | The normal steady state. Its issue must stay occupied, or a second attempt lands on the live PR. |
| could not be determined | unchanged | A flaky network, a revoked token, a deleted PR. An unknown answer never settles a row; the next tick asks again for free. |

Run history is untouched. A PR closed without merging becomes a concrete failed
attempt; a merge does not spend failure or continuation budget. A merge normally
closes the issue, and a human who closed a PR is already looking at it, so what
an issue's labels should say next remains the orchestrator's drain-duty
judgement. One unreachable PR costs its own row and nothing else; the rest of
the sweep still settles.

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

## Host sizing and memory

Workers are **in-process** omp sessions inside the daemon's single PID (plus one
long-lived orchestrator session). systemd's Memory peak for `omp-conductor.service`
is therefore daemon + every live worker + the orchestrator + any MCP stdio
children those sessions mount — not a separate worker process list.

On the reference deploy that produced [issue #51](https://github.com/TerrifiedBug/conductor/issues/51):

| Shape | Observed |
| --- | --- |
| Idle / workers restarting | ~430 MB RSS for the daemon alone |
| Two workers + orchestrator, busy | **3.2–4.2 GB** Memory peak for the unit; up to ~800 MB swap |

That peak is **expected for concurrent SDK sessions**, not evidence of a
conductor-side leak: the SQLite store is disk-backed, admission state is
per-tick, and worker sessions are disposed when a run ends. What grows is the
session heap (conversation + tool output); a single graph-assisted run has been
measured in the hundreds of thousands of characters of tool output.

**Practical guidance**

- Prefer **≥16 GiB RAM** for the default `maxConcurrentWorkers: 2`, and do **not**
  co-locate ClickHouse / other multi-GB services beside that fleet on an ≤8 GiB
  box.
- On hosts under ~16 GiB, set `maxConcurrentWorkers` to **1**. `/conductor setup`
  does this automatically when it can read host RAM.
- Supervise the daemon with a unit that sets `SuccessExitStatus=0 143` and a
  `MemoryMax=` just above your expected peak. A ready-to-edit example ships as
  [`systemd/omp-conductor.service.example`](systemd/omp-conductor.service.example)
  (`MemoryMax=5G` for the two-worker shape).
- `omp-conductor status` prints daemon `rss` from `/healthz` when the process is
  up, so you can see pressure without scraping journald.

## Caps

Caps resolve per project: the global `defaults` block, then the project's own
`caps` layered on field by field, so a project that pins one cap still inherits the
rest. `0` is a real value (a hard stop), not "unset".

| Cap | Default | What it protects |
| --- | --- | --- |
| `maxConcurrentWorkers` | `2` (setup may write `1` on &lt;16 GiB hosts) | Parallel in-process omp sessions inside the daemon PID. Two, because **CI runner slots, not model tokens, are the usual throughput ceiling** — a third worker would starve its own PR checks on a small self-hosted runner pool. On hosts under ~16 GiB RAM, prefer `1` so the unit stays out of swap ([host sizing](#host-sizing-and-memory)). Raise it only if you actually have the runners *and* the RAM. |
| `dailySpendUsd` | `25` | Rolling-day spend ceiling in USD, or `null` for no spend gate. `0` is a hard stop. Metered from assistant `usage.cost.total`. |
| `workerMaxTurns` | `120` | Startup ceiling for each new worker. Catches a session looping without converging; use `omp-conductor extend` to raise one live run without changing this default. |
| `workerWallClockMs` | `5400000` (90 minutes) | Wall-clock ceiling for one worker. A session that is merely stuck spends no turns, so turns alone cannot detect it. |
| `maxAttemptsPerIssue` | `2` | Failed implementation or CI attempts before escalation. Operational stops do not consume this budget, so salvage can continue without stealing the retry needed for a real failure. |
| `maxContinuationsPerIssue` | `2` | Cap-kill, daemon-orphan and answered-block resumes before escalation. This independently bounds crash/resume loops. |

Days are counted from **local midnight**, matching how a human reads "today".

Set `dailySpendUsd` to `null` (wizard: blank) for no money gate — turns and wall-clock still apply. Hitting a numeric `dailySpendUsd` is not the same as hitting the other caps. A concurrency
limit simply defers work to a later tick. The spend cap **pauses the daemon and
pages at Tier 2**: a loop that is burning money has to halt itself, because
waiting for someone to notice tomorrow is how a runaway becomes expensive.
Work resumes only after `omp-conductor resume` (or `/conductor resume`).

`workerMaxTurns` and `workerWallClockMs` are enforced inside the session driver.
The daemon reads a live run's effective turn ceiling at every turn boundary. Use
`omp-conductor extend <issue> --turns N [--project NAME]` to raise it without
restarting or reconstructing the session. Extension is monotonic: equal or lower
values are refused, as are runs whose live controller has already settled. The
effective value is persisted and shown beside that active run in `status`; editing
`config.json` changes defaults for future daemon starts, not workers already in
flight. A cap that fires aborts the run, records it as `killed`, and names the
ceiling in the escalation.

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

`omp-conductor` never installs, starts, imports, or depends on the indexer for
dispatch. With `graphProject` unset, nothing about dispatch, caps, escalation, or
status changes. A fresh host needs both of these before an index is worth
anything, and `graph-setup` reports them as step 0:

1. **`codebase-memory-mcp` on PATH** — a separate project,
   [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp).
2. **Mounted as an MCP server** in `~/.omp/agent/mcp.json`, on the account the
   daemon runs as. Miss this and the failure is silent: every index builds
   correctly, no worker session can read any of them, so workers fall back to
   grepping and the feature looks like a no-op. `graph-setup` prints the entry.

Say yes and the wizard asks for one root, then derives one clone per routed repo
underneath it (default `~/.cache/conductor-graph/<org>/<repo>`) and writes it to
each repo's [`graphProject`](#configuration). The only automatic interaction is
a bounded, read-only health query; this package never clones, fetches, builds an
index, or changes systemd. Dispatch, caps and escalation do not depend on graph
health. On a fleet configured before this key existed, `/conductor setup` and
the `code graph` area add it in two prompts — see
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

### Seeing whether the graph is usable

When at least one routed repo has `graphProject`, `omp-conductor status` adds a
`code graph` block. It proves the indexer is on `PATH`, the worker MCP config
mounts it, every configured clone exists and exactly matches an indexed
`root_path`, the refresh timer is enabled and active, and the last service run
succeeded within 45 minutes. A running daemon refreshes this evidence every
minute and publishes the cached result through `/healthz`; status probes the host
directly when that cache is unavailable. Every command is read-only, runs with a
one-second timeout, and graph degradation never changes `/healthz.ok` or blocks
dispatch. Unconfigured projects omit the block entirely.

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
the `sessions/` worker transcripts, the `orchestrator/` session directory,
`backups/briefs/` for timestamped brief and policy safety copies, and
`release-policy-blocks.jsonl`, the append-only audit of mechanically rejected
release/deploy calls.

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
    "maxAttemptsPerIssue": 2,
    "maxContinuationsPerIssue": 2
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
      "releasePolicy": "none",
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
| `releasePolicy` | Optional; `"none"` (default) or `"operator-brief"`. `none` installs a pre-tool-call tripwire in worker, embedded-orchestrator and external-orchestrator sessions. It blocks `git tag`, tag pushes, package publishing, GitHub release creation and recognised deploy commands before execution. `operator-brief` opens that gate only for the procedure in the operator-owned brief. Unknown values are errors. Every rejection is written to `release-policy-blocks.jsonl`; the heartbeat carries that day's count into the daily digest so configured intent and observed behaviour cannot drift silently. This is the mechanical gate; `authority.release` still says who owns the decision. |
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

The heartbeat is **inert unless the session cwd contains
`.conductor-tick.json`**, so an ordinary session has no timer. `/conductor setup`
writes this file for external orchestration. A manual configuration has this form:

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
[omp-conductor] orchestrator tick inactive: pid 12345 (claimed 2026-01-02T03:04:05.000Z, session …/fleet.jsonl) owns the fleet tick in /home/conductor/.omp/conductor — this session will not tick
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
omp-conductor --version
omp-conductor stop
omp-conductor restart [--port N] [--project NAME]
omp-conductor status [--project NAME]
omp-conductor board [--project NAME]
omp-conductor hold [--project NAME]
omp-conductor halt [--pane] [--project NAME]
omp-conductor arm [--project NAME]
omp-conductor disarm [--project NAME]
omp-conductor release-pane [--project NAME]
omp-conductor tail <issue> [--project NAME]
omp-conductor extend <issue> --turns N [--project NAME]
omp-conductor unblock <issue> [--project NAME]
omp-conductor friction <escalation-digest|report-noise|report-surprise> --detail TEXT [--issue N] [--project NAME]
omp-conductor daemon [--once] [--port N] [--project NAME]
omp-conductor pause
omp-conductor resume
omp-conductor graph-setup [--project NAME] [--write]
omp-conductor brief-upgrade [--migrate|--retrofit] [--apply] [--file PATH] [--project NAME]
omp-conductor help
```

| Command | Behaviour |
| --- | --- |
| `start` | Start `herdr-fleet.service` when that optional unit is installed, clearing a previous pane-recovery pin, then spawn the dispatch loop in the background and wait until it answers `GET /healthz` on `:8787`. Without systemd or that unit it keeps the standalone daemon behaviour. It never clears pause or arms ticks. Refuses if a daemon is already live, naming its pid; if the process dies or never serves, it cleans up and quotes the tail of `daemon.log`. |
| `stop` | Prefer `systemctl stop omp-conductor.service` when that unit's MainPID is the live daemon — systemd then owns the stop and will not schedule a restart for the exit it just requested. Otherwise `SIGTERM`, then `SIGKILL` after a 10-second grace period. Prints `not running` when there is nothing to stop, and tags the confirmation with `(via systemctl)` when the unit path was used. |
| `restart` | Prefer `systemctl restart` when the unit owns the live pid so the replacement stays supervised; otherwise `stop` then `start`, inheriting the running daemon's port and project unless a flag overrides them. The new process **salvages dirty live worktrees before orphaning** those rows — see [Deploying a new package onto a busy fleet](#deploying-a-new-package-onto-a-busy-fleet). |
| `status [--project NAME]` | Layered fleet report first: `dispatch` / `ticks` / next scheduled tick / `pane` / `recovery` / `herdr` / `telegram` / optional `code graph` / `daemon`, then the project body. The project body includes the latest completed dispatch timestamp, ready/routed/admitted counts, and bounded hold groups; API failures are marked `DEGRADED` so queue starvation cannot look idle. The next tick comes from the live heartbeat process, not a guess from log timestamps. Telegram health uses `getMe` to prove API authentication without sending a message and reports inbound bridge configuration separately. Configured graphs report prerequisites, indexed repos, timer state, and refresh freshness without blocking dispatch. The daemon block includes `rss` from `/healthz`; live workers add a busy-deploy warning. A `.conductor-stalled` marker adds an `orchestrator STALLED since …` line. |
| `board [--project NAME]` | Live keyboard-driven kanban over the same SQLite and `/healthz` truth as `status`: Queue, Claimed, Running, Green, Blocked, Failed, and the last 24 hours of Merged. Refreshes run/spend/turn values every second and slower health every ten seconds. `Enter` follows the selected transcript in place; `u` invokes the existing unblock workflow; `i` / `p` open the issue / PR; `r` refreshes health; `?` shows all keys. Requires an interactive terminal of at least 50×20. |
| `hold [--project NAME]` | Soft stop: pause claiming **and** disarm ticks. Daemon and pane stay up. Prefer this over `pause` when the intent is "stop the conductor" without killing processes. See [Stop the conductor](#stop-the-conductor-hold--halt). |
| `halt [--pane] [--project NAME]` | `hold`, then stop the dispatch daemon (systemctl-aware). Pane stays up unless `--pane` is passed. `halt --pane` also pins herdr-conductor recovery off for the conductor agent only — it does **not** stop `herdr-fleet.service` or any other herdr session. Fail-closed: exits nonzero unless the agent is proven gone. |
| `arm [--project NAME]` | Proof-gated: send a Telegram challenge and write the arm marker only after your reply appears as a user turn in the orchestrator transcript. Never auto-armed by `resume` / `hold`. |
| `disarm [--project NAME]` | Remove the arm marker so ticks skip. Processes untouched. |
| `release-pane [--project NAME]` | Clear the `halt --pane` recovery pin so herdr-conductor may resume the fleet agent again. |
| `tail <issue>` | Follow the newest run for that issue: the worker's assistant text as `assistant: …` and each tool it calls as `tool: <name>`, printed as they land. Workers are omp sessions inside the daemon rather than terminals, so this is the only way to watch one live — a herdr pane running it becomes an observation window. Starts from the top of the transcript, not the end, so attaching to a run that is already ten turns in shows those ten turns. Exits `1` with `no run recorded for #N` when the issue has never been dispatched, or `no transcript yet (state: …)` when the attempt has not opened one. Otherwise it runs until `Ctrl-C`, or until the run has finished and its transcript has been silent for five seconds, and prints `run ended: <state>`. |
| `extend <issue> --turns N [--project NAME]` | Monotonically raise that live worker's effective turn ceiling through its owning daemon. The current omp session keeps running; no restart or continuation is created. The daemon persists the new ceiling for `status` and rejects missing, settled, cap-killed, equal, or lower requests instead of implying that an immutable session changed. |
| `unblock <issue>` | Remove that issue's `blocked` and `failed` labels so an answered escalation can be claimed again. `agent:in-progress` is never touched. Run history remains intact: blocks consume the independent continuation budget, not failed implementation attempts. The output reports both budgets and warns when either will make the next tick escalate instead of dispatch. Exits `2` when the issue number is missing or malformed. |
| `friction <kind> --detail TEXT [--issue N]` | Record one bounded judgment the daemon cannot infer: an escalation belonged in a digest, or a tick report was noise/surprising. The detail is limited to 160 characters. One event never changes policy; three observations inside seven days make the aggregate eligible for one Learning-loop prompt, followed by a seven-day cooldown. |
| `daemon` | Run the loop in the **foreground**, ticking every 5 minutes and serving `/healthz`. Admitted workers run in a tracked background pool, so settlement and capacity checks remain periodic while they work; shutdown drains the pool before closing the store. This is what `start` launches and what a systemd unit should call. |
| `daemon --once` | Run a single tick, wait for workers admitted by that tick, and exit. No HTTP server or pidfile — a drill must not register itself as the daemon, or the next reader believes it and the real daemon's in-flight runs get reconciled as orphans. |
| `--port N` | Accepted by `start`, `restart` and `daemon`. Both `--port 9000` and `--port=9000` work; missing or out of range exits `2` rather than falling back to the default, because probing the wrong endpoint is worse than a hard failure. |
| `--project NAME` | Pick the project to service. One daemon process serves exactly one project; with several configured projects the name is required. |
| `pause` | Stop claiming new work only. The running daemon notices on its next tick; runs already in flight finish. The orchestrator heartbeat keeps ticking if armed — its gate is the arm marker, not this flag. Prefer `hold` to silence both. |
| `resume` | Clear pause only — does **not** re-arm. Run `arm` after an inbound Telegram proof to resume ticks. |
| `--version`, `-V`, `version` | Print the installed `omp-conductor` package version and exit `0`. Works from the global binary and npm/plugin install because it reads the package metadata beside the shipped CLI. |
| `graph-setup` | Print how to set up the code-graph indexes workers query instead of grepping: a `git clone` for every index-only clone that does not exist yet, the one-shot index command per repo, and a `cbm-reindex.service` + `cbm-reindex.timer` pair generated from the project's own repos and branches. Reads only, so it is safe on a host where you are not root. Exits `1` when no repo in the project has [`graphProject`](#configuration) set, because the fix is a wizard answer rather than a flag. See [Code-graph discovery](#code-graph-discovery). |
| `--write` | Only for `graph-setup`. Writes the refresh script into the state directory and the two units into `/etc/systemd/system`, then prints the exact `systemctl daemon-reload && systemctl enable --now cbm-reindex.timer` to run. It never runs `systemctl` itself and never enables anything: that needs root, and a package that enables system timers behind your back is one you cannot audit by reading its output. |
| `brief-upgrade` | Inspect the package-floor + `POLICY.md` overlay. Reports by default; see [Keeping a brief current](#keeping-a-brief-current). |
| `--migrate` | Only for `brief-upgrade`. Lift a bannered `ORCHESTRATOR.md` owned half into `POLICY.md` and recompose. Dry-run unless `--apply`. |
| `--retrofit` | Only for `brief-upgrade`. Propose (or with `--apply`, write) a `YOURS TO EDIT` banner before the first owned-topic heading on a hand-written brief. |
| `--apply` | Only for `brief-upgrade`. Confirms `--migrate` / `--retrofit`, or legacy single-file merge above the banner. |
| `--file PATH` | Only for `brief-upgrade`. Check a brief that is not where the wizard would have put it, on a host that may have no config at all. |
| `help`, `--help`, `-h` | Print usage. An unknown or missing verb prints it too, and exits `2`. |

Pause is a flag file under the state directory, so it applies to every project and
survives a daemon restart. Hold also removes the arm marker the heartbeat reads,
so both brains go quiet without killing processes.

These are available in-session as `/conductor setup`, `/conductor status`,
`/conductor hold`, `/conductor halt [--pane]`, `/conductor arm`, `/conductor disarm`,
`/conductor release-pane`, `/conductor pause` and `/conductor resume`, each taking
an optional project name. Background-process management (`start` / `stop` /
`restart`) is CLI-only: the plugin does not start, stop or restart the daemon.

### Health endpoint

```bash
curl -s localhost:8787/healthz
```

```json
{
  "ok": true,
  "paused": false,
  "activeRuns": 1,
  "project": "demo",
  "rssBytes": 123456789,
  "dispatch": {
    "completedAt": 1786185678000,
    "ready": 8,
    "routed": 8,
    "admitted": 0,
    "degraded": true,
    "holds": [
      { "reason": "parent-lookup-error", "count": 8, "issues": [321, 320, 318] }
    ]
  },
  "codeGraph": {
    "configured": true,
    "status": "degraded",
    "checkedAt": "2026-08-08T13:00:00.000Z",
    "prerequisites": { "indexer": "present", "mcpMount": "missing" },
    "repos": [
      {
        "name": "api",
        "path": "/home/fleet/.cache/conductor-graph/acme/api",
        "clone": "present",
        "index": "present"
      }
    ],
    "timer": { "enabled": "enabled", "active": "active" },
    "refresh": {
      "result": "success",
      "fresh": true,
      "lastSuccessAt": "2026-08-08T12:50:00.000Z",
      "ageMs": 600000
    },
    "reasons": ["worker MCP configuration does not mount the indexer"]
  }
}
```

Any other path or method returns `404`. `ok` reports process liveness only.
Nonfatal admission errors and graph degradation keep it `true` so a supervisor
does not restart-loop. Inspect `dispatch.degraded` and its bounded reason groups
for queue starvation; inspect `codeGraph` for configured graph health.
`activeRuns` counts occupied issues — live workers plus green PRs awaiting merge.

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
| Escalate: ambiguity, a cross-repo contract, a needed credential, a product or data-migration decision, a blocking existing test, CI red twice, or most of the wall-clock budget burned. | **Under the default `releasePolicy: "none"`:** cut a release, push a tag, publish to npm, edit a deployment pin, deploy, or touch infrastructure or secrets. The harness blocks recognised release/deploy tool calls before they run and audits the attempt. A project may deliberately set `operator-brief` only after its operator-owned brief contains the exact release procedure; that opens the tool gate but does not change `authority.release`. |

The worker ends with a seven-line evidence report (issue, PR, observed head SHA,
state, gates, changed, next). A textual `pushed-green` claim is not success: the
daemon repeats the PR/head/check verification before it records that state.

### Worker confinement and the integrity tripwire

A worker session is rooted at its worktree `cwd`. **Structured file tools are
gated mechanically:** `runWorker` asks `createSession({ confineToCwd: true })`,
which installs an inline harness extension that blocks `write` / `edit` /
`read` / `grep` / `glob` when the tool's path resolves outside that worktree
(symlink-aware). Target selection was already mechanical — only a repo in
`routing.repos` is ever checked out — and the caps still bound *how much* work
happens.

General shell access is not confined to the worktree. Its argument is an opaque
program, so the brief still forbids path escape and the deploy-level answer is a
least-privilege worker uid (below). The narrower release-policy tripwire does
inspect explicit command shapes such as `git tag`, `npm publish`, and deploy
verbs; it blocks those before execution when `releasePolicy` is `none`.

#### Integrity tripwire (package self-hash)

Separately, the conductor watches *itself*. At startup the daemon sha256s every
`.ts` and `.md` file of its own installed `src/` — the dispatcher and the briefs
both, since rewriting a brief buys more than rewriting the loop — and re-walks
that tree on every tick (about 0.6 ms). Any difference at all, changed or added
or removed, is read as the package having been modified underneath a running
daemon: the tick claims nothing, the fleet is paused, and a tier-2 escalation
naming the first few differing paths pages you **once**, not every five minutes.

**A normal deploy never trips it.** The baseline is recorded per daemon process,
so installing a new build and restarting the unit re-records it from the new
files; only a change that lands *while* a daemon is holding the package open can
diverge from it. That also means `omp-conductor resume` on its own will not hold
— the next tick re-walks, still differs, and pauses again. Put the files back, or
restart onto the build you meant to be running.

This catches a worker (or human) that still managed to edit the live install —
including via `bash` — after the fact. It is detection for the package boundary,
not a substitute for the worktree gate or a dedicated uid.

#### Least-privilege worker uid (deploy)

The largest remaining win is OS-level: run the daemon (or at least worker
sessions, when the harness supports a uid switch) as a user that can write only
its worktrees and mirrors. A sketch that matches the reference single-host
deploy:

1. Create a system user, e.g. `conductor-worker`, with home under
   `/var/lib/conductor-worker` (or similar).
2. `chown` the project's `workspaceRoot` and `mirrorRoot` to that user; leave
   `~/.omp/conductor/config.json` readable only by the operator/daemon account
   (`0600` as shipped).
3. Do **not** put the worker uid in `docker` / `sudoers`, and do not give it the
   operator's `gh` auth if a narrower deploy token can open PRs in the routed
   repos alone.
4. Point the [example systemd unit](systemd/omp-conductor.service.example)
   `User=` / `Group=` at that account once the daemon itself should run
   unprivileged end-to-end.

Until that uid exists, a root-or-operator daemon still has a mechanical
worktree gate on structured tools and an integrity tripwire on its own package —
but `bash` plus host credentials remain a prompt-and-deploy problem.

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
- **Uniquely local mirror branches are retained.** Terminal runs are reaped
  automatically only after every commit exists on a remote ref. A failed salvage
  push deliberately leaves its branch and tree for an operator rather than
  trading disk hygiene for data loss.
- **`stop` is a bounded best-effort drain.** A signal stops new ticks and the
  daemon waits for its active worker pool before closing the store. The CLI
  escalates to `SIGKILL` after 10 seconds, so a worker that needs longer is
  orphaned and salvaged on restart. Use `pause`, wait for `workers 0 / N`, then
  stop when a clean drain matters. A supervising unit should set
  `SuccessExitStatus=0 143`, and operators should prefer `omp-conductor stop` /
  `systemctl stop` over raw `kill`, so `Restart=on-failure` cannot misread a
  deliberate stop as a crash.
- **A failed orchestrator degrades quietly.** The daemon logs a warning and keeps
  running, but tier-1 escalations then land in issue comments — which is exactly the
  "nobody reads it until morning" path the orchestrator exists to avoid. The warning
  is in `daemon.log`; nothing pages you about it.
- **Workers are not terminal panes, so you cannot watch them there.** Each
  worker is an in-process omp session started by `createSession`. The resident
  daemon tracks workers in a background pool so the five-minute loop keeps
  settling PRs and checking capacity; shutdown waits for that pool. Herdr still
  shows exactly one pane (the orchestrator's) regardless of concurrency.

  The cap does work. The admission loop (`admitCandidates` in `src/daemon.ts`) computes
  `slots = maxConcurrentWorkers - live workers`, admits at most that many issues
  per tick, and dispatches them together. To see them, read `omp-conductor
  status`, which lists every occupied issue, or follow `daemon.log`.
- **Workers stop at green PRs.** They never merge, release or deploy. Those
  actions default to a human, but setup may grant either to the orchestrator;
  `authority` never grants them to a worker or the dispatch daemon.
- **Worker confinement is partial.** Structured `write` / `edit` / `read` /
  `grep` / `glob` calls are blocked outside the worktree by an inline harness
  extension (`confineToCwd`). `bash` is not: a shell one-liner can still leave
  the tree. Prefer a [least-privilege worker uid](#least-privilege-worker-uid-deploy);
  the [integrity tripwire](#integrity-tripwire-package-self-hash) still pages if
  the installed package itself changes under a live daemon.


## License

MIT
