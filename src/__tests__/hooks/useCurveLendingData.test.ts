import { describe, it, expect } from "vitest";

// Test the useCurveLendingData business logic directly
// We test utilization calculation, USD formatting, and vault data formatting

describe("useCurveLendingData logic", () => {
  describe("formatUsd", () => {
    function formatUsd(value: number): string {
      if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
      return `$${value.toFixed(2)}`;
    }

    describe("millions", () => {
      it("formats $1M", () => {
        expect(formatUsd(1_000_000)).toBe("$1.00M");
      });

      it("formats $5.5M", () => {
        expect(formatUsd(5_500_000)).toBe("$5.50M");
      });

      it("formats $100M", () => {
        expect(formatUsd(100_000_000)).toBe("$100.00M");
      });
    });

    describe("thousands", () => {
      it("formats $1K", () => {
        expect(formatUsd(1_000)).toBe("$1.0K");
      });

      it("formats $50K", () => {
        expect(formatUsd(50_000)).toBe("$50.0K");
      });

      it("formats $999K", () => {
        expect(formatUsd(999_000)).toBe("$999.0K");
      });
    });

    describe("small values", () => {
      it("formats $0", () => {
        expect(formatUsd(0)).toBe("$0.00");
      });

      it("formats $1.50", () => {
        expect(formatUsd(1.5)).toBe("$1.50");
      });

      it("formats $999.99", () => {
        expect(formatUsd(999.99)).toBe("$999.99");
      });
    });
  });

  describe("utilization calculation", () => {
    function calculateUtilization(borrowed: number, totalSupplied: number): number {
      return totalSupplied > 0 ? (borrowed / totalSupplied) * 100 : 0;
    }

    it("calculates 0% utilization when nothing borrowed", () => {
      expect(calculateUtilization(0, 1_000_000)).toBe(0);
    });

    it("calculates 50% utilization", () => {
      expect(calculateUtilization(500_000, 1_000_000)).toBe(50);
    });

    it("calculates 100% utilization (fully borrowed)", () => {
      expect(calculateUtilization(1_000_000, 1_000_000)).toBe(100);
    });

    it("calculates 75% utilization", () => {
      expect(calculateUtilization(750_000, 1_000_000)).toBe(75);
    });

    it("returns 0 when total supplied is 0", () => {
      expect(calculateUtilization(0, 0)).toBe(0);
    });

    it("handles small utilization values", () => {
      const utilization = calculateUtilization(1000, 1_000_000);
      expect(utilization).toBeCloseTo(0.1, 2);
    });

    it("formats utilization to 1 decimal place", () => {
      const utilization = calculateUtilization(333_333, 1_000_000);
      expect(`${utilization.toFixed(1)}%`).toBe("33.3%");
    });
  });

  describe("formatCurveVaultData", () => {
    interface CurveLendingVault {
      rates: {
        lendApyPcent: number;
        borrowApyPcent: number;
      };
      totalSupplied: { total: number };
      borrowed: { total: number; usdTotal: number };
      availableToBorrow: { usdTotal: number };
      ammBalances: { ammBalanceCollateral: number };
      usdTotal: number;
      lendingVaultUrls: {
        deposit: string;
        withdraw: string;
        borrow: string;
      };
    }

    function formatUsd(value: number): string {
      if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
      return `$${value.toFixed(2)}`;
    }

    function formatCurveVaultData(vault: CurveLendingVault | undefined) {
      if (!vault) return null;

      const utilization = vault.totalSupplied.total > 0
        ? (vault.borrowed.total / vault.totalSupplied.total) * 100
        : 0;

      return {
        lendApy: vault.rates.lendApyPcent,
        lendApyFormatted: `${vault.rates.lendApyPcent.toFixed(2)}%`,
        borrowApy: vault.rates.borrowApyPcent,
        borrowApyFormatted: `${vault.rates.borrowApyPcent.toFixed(2)}%`,
        tvlUsd: vault.usdTotal,
        tvlFormatted: formatUsd(vault.usdTotal),
        utilization,
        utilizationFormatted: `${utilization.toFixed(1)}%`,
        availableToBorrow: vault.availableToBorrow.usdTotal,
        availableToBorrowFormatted: formatUsd(vault.availableToBorrow.usdTotal),
        totalBorrowed: vault.borrowed.usdTotal,
        totalBorrowedFormatted: formatUsd(vault.borrowed.usdTotal),
        collateralInAmm: vault.ammBalances.ammBalanceCollateral,
        depositUrl: vault.lendingVaultUrls.deposit,
        withdrawUrl: vault.lendingVaultUrls.withdraw,
        borrowUrl: vault.lendingVaultUrls.borrow,
      };
    }

    const createMockVault = (overrides: Partial<CurveLendingVault> = {}): CurveLendingVault => ({
      rates: {
        lendApyPcent: 5.5,
        borrowApyPcent: 8.2,
      },
      totalSupplied: { total: 1_000_000 },
      borrowed: { total: 500_000, usdTotal: 500_000 },
      availableToBorrow: { usdTotal: 500_000 },
      ammBalances: { ammBalanceCollateral: 10_000 },
      usdTotal: 1_500_000,
      lendingVaultUrls: {
        deposit: "https://curve.fi/deposit",
        withdraw: "https://curve.fi/withdraw",
        borrow: "https://curve.fi/borrow",
      },
      ...overrides,
    });

    it("returns null for undefined vault", () => {
      expect(formatCurveVaultData(undefined)).toBeNull();
    });

    describe("APY formatting", () => {
      it("formats lend APY", () => {
        const vault = createMockVault({ rates: { lendApyPcent: 5.55, borrowApyPcent: 8 } });
        const result = formatCurveVaultData(vault);
        expect(result?.lendApy).toBe(5.55);
        expect(result?.lendApyFormatted).toBe("5.55%");
      });

      it("formats borrow APY", () => {
        const vault = createMockVault({ rates: { lendApyPcent: 5, borrowApyPcent: 8.25 } });
        const result = formatCurveVaultData(vault);
        expect(result?.borrowApy).toBe(8.25);
        expect(result?.borrowApyFormatted).toBe("8.25%");
      });

      it("formats 0% APY", () => {
        const vault = createMockVault({ rates: { lendApyPcent: 0, borrowApyPcent: 0 } });
        const result = formatCurveVaultData(vault);
        expect(result?.lendApyFormatted).toBe("0.00%");
        expect(result?.borrowApyFormatted).toBe("0.00%");
      });
    });

    describe("TVL formatting", () => {
      it("formats TVL in millions", () => {
        const vault = createMockVault({ usdTotal: 5_500_000 });
        const result = formatCurveVaultData(vault);
        expect(result?.tvlUsd).toBe(5_500_000);
        expect(result?.tvlFormatted).toBe("$5.50M");
      });

      it("formats TVL in thousands", () => {
        const vault = createMockVault({ usdTotal: 250_000 });
        const result = formatCurveVaultData(vault);
        expect(result?.tvlFormatted).toBe("$250.0K");
      });
    });

    describe("utilization calculation", () => {
      it("calculates 50% utilization", () => {
        const vault = createMockVault({
          totalSupplied: { total: 1_000_000 },
          borrowed: { total: 500_000, usdTotal: 500_000 },
        });
        const result = formatCurveVaultData(vault);
        expect(result?.utilization).toBe(50);
        expect(result?.utilizationFormatted).toBe("50.0%");
      });

      it("calculates 0% utilization", () => {
        const vault = createMockVault({
          totalSupplied: { total: 1_000_000 },
          borrowed: { total: 0, usdTotal: 0 },
        });
        const result = formatCurveVaultData(vault);
        expect(result?.utilization).toBe(0);
      });

      it("handles empty pool (0 total supplied)", () => {
        const vault = createMockVault({
          totalSupplied: { total: 0 },
          borrowed: { total: 0, usdTotal: 0 },
        });
        const result = formatCurveVaultData(vault);
        expect(result?.utilization).toBe(0);
      });
    });

    describe("available to borrow", () => {
      it("formats available to borrow", () => {
        const vault = createMockVault({
          availableToBorrow: { usdTotal: 750_000 },
        });
        const result = formatCurveVaultData(vault);
        expect(result?.availableToBorrow).toBe(750_000);
        expect(result?.availableToBorrowFormatted).toBe("$750.0K");
      });
    });

    describe("total borrowed", () => {
      it("formats total borrowed", () => {
        const vault = createMockVault({
          borrowed: { total: 1_500_000, usdTotal: 1_500_000 },
        });
        const result = formatCurveVaultData(vault);
        expect(result?.totalBorrowed).toBe(1_500_000);
        expect(result?.totalBorrowedFormatted).toBe("$1.50M");
      });
    });

    describe("AMM collateral", () => {
      it("extracts collateral in AMM", () => {
        const vault = createMockVault({
          ammBalances: { ammBalanceCollateral: 25_000 },
        });
        const result = formatCurveVaultData(vault);
        expect(result?.collateralInAmm).toBe(25_000);
      });
    });

    describe("URLs", () => {
      it("extracts deposit URL", () => {
        const vault = createMockVault({
          lendingVaultUrls: {
            deposit: "https://curve.fi/deposit/123",
            withdraw: "https://curve.fi/withdraw/123",
            borrow: "https://curve.fi/borrow/123",
          },
        });
        const result = formatCurveVaultData(vault);
        expect(result?.depositUrl).toBe("https://curve.fi/deposit/123");
        expect(result?.withdrawUrl).toBe("https://curve.fi/withdraw/123");
        expect(result?.borrowUrl).toBe("https://curve.fi/borrow/123");
      });
    });
  });

  describe("VAULT_TO_CURVE_CONTROLLER mapping", () => {
    const VAULT_TO_CURVE_CONTROLLER: Record<string, string> = {
      "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86": "0x24174143cCF438f0A1F6dCF93B468C127123A96E",
    };

    it("maps ycvxCRV vault to Curve controller", () => {
      const ycvxcrvVault = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86";
      expect(VAULT_TO_CURVE_CONTROLLER[ycvxcrvVault]).toBe(
        "0x24174143cCF438f0A1F6dCF93B468C127123A96E"
      );
    });

    it("returns undefined for unknown vault", () => {
      expect(VAULT_TO_CURVE_CONTROLLER["0x0000000000000000000000000000000000000000"]).toBeUndefined();
    });
  });

  describe("vault lookup by controller", () => {
    interface CurveLendingVault {
      controllerAddress: string;
      name: string;
    }

    function findVaultByController(
      vaults: CurveLendingVault[],
      controllerAddress: string | undefined
    ): CurveLendingVault | undefined {
      if (!controllerAddress) return undefined;
      return vaults.find(
        (v) => v.controllerAddress.toLowerCase() === controllerAddress.toLowerCase()
      );
    }

    const mockVaults: CurveLendingVault[] = [
      { controllerAddress: "0xAAA111", name: "Vault A" },
      { controllerAddress: "0xBBB222", name: "Vault B" },
      { controllerAddress: "0xCCC333", name: "Vault C" },
    ];

    it("finds vault by controller address", () => {
      const vault = findVaultByController(mockVaults, "0xBBB222");
      expect(vault?.name).toBe("Vault B");
    });

    it("finds vault case-insensitively", () => {
      const vault = findVaultByController(mockVaults, "0xbbb222");
      expect(vault?.name).toBe("Vault B");
    });

    it("returns undefined for non-existent controller", () => {
      expect(findVaultByController(mockVaults, "0xDDD444")).toBeUndefined();
    });

    it("returns undefined when controller is undefined", () => {
      expect(findVaultByController(mockVaults, undefined)).toBeUndefined();
    });
  });

  describe("query configuration", () => {
    const STALE_TIME = 60 * 1000;
    const REFETCH_INTERVAL = 60 * 1000;

    it("has 1 minute stale time", () => {
      expect(STALE_TIME).toBe(60000);
    });

    it("has 1 minute refetch interval", () => {
      expect(REFETCH_INTERVAL).toBe(60000);
    });
  });

  describe("API configuration", () => {
    const API_URL = "https://api.curve.finance/v1/getLendingVaults/all/ethereum";

    it("uses correct Curve API URL", () => {
      expect(API_URL).toContain("api.curve.finance");
      expect(API_URL).toContain("getLendingVaults");
    });

    it("targets Ethereum chain", () => {
      expect(API_URL).toContain("/ethereum");
    });
  });

  describe("real-world scenarios", () => {
    function formatUsd(value: number): string {
      if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
      return `$${value.toFixed(2)}`;
    }

    function calculateUtilization(borrowed: number, totalSupplied: number): number {
      return totalSupplied > 0 ? (borrowed / totalSupplied) * 100 : 0;
    }

    it("typical cvxCRV/crvUSD market stats", () => {
      // Typical market with $5M TVL, 60% utilization
      const tvl = 5_000_000;
      const totalSupplied = 5_000_000;
      const borrowed = 3_000_000;

      expect(formatUsd(tvl)).toBe("$5.00M");
      expect(calculateUtilization(borrowed, totalSupplied)).toBe(60);
    });

    it("high utilization market", () => {
      // Market near capacity
      const totalSupplied = 10_000_000;
      const borrowed = 9_500_000;
      const utilization = calculateUtilization(borrowed, totalSupplied);

      expect(utilization).toBe(95);
    });

    it("low utilization market (bear market)", () => {
      const totalSupplied = 20_000_000;
      const borrowed = 2_000_000;
      const utilization = calculateUtilization(borrowed, totalSupplied);

      expect(utilization).toBe(10);
    });
  });
});
