import { NextRequest, NextResponse } from "next/server";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import { cachedUpstreamJson } from "@/lib/upstream-json-cache";

export const dynamic = "force-dynamic";

const KONG_API_URL = "https://kong.yearn.farm/api/gql";

// GET-based proxy for Kong (Yearn Finance's GraphQL API).
//
// Kong's Vercel edge gateway intermittently rejects browser CORS preflights
// with 403. Proxying through our own origin avoids this. Upstream JSON is
// cached inside this handler (see cachedUpstreamJson); the Cache-Control header
// below is advisory only, because Workers Caching is disabled — see
// wrangler.jsonc.

const isRateLimited = createRateLimiter(120);

/** Upstream answered with a non-2xx status. Never cached. */
class UpstreamStatusError extends Error {
  constructor(readonly status: number) {
    super(`upstream ${status}`);
  }
}

/**
 * GraphQL answered 200 with a body that must not be stored: any `errors` or no usable
 * payload. Returned to the caller as-is, never cached.
 */
class UncacheableBody extends Error {
  constructor(readonly body: unknown) {
    super("uncacheable body");
  }
}

/** True when the reply carries a non-empty `errors` array. */
function hasGraphqlErrors(body: object): boolean {
  const { errors } = body as { errors?: unknown };
  return Array.isArray(errors) && errors.length > 0;
}

/** True when `data` is absent or is not an object. */
function hasNoDataObject(body: object): boolean {
  const { data } = body as { data?: unknown };
  return typeof data !== "object" || data === null || Array.isArray(data);
}

/** True when the op answered with an empty payload. */
function isEmptyPayload(op: string, data: Record<string, unknown>): boolean {
  if (op === "vault") return data.vault == null;
  // Timeseries ops (tvl, pps, …): a missing or empty series has nothing to serve.
  const { timeseries } = data;
  return !Array.isArray(timeseries) || timeseries.length === 0;
}

function isUncacheableBody(op: string, body: unknown): boolean {
  if (typeof body !== "object" || body === null) return true;
  if (hasGraphqlErrors(body)) return true;
  if (hasNoDataObject(body)) return true;
  return isEmptyPayload(op, (body as { data: Record<string, unknown> }).data);
}

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
  // Cache-Control header used on upstream success (advisory only).
  cacheControl: string;
  // How long to cache the upstream JSON inside this handler.
  ttlSeconds: number;
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
    ttlSeconds: 60,
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
    ttlSeconds: 3600,
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
    ttlSeconds: 3600,
  },
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ op: string }> }
) {
  const { op } = await params;
  // Object.hasOwn, not OPS[op] alone: a path like /constructor must not resolve an
  // inherited Object.prototype member.
  if (!Object.hasOwn(OPS, op)) {
    return NextResponse.json({ error: "Unknown op" }, { status: 404 });
  }
  const spec = OPS[op];

  if (isRateLimited(getClientIp(request))) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const variables = spec.buildVars(request.nextUrl.searchParams);
  if (!variables) {
    return NextResponse.json({ error: "Invalid params" }, { status: 400 });
  }

  // Variables come from buildVars in a fixed key order, so this is stable. The cache
  // key lowercases the address so two casings share one entry; the variables sent
  // upstream keep the caller's casing.
  const cacheKeyVars =
    typeof variables.address === "string"
      ? { ...variables, address: variables.address.toLowerCase() }
      : variables;
  const cacheKey = `${op}:${JSON.stringify(cacheKeyVars)}`;

  try {
    const { value: data, status } = await cachedUpstreamJson(
      "kong",
      cacheKey,
      spec.ttlSeconds,
      async () => {
        const upstream = await fetch(KONG_API_URL, {
          method: "POST",
          headers: FORWARD_HEADERS,
          body: JSON.stringify({ query: spec.query, variables }),
        });

        if (!upstream.ok) throw new UpstreamStatusError(upstream.status);

        const body: unknown = await upstream.json();
        // An error reply or an empty payload is not data: return it, but never cache it.
        if (isUncacheableBody(op, body)) throw new UncacheableBody(body);
        return body;
      }
    );

    return NextResponse.json(data, {
      headers: { "Cache-Control": spec.cacheControl, "x-yld-cache": status },
    });
  } catch (error) {
    if (error instanceof UncacheableBody) {
      return NextResponse.json(error.body, { status: 200 });
    }
    if (error instanceof UpstreamStatusError) {
      return NextResponse.json(
        { error: `Kong upstream error: ${error.status}` },
        { status: error.status }
      );
    }
    console.error(`[Kong proxy /${op}] error forwarding`, error);
    return NextResponse.json({ error: "Kong proxy error" }, { status: 502 });
  }
}
