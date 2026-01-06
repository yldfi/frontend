import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  // Get URL at runtime (Cloudflare secret in production, .env.local for dev)
  const cacheWorkerUrl = process.env.CACHE_WORKER_URL;

  if (!cacheWorkerUrl) {
    console.error("CACHE_WORKER_URL environment variable is required");
    return NextResponse.json(
      { error: "Configuration error" },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(cacheWorkerUrl, {
      headers: { "Content-Type": "application/json" },
      next: { revalidate: 60 }, // Cache for 60 seconds
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to fetch vault data" },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
      },
    });
  } catch (error) {
    console.error("Vault cache proxy error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
