#!/usr/bin/gjs -m
/* systemd-probe.js
 *
 * Drives src/lib/systemd.js from outside GNOME Shell, so the unit handling can
 * be tested against the real user manager — the headless test shell runs on a
 * dbus-run-session bus, where systemd is not reachable at all.
 *
 * Usage: gjs -m scripts/systemd-probe.js <state|install|start|stop|lifecycle> [unit]
 *
 * The unit defaults to brscan-skey.service and is generated; naming another one
 * drives an existing unit without writing anything, which is how the failed and
 * start-limit-hit states get exercised without breaking the real service.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GLib from 'gi://GLib';
import system from 'system';

import {Unit} from '../src/lib/systemd.js';
import {UNIT_NAME, findBinary, unitText} from '../src/lib/unit.js';

const TIMEOUT_MS = 15000;

function report(unit, phase) {
    print(`${phase}: state=${unit.activeState} sub=${unit.subState} ` +
        `result=${unit.result} startedByUs=${unit.startedByUs} ` +
        `error=${unit.error ?? ''}`);
}

/* Resolves when the unit reaches one of `states`, driven by ::changed — the
 * same signal the menu is driven by, so a hang here is a real bug and not a
 * missing poll. */
function waitFor(unit, states) {
    if (states.includes(unit.activeState))
        return Promise.resolve();

    return new Promise((resolve, reject) => {
        const id = unit.connect('changed', () => {
            if (!states.includes(unit.activeState))
                return;
            unit.disconnect(id);
            GLib.source_remove(timeout);
            resolve();
        });
        const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMEOUT_MS, () => {
            unit.disconnect(id);
            reject(new Error(`timed out waiting for ${states} (still ${unit.activeState})`));
            return GLib.SOURCE_REMOVE;
        });
    });
}

function settle(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function main(command, unitName) {
    const binary = findBinary();
    if (!binary)
        throw new Error('brscan-skey is not installed');

    const unit = new Unit(unitName);
    if (!await unit.init())
        throw new Error(`cannot reach systemd: ${unit.error}`);

    const write = async () => {
        if (unitName === UNIT_NAME)
            await unit.writeUnit(unitText(binary));
    };

    switch (command) {
    case 'state':
        report(unit, 'state');
        break;

    case 'install':
        print(`written=${await unit.writeUnit(unitText(binary))} path=${unit.path}`);
        break;

    // Start something that is going to fail, and report what the menu would
    // have to say about it.
    case 'expect-failure':
        await unit.start().catch(e => print(`start refused: ${e.message}`));
        await waitFor(unit, ['failed', 'inactive']);
        // The first failure is not the last word — systemd restarts it — so let
        // the loop run out before reporting what a user would end up looking at.
        await settle(2000);
        await unit.refresh();
        report(unit, 'failure');
        break;

    case 'start':
        await write();
        await unit.start();
        await waitFor(unit, ['active', 'failed']);
        report(unit, 'start');
        break;

    case 'stop':
        await unit.stop();
        await waitFor(unit, ['inactive', 'failed']);
        report(unit, 'stop');
        break;

    // What enable() then disable() does, in one process: ownership only lives
    // for as long as the extension does.
    case 'lifecycle':
        await write();
        await unit.start();
        await waitFor(unit, ['active', 'failed']);
        report(unit, 'enable');

        if (unit.startedByUs) {
            await unit.stop();
            await waitFor(unit, ['inactive', 'failed']);
        }
        report(unit, 'disable');
        break;

    default:
        throw new Error(`unknown command: ${command}`);
    }

    unit.destroy();
}

const loop = new GLib.MainLoop(null, false);
let status = 0;

main(system.programArgs[0] ?? 'state', system.programArgs[1] ?? UNIT_NAME)
    .catch(e => {
        printerr(e.message);
        status = 1;
    })
    .finally(() => loop.quit());

loop.run();
system.exit(status);
