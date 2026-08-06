#!/bin/bash
# Check the generated unit and the lifecycle the extension drives it through,
# against the real systemd user manager.
#
# `make test` cannot cover this: its shell runs under dbus-run-session, and
# systemd is not on that bus. So this runs lib/systemd.js through
# scripts/systemd-probe.js instead — same code, no shell — and reads the result
# back with systemctl.
#
# It starts and stops brscan-skey.service for real, and kills its process once
# to see the supervision work.
set -u

UNIT=brscan-skey.service
HERE=$(cd "$(dirname "$0")" && pwd)
PROBE="gjs -m $HERE/systemd-probe.js"

FAILED=0
fail() { echo "FAIL: $*" >&2; FAILED=1; }
ok() { echo "ok: $*"; }

show() { systemctl --user show "$UNIT" -p "$1" --value; }

if [ ! -x /usr/bin/brscan-skey ]; then
    echo "SKIP: brscan-skey is not installed"
    exit 0
fi

# Ownership is the point of half of what follows, and it cannot be read off a
# unit somebody else already started.
if [ "$(systemctl --user is-active $UNIT)" = active ]; then
    echo "$UNIT is already running; stop it first (systemctl --user stop $UNIT)" >&2
    exit 1
fi

echo "== generating the unit =="
$PROBE install || fail "probe install failed"
UNIT_FILE=$(show FragmentPath)
[ -f "$UNIT_FILE" ] || fail "no unit file at '$UNIT_FILE'"
case "$UNIT_FILE" in
    "$HOME"/.config/systemd/user/*) ok "generated at $UNIT_FILE" ;;
    *) fail "unit came from $UNIT_FILE, not from ~/.config/systemd/user" ;;
esac

# Writing is content-addressed, so a second run must be a no-op — the extension
# calls this on every enable().
second=$($PROBE install)
case "$second" in
    written=false*) ok "second install rewrote nothing" ;;
    *) fail "second install: $second" ;;
esac

echo "== nothing can pull it in (design.md §2.4) =="
if grep -q '^\[Install\]' "$UNIT_FILE"; then
    fail "the unit has an [Install] section"
else
    ok "no [Install] section"
fi

for prop in WantedBy RequiredBy; do
    v=$(show $prop)
    [ -z "$v" ] && ok "$prop is empty" || fail "$prop=$v"
done

wants=$(find "$HOME/.config/systemd/user" -name "$UNIT" -path '*.wants/*' 2>/dev/null)
[ -z "$wants" ] && ok "in no .wants directory" || fail "linked from: $wants"

# systemd 259 does not fail here — `enable` on a unit with no [Install] prints
# "the unit files have no installation config" and exits 0. What matters is that
# it changes nothing: the unit stays static and no symlink appears, so a machine
# that shares its user manager with a sway session cannot pick this up.
systemctl --user enable "$UNIT" >/dev/null 2>&1
state=$(show UnitFileState)
[ "$state" = static ] && ok "still $state after systemctl --user enable" \
    || fail "UnitFileState=$state after enable"

wants=$(find "$HOME/.config/systemd/user" -name "$UNIT" -path '*.wants/*' 2>/dev/null)
[ -z "$wants" ] && ok "enable created no .wants symlink" || fail "enable linked it from: $wants"

echo "== enable() then disable() =="
# The probe does both in one process, because ownership of the unit lives only
# as long as the extension does.
life=$($PROBE lifecycle) || fail "probe lifecycle failed"
echo "$life"
case "$life" in
    *"enable: state=active"*"startedByUs=true"*) ok "enable() started it" ;;
    *) fail "enable() did not reach active" ;;
esac
case "$life" in
    *"disable: state=inactive"*) ok "disable() stopped it" ;;
    *) fail "disable() left it running" ;;
esac

echo "== a unit we did not start is not ours to stop =="
systemctl --user start "$UNIT" || fail "could not start $UNIT by hand"
sleep 1
life=$($PROBE lifecycle) || fail "probe lifecycle failed"
echo "$life"
case "$life" in
    *"enable: state=active"*"startedByUs=false"*) ok "did not claim a running unit" ;;
    *) fail "claimed a unit somebody else started" ;;
esac
case "$life" in
    *"disable: state=active"*) ok "left it running" ;;
    *) fail "stopped a unit it did not start" ;;
esac
systemctl --user stop "$UNIT"

echo "== supervision =="
$PROBE start >/dev/null || fail "probe start failed"
before=$(show NRestarts)
main=$(show MainPID)
# SIGKILL, not SIGTERM: systemd counts SIGTERM as a clean exit, so Restart=on-failure
# would let it stay down. The wrapper is /bin/sh, so the daemon is its child —
# unless the shell exec'd it, in which case there is no child to look for.
victims=$(pgrep -P "$main")
[ -n "$victims" ] || victims=$main
echo "killing $victims (unit MainPID=$main)"
kill -9 $victims

sleep 8
after=$(show NRestarts)
if [ "$(systemctl --user is-active $UNIT)" = active ] && [ "$after" -gt "$before" ]; then
    ok "restarted after the kill (NRestarts $before -> $after)"
else
    fail "not back up: is-active=$(systemctl --user is-active $UNIT), NRestarts $before -> $after, Result=$(show Result)"
fi

$PROBE stop >/dev/null || fail "probe stop failed"
[ "$(systemctl --user is-active $UNIT)" = inactive ] \
    && ok "stopped" || fail "still $(systemctl --user is-active $UNIT) after stop"

echo "== a start that fails =="
# On a throwaway unit, not on brscan-skey.service: the menu has to name the
# failure and there is no way to provoke one on the real service without leaving
# the scanner broken behind us.
#
# What systemd 259 does when the start limit is hit is worth knowing, because it
# is not what the documentation for older versions describes: StartUnit still
# returns a job, Result keeps the underlying cause (exit-code) rather than
# becoming start-limit-hit, and "Start request repeated too quickly" appears in
# the journal only. Hence the journalctl invocation in the menu: the label
# cannot carry the whole answer.
FAIL_UNIT=brother-mfc-failtest.service
FAIL_FILE="$HOME/.config/systemd/user/$FAIL_UNIT"
cat >"$FAIL_FILE" <<'EOF'
[Unit]
Description=throwaway unit for scripts/test-systemd.sh
StartLimitIntervalSec=60
StartLimitBurst=2

[Service]
Type=simple
ExecStart=/bin/false
Restart=on-failure
RestartSec=100ms
EOF
trap 'systemctl --user reset-failed "$FAIL_UNIT" 2>/dev/null; rm -f "$FAIL_FILE"; systemctl --user daemon-reload' EXIT
systemctl --user daemon-reload

failure=$($PROBE expect-failure "$FAIL_UNIT" 2>&1)
echo "$failure"
case "$failure" in
    *"failure: state=failed"*) ok "a failed start reads as failed" ;;
    *) fail "failed start not reported: $failure" ;;
esac
case "$failure" in
    *"result=exit-code"*) ok "the cause is carried in Result" ;;
    *) fail "no Result to put in the menu: $failure" ;;
esac

# The unit did give up rather than restart forever, and it said so where the
# menu sends the user.
if journalctl --user -u "$FAIL_UNIT" --since '-2min' 2>/dev/null \
        | grep -q 'repeated too quickly'; then
    ok "the start limit is in the journal, where the menu points"
else
    fail "the start limit was never hit; the restart loop was not exercised"
fi

[ "$FAILED" = 0 ] && echo OK
exit $FAILED
