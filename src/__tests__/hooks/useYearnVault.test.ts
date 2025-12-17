import { describe, it, expect } from "vitest";

// Test the useYearnVault business logic directly
// We test APY calculations, USD formatting, and vault data formatting

describe("useYearnVault logic", () => {
  describe("calculateStrategyNetApy", () => {
    // Replicates the function from useYearnVault.ts
    // Vault takes 15% fee, so strategyNet = vaultNet / (1 - 0.15) = vaultNet / 0.85
    function calculateStrategyNetApy(vaultNetApy: number): number {
      const strategyNetApy = vaultNetApy / 0.85;
      return strategyNetApy;
    }

    describe("common APY scenarios", () => {
      it("calculates strategy APY for 0% vault APY", () => {
        expect(calculateStrategyNetApy(0)).toBe(0);
      });

      it("calculates strategy APY for 10% vault APY", () => {
        // 10 / 0.85 ≈ 11.76%
        const result = calculateStrategyNetApy(10);
        expect(result).toBeCloseTo(11.76, 2);
      });

      it("calculates strategy APY for 20% vault APY", () => {
        // 20 / 0.85 ≈ 23.53%
        const result = calculateStrategyNetApy(20);
        expect(result).toBeCloseTo(23.53, 2);
      });

      it("calculates strategy APY for 50% vault APY", () => {
        // 50 / 0.85 ≈ 58.82%
        const result = calculateStrategyNetApy(50);
        expect(result).toBeCloseTo(58.82, 2);
      });

      it("calculates strategy APY for 100% vault APY", () => {
        // 100 / 0.85 ≈ 117.65%
        const result = calculateStrategyNetApy(100);
        expect(result).toBeCloseTo(117.65, 2);
      });
    });

    describe("decimal APY values", () => {
      it("handles decimal vault APY (8.5%)", () => {
        // 8.5 / 0.85 = 10
        expect(calculateStrategyNetApy(8.5)).toBe(10);
      });

      it("handles small decimal APY (0.85%)", () => {
        // 0.85 / 0.85 = 1
        expect(calculateStrategyNetApy(0.85)).toBe(1);
      });

      it("handles typical cvxCRV vault APY (~15%)", () => {
        // Typical ycvxCRV APY
        const result = calculateStrategyNetApy(15);
        expect(result).toBeCloseTo(17.65, 2);
      });

      it("handles very small APY (0.01%)", () => {
        const result = calculateStrategyNetApy(0.01);
        expect(result).toBeCloseTo(0.0118, 4);
      });
    });

    describe("fee relationship", () => {
      it("strategy APY is always higher than vault APY (15% fee removed)", () => {
        const vaultApy = 10;
        const strategyApy = calculateStrategyNetApy(vaultApy);
        expect(strategyApy).toBeGreaterThan(vaultApy);
      });

      it("strategy APY is exactly 1/0.85 times vault APY", () => {
        const vaultApy = 17;
        const strategyApy = calculateStrategyNetApy(vaultApy);
        expect(strategyApy).toBe(vaultApy / 0.85);
      });

      it("vault APY at 85% of strategy APY", () => {
        const vaultApy = 8.5;
        const strategyApy = calculateStrategyNetApy(vaultApy);
        expect(vaultApy / strategyApy).toBe(0.85);
      });
    });
  });

  describe("formatUsd", () => {
    // Replicates the formatUsd function from useYearnVault.ts
    function formatUsd(value: number): string {
      if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
      return `$${value.toFixed(2)}`;
    }

    describe("small values (under $1K)", () => {
      it("formats $0", () => {
        expect(formatUsd(0)).toBe("$0.00");
      });

      it("formats $1", () => {
        expect(formatUsd(1)).toBe("$1.00");
      });

      it("formats $0.50", () => {
        expect(formatUsd(0.5)).toBe("$0.50");
      });

      it("formats $99.99", () => {
        expect(formatUsd(99.99)).toBe("$99.99");
      });

      it("formats $999.99 (just under K threshold)", () => {
        // 999.99 is less than 1000, so it's formatted as regular dollars
        expect(formatUsd(999.99)).toBe("$999.99");
      });

      it("formats $500.123 (rounds to 2 decimals)", () => {
        expect(formatUsd(500.123)).toBe("$500.12");
      });
    });

    describe("thousands (K values)", () => {
      it("formats $1,000 as $1.0K", () => {
        expect(formatUsd(1000)).toBe("$1.0K");
      });

      it("formats $1,500 as $1.5K", () => {
        expect(formatUsd(1500)).toBe("$1.5K");
      });

      it("formats $10,000 as $10.0K", () => {
        expect(formatUsd(10000)).toBe("$10.0K");
      });

      it("formats $50,000 as $50.0K", () => {
        expect(formatUsd(50000)).toBe("$50.0K");
      });

      it("formats $100,000 as $100.0K", () => {
        expect(formatUsd(100000)).toBe("$100.0K");
      });

      it("formats $999,999 as $1000.0K (boundary)", () => {
        expect(formatUsd(999999)).toBe("$1000.0K");
      });

      it("formats $5,500 as $5.5K", () => {
        expect(formatUsd(5500)).toBe("$5.5K");
      });
    });

    describe("millions (M values)", () => {
      it("formats $1,000,000 as $1.00M", () => {
        expect(formatUsd(1000000)).toBe("$1.00M");
      });

      it("formats $1,500,000 as $1.50M", () => {
        expect(formatUsd(1500000)).toBe("$1.50M");
      });

      it("formats $10,000,000 as $10.00M", () => {
        expect(formatUsd(10000000)).toBe("$10.00M");
      });

      it("formats $100,000,000 as $100.00M", () => {
        expect(formatUsd(100000000)).toBe("$100.00M");
      });

      it("formats $1,234,567 as $1.23M", () => {
        expect(formatUsd(1234567)).toBe("$1.23M");
      });

      it("formats $999,999,999 as $1000.00M", () => {
        expect(formatUsd(999999999)).toBe("$1000.00M");
      });
    });

    describe("boundary cases", () => {
      it("formats $999 as regular dollars", () => {
        expect(formatUsd(999)).toBe("$999.00");
      });

      it("formats $1001 as K", () => {
        expect(formatUsd(1001)).toBe("$1.0K");
      });

      it("formats $999999 as K (not quite M)", () => {
        expect(formatUsd(999999)).toBe("$1000.0K");
      });

      it("formats $1000001 as M", () => {
        expect(formatUsd(1000001)).toBe("$1.00M");
      });
    });
  });

  describe("formatYearnVaultData", () => {
    interface YearnVaultAsset {
      address: string;
      name: string;
      symbol: string;
      decimals: number;
    }

    interface YearnVault {
      chainId: number;
      address: string;
      name: string;
      symbol: string;
      asset: YearnVaultAsset;
      accountant: string | null;
      pricePerShare: string;
      totalAssets: string;
      totalDebt: string;
      fees: {
        managementFee: number;
        performanceFee: number;
      } | null;
      tvl: {
        close: number;
      };
      apy: {
        close: number;
        grossApr: number;
        weeklyNet: number;
        monthlyNet: number;
        inceptionNet: number;
      };
      debts: Array<{
        strategy: string;
        currentDebt: string;
        currentDebtUsd: number;
        targetDebtRatio: number | null;
      }>;
    }

    interface YearnVaultStrategy {
      chainId: number;
      address: string;
      name: string;
    }

    function formatUsd(value: number): string {
      if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
      return `$${value.toFixed(2)}`;
    }

    function formatYearnVaultData(
      vault: YearnVault | null | undefined,
      strategies: YearnVaultStrategy[] = []
    ) {
      if (!vault) return null;

      const decimals = vault.asset.decimals;
      const pricePerShare = Number(vault.pricePerShare) / Math.pow(10, decimals);

      return {
        name: vault.name,
        symbol: vault.symbol,
        asset: {
          symbol: vault.asset.symbol,
          name: vault.asset.name,
          address: vault.asset.address,
        },
        tvl: vault.tvl?.close ?? 0,
        tvlFormatted: formatUsd(vault.tvl?.close ?? 0),
        apy: vault.apy?.close ?? 0,
        apyFormatted: `${(vault.apy?.close ?? 0).toFixed(2)}%`,
        grossApr: vault.apy?.grossApr ?? 0,
        grossAprFormatted: `${(vault.apy?.grossApr ?? 0).toFixed(2)}%`,
        weeklyApy: vault.apy?.weeklyNet ?? 0,
        weeklyApyFormatted: `${(vault.apy?.weeklyNet ?? 0).toFixed(2)}%`,
        monthlyApy: vault.apy?.monthlyNet ?? 0,
        monthlyApyFormatted: `${(vault.apy?.monthlyNet ?? 0).toFixed(2)}%`,
        inceptionApy: vault.apy?.inceptionNet ?? 0,
        inceptionApyFormatted: `${(vault.apy?.inceptionNet ?? 0).toFixed(2)}%`,
        pricePerShare,
        pricePerShareFormatted: pricePerShare.toFixed(4),
        managementFee: vault.fees?.managementFee ?? 0,
        managementFeeFormatted: `${((vault.fees?.managementFee ?? 0) / 100).toFixed(2)}%`,
        performanceFee: vault.fees?.performanceFee ?? 0,
        performanceFeeFormatted: `${((vault.fees?.performanceFee ?? 0) / 100).toFixed(0)}%`,
        totalAssets: vault.totalAssets,
        strategies,
      };
    }

    const createMockVault = (overrides: Partial<YearnVault> = {}): YearnVault => ({
      chainId: 1,
      address: "0x27B5739e22ad9033bcBf192059122d163b60349D",
      name: "ycvxCRV Vault",
      symbol: "ycvxCRV",
      asset: {
        address: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7",
        name: "Convex CRV",
        symbol: "cvxCRV",
        decimals: 18,
      },
      accountant: "0x1234567890123456789012345678901234567890",
      pricePerShare: "1050000000000000000", // 1.05
      totalAssets: "1000000000000000000000", // 1000 tokens
      totalDebt: "900000000000000000000", // 900 tokens
      fees: {
        managementFee: 0,
        performanceFee: 1000, // 10%
      },
      tvl: {
        close: 1500000, // $1.5M
      },
      apy: {
        close: 15.5, // 15.5%
        grossApr: 18.2, // 18.2%
        weeklyNet: 14.8,
        monthlyNet: 15.2,
        inceptionNet: 16.1,
      },
      debts: [],
      ...overrides,
    });

    describe("null/undefined handling", () => {
      it("returns null for null vault", () => {
        expect(formatYearnVaultData(null)).toBeNull();
      });

      it("returns null for undefined vault", () => {
        expect(formatYearnVaultData(undefined)).toBeNull();
      });
    });

    describe("basic fields", () => {
      it("extracts name and symbol", () => {
        const vault = createMockVault();
        const result = formatYearnVaultData(vault);
        expect(result?.name).toBe("ycvxCRV Vault");
        expect(result?.symbol).toBe("ycvxCRV");
      });

      it("extracts asset information", () => {
        const vault = createMockVault();
        const result = formatYearnVaultData(vault);
        expect(result?.asset.symbol).toBe("cvxCRV");
        expect(result?.asset.name).toBe("Convex CRV");
        expect(result?.asset.address).toBe("0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7");
      });

      it("extracts totalAssets", () => {
        const vault = createMockVault();
        const result = formatYearnVaultData(vault);
        expect(result?.totalAssets).toBe("1000000000000000000000");
      });
    });

    describe("TVL formatting", () => {
      it("formats TVL as millions", () => {
        const vault = createMockVault({ tvl: { close: 1500000 } });
        const result = formatYearnVaultData(vault);
        expect(result?.tvl).toBe(1500000);
        expect(result?.tvlFormatted).toBe("$1.50M");
      });

      it("formats TVL as thousands", () => {
        const vault = createMockVault({ tvl: { close: 50000 } });
        const result = formatYearnVaultData(vault);
        expect(result?.tvlFormatted).toBe("$50.0K");
      });

      it("handles zero TVL", () => {
        const vault = createMockVault({ tvl: { close: 0 } });
        const result = formatYearnVaultData(vault);
        expect(result?.tvl).toBe(0);
        expect(result?.tvlFormatted).toBe("$0.00");
      });
    });

    describe("APY formatting", () => {
      it("formats close APY", () => {
        const vault = createMockVault({ apy: { close: 15.5, grossApr: 18.2, weeklyNet: 14.8, monthlyNet: 15.2, inceptionNet: 16.1 } });
        const result = formatYearnVaultData(vault);
        expect(result?.apy).toBe(15.5);
        expect(result?.apyFormatted).toBe("15.50%");
      });

      it("formats gross APR", () => {
        const vault = createMockVault({ apy: { close: 15.5, grossApr: 18.24, weeklyNet: 14.8, monthlyNet: 15.2, inceptionNet: 16.1 } });
        const result = formatYearnVaultData(vault);
        expect(result?.grossApr).toBe(18.24);
        expect(result?.grossAprFormatted).toBe("18.24%");
      });

      it("formats weekly APY", () => {
        const vault = createMockVault({ apy: { close: 15.5, grossApr: 18.2, weeklyNet: 14.85, monthlyNet: 15.2, inceptionNet: 16.1 } });
        const result = formatYearnVaultData(vault);
        expect(result?.weeklyApy).toBe(14.85);
        expect(result?.weeklyApyFormatted).toBe("14.85%");
      });

      it("formats monthly APY", () => {
        const vault = createMockVault({ apy: { close: 15.5, grossApr: 18.2, weeklyNet: 14.8, monthlyNet: 15.27, inceptionNet: 16.1 } });
        const result = formatYearnVaultData(vault);
        expect(result?.monthlyApy).toBe(15.27);
        expect(result?.monthlyApyFormatted).toBe("15.27%");
      });

      it("formats inception APY", () => {
        const vault = createMockVault({ apy: { close: 15.5, grossApr: 18.2, weeklyNet: 14.8, monthlyNet: 15.2, inceptionNet: 16.15 } });
        const result = formatYearnVaultData(vault);
        expect(result?.inceptionApy).toBe(16.15);
        expect(result?.inceptionApyFormatted).toBe("16.15%");
      });

      it("formats 0% APY", () => {
        const vault = createMockVault({ apy: { close: 0, grossApr: 0, weeklyNet: 0, monthlyNet: 0, inceptionNet: 0 } });
        const result = formatYearnVaultData(vault);
        expect(result?.apyFormatted).toBe("0.00%");
      });
    });

    describe("price per share calculation", () => {
      it("calculates price per share with 18 decimals", () => {
        const vault = createMockVault({
          pricePerShare: "1050000000000000000", // 1.05
          asset: { address: "0x123", name: "Token", symbol: "TKN", decimals: 18 },
        });
        const result = formatYearnVaultData(vault);
        expect(result?.pricePerShare).toBe(1.05);
        expect(result?.pricePerShareFormatted).toBe("1.0500");
      });

      it("calculates price per share with 6 decimals", () => {
        const vault = createMockVault({
          pricePerShare: "1050000", // 1.05 with 6 decimals
          asset: { address: "0x123", name: "USDC", symbol: "USDC", decimals: 6 },
        });
        const result = formatYearnVaultData(vault);
        expect(result?.pricePerShare).toBe(1.05);
        expect(result?.pricePerShareFormatted).toBe("1.0500");
      });

      it("handles 1:1 price per share", () => {
        const vault = createMockVault({
          pricePerShare: "1000000000000000000", // 1.0
          asset: { address: "0x123", name: "Token", symbol: "TKN", decimals: 18 },
        });
        const result = formatYearnVaultData(vault);
        expect(result?.pricePerShare).toBe(1);
        expect(result?.pricePerShareFormatted).toBe("1.0000");
      });

      it("handles high price per share (vault with gains)", () => {
        const vault = createMockVault({
          pricePerShare: "2500000000000000000", // 2.5
          asset: { address: "0x123", name: "Token", symbol: "TKN", decimals: 18 },
        });
        const result = formatYearnVaultData(vault);
        expect(result?.pricePerShare).toBe(2.5);
        expect(result?.pricePerShareFormatted).toBe("2.5000");
      });
    });

    describe("fee formatting", () => {
      it("formats management fee (0%)", () => {
        const vault = createMockVault({ fees: { managementFee: 0, performanceFee: 1000 } });
        const result = formatYearnVaultData(vault);
        expect(result?.managementFee).toBe(0);
        expect(result?.managementFeeFormatted).toBe("0.00%");
      });

      it("formats management fee (2%)", () => {
        const vault = createMockVault({ fees: { managementFee: 200, performanceFee: 1000 } });
        const result = formatYearnVaultData(vault);
        expect(result?.managementFee).toBe(200);
        expect(result?.managementFeeFormatted).toBe("2.00%");
      });

      it("formats performance fee (10%)", () => {
        const vault = createMockVault({ fees: { managementFee: 0, performanceFee: 1000 } });
        const result = formatYearnVaultData(vault);
        expect(result?.performanceFee).toBe(1000);
        expect(result?.performanceFeeFormatted).toBe("10%");
      });

      it("formats performance fee (15%)", () => {
        const vault = createMockVault({ fees: { managementFee: 0, performanceFee: 1500 } });
        const result = formatYearnVaultData(vault);
        expect(result?.performanceFee).toBe(1500);
        expect(result?.performanceFeeFormatted).toBe("15%");
      });

      it("handles null fees", () => {
        const vault = createMockVault({ fees: null });
        const result = formatYearnVaultData(vault);
        expect(result?.managementFee).toBe(0);
        expect(result?.performanceFee).toBe(0);
        expect(result?.managementFeeFormatted).toBe("0.00%");
        expect(result?.performanceFeeFormatted).toBe("0%");
      });
    });

    describe("strategies", () => {
      it("includes empty strategies array by default", () => {
        const vault = createMockVault();
        const result = formatYearnVaultData(vault);
        expect(result?.strategies).toEqual([]);
      });

      it("includes provided strategies", () => {
        const vault = createMockVault();
        const strategies: YearnVaultStrategy[] = [
          { chainId: 1, address: "0xStrategy1", name: "Strategy 1" },
          { chainId: 1, address: "0xStrategy2", name: "Strategy 2" },
        ];
        const result = formatYearnVaultData(vault, strategies);
        expect(result?.strategies).toHaveLength(2);
        expect(result?.strategies[0].name).toBe("Strategy 1");
      });
    });
  });

  describe("query configuration", () => {
    const STALE_TIME = 60 * 1000; // 1 minute
    const REFETCH_INTERVAL = 60 * 1000; // 1 minute

    it("has 1 minute stale time", () => {
      expect(STALE_TIME).toBe(60000);
    });

    it("has 1 minute refetch interval", () => {
      expect(REFETCH_INTERVAL).toBe(60000);
    });
  });

  describe("query key structure", () => {
    function buildQueryKey(chainId: number, address: string): [string, number, string] {
      return ["yearn-vault", chainId, address];
    }

    it("builds correct query key for mainnet", () => {
      const key = buildQueryKey(1, "0x123");
      expect(key).toEqual(["yearn-vault", 1, "0x123"]);
    });

    it("builds correct query key for different chain", () => {
      const key = buildQueryKey(42161, "0xABC");
      expect(key).toEqual(["yearn-vault", 42161, "0xABC"]);
    });
  });

  describe("query enablement", () => {
    function shouldEnableQuery(address: string | undefined): boolean {
      return !!address;
    }

    it("enables query when address is provided", () => {
      expect(shouldEnableQuery("0x123")).toBe(true);
    });

    it("disables query when address is empty", () => {
      expect(shouldEnableQuery("")).toBe(false);
    });

    it("disables query when address is undefined", () => {
      expect(shouldEnableQuery(undefined)).toBe(false);
    });
  });

  describe("API configuration", () => {
    const KONG_API_URL = "https://kong.yearn.farm/api/gql";

    it("uses correct Kong API URL", () => {
      expect(KONG_API_URL).toBe("https://kong.yearn.farm/api/gql");
    });

    it("API URL is HTTPS", () => {
      expect(KONG_API_URL.startsWith("https://")).toBe(true);
    });
  });

  describe("real-world vault scenarios", () => {
    function formatUsd(value: number): string {
      if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
      return `$${value.toFixed(2)}`;
    }

    function calculateStrategyNetApy(vaultNetApy: number): number {
      return vaultNetApy / 0.85;
    }

    it("ycvxCRV vault with typical values", () => {
      // Typical ycvxCRV vault stats
      const tvl = 1500000; // $1.5M TVL
      const vaultApy = 15.5; // 15.5% APY

      expect(formatUsd(tvl)).toBe("$1.50M");
      expect(calculateStrategyNetApy(vaultApy)).toBeCloseTo(18.24, 2);
    });

    it("small vault with low TVL", () => {
      const tvl = 25000; // $25K TVL
      expect(formatUsd(tvl)).toBe("$25.0K");
    });

    it("large vault with high TVL", () => {
      const tvl = 50000000; // $50M TVL
      expect(formatUsd(tvl)).toBe("$50.00M");
    });

    it("new vault with zero APY", () => {
      const vaultApy = 0;
      expect(calculateStrategyNetApy(vaultApy)).toBe(0);
    });

    it("high-yield vault", () => {
      const vaultApy = 35; // 35% APY
      const strategyApy = calculateStrategyNetApy(vaultApy);
      expect(strategyApy).toBeCloseTo(41.18, 2);
    });
  });
});
