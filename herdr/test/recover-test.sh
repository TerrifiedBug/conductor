#!/usr/bin/env bash
#
# herdr-conductor · offline tests for bin/recover.sh
#
# No bats, no network, no Herdr server. Every case drives the real script with
# RECOVER_DRY_RUN=1 and a stub `herdr` that replays fixture JSON, so what is
# under test is the decision the hook would take — not a mock of it.
#
# The fixtures are fabricated but field-accurate against the Herdr source they
# imitate:
#   session.json          src/persist/snapshot.rs:14-118 (+ LayoutSnapshot:127-136)
#   agent list response   src/api/schema/response.rs:107-109 + agents.rs:184-223
#   pane list response    src/api/schema/response.rs:120-122 + panes.rs:395-428
#   pane process-info     src/api/schema/response.rs:137-139 + panes.rs:437-448
#   pane.exited event     src/api/schema/events.rs:355-359,514-517
#
# Prints one line per case and exits non-zero if any of them fails.

set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(dirname "$here")
recover="$root/bin/recover.sh"

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  printf '      %s\n' "$2"
  failures=$((failures + 1))
}

check() { # <name> <expected substring> <actual>
  if [[ $3 == *"$2"* ]]; then
    pass "$1"
  else
    fail "$1" "expected to contain: $2"
    printf '      got: %s\n' "${3//$'\n'/ | }"
  fi
}

# --------------------------------------------------------------------------
# syntax
# --------------------------------------------------------------------------

syntax_errors=$(
  bash -n "$recover" 2>&1
  bash -n "$here/recover-test.sh" 2>&1
)
if [[ -z $syntax_errors ]]; then
  pass 'bash -n bin/recover.sh test/recover-test.sh'
else
  fail 'bash -n bin/recover.sh test/recover-test.sh' "$syntax_errors"
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/herdr-conductor-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# --------------------------------------------------------------------------
# stub herdr CLI
# --------------------------------------------------------------------------

cat >"$tmp/herdr" <<'STUB'
#!/usr/bin/env bash
# Fixture-emitting stand-in for the herdr binary. Reads $STUB_DIR, records any
# mutating call so a dry run can be proven inert, and mimics the real CLI's
# one-line JSON on stdout / error JSON on stderr (src/cli.rs:719-727).
set -uo pipefail
record() { printf '%s\n' "$*" >>"$STUB_DIR/calls"; }
emit() {
  if [[ -f "$STUB_DIR/$1" ]]; then
    cat "$STUB_DIR/$1"
  else
    printf '{"id":"cli:stub","error":{"code":"%s","message":"stub: no %s"}}\n' "${2:-not_found}" "$1" >&2
    exit 1
  fi
}
case "${1:-} ${2:-}" in
  "agent list")
    # A second `agent list` in one run is the stale-claim re-check: serve
    # agent-list.2.json when the case supplies one, so a release that lands
    # between the two reads can be exercised.
    calls=$(cat "$STUB_DIR/agent-list-calls" 2>/dev/null || printf '0')
    calls=$((calls + 1))
    printf '%s\n' "$calls" >"$STUB_DIR/agent-list-calls"
    if [[ $calls -gt 1 && -f "$STUB_DIR/agent-list.2.json" ]]; then
      emit agent-list.2.json
    else
      emit agent-list.json
    fi
    ;;
  "pane list") emit pane-list.json ;;
  "pane process-info")
    pane=''
    shift 2
    while [[ $# -gt 0 ]]; do
      case $1 in
        --pane)
          pane=${2:-}
          shift 2
          ;;
        *) shift ;;
      esac
    done
    emit "process-info-$pane.json" pane_not_found
    ;;
  "agent start")
    record "$*"
    printf '{"id":"cli:agent:start","result":{"type":"agent_started","agent":{},"argv":[]}}\n'
    ;;
  "notification show")
    record "$*"
    printf '{"id":"cli:notification:show","result":{"type":"ok"}}\n'
    ;;
  *)
    printf 'stub: unsupported command: %s\n' "$*" >&2
    exit 2
    ;;
esac
STUB
chmod +x "$tmp/herdr"

# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------

REF='/root/.omp/agent/sessions/fleet-2026-08-06T09-15-02.jsonl'
OTHER_REF='/root/.omp/agent/sessions/scratch-2026-08-01T11-00-00.jsonl'

newcase() { # <name> -> case dir
  local dir="$tmp/$1"
  mkdir -p "$dir/config" "$dir/state" "$dir/session"
  cat >"$dir/config/config.env" <<EOF
AGENT_NAME=fleet
FLEET_CWD=/root/fleet
TELEGRAM_ENV=$dir/telegram.env
ACCESS_JSON=$dir/access.json
EOF
  printf '%s' "$dir"
}

# One saved workspace whose single pane is the fleet: public pane number 1 in
# workspace w1, so the derived public pane id is w1:p1
# (src/workspace.rs:106-118,137-139).
saved_session_json() { # <agent_name> <session_value>
  cat <<EOF
{
  "version": 3,
  "workspaces": [
    {
      "id": "w1",
      "custom_name": "fleet",
      "identity_cwd": "/root/fleet",
      "public_pane_numbers": { "1": 1 },
      "next_public_pane_number": 2,
      "public_tab_numbers": [1],
      "next_public_tab_number": 2,
      "tabs": [
        {
          "custom_name": null,
          "layout": { "Pane": 1 },
          "panes": {
            "1": {
              "cwd": "/root/fleet",
              "agent_name": "$1",
              "managed_agent_kind": "omp",
              "agent_session": {
                "source": "herdr:omp",
                "agent": "omp",
                "kind": "path",
                "value": "$2"
              }
            }
          },
          "zoomed": false,
          "focused": 1,
          "root_pane": 1
        }
      ],
      "active_tab": 0
    }
  ],
  "active": 0,
  "selected": 0,
  "sidebar_width": 28,
  "sidebar_section_split": 0.5,
  "collapsed_space_keys": []
}
EOF
}

# The same pane one session save after omp exited: `agent_name` and
# `managed_agent_kind` are gone because they are written straight from the
# terminal (src/persist/snapshot.rs:329-339) while `agent_session` survives,
# being taken from the hook authority or the persisted session (:341-361) —
# neither of which clear_agent_name() touches (src/terminal/state.rs:1924-1928).
released_session_json() { # <session_value> <saved_cwd>
  cat <<EOF
{
  "version": 3,
  "workspaces": [
    {
      "id": "w1",
      "custom_name": "fleet",
      "identity_cwd": "$2",
      "public_pane_numbers": { "1": 1 },
      "next_public_pane_number": 2,
      "public_tab_numbers": [1],
      "next_public_tab_number": 2,
      "tabs": [
        {
          "custom_name": null,
          "layout": { "Pane": 1 },
          "panes": {
            "1": {
              "cwd": "$2",
              "agent_session": {
                "source": "herdr:omp",
                "agent": "omp",
                "kind": "path",
                "value": "$1"
              }
            }
          },
          "zoomed": false,
          "focused": 1,
          "root_pane": 1
        }
      ],
      "active_tab": 0
    }
  ],
  "active": 0,
  "selected": 0
}
EOF
}

empty_session_json() {
  printf '{"version":3,"workspaces":[],"active":null,"selected":0}\n'
}

# The plugin's own durable identity file: pane and session ref, unit-separated.
# State file names are suffixed with the Herdr session because the plugin state
# dir is global to the user (src/plugin_paths.rs:21-25); these cases all run in
# session 'fleet'.
write_identity() { # <case dir> <pane_id> <ref>
  printf '%s\037%s\n' "$2" "$3" >"$1/state/identity.fleet"
}

# Two saved workspaces both claiming the same agent name — the ambiguity a
# recovery must never resolve on its own.
ambiguous_session_json() {
  cat <<EOF
{
  "version": 3,
  "workspaces": [
    {
      "id": "w1",
      "custom_name": "fleet",
      "identity_cwd": "/root/fleet",
      "public_pane_numbers": { "1": 1 },
      "next_public_pane_number": 2,
      "public_tab_numbers": [1],
      "next_public_tab_number": 2,
      "tabs": [
        {
          "custom_name": null,
          "layout": { "Pane": 1 },
          "panes": {
            "1": {
              "cwd": "/root/fleet",
              "agent_name": "fleet",
              "managed_agent_kind": "omp",
              "agent_session": {
                "source": "herdr:omp",
                "agent": "omp",
                "kind": "path",
                "value": "$REF"
              }
            }
          },
          "zoomed": false,
          "focused": 1,
          "root_pane": 1
        }
      ],
      "active_tab": 0
    },
    {
      "id": "w2",
      "custom_name": "fleet-clone",
      "identity_cwd": "/root/fleet",
      "public_pane_numbers": { "1": 1 },
      "next_public_pane_number": 2,
      "public_tab_numbers": [1],
      "next_public_tab_number": 2,
      "tabs": [
        {
          "custom_name": null,
          "layout": { "Pane": 1 },
          "panes": {
            "1": {
              "cwd": "/root/fleet",
              "agent_name": "fleet",
              "managed_agent_kind": "omp",
              "agent_session": {
                "source": "herdr:omp",
                "agent": "omp",
                "kind": "path",
                "value": "$OTHER_REF"
              }
            }
          },
          "zoomed": false,
          "focused": 1,
          "root_pane": 1
        }
      ],
      "active_tab": 0
    }
  ],
  "active": 0,
  "selected": 0
}
EOF
}

empty_agent_list() {
  printf '{"id":"cli:agent:list","result":{"type":"agent_list","agents":[]}}\n'
}

live_agent_list() { # <name> <pane_id> <session_value>
  cat <<EOF
{"id":"cli:agent:list","result":{"type":"agent_list","agents":[{"terminal_id":"term-7","name":"$1","agent":"omp","title":"omp","display_agent":"omp","agent_status":"idle","agent_session":{"source":"herdr:omp","agent":"omp","kind":"path","value":"$3"},"workspace_id":"w1","tab_id":"w1:t1","pane_id":"$2","focused":true,"interactive_ready":true,"state_change_seq":41,"cwd":"/root/fleet","revision":128}]}}
EOF
}

pane_list_json() { # <panes-json-array-body>
  printf '{"id":"cli:pane:list","result":{"type":"pane_list","panes":[%s]}}\n' "$1"
}

# A restored pane with the persisted omp session and no agent in it: exactly what
# `agent start` can be pointed at (src/persist/restore.rs:637-639,
# src/app/creation.rs:518-540).
free_pane() { # <pane_id> <session_value>
  cat <<EOF
{"pane_id":"$1","terminal_id":"term-shell","workspace_id":"w1","tab_id":"w1:t1","focused":true,"cwd":"/root/fleet","foreground_cwd":"/root/fleet","agent_status":"unknown","agent_session":{"source":"herdr:omp","agent":"omp","kind":"path","value":"$2"},"revision":4}
EOF
}

busy_pane() { # <pane_id>
  cat <<EOF
{"pane_id":"$1","terminal_id":"term-other","workspace_id":"w1","tab_id":"w1:t1","focused":false,"cwd":"/root","agent":"claude","display_agent":"claude","agent_status":"working","revision":9}
EOF
}

process_info_json() { # <pane_id>
  cat <<EOF
{"id":"cli:pane:process_info","result":{"type":"pane_process_info","process_info":{"pane_id":"$1","shell_pid":4242,"foreground_process_group_id":4242,"tty":"/dev/pts/3","foreground_processes":[{"pid":4242,"name":"bash","argv0":"-bash","cwd":"/root/fleet"}]}}}
EOF
}

pane_exited_event() { # <pane_id>
  printf '{"event":"pane_exited","data":{"type":"pane_exited","pane_id":"%s","workspace_id":"w1"}}\n' "$1"
}

# The release event Herdr emits when an agent process goes away while its pane
# lives on: `released` is set and the event fires unconditionally for a release
# (src/app/api.rs:586-597, payload at src/api/schema/events.rs:518-527).
agent_released_event() { # <pane_id>
  printf '{"event":"pane_agent_detected","data":{"type":"pane_agent_detected","pane_id":"%s","workspace_id":"w1","released":true,"final_status":"idle"}}\n' "$1"
}

# A pane whose saved agent name outlived its process: `agent list` still reports
# the entry, but with no `agent` field, because the label is only serialized
# while Herdr detects the process (src/api/schema/agents.rs:188-189 +
# src/terminal/state.rs:1691-1709).
stale_agent_list() { # <name> <pane_id> <session_value>
  cat <<EOF
{"id":"cli:agent:list","result":{"type":"agent_list","agents":[{"terminal_id":"term-7","name":"$1","agent_status":"idle","agent_session":{"source":"herdr:omp","agent":"omp","kind":"path","value":"$3"},"workspace_id":"w1","tab_id":"w1:t1","pane_id":"$2","focused":true,"interactive_ready":true,"state_change_seq":41,"cwd":"/root/fleet","revision":128}]}}
EOF
}

# omp holding the terminal: the shell is the pane's child, the foreground job is
# the agent (src/app/api/panes.rs:207-223).
process_info_omp() { # <pane_id>
  cat <<EOF
{"id":"cli:pane:process_info","result":{"type":"pane_process_info","process_info":{"pane_id":"$1","shell_pid":4242,"foreground_process_group_id":5150,"tty":"/dev/pts/3","foreground_processes":[{"pid":5150,"name":"bun","argv0":"bun","argv":["bun","omp"],"cwd":"/root/fleet"},{"pid":5151,"name":"omp","cwd":"/root/fleet"}]}}}
EOF
}

# A live pane whose foreground job could not be read at all: absence of evidence,
# never evidence of absence (foreground_processes is skipped when empty,
# src/api/schema/panes.rs:446-447).
process_info_unreadable() { # <pane_id>
  cat <<EOF
{"id":"cli:pane:process_info","result":{"type":"pane_process_info","process_info":{"pane_id":"$1","shell_pid":4242}}}
EOF
}

# --------------------------------------------------------------------------
# runner
# --------------------------------------------------------------------------

run_recover() { # <case dir> [event] [event json] [session name, '' to unset]
  (
    cd "$root" || exit 1
    RECOVER_DRY_RUN=1 \
      RECOVER_RECHECK_SECONDS=0 \
      HERDR_BIN_PATH="$tmp/herdr" \
      STUB_DIR="$1" \
      HERDR_PLUGIN_ID=herdr-conductor \
      HERDR_PLUGIN_ROOT="$root" \
      HERDR_PLUGIN_CONFIG_DIR="$1/config" \
      HERDR_PLUGIN_STATE_DIR="$1/state" \
      HERDR_SOCKET_PATH="$1/session/herdr.sock" \
      HERDR_PLUGIN_EVENT="${2:-startup}" \
      HERDR_PLUGIN_EVENT_JSON="${3:-}" \
      HERDR_SESSION="${4-fleet}" \
      bash "$recover" 2>"$1/stderr"
  )
}

assert_inert() { # <name> <case dir>
  if [[ -f "$2/calls" ]]; then
    fail "$1 (no mutations in dry run)" "stub recorded: $(tr '\n' ';' <"$2/calls")"
  fi
}

# --------------------------------------------------------------------------
# case 1 — a live fleet agent short-circuits: Herdr reports the omp label and
# omp holds the pane's foreground job
# --------------------------------------------------------------------------

d=$(newcase live-agent)
saved_session_json fleet "$REF" >"$d/session/session.json"
live_agent_list fleet 'w1:p1' "$REF" >"$d/agent-list.json"
process_info_omp 'w1:p1' >"$d/process-info-w1:p1.json"
out=$(run_recover "$d")
check 'live agent short-circuits' "ok: agent 'fleet' is live in pane w1:p1" "$out"
assert_inert 'live agent short-circuits' "$d"

# --------------------------------------------------------------------------
# case 1b — a stall marker in the fleet cwd does NOT change this hook's
# verdict. The wedge case belongs to the daemon (omp/src/daemon.ts,
# watchOrchestrator): this hook only runs on lifecycle events, so it could
# never fire during a wedge, while it WOULD fire on the operator's own
# recovery — the marker outlives a restart until the new session consumes a
# tick. Pinned so the tempting check is not re-added without the process-start
# comparison that would make it safe.
# --------------------------------------------------------------------------

d=$(newcase live-agent-stalled)
mkdir -p "$d/fleet-cwd"
printf '2026-08-07T06:27:55.123Z 2 ticks queued unconsumed\n' >"$d/fleet-cwd/.conductor-stalled"
sed -i.bak "s|^FLEET_CWD=.*|FLEET_CWD=$d/fleet-cwd|" "$d/config/config.env"
saved_session_json fleet "$REF" >"$d/session/session.json"
live_agent_list fleet 'w1:p1' "$REF" >"$d/agent-list.json"
process_info_omp 'w1:p1' >"$d/process-info-w1:p1.json"
out=$(run_recover "$d")
check 'a stall marker does not make this hook page about a live agent' \
  "ok: agent 'fleet' is live in pane w1:p1" "$out"
assert_inert 'a stall marker does not make this hook page about a live agent' "$d"

# --------------------------------------------------------------------------
# case 2 — exactly one saved pane and one live pane: a resume plan
# --------------------------------------------------------------------------

d=$(newcase one-match)
saved_session_json fleet "$REF" >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
pane_list_json "$(free_pane 'w1:p1' "$REF"),$(busy_pane 'w1:p2')" >"$d/pane-list.json"
process_info_json 'w1:p1' >"$d/process-info-w1:p1.json"
out=$(run_recover "$d")
check 'exactly one match yields a resume plan' \
  "plan: $tmp/herdr agent start 'fleet' --kind omp --pane w1:p1 -- --resume=$REF" "$out"
assert_inert 'exactly one match yields a resume plan' "$d"

# --------------------------------------------------------------------------
# case 3 — nothing saved for this agent name: page
# --------------------------------------------------------------------------

d=$(newcase zero-match)
saved_session_json worker "$OTHER_REF" >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
pane_list_json "$(busy_pane 'w1:p2')" >"$d/pane-list.json"
out=$(run_recover "$d")
check 'zero saved matches pages' "page: no fleet identity to recover for agent 'fleet'" "$out"
assert_inert 'zero saved matches pages' "$d"

# --------------------------------------------------------------------------
# case 4 — two saved panes claim the name: page, never guess
# --------------------------------------------------------------------------

d=$(newcase two-match)
ambiguous_session_json >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
pane_list_json "$(free_pane 'w1:p1' "$REF")" >"$d/pane-list.json"
process_info_json 'w1:p1' >"$d/process-info-w1:p1.json"
out=$(run_recover "$d")
check 'two saved matches page instead of guessing' \
  "page: the fleet's saved identity is ambiguous" "$out"
assert_inert 'two saved matches page instead of guessing' "$d"

# --------------------------------------------------------------------------
# case 5 — pane.exited for someone else's pane is filtered before any API call
# --------------------------------------------------------------------------

d=$(newcase event-filter)
saved_session_json fleet "$REF" >"$d/session/session.json"
out=$(run_recover "$d" 'pane.exited' "$(pane_exited_event 'w1:pT')")
check 'pane.exited for another pane is skipped' \
  'skip: pane.exited pane w1:pT is not the fleet pane (w1:p1)' "$out"
assert_inert 'pane.exited for another pane is skipped' "$d"
# No agent-list.json / pane-list.json exist in this case dir at all: had the
# filter fallen through, the stub would have failed the run.

# --------------------------------------------------------------------------
# case 6 — pane.exited for the fleet pane runs the full flow
# --------------------------------------------------------------------------

d=$(newcase event-fleet-pane)
saved_session_json fleet "$REF" >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
pane_list_json "$(free_pane 'w1:p1' "$REF")" >"$d/pane-list.json"
process_info_json 'w1:p1' >"$d/process-info-w1:p1.json"
out=$(run_recover "$d" 'pane.exited' "$(pane_exited_event 'w1:p1')")
check 'pane.exited for the fleet pane recovers' \
  "plan: $tmp/herdr agent start 'fleet' --kind omp --pane w1:p1 -- --resume=$REF" "$out"
assert_inert 'pane.exited for the fleet pane recovers' "$d"

# --------------------------------------------------------------------------
# case 7 — the name is claimed by a pane with no live terminal (the headless
# deferred-resume trap): page, because `agent start` cannot target it
# --------------------------------------------------------------------------

d=$(newcase claimed-but-dead)
saved_session_json fleet "$REF" >"$d/session/session.json"
live_agent_list fleet 'w1:p1' "$REF" >"$d/agent-list.json"
# deliberately no process-info fixture: the stub answers pane_not_found, exactly
# as the server does for a pane with no runtime (src/app/api/panes.rs:198-207)
out=$(run_recover "$d")
check 'claimed name with no live terminal pages' \
  "page: agent 'fleet' is claimed by pane w1:p1, which has no live terminal" "$out"
assert_inert 'claimed name with no live terminal pages' "$d"

# --------------------------------------------------------------------------
# case 8 — the saved session is nowhere in the live pane list: page
# --------------------------------------------------------------------------

d=$(newcase pane-missing)
saved_session_json fleet "$REF" >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
pane_list_json "$(busy_pane 'w1:p2')" >"$d/pane-list.json"
out=$(run_recover "$d")
check 'missing live pane pages' "page: no live pane is the fleet's" "$out"
assert_inert 'missing live pane pages' "$d"

# --------------------------------------------------------------------------
# case 9 — two live panes carry the same session ref: page
# --------------------------------------------------------------------------

d=$(newcase two-live-panes)
saved_session_json fleet "$REF" >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
pane_list_json "$(free_pane 'w1:p1' "$REF"),$(free_pane 'w1:p3' "$REF")" >"$d/pane-list.json"
process_info_json 'w1:p1' >"$d/process-info-w1:p1.json"
out=$(run_recover "$d")
check 'two live candidates page instead of guessing' \
  "page: 2 live panes answer to the fleet's identity" "$out"
assert_inert 'two live candidates page instead of guessing' "$d"

# --------------------------------------------------------------------------
# The crash path `pane.exited` cannot see: `agent start` submits omp into the
# pane's shell (src/app/agents.rs:193-218), so an exiting omp leaves the shell,
# the pane, and its `shell_pid` alive. Liveness has to look at the foreground
# job, not at the pane.
# --------------------------------------------------------------------------

# case 9a — Herdr reports the omp label but the pane is back at a shell prompt:
# the label lost its process, so this is a leftover claim, not a live fleet
d=$(newcase label-without-process)
saved_session_json fleet "$REF" >"$d/session/session.json"
live_agent_list fleet 'w1:p1' "$REF" >"$d/agent-list.json"
empty_agent_list >"$d/agent-list.2.json"
process_info_json 'w1:p1' >"$d/process-info-w1:p1.json"
pane_list_json "$(free_pane 'w1:p1' "$REF")" >"$d/pane-list.json"
out=$(run_recover "$d")
check 'a label with a shell foreground is not treated as alive' \
  "plan: $tmp/herdr agent start 'fleet' --kind omp --pane w1:p1 -- --resume=$REF" "$out"
assert_inert 'a label with a shell foreground is not treated as alive' "$d"

# case 9b — omp exited, its shell survived, Herdr released the name between the
# two reads: recover into that same pane, with the ref the live pane reports
NEW_REF='/root/.omp/agent/sessions/fleet-2026-08-06T18-40-11.jsonl'
d=$(newcase omp-exited-shell-survives)
saved_session_json fleet "$REF" >"$d/session/session.json"
stale_agent_list fleet 'w1:p1' "$REF" >"$d/agent-list.json"
empty_agent_list >"$d/agent-list.2.json"
process_info_json 'w1:p1' >"$d/process-info-w1:p1.json"
pane_list_json "$(free_pane 'w1:p1' "$NEW_REF")" >"$d/pane-list.json"
out=$(run_recover "$d")
check 'a dead omp with a surviving shell is resumed in place' \
  "plan: $tmp/herdr agent start 'fleet' --kind omp --pane w1:p1 -- --resume=$NEW_REF" "$out"
assert_inert 'a dead omp with a surviving shell is resumed in place' "$d"

# case 9c — same, but Herdr never releases the name: page, because `agent start`
# would be refused with agent_name_taken
d=$(newcase omp-exited-name-stuck)
saved_session_json fleet "$REF" >"$d/session/session.json"
stale_agent_list fleet 'w1:p1' "$REF" >"$d/agent-list.json"
process_info_json 'w1:p1' >"$d/process-info-w1:p1.json"
pane_list_json "$(free_pane 'w1:p1' "$REF")" >"$d/pane-list.json"
out=$(run_recover "$d")
check 'a stuck agent name pages instead of being guessed around' \
  "page: omp is gone from pane(s) w1:p1 but Herdr still holds the name 'fleet'" "$out"
assert_inert 'a stuck agent name pages instead of being guessed around' "$d"

# case 9d — the foreground job could not be read: ambiguity, never a second omp
d=$(newcase foreground-unreadable)
saved_session_json fleet "$REF" >"$d/session/session.json"
stale_agent_list fleet 'w1:p1' "$REF" >"$d/agent-list.json"
process_info_unreadable 'w1:p1' >"$d/process-info-w1:p1.json"
out=$(run_recover "$d")
check 'an unreadable foreground job pages' \
  'page: could not read the foreground job of pane w1:p1' "$out"
assert_inert 'an unreadable foreground job pages' "$d"

# case 9e — something non-shell runs in the pane but Herdr detects no agent:
# not an exited fleet, and not a pane to start omp into
d=$(newcase foreground-foreign)
saved_session_json fleet "$REF" >"$d/session/session.json"
stale_agent_list fleet 'w1:p1' "$REF" >"$d/agent-list.json"
process_info_omp 'w1:p1' >"$d/process-info-w1:p1.json"
out=$(run_recover "$d")
check 'a foreign foreground process pages' \
  "page: pane w1:p1 claims 'fleet' and something is running in it" "$out"
assert_inert 'a foreign foreground process pages' "$d"

# case 9f — a login shell (`-zsh`) is still a shell: Herdr strips the leading
# dash when it decides (src/platform/mod.rs:176-183,225-244)
d=$(newcase login-shell)
saved_session_json fleet "$REF" >"$d/session/session.json"
stale_agent_list fleet 'w1:p1' "$REF" >"$d/agent-list.json"
empty_agent_list >"$d/agent-list.2.json"
cat >"$d/process-info-w1:p1.json" <<'JSON'
{"id":"cli:pane:process_info","result":{"type":"pane_process_info","process_info":{"pane_id":"w1:p1","shell_pid":4242,"foreground_process_group_id":4242,"foreground_processes":[{"pid":4242,"name":"-zsh","argv0":"-zsh","cwd":"/root/fleet"}]}}}
JSON
pane_list_json "$(free_pane 'w1:p1' "$REF")" >"$d/pane-list.json"
out=$(run_recover "$d")
check 'a login shell counts as a shell' \
  "plan: $tmp/herdr agent start 'fleet' --kind omp --pane w1:p1 -- --resume=$REF" "$out"
assert_inert 'a login shell counts as a shell' "$d"

# case 9g — the release event for the fleet pane drives the same recovery, which
# is why `pane.agent_detected` is in the manifest: `pane.exited` never fires when
# only the agent inside the shell dies
d=$(newcase agent-released-event)
saved_session_json fleet "$REF" >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
pane_list_json "$(free_pane 'w1:p1' "$REF")" >"$d/pane-list.json"
process_info_json 'w1:p1' >"$d/process-info-w1:p1.json"
out=$(run_recover "$d" 'pane.agent_detected' "$(agent_released_event 'w1:p1')")
check 'a release event for the fleet pane recovers' \
  "plan: $tmp/herdr agent start 'fleet' --kind omp --pane w1:p1 -- --resume=$REF" "$out"
assert_inert 'a release event for the fleet pane recovers' "$d"

# case 9h — and a release in someone else's pane costs nothing
d=$(newcase agent-released-elsewhere)
saved_session_json fleet "$REF" >"$d/session/session.json"
out=$(run_recover "$d" 'pane.agent_detected' "$(agent_released_event 'w2:p4')")
check 'a release event elsewhere is skipped' \
  'skip: pane.agent_detected pane w2:p4 is not the fleet pane (w1:p1)' "$out"
assert_inert 'a release event elsewhere is skipped' "$d"

# --------------------------------------------------------------------------
# The release race: Herdr clears the pane's agent name and marks the session
# dirty, and the debounced save can land before this asynchronous hook runs. The
# snapshot then has the fleet's omp session but no name for it, so matching on
# the name alone loses the fleet exactly when it needs recovering.
# --------------------------------------------------------------------------

# case 10a — the snapshot lost the name; the pane's saved cwd identifies it
d=$(newcase release-race-orphan)
released_session_json "$REF" /root/fleet >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
pane_list_json "$(free_pane 'w1:p1' "$REF")" >"$d/pane-list.json"
process_info_json 'w1:p1' >"$d/process-info-w1:p1.json"
out=$(run_recover "$d" 'pane.agent_detected' "$(agent_released_event 'w1:p1')")
check 'a snapshot that lost the agent name still recovers' \
  "plan: $tmp/herdr agent start 'fleet' --kind omp --pane w1:p1 -- --resume=$REF" "$out"
assert_inert 'a snapshot that lost the agent name still recovers' "$d"

# case 10b — the release this run witnesses IS the identity: no name in the
# snapshot, nothing saved at all, and no identity file yet
d=$(newcase release-race-witness)
empty_session_json >"$d/session/session.json"
stale_agent_list fleet 'w1:p1' "$REF" >"$d/agent-list.json"
empty_agent_list >"$d/agent-list.2.json"
process_info_json 'w1:p1' >"$d/process-info-w1:p1.json"
pane_list_json "$(free_pane 'w1:p1' "$REF")" >"$d/pane-list.json"
out=$(run_recover "$d")
check 'the witnessed release carries the identity when the snapshot has none' \
  "plan: $tmp/herdr agent start 'fleet' --kind omp --pane w1:p1 -- --resume=$REF" "$out"
assert_inert 'the witnessed release carries the identity when the snapshot has none' "$d"

# case 10c — snapshot has nothing usable (its pane moved to another cwd, so not
# even the orphan tier matches): the remembered identity file recovers it
d=$(newcase identity-file-fallback)
released_session_json "$OTHER_REF" /srv/elsewhere >"$d/session/session.json"
write_identity "$d" 'w1:p1' "$REF"
empty_agent_list >"$d/agent-list.json"
pane_list_json "$(free_pane 'w1:p1' "$REF")" >"$d/pane-list.json"
process_info_json 'w1:p1' >"$d/process-info-w1:p1.json"
out=$(run_recover "$d")
check 'the remembered identity recovers a fleet the snapshot forgot' \
  "plan: $tmp/herdr agent start 'fleet' --kind omp --pane w1:p1 -- --resume=$REF" "$out"
assert_inert 'the remembered identity recovers a fleet the snapshot forgot' "$d"

# case 10d — the snapshot and the identity file name different panes: page
d=$(newcase identity-conflict)
saved_session_json fleet "$REF" >"$d/session/session.json"
write_identity "$d" 'w2:p7' "$OTHER_REF"
empty_agent_list >"$d/agent-list.json"
out=$(run_recover "$d")
check 'two panes claiming the fleet page instead of guessing' \
  'page: two different panes claim to be the fleet' "$out"
assert_inert 'two panes claiming the fleet page instead of guessing' "$d"

# --------------------------------------------------------------------------
# First provisioning (BOOTSTRAP_RESUME), including its guards
# --------------------------------------------------------------------------

# case 11a — nothing saved anywhere and an explicit ref: provision once
d=$(newcase bootstrap-first-run)
# A path-shaped ref must exist on disk before anything is provisioned
BOOT_REF="$d/fleet-session.jsonl"
: >"$BOOT_REF"
printf 'BOOTSTRAP_RESUME=%s\n' "$BOOT_REF" >>"$d/config/config.env"
empty_session_json >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
out=$(run_recover "$d")
check 'bootstrap provisions a fleet when nothing is saved' \
  "plan: bootstrap — $tmp/herdr workspace create --cwd /root/fleet --label fleet --no-focus, then agent start with --resume=$BOOT_REF" "$out"
assert_inert 'bootstrap provisions a fleet when nothing is saved' "$d"

# case 11b — a path-shaped ref that is not on disk is refused before any mutation
d=$(newcase bootstrap-missing-ref)
printf 'BOOTSTRAP_RESUME=%s\n' "$d/never-written.jsonl" >>"$d/config/config.env"
empty_session_json >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
out=$(run_recover "$d")
check 'a bootstrap ref that does not exist is refused' \
  "page: bootstrap ref $d/never-written.jsonl does not exist" "$out"
assert_inert 'a bootstrap ref that does not exist is refused' "$d"

# case 11c — the marker means bootstrap already ran: page, never provision twice
d=$(newcase bootstrap-already-ran)
printf 'BOOTSTRAP_RESUME=%s\n' "$REF" >>"$d/config/config.env"
empty_session_json >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
: >"$d/state/bootstrapped.fleet"
out=$(run_recover "$d")
check 'a bootstrap marker turns a lost fleet into a page' \
  "page: no fleet identity to recover for agent 'fleet'" "$out"
assert_inert 'a bootstrap marker turns a lost fleet into a page' "$d"

# case 11d — a remembered identity means a fleet already lived here, so a
# zero-candidate snapshot is a lost identity, not a virgin host
d=$(newcase bootstrap-refused-after-identity)
printf 'BOOTSTRAP_RESUME=%s\n' "$OTHER_REF" >>"$d/config/config.env"
empty_session_json >"$d/session/session.json"
write_identity "$d" 'w1:p1' "$REF"
empty_agent_list >"$d/agent-list.json"
pane_list_json "$(busy_pane 'w1:p2')" >"$d/pane-list.json"
out=$(run_recover "$d")
check 'bootstrap never runs once an identity is remembered' \
  "page: no live pane is the fleet's" "$out"
assert_inert 'bootstrap never runs once an identity is remembered' "$d"

# case 11d(ii) — the identity file exists but is unreadable (a torn write), so it
# yields no identity yet still proves a fleet lived here: page, never provision
d=$(newcase bootstrap-refused-after-torn-identity)
BOOT_REF2="$d/boot.jsonl"
: >"$BOOT_REF2"
printf 'BOOTSTRAP_RESUME=%s\n' "$BOOT_REF2" >>"$d/config/config.env"
empty_session_json >"$d/session/session.json"
printf 'w1:p1\n' >"$d/state/identity.fleet" # no separator, no ref: unusable
empty_agent_list >"$d/agent-list.json"
out=$(run_recover "$d")
check 'a torn identity file still blocks provisioning' \
  "page: no fleet identity to recover for agent 'fleet'" "$out"
assert_inert 'a torn identity file still blocks provisioning' "$d"

# case 11e — a real (non-dry) run that proves the fleet alive records the
# identity: that is what makes the release race recoverable on the NEXT run
d=$(newcase identity-write)
saved_session_json fleet "$REF" >"$d/session/session.json"
live_agent_list fleet 'w1:p1' "$REF" >"$d/agent-list.json"
process_info_omp 'w1:p1' >"$d/process-info-w1:p1.json"
(
  cd "$root" || exit 1
  HERDR_BIN_PATH="$tmp/herdr" \
    STUB_DIR="$d" \
    HERDR_PLUGIN_CONFIG_DIR="$d/config" \
    HERDR_PLUGIN_STATE_DIR="$d/state" \
    HERDR_SOCKET_PATH="$d/session/herdr.sock" \
    HERDR_PLUGIN_EVENT=startup \
    HERDR_SESSION=fleet \
    bash "$recover" >"$d/stdout" 2>"$d/stderr"
)
recorded=$(tr '\037' '|' <"$d/state/identity.fleet" 2>/dev/null)
leftovers=$(printf '%s' "$d"/state/identity.fleet.*)
if [[ $recorded == "w1:p1|$REF" && $leftovers == "$d/state/identity.fleet.*" ]]; then
  pass 'a live run records the fleet identity atomically'
else
  fail 'a live run records the fleet identity atomically' \
    "identity: ${recorded:-<none>} / temp files: $leftovers"
fi

# --------------------------------------------------------------------------
# Session scoping. Plugins are global to the user and load in every Herdr
# session (plugins.mdx:197-200), so a hook firing in the user's own interactive
# session must not touch the fleet's server, its bootstrap marker, or its pages.
# --------------------------------------------------------------------------

# case 13a — another session's hook skips before a single Herdr call: the case
# dir has no fixtures at all, so any call would fail the run
d=$(newcase session-mismatch)
saved_session_json fleet "$REF" >"$d/session/session.json"
out=$(run_recover "$d" startup '' 'personal')
check "another session's hook skips" \
  "skip: session 'personal' is not the fleet session 'fleet'" "$out"
assert_inert "another session's hook skips" "$d"

# case 13b — no HERDR_SESSION and a socket path outside sessions/ means the
# default session, which is not the fleet's: skip, naming both
d=$(newcase session-default)
saved_session_json fleet "$REF" >"$d/session/session.json"
out=$(run_recover "$d" startup '' '')
check 'the default session skips and names both sessions' \
  "skip: session 'default' is not the fleet session 'fleet'" "$out"
assert_inert 'the default session skips and names both sessions' "$d"

# case 13c — no HERDR_SESSION either, but the injected socket path is
# <config>/sessions/fleet/herdr.sock, which is where a named session keeps its
# data (src/session.rs:157-171): derive 'fleet' and proceed
d=$(newcase session-from-socket)
mkdir -p "$d/cfg/sessions/fleet"
saved_session_json fleet "$REF" >"$d/cfg/sessions/fleet/session.json"
empty_agent_list >"$d/agent-list.json"
pane_list_json "$(free_pane 'w1:p1' "$REF")" >"$d/pane-list.json"
process_info_json 'w1:p1' >"$d/process-info-w1:p1.json"
out=$(
  cd "$root" || exit 1
  RECOVER_DRY_RUN=1 \
    RECOVER_RECHECK_SECONDS=0 \
    HERDR_BIN_PATH="$tmp/herdr" \
    STUB_DIR="$d" \
    HERDR_PLUGIN_CONFIG_DIR="$d/config" \
    HERDR_PLUGIN_STATE_DIR="$d/state" \
    HERDR_SOCKET_PATH="$d/cfg/sessions/fleet/herdr.sock" \
    HERDR_PLUGIN_EVENT=startup \
    HERDR_SESSION='' \
    bash "$recover" 2>"$d/stderr"
)
check 'the session name is derived from the socket path when unset' \
  "plan: $tmp/herdr agent start 'fleet' --kind omp --pane w1:p1 -- --resume=$REF" "$out"
assert_inert 'the session name is derived from the socket path when unset' "$d"

# case 13d — an empty TARGET_SESSION disables the guard for single-session hosts
d=$(newcase session-guard-disabled)
printf 'TARGET_SESSION=\n' >>"$d/config/config.env"
saved_session_json fleet "$REF" >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
pane_list_json "$(free_pane 'w1:p1' "$REF")" >"$d/pane-list.json"
process_info_json 'w1:p1' >"$d/process-info-w1:p1.json"
out=$(run_recover "$d" startup '' 'whatever')
check 'an empty TARGET_SESSION disables the guard' \
  "plan: $tmp/herdr agent start 'fleet' --kind omp --pane w1:p1 -- --resume=$REF" "$out"
assert_inert 'an empty TARGET_SESSION disables the guard' "$d"

# case 13e — state files are per session, so a mis-scoped run could not consume
# the fleet's bootstrap marker even if the guard were bypassed
d=$(newcase session-scoped-state)
printf 'TARGET_SESSION=\nBOOTSTRAP_RESUME=%s\n' "$d/boot.jsonl" >>"$d/config/config.env"
: >"$d/boot.jsonl"
empty_session_json >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
: >"$d/state/bootstrapped.fleet" # the fleet session's marker
out=$(run_recover "$d" startup '' 'personal')
check "one session's bootstrap marker does not block another" \
  'plan: bootstrap' "$out"
assert_inert "one session's bootstrap marker does not block another" "$d"

# --------------------------------------------------------------------------
# case 10 — public pane number encoding matches Herdr's own vectors
# (src/workspace.rs:1522-1535). This is what lets the event filter name the
# fleet pane from session.json alone.
# --------------------------------------------------------------------------

# shellcheck source=../bin/recover.sh
. "$recover"
encoded=''
for n in 1 9 10 31 32 33; do
  encoded="$encoded$(encode_public_number "$n") "
done
check 'public pane number encoding matches herdr vectors' '1 9 A Z 0 11 ' "$encoded"

# --------------------------------------------------------------------------
# case 11 — the Telegram credentials come out of the omp-telegram files, with
# the `export`, quoting and comment shapes a real .env carries
# --------------------------------------------------------------------------

d=$(newcase telegram-credentials)
cat >"$d/telegram.env" <<'ENV'
# omp-telegram
TELEGRAM_ALLOWED_USERS=42
export TELEGRAM_BOT_TOKEN="123456:AA-fixture-token_value"
ENV
cat >"$d/access.json" <<'JSON'
{ "allowFrom": [987654321, 111222333], "pairedAt": "2026-07-01T00:00:00Z" }
JSON
TELEGRAM_ENV="$d/telegram.env" ACCESS_JSON="$d/access.json"
creds="$(telegram_token "$TELEGRAM_ENV")|$(telegram_chat_id "$ACCESS_JSON")"
check 'telegram credentials are read from the omp-telegram files' \
  '123456:AA-fixture-token_value|987654321' "$creds"

# --------------------------------------------------------------------------
# case 12 — a real (non-dry-run) page raises a Herdr notification and degrades
# cleanly when no bot token is configured. Offline by construction: the token
# lookup fails before curl is ever reached.
# --------------------------------------------------------------------------

d=$(newcase live-page)
saved_session_json worker "$OTHER_REF" >"$d/session/session.json"
empty_agent_list >"$d/agent-list.json"
(
  cd "$root" || exit 1
  HERDR_BIN_PATH="$tmp/herdr" \
    STUB_DIR="$d" \
    HERDR_PLUGIN_CONFIG_DIR="$d/config" \
    HERDR_PLUGIN_STATE_DIR="$d/state" \
    HERDR_SOCKET_PATH="$d/session/herdr.sock" \
    HERDR_PLUGIN_EVENT=startup \
    HERDR_SESSION=fleet \
    bash "$recover" >"$d/stdout" 2>"$d/stderr"
)
notified=$(cat "$d/calls" 2>/dev/null)
logged=$(cat "$d/stderr" 2>/dev/null)
if [[ $notified == *'notification show Conductor: fleet DOWN'* &&
  $notified == *"no fleet identity to recover for agent 'fleet'"* &&
  $logged == *"detail: nothing in $d/session/session.json"* &&
  $logged == *'telegram page skipped'* ]]; then
  pass 'a live page notifies herdr, logs the detail, and reports the missing token'
else
  fail 'a live page notifies herdr, logs the detail, and reports the missing token' \
    "calls: ${notified//$'\n'/ | } / stderr: ${logged//$'\n'/ | }"
fi

# --------------------------------------------------------------------------
# case 13 — an unreachable Herdr API pages with the CLI's own error text, so the
# page says what failed rather than only that something did
# --------------------------------------------------------------------------

d=$(newcase api-unreachable)
saved_session_json fleet "$REF" >"$d/session/session.json"
# no agent-list.json: the stub fails the call the way an unreachable server would
(
  cd "$root" || exit 1
  HERDR_BIN_PATH="$tmp/herdr" \
    STUB_DIR="$d" \
    HERDR_PLUGIN_CONFIG_DIR="$d/config" \
    HERDR_PLUGIN_STATE_DIR="$d/state" \
    HERDR_SOCKET_PATH="$d/session/herdr.sock" \
    HERDR_PLUGIN_EVENT=startup \
    HERDR_SESSION=fleet \
    bash "$recover" >"$d/stdout" 2>"$d/stderr"
)
reported="$(cat "$d/stdout" 2>/dev/null)|$(cat "$d/stderr" 2>/dev/null)"
if [[ $reported == *'page: the Herdr API did not answer `agent list`'* &&
  $reported == *'stub: no agent-list.json'* ]]; then
  pass 'an unreachable API pages with the CLI error text'
else
  fail 'an unreachable API pages with the CLI error text' "${reported//$'\n'/ | }"
fi

# --------------------------------------------------------------------------

if (( failures > 0 )); then
  printf '\n%d case(s) failed\n' "$failures"
  exit 1
fi
exit 0
