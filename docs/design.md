# Design

What the extension is and why it is built this way. `README.md` states the goal;
this document records the decisions and the facts they rest on. Tasks live in
[todo/](todo/) and cite sections here.

## §1 — Environment facts

Established by inspection on the development machine (Ubuntu 26.04, GNOME Shell
50.1, MFC-J5335DW at 192.168.1.3). Several are **not** guaranteed by the Brother
package and must be re-checked, not assumed, on any other machine.

| Fact | Consequence |
|---|---|
| GNOME Shell 50.1, gjs 1.88, Adw 1 / GTK 4 | ESM extension (GNOME 45+ style), Adw preferences |
| mutter 50 ships only `MetaBackendNative`; `gnome-shell --nested` is gone | No nested shell. Test headless on a virtual monitor — [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Headless shell refuses `Eval` and `Screenshot` over D-Bus | Automated checks read extension *state*; anything visual is confirmed by hand in a real session |
| `brscan-skey` present, `brscan-skey -l` lists the MFC | Detection path exists; `Not responded` in that output is the registration state |
| `brscan-skey.config` and `script/*.sh` writable by the user, `script/` dir **not** | Can edit in place, cannot add files there |
| No per-user override for `brscan-skey.config` — `strings` shows only the `/opt` path | Repointing must edit the `/opt` copy |
| Stock scripts source `~/.brscan-skey/scanto*.config` first, `/etc/opt/...` second | Per-user scan config is natively supported, no root needed |
| `brscan-skey-exe` calls `CMD "$1" "$2" "$3"` — device, mode, email address | Our scripts receive the device and the triggering action |
| FUNC values in the binary: `IMAGE`(1), `EMAIL`(2), `OCR`(3), `FILE`(5) | Four entry points to implement |
| `tesseract` not installed; `magick` (ImageMagick 7) is | OCR gated at runtime; PDF conversion via `magick` |
| `XDG_DOCUMENTS_DIR="$HOME/"` on this machine | `Documents/brother/` resolves to `~/brother/` unless special-cased |

## §2 — Architecture

### §2.1 — Repoint, don't replace

`README.md` proposes replacing `/opt/brother/scanner/brscan-skey/script/*`. Those
files are package-owned and are clobbered on upgrade, and the directory is not
writable, so new files cannot be added beside them.

Instead: install our scripts under `~/.local/share/brother-mfc/scripts/` and rewrite
the four `IMAGE=` / `OCR=` / `EMAIL=` / `FILE=` lines in `brscan-skey.config` to
point at them. One in-place edit of an already-writable file, revertible, and it
survives package upgrades. `pkexec` when the file is root-owned; §2.5 when that is
refused.

### §2.2 — Scan parameters ride Brother's own config format

The extension generates `~/.brscan-skey/scanto{image,file,email,ocr}.config` in
Brother's `key=value` shell format. Stock scripts already read those paths, so
resolution, size and duplex keep working **even if the user reverts §2.1**. Our
scripts read the same files plus extra keys (`output_format`, `output_dir`, …) that
stock scripts ignore harmlessly.

GSettings is authoritative; these files are generated output, never edited by hand.

> They are `source`d by bash. Every generated value must be shell-escaped on write,
> `output_dir` above all.

### §2.3 — Notifications go through a D-Bus service the extension exports

Scripts call `gdbus call --session --dest org.gnome.Shell --object-path
/org/gnome/Shell/Extensions/BrotherMFC` on start, finish and error. The extension
raises a GNOME notification carrying *Open* and *Open folder* actions, and reflects
progress on the panel icon.

When the call fails — extension disabled, shell restarting, or the sway session is
the one that is up — the script falls back to `notify-send` and completes the file
work anyway. **A scan must never depend on the UI being up.** The button on the
printer is the interface; the panel icon is a convenience.

### §2.4 — The systemd unit has no `[Install]` section

Per `~/CLAUDE.md`: this machine's systemd user manager is shared between the sway and
GNOME sessions and runs with `Linger=yes`, so anything `WantedBy=graphical-session.target`
starts under sway too.

`~/.config/systemd/user/brscan-skey.service` therefore carries **no `[Install]`
section at all**, and the extension drives it with `StartUnit` / `StopUnit` over
`org.freedesktop.systemd1` from `enable()` and `disable()`. That yields supervision,
`Restart=on-failure` and journal logging, with no `.wants` symlink to maintain and no
path by which the unit can leak into the sway session. The extension's own lifecycle
*is* the GNOME session lifecycle, which is exactly the scope wanted.

### §2.5 — Degraded mode

If `brscan-skey.config` cannot be written at all: leave the stock scripts alone and
run a `Gio.FileMonitor` on `~/brscan/`, post-processing each `.tif` that appears.

This loses per-action behaviour — all four actions write the same
`brscan_<timestamp>.tif` pattern into that one directory, so the trigger cannot be
recovered — but it still delivers XDG output paths and notifications. It is a
fallback, not a design goal.

## §3 — Layout

```
brother-mfc@parpaillon.org/
  extension.js          panel indicator, menu, D-Bus service, unit control
  prefs.js              Adw preferences -> GSettings
  lib/skey.js           brscan-skey -l parsing, install detection, config rewrite
  lib/config.js         GSettings -> ~/.brscan-skey/*.config generation
  lib/systemd.js        org.freedesktop.systemd1 client
  schemas/org.gnome.shell.extensions.brother-mfc.gschema.xml
  scripts/scanto{image,file,email,ocr}.sh   installed to ~/.local/share/brother-mfc/
  metadata.json         shell-version: ["50"]
```

## §4 — Open questions

- **Config reload semantics.** Does `brscan-skey` re-read `brscan-skey.config` on
  `--refresh`, or does it need a restart? Decided by [3.1](todo/3_1.md); it
  determines whether changing settings has to bounce the unit.
- **Multiple devices.** `brscan-skey.config` holds one script set for all MFCs, so
  per-device settings would have to be dispatched inside our scripts on `$1`. Single
  device is assumed throughout; see [3.2](todo/3_2.md).
