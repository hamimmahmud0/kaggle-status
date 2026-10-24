// Kaggle API client: pure GLib/Soup 3, no Shell imports, so it can be run
// under plain `gjs -m` (see tools/probe.js). Tokens are never logged.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

const API_BASE = 'https://api.kaggle.com/v1';
const SERVICE = 'kernels.KernelsApiService';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class KaggleError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.name = 'KaggleError';
        this.status = status;
    }
}

// Accepts the shapes Kaggle hands out: kaggle.json ({username,key}), a bare
// API token (KGAT_…), or "username:key". Returns null for unusable content.
export function parseCredential(text) {
    const raw = (text ?? '').trim();
    if (!raw)
        return null;
    if (raw.startsWith('{')) {
        try {
            const o = JSON.parse(raw);
            const key = o.key ?? o.token ?? o.api_token ?? o.apiToken;
            if (!key)
                return null;
            if (o.username)
                return {kind: 'basic', username: String(o.username), secret: String(key)};
            return {kind: 'bearer', username: null, secret: String(key)};
        } catch (_e) {
            return null;
        }
    }
    const kv = raw.match(/^([A-Za-z0-9_.-]+):(\S+)$/);
    if (kv && !raw.startsWith('KGAT_'))
        return {kind: 'basic', username: kv[1], secret: kv[2]};
    const env = raw.match(/^(?:export\s+)?KAGGLE_API_TOKEN\s*=\s*['"]?(\S+?)['"]?$/);
    return {kind: 'bearer', username: null, secret: env ? env[1] : raw};
}

// Kaggle durations arrive as "123.45s".
export function parseDuration(v) {
    if (v === null || v === undefined)
        return 0;
    if (typeof v === 'number')
        return v;
    const n = parseFloat(String(v).replace(/s$/, ''));
    return Number.isFinite(n) ? n : 0;
}

export class KaggleClient {
    constructor(credential) {
        this._cred = credential;
        this._session = new Soup.Session({timeout: 30, user_agent: 'gnome-kaggle-status/1.0'});
        this.username = credential.username;
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    _authHeader() {
        const c = this._cred;
        if (c.kind === 'bearer')
            return `Bearer ${c.secret}`;
        return `Basic ${GLib.base64_encode(encoder.encode(`${c.username}:${c.secret}`))}`;
    }

    async _send(method, url, body) {
        if (!this._session)
            throw new KaggleError('client destroyed');
        const msg = Soup.Message.new(method, url);
        const h = msg.get_request_headers();
        h.append('Authorization', this._authHeader());
        h.append('Accept', 'application/json');
        if (body !== undefined) {
            msg.set_request_body_from_bytes('application/json',
                new GLib.Bytes(encoder.encode(JSON.stringify(body))));
        }
        let bytes;
        try {
            bytes = await new Promise((resolve, reject) => {
                this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                    try {
                        resolve(s.send_and_read_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        } catch (e) {
            throw new KaggleError(`Network error: ${e.message}`);
        }
        const status = msg.get_status();
        const text = bytes ? decoder.decode(bytes.get_data() ?? new Uint8Array()) : '';
        return {status, text};
    }

    async rpc(name, body = {}) {
        const {status, text} = await this._send('POST', `${API_BASE}/${SERVICE}/${name}`, body);
        let data = null;
        try {
            data = text ? JSON.parse(text) : {};
        } catch (_e) { /* non-JSON body */ }
        if (status >= 400 || (data && typeof data.code === 'number' && data.code >= 400)) {
            const code = status >= 400 ? status : data.code;
            const msg = data?.message ?? `HTTP ${code}`;
            throw new KaggleError(msg, code);
        }
        return data ?? {};
    }

    // ---- account ----
    // Own kernels (group PROFILE). Also how we learn the username of a bare token.
    async listMine({pageSize = 50, sortBy = 'DATE_RUN', search = '', pageToken} = {}) {
        const r = await this.rpc('ListKernels', {
            group: 'PROFILE', pageSize, sortBy, search, pageToken, language: 'all', kernelType: 'all', outputType: 'all',
        });
        const kernels = (r.kernels ?? []).map(normalizeKernel);
        if (!this.username && kernels.length > 0)
            this.username = kernels[0].owner;
        return {kernels, next: r.nextPageToken ?? ''};
    }

    async browse({user = '', search = '', sortBy = 'HOTNESS', pageSize = 30, pageToken, language = 'all'} = {}) {
        const r = await this.rpc('ListKernels', {
            group: 'EVERYONE', user, search, sortBy, pageSize, pageToken, language, kernelType: 'all', outputType: 'all',
        });
        return {kernels: (r.kernels ?? []).map(normalizeKernel), next: r.nextPageToken ?? ''};
    }

    async quota() {
        const r = await this.rpc('GetAcceleratorQuotaStatistics', {});
        const q = x => x ? {
            used: parseDuration(x.timeUsed), reserved: parseDuration(x.timeReserved),
            total: parseDuration(x.totalTimeAllowed), payToScale: !!x.isPayToScaleEnabled,
        } : null;
        return {refresh: r.quotaRefreshTime ?? null, gpu: q(r.gpuQuota), tpu: q(r.tpuQuota)};
    }

    // ---- kernels ----
    async sessionStatus(owner, slug) {
        const r = await this.rpc('GetKernelSessionStatus', {userName: owner, kernelSlug: slug});
        return {status: normalizeStatus(r.status), message: r.failureMessage ?? ''};
    }

    async getKernel(owner, slug) {
        const r = await this.rpc('GetKernel', {userName: owner, kernelSlug: slug});
        return {meta: normalizeKernel(r.metadata ?? {}), source: r.blob?.source ?? '', raw: r};
    }

    async saveKernel(body) {
        return this.rpc('SaveKernel', body);
    }

    async cancelSession(sessionId) {
        return this.rpc('CancelKernelSession', {kernelSessionId: sessionId});
    }

    // Log entries are a JSON array of {stream_name, data, time}; the API may
    // hand it back as a string or an already-parsed array.
    async output(owner, slug) {
        const r = await this.rpc('ListKernelSessionOutput', {userName: owner, kernelSlug: slug});
        let log = r.log ?? '';
        let entries = [];
        if (typeof log === 'string' && log.trim().startsWith('[')) {
            try {
                entries = JSON.parse(log);
            } catch (_e) { /* partial log */ }
        } else if (Array.isArray(log)) {
            entries = log;
        }
        const text = entries.length > 0
            ? entries.map(e => e.data ?? '').join('')
            : (typeof log === 'string' ? log : '');
        const files = (r.files ?? []).map(f => ({name: f.fileName ?? f.file_name ?? '', url: f.url ?? ''}));
        return {text, files};
    }
}

const STATUS_ALIASES = {
    KERNEL_WORKER_STATUS_QUEUED: 'QUEUED', KERNEL_WORKER_STATUS_RUNNING: 'RUNNING',
    KERNEL_WORKER_STATUS_COMPLETE: 'COMPLETE', KERNEL_WORKER_STATUS_ERROR: 'ERROR',
};

export function normalizeStatus(s) {
    if (typeof s === 'number')
        return ['QUEUED', 'RUNNING', 'COMPLETE', 'ERROR', 'CANCEL_REQUESTED', 'CANCEL_ACKNOWLEDGED', 'NEW_SCRIPT'][s] ?? 'UNKNOWN';
    return STATUS_ALIASES[s] ?? s ?? 'UNKNOWN';
}

export function isActiveStatus(s) {
    return s === 'QUEUED' || s === 'RUNNING' || s === 'CANCEL_REQUESTED' || s === 'NEW_SCRIPT';
}

export function normalizeKernel(k) {
    const ref = k.ref ?? '';
    const [refOwner, refSlug] = ref.includes('/') ? ref.split('/') : ['', ref];
    return {
        id: k.id ?? null,
        ref,
        owner: refOwner || k.author || '',
        slug: k.slug ?? refSlug ?? '',
        title: k.title ?? refSlug ?? '',
        author: k.author ?? refOwner,
        language: k.language ?? '',
        kernelType: k.kernelType ?? '',
        isPrivate: !!k.isPrivate,
        gpu: !!k.enableGpu,
        tpu: !!k.enableTpu,
        internet: k.enableInternet !== false,
        machineShape: k.machineShape ?? null,
        dockerImage: k.dockerImage ?? null,
        datasets: k.datasetDataSources ?? [],
        competitions: k.competitionDataSources ?? [],
        kernels: k.kernelDataSources ?? [],
        models: k.modelDataSources ?? [],
        lastRun: k.lastRunTime ?? null,
        votes: k.totalVotes ?? 0,
        version: k.currentVersionNumber ?? null,
    };
}

export async function readTextFile(path) {
    const file = Gio.File.new_for_path(path);
    const [, bytes] = await new Promise((resolve, reject) => {
        file.load_contents_async(null, (f, res) => {
            try {
                resolve(f.load_contents_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
    return decoder.decode(bytes);
}

// Loads every file in a token directory into {id, path, credential}. Tokens
// stay where they are; only parsed in memory.
export async function loadTokenDir(dirPath) {
    const dir = Gio.File.new_for_path(dirPath);
    const out = [];
    let en;
    try {
        en = await new Promise((resolve, reject) => {
            dir.enumerate_children_async('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, null, (f, res) => {
                    try {
                        resolve(f.enumerate_children_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    } catch (_e) {
        return out;
    }
    for (;;) {
        const infos = await new Promise((resolve, reject) => {
            en.next_files_async(64, GLib.PRIORITY_DEFAULT, null, (e, res) => {
                try {
                    resolve(e.next_files_finish(res));
                } catch (err) {
                    reject(err);
                }
            });
        });
        if (infos.length === 0)
            break;
        for (const info of infos) {
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;
            const name = info.get_name();
            if (name.startsWith('.') || name.endsWith('~'))
                continue;
            const path = GLib.build_filenamev([dirPath, name]);
            try {
                const credential = parseCredential(await readTextFile(path));
                if (credential)
                    out.push({id: name, path, credential});
            } catch (_e) { /* unreadable file: skip */ }
        }
    }
    out.sort((a, b) => a.id.localeCompare(b.id, undefined, {numeric: true}));
    return out;
}
