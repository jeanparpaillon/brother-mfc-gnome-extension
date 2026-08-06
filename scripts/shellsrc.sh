#!/bin/bash
# Unpack the GNOME Shell JS, the gjs overrides and the shell-side GIRs into
# .shellsrc/, so the API this extension is written against can be grepped.
#
# None of it is on disk as files. The shell's own JavaScript is a GResource
# bundle linked into libshell-<n>.so — not into /usr/bin/gnome-shell, which is a
# 31 kB stub and lists no resources at all — and Ubuntu ships no -dev packages
# here, so there are no .gir XML files either, only binary .typelib.
#
# Everything is discovered rather than named: the soname carries the shell
# version (libshell-18.so is shell 50), and the typelibs sit outside the default
# girepository search path, in /usr/lib/gnome-shell and mutter's private dir.
# Hardcoding either breaks on the next shell release.
set -u

OUT=${OUT:-.shellsrc}

die() { echo "$*" >&2; exit 1; }

# The library actually linked into the running shell, whatever its version is.
SHELL_LIB=$(ldd /usr/bin/gnome-shell |
    sed -n 's|.*=> \(/usr/lib/gnome-shell/libshell-[0-9]*\.so\).*|\1|p' | head -1)
[ -n "$SHELL_LIB" ] || die "no libshell-*.so in ldd /usr/bin/gnome-shell"

GJS_LIB=$(ldd /usr/bin/gnome-shell |
    sed -n 's|.*=> \(/[^ ]*libgjs\.so\.0\).*|\1|p' | head -1)
[ -n "$GJS_LIB" ] || die "no libgjs.so.0 in ldd /usr/bin/gnome-shell"

# gresource paths are absolute (/org/gnome/shell/ui/panel.js); strip the prefix
# so the tree comes out as js/ui/panel.js rather than one long path.
extract_bundle() {
    local lib=$1 prefix=$2 dest=$3 n=0 res rel

    while read -r res; do
        rel=${res#"$prefix"}
        mkdir -p "$dest/$(dirname "$rel")"
        gresource extract "$lib" "$res" > "$dest/$rel" || die "extract $res"
        n=$((n + 1))
    done < <(gresource list "$lib" | grep "^$prefix")

    [ "$n" -gt 0 ] || die "no resources under $prefix in $lib"
    echo "$dest: $n files from $(basename "$lib")"
}

rm -rf "$OUT"
mkdir -p "$OUT"

extract_bundle "$SHELL_LIB" /org/gnome/shell/ "$OUT/js"
extract_bundle "$GJS_LIB" /org/gnome/gjs/modules/ "$OUT/gjs"

# The C side: St, Shell, Clutter, Meta. g-ir-generate turns a .typelib back into
# the .gir XML the dev packages would have shipped — class hierarchy, properties,
# signals and method signatures, which is what a gjs caller needs. It resolves
# each typelib's dependencies itself, so every directory holding one has to be on
# the include path or it aborts ("Typelib file for namespace 'Meta' not found").
MUTTER_DIR=$(ldd /usr/bin/gnome-shell |
    sed -n 's|.*=> \(/[^ ]*/mutter-[0-9]*\)/lib[^ ]*\.so.*|\1|p' | head -1)
[ -n "$MUTTER_DIR" ] || die "no mutter-* directory in ldd /usr/bin/gnome-shell"

mkdir -p "$OUT/gir"
mapfile -t TYPELIBS < <(
    find /usr/lib/gnome-shell "$MUTTER_DIR" -name '*.typelib' | sort)
[ ${#TYPELIBS[@]} -gt 0 ] || die "no shell/mutter typelibs found"

INCLUDES=(--includedir=/usr/lib/gnome-shell "--includedir=$MUTTER_DIR")

for tl in "${TYPELIBS[@]}"; do
    name=$(basename "$tl" .typelib)
    g-ir-generate "${INCLUDES[@]}" "$tl" > "$OUT/gir/$name.gir" 2>/dev/null ||
        { rm -f "$OUT/gir/$name.gir"; echo "  skipped $name (decompile failed)" >&2; }
done
echo "$OUT/gir: $(ls "$OUT/gir" | wc -l) GIRs — $(ls "$OUT/gir" | sed 's/\.gir//' | tr '\n' ' ')"
