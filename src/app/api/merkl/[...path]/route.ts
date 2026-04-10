import { NextRequest, NextResponse } from "next/server";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

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
  const pathAndSearch = `${joinedPath}${request.nextUrl.search}`;

  try {
    const upstream = await merklFetch(pathAndSearch);
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Merkl upstream error: ${upstream.status}` },
        { status: upstream.status }
      );
    }

    const data = await upstream.json();

    // Opportunities change slowly — cache at the edge.
    // User rewards are personal, short max-age for tab-switch coalescing.
    const isOpportunities = joinedPath.startsWith("v4/opportunities");
    const cacheControl = isOpportunities
      ? "public, s-maxage=300, stale-while-revalidate=600"
      : "private, max-age=30";

    return NextResponse.json(data, {
      headers: { "Cache-Control": cacheControl },
    });
  } catch (error) {
    console.error("[Merkl proxy] error forwarding", pathAndSearch, error);
    return NextResponse.json(
      { error: "Merkl proxy error" },
      { status: 502 }
    );
  }
}
