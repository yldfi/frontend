import { describe, expect, it } from "vitest";
import { buildCurveMarketStats, type MarketRates } from "@/hooks/useCurveMarketRates";

describe("buildCurveMarketStats", () => {
  it("uses the active policy APR directly instead of deriving a semilog rate", () => {
    const raw: MarketRates = {
      policyAddress: "0x066a89BdF4EFb6ad58427D278f16b7A2C53C3EE" as `0x${string}`,
      currentBorrowApr: 14.1331116908448,
      totalDebt: 6140307232344542440089n,
      totalAssets: 9920963285178582941180n,
      utilization: 0.6189224832146946,
    };

    const stats = buildCurveMarketStats(raw);

    expect(stats.borrowApr).toBeCloseTo(14.1331116908448, 8);
    expect(stats.borrowApy).toBeCloseTo(15.18059672816452, 8);
    expect(stats.totalBorrowed).toBe("6.1K");
    expect(stats.availableLiquidity).toBe("3.8K");
    expect(stats.raw.policyAddress).toBe(raw.policyAddress);
  });
});
