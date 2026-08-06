/* lib/systemd.js
 *
 * A small org.freedesktop.systemd1 client: write a user unit, start and stop
 * it, and follow its state.
 *
 * Nothing here imports resource:///org/gnome/shell/*, so the module also loads
 * under plain gjs — scripts/systemd-probe.js drives it that way against the
 * real user manager, which a headless test shell cannot do (see
 * CONTRIBUTING.md).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

const SYSTEMD_NAME = 'org.freedesktop.systemd1';
const SYSTEMD_PATH = '/org/freedesktop/systemd1';
const MANAGER_IFACE = 'org.freedesktop.systemd1.Manager';
const UNIT_IFACE = 'org.freedesktop.systemd1.Unit';
const SERVICE_IFACE = 'org.freedesktop.systemd1.Service';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

/* ActiveState as systemd reports it, plus one value of our own for "systemd
 * could not be reached at all". That is an error — a systemd user manager is a
 * requirement here — but it has to be a reportable one rather than a thrown
 * exception, because the headless test shell runs on a dbus-run-session bus
 * where systemd is genuinely absent. */
export const UNAVAILABLE = 'unavailable';

/* Gio._promisify() patches prototypes process-wide, which an extension has no
 * business doing to the shell; wrap the callbacks by hand instead. */
function _finish(obj, finishMethod, res, resolve, reject) {
    try {
        resolve(obj[finishMethod](res));
    } catch (e) {
        reject(e);
    }
}

function callAsync(obj, startMethod, finishMethod, args) {
    return new Promise((resolve, reject) => {
        obj[startMethod](...args, (source, res) =>
            _finish(obj, finishMethod, res, resolve, reject));
    });
}

/**
 * A systemd user unit this extension owns: the file it is generated into, and
 * the manager calls that drive it.
 */
export class Unit extends GObject.Object {
    static {
        GObject.registerClass({
            Signals: {'changed': {}},
        }, this);
    }

    /**
     * @param {string} name unit name, e.g. 'brscan-skey.service'
     */
    constructor(name) {
        super();

        this._name = name;
        this._file = Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'systemd', 'user', name]));

        this._bus = null;
        this._unitPath = null;
        this._propsId = 0;
        this._cancellable = new Gio.Cancellable();

        this._activeState = UNAVAILABLE;
        this._subState = '';
        this._result = '';
        this._error = null;
        this._startedByUs = false;
    }

    get name() {
        return this._name;
    }

    get path() {
        return this._file.get_path();
    }

    /** systemd's ActiveState, or UNAVAILABLE when systemd is out of reach. */
    get activeState() {
        return this._activeState;
    }

    get subState() {
        return this._subState;
    }

    /** systemd's Result — 'start-limit-hit', 'exit-code', … — or ''. */
    get result() {
        return this._result;
    }

    /** Message from the last failed call, or null. */
    get error() {
        return this._error;
    }

    get available() {
        return this._activeState !== UNAVAILABLE;
    }

    /** True once we started it ourselves, so disable() knows what to stop. */
    get startedByUs() {
        return this._startedByUs;
    }

    /**
     * Connect, subscribe to unit state, and read the current state.
     *
     * @returns {Promise<boolean>} false when systemd could not be reached — an
     *   error, but one the caller reports rather than one that is thrown.
     */
    async init() {
        try {
            this._bus = Gio.DBus.session;
            if (!await this._nameHasOwner(SYSTEMD_NAME)) {
                this._fail(`${SYSTEMD_NAME} is not on the session bus`);
                return false;
            }

            // systemd only emits PropertiesChanged for units while at least one
            // client holds a Subscribe(); without this the menu would go stale
            // the moment the service changes state on its own.
            await this._manager('Subscribe', null).catch(() => {});

            // LoadUnit rather than GetUnit: GetUnit answers NoSuchUnit for a
            // unit that is merely not running yet.
            const [path] = (await this._manager('LoadUnit',
                new GLib.Variant('(s)', [this._name]))).deepUnpack();
            this._unitPath = path;

            this._propsId = this._bus.signal_subscribe(
                SYSTEMD_NAME, PROPERTIES_IFACE, 'PropertiesChanged',
                this._unitPath, null, Gio.DBusSignalFlags.NONE,
                () => this.refresh().catch(e => this._fail(e.message)));

            await this.refresh();
            return true;
        } catch (e) {
            this._fail(e.message);
            return false;
        }
    }

    /**
     * Write the unit file if it is absent or differs, then daemon-reload.
     *
     * @param {string} contents the unit file to generate
     * @returns {Promise<boolean>} true if the file was written
     */
    async writeUnit(contents) {
        if (await this._readUnit() === contents)
            return false;

        GLib.mkdir_with_parents(this._file.get_parent().get_path(), 0o755);
        await callAsync(this._file, 'replace_contents_async', 'replace_contents_finish',
            [new TextEncoder().encode(contents), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable]);

        if (this.available)
            await this._manager('Reload', null);
        return true;
    }

    /**
     * Start the unit — unless it is already up, in which case we leave it
     * alone and do not claim ownership of it: something else started it, and
     * disable() must not take it down.
     *
     * @returns {Promise<void>}
     */
    async start() {
        if (!this.available)
            return;
        if (['active', 'activating', 'reloading'].includes(this._activeState))
            return;

        // Claimed before the call, not after: a StartUnit that times out may
        // still have left a job running, and that job is ours to clean up.
        this._startedByUs = true;
        await this._job('StartUnit');
    }

    /**
     * @returns {Promise<void>}
     */
    async stop() {
        if (!this.available)
            return;

        this._startedByUs = false;
        await this._job('StopUnit');
    }

    /**
     * Re-read ActiveState, SubState and Result, and emit ::changed if any of
     * them moved.
     *
     * @returns {Promise<void>}
     */
    async refresh() {
        if (!this._unitPath)
            return;

        const [unitProps, result] = await Promise.all([
            this._properties('GetAll', new GLib.Variant('(s)', [UNIT_IFACE])),
            this._properties('Get', new GLib.Variant('(ss)', [SERVICE_IFACE, 'Result'])),
        ]);

        const props = unitProps.deepUnpack()[0];
        this._update(
            props['ActiveState']?.deepUnpack() ?? UNAVAILABLE,
            props['SubState']?.deepUnpack() ?? '',
            result.deepUnpack()[0].deepUnpack());
    }

    destroy() {
        this._cancellable.cancel();
        if (this._propsId) {
            this._bus.signal_unsubscribe(this._propsId);
            this._propsId = 0;
        }
        this._bus = null;
        this._unitPath = null;
    }

    async _readUnit() {
        try {
            const [, bytes] = await callAsync(this._file,
                'load_contents_async', 'load_contents_finish', [this._cancellable]);
            return new TextDecoder().decode(bytes);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                logError(e, `reading ${this.path}`);
            return null;
        }
    }

    async _job(method) {
        try {
            await this._manager(method, new GLib.Variant('(ss)', [this._name, 'replace']));
            this._error = null;
        } catch (e) {
            // A refused job says nothing about whether systemd is reachable —
            // it plainly is — so this must not fall back to UNAVAILABLE.
            this._setError(e.message);
            throw e;
        } finally {
            // The reply means the job was queued, not that it finished; the
            // PropertiesChanged subscription carries the rest. This refresh is
            // only so the menu is right even if Subscribe() did not take.
            await this.refresh().catch(() => {});
        }
    }

    _manager(method, params) {
        return this._call(SYSTEMD_PATH, MANAGER_IFACE, method, params);
    }

    _properties(method, params) {
        return this._call(this._unitPath, PROPERTIES_IFACE, method, params);
    }

    _call(path, iface, method, params) {
        return callAsync(this._bus, 'call', 'call_finish', [
            SYSTEMD_NAME, path, iface, method, params, null,
            Gio.DBusCallFlags.NONE, -1, this._cancellable,
        ]);
    }

    async _nameHasOwner(name) {
        const reply = await callAsync(this._bus, 'call', 'call_finish', [
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'NameHasOwner', new GLib.Variant('(s)', [name]), null,
            Gio.DBusCallFlags.NONE, -1, this._cancellable,
        ]);
        return reply.deepUnpack()[0];
    }

    /** systemd is out of reach: there is no unit state left to report. */
    _fail(message) {
        this._error = message;
        if (!this._update(UNAVAILABLE, '', ''))
            this.emit('changed');
    }

    _setError(message) {
        this._error = message;
        this.emit('changed');
    }

    /**
     * @returns {boolean} whether anything moved, and ::changed was emitted
     */
    _update(activeState, subState, result) {
        if (activeState === this._activeState && subState === this._subState &&
            result === this._result)
            return false;

        this._activeState = activeState;
        this._subState = subState;
        this._result = result;
        this.emit('changed');
        return true;
    }
}
