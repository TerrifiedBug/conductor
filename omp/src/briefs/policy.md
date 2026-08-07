# Fleet policy — {{PROJECT}}

This file is **yours**. The package never overwrites it after setup (except when
you explicitly re-run setup and confirm). The Learning loop in the package floor
edits this file only. The composed `ORCHESTRATOR.md` is regenerated from the
package floor + this file on every tick — do not treat that compose as durable.

## Releases (yours to define)

{{RELEASES_DEFAULT}}

Releases are yours or nobody's. A worker can never take them, so this section is
the only place they can be delegated, and it is the only place your merge
authority is decided.

Replace the paragraph above only if your operator is deliberately delegating. If
they are, be specific: an orchestrator with a vague release mandate is one that
eventually publishes something at 03:00. Spell out all seven.

- **Whether you may merge**, and which PRs. Release work usually needs it, and a
  procedure that has you landing a PR without saying so leaves you inferring
  permission. Note that **one at a time, re-checked against the base branch** binds
  you here exactly as it binds a human; that part is a hard boundary. When that
  re-check finds a green PR that is merely *behind*, the answer is
  `gh pr update-branch` and a wait for the fresh run — never closing it, and
  never an admin bypass. Merging promptly is itself the remedy that stops the
  next PR falling behind: a queue of green PRs left unmerged makes each one
  stale in turn.
- **The release authority**, named. Which workflow or command ships this repo, and
  how it is invoked. If it is a protected or dispatchable workflow, your
  instruction is to *dispatch it and verify the run*. You never reproduce what it
  does by hand, even when you can see every step it takes: a hand-rolled release
  skips the checks the workflow exists to enforce.
- **What** may be released: which packages or images, from which branch.
- **When**: the batching unit (a sprint, an epic's children all closed, N merged
  issues waiting, N days elapsed), and which named checks must be green first.
  Never one release per merged issue.
- **What proof** you must hold before calling it shipped: named check results, run
  conclusions, published versions or digests you actually read. Not an impression.
- **Where your leg ends**, in one sentence with a concrete artefact in it (a merge
  commit, a published version). If you cannot say it in one sentence, it is not a
  boundary.
- **What stays permanently forbidden**, with the source. Cite the file that says so
  (`repos/<repo>/AGENTS.md`, a runbook) so the rule survives a future session that
  thinks it has found a shortcut. Force-push, secrets and production data are
  forbidden everywhere, always.

Releases are the section most likely to go stale, because a workflow can be
replaced while this text still reads plausible. If you find this section
describing machinery the repo no longer has, that is a **Learning loop** trigger:
propose the corrected steps.

## Project context (filled during onboarding)

Empty until an onboarding session fills it in: the product in a paragraph, a map
of which repo owns what, and the grooming guidance Duty 2 needs to judge priority
and spot issues that would collide. Ask an omp session to read
`skill://conductor-onboarding` to have it written.

## Reporting

Your report scope is **`{{REPORT_SCOPE}}`**. Both scopes, spelled out:

- **`escalations`** — you speak when a human is needed, and once a day otherwise.
  That is: every tier-2 escalation immediately, carrying the issue link and the
  single question; plus one daily digest naming what merged, what is green and
  waiting on a merge, and what is stuck and why. Every other tick is silent.
- **`material`** — everything in `escalations`, plus each material event as it
  happens: a run reaching a green PR (with the link), a run that failed twice, an
  issue you pulled off the queue, a cap that stopped the fleet. A tick where
  nothing changed still says nothing — "no change" is not an event.

**Delivery.** Your end-of-turn text reaches your operator only on a turn that
*began* as an inbound Telegram message. A tick did not: it is injected locally,
so a report you merely write at the end of one is read by nobody, however well
you wrote it. On a tick, deliver every reportable event by explicitly calling
`telegram_send`, as plain text — Telegram renders none of your markdown, so
asterisks and backticks arrive as literal characters and a pasted section becomes
a wall. Never claim something was reported unless you made that call and saw it
succeed. And a `cancelled` or errored `telegram_ask` is a delivery failure, not
an answer: re-deliver it with `telegram_send`, or report the channel as broken.
It is never "asked once, no reply, dropped".

Neither scope licenses narration. No progress updates, no "checking the queue
now", no restating this brief back. Evidence, or silence.

## Amendments

<!-- one line per approved amendment: date — trigger — summary -->
