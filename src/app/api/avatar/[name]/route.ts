import { NextRequest, NextResponse } from "next/server";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

const isRateLimited = createRateLimiter(60);

// Allowed origins for CORS (same as simulate endpoint)
const ALLOWED_ORIGINS = [
  "https://yldfi.co",
  "https://www.yldfi.co",
  ...(process.env.NODE_ENV === "development" ? ["http://localhost:3000"] : []),
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

// Only passive raster formats are re-served from our origin. SVG and HTML
// are active content and are refused.
const ALLOWED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_FETCH_TIMEOUT_MS = 10_000;

/** Read an upstream body without buffering more than the avatar cap. */
async function readBodyWithinLimit(response: Response): Promise<ArrayBuffer | null> {
  if (!response.body) {
    const body = await response.arrayBuffer();
    return body.byteLength > MAX_AVATAR_BYTES ? null : body;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_AVATAR_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  const body = new ArrayBuffer(total);
  const view = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return new NextResponse("Avatar not found", {
        status: response.status,
        headers: corsHeaders,
      });
    }

    const contentType = (response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_AVATAR_TYPES.has(contentType)) {
      await response.body?.cancel().catch(() => {});
      return new NextResponse("Unsupported avatar type", { status: 415, headers: corsHeaders });
    }
    const declaredLength = Number(response.headers.get("content-length") || "0");
    if (declaredLength > MAX_AVATAR_BYTES) {
      await response.body?.cancel().catch(() => {});
      return new NextResponse("Avatar too large", { status: 413, headers: corsHeaders });
    }
    const body = await readBodyWithinLimit(response);
    if (!body) {
      return new NextResponse("Avatar too large", { status: 413, headers: corsHeaders });
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": "inline; filename=\"avatar\"",
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
