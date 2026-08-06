#!/usr/bin/env python3
"""Add or remove the extension from org.gnome.shell enabled-extensions.

`gnome-extensions enable` asks the running shell over D-Bus, and a running shell
only scans the extension directories at startup — it will not have heard of an
extension that `make install` just unzipped:

    $ gnome-extensions enable brother-mfc@parpaillon.org
    L'extension « brother-mfc@parpaillon.org » n'existe pas

There is no way to make it rescan; ReloadExtension answers "deprecated and does
not work" on shell 50. Writing the GSetting instead always succeeds, and it is
the same key the shell reads at startup, so the extension comes up at the next
login. A shell that *does* already know the extension picks the change up live —
it watches that key.
"""
import sys

from gi.repository import Gio

KEY = "enabled-extensions"


def main(uuid, enable):
    settings = Gio.Settings.new("org.gnome.shell")
    uuids = list(settings.get_strv(KEY))

    if enable and uuid not in uuids:
        uuids.append(uuid)
    elif not enable and uuid in uuids:
        uuids.remove(uuid)
    else:
        print(f"{uuid}: already {'enabled' if enable else 'disabled'}")
        return 0

    if not settings.set_strv(KEY, uuids):
        print(f"{KEY} is not writable", file=sys.stderr)
        return 1
    Gio.Settings.sync()

    # Read back through a fresh Settings, not the one just written: the write is
    # only queued until sync(), and a running shell reacts to this key. Silently
    # printing success on a change that did not land is worse than failing.
    if (uuid in Gio.Settings.new("org.gnome.shell").get_strv(KEY)) is not enable:
        print(f"{KEY} did not keep the change", file=sys.stderr)
        return 1

    print(f"{uuid}: {'enabled' if enable else 'disabled'}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[2] not in ("true", "false"):
        sys.exit(f"usage: {sys.argv[0]} <uuid> <true|false>")
    sys.exit(main(sys.argv[1], sys.argv[2] == "true"))
