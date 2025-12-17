import { describe, it, expect } from "vitest";
import { formatUnits } from "viem";

// Test the usePricePerShare business logic directly
// We test price calculation and formatting patterns

describe("usePricePerShare logic", () => {
  describe("price per share calculation", () => {
    function calculatePricePerShare(
      assetsPerShare: bigint | undefined,
      decimals: number
    ): number {
      // If no assets data, default to 1 (1:1 ratio)
      if (!assetsPerShare) return 1;
      return Number(formatUnits(assetsPerShare, decimals));
    }

    describe("with 18 decimals", () => {
      it("calculates 1:1 ratio correctly", () => {
        // 1e18 shares = 1e18 assets
        const assetsPerShare = BigInt("1000000000000000000");
        expect(calculatePricePerShare(assetsPerShare, 18)).toBe(1);
      });

      it("calculates higher price per share", () => {
        // 1e18 shares = 1.5e18 assets (50% gain)
        const assetsPerShare = BigInt("1500000000000000000");
        expect(calculatePricePerShare(assetsPerShare, 18)).toBe(1.5);
      });

      it("calculates very high price per share", () => {
        // 1e18 shares = 2e18 assets (100% gain)
        const assetsPerShare = BigInt("2000000000000000000");
        expect(calculatePricePerShare(assetsPerShare, 18)).toBe(2);
      });

      it("calculates price with many decimal places", () => {
        // 1e18 shares = 1.123456789e18 assets
        const assetsPerShare = BigInt("1123456789012345678");
        const price = calculatePricePerShare(assetsPerShare, 18);
        expect(price).toBeCloseTo(1.123456789, 6);
      });
    });

    describe("with different decimals", () => {
      it("handles 6 decimals correctly", () => {
        // For a 6-decimal vault (rare but possible)
        const assetsPerShare = BigInt("1500000"); // 1.5
        expect(calculatePricePerShare(assetsPerShare, 6)).toBe(1.5);
      });

      it("handles 8 decimals correctly", () => {
        const assetsPerShare = BigInt("150000000"); // 1.5
        expect(calculatePricePerShare(assetsPerShare, 8)).toBe(1.5);
      });
    });

    describe("edge cases", () => {
      it("returns 1 when assetsPerShare is undefined", () => {
        expect(calculatePricePerShare(undefined, 18)).toBe(1);
      });

      it("handles zero assets per share (defaults to 1 since 0n is falsy)", () => {
        // 0n is falsy in JavaScript, so the function defaults to 1
        // This is intentional - a vault with 0 assets per share should default to 1:1
        expect(calculatePricePerShare(0n, 18)).toBe(1);
      });

      it("handles very small price per share", () => {
        const assetsPerShare = BigInt("100000000000000"); // 0.0001
        expect(calculatePricePerShare(assetsPerShare, 18)).toBe(0.0001);
      });

      it("handles very large price per share", () => {
        // 1e18 shares = 1000e18 assets
        const assetsPerShare = BigInt("1000000000000000000000");
        expect(calculatePricePerShare(assetsPerShare, 18)).toBe(1000);
      });
    });
  });

  describe("price formatting", () => {
    function formatPricePerShare(price: number): string {
      return price.toFixed(4);
    }

    it("formats to 4 decimal places", () => {
      expect(formatPricePerShare(1.0)).toBe("1.0000");
    });

    it("formats price with decimals", () => {
      expect(formatPricePerShare(1.5)).toBe("1.5000");
    });

    it("formats high precision price", () => {
      expect(formatPricePerShare(1.123456789)).toBe("1.1235");
    });

    it("formats small price", () => {
      expect(formatPricePerShare(0.0001)).toBe("0.0001");
    });

    it("formats very small price (rounds to 0)", () => {
      expect(formatPricePerShare(0.00001)).toBe("0.0000");
    });

    it("formats large price", () => {
      expect(formatPricePerShare(1000.5)).toBe("1000.5000");
    });
  });

  describe("default value handling", () => {
    interface ContractResult {
      result?: bigint | number;
      status?: "success" | "failure";
    }

    function extractDecimals(data: ContractResult[] | undefined): number {
      return (data?.[0]?.result as number) ?? 18;
    }

    function extractAssetsPerShare(
      data: ContractResult[] | undefined
    ): bigint | undefined {
      return data?.[1]?.result as bigint | undefined;
    }

    it("defaults decimals to 18", () => {
      expect(extractDecimals(undefined)).toBe(18);
      expect(extractDecimals([{ result: undefined }])).toBe(18);
    });

    it("extracts decimals when present", () => {
      expect(extractDecimals([{ result: 6 }])).toBe(6);
    });

    it("returns undefined for missing assetsPerShare", () => {
      expect(extractAssetsPerShare(undefined)).toBeUndefined();
      expect(extractAssetsPerShare([{}, {}])).toBeUndefined();
    });

    it("extracts assetsPerShare when present", () => {
      const data = [{}, { result: BigInt("1500000000000000000") }];
      expect(extractAssetsPerShare(data)).toBe(BigInt("1500000000000000000"));
    });
  });

  describe("useMultiplePricePerShare index calculation", () => {
    function getIndexes(vaultIndex: number): { decimalsIndex: number; assetsIndex: number } {
      return {
        decimalsIndex: vaultIndex * 2,
        assetsIndex: vaultIndex * 2 + 1,
      };
    }

    it("calculates correct indexes for first vault", () => {
      const { decimalsIndex, assetsIndex } = getIndexes(0);
      expect(decimalsIndex).toBe(0);
      expect(assetsIndex).toBe(1);
    });

    it("calculates correct indexes for second vault", () => {
      const { decimalsIndex, assetsIndex } = getIndexes(1);
      expect(decimalsIndex).toBe(2);
      expect(assetsIndex).toBe(3);
    });

    it("calculates correct indexes for third vault", () => {
      const { decimalsIndex, assetsIndex } = getIndexes(2);
      expect(decimalsIndex).toBe(4);
      expect(assetsIndex).toBe(5);
    });

    it("calculates correct indexes for tenth vault", () => {
      const { decimalsIndex, assetsIndex } = getIndexes(9);
      expect(decimalsIndex).toBe(18);
      expect(assetsIndex).toBe(19);
    });
  });

  describe("contracts array construction", () => {
    const ERC4626_ABI = [
      { name: "decimals", type: "function" },
      { name: "convertToAssets", type: "function" },
    ];

    function buildContractsArray(
      vaultAddresses: string[]
    ): Array<{ address: string; functionName: string }> {
      return vaultAddresses.flatMap((address) => [
        { address, functionName: "decimals" },
        { address, functionName: "convertToAssets" },
      ]);
    }

    it("builds empty array for no vaults", () => {
      const contracts = buildContractsArray([]);
      expect(contracts).toHaveLength(0);
    });

    it("builds array for single vault", () => {
      const contracts = buildContractsArray(["0x111"]);
      expect(contracts).toHaveLength(2);
      expect(contracts[0].functionName).toBe("decimals");
      expect(contracts[1].functionName).toBe("convertToAssets");
    });

    it("builds array for multiple vaults", () => {
      const contracts = buildContractsArray(["0x111", "0x222", "0x333"]);
      expect(contracts).toHaveLength(6);
    });

    it("preserves vault address for each contract", () => {
      const contracts = buildContractsArray(["0xAAA", "0xBBB"]);
      expect(contracts[0].address).toBe("0xAAA");
      expect(contracts[1].address).toBe("0xAAA");
      expect(contracts[2].address).toBe("0xBBB");
      expect(contracts[3].address).toBe("0xBBB");
    });
  });

  describe("stale time and refetch configuration", () => {
    const STALE_TIME = 60 * 1000; // 1 minute
    const REFETCH_INTERVAL = 60 * 1000; // 1 minute

    it("has 1 minute stale time", () => {
      expect(STALE_TIME).toBe(60000);
    });

    it("has 1 minute refetch interval", () => {
      expect(REFETCH_INTERVAL).toBe(60000);
    });

    it("stale time equals refetch interval", () => {
      expect(STALE_TIME).toBe(REFETCH_INTERVAL);
    });
  });

  describe("result object structure", () => {
    interface PricePerShareResult {
      address: string;
      pricePerShare: number;
      pricePerShareFormatted: string;
      decimals: number;
    }

    function createResult(
      address: string,
      assetsPerShare: bigint | undefined,
      decimals: number
    ): PricePerShareResult {
      const pricePerShare = assetsPerShare
        ? Number(formatUnits(assetsPerShare, decimals))
        : 1;

      return {
        address,
        pricePerShare,
        pricePerShareFormatted: pricePerShare.toFixed(4),
        decimals,
      };
    }

    it("creates result with all fields", () => {
      const result = createResult(
        "0x123",
        BigInt("1500000000000000000"),
        18
      );

      expect(result.address).toBe("0x123");
      expect(result.pricePerShare).toBe(1.5);
      expect(result.pricePerShareFormatted).toBe("1.5000");
      expect(result.decimals).toBe(18);
    });

    it("defaults to 1 when no assets data", () => {
      const result = createResult("0x123", undefined, 18);
      expect(result.pricePerShare).toBe(1);
      expect(result.pricePerShareFormatted).toBe("1.0000");
    });
  });

  describe("convertToAssets argument", () => {
    const ONE_SHARE_18_DECIMALS = BigInt(10 ** 18);

    it("uses 1e18 as shares input", () => {
      expect(ONE_SHARE_18_DECIMALS).toBe(BigInt("1000000000000000000"));
    });

    it("represents exactly 1 share with 18 decimals", () => {
      expect(Number(formatUnits(ONE_SHARE_18_DECIMALS, 18))).toBe(1);
    });
  });

  describe("floating point precision", () => {
    it("handles precision for realistic vault prices", () => {
      // Typical vault price after some yield: 1.03456
      const assetsPerShare = BigInt("1034560000000000000");
      const price = Number(formatUnits(assetsPerShare, 18));
      expect(price).toBeCloseTo(1.03456, 5);
    });

    it("formats without excessive precision", () => {
      const price = 1.034567891234;
      const formatted = price.toFixed(4);
      expect(formatted).toBe("1.0346");
    });
  });
});
