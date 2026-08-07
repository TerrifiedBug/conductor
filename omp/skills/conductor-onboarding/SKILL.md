---
name: conductor-onboarding
description: Interview-driven onboarding for omp-conductor. Use when the user wants to set up conductor, onboard a new fleet or project, configure the fleet, asks for conductor setup help, asks what belongs in ORCHESTRATOR.md, or wants an agent's release and merge authority scoped and written down. Interviews the operator on release policy, escalation taste and reporting scope, reads each routing repo's CI to propose the real pre-push gates, learns the product and roadmap the fleet will groom, scaffolds the release procedure from the repo's own release workflows rather than from the operator's memory, tailors ORCHESTRATOR.md from the shipped template, verifies the worker brief's assumptions against the actual repos, finishes through the deterministic /conductor setup wizard, then builds the code-graph indexes workers query instead of grepping.
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

This is the decision the shipped brief exists to protect, so give it room.

First, settle who is even a candidate, because operators assume it is the workers
and it never is. A worker is scoped to one issue: it cannot judge whether a release
is worth cutting, and it stops at a green PR permanently. **The only two candidates
are the orchestrator and a human.** The orchestrator is the right agent for it if
any agent is: it is long-lived, it can see everything that merged since the last
release, and batching is exactly the judgement a per-issue session cannot make.

So frame it as **three** options, in this order, and name the default. Each one
maps to an `authority` answer the wizard asks for directly — the interview
decides *which answer to give*, and `/conductor setup` is what records it. Never
write authority into the brief by hand: the config is what words the brief, and
a hand-edit is a second source that outlives the operator's memory of making it.

1. **Humans release.** *(default, and what the package ships)* Work ends at a
   green PR. Merging is a separate human action; releasing is a separate human
   action after that. Neither a worker nor the orchestrator ever tags, pins,
   publishes, or deploys. "This needs releasing" becomes something the
   orchestrator *reports*. → `authority: merge=human, release=human`; answer
   **no** to both wizard confirms.
2. **The orchestrator releases up to a named boundary.** Delegating part of the
   release to the supervising session, with the stopping line written down.
   → usually `merge=orchestrator, release=orchestrator`, with the boundary in
   the procedure rather than in the grant; `merge=orchestrator, release=human`
   when the line falls before the tag.
3. **The orchestrator releases fully.** → `merge=orchestrator,
   release=orchestrator`.

Then ask the question that makes option 2 real:

> **"Where does the orchestrator's leg END?"**

Not "can it release" — *where does its leg stop*. A boundary you cannot state in
one sentence is not a boundary, and an orchestrator with a vague release mandate
is one that eventually publishes something at 03:00.

Give them a worked answer so they can calibrate. One real deployment's answer:
**the agent's leg ends at the merged version pin.** It may open and land the PR that
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

**Then stop, and do not write the section yet.** What you have is the operator's
*intent*: how much they want to delegate, and where they want the line. The
*steps* on their side of that line come from the repo's own release machinery, not
from this conversation. Step 4 reads that machinery and turns the intent into a
procedure. Writing release steps from an interview answer is how a brief ends up
prescribing a hand-rolled release the repo's own policy forbids.

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

## Step 3 — learn the product

The duties assume an orchestrator that understands what it is grooming. Duty 2
asks it to judge whether acceptance criteria are readable and whether an issue is
worth claiming at all; neither is answerable by a session that knows only the repo
names. So learn the product now, and write what you learn into the brief.

Read, per routing repo:

- the `README` — what the thing is for, and who uses it;
- whatever top-level architecture doc exists (`docs/`, `ARCHITECTURE.md`, an ADR
  directory), enough to say which repo owns which concern;
- `AGENTS.md` / `CONTRIBUTING.md` for the repo's own rules, which outrank the
  brief.

Then read the tracker as a roadmap rather than as a queue:

```bash
gh issue list --repo <tracker> --state open --limit 100 --json number,title,labels,milestone
gh api repos/<tracker>/milestones --jq '.[] | "\(.title) — \(.open_issues) open"'
gh label list --repo <tracker>
```

Milestones and the label taxonomy are what separate a theme from a one-off. Epics
usually surface as one or the other.

Then ask the operator exactly one question, because it is the one thing none of
that reading answers:

> **"Where does the roadmap live, and what is the current priority?"**

*Why:* a tracker shows what is open, never what matters. An orchestrator that
cannot rank work grooms by recency, and that is how a stale issue outranks the
thing the operator is actually shipping this month.

**Write the findings into the brief** as a `## Project context` section, in the
editable half beside Releases — the template ships a stub for it. Keep it under 40
lines: it is read on every tick, and a brief nobody finishes reading is a brief
that gets skimmed. It needs four things.

1. **The product in one paragraph.** What it does, for whom. Not a feature list.
2. **A repo map** — one line per routing key, naming what that repo owns in the
   operator's vocabulary. This is what turns a routing label into a judgement.
3. **Grooming guidance for Duty 2.** Which repos ship together, so a change in one
   is known to need a matching PR in the other. And which kinds of issue touch the
   same files: those must not be queued concurrently, because two workers editing
   one file produce two PRs that cannot both merge.
4. **Where the roadmap lives, and how to judge priority against it** — the pointer
   the operator just gave you, in one line.

Same order of operations as Step 5: draft it now, and apply it to the brief after
the wizard has written the file.

---

## Step 4 — scaffold the release process from the repo, not from memory

The interview gave you a boundary. This step turns it into steps the operator's
repos will actually accept, for the same reason Step 2 reads CI instead of asking
about gates: an operator describes the release they *remember*, and a release is
the one procedure where being approximately right is worst.

Skip this step only for option 1 (humans release). There is nothing to scaffold:
the rendered paragraph already says humans hold both, and there is no procedure
under it to write.

### Find the release authority

Per repo that can be released, read:

```bash
gh api repos/<owner>/<repo>/contents/.github/workflows --jq '.[].name'
gh release list --repo <owner>/<repo> --limit 10
git tag --list --sort=-v:refname | head
```

and then, in the checkout:

- **every workflow that publishes anything** — a release, a tag, an image, a
  package, a deployment. For each, the **trigger** is the fact that matters:
  - `workflow_dispatch` → the release is *dispatched*. That workflow is the
    authority, and the correct instruction is "dispatch it with the planned
    version", never "do what it does".
  - `on: push: tags:` → a pushed tag is the trigger, so tagging *is* releasing.
  - `on: release: published` → the GitHub Release is the trigger.
- **what the workflow enforces.** Many reject a tag unless several version files
  agree. That constraint belongs in the brief, quoted, because it is the failure
  the agent will otherwise hit at 03:00.
- **`AGENTS.md`, `CONTRIBUTING.md`, and any release runbook.** An explicit policy
  outranks anything you infer from a workflow, and it is usually where the
  *forbidden* paths are named.
- **whether a release needs a human by construction.** An `npm publish` behind
  interactive 2FA cannot be delegated to an unattended session at all, whatever the
  operator would like. Say so rather than writing a step that cannot run.

### Then write three things, and one of them is the forbidden list

Present this back as a proposal, in the repo's own commands, before it goes in the
brief:

1. **The authority, named.** One sentence: which workflow or command ships this
   repo, and how it is invoked. If it is a protected workflow, the brief says
   *dispatch it and verify the run* and stops there.
2. **The steps on the agent's side of the boundary**, as commands, in order, each
   with the check that proves it worked. A step whose success cannot be read from
   a named check is not a step the agent can own.
3. **What is forbidden, and why, with the citation.** This is the part that decays
   silently, so it is the part to write down hardest. Cite the file and the line:
   `never mutate the deployment directly or reimplement the release by hand
   (repos/<repo>/AGENTS.md)`. A forbidden path with a source attached survives a
   future session's improvisation; "be careful with releases" does not.

### Ask two things the repo cannot tell you

- **"What is a release worth cutting?"** The batching unit, in the repo's own
  vocabulary: a sprint, an epic's children all closed, N merged issues waiting, N
  days elapsed, or urgency. Without this the orchestrator either releases per merge
  (a stream of meaningless versions burning shared runners) or never releases at
  all.
- **"Who owns the rollback?"** If the answer is a person, that person owns the
  release, and the boundary belongs before the irreversible step regardless of
  what option 2 sounded like in the interview.

### And make it self-correcting

A release process is the section most likely to go stale: workflows get replaced,
and a brief describing the old one still reads plausible. So tell the operator
plainly, and make sure the brief's own **Learning loop** covers it: when the
release workflow changes, the brief contradicts repo reality, which is exactly an
amendment trigger. The session proposes the corrected steps and they approve with
a yes.

---

## Step 5 — tailor the brief, and show the diff first

`src/briefs/orchestrator.md` in this package is the **floor**, not the deliverable.
It ships deliberately conservative so that an operator who never edits it still
has a safe fleet. Your job is to raise it to *this* fleet.

The file has a hard line in it — an HTML comment banner reading
`YOURS TO EDIT`. Respect it in both directions:

**Above the banner — leave it alone.** The three duties — drain (unstick what is
stuck), groom (keep the queue worth draining), report — the
escalation-tier table, and the hard boundaries describe how the package already
behaves. Rewriting them makes the brief disagree with the code, and the code wins.
The evidence rule in particular is not negotiable: *every claim cites evidence — a
PR URL, an issue number, or a named check actually read.* "Should be fine",
"looks green" and "probably passing" are not evidence.

Know what is *not* up there, though, because operators expect it to be: the
orchestrator's own merge and release authority is **not** a hard boundary. It is
config — the two `authority` answers — and it defaults to none. What is fixed
above the banner is that a *worker* never merges or releases, and that PRs land
one at a time with a freshness re-check. Delegating a release to the
orchestrator does not touch either of those, so it needs no negotiation with the
shipped half.

**Below the banner — rewrite from the interview.**

- **Releases.** The section's opening paragraph is rendered from the `authority`
  answers, and Duty 1's "the PR is green" branch is rendered from the same
  place. Leave both alone: they are the config speaking, and re-running
  `/conductor setup` is how they change. What you write is everything under that
  paragraph — the procedure you scaffolded in Step 4. If humans-release, there is
  nothing to scaffold and you stop. If they chose a boundary, write the boundary
  as a sentence with an end — *"your leg ends at the merged pin PR; you never
  deploy it"* — then the scaffolded steps, then the forbidden list with its
  citations. Do not restate the merge grant in your own words: a second spelling
  of it is exactly the disagreement the rendered paragraph exists to prevent.
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
sections now, let the wizard write the rendered floor in Step 7, and apply the
agreed edits to that file immediately afterwards. Do not pre-write the file to a
path you guessed, and do not skip the wizard's brief-writing step — you would
lose the substituted coordinates and the overwrite confirmation.

---

## Step 6 — check the worker brief's assumptions against reality

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

## Step 7 — finish through the wizard

Now hand the collected answers to the deterministic path:

```text
/conductor setup
```

You have the answers ready, so this is fast — and it stays the wizard's decision
to write, not yours. It asks, in this order: project name; tracker repo; queue
label; whether to rename the state labels; routing label prefix; then per repo the
routing key, clone URL, default branch and **pre-push gates** (your Step 2
proposal, in `cmd @ cwd` form); whether to add another repo; whether to set up
**code-graph discovery** and the root its clones live under (Step 8); caps; the
authority confirms; the worker model; the Telegram chat id for tier 2; the
escalation fallback; whether an orchestrator session already runs elsewhere; the
report scope; and finally whether to write `ORCHESTRATOR.md`.

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

Say yes to writing `ORCHESTRATOR.md`, then **immediately apply the edits you
drafted in Steps 3, 4 and 5** to the file it wrote, and tell them the path. Note
the trap for later: a future `/conductor setup` re-run offers to overwrite that
file, and accepting loses every tailored word. Their brief is now a file worth
keeping a copy of.

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

## Step 8 — build the code graph, if they said yes to it

Only if the wizard's code-graph question was answered yes. It is optional, and a
fleet without it works exactly as it did before — but it is the cheapest single
improvement to how far a worker gets, so lead with the number: **workers spend
most of a run finding code, not changing it.** Measured on the reference fleet, a
run typically spends 30–62 `read` and 32–69 `bash` calls against 9–24 edits, and
the runs that hit the turns cap hit it with the work unfinished. A graph answers
"who calls this" in one call instead of twenty greps.

Say the thing operators get wrong before you run anything: **the indexed
directories are conductor's, not theirs.** Three candidates and only one works.

- A worker's **worktree** cannot be indexed usefully — an index is keyed by the
  realpath it was built from, so a throwaway `worktrees/<issue>` path is always an
  empty project. That is why the brief hands the worker an absolute path instead.
- Their **own checkout** must not be indexed. Refreshing means resetting to the
  default branch, which in a directory they work in either destroys uncommitted
  work or indexes the feature branch they left checked out.
- Conductor's **mirrors** are bare. No working tree, nothing to index.

So each `graphProject` is a fourth thing: a disposable clone that exists only to
be indexed, pinned to the repo's default branch, never edited by a human. Say that
out loud, because an operator who points it at `~/projects/<repo>` to "save disk"
has armed something that will one day `git reset --hard` over their work.

Two host prerequisites come before any of that, and neither is conductor's to
install. `graph-setup` reports both as step 0, so run it first and read that
block before running anything else.

- **The indexer must be on PATH.** `codebase-memory-mcp` is a separate project
  ([source](https://github.com/DeusData/codebase-memory-mcp)); the package never
  installs, spawns or depends on it. A host without it gets command-not-found
  partway down the plan.
- **It must be mounted as an MCP server for sessions**, in `~/.omp/agent/mcp.json`
  on the account the daemon runs as. This is the one that bites, because it fails
  *silently*: indexing succeeds, the databases are real and correct, and worker
  sessions have no graph tools at all — so every worker quietly greps and the
  whole thing looks like it simply did not help. `graph-setup` prints the exact
  entry to paste, pointed at the binary it found.

Check the mount on the daemon's account, not yours — a per-user config that is
present for the operator and absent for the service account looks fine from the
shell they are typing in.

Then, on the host that runs the daemon:

```bash
omp-conductor graph-setup                 # read-only: prints the whole plan
```

Walk them through what it printed rather than pasting it silently. It has three
parts, and each one is a decision they can still refuse: a `git clone` per missing
clone, an index command per repo (minutes each — run them now, or the first worker
queries an empty graph), and a `cbm-reindex.service` + `cbm-reindex.timer` pair
derived from their own repos and branches. Then:

```bash
sudo omp-conductor graph-setup --write    # writes the script and the two units
```

`--write` needs root because system units live in `/etc/systemd/system`, and it
deliberately stops there: it prints the `systemctl daemon-reload && systemctl
enable --now cbm-reindex.timer` for them to run and never runs `systemctl` itself.
Have them start the service once by hand (`systemctl start cbm-reindex.service`)
and read the result — a first real run is where a wrong branch or a missing clone
shows up, and the unit is written to fail loudly rather than index a stale tree.

Two things to leave them with:

- **A timer, not the server's own watcher.** That watcher lives inside a connected
  MCP session and dies with it, so nothing a worker mounts keeps anything fresh.
  If the timer is not enabled, the graph decays and no one is told.
- **The graph is a snapshot, and the brief says so.** Workers are told to orient
  with it and then read the real file before editing, because the index is the
  default branch at the last reindex — not their branch, and not their edits.

Verify before moving on: `codebase-memory-mcp cli list_projects` must show one
entry per repo whose `root_path` is exactly the configured `graphProject`. That
match is the whole contract — the worker brief tells the session to find its
project by that path, so a mismatch means a silent fallback to grep.

---

## Step 9 — hand over the learning loop

Finish by telling the operator the truth about what they just wrote:

**A brief converges from operation, not from an interview.** What you produced
today is a good first draft, and it is wrong in ways neither of you can see yet.
Real deployments diverge from the template exactly where the operator learns
something: a reporting scope that turned out too loud, a release boundary drawn in
the wrong place, an escalation that should have been a digest line, a hard
boundary nobody thought to name until an agent walked into it.

The brief closes that gap itself now. Point them at its **Learning loop** section
and say what it means in practice:

- **Their corrections are the trigger.** When they tell the orchestrator to work
  differently — mid-flight, in a reply to an escalation, anywhere — it drafts the
  matching edit to its own brief instead of just complying once.
- **Approval is a Telegram yes/no.** The proposal arrives as one question carrying
  the exact diff: the current lines, then the replacement. Yes applies it. No, or
  no answer at all, drops it, and it does not raise that amendment again.
- **Two things it will never do:** propose relaxing **Hard boundaries** (that
  section changes only when they hand-edit it), or interrupt a tick's duties to
  ask.
- **Every applied amendment is logged** as one line under **Amendments** at the
  bottom of the brief — date, trigger, summary. That list is the honest record of
  where this interview was wrong, and it accumulates without anyone scheduling it.

That is the whole handover. Convergence is now the loop's job rather than a habit
the operator has to keep.
