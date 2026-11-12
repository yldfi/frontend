import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRateLimiter, createSharedRateLimiter, getClientIp } from "@/lib/rate-limit";
import type { NextRequest } from "next/server";

const { mockGetCloudflareContext } = vi.hoisted(() => ({
  mockGetCloudflareContext: vi.fn(),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mockGetCloudflareContext,
}));

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

// ---------------------------------------------------------------------------
// createSharedRateLimiter
// ---------------------------------------------------------------------------

describe("createSharedRateLimiter", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetCloudflareContext.mockReset();
    mockGetCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("behaves like the in-memory limiter when there is no binding", async () => {
    const isRateLimited = createSharedRateLimiter("RL_TEST_NONE", 2);

    await expect(isRateLimited("203.0.113.1")).resolves.toBe(false);
    await expect(isRateLimited("203.0.113.1")).resolves.toBe(false);
    await expect(isRateLimited("203.0.113.1")).resolves.toBe(true);
  });

  it("does not limit a request the binding accepts", async () => {
    const binding = { limit: vi.fn().mockResolvedValue({ success: true }) };
    mockGetCloudflareContext.mockReturnValue({ env: { RL_TEST_ALLOW: binding } });

    const isRateLimited = createSharedRateLimiter("RL_TEST_ALLOW", 10);

    await expect(isRateLimited("203.0.113.2")).resolves.toBe(false);
    expect(binding.limit).toHaveBeenCalledWith({ key: "203.0.113.2" });
  });

  it("limits a request the binding rejects", async () => {
    const binding = { limit: vi.fn().mockResolvedValue({ success: false }) };
    mockGetCloudflareContext.mockReturnValue({ env: { RL_TEST_DENY: binding } });

    const isRateLimited = createSharedRateLimiter("RL_TEST_DENY", 10);

    await expect(isRateLimited("203.0.113.3")).resolves.toBe(true);
  });

  it("fails open and warns once when the binding throws", async () => {
    const binding = { limit: vi.fn().mockRejectedValue(new Error("binding down")) };
    mockGetCloudflareContext.mockReturnValue({ env: { RL_TEST_THROWS: binding } });

    const isRateLimited = createSharedRateLimiter("RL_TEST_THROWS", 10);

    await expect(isRateLimited("203.0.113.4")).resolves.toBe(false);
    await expect(isRateLimited("203.0.113.5")).resolves.toBe(false);
    await expect(isRateLimited("203.0.113.6")).resolves.toBe(false);
    expect(binding.limit).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("fails open when the binding resolves without a boolean success", async () => {
    const binding = { limit: vi.fn().mockResolvedValue({}) };
    mockGetCloudflareContext.mockReturnValue({ env: { RL_TEST_EMPTY: binding } });

    const isRateLimited = createSharedRateLimiter("RL_TEST_EMPTY", 10);

    await expect(isRateLimited("203.0.113.7")).resolves.toBe(false);
  });

  it("does not call the binding once the in-memory limit is reached", async () => {
    const binding = { limit: vi.fn().mockResolvedValue({ success: true }) };
    mockGetCloudflareContext.mockReturnValue({ env: { RL_TEST_MEMORY: binding } });

    const isRateLimited = createSharedRateLimiter("RL_TEST_MEMORY", 1);

    await expect(isRateLimited("203.0.113.8")).resolves.toBe(false);
    await expect(isRateLimited("203.0.113.8")).resolves.toBe(true);
    await expect(isRateLimited("203.0.113.8")).resolves.toBe(true);
    expect(binding.limit).toHaveBeenCalledTimes(1);
  });
});
