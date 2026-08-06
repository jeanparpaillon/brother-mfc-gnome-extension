/* tests/run.js — unit tests for the parts of lib/ that are pure functions.
 *
 * Run with `make unit`, or `gjs -m tests/run.js` once the stub bundle exists.
 * No shell, no D-Bus, no hardware: scripts/test-shell.sh covers what needs a
 * running shell, and it needs a minute and a headless compositor to say
 * anything. This says something about the parser in a tenth of a second.
 *
 * Two things make importing an extension module outside the shell possible:
 *
 * - **A GResource stub.** `src/lib/skey.js` imports
 *   `resource:///org/gnome/shell/extensions/extension.js`, which exists only
 *   inside gnome-shell — it is compiled into libshell-18.so, and there is no
 *   file to point an import at (CONTRIBUTING.md, "Reading the shell's own
 *   sources"). tests/stub/ is compiled into a bundle holding that one path and
 *   registered below, which is enough to satisfy the import.
 * - **A dynamic import.** Static imports are resolved before any statement in
 *   this file runs, so the module under test has to be pulled in with
 *   `await import()` *after* the resource is registered. That is the only
 *   reason it is written that way.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const STUB = GLib.getenv('BROTHER_MFC_STUB') ??
    GLib.build_filenamev([HERE, '..', 'build', 'stub.gresource']);

if (!GLib.file_test(STUB, GLib.FileTest.EXISTS)) {
    printerr(`no stub bundle at ${STUB} — run \`make unit\``);
    System.exit(2);
}
Gio.resources_register(Gio.resource_load(STUB));

// What ui/environment.js:421 does inside the shell. skey.js's explain() calls
// String.prototype.format, which is a gjs extension that nothing installs by
// itself.
String.prototype.format = imports.format.format;

const Skey = await import(GLib.filename_to_uri(
    GLib.build_filenamev([HERE, '..', 'src', 'lib', 'skey.js']), null));

/* --- the harness ---------------------------------------------------------- */

let failed = 0;
let ran = 0;

/** @param {*} v - any value @returns {*} the same, with object keys ordered */
function stable(v) {
    if (Array.isArray(v))
        return v.map(stable);
    if (v && typeof v === 'object') {
        return Object.fromEntries(
            Object.keys(v).sort().map(k => [k, stable(v[k])]));
    }
    return v;
}

/**
 * @param {string} label - what is being checked
 * @param {*} actual - what came back
 * @param {*} expected - what should have
 */
function is(label, actual, expected) {
    ran++;
    const a = JSON.stringify(stable(actual));
    const b = JSON.stringify(stable(expected));
    if (a === b) {
        print(`ok   ${label}`);
    } else {
        failed++;
        print(`FAIL ${label}`);
        print(`       expected ${b}`);
        print(`       got      ${a}`);
    }
}

/** @param {string} name - fixture file name @returns {string} its contents */
function fixture(name) {
    const path = GLib.build_filenamev([HERE, 'fixtures', name]);
    const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
    return new TextDecoder().decode(bytes);
}

/**
 * One output line, rendered through the format brscan-skey-exe uses:
 * ` %-18s: %-20s: %-20s %s`. Verified byte-for-byte against
 * fixtures/list-net-active.txt, so lines built here are the real thing for any
 * field values — which is what makes the cases below more than guesses about
 * hardware nobody here has.
 *
 * @param {string} name - model
 * @param {string} device - SANE device URI
 * @param {string} ip - address, empty for USB
 * @param {string} status - status phrase
 * @returns {string} the line, without its newline
 */
function line(name, device, ip, status) {
    const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
    return ` ${pad(name, 18)}: ${pad(device, 20)}: ${pad(ip, 20)} ${status}`;
}

/* --- the captures --------------------------------------------------------- */

// Real output, `brscan-skey -l > tests/fixtures/list-net-active.txt` on the
// development machine (brscan-skey 0.3.4-0, MFC-J5335DW at 192.168.1.3).
is('captured: network device, Active',
    Skey.parseDeviceList(fixture('list-net-active.txt')),
    {
        devices: [{
            name: 'MFC-J5335DW',
            device: 'brother4:net1;dev0',
            ip: '192.168.1.3',
            status: 'Active',
            responded: true,
        }],
        skipped: [],
    });

// The same device, as it read while it was not answering — the line recorded in
// issue 2.1 and design.md §1. Re-rendered rather than re-captured: getting the
// printer back into that state on demand is not something a test can do, and
// the format above reproduces the capture exactly.
is('captured: network device, Not responded',
    Skey.parseDeviceList(fixture('list-net-not-responded.txt')),
    {
        devices: [{
            name: 'MFC-J5335DW',
            device: 'brother4:net1;dev0',
            ip: '192.168.1.3',
            status: 'Not responded',
            responded: false,
        }],
        skipped: [],
    });

/* --- shapes this machine cannot produce ----------------------------------- */

// USB: no address at all, so the third column is blank and the status is all
// that is left of it. `Active` is the dangerous one — a single word with no
// spaces, which reads exactly like an address unless it is recognised.
for (const status of ['Active', 'Not responded', 'Not registered']) {
    is(`usb device, ${status}`,
        Skey.parseDeviceList(`\n${line('MFC-J5335DW', 'brother4:bus1;dev1', '', status)}\n`),
        {
            devices: [{
                name: 'MFC-J5335DW',
                device: 'brother4:bus1;dev1',
                ip: null,
                status,
                responded: status === 'Active',
            }],
            skipped: [],
        });
}

// A model name past the 18-character column leaves no space before the colon,
// and shifts every column after it.
is('model name overflowing its column',
    Skey.parseDeviceList(`\n${line('MFC-J5335DW-SUPER-LONG', 'brother5:net1;dev0', '192.168.1.9', 'Active')}\n`),
    {
        devices: [{
            name: 'MFC-J5335DW-SUPER-LONG',
            device: 'brother5:net1;dev0',
            ip: '192.168.1.9',
            status: 'Active',
            responded: true,
        }],
        skipped: [],
    });

// An address long enough to eat its own padding: one space left between the
// columns, where every other line has ten.
is('address overflowing its column',
    Skey.parseDeviceList(`\n${line('MFC-J5335DW', 'brother4:net1;dev0', 'a-very-long-hostname.example.invalid', 'Active')}\n`),
    {
        devices: [{
            name: 'MFC-J5335DW',
            device: 'brother4:net1;dev0',
            ip: 'a-very-long-hostname.example.invalid',
            status: 'Active',
            responded: true,
        }],
        skipped: [],
    });

// A status this file has never seen — a later firmware, or a localised build.
// It is carried through for display, and does *not* mark the device unusable:
// only the phrases known to be bad do that.
is('unknown status is opaque, and not a failure',
    Skey.parseDeviceList(`\n${line('MFC-J5335DW', 'brother4:net1;dev0', '192.168.1.3', 'Ne répond pas')}\n`)
        .devices[0],
    {
        name: 'MFC-J5335DW',
        device: 'brother4:net1;dev0',
        ip: '192.168.1.3',
        status: 'Ne répond pas',
        responded: true,
    });

/* --- damage --------------------------------------------------------------- */

is('empty output',
    Skey.parseDeviceList(''), {devices: [], skipped: []});
is('blank lines only',
    Skey.parseDeviceList('\n\n   \n'), {devices: [], skipped: []});
is('undefined output',
    Skey.parseDeviceList(undefined), {devices: [], skipped: []});

// The point of the whole exercise: one line nobody can read must not cost the
// lines either side of it.
const damaged = [
    '',
    line('MFC-J5335DW', 'brother4:net1;dev0', '192.168.1.3', 'Active'),
    'segmentation fault',
    line('DCP-L2530DW', 'brother4:net2;dev0', '192.168.1.4', 'Not responded'),
    '',
].join('\n');

is('a garbage line between two good ones',
    Skey.parseDeviceList(damaged),
    {
        devices: [
            {
                name: 'MFC-J5335DW',
                device: 'brother4:net1;dev0',
                ip: '192.168.1.3',
                status: 'Active',
                responded: true,
            },
            {
                name: 'DCP-L2530DW',
                device: 'brother4:net2;dev0',
                ip: '192.168.1.4',
                status: 'Not responded',
                responded: false,
            },
        ],
        skipped: ['segmentation fault'],
    });

// Not every unreadable line looks like noise. A truncated one still parses to
// nothing rather than to half a device.
is('a truncated line is skipped, not half-parsed',
    Skey.parseDeviceList(' MFC-J5335DW       : brother4:net1;dev0\n'),
    {devices: [], skipped: [' MFC-J5335DW       : brother4:net1;dev0']});

/* --- the surface listDevices() presents ----------------------------------- */

is('ListFailure names the three ways it can fail',
    Object.values(Skey.ListFailure).sort(), ['exit', 'signal', 'spawn']);

const err = new Skey.ListError(Skey.ListFailure.EXIT, 'boom', {status: 2, stderr: 'x'});
is('ListError carries what the caller has to tell apart',
    {reason: err.reason, status: err.status, signal: err.signal, stderr: err.stderr},
    {reason: 'exit', status: 2, signal: null, stderr: 'x'});
is('ListError is an Error', err instanceof Error, true);

/* --- verdict -------------------------------------------------------------- */

print(failed ? `\n${failed}/${ran} failed` : `\n${ran} passed`);
System.exit(failed ? 1 : 0);
