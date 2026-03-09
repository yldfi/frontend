import { describe, it, expect } from "vitest";

// Re-implement logic from src/app/api/simulate/share/[simulationId]/route.ts

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((value.length + 3) % 4);
  const bytes = Buffer.from(padded, "base64");
  return new Uint8Array(bytes);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
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
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );
  return base64UrlEncode(new Uint8Array(signature));
}

async function verifySignature(
  secret: string,
  payload: string,
  signature: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );
  const expectedBytes = new Uint8Array(expected);
  const providedBytes = base64UrlDecode(signature);
  return timingSafeEqual(expectedBytes, providedBytes);
}

// Simulation ID validation regex from route.ts
const SIMULATION_ID_REGEX = /^[a-f0-9-]+$/i;

function isValidSimulationId(id: string): boolean {
  return !!id && SIMULATION_ID_REGEX.test(id);
}

describe("Simulate Share API", () => {
  describe("base64UrlDecode", () => {
    it("round-trips with base64UrlEncode", () => {
      const original = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const encoded = base64UrlEncode(original);
      const decoded = base64UrlDecode(encoded);
      expect(decoded).toEqual(original);
    });

    it("handles URL-safe characters (- and _)", () => {
      // Base64 with + and / should be decoded after conversion to - and _
      const bytes = new Uint8Array(Array.from({ length: 32 }, (_, i) => i * 8));
      const encoded = base64UrlEncode(bytes);
      // Verify no standard base64 chars
      expect(encoded).not.toMatch(/[+/=]/);
      const decoded = base64UrlDecode(encoded);
      expect(decoded).toEqual(bytes);
    });

    it("restores padding correctly", () => {
      // 1 byte → 4 chars in base64 but 2 needed + 2 padding
      const one = base64UrlEncode(new Uint8Array([255]));
      expect(one).not.toContain("=");
      const decoded = base64UrlDecode(one);
      expect(decoded).toEqual(new Uint8Array([255]));
    });

    it("handles empty input", () => {
      const encoded = base64UrlEncode(new Uint8Array([]));
      const decoded = base64UrlDecode(encoded);
      expect(decoded).toEqual(new Uint8Array([]));
    });

    it("handles 32-byte HMAC output", () => {
      const hmacLike = new Uint8Array(32);
      for (let i = 0; i < 32; i++) hmacLike[i] = i;
      const encoded = base64UrlEncode(hmacLike);
      const decoded = base64UrlDecode(encoded);
      expect(decoded).toEqual(hmacLike);
    });
  });

  describe("simulation ID validation", () => {
    it("accepts valid UUIDs", () => {
      expect(
        isValidSimulationId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
      ).toBe(true);
    });

    it("accepts hex strings without dashes", () => {
      expect(isValidSimulationId("a1b2c3d4e5f67890abcdef1234567890")).toBe(
        true
      );
    });

    it("accepts uppercase hex", () => {
      expect(isValidSimulationId("A1B2C3D4-E5F6-7890-ABCD-EF1234567890")).toBe(
        true
      );
    });

    it("rejects empty string", () => {
      expect(isValidSimulationId("")).toBe(false);
    });

    it("rejects strings with invalid characters", () => {
      expect(isValidSimulationId("abc-xyz-123")).toBe(false); // x, y, z not hex
      expect(isValidSimulationId("abc!def")).toBe(false);
      expect(isValidSimulationId("abc def")).toBe(false);
      expect(isValidSimulationId("abc/def")).toBe(false);
    });

    it("rejects strings with special characters", () => {
      expect(isValidSimulationId("abc<script>")).toBe(false);
      expect(isValidSimulationId("abc;DROP TABLE")).toBe(false);
    });
  });

  describe("verifySignature (share endpoint)", () => {
    const SECRET = "share-secret-key-test";

    it("verifies valid signature", async () => {
      const simId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
      const sig = await signPayload(SECRET, simId);
      const valid = await verifySignature(SECRET, simId, sig);
      expect(valid).toBe(true);
    });

    it("rejects forged signature", async () => {
      const simId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
      const sig = await signPayload(SECRET, "different-id");
      const valid = await verifySignature(SECRET, simId, sig);
      expect(valid).toBe(false);
    });

    it("rejects wrong secret", async () => {
      const simId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
      const sig = await signPayload(SECRET, simId);
      const valid = await verifySignature("wrong-secret", simId, sig);
      expect(valid).toBe(false);
    });

    it("is payload-specific (different IDs produce different sigs)", async () => {
      const sig1 = await signPayload(SECRET, "id-1");
      const sig2 = await signPayload(SECRET, "id-2");
      expect(sig1).not.toBe(sig2);
    });
  });
});
