import { describe, it, expect } from "vitest";

// Re-implement unexported pure functions from LendingInterface.tsx for testing
// (follows avatar.test.ts pattern — test the logic, not the component)

// Semilog interest rate model: rate = minRate * (maxRate / minRate) ^ utilization
function semilogBorrowAPR(
  utilization: number,
  minRate: number,
  maxRate: number
): number {
  if (minRate <= 0 || maxRate <= 0 || utilization < 0) return 0;
  const util = Math.min(utilization, 1);
  return minRate * Math.pow(maxRate / minRate, util);
}

// Health bar color function
function getColor(h: number): string {
  if (h <= 0) return "#ef4444";
  if (h < 5) return "#ef4444";
  if (h < 10) return "#f97316";
  if (h < 20) return "#eab308";
  if (h < 40) return "#84cc16";
  return "#22c55e";
}

describe("LendingInterface", () => {
  describe("semilogBorrowAPR", () => {
    it("returns minRate at utilization = 0", () => {
      expect(semilogBorrowAPR(0, 2, 200)).toBe(2);
    });

    it("returns maxRate at utilization = 1", () => {
      expect(semilogBorrowAPR(1, 2, 200)).toBe(200);
    });

    it("returns geometric mean at utilization = 0.5", () => {
      const result = semilogBorrowAPR(0.5, 2, 200);
      // geometric mean of 2 and 200 = sqrt(2 * 200) = 20
      expect(result).toBeCloseTo(20, 5);
    });

    it("returns 0 when minRate <= 0", () => {
      expect(semilogBorrowAPR(0.5, 0, 200)).toBe(0);
      expect(semilogBorrowAPR(0.5, -1, 200)).toBe(0);
    });

    it("returns 0 when maxRate <= 0", () => {
      expect(semilogBorrowAPR(0.5, 2, 0)).toBe(0);
      expect(semilogBorrowAPR(0.5, 2, -5)).toBe(0);
    });

    it("returns 0 when utilization < 0", () => {
      expect(semilogBorrowAPR(-0.1, 2, 200)).toBe(0);
    });

    it("clamps utilization to 1", () => {
      const atOne = semilogBorrowAPR(1, 2, 200);
      const above = semilogBorrowAPR(1.5, 2, 200);
      expect(above).toBe(atOne);
    });

    it("returns minRate when minRate equals maxRate", () => {
      const result = semilogBorrowAPR(0.5, 10, 10);
      // 10 * (10/10)^0.5 = 10 * 1 = 10
      expect(result).toBe(10);
    });

    it("is monotonically increasing with utilization", () => {
      const points = [0, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0];
      const rates = points.map((u) => semilogBorrowAPR(u, 2, 200));
      for (let i = 1; i < rates.length; i++) {
        expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1]);
      }
    });

    it("handles very small rates", () => {
      const result = semilogBorrowAPR(0.5, 0.01, 0.1);
      // geometric mean of 0.01 and 0.1 = sqrt(0.01 * 0.1) ≈ 0.0316
      expect(result).toBeCloseTo(Math.sqrt(0.01 * 0.1), 5);
    });

    it("handles very large rates", () => {
      const result = semilogBorrowAPR(1, 1, 10000);
      expect(result).toBe(10000);
    });

    it("returns exactly 0 for all zero-guard paths", () => {
      expect(semilogBorrowAPR(0, 0, 0)).toBe(0);
      expect(semilogBorrowAPR(-1, 0, 0)).toBe(0);
      expect(semilogBorrowAPR(0, -1, -1)).toBe(0);
    });
  });

  describe("getColor", () => {
    it("returns red for health = 0", () => {
      expect(getColor(0)).toBe("#ef4444");
    });

    it("returns red for negative health", () => {
      expect(getColor(-10)).toBe("#ef4444");
    });

    it("returns red for health < 5", () => {
      expect(getColor(4.99)).toBe("#ef4444");
    });

    it("returns orange for health = 5", () => {
      expect(getColor(5)).toBe("#f97316");
    });

    it("returns orange for health < 10", () => {
      expect(getColor(9.99)).toBe("#f97316");
    });

    it("returns yellow for health = 10", () => {
      expect(getColor(10)).toBe("#eab308");
    });

    it("returns yellow for health < 20", () => {
      expect(getColor(19.99)).toBe("#eab308");
    });

    it("returns lime for health = 20", () => {
      expect(getColor(20)).toBe("#84cc16");
    });

    it("returns lime for health < 40", () => {
      expect(getColor(39.99)).toBe("#84cc16");
    });

    it("returns green for health = 40", () => {
      expect(getColor(40)).toBe("#22c55e");
    });

    it("returns green for health = 100", () => {
      expect(getColor(100)).toBe("#22c55e");
    });

    // Boundary tests
    it("transitions at each boundary", () => {
      expect(getColor(4.999)).toBe("#ef4444");
      expect(getColor(5)).toBe("#f97316");
      expect(getColor(9.999)).toBe("#f97316");
      expect(getColor(10)).toBe("#eab308");
      expect(getColor(19.999)).toBe("#eab308");
      expect(getColor(20)).toBe("#84cc16");
      expect(getColor(39.999)).toBe("#84cc16");
      expect(getColor(40)).toBe("#22c55e");
    });
  });
});
