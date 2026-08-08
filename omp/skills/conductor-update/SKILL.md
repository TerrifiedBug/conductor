---
name: conductor-update
description: Update an installed conductor fleet through one operator request. Use when the user asks to update, upgrade, refresh, reinstall, or deploy conductor. Pins one npm release across the Bun-global CLI, omp plugin, and Herdr recovery plugin; converts a local Herdr link when needed; pauses claims, reloads processes, verifies the fleet, and restores the operator's prior pause state.
---

# Update a conductor fleet

The operator interface is one request: **“update conductor.”** Do not hand them
the implementation as a checklist unless execution is blocked.

One release has three installed surfaces:

1. Bun-global `omp-conductor`: CLI and systemd daemon source.
2. omp npm plugin `omp-conductor`: slash command and heartbeat loaded by sessions.
3. Herdr plugin `herdr-conductor`: exact-pane recovery, pinned to the npm
   release's `gitHead`.

This skill performs the whole swap. It does not publish npm, merge, tag, edit an
install root, or update unrelated Bun packages.

## Safety boundary

Run from an operator shell or maintenance omp session that is not hosted by the
target `herdr-fleet.service`. If restarting that unit would kill this updater,
move to an external session first. Never print npm, Telegram, or bot credentials.

The normal update is:

```text
inspect → pause claims → drain → pinned installs → reload → verify → restore pause state
```

Ticks stay in their existing armed or disarmed state. Do not use `hold`,
`halt --pane`, `disarm`, `arm`, recovery pins, `pkill`, or manual install-root
edits for a healthy update.

## 1. Resolve one release and inspect every surface

Use the registry latest unless the operator names another published version:

```bash
version=$(npm view omp-conductor version)
gitHead=$(npm view "omp-conductor@$version" gitHead)
npm view "omp-conductor@$version" version gitHead --json
```

Require `$version` to be nonempty and `$gitHead` to be a full commit SHA before
changing state.

Inspect, without mutating:

```bash
omp-conductor --version
omp plugin list --json
herdr --session "$session" plugin list
omp-conductor status [--project NAME]
```

Honor the installation's existing Herdr session and `HERDR_CONFIG_PATH`; discover
them from the running unit/config rather than assuming `fleet` or a path.

Record:

- Bun-global CLI version;
- omp plugin version;
- Herdr plugin source: GitHub revision, `local:<path>`, or missing;
- initial dispatch state: running, paused, or stopped;
- initial ticks state, which this update must not change;
- active runs and layered health.

Report “already current” only when **all** of these are true:

- Bun-global CLI version equals `$version`;
- omp plugin version equals `$version`;
- Herdr source revision equals `$gitHead`;
- layered status is healthy for the fleet's configured topology.

A current npm version with a linked, missing, or stale Herdr plugin is a partial
update, not a no-op. If all versions match but status is unhealthy, diagnose the
reported layer; never call an unhealthy fleet current.

## 2. Pause claims and drain

If dispatch was running:

```bash
omp-conductor pause [--project NAME]
```

If it was already paused, preserve that state. If it was stopped, do not start it
later merely because packages were updated.

Wait for `active runs (none)`. Never kill workers for an update. If a run does not
drain, stop and report it; leave any pause this skill added in place.

## 3. Replace all three surfaces with the pinned release

Use exact versions. A broad `bun update` is prohibited.

```bash
bun add -g "omp-conductor@$version"
omp plugin install "omp-conductor@$version"
```

For Herdr, inspect the source found in step 1:

- `local:<path>`: unlink the plugin id first;
- GitHub-managed or missing: do not unlink.

Then install the exact npm release commit. Herdr requires the source argument
before its options:

```bash
herdr plugin unlink herdr-conductor  # only when step 1 reported local:<path>
herdr plugin install TerrifiedBug/conductor/herdr --ref "$gitHead" --yes
```

If any install fails, do not reload processes and do not restore dispatch.
Leave the fleet paused, report the failed surface, and give the one retry command.
The still-running processes keep their already-loaded code until a successful
reload.

## 4. Reload the installed code

When Herdr is systemd-managed, restart its fleet unit. This reloads the managed
recovery plugin and causes exact-identity recovery to resume the orchestrator pane
with the new omp extension:

```bash
systemctl restart herdr-fleet.service
```

Wait until Herdr reports its unit active and the exact configured agent live.

If the dispatch daemon was running or paused initially, restart it so its process
and source-integrity baseline use the new Bun-global package:

```bash
omp-conductor restart [--project NAME]
```

Do not substitute `start` when the daemon was initially stopped.

## 5. Verify before restoring claims

Check every surface again:

```bash
omp-conductor --version
omp plugin list --json
herdr --session "$session" plugin list
omp-conductor status [--project NAME]
systemctl is-active herdr-fleet.service
```

Require:

- global CLI and omp plugin both equal `$version`;
- Herdr source equals `TerrifiedBug/conductor` at `$gitHead`;
- exact pane is live and recovery is clear;
- Herdr and daemon health are OK when managed;
- ticks equal their initial state;
- active runs remain empty;
- dispatch remains paused if this skill paused it.

Run status a second time after recovery settles. Any failed check leaves dispatch
paused and is reported as a partial update.

Only if dispatch was initially running and every check passed:

```bash
omp-conductor resume [--project NAME]
```

Verify `dispatch running` once more. If dispatch was initially paused or stopped,
preserve that state and report it.

Finish with one compact result: old → new version, all three installed surfaces,
final layered status, and whether the original dispatch state was restored.
