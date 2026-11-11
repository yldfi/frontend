import { NextRequest, NextResponse } from "next/server";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import { cachedUpstreamJson } from "@/lib/upstream-json-cache";

export const dynamic = "force-dynamic";

const MERKL_API_PRIMARY = "https://api.merkl.xyz";
const MERKL_API_FALLBACK = "https://api.merkl.fr";

// Merkl's Cloudflare tenant blocks many VPN / datacenter exit IPs at the edge,
// so browsers on VPNs get a 403 with no CORS headers. This proxy forwards
// requests from the yldfi origin (trusted by Cloudflare) so users behind VPNs
// can still load rewards and opportunities.

// Only forward to Merkl's public v4 API to prevent this route from becoming
// an open proxy.
const ALLOWED_PATH_PREFIXES = ["v4/"];

// 60 requests/minute/IP is generous for the two endpoints we proxy
// (rewards: 1 call per wallet per ~5min, opportunities: 1 call per ~10min).
const isRateLimited = createRateLimiter(60);

const FORWARD_HEADERS: HeadersInit = {
  Accept: "application/json",
  "User-Agent": "yldfi/1.0 (+https://yldfi.co)",
};

async function merklFetch(pathAndSearch: string): Promise<Response> {
  try {
    const res = await fetch(`${MERKL_API_PRIMARY}/${pathAndSearch}`, {
      headers: FORWARD_HEADERS,
    });
    if (res.ok) return res;
  } catch {
    // primary unreachable — try fallback host
  }
  return fetch(`${MERKL_API_FALLBACK}/${pathAndSearch}`, {
    headers: FORWARD_HEADERS,
  });
}

/** Upstream answered with a non-2xx status. Never cached. */
class UpstreamStatusError extends Error {
  constructor(readonly status: number) {
    super(`upstream ${status}`);
  }
}

/**
 * Upstream answered 2xx with a body that must not be cached: anything that is not a
 * non-empty JSON array. Returned to the caller unchanged, never stored.
 */
class UncacheableBody extends Error {
  constructor(readonly body: unknown) {
    super("uncacheable body");
  }
}

const OPPORTUNITIES_CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=600";
const OPPORTUNITIES_TTL_SECONDS = 300;

// Only the exact opportunities list is cacheable, keyed by the params the app sends
// (src/hooks/useMerklRewards.ts). Anything else is per-wallet or unknown-shaped.
// Listed in sorted order: the canonical query follows it regardless of request order.
const OPPORTUNITIES_SEARCH_PARAMS = ["campaigns", "chainId", "type"] as const;
type OpportunitiesSearchParam = (typeof OPPORTUNITIES_SEARCH_PARAMS)[number];

const OPPORTUNITIES_SEARCH_PARAM_PATTERNS: Record<OpportunitiesSearchParam, RegExp> = {
  campaigns: /^(?:true|false)$/,
  chainId: /^\d{1,10}$/,
  type: /^[A-Z_]{1,32}$/,
};

/**
 * Canonical query for an opportunities request (no leading "?"), or null when the
 * request is not cacheable: an unknown param, a repeated allow-listed param, or a
 * value outside its strict shape.
 *
 * The same string is used as the cache key and as the upstream search string, so the
 * fetched request is exactly the keyed one. Joining decoded values directly would let
 * an encoded separator (campaigns=true%26chainId%3D1) forge another request's key.
 */
function canonicalOpportunitiesSearch(params: URLSearchParams): string | null {
  const allowed = OPPORTUNITIES_SEARCH_PARAMS as readonly string[];
  for (const name of params.keys()) {
    if (!allowed.includes(name)) return null;
  }

  const pairs: [string, string][] = [];
  for (const name of OPPORTUNITIES_SEARCH_PARAMS) {
    const values = params.getAll(name);
    if (values.length > 1) return null;
    if (values.length === 1) {
      if (!OPPORTUNITIES_SEARCH_PARAM_PATTERNS[name].test(values[0])) return null;
      pairs.push([name, values[0]]);
    }
  }
  return new URLSearchParams(pairs).toString();
}

/** True only for the exact list endpoint, matched on decoded segments. */
function isOpportunitiesPath(path: string[]): boolean {
  return path.length === 2 && path[0] === "v4" && path[1] === "opportunities";
}

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const clientIp = getClientIp(request);
  if (isRateLimited(clientIp)) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429 }
    );
  }

  const { path } = await params;
  const joinedPath = path.join("/");

  if (!ALLOWED_PATH_PREFIXES.some((prefix) => joinedPath.startsWith(prefix))) {
    return NextResponse.json({ error: "Forbidden path" }, { status: 403 });
  }

  // request.nextUrl.search is "" or "?foo=bar"
  const requestPathAndSearch = `${joinedPath}${request.nextUrl.search}`;

  // Opportunities change slowly — cache the upstream JSON inside this handler, but
  // only for the exact list endpoint with the params the app sends. Everything else
  // here is per-wallet or unknown data and must never be cached server-side.
  const canonicalSearch = isOpportunitiesPath(path)
    ? canonicalOpportunitiesSearch(request.nextUrl.searchParams)
    : null;

  try {
    if (canonicalSearch !== null) {
      // Built from the validated pairs, never from the raw search string, so the
      // cache key and the upstream request cannot disagree.
      const canonicalPathAndSearch = `${joinedPath}${
        canonicalSearch ? `?${canonicalSearch}` : ""
      }`;
      const { value: data, status } = await cachedUpstreamJson(
        "merkl",
        canonicalSearch,
        OPPORTUNITIES_TTL_SECONDS,
        async () => {
          const upstream = await merklFetch(canonicalPathAndSearch);
          if (!upstream.ok) throw new UpstreamStatusError(upstream.status);
          const body: unknown = await upstream.json();
          // An error payload or an empty list is not worth caching.
          if (!isNonEmptyArray(body)) throw new UncacheableBody(body);
          return body;
        }
      );

      return NextResponse.json(data, {
        headers: { "Cache-Control": OPPORTUNITIES_CACHE_CONTROL, "x-yld-cache": status },
      });
    }

    const upstream = await merklFetch(requestPathAndSearch);
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Merkl upstream error: ${upstream.status}` },
        { status: upstream.status }
      );
    }

    const data = await upstream.json();

    // User rewards are personal, short max-age for tab-switch coalescing.
    return NextResponse.json(data, {
      headers: { "Cache-Control": "private, max-age=30" },
    });
  } catch (error) {
    if (error instanceof UncacheableBody) {
      // Same shape as the uncached branch: no cache hint towards a shared cache and
      // no x-yld-cache, because nothing was stored.
      return NextResponse.json(error.body, {
        headers: { "Cache-Control": "private, max-age=30" },
      });
    }
    if (error instanceof UpstreamStatusError) {
      return NextResponse.json(
        { error: `Merkl upstream error: ${error.status}` },
        { status: error.status }
      );
    }
    console.error("[Merkl proxy] error forwarding", requestPathAndSearch, error);
    return NextResponse.json(
      { error: "Merkl proxy error" },
      { status: 502 }
    );
  }
}
