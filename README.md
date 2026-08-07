# conductor

Two native plugins that keep a 24/7 omp fleet session working, hosted in a Herdr
pane. They are independent installs on two different hosts' surfaces, and they do
not import each other: one lives inside the session, the other outside it.

| Directory | Package / id | Host | What it owns |
| --- | --- | --- | --- |
| [`omp/`](omp) | `omp-conductor` | omp | The dispatch loop: ready issues → worktrees → green PRs, caps, escalation tiers, and the orchestrator session's own heartbeat (`/conductor`, `omp-conductor`). |
| [`herdr/`](herdr) | `herdr-conductor` | Herdr | Bringing that session *back*: after a Herdr restart or a pane exit it resumes the exact omp session in its pane, or pages a human. |

The split follows the failure it handles. A session that is running but idle needs
a nudge from inside; that is the omp plugin's heartbeat. A session that is not
running at all cannot nudge itself; only the terminal multiplexer hosting it can,
and that is the Herdr plugin.

## Install

From a checkout, one script does both halves:

```bash
./setup.sh preflight   # check the machine, change nothing
./setup.sh             # preflight, then link or install both plugins
```

It checks every prerequisite before installing anything and prints the fix beside
each failure. Re-running it is the refresh path.

Or install each half by hand. They are useful separately, and share no runtime,
config file, or state directory:

```bash
# inside omp — from npm
omp plugin install omp-conductor

# in Herdr — from GitHub
herdr plugin install TerrifiedBug/conductor/herdr
```

`herdr plugin install` takes **GitHub shorthand only** (`owner/repo/subdir`).
Herdr plugins v1 has no npm install path: `herdr plugin install herdr-conductor`
is not a thing, and there is no `plugin update`. Reinstalling from GitHub is how
you refresh the managed checkout.

### Prerequisites

- **omp** and **bun**. Both plugins run inside the harness.
- **git** and an authenticated **gh** (`gh auth login`, scopes `repo` and
  `project`). Every run cuts a worktree and reads the tracker through `gh`.
- **[omp-telegram](https://www.npmjs.com/package/omp-telegram)**, installed and
  paired. It stays a separate package; conductor borrows its bot token from
  `~/.omp/agent/telegram/.env` to page you, and the fleet heartbeat reads its
  `access.json` to confirm a human is still reachable before it lets unattended
  dispatch continue.

  Tier-2 paging works with the borrowed token alone. The interactive channel —
  answering an escalation from your phone, approving a brief amendment — is what
  needs the paired `access.json`.
- **herdr**, for the half that resumes the fleet pane. Without it `setup.sh`
  installs the omp half and says so.

Per-half configuration and limitations live in each half's own README:
[`omp/README.md`](omp/README.md), [`herdr/README.md`](herdr/README.md).

## The fleet host

Both halves are pointed at the same 24/7 session — on your always-on host, an omp
session with `/root/fleet` as its cwd, `ORCHESTRATOR.md` as its standing brief
(symlinked as `AGENTS.md`), and `state/armed` as the marker that decides whether a
heartbeat does anything. Pause only stops the dispatch loop from claiming new work;
an armed heartbeat still fires. Soft-stop both brains with `omp-conductor hold`
(pause + disarm). Harder stops are `halt` / `halt --pane` — see
[`omp/README.md`](omp/README.md#stop-the-conductor-hold--halt).

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
