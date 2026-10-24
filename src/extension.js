import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Monitor} from './lib/monitor.js';
import {Ring, Bar} from './lib/ring.js';
import {
    VERTICAL, openUri, accountName, statusPill, OutputDialog, KernelBrowser,
} from './lib/dialogs.js';
import {
    pickResource, pct, levelFor, parseColor, formatHours, formatRemaining, formatAgo,
} from './lib/model.js';

const SETTING_KEYS_REBUILD = [
    'panel-mode', 'panel-resource', 'value-mode', 'show-percent', 'running-badge', 'ring-size', 'ring-stroke',
    'warn-threshold', 'crit-threshold', 'color-ok', 'color-warn', 'color-crit', 'color-track', 'menu-show-individual',
];

function label(text, styleClass, props = {}) {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
}

const Indicator = GObject.registerClass(
class KaggleIndicator extends PanelMenu.Button {
    _init(ext, monitor, settings) {
        super._init(0.5, 'Kaggle Status', false);
        this._ext = ext;
        this._monitor = monitor;
        this._s = settings;

        this._panelBox = new St.BoxLayout({style_class: 'kg-panel', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._panelBox);

        this._buildMenuSkeleton();
        this._unsub = monitor.onChange(() => this._render());
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._render();
        });
        this._render();
    }

    destroy() {
        this._unsub?.();
        this._unsub = null;
        super.destroy();
    }

    // ---------- colours ----------
    _colors() {
        const g = k => parseColor(this._s.get_string(k));
        return {ok: g('color-ok'), warn: g('color-warn'), crit: g('color-crit'), track: g('color-track')};
    }

    _levelColor(percent) {
        const c = this._colors();
        const lvl = levelFor(percent, this._s.get_int('warn-threshold'), this._s.get_int('crit-threshold'));
        return {lvl, fill: c[lvl], track: c.track};
    }

    _shown(q) {
        // value-mode 'left' flips the ring to show what remains; level still follows usage.
        const used = pct(q);
        return this._s.get_string('value-mode') === 'left' ? 100 - used : used;
    }

    // ---------- panel ----------
    _renderPanel() {
        this._panelBox.destroy_all_children();
        const m = this._monitor;
        const res = this._s.get_string('panel-resource');
        const size = this._s.get_int('ring-size');
        const stroke = this._s.get_int('ring-stroke');
        const style = {size, stroke, track: this._colors().track};

        const addRing = (q, dot) => {
            const ring = new Ring();
            ring.applyStyle(style);
            if (q) {
                const used = pct(q);
                ring.setValue(this._shown(q), this._levelColor(used).fill, dot);
            } else {
                ring.setValue(null, this._colors().ok, dot);
            }
            this._panelBox.add_child(ring);
            return ring;
        };

        if (this._s.get_string('panel-mode') === 'per-account') {
            const accts = m.accounts.filter(a => a.enabled);
            if (accts.length === 0)
                addRing(null, null);
            for (const a of accts)
                addRing(pickResource(a.quota, res), parseColor(a.color));
        } else {
            const q = pickResource(m.combined, res);
            addRing(q, null);
            if (this._s.get_boolean('show-percent')) {
                const text = q ? `${Math.round(this._shown(q))}%` : (m.loading ? '…' : '—');
                this._panelBox.add_child(label(text, 'kg-panel-text'));
            }
        }

        const n = m.running.length;
        const badge = this._s.get_string('running-badge');
        if (badge === 'always' || (badge === 'when-running' && n > 0)) {
            const cls = n > 0 ? 'kg-badge kg-badge-active' : 'kg-badge';
            this._panelBox.add_child(label(`▶ ${n}`, cls));
        }
    }

    // ---------- menu ----------
    _buildMenuSkeleton() {
        this.menu.box.add_style_class_name('kg-menu');
        const wrap = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'kg-wrap-item'});
        this._body = new St.BoxLayout({...VERTICAL, style_class: 'kg-body', x_expand: true});
        wrap.add_child(this._body);
        this.menu.addMenuItem(wrap);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const browse = this.menu.addAction('Browse & run kernels…', () => this._openBrowser());
        browse.add_style_class_name('kg-action');
        this.menu.addAction('Open Kaggle', () => openUri('https://www.kaggle.com/code'));
        this.menu.addAction('Settings', () => this._ext.openPreferences());
    }

    _openBrowser() {
        this.menu.close();
        if (this._monitor.accounts.filter(a => a.enabled).length === 0) {
            Main.notify('Kaggle Status', 'No accounts found. Add token files in Settings → Accounts.');
            return;
        }
        new KernelBrowser(this._monitor, this._s, (acct, kernel) => this.openOutput(acct, kernel)).open();
    }

    openOutput(acct, kernel) {
        this.menu.close();
        new OutputDialog(this._monitor, this._s, acct, kernel).open();
    }

    _quotaRow(name, q) {
        const row = new St.BoxLayout({...VERTICAL, style_class: 'kg-quota-row', x_expand: true});
        const top = new St.BoxLayout({x_expand: true});
        top.add_child(label(name, 'kg-key'));
        const used = pct(q);
        const txt = q
            ? `${formatHours(q.used + q.reserved)} / ${formatHours(q.total)}  ·  ${Math.round(used)}%`
            : 'not available';
        top.add_child(label(txt, 'kg-value', {x_expand: true, x_align: Clutter.ActorAlign.END}));
        row.add_child(top);
        const bar = new Bar(6);
        const {fill, track} = this._levelColor(used);
        bar.setValue(q ? used : 0, fill, track);
        row.add_child(bar);
        return row;
    }

    _renderMenu() {
        const m = this._monitor;
        const body = this._body;
        body.destroy_all_children();

        // header
        const head = new St.BoxLayout({style_class: 'kg-head', x_expand: true});
        const titles = new St.BoxLayout({...VERTICAL, x_expand: true});
        titles.add_child(label('Kaggle', 'kg-title', {x_align: Clutter.ActorAlign.START}));
        const upd = m.loading ? 'Updating…' : m.lastUpdate ? `Updated ${formatAgo(new Date(m.lastUpdate).toISOString())}` : 'Not updated yet';
        titles.add_child(label(upd, 'kg-sub', {x_align: Clutter.ActorAlign.START}));
        head.add_child(titles);
        const refresh = new St.Button({
            style_class: 'kg-icon-btn', can_focus: true, reactive: true,
            child: new St.Icon({icon_name: 'view-refresh-symbolic', style_class: 'popup-menu-icon'}),
        });
        refresh.connect('clicked', () => m.refresh({reload: true, full: true}));
        head.add_child(refresh);
        body.add_child(head);

        const enabled = m.accounts.filter(a => a.enabled);
        if (m.accounts.length === 0 && !m.loading) {
            body.add_child(label(`No token files found in\n${m.tokenDir}`, 'kg-warn'));
            return;
        }

        // combined quota
        const card = new St.BoxLayout({...VERTICAL, style_class: 'kg-card', x_expand: true});
        const cardHead = new St.BoxLayout({x_expand: true});
        cardHead.add_child(label(enabled.length > 1 ? `Combined · ${enabled.length} accounts` : 'Weekly quota', 'kg-card-title', {x_expand: true}));
        const reset = enabled.map(a => a.quota?.refresh).filter(Boolean).sort()[0];
        if (reset)
            cardHead.add_child(label(`resets in ${formatRemaining(reset)}`, 'kg-sub'));
        card.add_child(cardHead);
        card.add_child(this._quotaRow('GPU', pickResource(m.combined, 'gpu')));
        card.add_child(this._quotaRow('TPU', pickResource(m.combined, 'tpu')));
        body.add_child(card);

        // individual accounts
        if (this._s.get_boolean('menu-show-individual')) {
            for (const a of m.accounts)
                body.add_child(this._accountCard(a));
        }

        // running sessions
        body.add_child(label(m.running.length > 0 ? `Running now · ${m.running.length}` : 'Nothing running', 'kg-section'));
        for (const r of m.running)
            body.add_child(this._runningRow(r));
    }

    _accountCard(a) {
        const card = new St.BoxLayout({...VERTICAL, style_class: `kg-card kg-account${a.enabled ? '' : ' kg-disabled'}`, x_expand: true});
        const head = new St.BoxLayout({x_expand: true});
        const dot = new St.Widget({style_class: 'kg-dot', y_align: Clutter.ActorAlign.CENTER});
        dot.style = `background-color: ${a.color};`;
        head.add_child(dot);
        head.add_child(label(accountName(a), 'kg-card-title', {x_expand: true}));
        const running = this._monitor.running.filter(r => r.account === a).length;
        if (running > 0)
            head.add_child(label(`▶ ${running}`, 'kg-badge kg-badge-active'));
        else if (!a.enabled)
            head.add_child(label('disabled', 'kg-sub'));
        card.add_child(head);
        if (a.username && a.alias)
            card.add_child(label(`@${a.username}`, 'kg-sub', {x_align: Clutter.ActorAlign.START}));
        if (a.error) {
            card.add_child(label(a.error, 'kg-warn'));
        } else if (a.enabled) {
            card.add_child(this._quotaRow('GPU', pickResource(a.quota, 'gpu')));
            card.add_child(this._quotaRow('TPU', pickResource(a.quota, 'tpu')));
        }
        return card;
    }

    _runningRow(r) {
        const row = new St.Button({style_class: 'kg-run-row', can_focus: true, reactive: true, x_expand: true});
        const box = new St.BoxLayout({x_expand: true});
        const dot = new St.Widget({style_class: 'kg-dot', y_align: Clutter.ActorAlign.CENTER});
        dot.style = `background-color: ${r.account.color};`;
        box.add_child(dot);
        const t = new St.BoxLayout({...VERTICAL, x_expand: true});
        const title = label(r.title || r.slug, 'kg-kernel-title', {x_align: Clutter.ActorAlign.START});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        t.add_child(title);
        t.add_child(label(`${r.ref} · ${accountName(r.account)}`, 'kg-sub', {x_align: Clutter.ActorAlign.START}));
        box.add_child(t);
        box.add_child(statusPill(r.status));
        row.set_child(box);
        row.connect('clicked', () => this.openOutput(r.account, {owner: r.owner, slug: r.slug, title: r.title, ref: r.ref}));
        return row;
    }

    _render() {
        this._renderPanel();
        if (this.menu.isOpen)
            this._renderMenu();
    }
});

export default class KaggleStatusExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._monitor = new Monitor(this._settings, (title, body) => Main.notify(title, body));
        this._addIndicator();

        this._rebuildId = 0;
        this._ids = [];
        const queueRebuild = () => {
            if (this._rebuildId)
                return;
            this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                this._rebuildId = 0;
                this._indicator?.destroy();
                this._addIndicator();
                return GLib.SOURCE_REMOVE;
            });
        };
        for (const k of ['panel-position', 'panel-index'])
            this._ids.push(this._settings.connect(`changed::${k}`, queueRebuild));
        for (const k of SETTING_KEYS_REBUILD)
            this._ids.push(this._settings.connect(`changed::${k}`, () => this._indicator?._render()));
        for (const k of ['token-dir', 'accounts-config'])
            this._ids.push(this._settings.connect(`changed::${k}`, () => this._monitor.refresh({reload: true, full: true})));
        for (const k of ['poll-interval', 'session-check-count', 'active-poll-interval'])
            this._ids.push(this._settings.connect(`changed::${k}`, () => this._monitor.refresh({full: true})));

        this._monitor.start();
    }

    _addIndicator() {
        this._indicator = new Indicator(this, this._monitor, this._settings);
        const pos = this._settings.get_string('panel-position');
        Main.panel.addToStatusArea(this.uuid, this._indicator, this._settings.get_int('panel-index'), pos);
    }

    disable() {
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = 0;
        for (const id of this._ids ?? [])
            this._settings.disconnect(id);
        this._ids = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._monitor?.stop();
        this._monitor = null;
        this._settings = null;
    }
}
