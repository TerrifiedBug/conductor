#!/usr/bin/env bash
set -uo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"
CALLS="$TMP/calls"
mkdir -p "$BIN" "$TMP/home/.omp/agent/telegram"
printf 'TELEGRAM_BOT_TOKEN=test-token\n' >"$TMP/home/.omp/agent/telegram/.env"
printf '{"allowFrom":[1]}\n' >"$TMP/home/.omp/agent/telegram/access.json"

cat >"$BIN/omp" <<'EOF'
#!/usr/bin/env bash
if [ "$*" = "plugin list --json" ]; then
	cat "$OMP_INVENTORY"
	exit "${OMP_LIST_EXIT:-0}"
fi
printf 'omp %s\n' "$*" >>"$SETUP_CALLS"
EOF
cat >"$BIN/gh" <<'EOF'
#!/usr/bin/env bash
[ "$*" = "auth status" ]
EOF
cat >"$BIN/herdr" <<'EOF'
#!/usr/bin/env bash
printf 'herdr %s\n' "$*" >>"$SETUP_CALLS"
EOF
chmod +x "$BIN/omp" "$BIN/gh" "$BIN/herdr"

export HOME="$TMP/home"
export PATH="$BIN:$PATH"
export SETUP_CALLS="$CALLS"
export OMP_INVENTORY="$TMP/inventory.json"

fail() {
	printf 'not ok %s\n' "$1" >&2
	exit 1
}
pass() { printf 'ok    %s\n' "$1"; }
run_setup() {
	: >"$CALLS"
	SETUP_OUTPUT=$("$ROOT/setup.sh" "$@" 2>&1)
}

printf '{"npm":[{"name":"omp-conductor","version":"0.3.18"}],"marketplace":[]}\n' >"$OMP_INVENTORY"
run_setup install || fail "npm-managed install should be preserved"
case $SETUP_OUTPUT in
*"npm-managed; keeping it"*) ;;
*) fail "preserved npm install was not explained" ;;
esac
case $(cat "$CALLS") in
*"omp plugin link"*) fail "ordinary install replaced npm package with a link" ;;
*"herdr plugin link"*) ;;
*) fail "Herdr checkout was not linked while npm omp package was preserved" ;;
esac
pass "npm-managed omp package is preserved while Herdr links"

run_setup install --force-link || fail "explicit force-link should succeed"
case $(cat "$CALLS") in
*"omp plugin link $ROOT/omp"*) ;;
*) fail "force-link did not link the checkout" ;;
esac
pass "force-link deliberately replaces npm source"

printf '{"npm":[],"marketplace":[]}\n' >"$OMP_INVENTORY"
run_setup install || fail "checkout without npm install should link"
case $(cat "$CALLS") in
*"omp plugin link $ROOT/omp"*) ;;
*) fail "checkout was not linked when no npm package existed" ;;
esac
pass "checkout links when no npm package exists"

printf '{not-json\n' >"$OMP_INVENTORY"
if run_setup install; then
	fail "unreadable inventory should fail closed"
fi
case $SETUP_OUTPUT in
*"refusing to replace it"*) ;;
*) fail "inventory failure did not explain the safe recovery" ;;
esac
case $(cat "$CALLS") in
*"plugin link"*) fail "inventory failure still mutated plugins" ;;
esac
pass "unreadable inventory fails closed"
