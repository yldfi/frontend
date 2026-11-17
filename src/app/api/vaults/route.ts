import { NextResponse } from "next/server";
import { CACHE_WORKER_VAULTS_PATH, getCacheWorkerFetch } from "@/lib/cache-worker";
import { cachedUpstreamJson } from "@/lib/upstream-json-cache";

export const dynamic = "force-dynamic";

const VAULTS_TTL_SECONDS = 60;

/** Upstream answered with a non-2xx status. Never cached. */
class UpstreamStatusError extends Error {
  constructor(readonly status: number) {
    super(`upstream ${status}`);
  }
}

/**
 * Upstream answered 2xx with a reply that must not be cached: an error body or an
 * empty object. Returned to the caller unchanged, never stored.
 */
class UncacheableBody extends Error {
  constructor(readonly body: unknown) {
    super("uncacheable body");
  }
}

/**
 * The cache worker's /api/vaults payload is an object keyed by vault (plus prices and
 * lastUpdated). An empty object or a top-level `error` reply is not worth storing.
 */
function isCompleteVaultsBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  if (Object.hasOwn(body, "error")) return false;
  return Object.keys(body).length > 0;
}

export async function GET() {
  // Service binding in production, CACHE_WORKER_URL (.env.local) in dev
  const fetchCacheWorker = getCacheWorkerFetch();

  if (!fetchCacheWorker) {
    console.error("CACHE_WORKER_URL environment variable is required");
    return NextResponse.json(
      { error: "Configuration error" },
      { status: 500 }
    );
  }

  try {
    const { value: data, status } = await cachedUpstreamJson(
      "vaults",
      "all",
      VAULTS_TTL_SECONDS,
      async () => {
        const response = await fetchCacheWorker(CACHE_WORKER_VAULTS_PATH, {
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) throw new UpstreamStatusError(response.status);
        const body: unknown = await response.json();
        // An error reply or an empty payload has nothing to serve; never store it.
        if (!isCompleteVaultsBody(body)) throw new UncacheableBody(body);
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
        { error: "Failed to fetch vault data" },
        { status: error.status }
      );
    }
    console.error("Vault cache proxy error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
