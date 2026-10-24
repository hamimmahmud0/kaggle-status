import GLib from 'gi://GLib';
import {loadTokenDir, KaggleClient} from '../src/lib/kaggleClient.js';
const loop = new GLib.MainLoop(null, false);
(async () => {
    const [t] = await loadTokenDir(ARGV[0]);
    const c = new KaggleClient(t.credential);
    const {kernels} = await c.listMine({pageSize: 3});
    const k = kernels[0];
    print('meta keys of list item ok:', k.ref);
    const r = await c.getKernel(k.owner, k.slug);
    print('raw keys:', Object.keys(r.raw), 'blob keys:', Object.keys(r.raw.blob ?? {}), 'source len:', r.source.length);
    print('meta:', JSON.stringify({...r.meta}));
    const b = await c.browse({search: 'titanic', pageSize: 3});
    print('browse:', b.kernels.map(x => x.ref).join(', '));
    const s = await c.output(k.owner, k.slug);
    print('files:', JSON.stringify(s.files.map(f => f.name)));
    c.destroy(); loop.quit();
})().catch(e => { print('fatal', e.status, e.message); loop.quit(); });
loop.run();
