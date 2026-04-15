import { NextRequest, NextResponse } from "next/server";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const KONG_API_URL = "https://kong.yearn.farm/api/gql";

// GET-based proxy for Kong (Yearn Finance's GraphQL API).
//
// Kong's Vercel edge gateway intermittently rejects browser CORS preflights
// with 403. Proxying through our own origin avoids this. GET requests with
// query params are cacheable by Cloudflare (POSTs are not by default), so the
// per-op Cache-Control below actually produces edge hits.

const isRateLimited = createRateLimiter(120);

const FORWARD_HEADERS: HeadersInit = {
  "content-type": "application/json",
  accept: "application/json",
  "user-agent": "yldfi/1.0 (+https://yldfi.co)",
};

interface OpSpec {
  // Fixed GraphQL query run for this op.
  query: string;
  // Build variables from request search params. Return null to 400.
  buildVars: (params: URLSearchParams) => Record<string, unknown> | null;
  // Cache-Control header used on upstream success.
  cacheControl: string;
}

const HEX40 = /^0x[a-fA-F0-9]{40}$/;

function parseChainId(params: URLSearchParams): number | null {
  const raw = params.get("chainId") ?? "1";
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseAddress(params: URLSearchParams): string | null {
  const addr = params.get("address");
  return addr && HEX40.test(addr) ? addr : null;
}

function parseLimit(params: URLSearchParams, fallback: number, max = 1000): number | null {
  const raw = params.get("limit");
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > max) return null;
  return n;
}

const OPS: Record<string, OpSpec> = {
  vault: {
    query: `
      query Query($chainId: Int, $address: String) {
        vault(chainId: $chainId, address: $address) {
          chainId address name symbol
          asset { address name symbol decimals }
          accountant pricePerShare totalAssets totalDebt
          fees { managementFee performanceFee }
          tvl { close }
          apy { close: net grossApr weeklyNet monthlyNet inceptionNet }
          debts { strategy currentDebt currentDebtUsd targetDebtRatio }
        }
        vaultStrategies(chainId: $chainId, vault: $address) {
          chainId address name
        }
      }
    `,
    buildVars: (p) => {
      const chainId = parseChainId(p);
      const address = parseAddress(p);
      if (chainId === null || address === null) return null;
      return { chainId, address };
    },
    // Current vault state (APY, TVL). Updates ~minutely — cache short, allow stale.
    cacheControl: "public, s-maxage=60, stale-while-revalidate=300",
  },
  tvl: {
    query: `
      query($chainId: Int, $address: String, $limit: Int) {
        timeseries(chainId: $chainId, address: $address, label: "tvl", limit: $limit) {
          value time
        }
      }
    `,
    buildVars: (p) => {
      const chainId = parseChainId(p);
      const address = parseAddress(p);
      const limit = parseLimit(p, 365);
      if (chainId === null || address === null || limit === null) return null;
      return { chainId, address, limit };
    },
    // Historical TVL — daily buckets. Cache aggressively.
    cacheControl: "public, s-maxage=3600, stale-while-revalidate=86400",
  },
  pps: {
    query: `
      query($chainId: Int, $address: String, $limit: Int) {
        timeseries(chainId: $chainId, address: $address, label: "pps", component: "humanized", limit: $limit) {
          value time
        }
      }
    `,
    buildVars: (p) => {
      const chainId = parseChainId(p);
      const address = parseAddress(p);
      const limit = parseLimit(p, 395);
      if (chainId === null || address === null || limit === null) return null;
      return { chainId, address, limit };
    },
    cacheControl: "public, s-maxage=3600, stale-while-revalidate=86400",
  },
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ op: string }> }
) {
  const { op } = await params;
  const spec = OPS[op];
  if (!spec) {
    return NextResponse.json({ error: "Unknown op" }, { status: 404 });
  }

  if (isRateLimited(getClientIp(request))) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const variables = spec.buildVars(request.nextUrl.searchParams);
  if (!variables) {
    return NextResponse.json({ error: "Invalid params" }, { status: 400 });
  }

  try {
    const upstream = await fetch(KONG_API_URL, {
      method: "POST",
      headers: FORWARD_HEADERS,
      body: JSON.stringify({ query: spec.query, variables }),
    });

    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Kong upstream error: ${upstream.status}` },
        { status: upstream.status }
      );
    }

    const data = await upstream.json();
    return NextResponse.json(data, { headers: { "Cache-Control": spec.cacheControl } });
  } catch (error) {
    console.error(`[Kong proxy /${op}] error forwarding`, error);
    return NextResponse.json({ error: "Kong proxy error" }, { status: 502 });
  }
}
