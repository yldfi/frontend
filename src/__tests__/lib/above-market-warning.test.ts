import { describe, it, expect } from "vitest";
import {
  ABOVE_MARKET_WARN_PCT,
  aboveMarketWarning,
  isQuoteAboveMarket,
  priceImpactClassName,
} from "@/lib/price-impact";

describe("above-market quote warning", () => {
  it("flags only negatives beyond the threshold", () => {
    expect(ABOVE_MARKET_WARN_PCT).toBe(5);
    expect(isQuoteAboveMarket(-25.69)).toBe(true); // 10 Nov CRV → ETH dust quote
    expect(isQuoteAboveMarket(-5.01)).toBe(true);
    expect(isQuoteAboveMarket(-5)).toBe(false);
    expect(isQuoteAboveMarket(-0.3)).toBe(false);
    expect(isQuoteAboveMarket(38)).toBe(false);
    expect(isQuoteAboveMarket(null)).toBe(false);
    expect(isQuoteAboveMarket(Number.NaN)).toBe(false);
  });

  it("colours a large negative amber instead of green", () => {
    expect(priceImpactClassName(-25.69)).toBe("text-[var(--warning)]");
    expect(priceImpactClassName(-0.3)).toBe("text-green-500");
    expect(priceImpactClassName(0.48)).toBe("");
    expect(priceImpactClassName(1.5)).toBe("text-[var(--warning)]");
    expect(priceImpactClassName(38.01)).toBe("text-[var(--destructive)]");
    expect(priceImpactClassName(null)).toBe("");
  });

  it("explains the warning with the gap", () => {
    expect(aboveMarketWarning(-25.69)).toContain("25.7% above market");
    expect(aboveMarketWarning(-25.69)).toContain("likely fail");
    expect(aboveMarketWarning(-2)).toBeNull();
  });
});
