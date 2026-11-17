import { NextRequest, NextResponse } from "next/server";
import { getCacheWorkerFetch } from "@/lib/cache-worker";
import { cachedUpstreamJson } from "@/lib/upstream-json-cache";

export const dynamic = "force-dynamic";

const HISTORY_TTL_SECONDS = 60;

/** Upstream answered with a non-2xx status. Never cached. */
class UpstreamStatusError extends Error {
  constructor(readonly status: number) {
    super(`upstream ${status}`);
  }
}

/**
 * Upstream answered 2xx with a reply that must not be cached: anything without a
 * non-empty `data.timeseries` array. Returned to the caller unchanged, never stored.
 */
class UncacheableBody extends Error {
  constructor(readonly body: unknown) {
    super("uncacheable body");
  }
}

/** The cache worker's history reply shape: `{ data: { timeseries: [...] } }`. */
function hasNonEmptyTimeseries(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const { data } = body as { data?: unknown };
  if (typeof data !== "object" || data === null) return false;
  const { timeseries } = data as { timeseries?: unknown };
  return Array.isArray(timeseries) && timeseries.length > 0;
}

// Proxy for self-sampled on-chain history (yscvx, yspxcvx) served from the
// cache worker's R2 bucket. Returns the same { data: { timeseries } } shape as
// the Kong history endpoints so the frontend parses them identically.
export async function GET(request: NextRequest) {
  const fetchCacheWorker = getCacheWorkerFetch();

  if (!fetchCacheWorker) {
    console.error("CACHE_WORKER_URL environment variable is required");
    return NextResponse.json({ error: "Configuration error" }, { status: 500 });
  }

  const { searchParams } = request.nextUrl;
  const key = searchParams.get("key");
  const metric = searchParams.get("metric") === "pps" ? "pps" : "tvl";
  if (!key) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  const upstreamParams = new URLSearchParams({ key, metric, version: "2" });
  const upstreamPath = `/api/history?${upstreamParams.toString()}`;

  try {
    const { value: data, status } = await cachedUpstreamJson(
      "history",
      `${key}:${metric}`,
      HISTORY_TTL_SECONDS,
      async () => {
        const response = await fetchCacheWorker(upstreamPath, {
          headers: { "Content-Type": "application/json" },
        });
        if (!response.ok) throw new UpstreamStatusError(response.status);
        const body: unknown = await response.json();
        // An error reply or an empty series has nothing to serve; never store it.
        if (!hasNonEmptyTimeseries(body)) throw new UncacheableBody(body);
        return body;
      }
    );

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
        "x-yld-cache": status,
      },
    });
  } catch (error) {
    if (error instanceof UncacheableBody) {
      // Nothing was stored, so no x-yld-cache and no shared-cache hint.
      return NextResponse.json(error.body);
    }
    if (error instanceof UpstreamStatusError) {
      return NextResponse.json(
        { error: "Failed to fetch history" },
        { status: error.status }
      );
    }
    console.error("History proxy error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
