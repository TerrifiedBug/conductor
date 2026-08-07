#!/usr/bin/env bash
#
# herdr-conductor · fleet recovery
#
# One job: make sure the named omp fleet session is *running* inside its Herdr
# pane, and page a human the moment that cannot be proven by exact identity.
#
# Why it exists. Herdr already persists the fleet pane and the omp session ref
# that pane reported (`agent_session` in src/persist/snapshot.rs:97-118) and
# re-creates the pane on restore with a *deferred* resume plan
# (src/persist/restore.rs:536-539). Those deferred resumes only start once the
# UI has a terminal area: `pending_agent_resume_candidates` returns nothing
# while the view is 0x0 (src/app/agent_resume.rs:78-82). A 24/7 headless server
# that nobody attaches to therefore restores the topology and never restarts the
# agent. This hook closes exactly that gap — nothing else.
#
# Three rules shape the whole script.
#
#   1. Exact identity only. The saved omp session ref for the configured agent
#      name must match exactly one saved pane and exactly one live pane. Zero or
#      several candidates is a page, never "the newest session".
#   2. Idempotent. A proven-live fleet agent short-circuits, so the common case
#      costs one `agent list` plus one `pane process-info` call.
#   3. Fail-closed, never fatal. Every failure pages and exits 0. A startup hook
#      that exits non-zero only decorates the plugin command log (Herdr does not
#      stop the server for it, plugins.mdx:240-241) while the human, who is the
#      actual recovery path, learns nothing.
#
# Invoked as: [[startup]] (every server start and live handoff) and on
# `pane.exited`. Both entry points run the same flow; the event entry point
# first filters out pane exits that are not the fleet pane, without touching the
# Herdr API.
#
# RECOVER_DRY_RUN=1 prints every decision and mutates nothing.

set -uo pipefail

PROG=herdr-conductor
HERDR_BIN=${HERDR_BIN_PATH:-herdr}

# Herdr's public pane/tab number alphabet, mirrored from src/workspace.rs:99.
PUBLIC_ID_ALPHABET='123456789ABCDEFGHJKMNPQRSTVWXYZ0'

# Record separator for every internal "one row, several fields" string. Tab looks
# obvious and is wrong: tab is IFS whitespace, so bash's `read` collapses a run of
# them and an empty middle field (an agent with no label, a pane with no saved
# number) silently shifts every field after it. The unit separator is neither
# whitespace nor legal in a pane id, session path, or cwd.
FIELD_SEP=$'\x1f'

LOCK_DIR=''
LOCK_FD_OPEN=''
# Resolved once in main() / run_recovery(); state file names hang off it.
SESSION_NAME=default

# --------------------------------------------------------------------------
# output
# --------------------------------------------------------------------------

# Herdr captures both streams into the plugin command log, so decisions go to
# stdout (they are the record of what this run concluded) and incidents to
# stderr.
say() { printf '%s: %s\n' "$PROG" "$*"; }
log() { printf '%s: %s\n' "$PROG" "$*" >&2; }

dry_run() { [[ ${RECOVER_DRY_RUN:-0} == 1 ]]; }

decide() {
  if dry_run; then
    printf '%s: dry-run: %s\n' "$PROG" "$*"
  else
    printf '%s: %s\n' "$PROG" "$*"
  fi
}

# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------

# `$HERDR_PLUGIN_CONFIG_DIR/config.env` is plain shell (`KEY=value`) and is
# sourced, so it can also carry comments and quoting. Herdr creates that
# directory and never touches its contents (plugins.mdx:264-271); a missing file
# just means "all defaults".
load_config() {
  local file="${HERDR_PLUGIN_CONFIG_DIR:-}/config.env"
  if [[ -n ${HERDR_PLUGIN_CONFIG_DIR:-} && -f $file ]]; then
    # shellcheck disable=SC1090 # user-owned config, path known only at runtime
    . "$file" || log "failed to source $file; continuing with defaults"
  fi
  AGENT_NAME=${AGENT_NAME:-fleet}
  FLEET_CWD=${FLEET_CWD:-/root/fleet}
  TELEGRAM_ENV=${TELEGRAM_ENV:-/root/.omp/agent/telegram/.env}
  ACCESS_JSON=${ACCESS_JSON:-/root/.omp/agent/telegram/access.json}
  # Seconds to wait before re-reading a stale name claim. Herdr's detector
  # releases the name a beat after an agent exits, and this keeps that window
  # from becoming a page. 0 disables the wait.
  RECHECK_SECONDS=${RECOVER_RECHECK_SECONDS:-2}
  case $RECHECK_SECONDS in
    '' | *[!0-9]*) RECHECK_SECONDS=2 ;;
  esac
  # First-provisioning only: an exact omp session ref (absolute .jsonl path or
  # session id) to resume when NO saved fleet pane exists yet. Used at most
  # once — a marker in the state dir retires it — so a later loss of the saved
  # identity pages instead of silently re-provisioning. Empty means "never
  # bootstrap" (zero saved candidates page, as before).
  BOOTSTRAP_RESUME=${BOOTSTRAP_RESUME:-}
  # Escape hatch for named sessions in exotic layouts; empty means "derive".
  SESSION_JSON=${SESSION_JSON:-}
  # Which Herdr session owns the fleet. Plugins are global to the user and load
  # in EVERY session (plugins.mdx:197-200), so without this an unrelated session's
  # startup hook would try to recover the fleet in the wrong server. Empty
  # disables the guard for single-session hosts.
  # `-` not `:-`: an explicitly empty TARGET_SESSION is a deliberate "no guard",
  # while an unset one gets the default.
  TARGET_SESSION=${TARGET_SESSION-fleet}
}

# The name of the Herdr session this hook is running in.
#
# `HERDR_SESSION` is authoritative: every way of selecting a named session ends
# in `std::env::set_var(SESSION_ENV_VAR, …)` (src/session.rs:29-94,448-457, with
# SESSION_ENV_VAR = "HERDR_SESSION" at :10), and plugin commands are spawned with
# `.envs(extra)` on top of the inherited server environment — no `env_clear()` —
# so it reaches this script (src/app/api/plugins/runtime.rs:39-63 and the spawn
# below it).
#
# Fallback: the injected socket path lives in the session data dir, which is the
# config dir for the default session and `<config>/sessions/<name>` for a named
# one (src/session.rs:157-171). Neither available → "default", the name Herdr
# itself uses for the unnamed session (src/session.rs:11).
current_session() {
  local name=${HERDR_SESSION:-}
  if [[ -n $name ]]; then
    printf '%s' "$name"
    return 0
  fi
  local dir parent
  if [[ -n ${HERDR_SOCKET_PATH:-} ]]; then
    dir=$(dirname "$HERDR_SOCKET_PATH")
    parent=$(basename "$(dirname "$dir")")
    if [[ $parent == sessions ]]; then
      printf '%s' "$(basename "$dir")"
      return 0
    fi
  fi
  printf 'default'
}

# Per-session state file names. HERDR_PLUGIN_STATE_DIR is global to the user,
# not per session (src/plugin_paths.rs:21-25 builds it from
# crate::config::state_dir(), which has no session component), so the lock, the
# remembered identity and the bootstrap marker are suffixed with the session.
# The session guard should make a cross-session run impossible; this is defence
# in depth for the day it is not.
state_file() { # <basename>
  local dir=${HERDR_PLUGIN_STATE_DIR:-${TMPDIR:-/tmp}} slug
  slug=$(printf '%s' "${SESSION_NAME:-default}" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s/%s.%s' "$dir" "$1" "$slug"
}

# --------------------------------------------------------------------------
# singleton
# --------------------------------------------------------------------------

release_lock() {
  if [[ -n $LOCK_FD_OPEN ]]; then
    exec 9>&-
    LOCK_FD_OPEN=''
  fi
  if [[ -n $LOCK_DIR ]]; then
    rm -f "$LOCK_DIR/pid" 2>/dev/null
    rmdir "$LOCK_DIR" 2>/dev/null
    LOCK_DIR=''
  fi
}

# Non-blocking: a second instance exits 0 rather than queueing behind the first.
# A server start that races a `pane.exited` for the same pane must do the work
# once, and the loser has nothing useful to add.
acquire_lock() {
  local dir=${HERDR_PLUGIN_STATE_DIR:-${TMPDIR:-/tmp}}
  mkdir -p "$dir" 2>/dev/null
  if [[ ! -d $dir ]]; then
    # The lock is an optimization, the recovery is the point. An unusable state
    # directory must not be read as "someone else is already recovering".
    log "cannot use $dir for the recovery lock; running without a singleton"
    return 0
  fi
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$(state_file recover.lock)" || return 1
    LOCK_FD_OPEN=1
    if ! flock -n 9; then
      exec 9>&-
      LOCK_FD_OPEN=''
      return 1
    fi
    trap release_lock EXIT
    return 0
  fi
  # macOS ships no flock(1), and this plugin declares macos support. mkdir is
  # atomic on both platforms, which is all a singleton needs.
  local lock
  lock=$(state_file recover.lock.d)
  if mkdir "$lock" 2>/dev/null; then
    LOCK_DIR=$lock
    printf '%s\n' "$$" >"$lock/pid" 2>/dev/null
    trap release_lock EXIT
    return 0
  fi
  # A hook killed mid-run must not wedge recovery until the next reboot.
  local owner
  owner=$(cat "$lock/pid" 2>/dev/null)
  if [[ -n $owner ]] && ! kill -0 "$owner" 2>/dev/null; then
    log "clearing stale recovery lock from pid $owner"
    rm -f "$lock/pid" 2>/dev/null
    rmdir "$lock" 2>/dev/null
    if mkdir "$lock" 2>/dev/null; then
      LOCK_DIR=$lock
      printf '%s\n' "$$" >"$lock/pid" 2>/dev/null
      trap release_lock EXIT
      return 0
    fi
  fi
  return 1
}

# --------------------------------------------------------------------------
# herdr access
# --------------------------------------------------------------------------

# Every CLI response is a single JSON line (src/cli.rs:719-727). There is no
# `--json` flag on `agent list` / `pane list`: passing one exits 2
# (src/cli/agent.rs:377-381), so callers just parse stdout.
herdr_json() {
  "$HERDR_BIN" "$@" 2>/dev/null
}

# Only ever called after the same command already failed: stderr carries the
# CLI's error JSON (src/cli.rs:719-723), which is the one thing that turns "the
# API did not answer" into something a woken human can act on. Kept off the
# success path so a stray warning can never corrupt parsed stdout.
herdr_error_detail() {
  local err
  err=$("$HERDR_BIN" "$@" 2>&1 >/dev/null)
  printf '%s' "${err:-no error output}"
}

# `pane process-info` resolves a live terminal runtime and answers
# `pane_not_found` when there is none (src/app/api/panes.rs:198-207). Success
# means the pane has a live shell; the payload's foreground job is what says
# whether anything is running *in* it (src/api/schema/panes.rs:437-462).
pane_process_info() {
  herdr_json pane process-info --pane "$1"
}

# Herdr's own set of pane shell names, mirrored from
# src/platform/mod.rs:225-244, with its normalization (basename, strip a leading
# `-` for login shells, strip a trailing `.exe`, lowercase) from :176-183.
is_shell_process_name() {
  local name=${1##*/}
  name=${name##*\\}
  while [[ $name == -* ]]; do name=${name#-}; done
  name=${name%.exe}
  name=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
  case $name in
    sh | bash | dash | zsh | fish | ksh | mksh | csh | tcsh | elvish | xonsh | nu | pwsh | powershell | cmd)
      return 0
      ;;
  esac
  return 1
}

# The whole point of this function: `agent start` submits omp *into* a shell
# (src/app/agents.rs:193-218), so when omp exits the shell survives — no
# `pane.exited`, and a pane that still has a `shell_pid` proves nothing about
# omp. The foreground job does.
#   alive   — something that is not a shell holds the terminal
#   shell   — the pane is sitting at a shell prompt: whatever ran there is gone
#   unknown — Herdr could not read the foreground job; absence of evidence, and
#             never treated as "dead", because starting a second omp into a live
#             pane is the one genuinely destructive outcome available here
foreground_verdict() {
  local names name saw_any=''
  names=$(printf '%s' "$1" | jq -r '
    (((.result // .).process_info // {}).foreground_processes // [])[]
    | (.name // "")
  ' 2>/dev/null)
  while IFS= read -r name; do
    [[ -z $name ]] && continue
    saw_any=1
    if ! is_shell_process_name "$name"; then
      printf 'alive'
      return 0
    fi
  done <<<"$names"
  if [[ -z $saw_any ]]; then
    printf 'unknown'
  else
    printf 'shell'
  fi
}

# --------------------------------------------------------------------------
# pure decision helpers (the test drives these directly)
# --------------------------------------------------------------------------

# Bijective base-32, mirroring src/workspace.rs:106-118. Public pane ids survive
# a restore unchanged (src/persist/restore.rs:330-344), so this is enough to
# name the fleet pane from the snapshot alone — no Herdr call needed.
encode_public_number() {
  local value=$1 out='' digit
  if (( value == 0 )); then
    printf '0'
    return 0
  fi
  while (( value > 0 )); do
    digit=$(( (value - 1) % 32 ))
    out="${PUBLIC_ID_ALPHABET:digit:1}$out"
    value=$(( (value - 1) / 32 ))
  done
  printf '%s' "$out"
}

# `HERDR_PLUGIN_EVENT_JSON` is a serialized EventEnvelope
# (src/app/api/plugins/runtime.rs:241) — `{"event":"pane_exited","data":{...}}`
# — and the pane id inside it is the public one (src/app/api.rs:229-234).
event_pane_id() {
  printf '%s' "$1" | jq -r '(.data // {}).pane_id // empty' 2>/dev/null
}

# Saved panes that could be the fleet, in two tiers.
#
# The snapshot writes `agent_name` and `managed_agent_kind` straight from the
# terminal, but `agent_session` from the hook authority or the *persisted*
# session (src/persist/snapshot.rs:329-361) — and releasing an agent name clears
# only agent_name/agent_name_owner/managed_agent (src/terminal/state.rs:1924-1928
# via :540-541). So the moment omp exits, the very next session save keeps the
# fleet's omp session ref and drops its name. Matching on the name alone would
# lose the fleet exactly when it needs recovering.
#
#   named  — `agent_name` is the configured name: the strongest evidence.
#   orphan — no saved name at all, and the pane's saved cwd is FLEET_CWD: the
#            post-release shape of the same pane.
#
# A pane saved under a *different* agent name is never a candidate. `herdr:omp` /
# `omp` is the only pair Herdr resumes as omp (src/agent_resume.rs:154-158).
# Emits: tier, workspace_id, saved pane key, public pane number, ref kind, ref
# value, saved cwd.
saved_fleet_panes() {
  local file=$1 name=$2 fleet_cwd=$3
  jq -r --arg name "$name" --arg cwd "$fleet_cwd" '
    (.workspaces // [])[] as $ws
    | ($ws.tabs // [])[] as $tab
    | (($tab.panes // {}) | to_entries[]) as $pane
    | ($pane.value.agent_session // {}) as $session
    | ($pane.value.agent_name // "") as $saved_name
    | select(($session.source // "") == "herdr:omp")
    | select(($session.agent // "") == "omp")
    | select(($session.value // "") != "")
    | (
        if $saved_name == $name then "named"
        elif $saved_name == "" and ($pane.value.cwd // "") == $cwd then "orphan"
        else "" end
      ) as $tier
    | select($tier != "")
    | [
        $tier,
        ($ws.id // ""),
        $pane.key,
        ((($ws.public_pane_numbers // {}) | .[$pane.key]) // "" | tostring),
        ($session.kind // ""),
        $session.value,
        ($pane.value.cwd // "")
      ]
    | join("\u001f")
  ' "$file" 2>/dev/null
}

# On omp-conductor's stall marker, and why this plugin deliberately ignores it.
#
# A wedged agent loop passes both of this plugin's liveness tests — the process
# is there, the label is there, nothing is being read off the queue — so a
# marker check here looked like the missing third input. It is not, because of
# when this plugin runs: only on `startup`, `pane.exited` and
# `pane.agent_detected`. A session that stays alive and stops working emits
# none of those, so the check could never fire during the wedge itself.
#
# What it *would* catch is the recovery afterwards — and there it is actively
# wrong. The marker is cleared by the first tick the new session consumes, up
# to a full interval after the restart, so every `pane.agent_detected` from an
# operator's own SIGTERM-and-resume would page about the healthy session they
# just fixed. Distinguishing the two needs the process start time against the
# marker's, and `pane process-info` reports pids, not start times.
#
# So the daemon owns this: a different process, awake every five minutes,
# already holding an escalation path, and structurally unable to be wedged by
# the session it is watching (`watchOrchestrator` in omp/src/daemon.ts). The
# coverage it gives up here is at most one daemon tick.

# Plugin-owned durable identity: the last pane and session ref this plugin saw
# the fleet running in. Herdr's snapshot is authoritative but debounced, and the
# `agent_name` in it disappears the instant omp exits; this file is what keeps a
# recovery honest when the snapshot has already forgotten who the fleet was.
identity_path() {
  state_file identity
}

remember_identity() { # <pane_id> <session ref>
  local file tmp
  [[ -n ${1:-} && -n ${2:-} ]] || return 0
  dry_run && return 0
  file=$(identity_path)
  tmp="$file.$$"
  if ! printf '%s%s%s\n' "$1" "$FIELD_SEP" "$2" >"$tmp" 2>/dev/null; then
    log "could not write $tmp; fleet identity not remembered"
    return 0
  fi
  mv -f "$tmp" "$file" 2>/dev/null || {
    rm -f "$tmp" 2>/dev/null
    log "could not replace $file; fleet identity not remembered"
  }
  return 0
}

# Prints "<pane_id>\t<ref>"; non-zero when there is nothing usable on disk.
read_identity() {
  local file line pane ref
  file=$(identity_path)
  [[ -f $file ]] || return 1
  IFS= read -r line <"$file" || return 1
  IFS="$FIELD_SEP" read -r pane ref <<<"$line"
  [[ -n ${pane:-} && -n ${ref:-} ]] || return 1
  printf '%s%s%s' "$pane" "$FIELD_SEP" "$ref"
}

# Every claim on the configured name, with what Herdr currently detects in that
# pane and the omp session it reports:
# "<pane_id>\t<agent label or empty>\t<omp session ref or empty>".
#
# `agent list` reports any pane Herdr counts as an agent terminal, which includes
# a pane whose saved name outlived its process: is_agent_terminal() is true on
# `agent_name` alone (src/terminal/state.rs:1950-1952) and nothing clears that
# name until Herdr's detector observes the exit (src/terminal/state.rs:302,
# 540-541 via src/pane.rs:786-788) — the herdr test at state.rs:2106-2112 pins
# exactly that stickiness.
#
# The `agent` field is the useful half. For a full-lifecycle integration such as
# omp it is only reported while the agent process is currently detected in the
# pane (src/terminal/state.rs:1691-1709 + src/detect/mod.rs:283-293), so a claim
# *with* a label means omp is running and a claim *without* one means the name is
# a leftover.
live_name_claims() {
  printf '%s' "$1" | jq -r --arg name "$2" '
    ((.result // .).agents // [])[]
    | select((.name // "") == $name)
    | (.agent_session // {}) as $session
    | [
        .pane_id,
        (.agent // ""),
        (if ($session.source // "") == "herdr:omp" then ($session.value // "") else "" end)
      ]
    | join("\u001f")
  ' 2>/dev/null
}

# Live panes that could host the resumed fleet: no agent in them (the
# CLI-visible half of the `agent start` precondition, src/app/agents.rs:183-191)
# and identified either by being the fleet's own restored pane id or by carrying
# the saved omp session ref. Both are exact; the pane id covers a session ref
# that omp has since rotated (a `/clear` or compaction reports a new one), the
# ref covers a pane that moved and was renumbered.
#
# Prints "<pane_id>\t<live omp session ref or empty>" so the caller can prefer
# the pane's own current ref over the snapshot's.
live_resume_candidates() {
  printf '%s' "$1" | jq -r --arg pane "$2" --arg ref "$3" '
    ((.result // .).panes // [])[]
    | (.agent_session // {}) as $session
    | select((.agent // "") == "")
    | select(
        ($pane != "" and .pane_id == $pane)
        or ($ref != "" and ($session.source // "") == "herdr:omp" and ($session.value // "") == $ref)
      )
    | [
        .pane_id,
        (if ($session.source // "") == "herdr:omp" then ($session.value // "") else "" end)
      ]
    | join("\u001f")
  ' 2>/dev/null
}

line_count() {
  if [[ -z ${1:-} ]]; then
    printf '0'
    return 0
  fi
  printf '%s\n' "$1" | wc -l | tr -d '[:space:]'
}

# session.json lives beside the API socket, because both are children of the
# session data dir (src/persist/io.rs:10-11, src/session.rs:161-171). Deriving
# it from `HERDR_SOCKET_PATH` therefore lands on the right file for the default
# session and for named ones, without this script having to know about
# `HERDR_SESSION`. The XDG fallback exists only for a socket-less invocation.
session_json_path() {
  if [[ -n ${SESSION_JSON:-} ]]; then
    printf '%s' "$SESSION_JSON"
    return 0
  fi
  local socket=${HERDR_SOCKET_PATH:-}
  if [[ -n $socket ]]; then
    printf '%s/session.json' "$(dirname "$socket")"
    return 0
  fi
  local base=${XDG_CONFIG_HOME:-${HOME:-}/.config}/herdr
  local named=${HERDR_SESSION:-}
  if [[ -n $named && $named != default ]]; then
    printf '%s/sessions/%s/session.json' "$base" "$named"
  else
    printf '%s/session.json' "$base"
  fi
}

# --------------------------------------------------------------------------
# paging
# --------------------------------------------------------------------------

page_text() {
  local reason=$1 detail=${2:-}
  local host
  host=$(hostname 2>/dev/null || uname -n 2>/dev/null || printf 'unknown-host')
  printf 'conductor · fleet DOWN\n'
  printf 'host: %s\n' "$host"
  printf 'trigger: %s\n' "${HERDR_PLUGIN_EVENT:-manual}"
  printf 'agent: %s (cwd %s)\n' "$AGENT_NAME" "$FLEET_CWD"
  printf 'missing: %s\n' "$reason"
  [[ -n $detail ]] && printf 'detail: %s\n' "$detail"
  printf 'The fleet is DOWN pending manual recovery; herdr-conductor will not guess a session to resume.\n'
}

# omp-telegram owns this file; conductor only borrows the token, so a host
# already running that bot needs no extra configuration. Tolerates `export ` and
# quotes exactly like the omp side (omp/src/escalate.ts:189-211).
telegram_token() {
  local file=$1 line value quote
  [[ -f $file ]] || return 1
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line#"${line%%[![:space:]]*}"}
    case $line in
      '' | '#'*) continue ;;
    esac
    # `export KEY=value` is as valid in a .env as `KEY=value`.
    if [[ $line == export[[:space:]]* ]]; then
      line=${line#export}
      line=${line#"${line%%[![:space:]]*}"}
    fi
    case $line in
      TELEGRAM_BOT_TOKEN=*) ;;
      *) continue ;;
    esac
    value=${line#*=}
    value=${value#"${value%%[![:space:]]*}"}
    value=${value%"${value##*[![:space:]]}"}
    quote=${value:0:1}
    if [[ ${#value} -ge 2 && ($quote == '"' || $quote == "'") && ${value: -1} == "$quote" ]]; then
      value=${value:1:${#value}-2}
    fi
    if [[ -n $value ]]; then
      printf '%s' "$value"
      return 0
    fi
  done <"$file"
  return 1
}

# The paired owner: omp-telegram's access list, first entry.
telegram_chat_id() {
  local file=$1 chat
  [[ -f $file ]] || return 1
  chat=$(jq -r '((.allowFrom // [])[0]) // empty | tostring' "$file" 2>/dev/null)
  [[ -n $chat ]] || return 1
  printf '%s' "$chat"
}

# The token never reaches argv (world-readable in `ps` on Linux) and never
# reaches a log: it goes in on a curl config file read from stdin, and both curl
# streams are discarded, so a failing request cannot quote the URL back at us.
telegram_send() {
  local text=$1 token chat
  token=$(telegram_token "$TELEGRAM_ENV") || {
    log "no TELEGRAM_BOT_TOKEN in $TELEGRAM_ENV; telegram page skipped"
    return 1
  }
  chat=$(telegram_chat_id "$ACCESS_JSON") || {
    log "no allowFrom[0] in $ACCESS_JSON; telegram page skipped"
    return 1
  }
  if ! command -v curl >/dev/null 2>&1; then
    log "curl is not installed; telegram page skipped"
    return 1
  fi
  if printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
    curl -s -m 20 -o /dev/null -K - \
      --data-urlencode "chat_id=$chat" \
      --data-urlencode "text=$text" \
      --data-urlencode 'disable_web_page_preview=true' >/dev/null 2>&1; then
    return 0
  fi
  log 'telegram sendMessage failed (details withheld: the request URL carries the bot token)'
  return 1
}

# Both transports, always: the toast reaches whoever is attached now, Telegram
# reaches the owner who is not.
page() {
  local reason=$1 detail=${2:-} text
  if dry_run; then
    decide "page: $reason"
    return 0
  fi
  say "page: $reason"
  # The toast body stays short and Telegram may be unreachable, so the diagnosis
  # also goes to the plugin command log (`herdr plugin log list`).
  [[ -n $detail ]] && log "detail: $detail"
  text=$(page_text "$reason" "$detail")
  "$HERDR_BIN" notification show 'Conductor: fleet DOWN' \
    --body "$reason" --sound request >/dev/null 2>&1 ||
    log 'herdr notification show failed'
  telegram_send "$text" || true
}

# --------------------------------------------------------------------------
# flow
# --------------------------------------------------------------------------

# Ask the omp orchestrator-tick extension to fire as soon as it arms, instead of
# waiting up to `intervalSeconds` (often 30 min) after a restart. Written into
# FLEET_CWD *before* `agent start` so session_start can see it; the extension
# clears the file only after a tick is actually sent (armed + channel up).
# Live-agent short-circuit never calls this — nothing was resumed.
TICK_REQUESTED_FILE='.conductor-tick-requested'

request_immediate_tick() {
  local path=$FLEET_CWD/$TICK_REQUESTED_FILE
  if dry_run; then
    decide "plan: request immediate tick via $path"
    return 0
  fi
  if printf '%s recover\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$path" 2>/dev/null; then
    decide "requested immediate tick: $path"
  else
    log "could not write $path; resumed fleet may wait a full tick interval to reconcile"
  fi
}

start_fleet() {
  local pane=$1 ref=$2 kind=$3 err
  if dry_run; then
    decide "plan: $HERDR_BIN agent start '$AGENT_NAME' --kind omp --pane $pane -- --resume=$ref (ref kind: $kind); request immediate tick via $FLEET_CWD/$TICK_REQUESTED_FILE"
    return 0
  fi
  # `--` hands the rest to the agent verbatim (src/cli/agent.rs:277-280,339-343)
  # and omp resumes with `--resume=<id-or-path>` for both ref kinds
  # (src/agent_resume.rs:154-158).
  # Tick request first: agent start is when session_start runs, and that is the
  # moment the heartbeat can consume the sentinel without waiting an interval.
  request_immediate_tick
  if err=$("$HERDR_BIN" agent start "$AGENT_NAME" --kind omp --pane "$pane" -- "--resume=$ref" 2>&1 >/dev/null); then
    remember_identity "$pane" "$ref"
    decide "recovered: agent '$AGENT_NAME' resumed in pane $pane (--resume=$ref)"
    return 0
  fi
  # Start failed: drop the poke so a later live session in this cwd is not
  # spuriously tick-nudged by a recovery that never happened.
  rm -f "$FLEET_CWD/$TICK_REQUESTED_FILE" 2>/dev/null || true
  page "agent start failed for pane $pane" "${err:-no error output}"
  return 0
}

# First provisioning: no saved fleet pane has ever existed on this server, and
# the operator supplied the exact session to resume. Creates a dedicated
# workspace at FLEET_CWD and starts the agent there. At most once: the state
# marker retires BOOTSTRAP_RESUME, so losing the saved identity LATER pages
# instead of quietly re-provisioning (an exact-identity guarantee, not a
# convenience). Returns 0 when this run handled the situation (bootstrapped or
# paged), 1 when bootstrap does not apply and the caller should page as usual.
bootstrap_fleet() {
  [[ -n $BOOTSTRAP_RESUME ]] || return 1
  local marker
  marker=$(state_file bootstrapped)
  # A remembered identity means a fleet has already lived on this server, so a
  # zero-candidate snapshot is a lost identity, not a virgin host. Provisioning a
  # second workspace there is how you end up with two orchestrators.
  if [[ -f $(identity_path) ]]; then
    log "BOOTSTRAP_RESUME is set but $(identity_path) already remembers a fleet pane; not provisioning"
    return 1
  fi
  if [[ -e $marker ]]; then
    log "BOOTSTRAP_RESUME is set but $marker exists; bootstrap already ran once"
    return 1
  fi
  # A path ref must exist on disk; an id ref (no slash) cannot be checked here
  # and is handed to omp as-is.
  if [[ $BOOTSTRAP_RESUME == /* && ! -f $BOOTSTRAP_RESUME ]]; then
    page "bootstrap ref $BOOTSTRAP_RESUME does not exist" \
      'BOOTSTRAP_RESUME names a session file that is not on disk; refusing to provision.'
    return 0
  fi
  if dry_run; then
    decide "plan: bootstrap — $HERDR_BIN workspace create --cwd $FLEET_CWD --label fleet --no-focus, then agent start with --resume=$BOOTSTRAP_RESUME; request immediate tick via $FLEET_CWD/$TICK_REQUESTED_FILE"
    return 0
  fi
  local created pane
  created=$(herdr_json workspace create --cwd "$FLEET_CWD" --label fleet --no-focus) || {
    page 'the Herdr API did not answer `workspace create` during bootstrap' \
      "called through ${HERDR_BIN}: $(herdr_error_detail workspace create) — nothing was provisioned."
    return 0
  }
  # Response carries the new workspace, tab, and root pane
  # (src/cli/workspace.rs:96-100 -> workspace_create envelope).
  pane=$(printf '%s' "$created" | jq -r '((.result // .).root_pane.pane_id) // empty')
  if [[ -z $pane ]]; then
    page 'bootstrap workspace was created but its root pane id could not be read' \
      "workspace create answered without a root_pane.pane_id: $(printf '%s' "$created" | head -c 300)"
    return 0
  fi
  # Marker before the start attempt: bootstrap is one attempt, ever. A failed
  # start pages and a human decides; retrying provisioning on every server
  # start is how duplicate fleets happen.
  printf '%s\n' "$BOOTSTRAP_RESUME -> $pane $(date -u +%FT%TZ)" >"$marker" 2>/dev/null ||
    log "could not write $marker; a later zero-candidate state may re-provision"
  decide "bootstrap: provisioning fleet in new pane $pane"
  start_fleet "$pane" "$BOOTSTRAP_RESUME" bootstrap
  return 0
}

# Decide what a claim on the fleet name means. Returns 0 when the claim proved to
# be a leftover that Herdr has since released, so the caller can recover the pane
# normally; returns 1 when this run is over — the fleet is provably alive, or the
# state was paged.
#
# This is the difference between "a pane says fleet" and "omp is running".
# `agent start` submits omp into the pane's existing shell
# (src/app/agents.rs:193-218), so an exiting omp leaves the shell — and with it
# the pane, its `shell_pid`, and for a while its agent name — completely intact.
assess_claims() {
  local claims=$1 pane label claim_ref probe verdict panes_seen=''
  local seen_pane='' seen_ref='' seen_count=0
  WITNESS_PANE=''
  WITNESS_REF=''

  # The name alone decides nothing. The foreground job does: only a non-shell
  # process holding the terminal proves something is running in that pane, and
  # only Herdr's own agent label proves the something is the agent — for a
  # full-lifecycle integration such as omp that label is reported exactly while
  # the agent process is currently detected (src/terminal/state.rs:1691-1709,
  # src/detect/mod.rs:283-293).
  while IFS="$FIELD_SEP" read -r pane label claim_ref; do
    [[ -z $pane ]] && continue
    probe=$(pane_process_info "$pane") || {
      page "agent '$AGENT_NAME' is claimed by pane $pane, which has no live terminal" \
        'Herdr restored the pane with a deferred resume plan and a headless server never runs it (src/app/agent_resume.rs:78-82); `agent start` cannot target a pane that already claims the name. Attach a client once, or set session.resume_agents_on_restore = false in the Herdr config so restored panes come back as plain shells this plugin can drive.'
      return 1
    }
    verdict=$(foreground_verdict "$probe")
    case $verdict in
      alive)
        if [[ -n $label ]]; then
          # The one moment this plugin knows the fleet's identity first-hand.
          remember_identity "$pane" "${claim_ref:-}"
          # Alive here means "a process holds the pane", not "the loop is
          # working" — see the stall-marker note above for why the wedge case
          # belongs to the daemon and not to this hook.
          decide "ok: agent '$AGENT_NAME' is live in pane $pane (herdr detects $label) — nothing to do"
          return 1
        fi
        page "pane $pane claims '$AGENT_NAME' and something is running in it, but Herdr detects no agent there" \
          'a non-shell process holds the terminal, so this is not an exited fleet session, and starting another omp into that pane would collide with it.'
        return 1
        ;;
      unknown)
        page "could not read the foreground job of pane $pane, which claims '$AGENT_NAME'" \
          'Herdr reported no foreground processes, so whether omp is still running there is unknown; refusing to start a second omp into a pane that may already have one.'
        return 1
        ;;
      *)
        # Shell prompt: whatever ran here has exited, label or no label.
        panes_seen="$panes_seen $pane"
        seen_count=$((seen_count + 1))
        seen_pane=$pane
        seen_ref=${claim_ref:-}
        ;;
    esac
  done <<<"$claims"

  # Every claiming pane is sitting at a shell prompt: omp exited and its shell
  # survived. Herdr's own detector clears the name a beat later
  # (src/pane.rs:786-788 -> src/terminal/state.rs:302,540-541), so re-read once
  # instead of turning that window into a page.
  if (( RECHECK_SECONDS > 0 )); then
    log "omp is gone from pane(s)$panes_seen; waiting ${RECHECK_SECONDS}s for Herdr to release the name"
    sleep "$RECHECK_SECONDS"
  fi
  local agents_after claims_after
  agents_after=$(herdr_json agent list) || {
    page 'the Herdr API did not answer `agent list`' \
      "called through ${HERDR_BIN}: $(herdr_error_detail agent list) — re-reading a stale claim on '$AGENT_NAME'."
    return 1
  }
  claims_after=$(live_name_claims "$agents_after" "$AGENT_NAME")
  if [[ -z $claims_after ]]; then
    # This run watched the fleet's own claim disappear, so it is the most
    # reliable witness of who the fleet was — Herdr's next session save has
    # already dropped the name from the snapshot (src/persist/snapshot.rs:329-339).
    if (( seen_count == 1 )); then
      WITNESS_PANE=$seen_pane
      WITNESS_REF=$seen_ref
      remember_identity "$seen_pane" "$seen_ref"
    fi
    decide "found: omp exited in pane(s)$panes_seen and Herdr released the name '$AGENT_NAME'"
    return 0
  fi
  page "omp is gone from pane(s)$panes_seen but Herdr still holds the name '$AGENT_NAME'" \
    "the pane is at a shell prompt with no agent process, yet the name is still attached, so \`agent start\` would be refused with agent_name_taken (src/app/agents.rs:161-167,398-409) and \`agent rename --clear\` with agent_not_found (src/app/agents.rs:125-127,330-333). Herdr releases the name when its detector observes the exit; if this persists, restart the Herdr server (with session.resume_agents_on_restore = false the pane returns as a plain shell this plugin recovers on its own)."
  return 1
}

# Who is the fleet, before a single Herdr call. Sets:
#   IDENT_STATUS  ok | none | ambiguous | conflict
#   IDENT_PANE    public pane id the fleet should be in ('' when underivable)
#   IDENT_REF     omp session ref to resume
#   IDENT_KIND    ref kind from the snapshot, when known
#   IDENT_ORIGIN  where the answer came from, for the log and for pages
#   IDENT_CWD     saved cwd of the matched pane, when known
#   IDENT_DETAIL  page detail for ambiguous / conflict
#
# Order: a saved pane still carrying the name, else a saved pane that lost its
# name but sits at FLEET_CWD, else what this plugin last remembered. Two sources
# that name different panes is a conflict, never a coin toss.
resolve_identity() {
  local session_file=$1
  IDENT_STATUS=none
  IDENT_PANE=''
  IDENT_REF=''
  IDENT_KIND=''
  IDENT_ORIGIN=''
  IDENT_CWD=''
  IDENT_DETAIL=''

  local saved='' line rows_named='' rows_orphan='' chosen='' tier='' count
  if [[ -f $session_file ]]; then
    saved=$(saved_fleet_panes "$session_file" "$AGENT_NAME" "$FLEET_CWD")
  fi
  while IFS= read -r line; do
    [[ -z $line ]] && continue
    case $line in
      named"$FIELD_SEP"*) rows_named="${rows_named:+$rows_named$'\n'}$line" ;;
      orphan"$FIELD_SEP"*) rows_orphan="${rows_orphan:+$rows_orphan$'\n'}$line" ;;
    esac
  done <<<"$saved"

  if [[ -n $rows_named ]]; then
    chosen=$rows_named
    tier=named
  elif [[ -n $rows_orphan ]]; then
    chosen=$rows_orphan
    tier=orphan
  fi

  local remembered='' rpane='' rref=''
  if remembered=$(read_identity); then
    IFS="$FIELD_SEP" read -r rpane rref <<<"$remembered"
  fi

  count=$(line_count "$chosen")
  if (( count > 1 )); then
    IDENT_STATUS=ambiguous
    IDENT_DETAIL="$count saved panes match the fleet ($tier tier) in $session_file: $(printf '%s' "$chosen" | cut -d"$FIELD_SEP" -f2,3,6 | tr '\n' ';')"
    return 0
  fi
  if (( count == 1 )); then
    local ws_id pane_key public_number
    IFS="$FIELD_SEP" read -r tier ws_id pane_key public_number IDENT_KIND IDENT_REF IDENT_CWD <<<"$chosen"
    if [[ -n $ws_id && -n $public_number ]]; then
      IDENT_PANE="$ws_id:p$(encode_public_number "$public_number")"
    fi
    IDENT_ORIGIN="$session_file ($tier)"
    IDENT_STATUS=ok
    if [[ -n $rpane && -n $IDENT_PANE && $rpane != "$IDENT_PANE" ]]; then
      IDENT_STATUS=conflict
      IDENT_DETAIL="$session_file points at pane $IDENT_PANE (session $IDENT_REF) while $(identity_path) remembers pane $rpane (session $rref); refusing to pick one."
    elif [[ -z $IDENT_PANE && -n $rpane ]]; then
      IDENT_PANE=$rpane
      log "no public pane number saved for the fleet; using the remembered pane $rpane"
    fi
    return 0
  fi
  if [[ -n $rpane ]]; then
    IDENT_PANE=$rpane
    IDENT_REF=$rref
    IDENT_ORIGIN=$(identity_path)
    IDENT_STATUS=ok
  fi
  return 0
}

run_recovery() {
  load_config
  SESSION_NAME=$(current_session)

  # Wrong server, nothing to do — and nothing to say beyond one log line. An
  # unrelated session's hooks must never page about the fleet, consume its
  # bootstrap marker, or start an agent in the wrong pane namespace.
  if [[ -n $TARGET_SESSION && $SESSION_NAME != "$TARGET_SESSION" ]]; then
    decide "skip: session '$SESSION_NAME' is not the fleet session '$TARGET_SESSION'"
    return 0
  fi

  if ! command -v jq >/dev/null 2>&1; then
    # Paging still works without jq for the toast; say so plainly either way.
    page 'jq is not installed on this host' \
      'herdr-conductor reads Herdr session state and CLI responses with jq; install jq and re-run the startup hook.'
    return 0
  fi

  local session_file
  session_file=$(session_json_path)
  resolve_identity "$session_file"

  # Event entry point: reject other panes' events before spending a single Herdr
  # round trip. With no resolvable fleet identity there is no evidence the event
  # was about the fleet, so an event is not the place to page about it — the next
  # startup hook is.
  if [[ -n ${HERDR_PLUGIN_EVENT_JSON:-} ]]; then
    local exited
    exited=$(event_pane_id "$HERDR_PLUGIN_EVENT_JSON")
    if [[ -z $IDENT_PANE ]]; then
      decide "skip: ${HERDR_PLUGIN_EVENT:-event} for pane ${exited:-<unparsed>} — no single fleet pane to compare against"
      return 0
    fi
    if [[ -n $exited && $exited != "$IDENT_PANE" ]]; then
      decide "skip: ${HERDR_PLUGIN_EVENT:-event} pane $exited is not the fleet pane ($IDENT_PANE)"
      return 0
    fi
  fi

  local agents claims
  agents=$(herdr_json agent list) || {
    page 'the Herdr API did not answer `agent list`' \
      "called through ${HERDR_BIN}: $(herdr_error_detail agent list) — fleet state unknown, nothing was started."
    return 0
  }
  claims=$(live_name_claims "$agents" "$AGENT_NAME")
  if [[ -n $claims ]]; then
    # Returns non-zero when the run is finished (alive, or paged); zero when the
    # claim was a leftover Herdr has since released, and the pane can be
    # recovered like any other.
    assess_claims "$claims" || return 0
  fi

  # A run that just watched the fleet's own claim disappear is a first-hand
  # witness, and a fresher one than a debounced snapshot that has already dropped
  # the name (src/persist/snapshot.rs:329-339).
  if [[ -n ${WITNESS_PANE:-} ]]; then
    if [[ $IDENT_STATUS != ok ]]; then
      IDENT_PANE=$WITNESS_PANE
      [[ -n ${WITNESS_REF:-} ]] && IDENT_REF=$WITNESS_REF
      IDENT_KIND=''
      IDENT_ORIGIN='the agent release this run witnessed'
      IDENT_STATUS=ok
    elif [[ -n $IDENT_PANE && $IDENT_PANE != "$WITNESS_PANE" ]]; then
      IDENT_STATUS=conflict
      IDENT_DETAIL="$IDENT_ORIGIN points at pane $IDENT_PANE while the released claim this run saw was in pane $WITNESS_PANE; refusing to pick one."
    elif [[ -n ${WITNESS_REF:-} ]]; then
      IDENT_REF=$WITNESS_REF
      IDENT_KIND=''
    fi
  fi

  case $IDENT_STATUS in
    ambiguous)
      page "the fleet's saved identity is ambiguous" "$IDENT_DETAIL"
      return 0
      ;;
    conflict)
      page "two different panes claim to be the fleet" "$IDENT_DETAIL"
      return 0
      ;;
    none)
      # First provisioning: an explicit BOOTSTRAP_RESUME may claim this state
      # exactly once; otherwise no identity is a page, never a guess.
      bootstrap_fleet && return 0
      page "no fleet identity to recover for agent '$AGENT_NAME'" \
        "nothing in $session_file has an omp agent_session named '$AGENT_NAME' or saved at $FLEET_CWD, and $(identity_path) remembers nothing."
      return 0
      ;;
  esac
  if [[ -z $IDENT_REF ]]; then
    page "the fleet's pane is known ($IDENT_PANE) but no omp session ref is" \
      "resolved from $IDENT_ORIGIN"
    return 0
  fi
  if [[ -n $IDENT_CWD && $IDENT_CWD != "$FLEET_CWD" ]]; then
    log "saved fleet pane cwd is $IDENT_CWD, configured FLEET_CWD is $FLEET_CWD"
  fi
  log "fleet identity from $IDENT_ORIGIN: pane ${IDENT_PANE:-<unknown>}, session $IDENT_REF"

  local panes candidates candidate_count pane live_ref probe verdict
  panes=$(herdr_json pane list) || {
    page 'the Herdr API did not answer `pane list`' \
      "called through ${HERDR_BIN}: $(herdr_error_detail pane list) — while resolving the pane for session $IDENT_REF."
    return 0
  }
  candidates=$(live_resume_candidates "$panes" "$IDENT_PANE" "$IDENT_REF")
  candidate_count=$(line_count "$candidates")
  if (( candidate_count == 0 )); then
    page "no live pane is the fleet's: neither pane ${IDENT_PANE:-<unknown>} nor omp session $IDENT_REF" \
      "identity from $IDENT_ORIGIN; expected that pane (saved cwd ${IDENT_CWD:-unknown}) to be present with no agent in it."
    return 0
  fi
  if (( candidate_count > 1 )); then
    page "$candidate_count live panes answer to the fleet's identity (pane ${IDENT_PANE:-<unknown>} / omp session $IDENT_REF)" \
      "candidates: $(printf '%s' "$candidates" | cut -d"$FIELD_SEP" -f1 | tr '\n' ' ') — refusing to guess which one is the fleet."
    return 0
  fi

  IFS="$FIELD_SEP" read -r pane live_ref <<<"$candidates"
  # The pane's own session ref wins: omp reports a new one after a /clear or a
  # compaction, and session.json is only as fresh as its last save.
  if [[ -n $live_ref && $live_ref != "$IDENT_REF" ]]; then
    log "pane $pane reports omp session $live_ref; $IDENT_ORIGIN still has $IDENT_REF"
    IDENT_REF=$live_ref
    IDENT_KIND=''
  fi

  probe=$(pane_process_info "$pane") || {
    page "pane $pane is the fleet's but has no live terminal" \
      'the pane was restored with a deferred resume plan; `agent start` needs a running shell in the pane (src/app/agents.rs:186-191).'
    return 0
  }
  verdict=$(foreground_verdict "$probe")
  if [[ $verdict != shell ]]; then
    page "pane $pane is the fleet's but is not at a shell prompt ($verdict)" \
      'something already holds that terminal, and `agent start` submits omp into the pane shell (src/app/agents.rs:190-196,213-217) — starting one now would collide with whatever is running.'
    return 0
  fi

  start_fleet "$pane" "$IDENT_REF" "${IDENT_KIND:-unknown}"
}

main() {
  load_config
  SESSION_NAME=$(current_session)
  if ! acquire_lock; then
    decide 'skip: another recovery run holds the lock'
    return 0
  fi
  run_recovery
  release_lock
  return 0
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main
  exit 0
fi
