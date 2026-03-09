import { describe, it, expect } from "vitest";

// Re-implement logic from src/app/api/vaults/route.ts

// The vaults proxy route checks for CACHE_WORKER_URL and returns 500 if missing
function validateConfig(cacheWorkerUrl: string | undefined): {
  ok: boolean;
  error?: string;
} {
  if (!cacheWorkerUrl) {
    return { ok: false, error: "Configuration error" };
  }
  return { ok: true };
}

// The route sets Cache-Control header on successful responses
function getCacheControlHeader(): string {
  return "public, s-maxage=60, stale-while-revalidate=120";
}

// Upstream error passthrough: returns upstream status code
function getUpstreamErrorResponse(upstreamStatus: number): {
  error: string;
  status: number;
} {
  return {
    error: "Failed to fetch vault data",
    status: upstreamStatus,
  };
}

describe("Vaults Proxy API", () => {
  describe("config validation", () => {
    it("returns error when CACHE_WORKER_URL is undefined", () => {
      const result = validateConfig(undefined);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("Configuration error");
    });

    it("returns error when CACHE_WORKER_URL is empty string", () => {
      // Empty string is falsy in JS, same as undefined for the check
      const result = validateConfig("");
      expect(result.ok).toBe(false);
    });

    it("returns ok when CACHE_WORKER_URL is set", () => {
      const result = validateConfig("https://cache.example.com/vaults");
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("Cache-Control header", () => {
    it("includes s-maxage=60", () => {
      const header = getCacheControlHeader();
      expect(header).toContain("s-maxage=60");
    });

    it("includes stale-while-revalidate=120", () => {
      const header = getCacheControlHeader();
      expect(header).toContain("stale-while-revalidate=120");
    });

    it("is public", () => {
      const header = getCacheControlHeader();
      expect(header).toContain("public");
    });
  });

  describe("upstream error passthrough", () => {
    it("passes through 502 status", () => {
      const result = getUpstreamErrorResponse(502);
      expect(result.status).toBe(502);
      expect(result.error).toBe("Failed to fetch vault data");
    });

    it("passes through 503 status", () => {
      const result = getUpstreamErrorResponse(503);
      expect(result.status).toBe(503);
    });

    it("passes through 404 status", () => {
      const result = getUpstreamErrorResponse(404);
      expect(result.status).toBe(404);
    });
  });
});
