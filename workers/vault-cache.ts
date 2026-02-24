// Cloudflare Worker for caching vault data
// Runs on a cron schedule to fetch vault data from Kong/Yearn API

const KONG_API_URL = "https://kong.yearn.farm/api/gql";

const CHAINLIST_URL = "https://chainid.network/chains.json";
const RPC_CACHE_KEY = "eth-rpc-urls";
const RPC_CACHE_TTL = 3600; // 1 hour

/**
 * Fetch public keyless Ethereum RPCs from chainlist.org, cached in KV for 1h.
 * Filters to HTTPS-only, no API keys, no websocket, shuffled for load distribution.
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

    const rpcs = eth.rpc.filter((url) =>
      url.startsWith("https://") &&
      !url.includes("${") &&           // skip template vars like ${INFURA_API_KEY}
      !url.includes("wss://") &&
      !url.includes("api_key=") &&
      !url.includes("apikey=")
    );

    // Shuffle so we spread load across RPCs
    for (let i = rpcs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rpcs[i], rpcs[j]] = [rpcs[j], rpcs[i]];
    }

    await kv.put(RPC_CACHE_KEY, JSON.stringify(rpcs), { expirationTtl: RPC_CACHE_TTL });
    return rpcs;
  } catch {
    // Hardcoded fallback if chainlist is down
    return [
      "https://eth.llamarpc.com",
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
const YSCVGCVX_VAULT = "0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359";
const YSPXCVX_VAULT = "0xB246DB2A73EEE3ee026153660c74657C123f8E42";

// Function selectors (only needed for yspxcvx fallback)
const TOTAL_ASSETS = "0x01e1d114"; // totalAssets()
const PRICE_PER_SHARE = "0x99530b06"; // pricePerShare()

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
  REFRESH_SECRET?: string;
  RPC_URL?: string;
  ALCHEMY_RPC_URL?: string;
  INFURA_RPC_URL?: string;
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

async function ethCall(to: string, data: string, rpcUrls: string[], logger: Logger): Promise<string> {
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
          params: [{ to, data }, "latest"],
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
    yscvgcvx: KongVaultData | null;
  };
}

/**
 * Fetch token price from Enso API (corrected URL format)
 */
async function getTokenPrice(tokenAddress: string): Promise<number> {
  try {
    const response = await fetchWithRetry(
      `https://api.enso.finance/api/v1/prices/1/${tokenAddress}`,
      undefined,
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
 * Convert Kong vault data to our response format
 */
function formatKongVault(address: string, data: KongVaultData | null) {
  const totalAssets = data?.totalAssets ? BigInt(data.totalAssets) : 0n;
  const pricePerShare = data?.pricePerShare ? BigInt(data.pricePerShare) : 0n;

  return {
    address,
    totalAssets: totalAssets.toString(),
    pricePerShare: pricePerShare.toString(),
    tvl: bigIntToNumber18(totalAssets),
    pps: bigIntToNumber18(pricePerShare),
    tvlUsd: data?.tvl?.close ?? 0,
  };
}

async function fetchVaultData(env: Env, logger: Logger) {
  // Priority: muupe → alchemy → infura → chainlist public RPCs
  const privateRpcs = [env.RPC_URL, env.ALCHEMY_RPC_URL, env.INFURA_RPC_URL].filter(Boolean) as string[];
  const publicRpcs = await getPublicRpcUrls(env.VAULT_CACHE);
  const rpcUrls = [...privateRpcs, ...publicRpcs];
  logger.info("fetchVaultData", `Using ${rpcUrls.length} RPCs (${privateRpcs.length} private, ${publicRpcs.length} chainlist)`);

  // Use allSettled so one failure doesn't kill the entire update
  const [kongResult, yspxcvxResult, cvxCrvPriceResult, cvgCvxPriceResult, pxCvxPriceResult] = await Promise.allSettled([
    fetchKongVaults(),
    getVaultData(YSPXCVX_VAULT, rpcUrls, logger),
    getTokenPrice(CVXCRV_TOKEN),
    getTokenPrice(CVGCVX_TOKEN),
    getTokenPrice(PXCVX_TOKEN),
  ]);

  // Kong is critical — if it fails, throw so we don't overwrite cache with empty data
  if (kongResult.status === "rejected") {
    logger.error("fetchVaultData", "Kong API failed", { error: String(kongResult.reason) });
    throw new Error(`Kong API failed: ${kongResult.reason}`);
  }
  const kongData = kongResult.value;
  logger.info("fetchVaultData", "Kong data fetched");

  // yspxcvx and prices are non-critical — use fallback values
  const yspxcvxData = yspxcvxResult.status === "fulfilled"
    ? yspxcvxResult.value
    : { totalAssets: "0", pricePerShare: "0", tvl: 0, pps: 0 };
  const cvxCrvPrice = cvxCrvPriceResult.status === "fulfilled"
    ? cvxCrvPriceResult.value
    : 0;
  const cvgCvxPrice = cvgCvxPriceResult.status === "fulfilled"
    ? cvgCvxPriceResult.value
    : 0;
  const pxCvxPrice = pxCvxPriceResult.status === "fulfilled"
    ? pxCvxPriceResult.value
    : 0;

  if (yspxcvxResult.status === "rejected") {
    logger.error("fetchVaultData", "yspxcvx RPC failed (using zeros)", { error: String(yspxcvxResult.reason) });
  } else {
    logger.info("fetchVaultData", "yspxcvx data fetched", { tvl: yspxcvxData.tvl });
  }
  if (cvxCrvPriceResult.status === "rejected") {
    logger.error("fetchVaultData", "cvxCRV price failed (using 0)", { error: String(cvxCrvPriceResult.reason) });
  }
  if (cvgCvxPriceResult.status === "rejected") {
    logger.error("fetchVaultData", "cvgCVX price failed (using 0)", { error: String(cvgCvxPriceResult.reason) });
  }
  if (pxCvxPriceResult.status === "rejected") {
    logger.error("fetchVaultData", "pxCVX price failed (using 0)", { error: String(pxCvxPriceResult.reason) });
  }

  return {
    ycvxcrv: formatKongVault(YCVXCRV_VAULT, kongData.data.ycvxcrv),
    yscvxcrv: formatKongVault(YSCVXCRV_VAULT, kongData.data.yscvxcrv),
    yscvgcvx: formatKongVault(YSCVGCVX_VAULT, kongData.data.yscvgcvx),
    yspxcvx: {
      address: YSPXCVX_VAULT,
      ...yspxcvxData,
      tvlUsd: yspxcvxData.tvl * pxCvxPrice,
    },
    cvxCrvPrice,
    cvgCvxPrice,
    pxCvxPrice,
    lastUpdated: new Date().toISOString(),
  };
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

    return new Response("Not found", { status: 404 });
  },
};
