import GLib from 'gi://GLib';

import {KaggleClient, loadTokenDir, isActiveStatus} from './kaggleClient.js';
import {parseJson, ACCOUNT_PALETTE, combineQuotas} from './model.js';

export function defaultTokenDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'kaggle-status', 'tokens']);
}

// Owns accounts, polling and the running-session list. UI subscribes via
// `onChange`; nothing here touches Shell widgets.
export class Monitor {
    constructor(settings, notify) {
        this._settings = settings;
        this._notify = notify;
        this.accounts = [];
        this.running = [];        // [{account, ref, owner, slug, title, status, gpu, tpu}]
        this.combined = {gpu: null, tpu: null};
        this.lastUpdate = null;
        this.loading = false;
        this.tracked = new Map(); // `${accountId}|${ref}` -> {account, owner, slug, title}
        this._listeners = new Set();
        this._timer = 0;
        this._gen = 0;
        this._lastFull = 0;
        this._destroyed = false;
    }

    onChange(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    _emit() {
        for (const cb of this._listeners)
            cb();
    }

    get tokenDir() {
        return this._settings.get_string('token-dir') || defaultTokenDir();
    }

    start() {
        this.refresh({reload: true, full: true});
    }

    stop() {
        this._destroyed = true;
        this._gen++;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        for (const a of this.accounts)
            a.client?.destroy();
        this.accounts = [];
        this._listeners.clear();
    }

    account(id) {
        return this.accounts.find(a => a.id === id) ?? null;
    }

    byUsername(name) {
        return this.accounts.find(a => a.username === name) ?? null;
    }

    // Remember a kernel we started so its session is polled even when it is
    // not among the account's most recent kernels.
    track(account, kernel) {
        this.tracked.set(`${account.id}|${kernel.ref}`, {
            account, ref: kernel.ref, owner: kernel.owner, slug: kernel.slug, title: kernel.title, since: Date.now(),
        });
    }

    async _loadAccounts() {
        const cfg = parseJson(this._settings.get_string('accounts-config'), {});
        const tokens = await loadTokenDir(this.tokenDir);
        const next = [];
        tokens.forEach((t, i) => {
            const old = this.accounts.find(a => a.id === t.id && a.secret === t.credential.secret);
            const c = cfg[t.id] ?? {};
            const acct = old ?? {
                id: t.id, secret: t.credential.secret, client: new KaggleClient(t.credential),
                username: t.credential.username, quota: null, kernels: [], error: null,
            };
            acct.alias = c.alias || '';
            acct.enabled = c.enabled !== false;
            acct.color = c.color || ACCOUNT_PALETTE[i % ACCOUNT_PALETTE.length];
            next.push(acct);
        });
        for (const a of this.accounts) {
            if (!next.includes(a))
                a.client?.destroy();
        }
        this.accounts = next;
    }

    _publishInfo() {
        const info = {};
        for (const a of this.accounts)
            info[a.id] = {username: a.username ?? ''};
        const text = JSON.stringify(info);
        if (text !== this._settings.get_string('accounts-info'))
            this._settings.set_string('accounts-info', text);
    }

    async refresh({reload = false, full = false} = {}) {
        if (this._destroyed)
            return;
        const gen = ++this._gen;
        this.loading = true;
        this._emit();
        const pollSecs = this._settings.get_int('poll-interval');
        const doFull = full || (Date.now() - this._lastFull) / 1000 >= pollSecs - 1;
        try {
            if (reload || this.accounts.length === 0)
                await this._loadAccounts();
            if (gen !== this._gen)
                return;
            await Promise.all(this.accounts.filter(a => a.enabled).map(a => this._refreshAccount(a, doFull)));
            if (gen !== this._gen)
                return;
            if (doFull)
                this._lastFull = Date.now();
            this._collectRunning();
            this.lastUpdate = Date.now();
            this._publishInfo();
        } finally {
            if (gen === this._gen) {
                this.loading = false;
                this._emit();
                this._schedule();
            }
        }
    }

    async _refreshAccount(a, full) {
        try {
            a.quota = await a.client.quota();
            a.error = null;
        } catch (e) {
            a.error = e.message;
            if (e.status === 401 || e.status === 403)
                a.error = 'Token rejected (401/403)';
            return;
        }
        const count = this._settings.get_int('session-check-count');
        if (full && (count > 0 || !a.username)) {
            try {
                const r = await a.client.listMine({pageSize: Math.max(1, count), sortBy: 'DATE_RUN'});
                a.username = a.client.username ?? a.username;
                a.kernels = r.kernels.slice(0, Math.max(count, 0));
            } catch (e) {
                a.error = e.message;
            }
        }
        // Which kernels to poll: everything on a full scan; otherwise only
        // ones last seen active plus runs we started ourselves.
        const prev = new Map((a.sessions ?? []).map(s => [s.ref, s]));
        const wanted = new Map();
        for (const k of a.kernels) {
            if (full || isActiveStatus(prev.get(k.ref)?.status))
                wanted.set(k.ref, k);
        }
        for (const t of this.tracked.values()) {
            if (t.account === a)
                wanted.set(t.ref, {ref: t.ref, owner: t.owner, slug: t.slug, title: t.title});
        }
        const results = await Promise.all([...wanted.values()].map(async k => {
            try {
                const s = await a.client.sessionStatus(k.owner, k.slug);
                return {...k, status: s.status, message: s.message};
            } catch (_e) {
                return prev.get(k.ref) ?? {...k, status: 'UNKNOWN', message: ''};
            }
        }));
        // keep entries not re-polled this round
        const merged = new Map(prev);
        for (const k of a.kernels) {
            if (!merged.has(k.ref))
                merged.set(k.ref, {...k, status: 'UNKNOWN', message: ''});
        }
        for (const r of results)
            merged.set(r.ref, {...merged.get(r.ref), ...r});
        a.sessions = [...merged.values()];
    }

    _collectRunning() {
        const before = new Set(this.running.map(r => `${r.account.id}|${r.ref}`));
        const now = [];
        for (const a of this.accounts.filter(x => x.enabled)) {
            for (const s of a.sessions ?? []) {
                if (s.status === 'RUNNING' || s.status === 'QUEUED')
                    now.push({account: a, ...s});
            }
        }
        const nowKeys = new Set(now.map(r => `${r.account.id}|${r.ref}`));
        for (const key of before) {
            if (nowKeys.has(key))
                continue;
            this.tracked.delete(key);
            const prev = this.running.find(r => `${r.account.id}|${r.ref}` === key);
            const acct = prev?.account;
            const fin = acct?.sessions?.find(s => s.ref === prev.ref);
            if (this._settings.get_boolean('notify-on-finish') && prev)
                this._notify(`Kaggle: ${prev.title || prev.slug}`,
                    `${fin?.status === 'ERROR' ? 'Failed' : 'Finished'} on ${acct.alias || acct.username || acct.id}`);
        }
        // Tracked runs that are already done stop being tracked.
        for (const [key, t] of this.tracked) {
            const s = t.account.sessions?.find(x => x.ref === t.ref);
            // Grace period: right after a push the API may still report the previous version.
            if (s && !isActiveStatus(s.status) && Date.now() - t.since > 90000)
                this.tracked.delete(key);
        }
        this.running = now;
        this.combined = combineQuotas(this.accounts.filter(a => a.enabled).map(a => a.quota));
    }

    _schedule() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        if (this._destroyed)
            return;
        const secs = this.running.length > 0 || this.tracked.size > 0
            ? this._settings.get_int('active-poll-interval')
            : this._settings.get_int('poll-interval');
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._timer = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }
}
