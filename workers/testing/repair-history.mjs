// Read-only archive reconstruction. Writes ONLY local artifacts. Publication is
// a separate, explicit R2 upload after runtime validation; no production keys
// other than the read-only RPC URL are loaded.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const wr = createRequire(require.resolve('wrangler/package.json'));
const { build } = wr('esbuild');
const out = resolve(process.argv[2] || 'local/history-repair');
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['workers/vault-history.ts'], outfile: `${out}/history.mjs`, bundle: true, platform: 'node', format: 'esm' });
const { HISTORY_VAULTS, dayBucket, readBlock, blockAt, sampleDay, parseHistory } = await import(pathToFileURL(`${out}/history.mjs`));
const endpoints = execFileSync(process.env.ETHCLI_BIN || 'ethcli', ['endpoints','list'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
const endpoint = (endpoints.match(/https?:\/\/\S+/g) || []).find(u => new URL(u).hostname === 'muupe.com' && new URL(u).pathname === '/eth/rpc');
if (!endpoint) throw new Error('Configured Muupe archive endpoint missing');
const rpcUrl = new URL(endpoint);
const headers = { 'Content-Type': 'application/json' };
if (rpcUrl.username) { headers.Authorization = 'Basic ' + Buffer.from(`${decodeURIComponent(rpcUrl.username)}:${decodeURIComponent(rpcUrl.password)}`).toString('base64'); rpcUrl.username = ''; rpcUrl.password = ''; }
const cachePath = `${out}/rpc-evidence.json`;
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath)) : {};
let calls = 0;
async function rpc(method, params) {
  const key = JSON.stringify([method,params]);
  if (cache[key] !== undefined && !params.includes('latest')) return cache[key];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(rpcUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc:'2.0',id:1,method,params }), signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`Archive HTTP ${r.status}`);
      const body = await r.json();
      if (body.error || body.result == null) throw new Error('Archive result unavailable');
      calls++;
      if (!params.includes('latest')) cache[key] = body.result;
      if (calls % 100 === 0) writeFileSync(cachePath, JSON.stringify(cache));
      return body.result;
    } catch {
      if (attempt === 2) throw new Error(`Archive ${method} failed after retries`);
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}
const latest = await readBlock(rpc,'latest');
const end = dayBucket(latest.timestamp) - 86400;
const summaries = [];
try {
  for (const [key,vault] of Object.entries(HISTORY_VAULTS)) {
    const file = `${out}/${key}.json`;
    const doc = existsSync(file) ? parseHistory(readFileSync(file,'utf8'),key) : { version:2,key,generatedAt:'',points:[] };
    const points = new Map(doc.points.map(p => [p.time,p]));
    let lower = await readBlock(rpc,vault.inception);
    console.log(JSON.stringify({ key,inception:lower,source:'configured Muupe archive',through:new Date(end*1000).toISOString().slice(0,10) }));
    for (let time = Date.parse(vault.firstDay)/1000; time <= end; time += 86400) {
      if (points.has(time) && points.get(time).tvl !== null) { lower=points.get(time).block; continue; }
      const block = await blockAt(rpc,time+86399,lower,latest);
      const p = await sampleDay(rpc,key,time,block);
      points.set(time,p); lower=block;
      doc.points = [...points.values()].sort((a,b)=>a.time-b.time);
      doc.generatedAt = new Date().toISOString();
      parseHistory(JSON.stringify(doc),key);
      writeFileSync(file,JSON.stringify(doc));
      if (doc.points.length % 25 === 0 || p.tvl === null) console.log(JSON.stringify({key,points:doc.points.length,date:new Date(time*1000).toISOString().slice(0,10),tvl:p.tvl,pps:p.pps,rpcCalls:calls}));
    }
    summaries.push({key,count:doc.points.length,first:doc.points[0]?.time,last:doc.points.at(-1)?.time,nullTvl:doc.points.filter(p=>p.tvl===null).map(p=>p.time),zeroTvl:doc.points.filter(p=>p.tvl===0).map(p=>p.time)});
  }
} finally { writeFileSync(cachePath,JSON.stringify(cache)); }
writeFileSync(`${out}/summary.json`,JSON.stringify({source:'configured Muupe archive',latest,summaries},null,2));
console.log(JSON.stringify({completed:true,summaries}));
