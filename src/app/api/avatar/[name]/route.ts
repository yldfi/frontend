import { NextRequest, NextResponse } from "next/server";

// Rate limiting: 60 requests per minute per IP
const MAX_REQUESTS_PER_MINUTE = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const requestLog = new Map<string, number[]>();

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function isRateLimited(clientIp: string): boolean {
  const now = Date.now();
  const entries = requestLog.get(clientIp) ?? [];
  const recent = entries.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_MINUTE) {
    requestLog.set(clientIp, recent);
    return true;
  }
  recent.push(now);
  requestLog.set(clientIp, recent);
  return false;
}

/**
 * ENS Avatar CORS Proxy
 * Proxies requests to euc.li with proper CORS headers
 *
 * Usage: /api/avatar/vitalik.eth
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  // Rate limiting
  const clientIp = getClientIp(request);
  if (isRateLimited(clientIp)) {
    return new NextResponse("Rate limit exceeded", {
      status: 429,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  const { name } = await params;

  if (!name || !name.includes(".")) {
    return NextResponse.json({ error: "Invalid ENS name" }, { status: 400 });
  }

  try {
    const avatarUrl = `https://euc.li/${name}`;
    const response = await fetch(avatarUrl, {
      headers: {
        "User-Agent": "yld ENS Avatar Proxy",
      },
    });

    if (!response.ok) {
      return new NextResponse("Avatar not found", {
        status: response.status,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const body = await response.arrayBuffer();

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600", // 1 hour cache
      },
    });
  } catch {
    return new NextResponse("Failed to fetch avatar", {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
