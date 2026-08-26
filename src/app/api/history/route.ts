import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Proxy for self-sampled on-chain history (yscvx, yspxcvx) served from the
// cache worker's R2 bucket. Returns the same { data: { timeseries } } shape as
// the Kong history endpoints so the frontend parses them identically.
export async function GET(request: NextRequest) {
  const cacheWorkerUrl = process.env.CACHE_WORKER_URL;

  if (!cacheWorkerUrl) {
    console.error("CACHE_WORKER_URL environment variable is required");
    return NextResponse.json({ error: "Configuration error" }, { status: 500 });
  }

  const { searchParams } = request.nextUrl;
  const key = searchParams.get("key");
  const metric = searchParams.get("metric") === "pps" ? "pps" : "tvl";
  if (!key) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  const upstream = new URL("/api/history", cacheWorkerUrl);
  upstream.searchParams.set("key", key);
  upstream.searchParams.set("metric", metric);

  try {
    const response = await fetch(upstream.toString(), {
      headers: { "Content-Type": "application/json" },
      next: { revalidate: 3600 },
    });
    if (!response.ok) {
      return NextResponse.json({ error: "Failed to fetch history" }, { status: response.status });
    }
    const data = await response.json();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    });
  } catch (error) {
    console.error("History proxy error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}