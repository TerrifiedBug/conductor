# herdr-conductor

Keeps the 24/7 omp fleet session **running** inside its Herdr pane. When the
Herdr server restarts, when omp exits, or when the pane dies, this plugin resumes
that exact omp session, or pages you and says the fleet is down. It never
guesses which session to resume.

## What it is

A Herdr plugin: one manifest, one Bash script, no build step.

| Hook | Fires | Does |
| --- | --- | --- |
| `[[startup]]` | every Herdr server start and live handoff | resume the fleet session, or page |
| `[[events]] on = "pane.exited"` | a pane's own process dies | ignore other panes; for the fleet pane, resume or page |
| `[[events]] on = "pane.agent_detected"` | an agent appears in or disappears from a pane | same, and this is the hook that catches omp exiting |

All three entry points run the same idempotent flow, so extra invocations cost one
`agent list` plus one `pane process-info` call and change nothing.

## Why it exists

Two different holes, one script.

**A restarted server restores the pane but not the agent.** The fleet pane's saved
snapshot carries the omp session reference that pane reported (`agent_session` in
`src/persist/snapshot.rs`), restore re-creates the pane, and restore attaches a
*deferred* resume plan to it (`src/persist/restore.rs`). That plan only runs once
the UI has a terminal area to draw into: `pending_agent_resume_candidates` returns
nothing while the view is 0×0 (`src/app/agent_resume.rs:78-82`). On a headless VPS
that nobody attaches to, the topology comes back and the agent never does.

**omp exiting does not kill anything Herdr watches.** `herdr agent start` submits
omp *into* the pane's existing shell (`src/app/agents.rs:193-218`), so when omp
exits (crash, OOM, `/exit`), the shell is still there. No `pane.exited` fires,
the pane keeps its `shell_pid`, and for a moment it even keeps its agent name
(`src/terminal/state.rs:1950-1952`). A liveness check that trusts either of those
would call a dead fleet healthy forever. That is why the hook watches
`pane.agent_detected` (emitted unconditionally on release,
`src/app/api.rs:586-597`) and why liveness is decided on the pane's **foreground
job**, not on the pane.

This plugin is that missing nudge, and nothing more. It does not supervise omp, it
does not create panes, and it does not touch the layout.

## Failure modes it covers

| What breaks | What catches it | What happens |
| --- | --- | --- |
| the Herdr server restarts (reboot, upgrade, crash) | `[[startup]]` | the restored pane is resumed by exact identity |
| the fleet pane is destroyed | `pane.exited` | recovery if the pane came back, page otherwise |
| omp exits, its shell survives | `pane.agent_detected` (released) | the pane is still there, so omp is restarted in place |
| omp exits **and** Herdr's debounced session save lands before this hook runs, so the snapshot has the fleet's omp session but no longer its agent name (`agent_name` is written from the terminal, `agent_session` from the persisted session — `src/persist/snapshot.rs:329-361` — and releasing the name touches only the former, `src/terminal/state.rs:1924-1928`) | the same hook: identity falls back to the saved pane at `FLEET_CWD`, then to the release this run just witnessed, then to the identity file this plugin keeps | recovery with the exact ref, not a skip |
| a hook fires in an unrelated Herdr session | the session guard | skip before any Herdr call |
| omp is running normally | any hook | one `agent list` + one `pane process-info`, then exit |

## Session scoping

Installed plugins are global to the user and load in **every** Herdr session, so
without a guard the startup hook of an unrelated session would try to recover the
fleet against the wrong server. `TARGET_SESSION` (default `fleet`) is that guard:
a run whose session name does not match skips before touching anything.

The session name comes from `HERDR_SESSION`, which Herdr sets in its own process
for every way of selecting a named session: `--session <name>`, `--session=<name>`
and `session attach <name>` all end in `set_var` (`src/session.rs:29-94,448-457`).
Plugin commands inherit it, because Herdr adds its own variables on top of the
inherited environment instead of replacing it
(`src/app/api/plugins/runtime.rs:39-63`). When it is absent the name is derived
from the injected socket path, which lives in `<config>/sessions/<name>/` for a
named session and in the config dir itself for the default one
(`src/session.rs:157-171`). Neither available means the default session.

**Deploy the fleet in its own session.** For a systemd unit:

```ini
ExecStart=/usr/local/bin/herdr --session fleet server
```

`herdr server` runs the headless server explicitly, and the global `--session`
flag is consumed before the subcommand dispatch (`src/main.rs:456`), so it also
exports `HERDR_SESSION=fleet` to everything the server spawns, including this
plugin's hooks. `Environment=HERDR_SESSION=fleet` with a plain `herdr server` is
equivalent (`src/session.rs:84-88`).

Set `TARGET_SESSION=` (empty) only on a host where Herdr runs a single session and
that session is the fleet's.

## Install

```bash
herdr plugin install TerrifiedBug/conductor/herdr
herdr plugin config-dir herdr-conductor   # prints the config directory
```

`herdr plugin install` accepts **GitHub shorthand only** (`owner/repo/subdir`).
Herdr plugins v1 has no npm install path and no `plugin update`: to update, run
the same `plugin install` again and it replaces the managed checkout.

Startup hooks run when a server starts or takes over during live handoff. They do
**not** run when a client attaches, when config reloads, or when a plugin is
installed or enabled. After installing on a running server, either restart the
server or run the script once by hand (see [Dry run](#dry-run)) to cover the
current session.

### Prerequisites

- **Herdr ≥ 0.7.5.** `[[startup]]` hooks and `herdr agent start` both landed in
  0.7.5; `[[events]]` in 0.7.0. `min_herdr_version` is set to 0.7.5 and Herdr
  refuses to install a plugin that wants a newer binary than yours.
- **`bash`** ≥ 3.2 (macOS system Bash is fine), **`jq`** (Herdr's session state and
  CLI responses are JSON) and **`curl`** (only for Telegram pages).
- Linux or macOS. Windows is not declared: the recovery path assumes a Unix
  socket path next to `session.json`.
- **[omp-telegram](https://www.npmjs.com/package/omp-telegram)**, installed and
  paired, if you want to hear about a fleet that is down. This plugin holds no
  credentials of its own; it borrows omp-telegram's files: the bot token from
  `TELEGRAM_ENV` (default `/root/.omp/agent/telegram/.env`) and the chat id from
  the first `allowFrom` entry in `ACCESS_JSON` (default
  `/root/.omp/agent/telegram/access.json`). Both paths are overridable in
  `config.env`.

  Without them, recovery still runs and still logs; only the page is skipped, and
  the log line says which file was missing. A Herdr notification is always raised
  regardless, so a page is the remote copy of a signal you already have locally.

For local development, link the working tree instead:

```bash
herdr plugin link /path/to/conductor/herdr
herdr plugin log list --plugin herdr-conductor
```

## Configuration

Optional. Write `config.env` into the directory printed by
`herdr plugin config-dir herdr-conductor`. It is plain shell, sourced, so comments
and quoting work. A missing file means "all defaults".

| Key | Default | Notes |
| --- | --- | --- |
| `TARGET_SESSION` | `fleet` | The Herdr session that owns the fleet. Runs in any other session skip immediately. Empty disables the guard — see [Session scoping](#session-scoping). |
| `AGENT_NAME` | `fleet` | The Herdr agent name of the fleet session. This is the identity everything else hangs off; Herdr keeps live agent names unique. |
| `FLEET_CWD` | `/root/fleet` | The fleet session's working directory. Reported in pages; a saved pane whose cwd has drifted logs a warning rather than blocking recovery. |
| `TELEGRAM_ENV` | `/root/.omp/agent/telegram/.env` | Read for `TELEGRAM_BOT_TOKEN` (`export` and quotes tolerated). Owned by omp-telegram; this plugin only borrows the token. |
| `ACCESS_JSON` | `/root/.omp/agent/telegram/access.json` | The paged chat is `.allowFrom[0]` — the owner omp-telegram is paired with. |
| `SESSION_JSON` | derived | Escape hatch. By default the snapshot is found next to `HERDR_SOCKET_PATH`, because Herdr keeps `herdr.sock` and `session.json` in the same session data directory. |
| `RECOVER_RECHECK_SECONDS` | `2` | How long to wait before re-reading a name claim whose process is gone. Herdr releases the name a beat after it observes the exit, and this keeps that window from paging. `0` disables the wait. |
| `BOOTSTRAP_RESUME` | unset | First provisioning only: an exact omp session ref (absolute `.jsonl` path or session id) to resume when **no** fleet pane has ever been saved. Used at most once — a marker retires it — so a later loss of identity pages instead of quietly provisioning a second fleet. |

Three files live under `HERDR_PLUGIN_STATE_DIR`, each suffixed with the session
name because that directory is global to the user and shared by every session
(`src/plugin_paths.rs:21-25`): `recover.lock*` (the singleton), `identity` (the
last pane and session ref this plugin saw the fleet in) and `bootstrapped` (the
one-shot provisioning marker). The session guard should make cross-session
collisions impossible; the suffix is there for the day it does not.

## How one run decides

1. **Session guard.** Anything but `TARGET_SESSION` skips here, before the lock and
   before any Herdr call.
2. **Singleton.** Non-blocking, per-session lock in `HERDR_PLUGIN_STATE_DIR`
   (`flock` where it exists, atomic `mkdir` on macOS, which ships no `flock(1)`). A
   second instance exits 0 instead of queueing — a server start racing an event for
   the same pane should do the work once.
3. **Identity, before any Herdr call.** In order: a saved pane that still carries
   `agent_name = AGENT_NAME` with an `agent_session` from the official omp
   integration (`source = "herdr:omp"`, `agent = "omp"`); else a saved pane that
   lost its name but sits at `FLEET_CWD` (the shape a snapshot takes the moment omp
   exits); else what this plugin last remembered in its identity file. More than one
   candidate in a tier, or two sources naming different panes, is a page. A pane
   saved under a *different* agent name is never a candidate.
4. **Event filter.** The event's pane id from `HERDR_PLUGIN_EVENT_JSON` is compared
   with that pane id. A different pane exits 0 without a single Herdr call. With no
   resolvable identity there is no evidence the event was about the fleet, so an
   event skips silently — the next startup hook is where absence gets paged.
5. **Liveness.** `herdr agent list` for `AGENT_NAME`, then
   `herdr pane process-info` on each pane that claims it. Three signals, in order:
   - the call itself fails when the pane has no live terminal
     (`src/app/api/panes.rs:198-207`) — the deferred-resume trap;
   - the pane's **foreground job** says whether anything is running in it. Herdr's
     own shell-name set decides (`src/platform/mod.rs:225-244`, login-shell `-zsh`
     normalized like Herdr does): a non-shell foreground means something holds the
     terminal, an all-shell foreground means whatever ran there exited, and no
     readable foreground means *unknown* — never "dead";
   - the reported `agent` label, which for a full-lifecycle integration such as omp
     is only present while Herdr detects that process (`src/terminal/state.rs:1691-1709`).

   Label **and** a non-shell foreground → the fleet is up, exit 0. Anything else is
   either a leftover name (re-read once, then recover) or a page.
   A run that watches the fleet's own claim disappear records the pane and ref it
   just saw — the freshest identity there is, and fresher than a snapshot that has
   already dropped the name.
6. **Live pane.** Exactly one live pane must host no agent and be identified either
   by being the fleet's own pane id or by carrying the resolved session ref — the
   first covers a ref omp has since rotated (a `/clear` or a compaction reports a
   new one), the second a pane that moved and was renumbered. Its own current ref
   wins. It must also be sitting at a shell prompt.
7. **Resume.**
   `herdr agent start "$AGENT_NAME" --kind omp --pane <id> -- --resume=<ref>`.
   Everything after `--` goes to the agent verbatim, and omp resumes from either
   a session id or a session path with `--resume=<value>`.

## When it pages

Any absence, any ambiguity, any failure. Never a guess.

| Condition | Why it is a page and not a repair |
| --- | --- |
| `jq` missing | The host cannot read Herdr's state; nothing can be established. |
| `agent list` / `pane list` unanswered | Fleet state unknown. |
| a pane claims the name but has no live terminal | The deferred-resume trap. `agent start` refuses a pane that already claims the name, so this needs a human — see [The one Herdr setting that matters](#the-one-herdr-setting-that-matters). |
| a claiming pane runs something that is not a shell, with no agent label | Not an exited fleet session. Starting omp there would collide with whatever holds the terminal. |
| a claiming pane's foreground job is unreadable | Absence of evidence. Starting a second omp into a pane that may already have one is the only genuinely destructive outcome available here. |
| omp is gone but Herdr still holds the name after the re-check | `agent start` would be refused with `agent_name_taken` (`src/app/agents.rs:161-167,398-409`) and `agent rename --clear` with `agent_not_found` (`src/app/agents.rs:125-127,330-333`). Herdr frees the name when its detector sees the exit; if it never does, restart the server. |
| no identity at all: nothing saved, nothing remembered | Nothing to resume. Also what a first-ever start looks like — `BOOTSTRAP_RESUME` is the one way to claim that state, once. |
| more than one saved pane in a tier | Two panes claim the fleet; picking one is how you get two orchestrators. |
| the snapshot and the identity file name different panes | Same reason. Whichever is stale, guessing is worse than paging. |
| no live pane matches the fleet's pane id or session ref | The pane did not come back. |
| more than 1 live pane matches | Refusing to pick. |
| the target pane is not at a shell prompt | `agent start` submits omp into the pane shell; something already has it. |
| `agent start` failed | The error text is included. |

A page is both transports: `herdr notification show` for whoever is attached, and
Telegram `sendMessage` for the owner who is not. The message names the host, what
was missing, and that the fleet is DOWN pending manual recovery.

Either transport can be unavailable without taking the other down, and the run
still exits 0 — a startup hook that exits non-zero only decorates the plugin log
(Herdr does not stop the server for it) while the human learns nothing.

The bot token never reaches `argv` (world-readable through `ps` on Linux) or a log
line: it is passed to `curl` on a config file read from stdin, both `curl` streams
are discarded, and failures are reported without the request URL.

## Dry run

Prints every decision and mutates nothing — no `agent start`, no notification, no
Telegram:

```bash
cd "$(herdr plugin list --plugin herdr-conductor --json | jq -r '.result.plugins[0].plugin_root')"
RECOVER_DRY_RUN=1 \
  HERDR_BIN_PATH="$(command -v herdr)" \
  HERDR_PLUGIN_CONFIG_DIR="$(herdr plugin config-dir herdr-conductor)" \
  bash bin/recover.sh
```

A hand-run has no `HERDR_SOCKET_PATH`, so the snapshot is located through
`XDG_CONFIG_HOME`/`HERDR_SESSION` instead — correct for the default session, and
overridable with `SESSION_JSON` for a named one.

Run it against the live server to see exactly what the next restart would do:

```text
herdr-conductor: dry-run: plan: herdr agent start 'fleet' --kind omp --pane w1:p1 -- --resume=/root/.omp/agent/sessions/….jsonl (ref kind: path)
```

## The one Herdr setting that matters

Herdr's `session.resume_agents_on_restore` defaults to `true`. With it on, a
restored omp pane gets the deferred resume plan described above and **no live
terminal** — and a pane with no terminal cannot be driven by `agent start`, which
is why that case pages instead of recovering.

On a headless fleet host, turn it off:

```toml
# ~/.config/herdr/config.toml
[session]
resume_agents_on_restore = false
```

Restored panes then come back as plain shells that still carry the persisted omp
session ref, which is exactly the shape this plugin resumes deterministically.
Attaching a client once also clears the deferred plan, if you would rather keep
the default.

## Tests

```bash
bash test/recover-test.sh
```

Offline, no bats, no Herdr server: fixture JSON (field-accurate against the Herdr
structs it imitates) plus a stub `herdr` binary drive the real script under
`RECOVER_DRY_RUN=1`. One line per case, and the run also `bash -n`s both scripts.

## Limitations

Known and deliberate in this version:

- **Identity is the fleet's pane id and its omp session ref, nothing softer.** No
  cwd heuristics, no "newest session", no pane-title matching. That is the point,
  and it means a fleet whose snapshot was never written (a session that died
  within the save debounce of starting) pages rather than recovers.
- **A pane with a deferred resume plan cannot be recovered, only reported.** See
  above; the fix is a config setting on the host, which no plugin can apply
  through the CLI.
- **Liveness leans on Herdr's own detection.** The foreground job and the agent
  label both come from Herdr. If its detector cannot read a pane's foreground
  processes, this plugin reports *unknown* and pages rather than risk starting a
  second omp into a live pane.
- **A name Herdr has not released yet is a page, not a repair.** Between omp
  exiting and Herdr's detector noticing, the pane still owns the agent name; the
  script waits `RECOVER_RECHECK_SECONDS` and then pages, because no CLI call can
  reclaim that name (`agent rename --clear` needs a currently-detected agent).
- **The identity file is a cache, not a source of truth.** It only ever fills in
  what Herdr's snapshot has forgotten, and it is never preferred over a saved pane
  that still names the fleet. Delete it and the plugin falls back to the snapshot;
  keep a stale one and a disagreement pages rather than resolving itself.
- **One fleet per Herdr session.** `TARGET_SESSION`/`AGENT_NAME` name exactly one,
  and state files are per session, so two fleets need two sessions.
- **No back-off or retry.** Each hook invocation decides once. The next server
  start, pane exit, or agent release retries recovery; this script never does.
- **Pages are not deduplicated.** Ten failing pane exits are ten pages. The
  singleton lock only collapses runs that overlap in time.
- **`jq` and `curl` are assumed, not installed.** Herdr reports plugin build and
  runtime failures; it does not provision toolchains.
