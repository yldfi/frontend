import { describe, it, expect } from "vitest";
import {
  computeLeverage,
  computeNetRate,
  buildLendingPositionDisplay,
} from "@/lib/lending";
import { parseUnits } from "viem";

// ---------------------------------------------------------------------------
// computeLeverage
// ---------------------------------------------------------------------------
describe("computeLeverage", () => {
  it("returns 1 when debt is zero", () => {
    expect(computeLeverage(10_000, 0)).toBe(1);
  });

  it("returns 2.0 for collateral=10000, debt=5000", () => {
    expect(computeLeverage(10_000, 5_000)).toBe(2.0);
  });

  it("returns 1.25 for collateral=10000, debt=2000", () => {
    expect(computeLeverage(10_000, 2_000)).toBe(1.25);
  });

  it("returns 1 when collateral equals debt (division-by-zero guard)", () => {
    expect(computeLeverage(5_000, 5_000)).toBe(1);
  });

  it("returns 1 for negative collateral", () => {
    expect(computeLeverage(-100, 50)).toBe(1);
  });

  it("returns 1 for zero collateral", () => {
    expect(computeLeverage(0, 0)).toBe(1);
  });

  it("returns 1 when debt exceeds collateral", () => {
    expect(computeLeverage(3_000, 5_000)).toBe(1);
  });

  it("returns 10.0 for high leverage (collateral=10000, debt=9000)", () => {
    expect(computeLeverage(10_000, 9_000)).toBe(10.0);
  });

  it("returns 100.0 for tiny difference (collateral=100, debt=99)", () => {
    expect(computeLeverage(100, 99)).toBe(100.0);
  });

  it("handles fractional values (collateral=1.5, debt=0.5)", () => {
    expect(computeLeverage(1.5, 0.5)).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// computeNetRate
// ---------------------------------------------------------------------------
describe("computeNetRate", () => {
  it("equals collateral rate when leverage is 1 (no borrowing component)", () => {
    expect(computeNetRate(10, 5, 1)).toBe(10);
  });

  it("computes correctly at 2x leverage", () => {
    // 10*2 - 5*(2-1) = 20 - 5 = 15
    expect(computeNetRate(10, 5, 2)).toBe(15);
  });

  it("computes correctly at high leverage (5x)", () => {
    // 10*5 - 8*(5-1) = 50 - 32 = 18
    expect(computeNetRate(10, 8, 5)).toBe(18);
  });

  it("returns 0 when borrow cost offsets collateral yield", () => {
    // 5*2 - 10*(2-1) = 10 - 10 = 0
    expect(computeNetRate(5, 10, 2)).toBe(0);
  });

  it("returns 0 when both rates are zero", () => {
    expect(computeNetRate(0, 0, 3)).toBe(0);
  });

  it("handles fractional leverage (1.5x)", () => {
    // 10*1.5 - 5*(1.5-1) = 15 - 2.5 = 12.5
    expect(computeNetRate(10, 5, 1.5)).toBe(12.5);
  });
});

// ---------------------------------------------------------------------------
// buildLendingPositionDisplay
// ---------------------------------------------------------------------------
describe("buildLendingPositionDisplay", () => {
  it("computes leverage, net rate, and formatted strings for a normal position", () => {
    // 10 tokens of collateral at $2000 each = $20,000 collateral value
    // 5000 crvUSD debt ≈ $5000
    // leverage = 20000 / (20000 - 5000) = 1.333...
    const collateral = parseUnits("10", 18);
    const debt = parseUnits("5000", 18);
    const collateralPriceUsd = 2000;
    const collateralApy = 11.5;
    const borrowApr = 7.43;

    const result = buildLendingPositionDisplay(
      collateral,
      debt,
      collateralPriceUsd,
      collateralApy,
      borrowApr,
    );

    // leverage = 20000 / 15000 = 1.3333...
    expect(result.leverage).toBeCloseTo(1.3333, 3);
    expect(result.leverageFormatted).toBe("1.33x");

    // netRate = 11.5 * 1.333 - 7.43 * 0.333 ≈ 12.86
    const expectedNet = computeNetRate(collateralApy, borrowApr, result.leverage);
    expect(result.netRate).toBeCloseTo(expectedNet, 4);

    // Collateral formatted: 10.0000 (< 1000 so 4 decimals)
    expect(result.collateralFormatted).toContain("10");

    // Debt formatted
    expect(result.debtFormatted).toContain("5");

    // Rate signs
    expect(result.collateralApyFormatted).toBe("+11.50%");
    expect(result.borrowAprFormatted).toBe("-7.43%");
    expect(result.netRateFormatted).toMatch(/^\+/);

    expect(result.hasLoan).toBe(true);
  });

  it("returns leverage=1 and hasLoan=true when debt is zero", () => {
    const collateral = parseUnits("100", 18);
    const debt = 0n;

    const result = buildLendingPositionDisplay(
      collateral,
      debt,
      1500,
      10,
      5,
    );

    expect(result.leverage).toBe(1);
    expect(result.leverageFormatted).toBe("1.00x");
    // netRate = collateralApy when leverage = 1
    expect(result.netRate).toBe(10);
    expect(result.netRateFormatted).toBe("+10.00%");
    // hasLoan is always true per implementation
    expect(result.hasLoan).toBe(true);
  });

  it("formats rate strings with correct signs", () => {
    // Create a position where net rate is negative:
    // collateral = 1 token at $1000 = $1000 value
    // debt = 500 crvUSD
    // leverage = 1000 / 500 = 2
    // netRate = 2*2 - 10*1 = 4 - 10 = -6
    const collateral = parseUnits("1", 18);
    const debt = parseUnits("500", 18);

    const result = buildLendingPositionDisplay(
      collateral,
      debt,
      1000,
      2,   // low collateral APY
      10,  // high borrow APR
    );

    expect(result.leverage).toBe(2);
    expect(result.collateralApyFormatted).toBe("+2.00%");
    expect(result.borrowAprFormatted).toBe("-10.00%");
    // netRate = 2*2 - 10*1 = -6
    expect(result.netRate).toBe(-6);
    expect(result.netRateFormatted).toBe("-6.00%");
  });
});
