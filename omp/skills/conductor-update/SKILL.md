---
name: conductor-update
description: Safely update an installed omp-conductor fleet as one maintenance operation across both separately installed halves: the npm omp plugin and the GitHub herdr-conductor plugin. Use when the user asks to update, upgrade, refresh, reinstall, or deploy a newly published conductor version, or when installed conductor code is behind npm/main. Quiesces work, preserves exact pane identity, performs a whole-version swap, restarts through the supported lifecycle, re-arms through Telegram proof, and verifies the live fleet.
---

# Update a conductor fleet

Treat an update as one operation across two independently installed plugins:

- `omp-conductor` comes from npm and owns dispatch, CLI, status, and heartbeat.
- `herdr-conductor` comes from `TerrifiedBug/conductor/herdr` and owns exact-pane recovery.

Updating only one half can leave a version that starts but cannot recover correctly.
This skill updates an installed fleet. It does **not** publish npm, merge a PR, tag a
release, or edit files in an install directory.

## Safety boundary

Run this procedure from an operator shell or maintenance omp session that is not
hosted by the target `herdr-fleet.service`. If the current working directory
contains `.conductor-tick.json`, or stopping that unit would kill the session
executing this skill, stop and move the update to an external maintenance
session. A self-terminating updater cannot produce trustworthy verification.

Use the configured target host. Do not assume a hostname, state directory, Herdr
session name, project name, or systemd availability. Read them from the existing
installation and `omp-conductor status`. Never print bot tokens, npm tokens, or
authentication files.

## 1. Establish the desired version

Read, do not guess:

```bash
omp-conductor --version
version=$(npm view omp-conductor version)
gitHead=$(npm view "omp-conductor@$version" gitHead)
npm view "omp-conductor@$version" version gitHead --json
omp plugin list --json
omp-conductor status [--project NAME]
```

Use the registry latest as `$version` unless the user explicitly names another
published version, then query that exact version as shown. Record its `gitHead`
and require a full commit SHA: the npm spec and Herdr ref below are both pinned,
so a concurrent release cannot mix two versions. If npm has no newer version, do
not churn the fleet: report that it is current. Confirm that `herdr` and
`systemctl` are present before taking anything down when status says Herdr
manages the pane.

## 2. Quiesce without losing work

First stop new claims and heartbeat prompts:

```bash
omp-conductor hold [--project NAME]
```

Read status until `active runs (none)`. Do not kill workers to make the update
faster. If a run does not drain, report the run and stop; ordinary update authority
does not include discarding work.

Then stop the exact conductor pane and dispatch daemon through the supported,
fail-closed path:

```bash
omp-conductor halt --pane [--project NAME]
```

This writes the recovery pin before stopping the exact configured Herdr agent. If
identity is invalid, missing, or ambiguous, it refuses rather than killing a guess.
Do not bypass that refusal with `pkill`.

When `herdr-fleet.service` is installed, stop it before replacing either plugin:

```bash
systemctl stop herdr-fleet.service
```

At this point the daemon is stopped, the pane is stopped, and recovery remains
pinned. If any of those statements is false, do not modify the install.

## 3. Replace both installed halves

Refresh the exact npm version using omp's package installer:

```bash
omp plugin install "omp-conductor@$version"
```

Then refresh the Herdr managed checkout from the exact npm release commit. Herdr
requires the GitHub source before its options:

```bash
herdr plugin install TerrifiedBug/conductor/herdr --ref "$gitHead" --yes
```

Do not use `git pull`, `scp`, a linked checkout, or edits under either plugin's
install root. This is a whole-version swap. If either install fails, leave the
fleet stopped and recovery pinned; report the failed command and do not continue
with a mixed live version.

## 4. Start through the new lifecycle

Run the newly installed CLI:

```bash
omp-conductor --version
omp-conductor start [--project NAME]
```

`start` clears the recovery pin, starts the optional `herdr-fleet.service`, and
starts the dispatch daemon after a real `/healthz` check. Herdr then recovers the
exact orchestrator pane and requests an immediate tick; the verification below,
not the `start` command alone, proves that recovery completed.

Wait until `omp-conductor status` reports the exact pane `live`; `start` returning
only proves the service and dispatch daemon. `hold` deliberately disarmed ticks,
so restore unattended operation through the existing Telegram proof:

```bash
omp-conductor arm [--project NAME]
```

Wait for the operator's inbound Telegram reply. Never create the arm marker by
hand and never treat an outbound challenge as proof.

## 5. Verify the live result

Require all of the following before reporting success:

```bash
omp-conductor --version
npm view "omp-conductor@$version" version gitHead --json
omp plugin list --json
herdr plugin list
omp-conductor status [--project NAME]
systemctl is-active herdr-fleet.service
```

- installed version and the npm package entry both equal `$version`;
- the Herdr plugin source revision equals the npm release `gitHead`;
- `dispatch` is `running`;
- `ticks` is `armed` and a next tick is shown;
- `pane` is `live` for the exact configured Herdr agent;
- `recovery` is `clear`;
- `herdr` is `active` when managed;
- Telegram is `ok` (or its exact supported degraded state is reported);
- daemon `/healthz` is `ok`;
- no unexpected active runs appeared during maintenance.

Run a second status check after the immediate recovery tick is consumed. A single
healthy snapshot is not proof that recovery and heartbeat scheduling survived the
swap.

Report the old and new versions, both plugin refreshes, the final layered status,
and any supported degraded state. Do not report success for a partial update.
