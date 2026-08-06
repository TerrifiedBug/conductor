---
name: conductor-onboarding
description: Interview-driven onboarding for omp-conductor. Use when the user wants to set up conductor, onboard a new fleet or project, configure the fleet, asks for conductor setup help, or asks what belongs in ORCHESTRATOR.md. Interviews the operator on release policy, escalation taste and reporting scope, reads each routing repo's CI to propose the real pre-push gates, tailors ORCHESTRATOR.md from the shipped template, verifies the worker brief's assumptions against the actual repos, then finishes through the deterministic /conductor setup wizard.
---

# Onboarding a conductor fleet

Onboarding has two layers, and they are not the same job.

- **`/conductor setup` is the mechanical layer.** It is deterministic, tested, and
  the **only** thing that writes `config.json`. It asks closed questions, plans
  labels, prints a dry run, and mutates nothing until the operator confirms.
- **You are the judgement layer.** The wizard cannot ask "where should this fleet
  stop?" and get a useful answer from a text prompt, and it cannot read a repo to
  find out what CI actually runs. That is the part that decides whether an
  unattended fleet is safe, and it is yours.

So: **you interview and investigate; the wizard writes.** Never hand-edit
`config.json`, never construct it and ask for a blessing, never skip the wizard's
dry run. Its consent gate is the safety property; going around it removes the one
step where the operator sees what is about to change.

Two more ground rules before you start.

**Do not recite this file.** Nothing here is a script to read aloud. Every
question below exists to extract one decision; ask it in your own words, in the
operator's vocabulary, and skip the ones the repo already answers. An interview
where you ask and they answer is worth more than a checklist you both step
through.

**Investigate before you ask.** Anything discoverable — default branches, CI
jobs, gate commands, whether a repo has a `Makefile` — you read, then propose.
Asking an operator to recite their own CI config is how gates end up wrong: they
tell you what they *think* runs, and the fleet pushes on it at 03:00.

---

## Step 0 — orient

Before the first question, find out where you are:

```bash
gh auth status                       # repo + project scopes, and who the token is
cat ~/.omp/conductor/config.json     # honours $OMP_CONDUCTOR_HOME
```

- **Config already there?** This is a re-run or a second project. The wizard
  pre-fills from the existing project and replaces it in place, keeping its
  neighbours — so the interview is now about *what changed*, not everything.
  Read the existing project out loud and ask what is wrong with it.
- **`gh` missing `repo` or `project`?** Say so now. The wizard warns at the
  confirm, but a token that cannot label issues means every claim fails, and it
  is cheaper to fix before the interview than after.
- **An `ORCHESTRATOR.md` already exists** at `<workspaceRoot>/ORCHESTRATOR.md`
  (default `~/.omp/conductor/worktrees/ORCHESTRATOR.md`)? Read it. It is the
  operator's accumulated policy, and it outranks the shipped template. Your job
  becomes amending it, and you must warn that a wizard re-run offers to overwrite
  it.

---

## Step 1 — the interview

Ask for decisions, not for values you could look up. Each question below carries
the reason it matters; when you ask it, lead with that reason. An operator who
understands why a question is being asked gives a usable answer.

### Project and tracker

**"What is this fleet called, and which one repo holds the queue?"**

*Why:* the project name is the handle for everything afterwards
(`/conductor status <name>`, `--project <name>`), and the tracker is the **one**
`owner/repo` whose open-issue list *is* the queue. Nothing else is ever read.

Say the part that surprises people: **the tracker repo does not have to contain
any code.** A planning repo whose only content is issues is the normal shape, and
it is often the better one — the queue then has its own label namespace and its
own permissions, separate from the code it dispatches into.

Then: **"What label means a human has signed this off?"** Default
`ready-for-agent`. *Why:* this label is the entire consent mechanism for
unattended work. The conductor never adds it. Everything the fleet ever does
starts with a human putting that label on an issue, so it should read like a
decision, not like a status.

The three state labels (`agent:in-progress`, `agent:blocked`, `agent:failed`) are
written *by* the conductor so the tracker alone shows live state. Only ask about
renaming them if the repo already has a colliding label convention — the
namespaced defaults are right almost always, and the wizard asks with one confirm.

### Routing — what lands where

**"Which code repos does this queue dispatch into, and how would you tell them
apart on an issue?"**

*Why:* an issue must carry **exactly one** `repo:<name>` label naming a repo in
`routing.repos`. Zero or two is reported unroutable and skipped — never guessed.
Routing is the fan-out: one tracker, any number of code repos.

For each repo you need the clone URL and the default branch, but **look those up**
rather than asking (Step 2). What you actually need from the operator is the
routing *key* — the word that goes after the prefix — and it should be the word
they already use in conversation about that repo, because they are the one who
will be typing it onto issues at 2am.

Prefer an SSH clone URL, or an https URL backed by a credential helper. A URL
with a credential in it gets persisted into the mirror's git config exactly as it
would for a hand-run clone; say that out loud if you see one.

### Release policy — the question that actually matters

This is the decision the shipped brief exists to protect, so give it room. Frame
it as **three** options, in this order, and name the default:

1. **Humans release.** *(default, and what the package ships)* Work ends at a
   green PR. Merging is a separate human action; releasing is a separate human
   action after that. Neither a worker nor the orchestrator ever tags, pins,
   publishes, or deploys. "This needs releasing" becomes something the
   orchestrator *reports*.
2. **The agent releases up to a named boundary.** Delegating part of the release,
   with the stopping line written down.
3. **The agent releases fully.**

Then ask the question that makes option 2 real:

> **"Where does the agent's leg END?"**

Not "can it release" — *where does its leg stop*. A boundary you cannot state in
one sentence is not a boundary, and an orchestrator with a vague release mandate
is one that eventually publishes something at 03:00.

Give them a worked answer so they can calibrate. The Veltro deployment's answer:
**the agent's leg ends at the merged suite pin.** It may open and land the PR that
bumps the module image tags, because that artefact is reviewable, reversible by a
revert, and its correctness is checkable by a named CI check. Deploying that pin
to prod is **operator territory** — it needs a person who can watch it, and who
owns the rollback. That is a leg with an end: a merge commit.

If they choose option 2, capture all five of these, because the brief needs them
and a missing one is a hole:

- **what** may be released — which packages or images, from which branch;
- **when** — batched how, after which *named* checks are green;
- **what proof** must be held first — check results actually read, not an
  impression;
- **what must still be asked, every time**;
- **what stays permanently forbidden** — force-push, secrets, production data.

If they choose option 3, do not just write it down. Warn, concretely:

- **Credentials.** Full release means the session holds publish tokens, registry
  credentials, or deploy keys. Those live in the session's environment, exposed to
  every turn, including a turn that went wrong. Ask whether they are willing to
  put that credential in a process that runs unattended for weeks.
- **Rollback ownership.** An agent that can release owns the 03:00 rollback too,
  and a rollback is a judgement call under time pressure with partial
  information — the exact thing agents are worst at. If the answer to "who rolls
  this back" is a person, then that person is already the release owner, and
  option 2 with a named boundary is the honest configuration.

Push back once if the answer is option 3 and the reasoning is "it'll be fine".
Then record what they decide. It is their fleet.

### Escalation taste

**"What should wake you up, and what can wait for the digest?"**

*Why:* there are two tiers, and the split is not adjustable — tier 1 is a worker
that stopped and asked a question (the orchestrator answers it), tier 2 is
"nobody can proceed without a human". What *is* adjustable is how tier 2 reaches
them and how much else comes along with it. An operator who gets paged for
everything stops reading the pages, which is functionally the same as having no
escalation channel at all.

Concretely, decide:

- **Channel.** If `omp-telegram` is installed and paired, the wizard offers that
  chat. If not, tier 2 degrades to an issue comment — a documented fallback, not
  an error, but say plainly that a comment on an issue nobody is watching is a
  page that lands nowhere.
- **Belt and braces.** Also comment on the issue when a run escalates?
  Recommended yes: a chat message you miss is a run nobody sees, and the comment
  is the durable copy.
- **Attempts before escalating** (`maxAttemptsPerIssue`, default 3). *Why:* an
  issue that failed three times is not a retry candidate — it is a diagnosis
  task. Setting this high converts a bad issue into a spend line.

### Reporting scope

**"Do you want to hear about progress, or only about problems?"**

*Why:* this is the one half of the brief that the *config* also knows about,
because every orchestrator tick appends the matching constraint line to its
prompt, re-read from the config each tick. It maps onto exactly two values:

| Answer | `reporting.scope` | What that means |
| --- | --- | --- |
| "Tell me when things happen." | `material` *(default)* | Escalations, plus every material event as it happens: a run reaching a green PR (with link), a run that failed twice, an issue pulled off the queue, a cap that stopped the fleet. |
| "Only bother me when I'm needed." | `escalations` | Every tier-2 escalation immediately, plus one daily digest. Every other tick silent. |

Two honesty notes to pass on:

- **Neither scope is an outbound filter.** Nothing inspects the orchestrator's
  messages and drops the ones the scope did not ask for. It is a constraint handed
  to the model each turn, not a gate it is held to.
- **Changing the scope later does not rewrite an existing `ORCHESTRATOR.md`.** The
  tick line changes; the brief does not. Whoever changes it must edit the brief's
  Reporting section too, or the session is carrying two versions of the policy.

---

## Step 2 — read the repos, then propose the gates

**Do this before you ask anything about gates.** The wizard's gate prompt is a
free-text field; whatever goes in it is what an unattended worker runs before
every push. It has to match what CI actually runs, and the operator is not the
best source for that. Their CI config is.

For each routing repo, mirror it read-only if you do not have it locally, then
read:

```bash
gh api repos/<owner>/<repo> --jq '.default_branch'
gh api repos/<owner>/<repo>/contents/.github/workflows --jq '.[].name'
```

and then, in the checkout:

- `.github/workflows/*.yml` — the PR-triggered jobs and their exact `run:` lines,
  including their `working-directory`;
- `package.json` — the `scripts` block (`lint`, `check`, `typecheck`, `test`);
- `Makefile` / `justfile` / `Taskfile.yml` — many repos put the real gate here and
  have CI call `make check`;
- `pyproject.toml`, `Cargo.toml`, `go.mod` — for the same reason, in other
  ecosystems;
- any `CONTRIBUTING.md` / `AGENTS.md` line that names the pre-push command.

Then **propose**, do not ask. Show your reading and the exact commands, with the
`cwd` each runs from, in the format the wizard takes (`cmd`, or `cmd @ cwd`,
comma-separated; `cwd` defaults to `.`):

```text
repo:api — from .github/workflows/ci.yml (on: pull_request), jobs lint + test:
  bun run lint      @ .        # CI: `bun run lint` at repo root, whole tree
  bun run check     @ .        # CI: tsc --noEmit
  bun test          @ .        # CI: bun test

Is that the set, and is anything missing that CI would catch?
```

Three warnings to carry, every time:

1. **Whole tree, not the subdirectory.** CI lints everything. A gate that lints
   only `src/` is how an error in a migration, a config file, a script or a test
   fixture reaches the runners. If CI runs `bun run lint` at the root, the gate is
   `bun run lint` at the root — not `bun run lint src`.
2. **Cheap gates only.** Do not put docker builds, image builds, production
   builds, browser/e2e suites, or a full integration suite in here. The host is
   shared; CI owns the heavy gates. If a repo's only meaningful check is heavy,
   say so — that repo's workers will lean on CI, and that is a known cost, not
   something to paper over with a fake gate.
3. **No gates at all is a real answer, and a loud one.** The wizard warns. Repeat
   the warning in plain terms: a repo with no gates means every unattended push
   is an experiment run on the shared runners.

---

## Step 3 — tailor the brief, and show the diff first

`src/briefs/orchestrator.md` in this package is the **floor**, not the deliverable.
It ships deliberately conservative so that an operator who never edits it still
has a safe fleet. Your job is to raise it to *this* fleet.

The file has a hard line in it — an HTML comment banner reading
`YOURS TO EDIT`. Respect it in both directions:

**Above the banner — leave it alone.** Duties (drain, groom, report), the
escalation-tier table, and the hard boundaries describe how the package already
behaves. Rewriting them makes the brief disagree with the code, and the code wins.
The evidence rule in particular is not negotiable: *every claim cites evidence — a
PR URL, an issue number, or a named check actually read.* "Should be fine",
"looks green" and "probably passing" are not evidence.

**Below the banner — rewrite from the interview.**

- **Releases.** Replace the section with the decision from Step 1. If they chose
  humans-release, say so in one short paragraph and stop; do not leave the "replace
  this paragraph if you are delegating" instructions in a finished brief, because
  a standing prompt full of alternatives it did not choose is a standing prompt
  the session has to guess its way through. If they chose a boundary, write the
  boundary as a sentence with an end — *"your leg ends at the merged pin PR; you
  never deploy it"* — followed by the five captured specifics as a list.
- **Reporting.** Rewrite it as the one scope they chose, in the second person,
  concretely. Delete the description of the scope they did not choose: it is
  useful in a template and noise in a live prompt. Keep the closing constraint
  verbatim in substance — no narration, no progress updates, no restating the
  brief back. Evidence, or silence.

**Then add what the template cannot know: this fleet's own hard boundaries.** Ask
for them directly:

> **"Is there anywhere in these repos an agent must never go, even when an issue
> says to?"**

Typical answers, worth prompting for by name: infrastructure directories
(`terraform/`, `puppet/`, `ansible/`, `charts/`, `.github/workflows/`), anything
holding secrets or environment files, migration directories, a vendored or
generated tree, and **whole repos** that are in the org but off-limits. Write each
one as a path or repo name, not as a category — "no infra changes" is advice, and
`never edit terraform/ or .github/workflows/; escalate instead` is a boundary.

**Show the diff before writing anything.** Present the tailored sections against
the shipped template — the sections you rewrote, the boundaries you added, and an
explicit statement that everything above the banner is untouched. Get an
acknowledgement. This file becomes the standing prompt for a session that runs
unattended for weeks; the operator reading it once, now, is the cheapest review it
will ever get.

**Order of operations matters here.** The wizard writes the *template* (with
coordinates substituted) at the path it owns. So: draft and agree the tailored
sections now, let the wizard write the rendered floor in Step 4, and apply the
agreed edits to that file immediately afterwards. Do not pre-write the file to a
path you guessed, and do not skip the wizard's brief-writing step — you would
lose the substituted coordinates and the overwrite confirmation.

---

## Step 4 — check the worker brief's assumptions against reality

The worker brief makes concrete claims to a session that has no other context. If
a claim is wrong, the worker cannot tell — it just fails in a confusing way. Check
each one against the actual repos, and report what you found.

1. **Default branches.** The brief says the worktree is cut from the repo's
   default branch and the PR targets it. Confirm per repo with
   `gh api repos/<owner>/<repo> --jq .default_branch`. A repo on `master`, `develop`
   or `trunk` configured as `main` produces a run that fails at worktree creation.
2. **Branch naming.** The conductor cuts `<type>/<slug>`, where type is `fix` when
   an issue label's last segment is `bug` and `feat` otherwise. Check that against
   the repo's convention and its branch protection: a ruleset that only permits
   `feature/*`, or requires a ticket prefix, will reject every push the fleet
   makes. `gh api repos/<owner>/<repo>/rulesets` and the branch-protection settings
   are the place to look.
3. **The gates actually run, and exit 0 on a clean checkout.** This is the one
   worth spending real time on. In a clean mirror or worktree, run each proposed
   gate read-only and record the exit code:
   - Safe to run: lint, typecheck, unit tests, formatter `--check` modes.
   - Do **not** run: anything that writes to the working tree (a formatter without
     `--check`), anything that hits the network beyond a package install, docker
     builds, deploys, or a suite that needs live services. If a gate cannot be
     verified safely, say which one and why, rather than asserting it works.
   - A gate that fails on a *clean* checkout is a fleet that can never push. That
     is a finding to report before arming, not after — the operator either fixes
     the repo or drops the gate, and both are their call.
4. **Does `pull_request` actually fire?** The whole loop ends with a worker
   watching `gh pr checks --watch` to a verdict. A workflow triggered only on
   `push` to a branch pattern, or gated behind `if: github.actor != ...`, or one
   that requires approval for a first-time contributor, gives a PR with **no
   checks** — and a worker that waits forever on a verdict that never comes. Read
   the `on:` block of each workflow and confirm `pull_request` is there and not
   path-filtered away from the paths this fleet will touch.

Report these as findings with evidence, not as reassurance. "I read
`.github/workflows/ci.yml`; `on: pull_request` is present with no path filter" is a
finding. "CI should trigger" is not.

---

## Step 5 — finish through the wizard

Now hand the collected answers to the deterministic path:

```text
/conductor setup
```

You have the answers ready, so this is fast — and it stays the wizard's decision
to write, not yours. It asks, in this order: project name; tracker repo; queue
label; whether to rename the state labels; routing label prefix; then per repo the
routing key, clone URL, default branch and **pre-push gates** (your Step 2
proposal, in `cmd @ cwd` form); whether to add another repo; caps; the Telegram
chat id for tier 2; the escalation fallback; the report scope; and finally whether
to write `ORCHESTRATOR.md`.

Two things about the end of it that you must not smooth over:

- **The dry run is the point.** Before the confirm, it reads the tracker through
  the same routing code the loop uses and prints exactly what the next tick would
  pick up, which repo each issue routes to, the branch it would cut, and every
  issue it cannot route. Walk the operator through that output. Unroutable issues
  here are the single most useful signal in the whole onboarding: they mean the
  labels and the routing config disagree, and it is far cheaper to see it now.
- **Nothing is mutated until they answer.** No label created, no config written,
  no state database, no arm. If they decline, the machine is untouched. Never
  answer that confirm on their behalf.

Say yes to writing `ORCHESTRATOR.md`, then **immediately apply the Step 3 edits**
to the file it wrote, and tell them the path. Note the trap for later: a future
`/conductor setup` re-run offers to overwrite that file, and accepting loses every
tailored word. Their brief is now a file worth keeping a copy of.

### Then walk arm, pause, and disarm — they are three different things

Operators conflate these, and the failure modes are not the same.

- **Arm** is what that final confirm did, and it is exactly two things: create the
  state database, and clear the pause flag. It does **not** start the daemon —
  `omp-conductor start` does, and it does not report success until the daemon
  answers `GET /healthz`. For a first run, take one tick in the foreground and
  watch it: `omp-conductor daemon --once`.
- **Pause is maintenance.** `/conductor pause` (or `omp-conductor pause`) writes a
  sentinel in the state directory. The dispatch loop checks it first, so no new
  work is claimed from the next tick; runs already in flight finish rather than
  being killed. The orchestrator heartbeat reads the *same* flag, so pausing the
  fleet also silences its heartbeat — one flag, not two. This is the switch for
  touching a repo, rotating a credential, a release window, or a holiday.
  `resume` undoes it. Nothing is torn down, nothing is forgotten.
- **Disarm is channel teardown, and it is not a subcommand.** It is removing the
  `armedFile` that `.conductor-tick.json` names — the heartbeat then sends nothing
  and the supervising session simply stops being prompted. Be precise about the
  asymmetry: **disarming stops the heartbeat, not the dispatch loop.** A disarmed
  fleet whose daemon is still up keeps claiming issues with nobody supervising, so
  "stop the fleet" is `pause` (or `omp-conductor stop`) — disarm is "stop waking
  the orchestrator".
- **And the gate that disarms itself.** If `.conductor-tick.json` names an
  `accessFile`, every tick re-reads the Telegram bridge's `access.json` and
  requires `enabled: true` with exactly **one** paired owner. It fails closed on
  everything else: missing, unreadable, not JSON, disabled, nobody paired, or
  several paired (it refuses to guess which human is on the hook). Unattended
  dispatch is only defensible while a tier-2 escalation can reach a person, so a
  channel that goes away disarms the heartbeat whether or not anyone intended it.
  **A fleet deploy always sets `accessFile`.** Leaving it unset passes the gate —
  that is for ordinary dev sessions, not an off switch.

---

## Step 6 — say the thing about iteration

Finish by telling the operator the truth about what they just wrote:

**A brief converges from operation, not from an interview.** What you produced
today is a good first draft, and it is wrong in ways neither of you can see yet.
Real deployments diverge from the template exactly where the operator learns
something: a reporting scope that turned out too loud, a release boundary drawn in
the wrong place, an escalation that should have been a digest line, a hard
boundary nobody thought to name until an agent walked into it.

So set the expectation concretely: **revisit the brief after the first week of
real ticks.** Bring three things to that review — the escalations that arrived,
the issues that came back unroutable, and any tick where the report was either
noise or a surprise. Each of those maps to one line in the brief.

That loop is currently manual, and productising it is the known next step:
[issue #8](https://github.com/TerrifiedBug/conductor/issues/8) proposes a v2 where
the daily digest itself **proposes brief amendments** from observed friction —
repeated skip reasons, recurring unroutable patterns — for the operator to approve.
Until then, the review is a calendar entry. Suggest they make one.
