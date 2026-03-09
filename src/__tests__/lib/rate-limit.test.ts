import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import type { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// createRateLimiter
// ---------------------------------------------------------------------------

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests under the limit", () => {
    const isRateLimited = createRateLimiter(3);

    expect(isRateLimited("127.0.0.1")).toBe(false);
    expect(isRateLimited("127.0.0.1")).toBe(false);
    expect(isRateLimited("127.0.0.1")).toBe(false);
  });

  it("blocks requests at the limit", () => {
    const isRateLimited = createRateLimiter(3);

    isRateLimited("127.0.0.1");
    isRateLimited("127.0.0.1");
    isRateLimited("127.0.0.1");

    expect(isRateLimited("127.0.0.1")).toBe(true);
  });

  it("tracks different IPs separately", () => {
    const isRateLimited = createRateLimiter(2);

    // Exhaust limit for IP "a"
    isRateLimited("a");
    isRateLimited("a");
    expect(isRateLimited("a")).toBe(true);

    // IP "b" should still be allowed
    expect(isRateLimited("b")).toBe(false);
    expect(isRateLimited("b")).toBe(false);
  });

  it("resets after the window expires", () => {
    const windowMs = 10_000;
    const isRateLimited = createRateLimiter(2, windowMs);

    isRateLimited("x");
    isRateLimited("x");
    expect(isRateLimited("x")).toBe(true);

    // Advance past the window
    vi.advanceTimersByTime(windowMs + 1);

    expect(isRateLimited("x")).toBe(false);
  });

  it("uses a default window of 60 seconds", () => {
    const isRateLimited = createRateLimiter(1);

    isRateLimited("ip");
    expect(isRateLimited("ip")).toBe(true);

    // Advance 61 seconds — past the default 60s window
    vi.advanceTimersByTime(61_000);

    expect(isRateLimited("ip")).toBe(false);
  });

  it("respects a custom window", () => {
    const isRateLimited = createRateLimiter(2, 5_000);

    isRateLimited("c");
    isRateLimited("c");
    expect(isRateLimited("c")).toBe(true);

    // 4 seconds — still within window
    vi.advanceTimersByTime(4_000);
    expect(isRateLimited("c")).toBe(true);

    // 1.5 more seconds — now past the 5s window for the original entries
    vi.advanceTimersByTime(1_500);
    expect(isRateLimited("c")).toBe(false);
  });

  it("cleanup evicts stale entries after 5 minutes", () => {
    const windowMs = 10_000;
    const isRateLimited = createRateLimiter(2, windowMs);

    // Use up the limit
    isRateLimited("stale");
    isRateLimited("stale");
    expect(isRateLimited("stale")).toBe(true);

    // Advance 5+ minutes so cleanup triggers, and also past the window
    vi.advanceTimersByTime(5 * 60_000 + 1);

    // The next call should trigger cleanup, evicting stale entries.
    // Since windowMs has long passed, IP is no longer limited.
    expect(isRateLimited("stale")).toBe(false);
  });

  it("works with a single request limit", () => {
    const isRateLimited = createRateLimiter(1);

    expect(isRateLimited("solo")).toBe(false);
    expect(isRateLimited("solo")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getClientIp
// ---------------------------------------------------------------------------

function mockRequest(
  headers: Record<string, string>,
): Parameters<typeof getClientIp>[0] {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

describe("getClientIp", () => {
  it("prefers cf-connecting-ip header", () => {
    const req = mockRequest({
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "5.6.7.8",
    });

    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("falls back to x-forwarded-for when cf-connecting-ip is absent", () => {
    const req = mockRequest({
      "x-forwarded-for": "10.0.0.1",
    });

    expect(getClientIp(req)).toBe("10.0.0.1");
  });

  it("trims whitespace from x-forwarded-for", () => {
    const req = mockRequest({
      "x-forwarded-for": "  9.8.7.6  , 1.1.1.1",
    });

    expect(getClientIp(req)).toBe("9.8.7.6");
  });

  it('returns "unknown" when no relevant headers are present', () => {
    const req = mockRequest({});

    expect(getClientIp(req)).toBe("unknown");
  });

  it("returns the first IP from a multi-value x-forwarded-for", () => {
    const req = mockRequest({
      "x-forwarded-for": "203.0.113.50, 70.41.3.18, 150.172.238.178",
    });

    expect(getClientIp(req)).toBe("203.0.113.50");
  });
});
