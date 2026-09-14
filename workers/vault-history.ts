// Canonical daily history for the three tracked strategies. All inputs for a
// point are read at the last Ethereum block of that UTC day, never interpolated.
export const HISTORY_VAULTS = {
  yscvgcvx: { address: "0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359", inception: 23614679, firstDay: "2025-10-19" },
  yscvxcrv: { address: "0xCa960E6DF1150100586c51382f619efCCcF72706", inception: 23899777, firstDay: "2025-11-28" },
  yscvx: { address: "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e", inception: 25565641, firstDay: "2026-07-19" },
} as const;
export type HistoryKey = keyof typeof HISTORY_VAULTS;
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
export interface Block { number: number; timestamp: number; hash: string }
export interface DailyPoint {
  time: number;
  block: Block;
  totalAssets: string;
  pricePerShare: string;
  pps: number;
  tvl: number | null;
  priceUsd: number | null;
  priceSource: string;
  priceInputs: { address: string; data: string; result: string }[];
}
export interface HistoryDocument { version: 2; key: HistoryKey; generatedAt: string; points: DailyPoint[] }
export const historyPath = (key: HistoryKey) => `history/v2/${key}.json`;
export const dayBucket = (seconds: number) => Math.floor(seconds / 86400) * 86400;
export function isHistoryKey(key: string | null): key is HistoryKey {
  return key !== null && Object.hasOwn(HISTORY_VAULTS, key);
}
const hex = (n: number) => "0x" + n.toString(16);
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const unit = (raw: bigint) => Number(raw / 10n ** 18n) + Number(raw % 10n ** 18n) / 1e18;
const CVX_FEED = "0xc27e191714b429c51e18fafba6a4c31135b2e157";
const CRVUSD_FEED = "0xEEf0C605546958c1f899b6fB336C20671f9cD49F";
const CVXCRV_ORACLE = "0xD7063E7e5EbF99b55c56F231f374F97C8578653a";
const CVG_POOL = "0xc50E191F703FB3160fC15d8b168A8c740fec3666";

export async function readBlock(rpc: Rpc, tag: number | "latest"): Promise<Block> {
  const raw = await rpc("eth_getBlockByNumber", [typeof tag === "number" ? hex(tag) : tag, false]) as { number?: string; timestamp?: string; hash?: string } | null;
  if (!raw || !raw.number || !raw.timestamp || !/^0x[0-9a-f]{64}$/i.test(raw.hash ?? "")) throw new Error("Invalid block response");
  const block = { number: Number(BigInt(raw.number)), timestamp: Number(BigInt(raw.timestamp)), hash: raw.hash! };
  if (!Number.isSafeInteger(block.number) || !Number.isSafeInteger(block.timestamp)) throw new Error("Invalid block fields");
  return block;
}

// Return the last block at/before the timestamp; adjacent bounds prove the
// boundary even across missed slots. No average-block-time approximation.
export async function blockAt(rpc: Rpc, timestamp: number, low: Block, high: Block): Promise<Block> {
  if (low.timestamp > timestamp || high.timestamp <= timestamp) throw new Error("Timestamp not bracketed");
  while (high.number - low.number > 1) {
    const mid = await readBlock(rpc, Math.floor((low.number + high.number) / 2));
    if (mid.timestamp <= timestamp) low = mid; else high = mid;
  }
  return low;
}

async function call(rpc: Rpc, block: Block, address: string, data: string): Promise<string> {
  const result = await rpc("eth_call", [{ to: address, data }, hex(block.number)]);
  if (typeof result !== "string" || !/^0x(?:[0-9a-f]{64})+$/i.test(result)) throw new Error("Invalid archive call response");
  return result;
}

async function priceAt(rpc: Rpc, key: HistoryKey, block: Block, inputs: DailyPoint["priceInputs"]): Promise<number> {
  async function read(address: string, data: string) {
    const result = await call(rpc, block, address, data);
    inputs.push({ address, data, result });
    return result;
  }
  async function feed(address: string) {
    const result = await read(address, "0xfeaf968c");
    if (result.length !== 322) throw new Error("Invalid Chainlink round");
    const words = result.slice(2).match(/.{64}/g)!.map(x => BigInt("0x" + x));
    const [round, answer, , updated, answered] = words;
    // Signed answer, completed round, and a bounded age at the sampled block.
    if (answer <= 0n || answer >= 2n ** 255n || updated === 0n || answered < round ||
        Number(updated) > block.timestamp || block.timestamp - Number(updated) > 48 * 3600) throw new Error("Unavailable or stale USD price");
    return Number(answer) / 1e8;
  }
  if (key === "yscvxcrv") {
    const usd = await feed(CRVUSD_FEED);
    const oracle = BigInt(await read(CVXCRV_ORACLE, "0xa035b1fe"));
    if (oracle <= 0n) throw new Error("Invalid cvxCRV oracle price");
    return unit(oracle) * usd;
  }
  const cvxUsd = await feed(CVX_FEED);
  if (key === "yscvx") return cvxUsd;
  // Same market-price basis as yldfi's useCvgCvxPrice: CVX1 wraps CVX 1:1.
  const out = BigInt(await read(CVG_POOL, "0x5e0d443f" + word(0) + word(1) + word(10n ** 18n)));
  if (out <= 0n) throw new Error("Unavailable cvgCVX pool quote");
  return cvxUsd / unit(out);
}

export async function sampleDay(rpc: Rpc, key: HistoryKey, time: number, block: Block): Promise<DailyPoint> {
  if (time !== dayBucket(time) || block.timestamp < time || block.timestamp >= time + 86400 ||
      block.number < HISTORY_VAULTS[key].inception) throw new Error("Invalid sample block/day");
  const address = HISTORY_VAULTS[key].address;
  const [assetsHex, ppsHex] = await Promise.all([
    call(rpc, block, address, "0x01e1d114"), call(rpc, block, address, "0x99530b06"),
  ]);
  const assets = BigInt(assetsHex), pps = BigInt(ppsHex);
  if (pps <= 0n) throw new Error("Invalid share price");
  const inputs: DailyPoint["priceInputs"] = [];
  let price: number | null = null;
  try { price = await priceAt(rpc, key, block, inputs); } catch { /* Preserve PPS even when valuation is unavailable. */ }
  if (price !== null && (!Number.isFinite(price) || price <= 0)) price = null;
  const tvl = assets === 0n ? 0 : price === null ? null : unit(assets) * price;
  if (tvl !== null && !Number.isFinite(tvl)) throw new Error("Non-finite TVL");
  return { time, block, totalAssets: assets.toString(), pricePerShare: pps.toString(), pps: unit(pps), tvl,
    priceUsd: price, priceSource: key === "yscvxcrv" ? "cvxCRV/crvUSD oracle × Chainlink crvUSD/USD" : key === "yscvgcvx" ? "Chainlink CVX/USD ÷ Curve CVX1→cvgCVX quote" : "Chainlink CVX/USD", priceInputs: inputs };
}

export function parseHistory(raw: string, key: HistoryKey): HistoryDocument {
  const doc = JSON.parse(raw) as HistoryDocument;
  if (doc.version !== 2 || doc.key !== key || !Array.isArray(doc.points) || doc.points.length > 10000) throw new Error("Invalid history document");
  let previous = 0;
  for (const p of doc.points) {
    if (!Number.isSafeInteger(p.time) || p.time !== dayBucket(p.time) || p.time <= previous ||
        !p.block || p.block.timestamp < p.time || p.block.timestamp >= p.time + 86400 ||
        p.block.number < HISTORY_VAULTS[key].inception || !/^0x[0-9a-f]{64}$/i.test(p.block.hash) ||
        !/^\d+$/.test(p.totalAssets) || !/^\d+$/.test(p.pricePerShare) ||
        !Number.isFinite(p.pps) || p.pps <= 0 || p.pps !== unit(BigInt(p.pricePerShare)) ||
        (p.tvl !== null && (!Number.isFinite(p.tvl) || p.tvl < 0)) ||
        (p.tvl === 0 && BigInt(p.totalAssets) !== 0n) ||
        (p.tvl !== null && p.tvl !== 0 && (p.priceUsd === null || !Number.isFinite(p.priceUsd) || p.priceUsd <= 0 || p.tvl !== unit(BigInt(p.totalAssets)) * p.priceUsd))) throw new Error("Invalid history point");
    previous = p.time;
  }
  return doc;
}

export async function loadHistory(bucket: R2Bucket, key: HistoryKey) {
  const obj = await bucket.get(historyPath(key));
  return { etag: obj?.etag, doc: obj ? parseHistory(await obj.text(), key) :
    { version: 2 as const, key, generatedAt: new Date().toISOString(), points: [] as DailyPoint[] } };
}

// Optimistic concurrency prevents a cron and a repair from losing each other's
// points. Completed points are immutable except a retry of unavailable pricing.
export async function savePoints(bucket: R2Bucket, key: HistoryKey, points: DailyPoint[]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { etag, doc } = await loadHistory(bucket, key);
    const merged = new Map(doc.points.map(p => [p.time, p]));
    for (const p of points) {
      const old = merged.get(p.time);
      if (!old || (old.tvl === null && p.tvl !== null)) merged.set(p.time, p);
    }
    doc.points = [...merged.values()].sort((a, b) => a.time - b.time);
    doc.generatedAt = new Date().toISOString();
    const value = JSON.stringify(doc);
    parseHistory(value, key);
    if (await bucket.put(historyPath(key), value, { onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" } })) return;
  }
  throw new Error("Concurrent history update; retry required");
}

export async function maintainHistory(bucket: R2Bucket, rpc: Rpc) {
  const latest = await readBlock(rpc, "latest");
  const yesterday = dayBucket(latest.timestamp) - 86400;
  const blocks = new Map<number, Block>();
  for (const key of Object.keys(HISTORY_VAULTS) as HistoryKey[]) {
    // Latest completed day plus one older missing day per invocation. This
    // heals sampling outages without turning cron into a full archive replay.
    try {
      const { doc } = await loadHistory(bucket, key);
      const known = new Map(doc.points.map(p => [p.time, p]));
      const pending: number[] = [];
      if (!known.has(yesterday) || known.get(yesterday)!.tvl === null) pending.push(yesterday);
      if (doc.points.length) {
        for (let time = Date.parse(HISTORY_VAULTS[key].firstDay) / 1000; time < yesterday; time += 86400) {
          if (!known.has(time)) { pending.push(time); break; }
        }
        if (!pending.length) {
          const unknown = doc.points.find(p => p.tvl === null);
          if (unknown) pending.push(unknown.time);
        }
      }
      for (const time of pending) {
        let block = blocks.get(time);
        if (!block) {
          block = await blockAt(rpc, time + 86399, await readBlock(rpc, HISTORY_VAULTS[key].inception), latest);
          blocks.set(time, block);
        }
        await savePoints(bucket, key, [await sampleDay(rpc, key, time, block)]);
      }
    } catch { console.warn(`History sampling unavailable for ${key}; stored points retained`); }
  }
}

export async function historyResponse(bucket: R2Bucket, key: HistoryKey, metric: "tvl" | "pps"): Promise<Response> {
  try {
    const { doc } = await loadHistory(bucket, key);
    if (!doc.points.length) return Response.json({ error: "History not yet available" }, { status: 503 });
    const byDay = new Map(doc.points.map(p => [p.time, p]));
    const first = Date.parse(HISTORY_VAULTS[key].firstDay) / 1000;
    const last = dayBucket(Date.now() / 1000) - 86400;
    const timeseries = [];
    for (let time = first; time <= last; time += 86400) timeseries.push({ time, value: byDay.get(time)?.[metric] ?? null });
    return Response.json({ data: { timeseries }, source: "yldfi-archive", version: 2, generatedAt: doc.generatedAt, sampling: "UTC day close" },
      { headers: { "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" } });
  } catch { return Response.json({ error: "History unavailable" }, { status: 503 }); }
}
