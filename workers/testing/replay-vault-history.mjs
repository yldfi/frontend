// Actual worker/R2 replay. No live network; archive fixture is captured from
// Muupe at the last block of 2025-10-19 for yscvgCVX.
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), wr = createRequire(require.resolve('wrangler/package.json'));
const { build } = wr('esbuild'), { Miniflare,convertV4MiniflareOptions,Response: MFResponse } = wr('miniflare');
const dir=mkdtempSync(`${tmpdir()}/yld-history-replay-`);
await build({entryPoints:['workers/vault-history.ts'],outfile:`${dir}/history.mjs`,bundle:true,format:'esm',platform:'node'});
const h=await import(pathToFileURL(`${dir}/history.mjs`));
const fixture=JSON.parse(readFileSync(new URL('./fixtures/archive-history-day.json',import.meta.url)));
const pad=n=>BigInt(n).toString(16).padStart(64,'0');
const rpc=async(method,params)=>{const r=fixture.rpc[JSON.stringify([method,params])];if(!r)throw new Error('Unexpected archive request');return r;};
const point=await h.sampleDay(rpc,fixture.key,fixture.point.time,fixture.point.block);
assert.deepEqual(point,fixture.point);console.log('PASS real archive balance, PPS and USD valuation reproduced');
const withCall = mutate => async(method,params)=>mutate(params[0],await rpc(method,params));
const zero=await h.sampleDay(withCall((call,value)=>call.data==='0x01e1d114'?'0x'+pad(0):value),fixture.key,point.time,point.block);
assert.equal(zero.tvl,0);console.log('PASS on-chain zero assets remain zero');
const noPrice=await h.sampleDay(async(method,params)=>{if(params[0].data==='0xfeaf968c')throw new Error('Price unavailable');return rpc(method,params);},fixture.key,point.time,point.block);
assert.equal(noPrice.tvl,null);assert.equal(noPrice.pps,point.pps);console.log('PASS price failure preserves PPS and marks TVL unavailable');
for(const bad of ['stale','negative']) {
 const p=await h.sampleDay(withCall((call,value)=>{
  if(call.data!=='0xfeaf968c')return value;
  const words=value.slice(2).match(/.{64}/g);
  if(bad==='stale')words[3]=pad(point.block.timestamp-49*3600);else words[1]=pad(2n**256n-1n);
  return '0x'+words.join('');
 }),fixture.key,point.time,point.block);assert.equal(p.tvl,null);
}console.log('PASS stale and negative oracle answers are unavailable');
await assert.rejects(()=>h.sampleDay(withCall((call,value)=>call.data==='0x99530b06'?'0x':value),fixture.key,point.time,point.block));
await assert.rejects(()=>h.sampleDay(async()=>{throw new Error('Archive failure');},fixture.key,point.time,point.block));
console.log('PASS failed or malformed balance/PPS never become zero');
const blocks=[{number:10,timestamp:100,hash:'0x'+'1'.repeat(64)},{number:11,timestamp:112,hash:'0x'+'2'.repeat(64)},{number:12,timestamp:148,hash:'0x'+'3'.repeat(64)}];
const boundary=await h.blockAt(async(_m,[tag])=>{const b=blocks.find(x=>x.number===Number(BigInt(tag)));return {...b,number:'0x'+b.number.toString(16),timestamp:'0x'+b.timestamp.toString(16)};},140,blocks[0],blocks[2]);
assert.equal(boundary.number,11);console.log('PASS exact day boundary across missed block slots');
const bundle=await build({entryPoints:['workers/vault-cache.ts'],bundle:true,write:false,format:'esm',platform:'browser'});
let archiveFail=false;
const now=Math.floor(Date.now()/1000),head=27000000;
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-02',host:'127.0.0.1',
 kvNamespaces:['VAULT_CACHE'],d1Databases:['LOGS'],r2Buckets:['HISTORY'],persist:dir,
 bindings:{RPC_URL:'https://fixture.invalid'},outboundService:async req=>{
  const respond=(data,status=200)=>new MFResponse(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  if(new URL(req.url).hostname==='chainid.network')return respond([{chainId:1,rpc:[]}]);
  if(new URL(req.url).hostname!=='fixture.invalid')return respond({errors:[{message:'Kong unavailable'}]});
  const {method,params}=await req.json();
  if(archiveFail)return respond({error:{code:-32000,message:'Archive unavailable'}});
  if(method==='eth_getBlockByNumber'){
   const n=params[0]==='latest'?head:Number(BigInt(params[0]));
   return respond({result:{number:'0x'+n.toString(16),timestamp:'0x'+(now-(head-n)*12).toString(16),hash:'0x'+pad(n)}});
  }
  if(method==='eth_blockNumber')return respond({result:'0x'+head.toString(16)});
  const data=params[0].data;
  const block=params[1]==='latest'?head:Number(BigInt(params[1]));
  const timestamp=now-(head-block)*12;
  return respond({result:data==='0xfeaf968c'?'0x'+[1,200000000,timestamp-10,timestamp-10,1].map(pad).join(''):'0x'+pad(data==='0x01e1d114'?5n*10n**18n:10n**18n)});
 }}));
try {
 const env=await mf.getBindings();
 await env.LOGS.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp TEXT,level TEXT,source TEXT,message TEXT,meta TEXT)');
 let response=await mf.dispatchFetch('http://localhost/api/history?key=yscvgcvx&metric=tvl');assert.equal(response.status,503);
 await h.savePoints(env.HISTORY,fixture.key,[noPrice]);
 await h.savePoints(env.HISTORY,fixture.key,[point]);
 assert.equal((await h.loadHistory(env.HISTORY,fixture.key)).doc.points[0].tvl,point.tvl);
 await h.savePoints(env.HISTORY,fixture.key,[noPrice]);
 assert.equal((await h.loadHistory(env.HISTORY,fixture.key)).doc.points[0].tvl,point.tvl);
 console.log('PASS R2 repairs unknown pricing without overwriting valid points');
 response=await mf.dispatchFetch('http://localhost/api/history?key=yscvgcvx&metric=tvl');
 const body=await response.json();assert.equal(body.version,2);assert.equal(body.data.timeseries[0].value,point.tvl);assert.equal(body.data.timeseries[1].value,null);
 console.log('PASS public worker history preserves missing dates as null');
 await (await mf.getWorker()).scheduled({cron:'*/5 * * * *'});
 for(const key of Object.keys(h.HISTORY_VAULTS)){
  const doc=(await h.loadHistory(env.HISTORY,key)).doc;
  assert(doc.points.some(p=>p.time===h.dayBucket(now)-86400&&p.tvl>0),key);
 }
 console.log('PASS cron samples all three vaults despite Kong outage');
 const before=await(await env.HISTORY.get(h.historyPath('yscvx'))).text();archiveFail=true;
 await(await mf.getWorker()).scheduled({cron:'*/5 * * * *'});
 assert.equal(await(await env.HISTORY.get(h.historyPath('yscvx'))).text(),before);
 console.log('PASS cron archive failure preserves stored history');
 await env.HISTORY.put(h.historyPath('yscvx'),'corrupt');
 response=await mf.dispatchFetch('http://localhost/api/history?key=yscvx&metric=tvl');assert.equal(response.status,503);
 console.log('PASS corrupt stored data is unavailable, not an empty/zero series');
 if(process.argv[2]) {
  for(const key of Object.keys(h.HISTORY_VAULTS)) {
   const raw=readFileSync(`${process.argv[2]}/${key}.json`,'utf8'),doc=h.parseHistory(raw,key);
   await env.HISTORY.put(h.historyPath(key),raw);
   for(const metric of ['tvl','pps']) {
    const r=await mf.dispatchFetch(`http://localhost/api/history?key=${key}&metric=${metric}&version=2`);
    assert.equal(r.status,200);
    const b=await r.json();assert.equal(b.data.timeseries.length,doc.points.length);
    assert.deepEqual(b.data.timeseries,doc.points.map(p=>({time:p.time,value:p[metric]})));
   }
   console.log(`PASS complete repaired ${key}: ${doc.points.length} points served through actual worker/R2`);
  }
 }
}finally{await mf.dispose();}
