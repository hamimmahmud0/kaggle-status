// Pure helpers (no Shell imports) so they can be tested under plain gjs/node.

export function formatHours(seconds) {
    const h = seconds / 3600;
    return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`;
}

export function formatRemaining(isoTime, now = Date.now()) {
    if (!isoTime)
        return '';
    const ms = Date.parse(isoTime) - now;
    if (!Number.isFinite(ms))
        return '';
    if (ms <= 0)
        return 'now';
    const mins = Math.round(ms / 60000);
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d > 0)
        return `${d}d ${h}h`;
    if (h > 0)
        return `${h}h ${m}m`;
    return `${m}m`;
}

export function formatAgo(isoTime, now = Date.now()) {
    const ms = now - Date.parse(isoTime);
    if (!isoTime || !Number.isFinite(ms))
        return '';
    const mins = Math.max(0, Math.round(ms / 60000));
    if (mins < 1)
        return 'just now';
    if (mins < 60)
        return `${mins}m ago`;
    if (mins < 1440)
        return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 1440)}d ago`;
}

// {used, reserved, total} for one resource, or null when absent/zero.
export function pickResource(quota, resource) {
    if (!quota)
        return null;
    if (resource === 'worst') {
        const a = pickResource(quota, 'gpu');
        const b = pickResource(quota, 'tpu');
        if (!a || !b)
            return a ?? b;
        return pct(a) >= pct(b) ? a : b;
    }
    const q = quota[resource];
    return q && q.total > 0 ? q : null;
}

export function pct(q) {
    if (!q || q.total <= 0)
        return 0;
    return Math.max(0, Math.min(100, ((q.used + q.reserved) / q.total) * 100));
}

// Sum quotas across accounts, per resource.
export function combineQuotas(quotas) {
    const out = {gpu: null, tpu: null};
    for (const key of ['gpu', 'tpu']) {
        for (const q of quotas) {
            const r = q?.[key];
            if (!r)
                continue;
            out[key] ??= {used: 0, reserved: 0, total: 0};
            out[key].used += r.used;
            out[key].reserved += r.reserved;
            out[key].total += r.total;
        }
    }
    return out;
}

export function levelFor(percent, warn, crit) {
    if (percent >= crit)
        return 'crit';
    if (percent >= warn)
        return 'warn';
    return 'ok';
}

// "#rrggbb", "#rrggbbaa" or "rgb(r,g,b)"/"rgba(...)" -> [r,g,b,a] in 0..1.
export function parseColor(s, fallback = [0.5, 0.5, 0.5, 1]) {
    const str = (s ?? '').trim();
    let m = str.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (m) {
        const n = parseInt(m[1], 16);
        return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255,
            m[2] ? parseInt(m[2], 16) / 255 : 1];
    }
    m = str.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
    if (m)
        return [m[1] / 255, m[2] / 255, m[3] / 255, m[4] !== undefined ? parseFloat(m[4]) : 1];
    return fallback;
}

export function toHex([r, g, b, a = 1]) {
    const h = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}${a < 1 ? h(a) : ''}`;
}

// Accent colours handed out to accounts that have not picked one.
export const ACCOUNT_PALETTE = ['#20beff', '#a78bfa', '#34d399', '#f59e0b', '#f472b6', '#60a5fa'];

export function parseJson(text, fallback) {
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' ? v : fallback;
    } catch (_e) {
        return fallback;
    }
}

// Strip notebook outputs the way `kaggle kernels push` does before upload.
export function prepareNotebookSource(source) {
    let json;
    try {
        json = JSON.parse(source);
    } catch (_e) {
        return source;
    }
    for (const cell of json.cells ?? []) {
        if (cell.cell_type === 'code' && cell.outputs)
            cell.outputs = [];
        if (Array.isArray(cell.source))
            cell.source = cell.source.join('');
    }
    return JSON.stringify(json);
}

// Dataset/competition/model sources the target account may not be able to read.
export function sourceWarnings(meta, sourceUser, targetUser) {
    if (!sourceUser || sourceUser === targetUser)
        return [];
    const warn = [];
    const mineDs = (meta.datasets ?? []).filter(d => d.startsWith(`${sourceUser}/`));
    if (mineDs.length > 0 && meta.isPrivate)
        warn.push(`Datasets owned by ${sourceUser} may be private: ${mineDs.join(', ')}`);
    if ((meta.competitions ?? []).length > 0)
        warn.push(`${targetUser} must have joined: ${meta.competitions.join(', ')}`);
    if ((meta.kernels ?? []).some(k => k.startsWith(`${sourceUser}/`)))
        warn.push('Kernel sources owned by the source account may be private');
    return warn;
}
