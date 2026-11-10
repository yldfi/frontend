import { describe, it, expect } from "vitest";
import { QUOTE_IDLE_MS, QUOTE_MAX_AGE_MS, isQuoteOlderThan } from "@/lib/quote-freshness";

describe("quote freshness", () => {
  it("uses a 3 min idle stop and a 90 s execute limit (refresh runs every 60 s)", () => {
    expect(QUOTE_IDLE_MS).toBe(180_000);
    expect(QUOTE_MAX_AGE_MS).toBe(90_000);
  });

  it("flags only quotes older than the limit", () => {
    const now = 1_000_000_000;
    expect(isQuoteOlderThan(now - 90_001, QUOTE_MAX_AGE_MS, now)).toBe(true);
    expect(isQuoteOlderThan(now - 90_000, QUOTE_MAX_AGE_MS, now)).toBe(false);
    expect(isQuoteOlderThan(now - 1_000, QUOTE_MAX_AGE_MS, now)).toBe(false);
  });

  it("treats 'no quote time yet' (0) as not stale", () => {
    expect(isQuoteOlderThan(0)).toBe(false);
  });
});
