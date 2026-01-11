import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const NONCE_TTL_MS = 30_000;

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

export async function GET() {
  const secret = process.env.SIMULATION_NONCE_SECRET;
  if (!secret) {
    return NextResponse.json(
      { success: false, errorMessage: "Nonce secret not configured" },
      { status: 500 }
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
  });
}
