/* lib/skey.js — is brscan-skey installed, and if not, what exactly is missing?
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// The shell already does this in ui/environment.js, and _promisify returns early
// when a method is wrapped, so repeating it costs nothing and keeps this file
// honest about what it relies on.
Gio._promisify(Gio.File.prototype, 'query_info_async');

/**
 * Where the packages come from. There is no repository and no per-model direct
 * link — the download page asks for the model — so this is the most precise URL
 * that can be given. See README.md.
 */
export const DOWNLOAD_URL = 'https://support.brother.com/g/b/downloadtop.aspx';

/** What `detect()` reports as absent, in `state.missing`. */
export const Missing = Object.freeze({
    TOOL: 'tool',
    OPT: 'opt',
    BACKEND: 'backend',
});

// /usr/bin/brscan-skey is a symlink into the /opt tree, and the /opt tree is
// where every path this extension later rewrites lives (design.md §2.1), so
// both halves are probed: the wrapper alone is a broken install.
const TOOL = '/usr/bin/brscan-skey';
const OPT_DIR = '/opt/brother/scanner/brscan-skey';

// brscan4 and brscan5 are separate downloads covering different model ranges;
// at most one is installed. Both ship their SANE module as
// /usr/lib64/sane/libsane-brotherN.so — that literal path is package-owned
// (`dpkg -L brscan4`), not the distribution's multiarch directory, so it can be
// probed without guessing an architecture triplet.
const BACKENDS = [
    {
        name: 'brscan5',
        dir: '/opt/brother/scanner/brscan5',
        lib: '/usr/lib64/sane/libsane-brother5.so',
    },
    {
        name: 'brscan4',
        dir: '/opt/brother/scanner/brscan4',
        lib: '/usr/lib64/sane/libsane-brother4.so',
    },
];

/**
 * Test hook: every probed path is taken relative to $BROTHER_MFC_ROOT when it is
 * set, so the missing-package states can be exercised without touching the real
 * /opt — which is root-owned, and which the machine running the tests may well
 * need for scanning. Unset in a normal session. See CONTRIBUTING.md.
 *
 * @param {string} path - absolute path to probe
 * @returns {string} the path, under the test root if there is one
 */
function rooted(path) {
    const root = GLib.getenv('BROTHER_MFC_ROOT');
    return root ? GLib.build_filenamev([root, path]) : path;
}

/**
 * @param {string} path - absolute path
 * @param {Gio.Cancellable} [cancellable] - cancelled when the indicator goes away
 * @returns {Promise<boolean>} whether the path resolves to something
 */
async function exists(path, cancellable = null) {
    try {
        // FileQueryInfoFlags.NONE follows symlinks, which is what is wanted: a
        // /usr/bin/brscan-skey dangling at a removed /opt tree is not an install.
        await Gio.File.new_for_path(path).query_info_async(
            Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable);
        return true;
    } catch (e) {
        if (e instanceof GLib.Error &&
            e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        // Anything else — not found, or a parent directory we may not traverse —
        // means the file cannot be confirmed, and for detection that is the same
        // as it not being there. Never let a probe fail the whole detection.
        return false;
    }
}

/**
 * Probe the install. Every filesystem access is async: this runs from `enable()`
 * and from menu-open, both on the compositor thread, which must not block.
 *
 * @param {Gio.Cancellable} [cancellable] - cancelled when the indicator goes away
 * @returns {Promise<object>} the state, as consumed by `stateKey()` and `explain()`
 */
export async function detect(cancellable = null) {
    const probe = path => exists(rooted(path), cancellable);

    const [hasTool, hasOptDir, backends] = await Promise.all([
        probe(TOOL),
        probe(OPT_DIR),
        Promise.all(BACKENDS.map(async b => ({
            name: b.name,
            dir: rooted(b.dir),
            lib: rooted(b.lib),
            hasDir: await probe(b.dir),
            hasLib: await probe(b.lib),
        }))),
    ]);

    // A generation counts as *chosen* as soon as its /opt tree is there. A tree
    // without the SANE module is a half-installed package, which is a different
    // sentence to the user than no driver at all.
    const found = backends.find(b => b.hasDir);
    const backend = found
        ? {name: found.name, dir: found.dir, lib: found.lib, hasLib: found.hasLib, present: found.hasLib}
        : {name: null, dir: null, lib: null, hasLib: false, present: false};

    const missing = [];
    if (!hasTool)
        missing.push(Missing.TOOL);
    if (!hasOptDir)
        missing.push(Missing.OPT);
    if (!backend.present)
        missing.push(Missing.BACKEND);

    return {
        tool: rooted(TOOL),
        optDir: rooted(OPT_DIR),
        hasTool,
        hasOptDir,
        backend,
        missing,
        ok: missing.length === 0,
    };
}

/**
 * A value that changes exactly when the menu would have to be rebuilt. Menu-open
 * re-runs detection, and rebuilding an open menu that has not changed makes it
 * flicker for nothing.
 *
 * @param {object} state - from `detect()`
 * @returns {string} comparable with `===`
 */
export function stateKey(state) {
    return [
        state.hasTool,
        state.hasOptDir,
        state.backend.name,
        state.backend.hasLib,
    ].join(':');
}

/**
 * Why the extension cannot do anything, in the user's words. Names the piece
 * that is actually absent: "not installed" alone leaves nothing to act on, and
 * the two packages come from the same download page but are not the same
 * download.
 *
 * @param {object} state - from `detect()`, with `ok === false`
 * @returns {string} one sentence per missing piece
 */
export function explain(state) {
    const lines = [];

    if (!state.hasTool && !state.hasOptDir) {
        lines.push(_('The brscan-skey scan-key tool is not installed.'));
    } else if (!state.hasTool) {
        lines.push(_('brscan-skey is installed, but the %s command is missing.')
            .format(state.tool));
    } else if (!state.hasOptDir) {
        lines.push(_('brscan-skey is installed, but %s is missing.')
            .format(state.optDir));
    }

    if (!state.backend.present) {
        if (!state.backend.name) {
            lines.push(_('The brscan4 or brscan5 scanner driver is not installed; without it no scanner is found.'));
        } else {
            lines.push(_('%s is installed, but its scanner driver %s is missing.')
                .format(state.backend.name, state.backend.lib));
        }
    }

    return lines.join('\n\n');
}
