// Usage: gjs -m tools/probe.js <token-dir>
// Prints only statuses and non-secret fields.
import GLib from 'gi://GLib';
import {loadTokenDir, KaggleClient} from '../src/lib/kaggleClient.js';

const loop = new GLib.MainLoop(null, false);
const dir = ARGV[0];
(async () => {
    const toks = await loadTokenDir(dir);
    print(`tokens: ${toks.length}`);
    for (const t of toks) {
        const c = new KaggleClient(t.credential);
        print(`--- ${t.id} kind=${t.credential.kind} hasUser=${!!t.credential.username}`);
        const step = async (label, fn) => {
            try {
                const r = await fn();
                print(`  ${label}: ok ${JSON.stringify(r).slice(0, 300)}`);
                return r;
            } catch (e) {
                print(`  ${label}: FAIL ${e.status} ${e.message.slice(0, 200)}`);
            }
        };
        const q = await step('quota', () => c.quota());
        const mine = await step('listMine', async () => {
            const r = await c.listMine({pageSize: 5});
            return {n: r.kernels.length, user: c.username, first: r.kernels[0]?.ref};
        });
        if (mine?.first) {
            const [o, s] = mine.first.split('/');
            await step('status', () => c.sessionStatus(o, s));
            await step('output', async () => {
                const r = await c.output(o, s);
                return {len: r.text.length, files: r.files.length};
            });
        }
        c.destroy();
    }
    loop.quit();
})().catch(e => {
    print(`fatal ${e.message}`);
    loop.quit();
});
loop.run();
