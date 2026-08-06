#!/bin/bash
# Load the freshly installed extension into the *running* shell, no logout.
#
# A running shell scans the extension directories only at startup, and gjs caches
# a module by URI forever, so re-loading the same UUID from the same path cannot
# pick up edited code — extensionSystem.js refuses outright ("A different version
# was loaded previously. You need to log out for changes to take effect.").
#
# The way round both, from gareve/GnomeShellExtensionReloader: copy the extension
# to a throwaway UUID, which is a path the shell has never imported, and hand that
# to Main.extensionManager. The previous throwaway is unloaded and deleted first.
#
# The manager is only reachable from inside the shell process, so this drives it
# through org.gnome.Shell.Eval, which needs unsafe mode. See CONTRIBUTING.md.
set -u

UUID=brother-mfc@parpaillon.org
EXTDIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
SRC="$EXTDIR/$UUID"

ev() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1"
}

CLEAN=0
[ $# -gt 0 ] && [ "$1" = "--clean" ] && CLEAN=1

[ -d "$SRC" ] || { echo "$SRC is not installed — run 'make install' first" >&2; exit 1; }

if [ "$(ev 'global.context.unsafe_mode')" = "(false, '')" ]; then
    cat >&2 <<'MSG'
org.gnome.Shell.Eval is refused: the shell is not in unsafe mode.

Turn it on for this session — Alt+F2, type `lg`, then in the Evaluator tab:

    global.context.unsafe_mode = true

It resets at the next login, and the shell posts a notification while it is on.
MSG
    exit 1
fi

# Unload every previous throwaway and take it out of enabled-extensions, before
# bash deletes the directories out from under the shell.
stale=$(ev "(async () => {
    const M = Main.extensionManager;
    const stale = M.getUuids().filter(u => u.startsWith('${UUID}_eph_'));
    for (const uuid of stale) {
        const ext = M.lookup(uuid);
        if (ext)
            await M.unloadExtension(ext);
    }
    const key = 'enabled-extensions';
    global.settings.set_strv(key,
        global.settings.get_strv(key).filter(u => !u.startsWith('${UUID}_eph_')));
    return stale.join(' ');
})()")
case "$stale" in
    "(true, "*) ;;
    *) echo "unloading previous copies failed: $stale" >&2; exit 1 ;;
esac

for d in "$SRC"_eph_*; do
    [ -d "$d" ] && rm -rf "$d"
done

if [ "$CLEAN" = 1 ]; then
    echo "unloaded and removed every throwaway copy"
    exit 0
fi

EPH="${UUID}_eph_$(date +%s%N)"
cp -r "$SRC" "$EXTDIR/$EPH" || exit 1
python3 - "$EXTDIR/$EPH/metadata.json" "$EPH" <<'PY' || exit 1
import json, sys
path, eph = sys.argv[1], sys.argv[2]
with open(path) as f:
    meta = json.load(f)
meta["uuid"] = eph
meta["name"] += " (reloaded)"
with open(path, "w") as f:
    json.dump(meta, f)
PY

# createExtensionObject registers it; loadExtension leaves it INITIALIZED because
# the UUID is not in enabled-extensions yet; enableExtension writes that key, and
# the manager's own handler on it does the init/enable. Same path a normal
# extension takes when you enable it.
result=$(ev "(async () => {
    const {ExtensionType} = await import('resource:///org/gnome/shell/misc/extensionUtils.js');
    const Gio = (await import('gi://Gio')).default;
    const M = Main.extensionManager;
    const dir = Gio.File.new_for_path('$EXTDIR/$EPH');
    const ext = M.createExtensionObject('$EPH', dir, ExtensionType.PER_USER);
    await M.loadExtension(ext);
    if (!M.enableExtension('$EPH'))
        throw new Error('enableExtension refused ' + '$EPH');

    // enableExtension only writes enabled-extensions; the manager's handler on
    // that key does the actual enable, so the state is still INITIALIZED here.
    // Wait for it to settle rather than reporting a state nobody asked about.
    const {ExtensionState} = await import('resource:///org/gnome/shell/misc/extensionUtils.js');
    for (let i = 0; i < 40; i++) {
        const {state} = M.lookup('$EPH');
        if (state !== ExtensionState.INITIALIZED && state !== ExtensionState.ACTIVATING) {
            return Object.keys(ExtensionState).find(k => ExtensionState[k] === state) ?? state;
        }
        await new Promise(r => setTimeout(r, 50));
    }
    return 'timed out waiting for it to leave INITIALIZED';
})()")

case "$result" in
    '(true, '*ACTIVE*) echo "$EPH: ACTIVE" ;;
    "(true, "*) echo "$EPH did not come up: ${result#(true, }" >&2; exit 1 ;;
    *) echo "load failed: $result" >&2; exit 1 ;;
esac
