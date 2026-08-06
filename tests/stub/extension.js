/* tests/stub/extension.js — enough of the shell's extension.js to import a
 * lib/ module outside the shell.
 *
 * Registered as a GResource at resource:///org/gnome/shell/extensions/
 * extension.js by tests/run.js, so that the real import statement in
 * src/lib/*.js resolves under a plain gjs. Nothing here pretends to behave like
 * the shell's version; it exists so that importing does not fail.
 *
 * Grow it when a module under test needs more than this.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const gettext = str => str;
export const ngettext = (one, many, n) => (n === 1 ? one : many);
export const pgettext = (context, str) => str;
