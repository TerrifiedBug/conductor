# conductor

Two native plugins that keep a 24/7 omp fleet session working, hosted in a Herdr
pane. They are independent installs on two different hosts' surfaces, and they do
not import each other — one lives inside the session, the other outside it.

| Directory | Package / id | Host | What it owns |
| --- | --- | --- | --- |
| [`omp/`](omp) | `omp-conductor` | omp | The dispatch loop: ready issues → worktrees → green PRs, caps, escalation tiers, and the orchestrator session's own heartbeat (`/conductor`, `omp-conductor`). |
| [`herdr/`](herdr) | `herdr-conductor` | Herdr | Bringing that session *back*: after a Herdr restart or a pane exit it resumes the exact omp session in its pane, or pages a human. |

The split follows the failure it handles. A session that is running but idle needs
a nudge from inside — that is the omp plugin's heartbeat. A session that is not
running at all cannot nudge itself; only the terminal multiplexer hosting it can,
and that is the Herdr plugin.

## Install

Each half installs natively on its own host. They are useful separately, and there
is no shared runtime, config file, or state directory between them.

```bash
# inside omp — from npm
omp plugin install omp-conductor

# in Herdr — from GitHub
herdr plugin install TerrifiedBug/conductor/herdr
```

`herdr plugin install` takes **GitHub shorthand only** (`owner/repo/subdir`).
Herdr plugins v1 has no npm install path — `herdr plugin install herdr-conductor`
is not a thing, and there is no `plugin update`: reinstalling from GitHub is how
you refresh the managed checkout.

Per-half requirements, configuration and limitations live in each half's own
README: [`omp/README.md`](omp/README.md), [`herdr/README.md`](herdr/README.md).

## The fleet host

Both halves are pointed at the same 24/7 session — on your always-on host, an omp
session with `/root/fleet` as its cwd, `ORCHESTRATOR.md` as its standing brief
(symlinked as `AGENTS.md`), and `state/armed` as the marker that decides whether a
heartbeat does anything. `omp-conductor`'s pause flag is the same flag both the
dispatch loop and the heartbeat read, so pausing the fleet pauses everything the
conductor would otherwise start.

The Herdr half never edits that session's state. It only answers one question —
is the fleet session running in its pane? — and either resumes it by exact
session identity or says, in Telegram and in a Herdr notification, that the fleet
is down.

## Development

```bash
(cd omp && bun test)                      # omp plugin
(cd herdr && bash test/recover-test.sh)   # herdr plugin — offline, no bats
```

The Herdr half is Bash plus a manifest: no build step, and `herdr plugin link` on
the `herdr/` directory is enough to run the working tree.
