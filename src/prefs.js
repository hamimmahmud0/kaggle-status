import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {loadTokenDir} from './lib/kaggleClient.js';
import {defaultTokenDir} from './lib/monitor.js';
import {parseJson, parseColor, toHex, ACCOUNT_PALETTE} from './lib/model.js';

function rgba(hex) {
    const [r, g, b, a] = parseColor(hex);
    return new Gdk.RGBA({red: r, green: g, blue: b, alpha: a});
}

function colorButton(settings, key) {
    const btn = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({with_alpha: true}), valign: Gtk.Align.CENTER});
    btn.set_rgba(rgba(settings.get_string(key)));
    btn.connect('notify::rgba', () => {
        const c = btn.get_rgba();
        settings.set_string(key, toHex([c.red, c.green, c.blue, c.alpha]));
    });
    return btn;
}

function colorRow(settings, key, title) {
    const row = new Adw.ActionRow({title});
    row.add_suffix(colorButton(settings, key));
    return row;
}

function comboRow(settings, key, title, options, subtitle = '') {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(options.map(o => o[1]))});
    const sync = () => {
        const i = options.findIndex(o => o[0] === settings.get_string(key));
        row.selected = i >= 0 ? i : 0;
    };
    sync();
    row.connect('notify::selected', () => settings.set_string(key, options[row.selected][0]));
    settings.connect(`changed::${key}`, sync);
    return row;
}

function spinRow(settings, key, title, subtitle, lo, hi, step = 1) {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({lower: lo, upper: hi, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class KaggleStatusPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window.set_default_size(680, 780);
        window.add(this._accountsPage(s, window));
        window.add(this._panelPage(s));
        window.add(this._generalPage(s, window));
        window.add(this._kernelsPage(s));
    }

    _generalPage(s, window) {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const src = new Adw.PreferencesGroup({title: 'Tokens', description: 'One file per account. Files are read in place and never copied.'});
        const dirRow = new Adw.EntryRow({title: 'Token directory', text: s.get_string('token-dir') || defaultTokenDir()});
        dirRow.connect('apply', () => s.set_string('token-dir', dirRow.text.trim()));
        dirRow.set_show_apply_button(true);
        const pick = new Gtk.Button({icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        pick.connect('clicked', () => {
            const dlg = new Gtk.FileDialog({title: 'Token directory'});
            dlg.select_folder(window, null, (d, res) => {
                try {
                    const f = d.select_folder_finish(res);
                    s.set_string('token-dir', f.get_path());
                    dirRow.text = f.get_path();
                } catch (_e) { /* cancelled */ }
            });
        });
        dirRow.add_suffix(pick);
        src.add(dirRow);
        page.add(src);

        const poll = new Adw.PreferencesGroup({title: 'Refresh'});
        poll.add(spinRow(s, 'poll-interval', 'Refresh interval', 'Seconds between quota checks while idle', 15, 3600, 5));
        poll.add(spinRow(s, 'active-poll-interval', 'Refresh while running', 'Seconds between checks while a session is active', 5, 300, 5));
        poll.add(spinRow(s, 'session-check-count', 'Kernels checked per account',
            'Most recent kernels whose session status is polled. 0 disables running-session detection.', 0, 30));
        poll.add(switchRow(s, 'notify-on-finish', 'Notify when a session finishes'));
        page.add(poll);
        return page;
    }

    _panelPage(s) {
        const page = new Adw.PreferencesPage({title: 'Panel', icon_name: 'view-app-grid-symbolic'});

        const layout = new Adw.PreferencesGroup({title: 'Indicator'});
        layout.add(comboRow(s, 'panel-mode', 'Rings', [['combined', 'One combined ring'], ['per-account', 'One ring per account']],
            'Combined sums every enabled account'));
        layout.add(comboRow(s, 'panel-resource', 'Resource', [['gpu', 'GPU'], ['tpu', 'TPU'], ['worst', 'Whichever is fuller']]));
        layout.add(comboRow(s, 'value-mode', 'Ring shows', [['used', 'Quota used'], ['left', 'Quota left']]));
        layout.add(switchRow(s, 'show-percent', 'Show percentage text', 'Combined mode only'));
        layout.add(comboRow(s, 'running-badge', 'Running-kernels badge',
            [['when-running', 'Only while something runs'], ['always', 'Always'], ['never', 'Never']]));
        page.add(layout);

        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        look.add(spinRow(s, 'ring-size', 'Ring size', 'Pixels', 12, 48));
        look.add(spinRow(s, 'ring-stroke', 'Ring thickness', 'Pixels', 2, 10));
        look.add(spinRow(s, 'warn-threshold', 'Warning at', 'Percent used', 1, 100));
        look.add(spinRow(s, 'crit-threshold', 'Critical at', 'Percent used', 1, 100));
        look.add(colorRow(s, 'color-ok', 'Normal colour'));
        look.add(colorRow(s, 'color-warn', 'Warning colour'));
        look.add(colorRow(s, 'color-crit', 'Critical colour'));
        look.add(colorRow(s, 'color-track', 'Ring track colour'));
        page.add(look);

        const place = new Adw.PreferencesGroup({title: 'Position'});
        place.add(comboRow(s, 'panel-position', 'Panel area', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]));
        place.add(spinRow(s, 'panel-index', 'Order in area', '0 is the outermost slot', 0, 20));
        page.add(place);

        const menu = new Adw.PreferencesGroup({title: 'Menu'});
        menu.add(switchRow(s, 'menu-show-individual', 'Show individual accounts', 'Per-account quota cards under the combined total'));
        page.add(menu);
        return page;
    }

    _accountsPage(s, window) {
        const page = new Adw.PreferencesPage({title: 'Accounts', icon_name: 'system-users-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Accounts',
            description: 'Each file in the token directory is one account. Name, colour and enable state are stored here; tokens are not.',
        });
        page.add(group);
        const rows = [];
        const rebuild = async () => {
            for (const r of rows)
                group.remove(r);
            rows.length = 0;
            const dir = s.get_string('token-dir') || defaultTokenDir();
            const tokens = await loadTokenDir(dir);
            const cfg = parseJson(s.get_string('accounts-config'), {});
            const info = parseJson(s.get_string('accounts-info'), {});
            if (tokens.length === 0) {
                const empty = new Adw.ActionRow({title: 'No token files found', subtitle: dir});
                group.add(empty);
                rows.push(empty);
            }
            tokens.forEach((t, i) => {
                const c = cfg[t.id] ?? {};
                const save = patch => {
                    const cur = parseJson(s.get_string('accounts-config'), {});
                    cur[t.id] = {...(cur[t.id] ?? {}), ...patch};
                    s.set_string('accounts-config', JSON.stringify(cur));
                };
                const user = info[t.id]?.username;
                const exp = new Adw.ExpanderRow({
                    title: c.alias || user || `Account ${t.id}`,
                    subtitle: `${t.id}${user ? ` · @${user}` : ''}`,
                    show_enable_switch: true,
                    enable_expansion: c.enabled !== false,
                });
                exp.connect('notify::enable-expansion', () => save({enabled: exp.enable_expansion}));
                const alias = new Adw.EntryRow({title: 'Display name', text: c.alias ?? ''});
                alias.connect('changed', () => save({alias: alias.text}));
                exp.add_row(alias);
                const col = new Adw.ActionRow({title: 'Colour'});
                const btn = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog(), valign: Gtk.Align.CENTER});
                btn.set_rgba(rgba(c.color || ACCOUNT_PALETTE[i % ACCOUNT_PALETTE.length]));
                btn.connect('notify::rgba', () => {
                    const k = btn.get_rgba();
                    save({color: toHex([k.red, k.green, k.blue])});
                });
                col.add_suffix(btn);
                exp.add_row(col);
                group.add(exp);
                rows.push(exp);
            });
        };
        rebuild();
        const reload = new Gtk.Button({label: 'Rescan', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        reload.connect('clicked', () => rebuild());
        group.set_header_suffix(reload);
        s.connect('changed::token-dir', () => rebuild());
        s.connect('changed::accounts-info', () => {
            // usernames resolve after the first poll; refresh titles without losing edits
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                rebuild();
                return GLib.SOURCE_REMOVE;
            });
        });
        return page;
    }

    _kernelsPage(s) {
        const page = new Adw.PreferencesPage({title: 'Kernels', icon_name: 'utilities-terminal-symbolic'});
        const run = new Adw.PreferencesGroup({
            title: 'Running kernels with another account',
            description: 'The kernel source is copied into the chosen account and run there, using that account’s quota.',
        });
        run.add(switchRow(s, 'run-private', 'Create copies as private'));
        run.add(switchRow(s, 'run-internet', 'Allow internet access', 'Only if the original kernel had it enabled'));
        page.add(run);

        const browse = new Adw.PreferencesGroup({title: 'Browser'});
        browse.add(spinRow(s, 'browser-page-size', 'Kernels per page', '', 10, 100, 5));
        browse.add(comboRow(s, 'browser-sort', 'Sort own kernels by', [
            ['DATE_RUN', 'Last run'], ['DATE_CREATED', 'Created'], ['HOTNESS', 'Hotness'], ['VOTE_COUNT', 'Votes'], ['VIEW_COUNT', 'Views'],
        ]));
        page.add(browse);

        const out = new Adw.PreferencesGroup({title: 'Output viewer'});
        out.add(spinRow(s, 'output-refresh', 'Refresh interval', 'Seconds, while the session is active', 2, 60));
        out.add(spinRow(s, 'output-font-size', 'Log font size', 'Points', 8, 20));
        out.add(spinRow(s, 'output-max-chars', 'Maximum characters shown', 'Older log text is hidden', 2000, 500000, 2000));
        page.add(out);
        return page;
    }
}
