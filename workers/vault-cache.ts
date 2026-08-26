// Cloudflare Worker for caching vault data
// Runs on a cron schedule to fetch vault data from Kong/Yearn API

const KONG_API_URL = "https://kong.yearn.farm/api/gql";

const CHAINLIST_URL = "https://chainid.network/chains.json";
const RPC_CACHE_KEY = "eth-rpc-urls";
const RPC_CACHE_TTL = 3600; // 1 hour

// Domains verified as tracking: "none" in DefiLlama chainlist
const PRIVACY_SAFE_DOMAINS = new Set([
  "eth.drpc.org",
  "ethereum-rpc.publicnode.com",
  "1rpc.io",
  "rpc.mevblocker.io",
  "rpc.flashbots.net",
  "rpc.payload.de",
  "eth.meowrpc.com",
  "api.securerpc.com",
  "rpc.builder0x69.io",
]);

/**
 * Fetch public keyless Ethereum RPCs from chainlist.org, cached in KV for 1h.
 * Filters to HTTPS-only, no API keys, no websocket, privacy-safe domains only,
 * shuffled for load distribution.
 */
async function getPublicRpcUrls(kv: KVNamespace): Promise<string[]> {
  // Check KV cache first
  const cached = await kv.get(RPC_CACHE_KEY);
  if (cached) return JSON.parse(cached) as string[];

  try {
    const response = await fetch(CHAINLIST_URL);
    if (!response.ok) throw new Error(`chainid.network ${response.status}`);

    const chains = (await response.json()) as { chainId: number; rpc: string[] }[];
    const eth = chains.find((c) => c.chainId === 1);
    if (!eth) throw new Error("Ethereum not found in chainlist");

    const rpcs = eth.rpc.filter((url) => {
      if (!url.startsWith("https://")) return false;
      if (url.includes("${") || url.includes("wss://")) return false;
      if (url.includes("api_key=") || url.includes("apikey=")) return false;
      try {
        const hostname = new URL(url).hostname;
        return PRIVACY_SAFE_DOMAINS.has(hostname);
      } catch {
        return false;
      }
    });

    // Shuffle so we spread load across RPCs
    for (let i = rpcs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rpcs[i], rpcs[j]] = [rpcs[j], rpcs[i]];
    }

    await kv.put(RPC_CACHE_KEY, JSON.stringify(rpcs), { expirationTtl: RPC_CACHE_TTL });
    return rpcs;
  } catch {
    // Minimal fallback if chainlist is down (privacy-safe RPCs only)
    return [
      "https://eth.drpc.org",
      "https://ethereum-rpc.publicnode.com",
      "https://1rpc.io/eth",
    ];
  }
}

// Contract addresses
const CVXCRV_TOKEN = "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7";
const YCVXCRV_VAULT = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86";
const YSCVXCRV_VAULT = "0xCa960E6DF1150100586c51382f619efCCcF72706";
const YCVGCVX_VAULT = "0x0849b046292293f78dF3002F8461f8A7e2eC2b82";
const YSCVGCVX_VAULT = "0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359";
const YSPXCVX_VAULT = "0xB246DB2A73EEE3ee026153660c74657C123f8E42";
const YSCVX_VAULT = "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e";

// Function selectors
const TOTAL_ASSETS = "0x01e1d114"; // totalAssets()
const PRICE_PER_SHARE = "0x99530b06"; // pricePerShare()
// convertToAssets(1e18) — selector + uint256(1e18) zero-padded to 32 bytes
const CONVERT_TO_ASSETS_1E18 = "0x07a2d13a0000000000000000000000000000000000000000000000000de0b6b3a7640000";

const BLOCKS_PER_DAY = 7200; // ~86400s / 12s per block

/**
 * Convert BigInt with 18 decimals to Number
 * Divides first to reduce magnitude before Number conversion.
 * Note: Precision loss possible if intPart > Number.MAX_SAFE_INTEGER (~9e15),
 * but typical vault TVLs are well below this threshold.
 */
function bigIntToNumber18(value: bigint): number {
  const divisor = 10n ** 18n;
  const intPart = value / divisor;
  const fracPart = value % divisor;
  return Number(intPart) + Number(fracPart) / 1e18;
}

interface Env {
  VAULT_CACHE: KVNamespace;
  LOGS: D1Database;
  HISTORY: R2Bucket;
  REFRESH_SECRET?: string;
  RPC_URL?: string;
  ALCHEMY_RPC_URL?: string;
  INFURA_RPC_URL?: string;
  ENSO_API_KEY?: string;
}

type LogLevel = "info" | "warn" | "error";

class Logger {
  private batch: { level: LogLevel; source: string; message: string; meta?: string }[] = [];

  log(level: LogLevel, source: string, message: string, meta?: Record<string, unknown>) {
    this.batch.push({ level, source, message, meta: meta ? JSON.stringify(meta) : undefined });
    // Mirror to console for wrangler tail
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`[${source}] ${message}`, meta ?? "");
  }

  info(source: string, message: string, meta?: Record<string, unknown>) { this.log("info", source, message, meta); }
  warn(source: string, message: string, meta?: Record<string, unknown>) { this.log("warn", source, message, meta); }
  error(source: string, message: string, meta?: Record<string, unknown>) { this.log("error", source, message, meta); }

  async flush(db: D1Database) {
    if (this.batch.length === 0) return;
    try {
      const stmt = db.prepare("INSERT INTO logs (timestamp, level, source, message, meta) VALUES (?, ?, ?, ?, ?)");
      await db.batch(this.batch.map((e) =>
        stmt.bind(new Date().toISOString(), e.level, e.source, e.message, e.meta ?? null)
      ));
    } catch (e) {
      console.error("Failed to flush logs to D1:", e);
    }
    this.batch = [];
  }
}

/**
 * Fetch with retry for worker environment
 */
async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || attempt === maxRetries) {
        return response;
      }
      // Retry on 5xx and 429
      if (response.status >= 500 || response.status === 429) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
    }
  }

  throw lastError || new Error("Failed after retries");
}

/**
 * Build fetch headers for an RPC URL, extracting basic auth if embedded in the URL.
 * CF Workers strip userinfo from URLs, so we must send it as an Authorization header.
 */
function rpcHeaders(rpcUrl: string): { url: string; headers: Record<string, string> } {
  const parsed = new URL(rpcUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (parsed.username) {
    headers["Authorization"] = "Basic " + btoa(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`);
    parsed.username = "";
    parsed.password = "";
  }
  return { url: parsed.toString(), headers };
}

async function ethCall(to: string, data: string, rpcUrls: string[], logger: Logger, block: string = "latest"): Promise<string> {
  let lastError: Error | null = null;
  const rpcLabel = (url: string) => new URL(url).hostname;

  for (const rpcUrl of rpcUrls) {
    try {
      const { url: cleanUrl, headers } = rpcHeaders(rpcUrl);
      const response = await fetchWithRetry(cleanUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to, data }, block],
        }),
      }, 1); // Only 1 retry per RPC, then try next

      if (response.ok) {
        const json = (await response.json()) as { result?: string; error?: { message: string; code?: number } };
        if (json.result && json.result !== "0x") {
          return json.result;
        }
        const errMsg = json.error?.message ?? "empty result";
        logger.warn("ethCall", `${rpcLabel(rpcUrl)} RPC error`, { contract: to, rpc: rpcLabel(rpcUrl), error: errMsg });
        lastError = new Error(errMsg);
        continue;
      }
      logger.warn("ethCall", `${rpcLabel(rpcUrl)} HTTP ${response.status}`, { contract: to, rpc: rpcLabel(rpcUrl), status: response.status });
      lastError = new Error(`HTTP ${response.status}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn("ethCall", `${rpcLabel(rpcUrl)} threw`, { contract: to, rpc: rpcLabel(rpcUrl), error: msg });
      lastError = e instanceof Error ? e : new Error(msg);
      continue;
    }
  }

  throw lastError ?? new Error("All RPCs failed");
}

async function getBlockNumber(rpcUrls: string[], logger: Logger): Promise<bigint> {
  for (const rpcUrl of rpcUrls) {
    try {
      const { url: cleanUrl, headers } = rpcHeaders(rpcUrl);
      const response = await fetchWithRetry(cleanUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      }, 1);
      if (response.ok) {
        const json = (await response.json()) as { result?: string };
        if (json.result) return BigInt(json.result);
      }
    } catch { /* try next */ }
  }
  throw new Error("Failed to get block number from all RPCs");
}

/**
 * Calculate on-chain APY for a vault using convertToAssets at current vs 24h-ago block.
 * Formula: ((priceNow / priceYesterday) ** 365 - 1) * 100
 * Matches DefiLlama's getERC4626Info methodology.
 */
async function getVaultAPY(vaultAddress: string, currentBlock: bigint, rpcUrls: string[], logger: Logger): Promise<number | null> {
  try {
    const blockYesterday = currentBlock - BigInt(BLOCKS_PER_DAY);
    const blockNowHex = "0x" + currentBlock.toString(16);
    const blockYesterdayHex = "0x" + blockYesterday.toString(16);

    const [priceNowHex, priceYesterdayHex] = await Promise.all([
      ethCall(vaultAddress, CONVERT_TO_ASSETS_1E18, rpcUrls, logger, blockNowHex),
      ethCall(vaultAddress, CONVERT_TO_ASSETS_1E18, rpcUrls, logger, blockYesterdayHex),
    ]);

    const priceNow = BigInt(priceNowHex);
    const priceYesterday = BigInt(priceYesterdayHex);
    if (priceYesterday === 0n) return null;

    const ratio = Number(priceNow) / Number(priceYesterday);
    const apy = (ratio ** 365 - 1) * 100;
    return apy;
  } catch (e) {
    logger.warn("getVaultAPY", `Failed for ${vaultAddress}`, { error: String(e) });
    return null;
  }
}

async function getVaultData(vaultAddress: string, rpcUrls: string[], logger: Logger) {
  const [totalAssetsHex, pricePerShareHex] = await Promise.all([
    ethCall(vaultAddress, TOTAL_ASSETS, rpcUrls, logger),
    ethCall(vaultAddress, PRICE_PER_SHARE, rpcUrls, logger),
  ]);

  const totalAssets = BigInt(totalAssetsHex);
  const pricePerShare = BigInt(pricePerShareHex);

  return {
    totalAssets: totalAssets.toString(),
    pricePerShare: pricePerShare.toString(),
    // Convert to human readable (18 decimals) - using safe conversion
    tvl: bigIntToNumber18(totalAssets),
    pps: bigIntToNumber18(pricePerShare),
  };
}

// Underlying token addresses for price lookups
const CVGCVX_TOKEN = "0x2191DF768ad71140F9F3E96c1e4407A4aA31d082";
const PXCVX_TOKEN = "0xBCe0Cf87F513102F22232436CCa2ca49e815C3aC";
const CVX_TOKEN = "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B";

// Curve pools for Curve-pool price fallback (when Enso has no feed)
const LPXCVX_CVX_POOL = "0x72725C0C879489986D213A9A6D2116dE45624c1c"; // CryptoSwap: coin0=CVX, coin1=lpxCVX
const CVX1_CVGCVX_POOL = "0xc50E191F703FB3160fC15d8b168A8c740fec3666"; // StableSwap: coin0=CVX1, coin1=cvgCVX

// get_dy selectors — encoded with abi.encodeWithSelector
// CryptoSwap: get_dy(uint256 i, uint256 j, uint256 dx) → 0x556d6e9f
// StableSwap: get_dy(int128 i, int128 j, uint256 dx)   → 0x5e0d443f
const GET_DY_UINT256 = "0x556d6e9f";
const GET_DY_INT128 = "0x5e0d443f";

function padHex32(value: bigint | number | string): string {
  const hex = typeof value === "bigint" ? value.toString(16) : BigInt(value).toString(16);
  return hex.padStart(64, "0");
}

/**
 * Curve-pool market price derivation for cvgCVX/pxCVX/lpxCVX.
 * Uses a 1-CVX probe against the pool's get_dy to read the mid-rate.
 *   1 CVX → X lpxCVX → 1 lpxCVX (= 1 pxCVX) market = cvxPrice / X
 *   1 CVX1 (≈1 CVX) → Y cvgCVX → 1 cvgCVX market = cvxPrice / Y
 * Returns 0 on failure (caller treats as "no price").
 */
async function getPxCvxPriceFromCurve(
  cvxPrice: number,
  rpcUrls: string[],
  logger: Logger,
): Promise<number> {
  if (cvxPrice <= 0) return 0;
  try {
    // get_dy(0, 1, 1e18): i=CVX, j=lpxCVX, dx=1 CVX
    const data =
      GET_DY_UINT256 + padHex32(0) + padHex32(1) + padHex32(10n ** 18n);
    const resultHex = await ethCall(LPXCVX_CVX_POOL, data, rpcUrls, logger);
    const lpxCvxOut = BigInt(resultHex);
    if (lpxCvxOut === 0n) return 0;
    const rate = Number(lpxCvxOut) / 1e18; // lpxCVX per 1 CVX
    return cvxPrice / rate;
  } catch (e) {
    logger.warn("getPxCvxPriceFromCurve", "Curve price derivation failed", {
      error: String(e),
    });
    return 0;
  }
}

async function getCvgCvxPriceFromCurve(
  cvxPrice: number,
  rpcUrls: string[],
  logger: Logger,
): Promise<number> {
  if (cvxPrice <= 0) return 0;
  try {
    // get_dy(0, 1, 1e18): i=CVX1, j=cvgCVX, dx=1 CVX1 (int128 args)
    const data =
      GET_DY_INT128 + padHex32(0) + padHex32(1) + padHex32(10n ** 18n);
    const resultHex = await ethCall(CVX1_CVGCVX_POOL, data, rpcUrls, logger);
    const cvgCvxOut = BigInt(resultHex);
    if (cvgCvxOut === 0n) return 0;
    const rate = Number(cvgCvxOut) / 1e18; // cvgCVX per 1 CVX1 (≈CVX, 1:1 wrap)
    return cvxPrice / rate;
  } catch (e) {
    logger.warn("getCvgCvxPriceFromCurve", "Curve price derivation failed", {
      error: String(e),
    });
    return 0;
  }
}

interface KongVaultData {
  tvl: { close: number } | null;
  totalAssets: string | null;
  pricePerShare: string | null;
  decimals: string | null;
}

interface KongResponse {
  data: {
    ycvxcrv: KongVaultData | null;
    yscvxcrv: KongVaultData | null;
    ycvgcvx: KongVaultData | null;
    yscvgcvx: KongVaultData | null;
  };
}

/**
 * Fetch token price from Enso API (corrected URL format)
 */
async function getTokenPrice(tokenAddress: string, apiKey: string | undefined): Promise<number> {
  if (!apiKey) return 0;
  try {
    const response = await fetchWithRetry(
      `https://api.enso.finance/api/v1/prices/1/${tokenAddress}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      2
    );
    if (response.ok) {
      const data = (await response.json()) as { price: number };
      return data.price || 0;
    }
  } catch (e) {
    console.error(`Enso price API error for ${tokenAddress}:`, e);
  }
  return 0;
}

/**
 * Fetch all vault data from Kong/Yearn API
 * Kong provides totalAssets, pricePerShare, and TVL (with proper redemption values)
 */
async function fetchKongVaults(): Promise<KongResponse> {
  const query = `{
    ycvxcrv: vault(chainId: 1, address: "${YCVXCRV_VAULT}") { tvl { close } totalAssets pricePerShare decimals }
    yscvxcrv: vault(chainId: 1, address: "${YSCVXCRV_VAULT}") { tvl { close } totalAssets pricePerShare decimals }
    ycvgcvx: vault(chainId: 1, address: "${YCVGCVX_VAULT}") { tvl { close } totalAssets pricePerShare decimals }
    yscvgcvx: vault(chainId: 1, address: "${YSCVGCVX_VAULT}") { tvl { close } totalAssets pricePerShare decimals }
  }`;

  const response = await fetchWithRetry(KONG_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`Kong API error: ${response.status}`);
  }

  return (await response.json()) as KongResponse;
}

/**
 * Convert Kong vault data to our response format.
 * Kong's `tvl.close` can be null for new/small vaults whose TVL timeseries the
 * indexer hasn't backfilled yet. In that case fall back to the on-chain
 * `totalAssets * price` (we already fetch on-chain assets + token prices), so
 * the card never renders $0.
 */
function formatKongVault(address: string, data: KongVaultData | null, price: number) {
  const totalAssets = data?.totalAssets ? BigInt(data.totalAssets) : 0n;
  const pricePerShare = data?.pricePerShare ? BigInt(data.pricePerShare) : 0n;

  const totalAssetsUsd = bigIntToNumber18(totalAssets) * price;
  const tvlUsd = data?.tvl?.close ? Number(data.tvl.close) : totalAssetsUsd;

  return {
    address,
    totalAssets: totalAssets.toString(),
    pricePerShare: pricePerShare.toString(),
    tvl: bigIntToNumber18(totalAssets),
    pps: bigIntToNumber18(pricePerShare),
    tvlUsd,
  };
}

async function fetchVaultData(env: Env, logger: Logger) {
  // Priority: muupe → alchemy → infura → chainlist public RPCs
  const privateRpcs = [env.RPC_URL, env.ALCHEMY_RPC_URL, env.INFURA_RPC_URL].filter(Boolean) as string[];
  const publicRpcs = await getPublicRpcUrls(env.VAULT_CACHE);
  const rpcUrls = [...privateRpcs, ...publicRpcs];
  logger.info("fetchVaultData", `Using ${rpcUrls.length} RPCs (${privateRpcs.length} private, ${publicRpcs.length} chainlist)`);

  // Use allSettled so one failure doesn't kill the entire update
  const [kongResult, yspxcvxResult, yscvxResult, cvxCrvPriceResult, cvgCvxPriceResult, pxCvxPriceResult, cvxPriceResult] = await Promise.allSettled([
    fetchKongVaults(),
    getVaultData(YSPXCVX_VAULT, rpcUrls, logger),
    getVaultData(YSCVX_VAULT, rpcUrls, logger),
    getTokenPrice(CVXCRV_TOKEN, env.ENSO_API_KEY),
    getTokenPrice(CVGCVX_TOKEN, env.ENSO_API_KEY),
    getTokenPrice(PXCVX_TOKEN, env.ENSO_API_KEY),
    getTokenPrice(CVX_TOKEN, env.ENSO_API_KEY),
  ]);

  // Kong is critical — if it fails, throw so we don't overwrite cache with empty data
  if (kongResult.status === "rejected") {
    logger.error("fetchVaultData", "Kong API failed", { error: String(kongResult.reason) });
    throw new Error(`Kong API failed: ${kongResult.reason}`);
  }
  const kongData = kongResult.value;
  logger.info("fetchVaultData", "Kong data fetched");

  // yspxcvx, yscvx and prices are non-critical — use fallback values
  const yspxcvxData = yspxcvxResult.status === "fulfilled"
    ? yspxcvxResult.value
    : { totalAssets: "0", pricePerShare: "0", tvl: 0, pps: 0 };
  const yscvxData = yscvxResult.status === "fulfilled"
    ? yscvxResult.value
    : { totalAssets: "0", pricePerShare: "0", tvl: 0, pps: 0 };
  const cvxCrvPrice = cvxCrvPriceResult.status === "fulfilled"
    ? cvxCrvPriceResult.value
    : 0;
  let cvgCvxPrice = cvgCvxPriceResult.status === "fulfilled"
    ? cvgCvxPriceResult.value
    : 0;
  let pxCvxPrice = pxCvxPriceResult.status === "fulfilled"
    ? pxCvxPriceResult.value
    : 0;
  const cvxPrice = cvxPriceResult.status === "fulfilled"
    ? cvxPriceResult.value
    : 0;

  // For cvgCVX/pxCVX the Curve pool is the authoritative price source (these
  // tokens only trade on one pool each). Enso's aggregator feed can lag the
  // pool mid-rate by several percent, so we prefer the on-chain Curve rate
  // and only use Enso as a last-resort fallback when the pool query fails.
  if (cvxPrice > 0) {
    const cvgCvxCurvePrice = await getCvgCvxPriceFromCurve(cvxPrice, rpcUrls, logger);
    if (cvgCvxCurvePrice > 0) {
      cvgCvxPrice = cvgCvxCurvePrice;
      logger.info("fetchVaultData", "cvgCVX price from Curve pool (primary)", { price: cvgCvxPrice });
    } else if (cvgCvxPrice > 0) {
      logger.info("fetchVaultData", "cvgCVX price from Enso fallback", { price: cvgCvxPrice });
    }
    const pxCvxCurvePrice = await getPxCvxPriceFromCurve(cvxPrice, rpcUrls, logger);
    if (pxCvxCurvePrice > 0) {
      pxCvxPrice = pxCvxCurvePrice;
      logger.info("fetchVaultData", "pxCVX price from Curve pool (primary)", { price: pxCvxPrice });
    } else if (pxCvxPrice > 0) {
      logger.info("fetchVaultData", "pxCVX price from Enso fallback", { price: pxCvxPrice });
    }
  }

  if (yspxcvxResult.status === "rejected") {
    logger.error("fetchVaultData", "yspxcvx RPC failed (using zeros)", { error: String(yspxcvxResult.reason) });
  } else {
    logger.info("fetchVaultData", "yspxcvx data fetched", { tvl: yspxcvxData.tvl });
  }
  if (yscvxResult.status === "rejected") {
    logger.error("fetchVaultData", "yscvx RPC failed (using zeros)", { error: String(yscvxResult.reason) });
  } else {
    logger.info("fetchVaultData", "yscvx data fetched", { tvl: yscvxData.tvl });
  }
  if (cvxCrvPriceResult.status === "rejected") {
    logger.error("fetchVaultData", "cvxCRV price failed (using 0)", { error: String(cvxCrvPriceResult.reason) });
  }
  if (cvgCvxPriceResult.status === "rejected") {
    logger.error("fetchVaultData", "cvgCVX Enso price failed (trying Curve fallback)", { error: String(cvgCvxPriceResult.reason) });
  }
  if (pxCvxPriceResult.status === "rejected") {
    logger.error("fetchVaultData", "pxCVX Enso price failed (trying Curve fallback)", { error: String(pxCvxPriceResult.reason) });
  }
  if (cvxPriceResult.status === "rejected") {
    logger.error("fetchVaultData", "CVX price failed (Curve fallback disabled)", { error: String(cvxPriceResult.reason) });
  }

  // On-chain APY: convertToAssets now vs 24h ago (matches DefiLlama getERC4626Info)
  let apys: Record<string, number | null> = {};
  try {
    const currentBlock = await getBlockNumber(rpcUrls, logger);
    const vaultAPYs = await Promise.allSettled([
      getVaultAPY(YCVXCRV_VAULT, currentBlock, rpcUrls, logger),
      getVaultAPY(YSCVXCRV_VAULT, currentBlock, rpcUrls, logger),
      getVaultAPY(YSCVGCVX_VAULT, currentBlock, rpcUrls, logger),
      getVaultAPY(YSCVX_VAULT, currentBlock, rpcUrls, logger),
    ]);
    apys = {
      ycvxcrv: vaultAPYs[0].status === "fulfilled" ? vaultAPYs[0].value : null,
      yscvxcrv: vaultAPYs[1].status === "fulfilled" ? vaultAPYs[1].value : null,
      yscvgcvx: vaultAPYs[2].status === "fulfilled" ? vaultAPYs[2].value : null,
      yscvx: vaultAPYs[3].status === "fulfilled" ? vaultAPYs[3].value : null,
    };
    logger.info("fetchVaultData", "On-chain APYs computed", apys as Record<string, unknown>);
  } catch (e) {
    logger.warn("fetchVaultData", "APY computation failed (non-critical)", { error: String(e) });
  }

  return {
    ycvxcrv: { ...formatKongVault(YCVXCRV_VAULT, kongData.data.ycvxcrv, cvxCrvPrice), apy: apys.ycvxcrv ?? null },
    yscvxcrv: { ...formatKongVault(YSCVXCRV_VAULT, kongData.data.yscvxcrv, cvxCrvPrice), apy: apys.yscvxcrv ?? null },
    ycvgcvx: { ...formatKongVault(YCVGCVX_VAULT, kongData.data.ycvgcvx, cvgCvxPrice), apy: null },
    yscvgcvx: { ...formatKongVault(YSCVGCVX_VAULT, kongData.data.yscvgcvx, cvgCvxPrice), apy: apys.yscvgcvx ?? null },
    // yscvx not yet indexed by Kong (standalone strategy, no Yearn allocator vault) — direct RPC
    yscvx: {
      address: YSCVX_VAULT,
      totalAssets: yscvxData.totalAssets,
      pricePerShare: yscvxData.pricePerShare,
      tvl: yscvxData.tvl,
      pps: yscvxData.pps,
      tvlUsd: yscvxData.tvl * cvxPrice,
      apy: apys.yscvx ?? null,
    },
    // yspxcvx excluded until vault is live
    cvxCrvPrice,
    cvgCvxPrice,
    cvxPrice,
    pxCvxPrice,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Vaults with no Kong timeseries (standalone strategies not indexed by Kong).
 * We sample totalAssets/pricePerShare ourselves on each cron and append to the
 * R2 history so the frontend can render TVL/performance charts for them.
 */
const SELF_SAMPLED_VAULTS = [
  { key: "yscvx", address: YSCVX_VAULT },
  { key: "yspxcvx", address: YSPXCVX_VAULT },
] as const;

interface HistorySeries {
  version: number;
  generatedAt: string;
  tvl: { t: number; v: number }[];
  pps: { t: number; v: number }[];
}

// Round down to the start of the UTC day to dedupe to one sample/day.
function toDayBucket(unixSec: number): number {
  return Math.floor(unixSec / 86400) * 86400;
}

async function readHistorySeries(bucket: R2Bucket, key: string): Promise<HistorySeries> {
  const obj = await bucket.get(key);
  if (!obj) return { version: 1, generatedAt: "1970-01-01T00:00:00.000Z", tvl: [], pps: [] };
  const raw = await obj.text();
  // Best-effort parse — corrupt/old shapes are discarded.
  try {
    return JSON.parse(raw) as HistorySeries;
  } catch {
    return { version: 1, generatedAt: "1970-01-01T00:00:00.000Z", tvl: [], pps: [] };
  }
}

// Append (or replace the current day's) point to a series, keeping the raw
// list compact and strictly time-ascending.
function appendSeriesPoint(series: { t: number; v: number }[], t: number, v: number): void {
  if (series.length > 0 && series[series.length - 1].t === t) {
    series[series.length - 1].v = v;
    return;
  }
  if (series.length > 0 && series[series.length - 1].t > t) return; // out-of-order, ignore
  series.push({ t, v });
  // Keep history bounded to ~2 years to keep the JSON small.
  const MAX_POINTS = 730;
  if (series.length > MAX_POINTS) series.splice(0, series.length - MAX_POINTS);
}

/**
 * Sample totalAssets/pps for self-hosted strategies into R2 history.
 * Runs on every cron; dedupes to one point per day per metric.
 */
async function sampleHistory(env: Env, logger: Logger, rpcUrls: string[], cvxPrice: number, pxCvxPrice: number) {
  for (const { key, address } of SELF_SAMPLED_VAULTS) {
    try {
      const data = await getVaultData(address, rpcUrls, logger);
      const underlyingPrice = key === "yscvx" ? cvxPrice : pxCvxPrice;
      if (underlyingPrice <= 0) {
        logger.warn("sampleHistory", `Skipping ${key} — underlying price unavailable`, { cvxPrice, pxCvxPrice });
        continue;
      }
      const t = toDayBucket(Math.floor(Date.now() / 1000));
      const series = await readHistorySeries(env.HISTORY, `history/${key}.json`);
      appendSeriesPoint(series.tvl, t, data.tvl * underlyingPrice);
      appendSeriesPoint(series.pps, t, data.pps);
      series.generatedAt = new Date().toISOString();
      await env.HISTORY.put(`history/${key}.json`, JSON.stringify(series), {
        httpMetadata: { contentType: "application/json" },
      });
      logger.info("sampleHistory", `Recorded ${key}`, { tvlUsd: data.tvl * underlyingPrice, pps: data.pps });
    } catch (e) {
      logger.warn("sampleHistory", `Failed for ${key}`, { error: String(e) });
    }
  }
}

export default {
  // Cron trigger handler
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const logger = new Logger();
    try {
      const data = await fetchVaultData(env, logger);
      await env.VAULT_CACHE.put("vault-data", JSON.stringify(data), {
        expirationTtl: 86400, // 24h TTL — stale data beats 503
      });
      logger.info("scheduled", "Vault data cached", { lastUpdated: data.lastUpdated });

      // Sample on-chain history for strategies Kong doesn't index (yscvx, yspxcvx).
      // Must not block/short-circuit the main cache write if it fails.
      try {
        const privateRpcs = [env.RPC_URL, env.ALCHEMY_RPC_URL, env.INFURA_RPC_URL].filter(Boolean) as string[];
        const publicRpcs = await getPublicRpcUrls(env.VAULT_CACHE);
        const rpcUrls = [...privateRpcs, ...publicRpcs];
        await sampleHistory(env, logger, rpcUrls, (data as { cvxPrice?: number }).cvxPrice ?? 0, (data as { pxCvxPrice?: number }).pxCvxPrice ?? 0);
      } catch (e) {
        logger.error("scheduled", "History sampling failed (non-fatal)", { error: String(e) });
      }
    } catch (error) {
      logger.error("scheduled", "Failed to cache vault data", { error: String(error) });
    }
    ctx.waitUntil(logger.flush(env.LOGS));
  },

  // HTTP handler for manual trigger and reading cache
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // GET /api/logs - View recent logs
    if (url.pathname === "/api/logs") {
      const level = url.searchParams.get("level");
      const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
      const source = url.searchParams.get("source");

      let query = "SELECT * FROM logs WHERE 1=1";
      const params: string[] = [];
      if (level) { query += " AND level = ?"; params.push(level); }
      if (source) { query += " AND source = ?"; params.push(source); }
      query += " ORDER BY id DESC LIMIT ?";
      params.push(String(limit));

      const result = await env.LOGS.prepare(query).bind(...params).all();
      return new Response(JSON.stringify(result.results), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // GET /api/vaults - Read cached data (with fallback to live fetch)
    if (url.pathname === "/api/vaults") {
      const cached = await env.VAULT_CACHE.get("vault-data");
      if (cached) {
        return new Response(cached, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=60",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // Fallback: fetch fresh data if cache is empty
      const logger = new Logger();
      try {
        const data = await fetchVaultData(env, logger);
        await env.VAULT_CACHE.put("vault-data", JSON.stringify(data), {
          expirationTtl: 86400,
        });
        ctx.waitUntil(logger.flush(env.LOGS));
        return new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=60",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (error) {
        logger.error("fetch", "Failed to fetch vault data on demand", { error: String(error) });
        ctx.waitUntil(logger.flush(env.LOGS));
        return new Response(JSON.stringify({ error: "Failed to fetch vault data" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // POST /api/vaults/refresh - Manual refresh (requires secret)
    if (url.pathname === "/api/vaults/refresh" && request.method === "POST") {
      const authHeader = request.headers.get("x-refresh-secret");
      if (!env.REFRESH_SECRET || authHeader !== env.REFRESH_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const logger = new Logger();
      const data = await fetchVaultData(env, logger);
      await env.VAULT_CACHE.put("vault-data", JSON.stringify(data), {
        expirationTtl: 600,
      });
      ctx.waitUntil(logger.flush(env.LOGS));
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /api/history?vault=yscvx&metric=tvl|pps - Serve self-sampled R2 history
    if (url.pathname === "/api/history") {
      const key = url.searchParams.get("key");
      const metric = url.searchParams.get("metric") === "pps" ? "pps" : "tvl";
      const allowed = SELF_SAMPLED_VAULTS.some((v) => v.key === key);
      if (!key || !allowed) {
        return new Response(JSON.stringify({ error: "Invalid key" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const series = await readHistorySeries(env.HISTORY, `history/${key}.json`);
      const points = (series[metric] ?? []).map((p) => ({ time: p.t, value: p.v }));
      return new Response(JSON.stringify({ data: { timeseries: points } }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
