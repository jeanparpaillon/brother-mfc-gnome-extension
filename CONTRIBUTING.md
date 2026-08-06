# Contributing

## Layout

The extension sources live in [src/](src/), not at the repository root: the root
already has a `scripts/` directory holding repository tooling, and
[docs/design.md](docs/design.md) §3 puts the scan scripts at `scripts/` *inside* the
extension. Packing from `src/` keeps the two apart. The tree described in §3 is what
ends up in `~/.local/share/gnome-shell/extensions/brother-mfc@parpaillon.org/`.

## Build and install

```sh
make install   # pack src/ and install into ~/.local/share/gnome-shell/extensions/
make enable
# log out and back in
```

**A running shell will not load a newly installed extension.** It reads the
extension directories once at startup, `ReloadExtension` over D-Bus answers
`NotSupported: ReloadExtension is deprecated and does not work`, and under Wayland
there is no `Alt+F2 r`. Either log out and back in, or use `make reload` below.

That is also why `make enable` does not run `gnome-extensions enable`. That command
asks the running shell, which has never heard of what `make install` just unzipped:

```
$ gnome-extensions enable brother-mfc@parpaillon.org
L'extension « brother-mfc@parpaillon.org » n'existe pas
```

[scripts/set-enabled.sh](scripts/set-enabled.sh) writes the `enabled-extensions`
GSetting directly instead. That is the same key the shell reads at startup, so it
works before the shell knows the extension exists, and a shell that *does* already
know it applies the change live — it watches that key. The script reads the value
back afterwards and fails if the change did not stick.

## The fast loop: `make reload`

`make reload` installs and then loads the result into the **running** session — no
logout, no test shell. The technique is from
[gareve/GnomeShellExtensionReloader](https://github.com/gareve/GnomeShellExtensionReloader)
(that extension itself is GNOME 40/41 and pre-ESM, so only the idea carries over).

Reloading the same UUID from the same path cannot work: gjs caches a module by URI
for the life of the process, and `extensionSystem.js` refuses the attempt outright
with *"A different version was loaded previously. You need to log out for changes
to take effect."* So [scripts/reload.sh](scripts/reload.sh) copies the installed
extension to a throwaway UUID — `brother-mfc@parpaillon.org_eph_<timestamp>`, a
path the shell has never imported — rewrites `uuid` in its `metadata.json`, and
hands that to `Main.extensionManager`:

```js
const ext = M.createExtensionObject(eph, dir, ExtensionType.PER_USER);
await M.loadExtension(ext);      // INITIALIZED: eph is not in enabled-extensions yet
M.enableExtension(eph);          // writes that key; the manager's handler enables it
```

The previous throwaway is unloaded, deleted and dropped from `enabled-extensions`
first, so they do not pile up. `make reload-clean` removes the last one when you
are done.

`Main.extensionManager` only exists inside the shell process, so this goes through
`org.gnome.Shell.Eval`, which is gated on unsafe mode. Turn it on once per session
— Alt+F2, `lg`, then in the Evaluator tab:

```js
global.context.unsafe_mode = true
```

The shell posts a notification while it is on, and it resets at the next login.
`make reload` says all this if Eval refuses.

Two things to expect: the reloaded copy shows up under a different UUID (its
`name` gets a "(reloaded)" suffix so it is obvious in the Extensions app), and the
real UUID stays unloaded until the next login.

`gnome-extensions pack` picks up `metadata.json`, `extension.js`, `prefs.js`,
`stylesheet.css`, `schemas/` and `locale/` on its own; anything else — `lib/`,
`scripts/` — has to be added to the `pack` line in the [Makefile](Makefile) with
`--extra-source` when it appears. The `.zip` carries only the `.gschema.xml`;
`gnome-extensions install` is what runs `glib-compile-schemas`, so
`schemas/gschemas.compiled` shows up in the installed copy and never in the build
output.

`make check` validates the schema without installing anything.

## Testing: headless, not nested

**There is no nested GNOME Shell on shell 50.** `gnome-shell --nested` is documented
all over the web and in this repository's own history, and it no longer exists:

```
$ gnome-shell --nested --wayland
Failed to configure: Option inconnue --nested
```

`--nested` was dropped because mutter's nested backend was the *X11* backend, and
mutter 50 ships only `MetaBackendNative` — `strings libmutter-14-0.so` finds no other
`MetaBackend*` type, and `--display-server` survives in `--help` only as a leftover
("Run as a full display server, rather than nested"). Running `gnome-shell --wayland`
without it does **not** fall back to nested; it goes straight for the seat and dies:

```
Running GNOME Shell (using mutter 50.1) as a Wayland display server
Failed to setup: Failed to take control of the session: GDBus.Error:System.Error.EBUSY
```

The replacement is a headless shell on a virtual monitor, on its own session bus:

```sh
dbus-run-session -- gnome-shell --headless --virtual-monitor 1280x720
```

Nothing is drawn — there is no window to look at — so the extension is checked over
D-Bus and through the shell's stderr instead. [scripts/test-shell.sh](scripts/test-shell.sh)
does that:

```sh
make install && make test
```

It starts the headless shell, enables the extension, cycles it disabled/enabled twice
and asserts the state stays `ACTIVE`, checks the indicator through `Eval`, then greps
the shell log for the UUID.

The shell is started with **`--unsafe-mode`**, a mutter option that `gnome-shell
--help` does not list. It is what makes `org.gnome.Shell.Eval` answer instead of
returning `(false, '')`, and Eval is the only way to see anything: headless draws
nothing, and `org.gnome.Shell.Screenshot.Screenshot` returns `AccessDenied`. With it,
the test asserts the indicator is in `Main.panel.statusArea`, carries
`scanner-symbolic`, and that `menu.open()` leaves `menu.isOpen` true.

That is object state, not pixels — it does not prove the icon *drew*. That last bit
still needs a real session.

Two things to know about the signals it uses:

- **The state name is `ACTIVE`, not `ENABLED`.** `gnome-extensions info` reports
  `INITIALIZED` before enabling, `ACTIVE` after, and `ERROR` when `enable()` threw.
- **The disable/enable cycle is what catches a leaked indicator**, and it is a real
  test, not a formality — verified by breaking `disable()` on purpose, which turns
  cycle 1 into:

  ```
  Extension brother-mfc@parpaillon.org: Error: Extension point conflict: there is
  already a status indicator for role brother-mfc@parpaillon.org
    addToStatusArea@resource:///org/gnome/shell/ui/panel.js:714:19
  ```

  and the state to `ERROR`. Anything added to `enable()` from here on should be
  matched by a teardown in `disable()` that this cycle would notice.

Other things worth knowing:

- The shell scans the extension directory at startup, so **`make install` before
  starting the test shell**; a rebuild after it started is not picked up.
- Enabled/disabled state lives in dconf, which `dbus-run-session` does *not* isolate.
  `gnome-extensions enable` inside the test shell also enables the extension in the
  real session at next login.
- Extension errors do not reach `journalctl /usr/bin/gnome-shell` here — that is the
  session's shell, not this one. They go to the test shell's own stderr.
- `gnome-extensions` talks to whichever shell owns `org.gnome.Shell` on the bus it
  finds. Run it *inside* the `dbus-run-session`, or it silently falls back to the
  standalone `org.gnome.Shell.Extensions` service and reports
  "Erreur lors de la connexion à Shell de GNOME".
