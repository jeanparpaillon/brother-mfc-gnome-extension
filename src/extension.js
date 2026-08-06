/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Skey from './lib/skey.js';
import {UNAVAILABLE, Unit} from './lib/systemd.js';
import {UNIT_NAME, findBinary, unitText} from './lib/unit.js';

const JOURNAL_CMD = `journalctl --user -u ${UNIT_NAME} -e`;

class Indicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(0.5, _('Brother MFC'));

        this.add_child(new St.Icon({
            iconName: 'scanner-symbolic',
            styleClass: 'system-status-icon',
        }));

        // Cancelled in destroy(): detection is async, and an answer arriving
        // after disable() would touch a menu that is gone.
        this._cancellable = new Gio.Cancellable();
        this._stateKey = null;

        // The service state arrives from the extension, on its own schedule and
        // independently of detection, so it is kept here rather than read: a
        // menu rebuilt by detection has to be able to put it back.
        this._service = {status: _('Scan key service: checking…'), hint: null};
        this._statusItem = null;
        this._hintItem = null;

        // An entirely empty PopupMenu opens as a zero-height popup, which cannot
        // be told apart from a menu that failed to open, so there is always an
        // item — this one until the first detection answers.
        this._setItems([this._infoItem(_('Looking for brscan-skey…'))]);

        // Re-detect whenever the menu is opened, so installing the package is
        // noticed without logging out. The rebuild is skipped when the answer
        // has not changed, which is the usual case.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });

        this._refresh();
    }

    destroy() {
        this._cancellable.cancel();
        super.destroy();
    }

    /**
     * @param {string} status one line of service state
     * @param {?string} hint a command to run, copied to the clipboard on click
     */
    setServiceStatus(status, hint) {
        this._service = {status, hint};
        this._applyServiceStatus();
    }

    async _refresh() {
        let state;
        try {
            state = await Skey.detect(this._cancellable);
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                console.error(`brscan-skey detection failed: ${e}`);
            return;
        }

        if (this._cancellable.is_cancelled())
            return;

        const key = Skey.stateKey(state);
        if (key === this._stateKey)
            return;
        this._stateKey = key;

        // Read by scripts/test-shell.sh; nothing in the extension uses it.
        this._state = state;
        this._rebuild(state);
    }

    _rebuild(state) {
        if (state.ok) {
            // 2.3 replaces the placeholder with the device list. The service
            // state under it is live already: it is what says whether the
            // printer's buttons will reach us at all.
            this._statusItem = this._infoItem('');
            this._hintItem = new PopupMenu.PopupMenuItem('');
            this._hintItem.connect('activate', () => this._copyHint());

            this._setItems([
                this._infoItem(_('No devices yet')),
                new PopupMenu.PopupSeparatorMenuItem(),
                this._statusItem,
                this._hintItem,
            ]);
            this._applyServiceStatus();
            return;
        }

        // Nothing else: a greyed-out device list or service toggle on a machine
        // that cannot scan is indistinguishable from an extension that is broken.
        // The packages are behind a per-model web form, so pointing at the
        // download page is the whole of what can be offered here.
        this._statusItem = null;
        this._hintItem = null;

        const download = new PopupMenu.PopupMenuItem(_('Get it from Brother…'));
        download.connect('activate', () => this._openDownloadPage());

        this._setItems([
            this._infoItem(Skey.explain(state)),
            new PopupMenu.PopupSeparatorMenuItem(),
            download,
        ]);
    }

    // The hint is shown only when something went wrong, and it is clickable: the
    // useful reaction to a failed unit is to go read its journal, and retyping
    // the invocation from a menu label is not it.
    _applyServiceStatus() {
        if (!this._statusItem)
            return;

        const {status, hint} = this._service;
        this._statusItem.label.text = status;
        this._hintItem.label.text = hint ? _('Copy: %s').format(hint) : '';
        this._hintItem.visible = !!hint;
    }

    _copyHint() {
        if (this._service.hint) {
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, this._service.hint);
        }
    }

    _setItems(items) {
        this.menu.removeAll();
        for (const item of items)
            this.menu.addMenuItem(item);
    }

    _infoItem(text) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        item.label.clutter_text.line_wrap = true;
        item.label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        // A popup is as wide as its widest child, and the explanation runs to a
        // couple of sentences; unbounded it would span the screen.
        item.label.style = 'max-width: 24em;';
        return item;
    }

    _openDownloadPage() {
        try {
            Gio.app_info_launch_default_for_uri(
                Skey.DOWNLOAD_URL, global.create_app_launch_context(0, -1));
        } catch (e) {
            console.error(`could not open ${Skey.DOWNLOAD_URL}: ${e}`);
        }
    }
}

export default class BrotherMFCExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._cancellable = new Gio.Cancellable();
        this._unit = new Unit(UNIT_NAME);
        this._onUnitChanged = this._unit.addListener(() => this._sync());

        this._queue(() => this._startService());
    }

    disable() {
        this._cancellable.cancel();
        this._cancellable = null;

        this._indicator?.destroy();
        this._indicator = null;

        const unit = this._unit;
        this._unit = null;
        if (!unit)
            return;

        unit.removeListener(this._onUnitChanged);
        this._onUnitChanged = null;
        // Stopping is a D-Bus round trip, so it outlives disable() — but it
        // holds nothing from the shell, and _queue() keeps it ordered against
        // the next enable() rather than racing it.
        this._queue(async () => {
            try {
                if (unit.startedByUs)
                    await unit.stop();
            } finally {
                unit.destroy();
            }
        });
    }

    /* One chain for every D-Bus interaction, so a disable() that is still
     * stopping the unit finishes before the enable() that follows it starts the
     * unit again — scripts/test-shell.sh cycles exactly that way. */
    _queue(task) {
        this._pending = (this._pending ?? Promise.resolve())
            .then(task)
            .catch(e => logError(e, UNIT_NAME));
        return this._pending;
    }

    async _startService() {
        const unit = this._unit;
        if (!unit)
            return;

        // Detection decides this, not a bare test for the binary: brscan-skey
        // without its SANE driver registers no device, so the daemon would run
        // and do nothing while the menu is showing the download page. See §2.6.
        let state;
        try {
            state = await Skey.detect(this._cancellable);
        } catch (e) {
            // Cancelled by disable(). Anything logged here fails the test shell,
            // which greps its log for the UUID, and rightly so.
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'brscan-skey detection');
            return;
        }

        if (unit !== this._unit)
            return;
        if (!state.ok) {
            this._indicator?.setServiceStatus(
                _('Scan key service: not started, brscan-skey is incomplete'), null);
            return;
        }

        await unit.init();
        if (unit !== this._unit)
            return;

        // The ::changed handler has already put the reason in the menu, and a
        // unit file that cannot be daemon-reloaded is not worth writing.
        if (!unit.available)
            return;

        // findBinary(), not state.tool: detection reads $BROTHER_MFC_ROOT under
        // test (CONTRIBUTING.md), and a unit is not the place for a fake path.
        const binary = findBinary();
        if (!binary)
            return;

        await unit.writeUnit(unitText(binary));
        await unit.start();
    }

    _sync() {
        const unit = this._unit;
        if (!unit || !this._indicator)
            return;

        let status, hint = null;
        switch (unit.activeState) {
        case 'active':
            status = _('Scan key service: running');
            break;
        case 'activating':
        case 'reloading':
            status = _('Scan key service: starting…');
            break;
        case 'deactivating':
            status = _('Scan key service: stopping…');
            break;
        case 'inactive':
            status = _('Scan key service: stopped');
            break;
        case 'failed':
            // systemd 259 does not rewrite Result when the start limit is hit —
            // it keeps the underlying cause and logs "Start request repeated too
            // quickly" — so the journal, not the label, is where the whole
            // answer is. Older systemd does report start-limit-hit here.
            status = unit.result === 'start-limit-hit'
                ? _('Scan key service: failed, restarting too often')
                : _('Scan key service: failed (%s)').format(unit.result || unit.subState);
            hint = JOURNAL_CMD;
            break;
        case UNAVAILABLE:
        default:
            // An error, not a supported configuration: this extension needs a
            // systemd user manager. It still must not throw — the headless test
            // shell runs on a dbus-run-session bus with no systemd on it, and an
            // exception out of enable() would take the whole extension down.
            status = _('Scan key service: cannot reach systemd');
            hint = JOURNAL_CMD;
            break;
        }

        // A job systemd refused outright — the unit sits wherever it was, which
        // on its own would read as if nothing had been asked of it. A unit that
        // ran and failed says more than the error would, so it keeps its label.
        if (unit.error && unit.available && unit.activeState !== 'failed') {
            status = _('Scan key service: %s').format(unit.error);
            hint = JOURNAL_CMD;
        }

        this._indicator.setServiceStatus(status, hint);
    }
}
