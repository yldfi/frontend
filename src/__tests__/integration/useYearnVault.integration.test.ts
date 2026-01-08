import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import {
  useYearnVault,
  formatYearnVaultData,
  calculateStrategyNetApy,
} from "@/hooks/useYearnVault";

// Get mocked function
const mockUseQuery = vi.mocked(useQuery);
const mockFetch = vi.mocked(globalThis.fetch);

describe("useYearnVault integration", () => {
  const VAULT_ADDRESS = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86";
  const CHAIN_ID = 1;

  const mockVaultResponse = {
    vault: {
      chainId: 1,
      address: VAULT_ADDRESS,
      name: "ycvxCRV Vault",
      symbol: "ycvxCRV",
      asset: {
        address: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7",
        name: "Convex CRV",
        symbol: "cvxCRV",
        decimals: 18,
      },
      accountant: "0xAccountant",
      pricePerShare: "1050000000000000000",
      totalAssets: "1000000000000000000000000",
      totalDebt: "900000000000000000000000",
      fees: {
        managementFee: 100,
        performanceFee: 1500,
      },
      tvl: {
        close: 1500000,
      },
      apy: {
        close: 0.125, // Kong returns as decimal (0.125 = 12.5%)
        grossApr: 0.15, // Kong returns as decimal (0.15 = 15%)
        weeklyNet: 0.112,
        monthlyNet: 0.121,
        inceptionNet: 0.135,
      },
      debts: [
        {
          strategy: "0xStrategy1",
          currentDebt: "500000000000000000000000",
          currentDebtUsd: 750000,
          targetDebtRatio: 50,
        },
      ],
    },
    vaultStrategies: [
      {
        chainId: 1,
        address: "0xStrategy1",
        name: "cvxCRV Staking Strategy",
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe("useYearnVault hook", () => {
    it("returns vault data on successful fetch", () => {
      mockUseQuery.mockReturnValue({
        data: mockVaultResponse,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useYearnVault(VAULT_ADDRESS, CHAIN_ID)
      );

      expect(result.current.data).toEqual(mockVaultResponse);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("returns loading state while fetching", () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useYearnVault(VAULT_ADDRESS, CHAIN_ID)
      );

      expect(result.current.isLoading).toBe(true);
      expect(result.current.data).toBeUndefined();
    });

    it("returns error state on failure", () => {
      const fetchError = new Error("Failed to fetch Yearn vault data");
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: fetchError,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useYearnVault(VAULT_ADDRESS, CHAIN_ID)
      );

      expect(result.current.error).toBe(fetchError);
    });

    it("uses default chainId of 1 when not specified", () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      renderHook(() => useYearnVault(VAULT_ADDRESS));

      // Check useQuery was called - the hook defaults to chainId 1
      expect(mockUseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: ["yearn-vault", 1, VAULT_ADDRESS],
        })
      );
    });

    it("is disabled when address is empty", () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      renderHook(() => useYearnVault(""));

      expect(mockUseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        })
      );
    });
  });

  describe("formatYearnVaultData", () => {
    it("formats complete vault data correctly", () => {
      const result = formatYearnVaultData(
        mockVaultResponse.vault,
        mockVaultResponse.vaultStrategies
      );

      expect(result).not.toBeNull();
      expect(result?.name).toBe("ycvxCRV Vault");
      expect(result?.symbol).toBe("ycvxCRV");
      expect(result?.asset.symbol).toBe("cvxCRV");
      expect(result?.tvl).toBe(1500000);
      expect(result?.tvlFormatted).toBe("$1.50M");
      expect(result?.apy).toBe(12.5);
      expect(result?.apyFormatted).toBe("12.50%");
      expect(result?.grossApr).toBe(15.0);
      expect(result?.grossAprFormatted).toBe("15.00%");
      expect(result?.pricePerShare).toBeCloseTo(1.05, 2);
      expect(result?.managementFee).toBe(100);
      expect(result?.managementFeeFormatted).toBe("1.00%");
      expect(result?.performanceFee).toBe(1500);
      expect(result?.performanceFeeFormatted).toBe("15%");
      expect(result?.strategies).toHaveLength(1);
    });

    it("returns null for null vault", () => {
      const result = formatYearnVaultData(null);
      expect(result).toBeNull();
    });

    it("returns null for undefined vault", () => {
      const result = formatYearnVaultData(undefined);
      expect(result).toBeNull();
    });

    it("handles empty strategies array", () => {
      const result = formatYearnVaultData(mockVaultResponse.vault, []);
      expect(result?.strategies).toHaveLength(0);
    });

    it("handles missing fees", () => {
      const vaultWithoutFees = {
        ...mockVaultResponse.vault,
        fees: null,
      };

      const result = formatYearnVaultData(vaultWithoutFees);

      expect(result?.managementFee).toBe(0);
      expect(result?.performanceFee).toBe(0);
      expect(result?.managementFeeFormatted).toBe("0.00%");
      expect(result?.performanceFeeFormatted).toBe("0%");
    });

    it("handles missing TVL", () => {
      const vaultWithoutTvl = {
        ...mockVaultResponse.vault,
        tvl: null,
      };

      const result = formatYearnVaultData(vaultWithoutTvl as unknown as typeof mockVaultResponse.vault);

      expect(result?.tvl).toBe(0);
      expect(result?.tvlFormatted).toBe("$0.00");
    });

    it("handles missing APY", () => {
      const vaultWithoutApy = {
        ...mockVaultResponse.vault,
        apy: null,
      };

      const result = formatYearnVaultData(vaultWithoutApy as unknown as typeof mockVaultResponse.vault);

      expect(result?.apy).toBe(0);
      expect(result?.apyFormatted).toBe("0.00%");
      expect(result?.grossApr).toBe(0);
    });

    it("formats TVL in thousands", () => {
      const vault = {
        ...mockVaultResponse.vault,
        tvl: { close: 50000 },
      };

      const result = formatYearnVaultData(vault);
      expect(result?.tvlFormatted).toBe("$50.0K");
    });

    it("formats small TVL", () => {
      const vault = {
        ...mockVaultResponse.vault,
        tvl: { close: 500 },
      };

      const result = formatYearnVaultData(vault);
      expect(result?.tvlFormatted).toBe("$500.00");
    });

    it("handles 6 decimal asset (USDC-like)", () => {
      const usdcVault = {
        ...mockVaultResponse.vault,
        asset: {
          ...mockVaultResponse.vault.asset,
          decimals: 6,
        },
        pricePerShare: "1050000", // 1.05 with 6 decimals
      };

      const result = formatYearnVaultData(usdcVault);
      expect(result?.pricePerShare).toBeCloseTo(1.05, 2);
    });

    it("handles 8 decimal asset (WBTC-like)", () => {
      const wbtcVault = {
        ...mockVaultResponse.vault,
        asset: {
          ...mockVaultResponse.vault.asset,
          decimals: 8,
        },
        pricePerShare: "105000000", // 1.05 with 8 decimals
      };

      const result = formatYearnVaultData(wbtcVault);
      expect(result?.pricePerShare).toBeCloseTo(1.05, 2);
    });
  });

  describe("calculateStrategyNetApy", () => {
    it("calculates strategy APY from vault APY", () => {
      // Vault takes 15% fee, so strategy net = vault net / 0.85
      const vaultNetApy = 12.5;
      const strategyApy = calculateStrategyNetApy(vaultNetApy);

      expect(strategyApy).toBeCloseTo(14.71, 2);
    });

    it("handles zero APY", () => {
      const strategyApy = calculateStrategyNetApy(0);
      expect(strategyApy).toBe(0);
    });

    it("handles negative APY (vault losing money)", () => {
      const strategyApy = calculateStrategyNetApy(-5);
      expect(strategyApy).toBeCloseTo(-5.88, 2);
    });

    it("handles high APY", () => {
      const strategyApy = calculateStrategyNetApy(50);
      expect(strategyApy).toBeCloseTo(58.82, 2);
    });

    it("handles small APY", () => {
      const strategyApy = calculateStrategyNetApy(0.5);
      expect(strategyApy).toBeCloseTo(0.59, 2);
    });
  });

  describe("edge cases", () => {
    it("handles vault with zero price per share", () => {
      const vault = {
        ...mockVaultResponse.vault,
        pricePerShare: "0",
      };

      const result = formatYearnVaultData(vault);
      expect(result?.pricePerShare).toBe(0);
      expect(result?.pricePerShareFormatted).toBe("0.0000");
    });

    it("handles vault with very high price per share", () => {
      const vault = {
        ...mockVaultResponse.vault,
        pricePerShare: "100000000000000000000", // 100 PPS
      };

      const result = formatYearnVaultData(vault);
      expect(result?.pricePerShare).toBe(100);
    });

    it("handles vault with very low price per share", () => {
      const vault = {
        ...mockVaultResponse.vault,
        pricePerShare: "100000000000000000", // 0.1 PPS
      };

      const result = formatYearnVaultData(vault);
      expect(result?.pricePerShare).toBeCloseTo(0.1, 2);
    });

    it("handles vault with multiple strategies", () => {
      const strategies = [
        { chainId: 1, address: "0xStrategy1", name: "Strategy 1" },
        { chainId: 1, address: "0xStrategy2", name: "Strategy 2" },
        { chainId: 1, address: "0xStrategy3", name: "Strategy 3" },
      ];

      const result = formatYearnVaultData(mockVaultResponse.vault, strategies);
      expect(result?.strategies).toHaveLength(3);
    });

    it("handles different chain IDs", () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      // Test Arbitrum
      renderHook(() => useYearnVault(VAULT_ADDRESS, 42161));
      expect(mockUseQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: ["yearn-vault", 42161, VAULT_ADDRESS],
        })
      );
    });
  });
});
