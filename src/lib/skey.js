/* lib/skey.js — is brscan-skey installed, and if not, what exactly is missing?
 * Plus: what does it say is out there, when it is.
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
// This one the shell does *not* do — ui/environment.js promisifies nine methods
// and Gio.Subprocess is not among them (`grep _promisify .shellsrc/js/ui/
// environment.js`), so without this line the call below would take a callback
// and return undefined. Promisified, it resolves to [stdout, stderr]: gjs drops
// the leading `true` of the finish function's return.
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

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

/* --- the device list ------------------------------------------------------
 *
 * `brscan-skey -l` is the only enumeration the tool offers, it has no
 * machine-readable form and no documentation. What follows was written against:
 *
 *     brscan-skey 0.3.4-0, brscan4 0.4.11-1 (dpkg), binaries dated 2025-01-21
 *     MFC-J5335DW over the network at 192.168.1.3, Ubuntu 26.04
 *
 * A blank line, then one line per MFC:
 *
 *      MFC-J5335DW       : brother4:net1;dev0  : 192.168.1.3          Active
 *     ^     ^            ^                     ^                     ^
 *     0     name (18)    19 ':'                41 ':'                64 status
 *
 * The columns are not guesswork; the format strings are in the binary, and so
 * is the closed set of status phrases (`strings brscan-skey-exe`):
 *
 *      %-18s:      %-20s:      %-20s      Active   Not responded   Not registered
 *
 * i.e. ` %-18s: %-20s: %-20s %s`. Two consequences for parsing:
 *
 * - **The second field contains a colon of its own** (`brother4:net1;dev0`), so
 *   "split on the first two colons" — which is what the shape of the line
 *   suggests — mis-splits it into `brother4` and `net1;dev0 : …`. The separator
 *   is the colon that follows a *padded* column, and the field itself never
 *   contains whitespace, which is what the expression below keys on instead.
 * - **A column that overflows its width shifts everything after it.** A model
 *   name of 19 characters or more leaves no space before the first colon. So
 *   nothing here counts characters; the widths are documentation, not input.
 *
 * The status is what a user actually needs from this: `Not responded` is what
 * "I press the Scan button and nothing happens" looks like from this side, and
 * `Not registered` is the same symptom with a different fix. It is carried
 * through verbatim for display — the phrases above are all that this build
 * emits, but they are the ones this build emits.
 */

/** The status phrases `brscan-skey-exe` contains. Not an exhaustive world. */
export const Status = Object.freeze({
    ACTIVE: 'Active',
    NOT_RESPONDED: 'Not responded',
    NOT_REGISTERED: 'Not registered',
});

const KNOWN_STATUS = Object.values(Status);

// `responded` is derived by naming the bad phrases, not by requiring the good
// one: an unrecognised status — a later firmware, a localised build, a phrase
// nobody here has seen — must not make a working scanner look broken in the
// menu. The unknown case reads as fine and shows its own words.
const UNRESPONSIVE = [Status.NOT_RESPONDED, Status.NOT_REGISTERED];

// <name> : <device> : <rest>. What tells a separator colon from the one inside
// `brother4:net1;dev0` is the space *after* it — the format puts one there
// (`: %-20s`) and the device URI never does. Requiring whitespace before it
// instead would fail on the overflow case, where a long column leaves none.
//
// Without that, a truncated line still finds two colons and parses to a device
// named `brother4` at `net1;dev0`. Wrong, and worse than useless: the whole
// point of skipping a line is that a device the parser invents cannot be told
// from one the printer reported.
//
// `(.+?)` is lazy so the name gives up as little as possible, and the trailing
// `\s*$` is what stops the status keeping the line's own padding.
const DEVICE_LINE = /^\s*(.+?)\s*:\s+(\S+)\s*:\s+(.*?)\s*$/;

/**
 * Take the address and the status apart. They are two columns with no separator
 * between them beyond the padding of the address field, and on a USB device —
 * `brother4:bus1;dev1`, which has no IP — the address column is empty and only
 * the phrase is left.
 *
 * @param {string} rest - everything after the second colon, already trimmed
 * @returns {{ip: ?string, status: string}} `ip` null when there is no address
 */
function splitAddress(rest) {
    if (!rest)
        return {ip: null, status: ''};

    // Checked before anything else because `Active` is a single word with no
    // spaces, and would otherwise be indistinguishable from an address.
    if (KNOWN_STATUS.includes(rest))
        return {ip: null, status: rest};

    // The ordinary case: %-20s pads the address, so at least two spaces stand
    // between it and the status.
    const padded = /^(\S+)\s{2,}(\S.*)$/.exec(rest);
    if (padded)
        return {ip: padded[1], status: padded[2]};

    // An address 20 characters or longer eats its own padding and leaves a
    // single space. Recoverable only for a phrase we know.
    const known = KNOWN_STATUS.find(s => rest.endsWith(` ${s}`));
    if (known)
        return {ip: rest.slice(0, -known.length).trim() || null, status: known};

    // One word: an address whose status column came out empty. An address
    // cannot contain a space, so anything else is a status and nothing more.
    return /\s/.test(rest)
        ? {ip: null, status: rest}
        : {ip: rest, status: ''};
}

/**
 * Parse the text of `brscan-skey -l`. Pure and synchronous — this is the half
 * that is worth testing, and it is tested against captured text in tests/.
 *
 * Nothing here throws. A line that does not parse is handed back in `skipped`
 * rather than taking out the lines that do: the caller is a menu, and one
 * unfamiliar device must not empty it.
 *
 * @param {string} text - stdout of `brscan-skey -l`
 * @returns {{devices: object[], skipped: string[]}} devices are
 *   `{name, device, ip, status, responded}`, `ip` null when there is none
 */
export function parseDeviceList(text) {
    const devices = [];
    const skipped = [];

    for (const line of (text ?? '').split('\n')) {
        // Blank lines are structure, not damage: the output opens with one.
        if (!line.trim())
            continue;

        const m = DEVICE_LINE.exec(line);
        if (!m) {
            skipped.push(line);
            continue;
        }

        const [, name, device, rest] = m;
        const {ip, status} = splitAddress(rest);
        devices.push({
            name,
            device,
            ip,
            status,
            responded: !UNRESPONSIVE.some(
                p => p.toLowerCase() === status.toLowerCase()),
        });
    }

    return {devices, skipped};
}

/** Why `listDevices()` could not answer, in `ListError.reason`. */
export const ListFailure = Object.freeze({
    SPAWN: 'spawn',      // brscan-skey could not be run at all
    EXIT: 'exit',        // it ran and failed
    SIGNAL: 'signal',    // it was killed before it finished
});

/**
 * A `brscan-skey -l` that did not produce a list. Empty output is *not* one of
 * these — a machine with no registered MFC is an ordinary, empty answer.
 */
export class ListError extends Error {
    /**
     * @param {string} reason - one of `ListFailure`
     * @param {string} message - for the log, not for the user
     * @param {object} [details] - `status`, `signal`, `stderr` as they apply
     */
    constructor(reason, message, details = {}) {
        super(message);
        this.name = 'SkeyListError';
        this.reason = reason;
        this.status = details.status ?? null;
        this.signal = details.signal ?? null;
        this.stderr = details.stderr ?? '';
    }
}

/**
 * Run `brscan-skey -l` and parse it.
 *
 * The exit status is checked, but it is close to worthless here and the caller
 * should not lean on it: the wrapper script runs the real binary and then
 * `exit 0` unconditionally for `-l` —
 *
 *     if [ "$1" = "-l" ] || [ "$1" = "--list" ]; then
 *             /opt/brother/scanner/brscan-skey/brscan-skey-exe $*
 *             exit 0
 *     fi
 *
 * — so brscan-skey-exe crashing, or being missing entirely, still comes back as
 * 0 with something on stderr. That is why `stderr` is returned alongside the
 * devices instead of being dropped on a successful exit. The check stays for
 * the cases the wrapper cannot swallow: it not being there, not being
 * executable, or being killed.
 *
 * @param {Gio.Cancellable} [cancellable] - cancelled when the indicator goes away
 * @returns {Promise<{devices: object[], skipped: string[], stderr: string}>} the list
 * @throws {ListError} when the tool could not be run, failed, or was killed
 */
export async function listDevices(cancellable = null) {
    const tool = rooted(TOOL);

    let proc;
    try {
        proc = Gio.Subprocess.new(
            [tool, '-l'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        // Not installed, not executable, not a program. detect() is what tells
        // the user about that; this is the race where it went away in between.
        throw new ListError(ListFailure.SPAWN,
            `could not run ${tool} -l: ${e.message}`);
    }

    let stdout, stderr;
    try {
        [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
    } catch (e) {
        // Cancelling the read does not stop the child; it would go on holding
        // its pipes after the indicator that asked for it is gone.
        if (e instanceof GLib.Error &&
            e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            proc.force_exit();
        throw e;
    }

    stderr = (stderr ?? '').trim();

    // Killed mid-read: distinguishable from a non-zero exit, and from a device
    // list that is legitimately empty, because all three are things the menu
    // has to say differently.
    if (proc.get_if_signaled()) {
        throw new ListError(ListFailure.SIGNAL,
            `${tool} -l was killed by signal ${proc.get_term_sig()}`,
            {signal: proc.get_term_sig(), stderr});
    }

    const status = proc.get_exit_status();
    if (status !== 0) {
        throw new ListError(ListFailure.EXIT,
            `${tool} -l exited ${status}: ${stderr || '(no output on stderr)'}`,
            {status, stderr});
    }

    const {devices, skipped} = parseDeviceList(stdout ?? '');

    // Once per run, with the lines themselves: this is the only place a format
    // this file was not written for becomes visible, and a per-line log would
    // repeat on every menu open.
    if (skipped.length) {
        console.warn(`brscan-skey -l: ${skipped.length} unparsed line(s):\n${
            skipped.map(l => `  ${JSON.stringify(l)}`).join('\n')}`);
    }
    if (stderr)
        console.warn(`brscan-skey -l wrote to stderr: ${stderr}`);

    return {devices, skipped, stderr};
}
