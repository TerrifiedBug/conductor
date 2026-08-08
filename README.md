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
each failure. For a running fleet, use the update skill below rather than
replacing live plugin files with this setup command.

When this checkout finds an existing npm-managed `omp-conductor`, ordinary
`./setup.sh install` keeps that immutable package and links only the Herdr half.
It prints the decision instead of silently replacing npm with a mutable checkout.
Use `./setup.sh install --force-link` only when you deliberately want the checkout
to become omp's plugin source.

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

After the first install, say “update conductor” from an external maintenance omp
session. The bundled `skill://conductor-update` pauses new claims, drains work,
pins one npm release across the Bun-global CLI, omp plugin, and Herdr plugin,
reloads the processes, verifies twice, and restores the prior pause state. It also
converts an old locally linked Herdr plugin to a managed pinned checkout. Tick
arming is preserved, so an ordinary update needs no halt or new Telegram proof.

### Release the npm package

Releases are human-gated by a version tag, not by an npm password or OTP. The
repository's `release.yml` uses npm trusted publishing (GitHub OIDC), reruns the
TypeScript gates, verifies that `vX.Y.Z` matches `omp/package.json`, and publishes
the public package with provenance.

One npm owner must configure the package once at
**npmjs.com → omp-conductor → Settings → Trusted Publisher**:

- provider: GitHub Actions
- organization or user: `TerrifiedBug`
- repository: `conductor`
- workflow filename: `release.yml`
- environment: leave blank

Do not add an `NPM_TOKEN` secret. After a version-bump PR is merged and green, a
human creates and pushes the matching tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The workflow refuses a mismatched tag before publishing. Publishing from a local
checkout remains intentionally outside the release path.

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

Both halves point at the same 24/7 omp session on your always-on host. The
session's working directory is configured as `FLEET_CWD`; it contains
`.conductor-tick.json`, whose relative `armedFile` also resolves from that
directory. Conductor state defaults to `~/.omp/conductor`, while `workspaceRoot`
defaults to its `worktrees/` directory. Setup composes the package floor and the
fleet-owned `POLICY.md` into `ORCHESTRATOR.md` there. No `/root` layout is built
into a new deployment.

Pause only stops the dispatch loop from claiming new work; an armed heartbeat
still fires. Soft-stop both brains with `omp-conductor hold` (pause + disarm).
Harder stops are `halt` / `halt --pane` — see
[`omp/README.md`](omp/README.md#stop-the-conductor-hold--halt).

The Herdr half owns recovery, not dispatch or policy. It restores the exact
session identity, requests an immediate heartbeat, or reports through Telegram
and a Herdr notification that the fleet is down.

## Development

```bash
(cd omp && bun test)                      # omp plugin
(cd herdr && bash test/recover-test.sh)   # herdr plugin — offline, no bats
```

The Herdr half is Bash plus a manifest: no build step, and `herdr plugin link` on
the `herdr/` directory is enough to run the working tree.
