// Run: node workers/testing/replay-vault-cache.mjs. All outbound reads are fixture-backed.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const __dirname = import.meta.dirname;
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { build } = wranglerRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions, Response: MFResponse } = wranglerRequire('miniflare');
const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/vault-cache-snapshot.json')));
let mode = 'healthy';
const vaults = Object.values(fixture).filter(v => v && typeof v === 'object' && v.address);
function response(value, status = 200) { return new MFResponse(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
async function outbound(req) {
  const url = new URL(req.url);
  if (url.hostname === 'chainid.network') return response([{ chainId: 1, rpc: [] }]);
  if (url.hostname === 'kong.yearn.farm') {
    if (mode === 'kong-error') return response({ errors: [{ message: 'Unavailable' }] });
    const data = {};
    for (const key of ['ycvxcrv','yscvxcrv','ycvgcvx','yscvgcvx']) {
      const v = fixture[key];
      data[key] = { totalAssets: v.totalAssets, pricePerShare: v.pricePerShare, decimals: '18', tvl: { close: v.tvlUsd } };
    }
    if (mode === 'kong-null') data.yscvxcrv = null;
    if (mode === 'invalid-tvl') data.yscvxcrv.tvl.close = -1;
    return response({ data });
  }
  if (url.hostname === 'api.enso.finance') return response({ price: mode === 'missing-price' ? 0 : fixture.cvxPrice });
  if (url.hostname !== 'fixture.invalid') throw new Error(`Unexpected outbound: ${url.hostname}`);
  const body = await req.json();
  if (body.method === 'eth_blockNumber') return response({ result: '0x18c0000' });
  assert.equal(body.method, 'eth_call');
  const { to, data } = body.params[0];
  const v = vaults.find(v => v.address.toLowerCase() === to.toLowerCase());
  if (!v) return response({ result: '0xde0b6b3a7640000' }); // Curve probe output: 1 token.
  if (mode === 'rpc-error' && to.toLowerCase() === fixture.yscvx.address.toLowerCase()) return response({ error: { code: -32000, message: 'Read unavailable' } });
  if (mode === 'apy-error' && data.startsWith('0x07a2d13a')) return response({ error: { code: -32000, message: 'Archive unavailable' } });
  let value = data === '0x01e1d114' ? BigInt(v.totalAssets) : BigInt(v.pricePerShare);
  if (mode === 'zero-assets' && data === '0x01e1d114') value = 0n;
  if (mode === 'invalid-pps' && data === '0x99530b06') value = 0n;
  return response({ result: '0x' + value.toString(16) });
}
(async () => {
  const bundle = await build({ entryPoints: ['workers/vault-cache.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-02', host: '127.0.0.1',
    kvNamespaces: ['VAULT_CACHE'], d1Databases: ['LOGS'], r2Buckets: ['HISTORY'], persist: mkdtempSync(path.join(tmpdir(), 'yld-cache-replay-')),
    bindings: { RPC_URL: 'https://fixture.invalid', ENSO_API_KEY: 'local-fixture', REFRESH_SECRET: 'local-fixture' }, outboundService: outbound }));
  try {
    const env = await mf.getBindings();
    await env.LOGS.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, level TEXT, source TEXT, message TEXT, meta TEXT)');
    const refresh = () => mf.dispatchFetch('http://localhost/api/vaults/refresh', { method: 'POST', headers: { 'x-refresh-secret': 'local-fixture' } });
    let r = await refresh(); assert.equal(r.status, 200); const healthy = await r.json();
    assert.equal(healthy.yscvx.totalAssets, fixture.yscvx.totalAssets);
    assert.equal(healthy.yscvx.apy, 0);
    const seeded = JSON.stringify({ ...healthy, lastUpdated: '2026-09-13T00:00:00.000Z' });
    for (const failure of ['rpc-error', 'invalid-pps', 'kong-error', 'kong-null', 'invalid-tvl', 'missing-price']) {
      await env.VAULT_CACHE.put('vault-data', seeded); mode = failure;
      r = await refresh(); assert.equal(r.status, 503, failure);
      assert.equal(await env.VAULT_CACHE.get('vault-data'), seeded, failure);
      const retained = await (await mf.dispatchFetch('http://localhost/api/vaults')).json();
      assert.equal(retained.lastUpdated, '2026-09-13T00:00:00.000Z');
      console.log('PASS preserves previous snapshot:', failure);
    }
    mode = 'rpc-error'; await (await mf.getWorker()).scheduled({ cron: '*/5 * * * *' });
    assert.equal(await env.VAULT_CACHE.get('vault-data'), seeded);
    console.log('PASS scheduled refresh failure preserves snapshot');
    await env.VAULT_CACHE.delete('vault-data'); r = await mf.dispatchFetch('http://localhost/api/vaults'); assert.equal(r.status, 503);
    console.log('PASS cold failure is unavailable, never zero');
    mode = 'zero-assets'; r = await refresh(); assert.equal(r.status, 200); const zero = await r.json(); assert.equal(zero.yscvx.totalAssets, '0'); assert.equal(zero.yscvx.tvlUsd, 0);
    console.log('PASS verified zero balance accepted');
    mode = 'apy-error'; r = await refresh(); assert.equal(r.status, 200); assert.equal((await r.json()).yscvx.apy, null);
    console.log('PASS unavailable APY remains null');
    mode = 'healthy'; r = await refresh(); assert.equal(r.status, 200);
    const entry = (await env.VAULT_CACHE.list()).keys.find(k => k.name === 'vault-data');
    assert(entry.expiration - Math.floor(Date.now()/1000) > 86000);
    console.log('PASS recovery and 24-hour retention');
    await (await mf.getWorker()).scheduled({ cron: '*/5 * * * *' });
    assert(await env.HISTORY.get('history/yspxcvx.json'));
    console.log('PASS healthy scheduled refresh and R2 history sampling');
  } finally { await mf.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
