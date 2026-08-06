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

# The install lib/skey.js probes is taken relative to $BROTHER_MFC_ROOT, so the
# extension is pointed at fake trees here rather than at the real /opt: that one
# is root-owned, and renaming it out of the way to see the missing-package menu
# would need sudo and would break scanning while the test runs.
ROOTS=$(mktemp -d -t brother-mfc-roots-XXXXXX)

# Everything there: the wrapper, the /opt tree, and the brscan4 driver with its
# SANE module at the path the Brother package owns.
mkdir -p "$ROOTS/present/usr/bin" \
         "$ROOTS/present/opt/brother/scanner/brscan-skey" \
         "$ROOTS/present/opt/brother/scanner/brscan4" \
         "$ROOTS/present/usr/lib64/sane"
touch "$ROOTS/present/usr/bin/brscan-skey" \
      "$ROOTS/present/usr/lib64/sane/libsane-brother4.so"

mkdir -p "$ROOTS/absent"

# brscan-skey installed, no scanner driver — the case the issue calls out: the
# two come from the same download page but are not the same package.
cp -a "$ROOTS/present" "$ROOTS/no-driver"
rm -rf "$ROOTS/no-driver/opt/brother/scanner/brscan4" "$ROOTS/no-driver/usr/lib64"

# The /opt tree renamed away with the wrapper left behind — a broken install,
# which must not read as "not installed".
cp -a "$ROOTS/present" "$ROOTS/no-opt"
mv "$ROOTS/no-opt/opt/brother/scanner/brscan-skey" \
   "$ROOTS/no-opt/opt/brother/scanner/brscan-skey.away"

export BROTHER_MFC_ROOT="$ROOTS/present"

# --unsafe-mode is a mutter option that gnome-shell --help does not list. It is
# what makes org.gnome.Shell.Eval answer, and Eval is the only way to look at the
# panel: headless draws nothing and Screenshot returns AccessDenied.
gnome-shell --headless --unsafe-mode --virtual-monitor 1280x720 >"$LOG" 2>&1 &
SHELL_PID=$!
trap 'kill $SHELL_PID 2>/dev/null; rm -rf "$ROOTS"' EXIT

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

# --- detection -------------------------------------------------------------
# Detection re-runs on every menu open, so a state change is applied by closing
# and reopening the menu — no disable/enable, which is the point: installing the
# package must not need a logout.

# Reads what is on screen now. No detect() of its own: the rebuild has to have
# happened by itself, on the open above.
read_menu() {
    p=$(ev "const i = Main.panel.statusArea['$UUID'];
        JSON.stringify({
            missing: i._state.missing,
            labels: i.menu._getMenuItems().map(m => m.label ? m.label.text : ''),
        })")
    echo "${p//\\/}"
}

set_root() { ev "GLib.setenv('BROTHER_MFC_ROOT', '$1', true); true" >/dev/null; }

reopen() {
    ev "const i = Main.panel.statusArea['$UUID'];
        i.menu.close(false); i.menu.open(false); true" >/dev/null
    sleep 1.5
}

# expect <what> <haystack> <needle>
expect() {
    case "$2" in
        *"$3"*) ;;
        *) fail "$1: expected '$3' in $2" ;;
    esac
}
reject() {
    case "$2" in
        *"$3"*) fail "$1: did not expect '$3' in $2" ;;
    esac
}

m=$(read_menu)
echo "menu (present): $m"
expect "present" "$m" '"missing":[]'
expect "present" "$m" 'No devices yet'

set_root "$ROOTS/absent"; reopen
m=$(read_menu)
echo "menu (absent): $m"
expect "absent" "$m" '"missing":["tool","opt","backend"]'
expect "absent" "$m" 'not installed'
expect "absent" "$m" 'Get it from Brother'
reject "absent" "$m" 'No devices yet'

set_root "$ROOTS/no-driver"; reopen
m=$(read_menu)
echo "menu (no driver): $m"
expect "no driver" "$m" '"missing":["backend"]'
expect "no driver" "$m" 'brscan4 or brscan5'
expect "no driver" "$m" 'Get it from Brother'

set_root "$ROOTS/no-opt"; reopen
m=$(read_menu)
echo "menu (no /opt tree): $m"
expect "no /opt tree" "$m" '"missing":["opt"]'
expect "no /opt tree" "$m" '/opt/brother/scanner/brscan-skey is missing'

# Back to a good install, without ever disabling the extension.
set_root "$ROOTS/present"; reopen
m=$(read_menu)
echo "menu (restored): $m"
expect "restored" "$m" '"missing":[]'
expect "restored" "$m" 'No devices yet'
reject "restored" "$m" 'Get it from Brother'

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
