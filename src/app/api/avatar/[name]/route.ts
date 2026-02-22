import { NextRequest, NextResponse } from "next/server";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

const isRateLimited = createRateLimiter(60);

// Allowed origins for CORS (same as simulate endpoint)
const ALLOWED_ORIGINS = [
  "https://yldfi.co",
  "https://www.yldfi.co",
  "http://localhost:3000",
];

function getCorsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
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
  const corsHeaders = getCorsHeaders(request);

  // Rate limiting
  const clientIp = getClientIp(request);
  if (isRateLimited(clientIp)) {
    return new NextResponse("Rate limit exceeded", {
      status: 429,
      headers: corsHeaders,
    });
  }

  const { name } = await params;

  // Validate ENS name format
  if (!name || !/^[a-z0-9._-]+\.eth$/i.test(name)) {
    return NextResponse.json({ error: "Invalid ENS name" }, { status: 400, headers: corsHeaders });
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
        headers: corsHeaders,
      });
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const body = await response.arrayBuffer();

    return new NextResponse(body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new NextResponse("Failed to fetch avatar", {
      status: 500,
      headers: corsHeaders,
    });
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { headers: getCorsHeaders(request) });
}
