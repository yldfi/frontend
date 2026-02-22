import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const NONCE_TTL_MS = 30_000;

// Allowed origins for CORS
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

// Rate limiting: 20 requests per minute per IP
const MAX_REQUESTS_PER_MINUTE = 20;
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

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function signPayload(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { headers: getCorsHeaders(request) });
}

export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  // Rate limiting
  const clientIp = getClientIp(request);
  if (isRateLimited(clientIp)) {
    return NextResponse.json(
      { success: false, errorMessage: "Rate limit exceeded" },
      { status: 429, headers: corsHeaders }
    );
  }

  const secret = process.env.SIMULATION_NONCE_SECRET;
  if (!secret) {
    return NextResponse.json(
      { success: false, errorMessage: "Nonce secret not configured" },
      { status: 500, headers: corsHeaders }
    );
  }

  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = base64UrlEncode(nonceBytes);
  const expires = Date.now() + NONCE_TTL_MS;
  const payload = `${nonce}.${expires}`;
  const sig = await signPayload(secret, payload);

  return NextResponse.json({
    success: true,
    nonce,
    expires,
    sig,
  }, { headers: corsHeaders });
}
