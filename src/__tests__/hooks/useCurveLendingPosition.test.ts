import { describe, it, expect } from "vitest";
import {
  formatHealth,
  formatLiquidationPrice,
} from "@/hooks/useCurveLendingPosition";

describe("useCurveLendingPosition", () => {
  describe("formatHealth", () => {
    it("returns danger status for health = 0", () => {
      const result = formatHealth(0);
      expect(result.status).toBe("danger");
      expect(result.color).toBe("text-red-500");
      expect(result.value).toBe(0);
    });

    it("returns danger status for negative health", () => {
      const result = formatHealth(-5);
      expect(result.status).toBe("danger");
      expect(result.color).toBe("text-red-500");
      expect(result.value).toBe(-5);
    });

    it("returns danger status for health = 3.99", () => {
      const result = formatHealth(3.99);
      expect(result.status).toBe("danger");
      expect(result.color).toBe("text-red-500");
    });

    it("returns warning status for health = 4", () => {
      const result = formatHealth(4);
      expect(result.status).toBe("warning");
      expect(result.color).toBe("text-yellow-600");
      expect(result.value).toBe(4);
    });

    it("returns warning status for health = 14.99", () => {
      const result = formatHealth(14.99);
      expect(result.status).toBe("warning");
      expect(result.color).toBe("text-yellow-600");
    });

    it("returns healthy status for health = 15", () => {
      const result = formatHealth(15);
      expect(result.status).toBe("healthy");
      expect(result.color).toBe("text-green-600");
      expect(result.value).toBe(15);
    });

    it("returns healthy status for health = 40", () => {
      const result = formatHealth(40);
      expect(result.status).toBe("healthy");
      expect(result.color).toBe("text-green-600");
    });

    it("returns healthy status for health = 100", () => {
      const result = formatHealth(100);
      expect(result.status).toBe("healthy");
      expect(result.color).toBe("text-green-600");
      expect(result.value).toBe(100);
    });

    it("passes through exact value", () => {
      expect(formatHealth(7.5).value).toBe(7.5);
      expect(formatHealth(0).value).toBe(0);
      expect(formatHealth(99.99).value).toBe(99.99);
    });

    it("handles very large health values", () => {
      const result = formatHealth(500);
      expect(result.status).toBe("healthy");
      expect(result.color).toBe("text-green-600");
    });

    // Boundary: exactly at threshold transitions
    it("warning/danger boundary at 4", () => {
      expect(formatHealth(3.999).status).toBe("danger");
      expect(formatHealth(4).status).toBe("warning");
    });

    it("healthy/warning boundary at 15", () => {
      expect(formatHealth(14.999).status).toBe("warning");
      expect(formatHealth(15).status).toBe("healthy");
    });
  });

  describe("formatLiquidationPrice", () => {
    it("formats zero price", () => {
      const result = formatLiquidationPrice(0n);
      expect(result).toBe(
        (0).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 6,
        })
      );
    });

    it("formats 1 ETH (1e18) correctly", () => {
      const result = formatLiquidationPrice(1000000000000000000n);
      expect(result).toBe(
        (1).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 6,
        })
      );
    });

    it("formats fractional price", () => {
      const result = formatLiquidationPrice(500000000000000000n); // 0.5
      expect(result).toBe(
        (0.5).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 6,
        })
      );
    });

    it("formats large prices", () => {
      const price = 50000n * 10n ** 18n; // 50,000
      const result = formatLiquidationPrice(price);
      expect(result).toBe(
        (50000).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 6,
        })
      );
    });

    it("handles custom decimals (6)", () => {
      const result = formatLiquidationPrice(1000000n, 6); // 1.0
      expect(result).toBe(
        (1).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 6,
        })
      );
    });

    it("handles custom decimals (8)", () => {
      const result = formatLiquidationPrice(100000000n, 8); // 1.0
      expect(result).toBe(
        (1).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 6,
        })
      );
    });

    it("defaults to 18 decimals", () => {
      const a = formatLiquidationPrice(10n ** 18n);
      const b = formatLiquidationPrice(10n ** 18n, 18);
      expect(a).toBe(b);
    });
  });
});
