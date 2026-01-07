// Cloudflare Worker for caching vault data
// Runs on a cron schedule to fetch and cache vault data from Ethereum

const RPC_URL = "https://eth.llamarpc.com";

// Contract addresses
const YCVXCRV_VAULT = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86";
const YSCVXCRV_VAULT = "0xCa960E6DF1150100586c51382f619efCCcF72706";
const YSCVGCVX_VAULT = "0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359";
const CVXCRV_TOKEN = "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7";
const CVGCVX_TOKEN = "0x2191DF768ad71140F9F3E96c1e4407A4aA31d082";

// Function selectors
const TOTAL_ASSETS = "0x01e1d114"; // totalAssets()
const PRICE_PER_SHARE = "0x99530b06"; // pricePerShare()
const DECIMALS = "0x313ce567"; // decimals()

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

async function ethCall(to: string, data: string): Promise<string> {
  const response = await fetchWithRetry(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  const json = (await response.json()) as { result: string };
  return json.result;
}

async function getVaultData(vaultAddress: string) {
  const [totalAssetsHex, pricePerShareHex] = await Promise.all([
    ethCall(vaultAddress, TOTAL_ASSETS),
    ethCall(vaultAddress, PRICE_PER_SHARE),
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

async function getCvxCrvPrice(): Promise<number> {
  // Fetch from Curve prices API with retry
  try {
    const response = await fetchWithRetry(
      `https://prices.curve.fi/v1/usd_price/ethereum/${CVXCRV_TOKEN}`,
      undefined,
      2
    );
    if (response.ok) {
      const data = (await response.json()) as { data: { usd_price: number } };
      return data.data?.usd_price || 0;
    }
  } catch (e) {
    console.error("Curve price API error:", e);
  }
  return 0;
}

async function getCvgCvxPrice(): Promise<number> {
  // Fetch from Curve prices API with retry
  try {
    const response = await fetchWithRetry(
      `https://prices.curve.fi/v1/usd_price/ethereum/${CVGCVX_TOKEN}`,
      undefined,
      2
    );
    if (response.ok) {
      const data = (await response.json()) as { data: { usd_price: number } };
      return data.data?.usd_price || 0;
    }
  } catch (e) {
    console.error("Curve price API error for cvgCVX:", e);
  }
  return 0;
}

async function fetchVaultData() {
  const [ycvxcrvData, yscvxcrvData, yscvgcvxData, cvxCrvPrice, cvgCvxPrice] = await Promise.all([
    getVaultData(YCVXCRV_VAULT),
    getVaultData(YSCVXCRV_VAULT),
    getVaultData(YSCVGCVX_VAULT),
    getCvxCrvPrice(),
    getCvgCvxPrice(),
  ]);

  return {
    ycvxcrv: {
      address: YCVXCRV_VAULT,
      ...ycvxcrvData,
      tvlUsd: ycvxcrvData.tvl * cvxCrvPrice,
    },
    yscvxcrv: {
      address: YSCVXCRV_VAULT,
      ...yscvxcrvData,
      tvlUsd: yscvxcrvData.tvl * cvxCrvPrice,
    },
    yscvgcvx: {
      address: YSCVGCVX_VAULT,
      ...yscvgcvxData,
      tvlUsd: yscvgcvxData.tvl * cvgCvxPrice,
    },
    cvxCrvPrice,
    cvgCvxPrice,
    lastUpdated: new Date().toISOString(),
  };
}

export default {
  // Cron trigger handler
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    try {
      const data = await fetchVaultData();
      await env.VAULT_CACHE.put("vault-data", JSON.stringify(data), {
        expirationTtl: 600, // 10 minutes TTL as backup
      });
      console.log("Vault data cached successfully:", data.lastUpdated);
    } catch (error) {
      console.error("Failed to cache vault data:", error);
    }
  },

  // HTTP handler for manual trigger and reading cache
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /api/vaults - Read cached data
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
      return new Response(JSON.stringify({ error: "No cached data" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /api/vaults/refresh - Manual refresh (for testing)
    if (url.pathname === "/api/vaults/refresh" && request.method === "POST") {
      const data = await fetchVaultData();
      await env.VAULT_CACHE.put("vault-data", JSON.stringify(data), {
        expirationTtl: 600,
      });
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
