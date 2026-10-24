import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {isActiveStatus} from './kaggleClient.js';
import {formatAgo, prepareNotebookSource, sourceWarnings} from './model.js';

export const VERTICAL = parseInt(PACKAGE_VERSION) >= 51
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

export function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        Main.notifyError('Kaggle Status', `Could not open ${uri}: ${e.message}`);
    }
}

export function kernelUrl(k) {
    return `https://www.kaggle.com/code/${k.owner}/${k.slug}`;
}

export function accountName(a) {
    return a.alias || a.username || `account ${a.id}`;
}

function chip(label, onClick, color = null) {
    const b = new St.Button({style_class: 'kg-chip', label, reactive: true, can_focus: true, toggle_mode: true});
    if (color)
        b.style = `border-left: 3px solid ${color};`;
    b.connect('clicked', () => onClick(b));
    return b;
}

const STATUS_LABEL = {
    QUEUED: 'Queued', RUNNING: 'Running', COMPLETE: 'Complete', ERROR: 'Failed',
    CANCEL_REQUESTED: 'Stopping', CANCEL_ACKNOWLEDGED: 'Cancelled', NEW_SCRIPT: 'Starting', UNKNOWN: '—',
};

export function statusPill(status) {
    const cls = isActiveStatus(status) ? 'kg-pill-active' : status === 'ERROR' ? 'kg-pill-error' : 'kg-pill-idle';
    return new St.Label({
        text: STATUS_LABEL[status] ?? status, style_class: `kg-pill ${cls}`, y_align: Clutter.ActorAlign.CENTER,
    });
}

// Live log + files for one kernel's latest session.
export class OutputDialog {
    constructor(monitor, settings, account, kernel) {
        this._monitor = monitor;
        this._settings = settings;
        this._account = account;
        this._kernel = kernel;
        this._timer = 0;
        this._closed = false;
        this._lastText = null;

        const d = this._dialog = new ModalDialog.ModalDialog({styleClass: 'kg-dialog kg-output-dialog', destroyOnClose: true});
        const box = new St.BoxLayout({style_class: 'kg-dialog-body', ...VERTICAL, x_expand: true});
        d.contentLayout.add_child(box);

        const head = new St.BoxLayout({style_class: 'kg-row', x_expand: true});
        const titles = new St.BoxLayout({...VERTICAL, x_expand: true});
        titles.add_child(new St.Label({text: kernel.title || kernel.slug, style_class: 'kg-title'}));
        titles.add_child(new St.Label({text: `${kernel.owner}/${kernel.slug} · via ${accountName(account)}`, style_class: 'kg-sub'}));
        head.add_child(titles);
        this._pill = statusPill('UNKNOWN');
        head.add_child(this._pill);
        box.add_child(head);

        this._scroll = new St.ScrollView({style_class: 'kg-log-scroll', x_expand: true, y_expand: true, overlay_scrollbars: true});
        this._log = new St.Label({text: 'Loading…', style_class: 'kg-log'});
        this._log.clutter_text.set_selectable(true);
        this._log.clutter_text.line_wrap = true;
        this._log.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._log.style = `font-size: ${settings.get_int('output-font-size')}pt;`;
        const logBox = new St.BoxLayout({...VERTICAL});
        logBox.add_child(this._log);
        this._scroll.set_child(logBox);
        box.add_child(this._scroll);

        this._files = new St.BoxLayout({style_class: 'kg-files', ...VERTICAL});
        box.add_child(this._files);
        this._note = new St.Label({text: '', style_class: 'kg-sub'});
        box.add_child(this._note);

        d.addButton({label: 'Open on Kaggle', action: () => openUri(kernelUrl(kernel))});
        d.addButton({label: 'Refresh', action: () => this._poll()});
        d.addButton({label: 'Close', action: () => this.close(), default: true, key: Clutter.KEY_Escape});
        d.connect('closed', () => {
            this._closed = true;
            if (this._timer)
                GLib.source_remove(this._timer);
            this._timer = 0;
        });
    }

    open() {
        this._dialog.open();
        this._poll();
    }

    close() {
        this._dialog.close();
    }

    async _poll() {
        if (this._closed)
            return;
        const c = this._account.client;
        const k = this._kernel;
        let active = false;
        try {
            const [st, out] = await Promise.all([
                c.sessionStatus(k.owner, k.slug),
                c.output(k.owner, k.slug).catch(e => ({text: '', files: [], error: e.message})),
            ]);
            if (this._closed)
                return;
            active = isActiveStatus(st.status);
            const old = this._pill;
            this._pill = statusPill(st.status);
            old.get_parent()?.replace_child(old, this._pill);
            this._setLog(out.text, st, out.error, active);
            this._setFiles(out.files);
            this._note.text = st.message ? `Failure: ${st.message}` : (active ? `Auto-refreshing every ${this._settings.get_int('output-refresh')}s` : 'Finished');
        } catch (e) {
            if (!this._closed)
                this._note.text = `Could not load output: ${e.message}`;
        }
        if (active && !this._closed && !this._timer) {
            this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._settings.get_int('output-refresh'), () => {
                this._timer = 0;
                this._poll();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _setLog(text, st, error, active) {
        const max = this._settings.get_int('output-max-chars');
        let shown = text.length > max ? `… (${text.length - max} earlier characters hidden)\n${text.slice(-max)}` : text;
        if (!shown)
            shown = error ? `(${error})` : active ? '(no output yet — waiting for the session to produce logs)' : '(no log output)';
        if (shown === this._lastText)
            return;
        this._lastText = shown;
        const adj = this._scroll.vadjustment;
        const atBottom = !adj || adj.value >= adj.upper - adj.page_size - 24;
        this._log.text = shown;
        if (atBottom) {
            GLib.idle_add(GLib.PRIORITY_LOW, () => {
                if (!this._closed && adj)
                    adj.value = Math.max(0, adj.upper - adj.page_size);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _setFiles(files) {
        this._files.destroy_all_children();
        if (files.length === 0)
            return;
        this._files.add_child(new St.Label({text: `Output files (${files.length})`, style_class: 'kg-section'}));
        for (const f of files.slice(0, 12)) {
            const b = new St.Button({style_class: 'kg-link', label: f.name, can_focus: true, x_align: Clutter.ActorAlign.START});
            b.connect('clicked', () => f.url && openUri(f.url));
            this._files.add_child(b);
        }
        if (files.length > 12)
            this._files.add_child(new St.Label({text: `+${files.length - 12} more on Kaggle`, style_class: 'kg-sub'}));
    }
}

// Browse an account's (or public) kernels and run one with any account.
export class KernelBrowser {
    constructor(monitor, settings, openOutput) {
        this._monitor = monitor;
        this._settings = settings;
        this._openOutput = openOutput;
        this._scope = null;       // account object, or null = public
        this._runWith = null;
        this._selected = null;
        this._busy = false;
        this._closed = false;
        this._seq = 0;

        const accounts = monitor.accounts.filter(a => a.enabled);
        this._scope = accounts[0] ?? null;
        this._runWith = accounts[0] ?? null;

        const d = this._dialog = new ModalDialog.ModalDialog({styleClass: 'kg-dialog kg-browser', destroyOnClose: true});
        const box = new St.BoxLayout({style_class: 'kg-dialog-body', ...VERTICAL, x_expand: true});
        d.contentLayout.add_child(box);
        box.add_child(new St.Label({text: 'Kernels', style_class: 'kg-title'}));

        // source chips
        const srcRow = new St.BoxLayout({style_class: 'kg-row'});
        srcRow.add_child(new St.Label({text: 'Browse', style_class: 'kg-key', y_align: Clutter.ActorAlign.CENTER}));
        this._srcChips = [];
        for (const a of accounts) {
            const c = chip(accountName(a), () => this._setScope(a), a.color);
            c._account = a;
            this._srcChips.push(c);
            srcRow.add_child(c);
        }
        const pub = chip('Public', () => this._setScope(null));
        pub._account = null;
        this._srcChips.push(pub);
        srcRow.add_child(pub);
        box.add_child(srcRow);

        this._search = new St.Entry({style_class: 'kg-search', hint_text: 'Search kernels — press Enter', can_focus: true, x_expand: true});
        this._search.clutter_text.connect('activate', () => this._load());
        box.add_child(this._search);

        this._scroll = new St.ScrollView({style_class: 'kg-list-scroll', x_expand: true, y_expand: true, overlay_scrollbars: true});
        this._list = new St.BoxLayout({...VERTICAL, style_class: 'kg-list'});
        this._scroll.set_child(this._list);
        box.add_child(this._scroll);

        // run-with chips
        const runRow = new St.BoxLayout({style_class: 'kg-row'});
        runRow.add_child(new St.Label({text: 'Run with', style_class: 'kg-key', y_align: Clutter.ActorAlign.CENTER}));
        this._runChips = [];
        for (const a of accounts) {
            const c = chip(accountName(a), () => this._setRunWith(a), a.color);
            c._account = a;
            this._runChips.push(c);
            runRow.add_child(c);
        }
        box.add_child(runRow);

        this._detail = new St.Label({text: 'Select a kernel', style_class: 'kg-sub'});
        this._detail.clutter_text.line_wrap = true;
        box.add_child(this._detail);
        this._warn = new St.Label({text: '', style_class: 'kg-warn'});
        this._warn.clutter_text.line_wrap = true;
        box.add_child(this._warn);

        this._runBtn = d.addButton({label: 'Run', action: () => this._run(), default: true});
        this._outBtn = d.addButton({label: 'Output', action: () => this._showOutput()});
        this._webBtn = d.addButton({label: 'Open on Kaggle', action: () => this._selected && openUri(kernelUrl(this._selected))});
        d.addButton({label: 'Close', action: () => this.close(), key: Clutter.KEY_Escape});
        d.connect('closed', () => {
            this._closed = true;
        });
        this._syncChips();
        this._syncButtons();
    }

    open() {
        this._dialog.open();
        this._load();
    }

    close() {
        this._dialog.close();
    }

    _setScope(a) {
        this._scope = a;
        this._selected = null;
        this._syncChips();
        this._load();
    }

    _setRunWith(a) {
        this._runWith = a;
        this._syncChips();
        this._updateDetail();
    }

    _syncChips() {
        for (const c of this._srcChips)
            c.checked = c._account === this._scope;
        for (const c of this._runChips)
            c.checked = c._account === this._runWith;
    }

    _syncButtons() {
        const can = !!this._selected && !!this._runWith && !this._busy;
        this._runBtn.reactive = can;
        this._runBtn.opacity = can ? 255 : 110;
        const hasSel = !!this._selected;
        this._outBtn.reactive = hasSel;
        this._outBtn.opacity = hasSel ? 255 : 110;
        this._webBtn.reactive = hasSel;
        this._webBtn.opacity = hasSel ? 255 : 110;
    }

    async _load() {
        const seq = ++this._seq;
        this._list.destroy_all_children();
        this._list.add_child(new St.Label({text: 'Loading…', style_class: 'kg-sub'}));
        const q = this._search.get_text().trim();
        const size = this._settings.get_int('browser-page-size');
        try {
            let kernels;
            if (this._scope) {
                const sort = q ? 'RELEVANCE' : this._settings.get_string('browser-sort');
                kernels = (await this._scope.client.listMine({pageSize: size, search: q, sortBy: sort})).kernels;
            } else {
                const client = (this._runWith ?? this._monitor.accounts[0])?.client;
                if (!client)
                    throw new Error('No account available');
                kernels = (await client.browse({search: q, pageSize: size, sortBy: q ? 'RELEVANCE' : 'HOTNESS'})).kernels;
            }
            if (seq !== this._seq || this._closed)
                return;
            this._renderList(kernels);
        } catch (e) {
            if (seq !== this._seq || this._closed)
                return;
            this._list.destroy_all_children();
            this._list.add_child(new St.Label({text: `Could not load kernels: ${e.message}`, style_class: 'kg-warn'}));
        }
    }

    _renderList(kernels) {
        this._list.destroy_all_children();
        this._rows = [];
        if (kernels.length === 0) {
            this._list.add_child(new St.Label({text: 'No kernels found', style_class: 'kg-sub'}));
            return;
        }
        for (const k of kernels) {
            const row = new St.Button({style_class: 'kg-kernel', can_focus: true, x_expand: true, reactive: true});
            const inner = new St.BoxLayout({...VERTICAL, x_expand: true});
            const top = new St.BoxLayout({x_expand: true});
            const title = new St.Label({text: k.title || k.slug, style_class: 'kg-kernel-title', x_expand: true});
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            top.add_child(title);
            if (k.gpu)
                top.add_child(new St.Label({text: 'GPU', style_class: 'kg-tag'}));
            if (k.tpu)
                top.add_child(new St.Label({text: 'TPU', style_class: 'kg-tag'}));
            if (k.isPrivate)
                top.add_child(new St.Label({text: 'private', style_class: 'kg-tag'}));
            inner.add_child(top);
            const parts = [k.ref, `${k.language} ${k.kernelType}`.trim(), k.lastRun ? `ran ${formatAgo(k.lastRun)}` : ''];
            inner.add_child(new St.Label({text: parts.filter(Boolean).join(' · '), style_class: 'kg-sub'}));
            row.set_child(inner);
            row.connect('clicked', () => this._select(k, row));
            row.connect('notify::hover', () => { /* styled via :hover */ });
            this._rows.push(row);
            this._list.add_child(row);
        }
    }

    _select(k, row) {
        this._selected = k;
        for (const r of this._rows)
            r.remove_style_pseudo_class('selected');
        row.add_style_pseudo_class('selected');
        // When browsing an account's own kernels, default to running with that account.
        const owner = this._monitor.byUsername(k.owner);
        if (owner?.enabled && this._scope)
            this._runWith = owner;
        this._syncChips();
        this._updateDetail();
    }

    _updateDetail() {
        this._syncButtons();
        const k = this._selected;
        if (!k) {
            this._detail.text = 'Select a kernel';
            this._warn.text = '';
            return;
        }
        const w = this._runWith;
        this._detail.text = w
            ? `${k.ref} will run on ${accountName(w)}${w.username === k.owner ? '' : ` as ${w.username ?? '?'}/${k.slug}`}`
            : k.ref;
        this._warn.text = w ? sourceWarnings(k, k.owner, w.username).join('\n') : '';
    }

    async _run() {
        const k = this._selected;
        const target = this._runWith;
        if (!k || !target || this._busy)
            return;
        if (!target.username) {
            this._detail.text = `${accountName(target)} has no resolved username yet — it needs at least one kernel. Create one on Kaggle first.`;
            return;
        }
        this._busy = true;
        this._syncButtons();
        this._detail.text = 'Fetching source…';
        try {
            // Read with the owner's token when we have it (private kernels), else the target's.
            const reader = this._monitor.byUsername(k.owner) ?? target;
            const full = await reader.client.getKernel(k.owner, k.slug);
            const m = full.meta;
            const src = (m.kernelType || k.kernelType) === 'notebook' ? prepareNotebookSource(full.source) : full.source;
            const body = {
                slug: `${target.username}/${k.slug}`,
                newTitle: m.title || k.title,
                text: src,
                language: m.language || k.language || 'python',
                kernelType: m.kernelType || k.kernelType || 'script',
                isPrivate: this._settings.get_boolean('run-private'),
                enableGpu: m.gpu, enableTpu: m.tpu,
                enableInternet: this._settings.get_boolean('run-internet') && m.internet,
                datasetDataSources: m.datasets, competitionDataSources: m.competitions,
                kernelDataSources: m.kernels, modelDataSources: m.models,
                categoryIds: [],
            };
            if (m.machineShape && (m.gpu || m.tpu))
                body.machineShape = m.machineShape;
            this._detail.text = `Starting on ${accountName(target)}…`;
            const r = await target.client.saveKernel(body);
            if (r.error) {
                this._detail.text = `Kaggle refused: ${r.error}`;
                const bad = ['invalidDatasetSources', 'invalidCompetitionSources', 'invalidKernelSources', 'invalidModelSources']
                    .flatMap(f => r[f] ?? []);
                this._warn.text = bad.length ? `Inaccessible sources: ${bad.join(', ')}` : '';
            } else {
                const ref = r.ref || body.slug;
                const started = {ref, owner: target.username, slug: k.slug, title: body.newTitle};
                this._monitor.track(target, started);
                this._monitor.refresh();
                this._warn.text = '';
                this._detail.text = `Started ${ref} on ${accountName(target)}`;
                this._openOutput(target, started);
            }
        } catch (e) {
            this._detail.text = `Run failed: ${e.message}`;
        } finally {
            this._busy = false;
            if (!this._closed)
                this._syncButtons();
        }
    }

    _showOutput() {
        const k = this._selected;
        if (!k)
            return;
        // Output is only readable by the owner (or anyone for public kernels).
        const acct = this._monitor.byUsername(k.owner) ?? this._runWith;
        if (acct)
            this._openOutput(acct, k);
    }
}
