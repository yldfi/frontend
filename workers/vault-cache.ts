// Cloudflare Worker for caching vault data
// Runs on a cron schedule to fetch and cache vault data from Ethereum

const RPC_URL = "https://eth.llamarpc.com";

// Contract addresses
const YCVXCRV_VAULT = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86";
const YSCVXCRV_VAULT = "0xCa960E6DF1150100586c51382f619efCCcF72706";
const CVXCRV_TOKEN = "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7";

// Function selectors
const TOTAL_ASSETS = "0x01e1d114"; // totalAssets()
const PRICE_PER_SHARE = "0x99530b06"; // pricePerShare()
const DECIMALS = "0x313ce567"; // decimals()

interface Env {
  VAULT_CACHE: KVNamespace;
}

async function ethCall(to: string, data: string): Promise<string> {
  const response = await fetch(RPC_URL, {
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
    // Convert to human readable (18 decimals)
    tvl: Number(totalAssets) / 1e18,
    pps: Number(pricePerShare) / 1e18,
  };
}

async function getCvxCrvPrice(): Promise<number> {
  // Fetch from Curve prices API
  try {
    const response = await fetch(
      `https://prices.curve.fi/v1/usd_price/ethereum/${CVXCRV_TOKEN}`
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

async function fetchVaultData() {
  const [ycvxcrvData, yscvxcrvData, cvxCrvPrice] = await Promise.all([
    getVaultData(YCVXCRV_VAULT),
    getVaultData(YSCVXCRV_VAULT),
    getCvxCrvPrice(),
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
    cvxCrvPrice,
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
