UUID    = brother-mfc@parpaillon.org
SRC     = src
BUILD   = build
ZIP     = $(BUILD)/$(UUID).shell-extension.zip
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

SOURCES = $(SRC)/metadata.json $(SRC)/extension.js $(wildcard $(SRC)/lib/*.js) \
          $(wildcard $(SRC)/schemas/*.gschema.xml)

.PHONY: all pack install uninstall enable disable reload reload-clean test test-systemd shell clean check shellsrc

all: pack

# gnome-extensions pack picks up metadata.json, extension.js, prefs.js,
# stylesheet.css, schemas/ and locale/ from the source directory on its own, and
# runs glib-compile-schemas over the schemas. Anything else — lib/, scripts/ —
# has to be named with --extra-source as it appears.
pack: $(ZIP)

$(ZIP): $(SOURCES) | $(BUILD)
	gnome-extensions pack --force --extra-source=lib --out-dir=$(BUILD) $(SRC)

$(BUILD):
	mkdir -p $(BUILD)

check:
	glib-compile-schemas --strict --dry-run $(SRC)/schemas/

install: $(ZIP)
	gnome-extensions install --force $(ZIP)

uninstall:
	gnome-extensions uninstall $(UUID)

# Not `gnome-extensions enable`: that goes through the running shell, which only
# scans the extension directories at startup and so has never heard of what
# `make install` just unzipped. See scripts/set-enabled.sh.
enable:
	./scripts/set-enabled.sh $(UUID) true
	@echo "Log out and back in — a running shell will not load a newly installed extension."

disable:
	./scripts/set-enabled.sh $(UUID) false

# The edit loop in a live session: no logout, no test shell. Needs unsafe mode.
reload: install
	./scripts/reload.sh

reload-clean:
	./scripts/reload.sh --clean

# GNOME Shell cannot be restarted under Wayland, and mutter 50 has no nested
# backend, so the test loop is a headless shell on its own session bus. It loads
# what `make install` put in ~/.local/share/gnome-shell/extensions/, so install
# first. See CONTRIBUTING.md.
test: install
	./scripts/test-shell.sh

# The other half of the test story: dbus-run-session gives the headless shell a
# bus with no systemd on it, so `make test` can only prove the extension
# survives that. This drives lib/systemd.js against the real user manager,
# outside any shell. It starts and stops brscan-skey.service for real.
test-systemd:
	./scripts/test-systemd.sh

# The same shell, left running to poke at by hand. Nothing is drawn; talk to it
# with gnome-extensions / gdbus from inside the dbus-run-session.
shell:
	dbus-run-session -- gnome-shell --headless --virtual-monitor 1280x720

# Unpack the shell's own JS and the shell-side GIRs into .shellsrc/ to read and
# grep. None of it ships as files — see CONTRIBUTING.md.
shellsrc:
	./scripts/shellsrc.sh

clean:
	rm -rf $(BUILD) .shellsrc
