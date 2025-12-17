import { describe, it, expect } from "vitest";
import { formatNumber, formatPercent, shortenAddress, formatTokenAmount } from "@/lib/utils";

describe("formatNumber", () => {
  describe("basic formatting", () => {
    it("formats numbers with default 2 decimals", () => {
      expect(formatNumber(1234.5678)).toBe("1,234.57");
    });

    it("formats string inputs", () => {
      expect(formatNumber("1234.5678")).toBe("1,234.57");
    });

    it("returns — for NaN", () => {
      expect(formatNumber(NaN)).toBe("—");
      expect(formatNumber("not a number")).toBe("—");
    });

    it("formats zero correctly", () => {
      expect(formatNumber(0)).toBe("0.00");
    });

    it("handles negative numbers", () => {
      expect(formatNumber(-1234.56)).toBe("-1,234.56");
    });
  });

  describe("decimal precision", () => {
    it("respects custom decimals", () => {
      expect(formatNumber(1234.5678, { decimals: 4 })).toBe("1,234.5678");
      expect(formatNumber(1234.5678, { decimals: 0 })).toBe("1,235");
    });
  });

  describe("compact notation", () => {
    it("formats thousands as K", () => {
      expect(formatNumber(1500, { compact: true })).toBe("1.50K");
      expect(formatNumber(999, { compact: true })).toBe("999.00");
    });

    it("formats millions as M", () => {
      expect(formatNumber(1500000, { compact: true })).toBe("1.50M");
      expect(formatNumber(999999, { compact: true })).toBe("1000.00K");
    });

    it("formats billions as B", () => {
      expect(formatNumber(1500000000, { compact: true })).toBe("1.50B");
    });

    it("handles negative compact numbers", () => {
      expect(formatNumber(-1500000, { compact: true })).toBe("-1.50M");
    });
  });

  describe("prefix and suffix", () => {
    it("adds prefix", () => {
      expect(formatNumber(1234, { prefix: "$" })).toBe("$1,234.00");
    });

    it("adds suffix", () => {
      expect(formatNumber(1234, { suffix: " USD" })).toBe("1,234.00 USD");
    });

    it("adds both prefix and suffix", () => {
      expect(formatNumber(1234, { prefix: "$", suffix: " USD" })).toBe("$1,234.00 USD");
    });

    it("works with compact notation", () => {
      expect(formatNumber(1500000, { compact: true, prefix: "$" })).toBe("$1.50M");
    });
  });

  describe("edge cases", () => {
    it("handles very small numbers", () => {
      expect(formatNumber(0.000001)).toBe("0.00");
      expect(formatNumber(0.000001, { decimals: 6 })).toBe("0.000001");
    });

    it("handles very large numbers without compact", () => {
      expect(formatNumber(123456789012)).toBe("123,456,789,012.00");
    });

    it("handles empty options", () => {
      expect(formatNumber(1234.56, {})).toBe("1,234.56");
    });
  });
});

describe("formatPercent", () => {
  it("formats percentages with default 2 decimals", () => {
    expect(formatPercent(12.3456)).toBe("12.35%");
  });

  it("formats string inputs", () => {
    expect(formatPercent("12.3456")).toBe("12.35%");
  });

  it("returns — for NaN", () => {
    expect(formatPercent(NaN)).toBe("—");
    expect(formatPercent("invalid")).toBe("—");
  });

  it("respects custom decimals", () => {
    expect(formatPercent(12.3456, 4)).toBe("12.3456%");
    expect(formatPercent(12.3456, 0)).toBe("12%");
  });

  it("handles negative percentages", () => {
    expect(formatPercent(-5.5)).toBe("-5.50%");
  });

  it("handles zero", () => {
    expect(formatPercent(0)).toBe("0.00%");
  });
});

describe("shortenAddress", () => {
  const testAddress = "0x1234567890abcdef1234567890abcdef12345678";

  it("shortens address with default 4 chars", () => {
    expect(shortenAddress(testAddress)).toBe("0x1234...5678");
  });

  it("respects custom character count", () => {
    expect(shortenAddress(testAddress, 6)).toBe("0x123456...345678");
    expect(shortenAddress(testAddress, 2)).toBe("0x12...78");
  });

  it("returns empty string for empty input", () => {
    expect(shortenAddress("")).toBe("");
  });

  it("handles undefined/null gracefully", () => {
    expect(shortenAddress(undefined as unknown as string)).toBe("");
    expect(shortenAddress(null as unknown as string)).toBe("");
  });
});

describe("formatTokenAmount", () => {
  it("formats token amounts with correct decimals", () => {
    // 1.5 tokens with 18 decimals
    const amount = BigInt("1500000000000000000");
    expect(formatTokenAmount(amount, 18, 4)).toBe("1.5000");
  });

  it("handles large amounts", () => {
    // 1,234,567.89 tokens with 18 decimals
    const amount = BigInt("1234567890000000000000000");
    expect(formatTokenAmount(amount, 18, 2)).toBe("1,234,567.89");
  });

  it("handles amounts with no fractional part", () => {
    // Exactly 100 tokens with 18 decimals
    const amount = BigInt("100000000000000000000");
    expect(formatTokenAmount(amount, 18, 4)).toBe("100.0000");
  });

  it("handles small decimals (6 for USDC)", () => {
    // 1.5 USDC (6 decimals)
    const amount = BigInt("1500000");
    expect(formatTokenAmount(amount, 6, 2)).toBe("1.50");
  });

  it("handles zero amount", () => {
    expect(formatTokenAmount(BigInt(0), 18, 4)).toBe("0.0000");
  });

  it("handles very small fractions", () => {
    // 0.0001 tokens with 18 decimals
    const amount = BigInt("100000000000000");
    expect(formatTokenAmount(amount, 18, 4)).toBe("0.0001");
  });
});
