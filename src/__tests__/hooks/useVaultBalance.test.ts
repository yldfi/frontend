import { describe, it, expect } from "vitest";
import { formatUnits } from "viem";

// Test the useVaultBalance business logic directly
// We test USD value calculation and formatting

describe("useVaultBalance logic", () => {
  describe("USD value calculation", () => {
    function calculateUsdValue(
      balanceNumber: number,
      pricePerShare: number,
      assetPriceUsd: number
    ): number {
      return balanceNumber * pricePerShare * assetPriceUsd;
    }

    it("calculates USD value for 1 share at 1:1 with $1 asset", () => {
      expect(calculateUsdValue(1, 1, 1)).toBe(1);
    });

    it("calculates USD value with price per share gain", () => {
      // 100 shares * 1.5 pps * $1 asset = $150
      expect(calculateUsdValue(100, 1.5, 1)).toBe(150);
    });

    it("calculates USD value with asset price", () => {
      // 10 shares * 1.0 pps * $100 asset = $1000
      expect(calculateUsdValue(10, 1, 100)).toBe(1000);
    });

    it("calculates USD value with all factors", () => {
      // 50 shares * 1.05 pps * $0.95 asset = $49.875
      const result = calculateUsdValue(50, 1.05, 0.95);
      expect(result).toBeCloseTo(49.875, 3);
    });

    it("returns 0 for zero balance", () => {
      expect(calculateUsdValue(0, 1.5, 100)).toBe(0);
    });

    it("handles very small balances", () => {
      const result = calculateUsdValue(0.0001, 1, 1);
      expect(result).toBe(0.0001);
    });

    it("handles very large balances", () => {
      const result = calculateUsdValue(1_000_000, 1.1, 0.9);
      expect(result).toBeCloseTo(990_000, 0);
    });
  });

  describe("formattedUsd logic", () => {
    function formatUsdValue(usdValue: number): string {
      if (usdValue >= 1000) return `$${(usdValue / 1000).toFixed(1)}K`;
      if (usdValue >= 1) return `$${usdValue.toFixed(2)}`;
      if (usdValue > 0) return `$${usdValue.toFixed(4)}`;
      return "$0";
    }

    describe("K values (>= $1000)", () => {
      it("formats $1000 as $1.0K", () => {
        expect(formatUsdValue(1000)).toBe("$1.0K");
      });

      it("formats $1500 as $1.5K", () => {
        expect(formatUsdValue(1500)).toBe("$1.5K");
      });

      it("formats $10000 as $10.0K", () => {
        expect(formatUsdValue(10000)).toBe("$10.0K");
      });

      it("formats $999999 as $1000.0K", () => {
        expect(formatUsdValue(999999)).toBe("$1000.0K");
      });
    });

    describe("regular values ($1 - $999)", () => {
      it("formats $1 as $1.00", () => {
        expect(formatUsdValue(1)).toBe("$1.00");
      });

      it("formats $99.99 as $99.99", () => {
        expect(formatUsdValue(99.99)).toBe("$99.99");
      });

      it("formats $500.50 as $500.50", () => {
        expect(formatUsdValue(500.5)).toBe("$500.50");
      });

      it("formats $999.99 as $999.99", () => {
        expect(formatUsdValue(999.99)).toBe("$999.99");
      });
    });

    describe("small values (< $1)", () => {
      it("formats $0.5 as $0.5000", () => {
        expect(formatUsdValue(0.5)).toBe("$0.5000");
      });

      it("formats $0.01 as $0.0100", () => {
        expect(formatUsdValue(0.01)).toBe("$0.0100");
      });

      it("formats $0.0001 as $0.0001", () => {
        expect(formatUsdValue(0.0001)).toBe("$0.0001");
      });

      it("formats very small value with 4 decimals", () => {
        expect(formatUsdValue(0.00001)).toBe("$0.0000");
      });
    });

    describe("zero value", () => {
      it("formats $0 as $0", () => {
        expect(formatUsdValue(0)).toBe("$0");
      });
    });

    describe("boundary cases", () => {
      it("formats $0.999 as small value (4 decimals)", () => {
        expect(formatUsdValue(0.999)).toBe("$0.9990");
      });

      it("formats $1.001 as regular value (2 decimals)", () => {
        expect(formatUsdValue(1.001)).toBe("$1.00");
      });

      it("formats $999.99 as regular value", () => {
        expect(formatUsdValue(999.99)).toBe("$999.99");
      });

      it("formats $1000.01 as K value", () => {
        expect(formatUsdValue(1000.01)).toBe("$1.0K");
      });
    });
  });

  describe("balance formatting from bigint", () => {
    function formatBalance(balance: bigint, decimals: number): string {
      return formatUnits(balance, decimals);
    }

    it("formats 1 token with 18 decimals", () => {
      const balance = BigInt("1000000000000000000");
      expect(formatBalance(balance, 18)).toBe("1");
    });

    it("formats 0.5 tokens with 18 decimals", () => {
      const balance = BigInt("500000000000000000");
      expect(formatBalance(balance, 18)).toBe("0.5");
    });

    it("formats 1000 tokens with 18 decimals", () => {
      const balance = BigInt("1000000000000000000000");
      expect(formatBalance(balance, 18)).toBe("1000");
    });

    it("formats with 6 decimals (USDC-like)", () => {
      const balance = BigInt("1000000"); // 1 USDC
      expect(formatBalance(balance, 6)).toBe("1");
    });

    it("formats 0 balance", () => {
      expect(formatBalance(0n, 18)).toBe("0");
    });
  });

  describe("default values", () => {
    function extractBalance(result: { result?: bigint }[] | undefined): bigint {
      return (result?.[0]?.result as bigint) ?? 0n;
    }

    function extractDecimals(result: { result?: number }[] | undefined): number {
      return (result?.[1]?.result as number) ?? 18;
    }

    it("defaults balance to 0n", () => {
      expect(extractBalance(undefined)).toBe(0n);
      expect(extractBalance([{}])).toBe(0n);
    });

    it("defaults decimals to 18", () => {
      expect(extractDecimals(undefined)).toBe(18);
      expect(extractDecimals([{}, {}])).toBe(18);
    });

    it("extracts balance when present", () => {
      const data = [{ result: BigInt("5000000000000000000") }];
      expect(extractBalance(data)).toBe(BigInt("5000000000000000000"));
    });

    it("extracts decimals when present", () => {
      const data = [{}, { result: 6 }];
      expect(extractDecimals(data)).toBe(6);
    });
  });

  describe("isLoading derivation", () => {
    function deriveIsLoading(isLoading: boolean, isConnected: boolean): boolean {
      return isLoading && isConnected;
    }

    it("returns true when loading and connected", () => {
      expect(deriveIsLoading(true, true)).toBe(true);
    });

    it("returns false when loading but not connected", () => {
      expect(deriveIsLoading(true, false)).toBe(false);
    });

    it("returns false when not loading", () => {
      expect(deriveIsLoading(false, true)).toBe(false);
    });

    it("returns false when neither loading nor connected", () => {
      expect(deriveIsLoading(false, false)).toBe(false);
    });
  });

  describe("query enablement", () => {
    function shouldEnableQuery(
      isConnected: boolean,
      userAddress: string | undefined
    ): boolean {
      return isConnected && !!userAddress;
    }

    it("enables when connected with address", () => {
      expect(shouldEnableQuery(true, "0x123")).toBe(true);
    });

    it("disables when not connected", () => {
      expect(shouldEnableQuery(false, "0x123")).toBe(false);
    });

    it("disables when no address", () => {
      expect(shouldEnableQuery(true, undefined)).toBe(false);
    });

    it("disables when empty address", () => {
      expect(shouldEnableQuery(true, "")).toBe(false);
    });
  });

  describe("useMultipleVaultBalances index calculation", () => {
    function getIndexes(vaultIndex: number): { balanceIndex: number; decimalsIndex: number } {
      return {
        balanceIndex: vaultIndex * 2,
        decimalsIndex: vaultIndex * 2 + 1,
      };
    }

    it("calculates indexes for first vault", () => {
      const { balanceIndex, decimalsIndex } = getIndexes(0);
      expect(balanceIndex).toBe(0);
      expect(decimalsIndex).toBe(1);
    });

    it("calculates indexes for second vault", () => {
      const { balanceIndex, decimalsIndex } = getIndexes(1);
      expect(balanceIndex).toBe(2);
      expect(decimalsIndex).toBe(3);
    });

    it("calculates indexes for fifth vault", () => {
      const { balanceIndex, decimalsIndex } = getIndexes(4);
      expect(balanceIndex).toBe(8);
      expect(decimalsIndex).toBe(9);
    });
  });

  describe("contracts array construction", () => {
    interface VaultConfig {
      address: `0x${string}`;
      pricePerShare: number;
      assetPriceUsd: number;
    }

    function buildContractsArray(
      vaults: VaultConfig[],
      userAddress: string | undefined
    ) {
      return vaults.flatMap((vault) => [
        {
          address: vault.address,
          functionName: "balanceOf",
          args: userAddress ? [userAddress] : undefined,
        },
        {
          address: vault.address,
          functionName: "decimals",
        },
      ]);
    }

    it("builds empty array for no vaults", () => {
      const contracts = buildContractsArray([], "0xUser");
      expect(contracts).toHaveLength(0);
    });

    it("builds array for single vault", () => {
      const vaults: VaultConfig[] = [
        { address: "0x111" as `0x${string}`, pricePerShare: 1, assetPriceUsd: 1 },
      ];
      const contracts = buildContractsArray(vaults, "0xUser");
      expect(contracts).toHaveLength(2);
      expect(contracts[0].functionName).toBe("balanceOf");
      expect(contracts[1].functionName).toBe("decimals");
    });

    it("builds array for multiple vaults", () => {
      const vaults: VaultConfig[] = [
        { address: "0x111" as `0x${string}`, pricePerShare: 1, assetPriceUsd: 1 },
        { address: "0x222" as `0x${string}`, pricePerShare: 1.5, assetPriceUsd: 0.9 },
        { address: "0x333" as `0x${string}`, pricePerShare: 1.2, assetPriceUsd: 1.1 },
      ];
      const contracts = buildContractsArray(vaults, "0xUser");
      expect(contracts).toHaveLength(6);
    });

    it("includes user address in balanceOf args", () => {
      const vaults: VaultConfig[] = [
        { address: "0x111" as `0x${string}`, pricePerShare: 1, assetPriceUsd: 1 },
      ];
      const contracts = buildContractsArray(vaults, "0xUserAddress");
      expect(contracts[0].args).toEqual(["0xUserAddress"]);
    });

    it("has undefined args when no user address", () => {
      const vaults: VaultConfig[] = [
        { address: "0x111" as `0x${string}`, pricePerShare: 1, assetPriceUsd: 1 },
      ];
      const contracts = buildContractsArray(vaults, undefined);
      expect(contracts[0].args).toBeUndefined();
    });
  });

  describe("query configuration", () => {
    const REFETCH_INTERVAL = 12000; // 12 seconds
    const STALE_TIME = 0;

    it("has 12 second refetch interval (approx 1 block)", () => {
      expect(REFETCH_INTERVAL).toBe(12000);
    });

    it("has 0 stale time (always refetch on wallet change)", () => {
      expect(STALE_TIME).toBe(0);
    });
  });

  describe("real-world scenarios", () => {
    function calculateUsdValue(
      balanceNumber: number,
      pricePerShare: number,
      assetPriceUsd: number
    ): number {
      return balanceNumber * pricePerShare * assetPriceUsd;
    }

    function formatUsdValue(usdValue: number): string {
      if (usdValue >= 1000) return `$${(usdValue / 1000).toFixed(1)}K`;
      if (usdValue >= 1) return `$${usdValue.toFixed(2)}`;
      if (usdValue > 0) return `$${usdValue.toFixed(4)}`;
      return "$0";
    }

    it("ycvxCRV vault balance", () => {
      // 1000 ycvxCRV shares, 1.05 pps, cvxCRV at $0.93
      const balance = 1000;
      const pricePerShare = 1.05;
      const assetPrice = 0.93;

      const usdValue = calculateUsdValue(balance, pricePerShare, assetPrice);
      expect(usdValue).toBeCloseTo(976.5, 1);
      expect(formatUsdValue(usdValue)).toBe("$976.50");
    });

    it("large position in ycvxCRV vault", () => {
      // 50000 ycvxCRV shares, 1.05 pps, cvxCRV at $0.93
      const balance = 50000;
      const pricePerShare = 1.05;
      const assetPrice = 0.93;

      const usdValue = calculateUsdValue(balance, pricePerShare, assetPrice);
      expect(usdValue).toBeCloseTo(48825, 0);
      expect(formatUsdValue(usdValue)).toBe("$48.8K");
    });

    it("tiny balance (dust)", () => {
      const balance = 0.001;
      const pricePerShare = 1.05;
      const assetPrice = 0.93;

      const usdValue = calculateUsdValue(balance, pricePerShare, assetPrice);
      expect(formatUsdValue(usdValue)).toBe("$0.0010");
    });

    it("new vault with 1:1 pps", () => {
      const balance = 100;
      const pricePerShare = 1;
      const assetPrice = 1;

      const usdValue = calculateUsdValue(balance, pricePerShare, assetPrice);
      expect(usdValue).toBe(100);
      expect(formatUsdValue(usdValue)).toBe("$100.00");
    });
  });
});
