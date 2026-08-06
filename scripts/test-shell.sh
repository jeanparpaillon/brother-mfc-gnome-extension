#!/bin/bash
# Load the extension in a throwaway GNOME Shell and check its lifecycle.
#
# mutter 50 has no nested backend (see CONTRIBUTING.md), so this runs a headless
# shell on a virtual monitor and on its own session bus. Nothing is drawn; the
# signal is the extension state reported over D-Bus plus the shell's stderr.
set -u

UUID=brother-mfc@parpaillon.org
CYCLES=${CYCLES:-2}
LOG=$(mktemp -t brother-mfc-shell-XXXXXX.log)

if [ -z "${DBUS_SESSION_BUS_ADDRESS_IS_OURS:-}" ]; then
    export DBUS_SESSION_BUS_ADDRESS_IS_OURS=1
    exec dbus-run-session -- "$0" "$@"
fi

fail() { echo "FAIL: $*" >&2; FAILED=1; }
FAILED=0

state() { gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *\(State\|État\): *//p'; }

gnome-shell --headless --virtual-monitor 1280x720 >"$LOG" 2>&1 &
SHELL_PID=$!
trap 'kill $SHELL_PID 2>/dev/null' EXIT

if ! gdbus wait --session --timeout 60 org.gnome.Shell; then
    echo "shell never claimed org.gnome.Shell; log follows" >&2
    cat "$LOG" >&2
    exit 1
fi
sleep 3

gnome-extensions enable "$UUID" || exit 1
sleep 2
s=$(state)
echo "after enable: $s"
[ "$s" = ACTIVE ] || fail "expected ACTIVE after enable, got '$s'"

# A disable() that leaks its indicator is caught here and nowhere else: the next
# enable() hits "Extension point conflict: there is already a status indicator
# for role $UUID" and the state goes ERROR.
for i in $(seq 1 "$CYCLES"); do
    gnome-extensions disable "$UUID"; sleep 1.5
    gnome-extensions enable "$UUID"; sleep 1.5
    s=$(state)
    echo "after cycle $i: $s"
    [ "$s" = ACTIVE ] || fail "expected ACTIVE after cycle $i, got '$s'"
done

if grep -q "$UUID" "$LOG"; then
    echo "--- shell complained about $UUID ---" >&2
    grep -A6 "$UUID" "$LOG" >&2
    fail "shell logged an error for $UUID"
fi

kill $SHELL_PID 2>/dev/null
wait $SHELL_PID 2>/dev/null

if [ "$FAILED" = 0 ]; then
    echo "OK (log: $LOG)"
else
    echo "log: $LOG" >&2
fi
exit $FAILED
