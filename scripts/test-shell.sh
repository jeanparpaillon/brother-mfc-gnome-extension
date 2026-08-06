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

# --unsafe-mode is a mutter option that gnome-shell --help does not list. It is
# what makes org.gnome.Shell.Eval answer, and Eval is the only way to look at the
# panel: headless draws nothing and Screenshot returns AccessDenied.
gnome-shell --headless --unsafe-mode --virtual-monitor 1280x720 >"$LOG" 2>&1 &
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

ev() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1"
}

# The indicator itself: it is in the panel, it carries the icon, and the menu
# opens. Object state, not pixels — nothing is drawn in a headless shell.
probe=$(ev "const i = Main.panel.statusArea['$UUID'];
    i.menu.open(false);
    JSON.stringify({
        present: !!i,
        visible: i.visible,
        icon: i.get_children()[0].iconName,
        menuItems: i.menu.numMenuItems,
        menuOpen: i.menu.isOpen,
    })")
echo "indicator: $probe"
# Eval hands back JSON inside a JSON string inside a GVariant, so every quote
# arrives backslash-escaped. Drop the backslashes rather than trying to write
# case patterns against them — in a pattern, \" matches a bare quote and so
# silently never matches what is actually there.
flat=${probe//\\/}
case "$flat" in
    *'"present":true'*) ;;
    *) fail "no indicator in Main.panel.statusArea" ;;
esac
case "$flat" in
    *'"icon":"scanner-symbolic"'*) ;;
    *) fail "indicator is not showing scanner-symbolic" ;;
esac
case "$flat" in
    *'"menuOpen":true'*) ;;
    *) fail "menu did not open" ;;
esac

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
