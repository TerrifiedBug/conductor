#!/usr/bin/env bash
#
# Install the conductor plugins, after checking this machine can actually run
# them.
#
#   ./setup.sh preflight   check only, change nothing
#   ./setup.sh install     preflight, then link or install both plugins
#   ./setup.sh install --force-link
#                          replace an npm omp-conductor install with this checkout
#
# Preflight evaluates every check before it decides, so one missing tool does
# not hide the next three. Each failure prints the command that fixes it.
#
set -uo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

USAGE='usage: ./setup.sh [preflight|install [--force-link]]

  preflight             check only, change nothing
  install               preflight, then link or install both plugins (default)
  install --force-link  deliberately replace an npm omp-conductor with this checkout'

# Collected rather than fatal-on-first: one run should tell you everything to fix.
HARD_FAILURES=()
SOFT_WARNINGS=()

pass() { printf '  ok    %s\n' "$1"; }
skip() { printf '  --    %s\n' "$1"; }

fail() {
	printf '  FAIL  %s\n' "$1"
	HARD_FAILURES+=("$1"$'\n        fix: '"$2")
}

warn() {
	printf '  warn  %s\n' "$1"
	SOFT_WARNINGS+=("$1"$'\n        '"$2")
}

# omp-telegram's state directory, resolved exactly as the plugin resolves it:
# `detectTelegram` (omp/src/setup.ts) and `readTelegramToken` (omp/src/escalate.ts)
# both take $OMP_TELEGRAM_STATE_DIR when it is set to something non-blank.
telegram_state_dir() {
	local override=${OMP_TELEGRAM_STATE_DIR:-}
	# Trimmed before the emptiness test: a variable set to whitespace is set but
	# unusable, and both readers treat it as unset.
	if [ -n "${override//[[:space:]]/}" ]; then
		printf '%s' "$override"
	else
		printf '%s' "$HOME/.omp/agent/telegram"
	fi
}

# True when `.env` carries a non-empty TELEGRAM_BOT_TOKEN. Mirrors the plugin's
# parser: an `export` prefix is allowed, comments and blanks are skipped, and
# surrounding quotes are stripped. The value is tested for emptiness, never printed.
has_telegram_token() {
	local env_path=$1 line value
	[ -f "$env_path" ] || return 1
	while IFS= read -r line || [ -n "$line" ]; do
		line=${line#"${line%%[![:space:]]*}"}
		case $line in
		'' | '#'*) continue ;;
		esac
		line=${line#export}
		line=${line#"${line%%[![:space:]]*}"}
		case $line in
		TELEGRAM_BOT_TOKEN*) ;;
		*) continue ;;
		esac
		value=${line#TELEGRAM_BOT_TOKEN}
		value=${value#"${value%%[![:space:]]*}"}
		case $value in
		=*) value=${value#=} ;;
		*) continue ;;
		esac
		value=${value#"${value%%[![:space:]]*}"}
		value=${value%"${value##*[![:space:]]}"}
		case $value in
		'"'*'"' | "'"*"'") value=${value:1:${#value}-2} ;;
		esac
		[ -n "$value" ] && return 0
	done <"$env_path"
	return 1
}

# Exit 0 only when omp reports omp-conductor in its npm-managed package list.
# Malformed/unreadable inventory is exit 2: callers fail closed rather than
# silently replacing an install whose source could not be identified.
omp_conductor_installed_from_npm() {
	local listing
	listing=$(omp plugin list --json 2>/dev/null) || return 2
	OMP_PLUGIN_LIST_JSON=$listing bun -e '
		try {
			const inventory = JSON.parse(process.env.OMP_PLUGIN_LIST_JSON ?? "{}");
			process.exit(
				Array.isArray(inventory.npm) &&
					inventory.npm.some((plugin) => plugin?.name === "omp-conductor")
					? 0
					: 1,
			);
		} catch {
			process.exit(2);
		}
	'
}

preflight() {
	echo "preflight"

	local tool
	for tool in omp bun git gh; do
		if command -v "$tool" >/dev/null 2>&1; then
			pass "$tool on PATH"
			continue
		fi
		case $tool in
		omp) fail "omp not on PATH" "install the omp harness — both plugins load inside it" ;;
		bun) fail "bun not on PATH" "curl -fsSL https://bun.sh/install | bash" ;;
		git) fail "git not on PATH" "install git — every run cuts a worktree" ;;
		gh) fail "gh not on PATH" "install the GitHub CLI — the tracker is read through it" ;;
		esac
	done

	if command -v gh >/dev/null 2>&1; then
		if gh auth status >/dev/null 2>&1; then
			pass "gh is authenticated"
		else
			fail "gh is not authenticated" "gh auth login    (then: gh auth refresh -s repo,project)"
		fi
	fi

	# omp-telegram is a separate package and stays one. Conductor borrows its bot
	# token to page tier 2, and the fleet heartbeat reads its access.json to decide
	# whether unattended dispatch is still supervised — so its state must exist.
	local tg_dir env_path access_path
	tg_dir=$(telegram_state_dir)
	env_path="$tg_dir/.env"
	access_path="$tg_dir/access.json"

	if has_telegram_token "$env_path"; then
		pass "omp-telegram bot token present ($env_path)"
	else
		fail "no usable TELEGRAM_BOT_TOKEN in $env_path" \
			"install and pair omp-telegram first — conductor borrows its token to page you"
	fi

	if [ -f "$access_path" ]; then
		pass "omp-telegram access.json present ($access_path)"
	else
		fail "missing $access_path" \
			"pair omp-telegram with your Telegram account — pairing is what writes access.json"
	fi

	# Soft: exactly one paired owner. The heartbeat's own gate fails closed on
	# anything else, so this is a warning here rather than a blocker.
	if [ -f "$access_path" ]; then
		if command -v jq >/dev/null 2>&1; then
			local owners
			owners=$(jq -r 'try (.allowFrom | length) catch "unreadable"' "$access_path" 2>/dev/null) || owners=unreadable
			case $owners in
			1) pass "exactly one paired Telegram owner" ;;
			'' | unreadable | null)
				warn "could not read allowFrom from $access_path" \
					"the tick gate refuses to guess who owns escalations; re-pair omp-telegram"
				;;
			*)
				warn "$owners paired Telegram owners in $access_path" \
					"the tick gate needs exactly one — it will not guess which human is on the hook"
				;;
			esac
		else
			skip "paired-owner count (install jq to check it)"
		fi
	fi

	if command -v herdr >/dev/null 2>&1; then
		pass "herdr on PATH"
	else
		warn "herdr not on PATH" \
			"the omp half will install on its own; herdr-conductor is what supervises the fleet pane"
	fi

	if [ ${#SOFT_WARNINGS[@]} -gt 0 ]; then
		printf '\nwarnings (not blocking):\n'
		local w
		for w in "${SOFT_WARNINGS[@]}"; do printf '  - %s\n' "$w"; done
	fi

	if [ ${#HARD_FAILURES[@]} -gt 0 ]; then
		printf '\npreflight failed — %d check(s) must pass first:\n' "${#HARD_FAILURES[@]}"
		local f
		for f in "${HARD_FAILURES[@]}"; do printf '  - %s\n' "$f"; done
		return 1
	fi

	printf '\npreflight passed\n'
	return 0
}

install_plugins() {
	local force_link=${1:-0}
	preflight || return 1

	# A checkout installs from source; anything else installs the published
	# package. `omp/package.json` beside this script is the reliable tell.
	local from_checkout=0 preserve_npm=0 inventory_status
	[ -f "$SCRIPT_DIR/omp/package.json" ] && from_checkout=1
	if [ "$from_checkout" -eq 1 ] && [ "$force_link" -ne 1 ]; then
		omp_conductor_installed_from_npm
		inventory_status=$?
		case $inventory_status in
		0) preserve_npm=1 ;;
		1) ;;
		*)
			printf '  FAIL  could not identify the installed omp-conductor source\n' >&2
			printf '        refusing to replace it; repair `omp plugin list --json` or rerun with --force-link\n' >&2
			return 1
			;;
		esac
	fi

	printf '\ninstall\n'

	# A checkout normally links from source. Preserve an existing npm-managed
	# install unless the operator explicitly chooses the mutable checkout.
	if [ "$preserve_npm" -eq 1 ]; then
		printf '  warn  omp-conductor is npm-managed; keeping it instead of linking %s\n' "$SCRIPT_DIR/omp"
		printf '        use `./setup.sh install --force-link` to replace it deliberately\n'
	elif [ "$from_checkout" -eq 1 ]; then
		printf '  omp    linking %s\n' "$SCRIPT_DIR/omp"
		omp plugin link "$SCRIPT_DIR/omp" || return 1
	else
		printf '  omp    installing omp-conductor\n'
		omp plugin install omp-conductor || return 1
	fi

	if command -v herdr >/dev/null 2>&1; then
		if [ "$from_checkout" -eq 1 ]; then
			printf '  herdr  linking %s\n' "$SCRIPT_DIR/herdr"
			herdr plugin link "$SCRIPT_DIR/herdr" || return 1
		else
			printf '  herdr  installing TerrifiedBug/conductor/herdr\n'
			herdr plugin install TerrifiedBug/conductor/herdr || return 1
		fi
	else
		printf '  herdr  skipped (not on PATH)\n'
	fi

	cat <<'EOF'

next
  1. In an omp session, run:  /conductor setup
     It interviews you, prints a dry run, and mutates nothing until you confirm.
  2. For a brief tailored to your project rather than the conservative floor,
     ask an omp session to read:  skill://conductor-onboarding
EOF
}

case ${1:-install} in
preflight)
	[ "$#" -eq 1 ] || {
		printf 'preflight takes no options\n\n%s\n' "$USAGE" >&2
		exit 2
	}
	preflight
	;;
install)
	case ${2:-} in
	'') install_plugins 0 ;;
	--force-link)
		[ "$#" -eq 2 ] || {
			printf 'install --force-link takes no other options\n\n%s\n' "$USAGE" >&2
			exit 2
		}
		install_plugins 1
		;;
	*)
		printf 'unknown install option: %s\n\n%s\n' "$2" "$USAGE" >&2
		exit 2
		;;
	esac
	;;
-h | --help | help) printf '%s\n' "$USAGE" ;;
*)
	printf 'unknown subcommand: %s\n\n%s\n' "$1" "$USAGE" >&2
	exit 2
	;;
esac
