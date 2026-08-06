/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

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

        // The menu is a placeholder until there is something to put in it. An
        // entirely empty PopupMenu opens as a zero-height popup, which cannot be
        // told apart from a menu that failed to open, so it carries one
        // insensitive item.
        this.menu.addMenuItem(
            new PopupMenu.PopupMenuItem(_('No actions yet'), {reactive: false}));
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
