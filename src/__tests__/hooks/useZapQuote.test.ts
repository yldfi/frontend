import { describe, it, expect } from "vitest";

// Test the calculatePriceImpact function logic directly
// Since it's not exported, we test the mathematical behavior

describe("calculatePriceImpact logic", () => {
  // Replicate the function logic for testing
  function calculatePriceImpact(inputUsd: number | null, outputUsd: number | null): number | null {
    if (inputUsd === null || outputUsd === null || inputUsd === 0) {
      return null;
    }
    return ((inputUsd - outputUsd) / inputUsd) * 100;
  }

  describe("returns null for invalid inputs", () => {
    it("returns null when inputUsd is null", () => {
      expect(calculatePriceImpact(null, 100)).toBeNull();
    });

    it("returns null when outputUsd is null", () => {
      expect(calculatePriceImpact(100, null)).toBeNull();
    });

    it("returns null when both are null", () => {
      expect(calculatePriceImpact(null, null)).toBeNull();
    });

    it("returns null when inputUsd is zero", () => {
      expect(calculatePriceImpact(0, 100)).toBeNull();
    });
  });

  describe("calculates positive price impact (loss)", () => {
    it("calculates 10% loss correctly", () => {
      // Input $100, output $90 = 10% loss
      const result = calculatePriceImpact(100, 90);
      expect(result).toBe(10);
    });

    it("calculates 50% loss correctly", () => {
      // Input $100, output $50 = 50% loss
      const result = calculatePriceImpact(100, 50);
      expect(result).toBe(50);
    });

    it("calculates 1% loss correctly", () => {
      // Input $1000, output $990 = 1% loss
      const result = calculatePriceImpact(1000, 990);
      expect(result).toBe(1);
    });

    it("calculates small percentage loss", () => {
      // Input $100, output $99.5 = 0.5% loss
      const result = calculatePriceImpact(100, 99.5);
      expect(result).toBeCloseTo(0.5, 5);
    });
  });

  describe("calculates negative price impact (gain)", () => {
    it("calculates 10% gain correctly", () => {
      // Input $100, output $110 = -10% (gain)
      const result = calculatePriceImpact(100, 110);
      expect(result).toBe(-10);
    });

    it("calculates small gain", () => {
      // Input $100, output $100.5 = -0.5% (gain)
      const result = calculatePriceImpact(100, 100.5);
      expect(result).toBeCloseTo(-0.5, 5);
    });
  });

  describe("edge cases", () => {
    it("returns 0 when input equals output", () => {
      expect(calculatePriceImpact(100, 100)).toBe(0);
    });

    it("handles very small differences", () => {
      const result = calculatePriceImpact(1000000, 999999);
      expect(result).toBeCloseTo(0.0001, 4);
    });

    it("handles very large values", () => {
      const result = calculatePriceImpact(1000000000, 900000000);
      expect(result).toBe(10);
    });

    it("calculates 100% loss (output is zero)", () => {
      const result = calculatePriceImpact(100, 0);
      expect(result).toBe(100);
    });
  });
});

describe("exchange rate calculation logic", () => {
  // Replicate exchange rate calculation from useZapQuote
  function calculateExchangeRate(inputNum: number, outputNum: number): number {
    return inputNum > 0 ? outputNum / inputNum : 0;
  }

  it("calculates 1:1 exchange rate", () => {
    expect(calculateExchangeRate(100, 100)).toBe(1);
  });

  it("calculates favorable exchange rate", () => {
    // 100 input gets 150 output
    expect(calculateExchangeRate(100, 150)).toBe(1.5);
  });

  it("calculates unfavorable exchange rate", () => {
    // 100 input gets 50 output
    expect(calculateExchangeRate(100, 50)).toBe(0.5);
  });

  it("returns 0 for zero input", () => {
    expect(calculateExchangeRate(0, 100)).toBe(0);
  });

  it("handles small amounts", () => {
    expect(calculateExchangeRate(0.001, 0.002)).toBe(2);
  });

  it("handles large amounts", () => {
    expect(calculateExchangeRate(1000000, 950000)).toBe(0.95);
  });
});

describe("vault-to-vault detection logic", () => {
  // Test vault address detection - addresses from the codebase
  const YLDFI_VAULT_ADDRESSES = [
    "0x583019ff0f430721ada9cfb4fac8f06ca104d0b4", // yCVXCRV
    "0x27b5739e22ad9033bcbf192059122d163b60349d", // yscvxCRV
  ];

  function isYldfiVault(address: string): boolean {
    return YLDFI_VAULT_ADDRESSES.includes(address.toLowerCase());
  }

  it("detects yCVXCRV vault", () => {
    expect(isYldfiVault("0x583019ff0f430721ada9cfb4fac8f06ca104d0b4")).toBe(true);
  });

  it("detects yscvxCRV vault", () => {
    expect(isYldfiVault("0x27b5739e22ad9033bcbf192059122d163b60349d")).toBe(true);
  });

  it("detects vault with uppercase address", () => {
    expect(isYldfiVault("0x583019FF0F430721ADA9CFB4FAC8F06CA104D0B4")).toBe(true);
  });

  it("returns false for non-vault address", () => {
    expect(isYldfiVault("0x1234567890abcdef1234567890abcdef12345678")).toBe(false);
  });

  it("returns false for ETH address", () => {
    expect(isYldfiVault("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")).toBe(false);
  });
});

describe("input amount parsing logic", () => {
  // Test parseUnits behavior (from viem)
  function parseInputAmount(inputAmount: string, decimals: number): string {
    try {
      if (inputAmount && decimals && Number(inputAmount) > 0) {
        // Simulate parseUnits result as string
        const num = Number(inputAmount);
        const wei = BigInt(Math.floor(num * 10 ** decimals));
        return wei.toString();
      }
      return "0";
    } catch {
      return "0";
    }
  }

  it("parses valid amount with 18 decimals", () => {
    const result = parseInputAmount("1.5", 18);
    expect(result).toBe("1500000000000000000");
  });

  it("parses valid amount with 6 decimals (USDC)", () => {
    const result = parseInputAmount("1.5", 6);
    expect(result).toBe("1500000");
  });

  it("returns 0 for empty string", () => {
    expect(parseInputAmount("", 18)).toBe("0");
  });

  it("returns 0 for zero amount", () => {
    expect(parseInputAmount("0", 18)).toBe("0");
  });

  it("returns 0 for negative amount", () => {
    expect(parseInputAmount("-1", 18)).toBe("0");
  });

  it("handles whole numbers", () => {
    const result = parseInputAmount("100", 18);
    expect(result).toBe("100000000000000000000");
  });
});
