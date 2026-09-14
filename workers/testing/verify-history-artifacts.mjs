// Recompute every repaired value using only the captured raw archive evidence.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),wr=createRequire(require.resolve('wrangler/package.json'));
const dir=resolve(process.argv[2]||'local/history-repair');
await wr('esbuild').build({entryPoints:['workers/vault-history.ts'],outfile:`${dir}/verify-history.mjs`,bundle:true,platform:'node',format:'esm'});
const h=await import(pathToFileURL(`${dir}/verify-history.mjs`));
const evidence=JSON.parse(readFileSync(`${dir}/rpc-evidence.json`));
const rpc=async(method,params)=>{const value=evidence[JSON.stringify([method,params])];assert.notEqual(value,undefined,'Missing raw archive evidence');return value;};
const records=[];
for(const key of Object.keys(h.HISTORY_VAULTS)) {
 const raw=readFileSync(`${dir}/${key}.json`,'utf8'),doc=h.parseHistory(raw,key);
 for(let i=0;i<doc.points.length;i++) {
  const p=doc.points[i];
  if(i)assert.equal(p.time-doc.points[i-1].time,86400,'Missing day');
  const block=await h.readBlock(rpc,p.block.number),next=await h.readBlock(rpc,p.block.number+1);
  assert.deepEqual(block,p.block);assert(block.timestamp<p.time+86400&&next.timestamp>=p.time+86400,'Not exact UTC close');
  const recomputed=await h.sampleDay(rpc,key,p.time,block);assert.deepEqual(recomputed,p);
  assert.notEqual(p.tvl,null,'Unresolved valuation');
 }
 records.push({key,points:doc.points.length,first:new Date(doc.points[0].time*1000).toISOString().slice(0,10),last:new Date(doc.points.at(-1).time*1000).toISOString().slice(0,10),zeroDays:doc.points.filter(p=>p.tvl===0).map(p=>new Date(p.time*1000).toISOString().slice(0,10)),sha256:createHash('sha256').update(raw).digest('hex')});
}
writeFileSync(`${dir}/artifact-audit.json`,JSON.stringify({verifiedAt:new Date().toISOString(),records,evidence:'Every value recomputed from recorded RPC replies; block and successor prove exact UTC day close'},null,2));
console.log(JSON.stringify(records,null,2));
