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
            // 2.3 fills this in with the device list and the service state.
            this._setItems([this._infoItem(_('No devices yet'))]);
            return;
        }

        // Nothing else: a greyed-out device list or service toggle on a machine
        // that cannot scan is indistinguishable from an extension that is broken.
        // The packages are behind a per-model web form, so pointing at the
        // download page is the whole of what can be offered here.
        const download = new PopupMenu.PopupMenuItem(_('Get it from Brother…'));
        download.connect('activate', () => this._openDownloadPage());

        this._setItems([
            this._infoItem(Skey.explain(state)),
            new PopupMenu.PopupSeparatorMenuItem(),
            download,
        ]);
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
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
