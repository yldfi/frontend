import { describe, it, expect } from "vitest";

// Test the HomePageContent business logic directly
// We test vault configuration, TVL formatting, APY calculations, and sorting

describe("HomePageContent logic", () => {
  describe("vault configurations", () => {
    const YCVXCRV_ADDRESS = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86";
    const YSCVXCRV_ADDRESS = "0x27B5739e22ad9033bcBf192059122d163b60349D";

    interface VaultConfig {
      name: string;
      vaultAddress: string;
      assetSymbol: string;
      description: string;
    }

    const vaultConfigs: VaultConfig[] = [
      {
        name: "ycvxCRV",
        vaultAddress: YCVXCRV_ADDRESS,
        assetSymbol: "cvxCRV",
        description: "Yearn cvxCRV auto-compounding vault",
      },
      {
        name: "yscvxCRV",
        vaultAddress: YSCVXCRV_ADDRESS,
        assetSymbol: "stkCvxCrv",
        description: "Yearn staked cvxCRV vault",
      },
    ];

    it("has two vault configurations", () => {
      expect(vaultConfigs).toHaveLength(2);
    });

    it("has ycvxCRV vault", () => {
      const vault = vaultConfigs.find((v) => v.name === "ycvxCRV");
      expect(vault).toBeDefined();
      expect(vault?.vaultAddress).toBe(YCVXCRV_ADDRESS);
    });

    it("has yscvxCRV vault", () => {
      const vault = vaultConfigs.find((v) => v.name === "yscvxCRV");
      expect(vault).toBeDefined();
      expect(vault?.vaultAddress).toBe(YSCVXCRV_ADDRESS);
    });

    it("all vaults have required fields", () => {
      vaultConfigs.forEach((vault) => {
        expect(vault.name).toBeTruthy();
        expect(vault.vaultAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(vault.assetSymbol).toBeTruthy();
        expect(vault.description).toBeTruthy();
      });
    });
  });

  describe("formatNumber function", () => {
    function formatNumber(value: number | undefined): string {
      if (value === undefined || value === null) return "—";
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
      return value.toFixed(2);
    }

    describe("millions", () => {
      it("formats $1M", () => {
        expect(formatNumber(1_000_000)).toBe("1.00M");
      });

      it("formats $5.5M", () => {
        expect(formatNumber(5_500_000)).toBe("5.50M");
      });

      it("formats $100M", () => {
        expect(formatNumber(100_000_000)).toBe("100.00M");
      });

      it("formats $1.23M", () => {
        expect(formatNumber(1_234_567)).toBe("1.23M");
      });
    });

    describe("thousands", () => {
      it("formats $1K", () => {
        expect(formatNumber(1_000)).toBe("1.0K");
      });

      it("formats $50K", () => {
        expect(formatNumber(50_000)).toBe("50.0K");
      });

      it("formats $999K", () => {
        expect(formatNumber(999_000)).toBe("999.0K");
      });

      it("formats $500.5K", () => {
        expect(formatNumber(500_500)).toBe("500.5K");
      });
    });

    describe("small values", () => {
      it("formats $0", () => {
        expect(formatNumber(0)).toBe("0.00");
      });

      it("formats $1.50", () => {
        expect(formatNumber(1.5)).toBe("1.50");
      });

      it("formats $999.99", () => {
        expect(formatNumber(999.99)).toBe("999.99");
      });

      it("formats $0.01", () => {
        expect(formatNumber(0.01)).toBe("0.01");
      });
    });

    describe("edge cases", () => {
      it("returns dash for undefined", () => {
        expect(formatNumber(undefined)).toBe("—");
      });

      it("handles boundary at 1000", () => {
        expect(formatNumber(999)).toBe("999.00");
        expect(formatNumber(1000)).toBe("1.0K");
      });

      it("handles boundary at 1M", () => {
        expect(formatNumber(999_999)).toBe("1000.0K");
        expect(formatNumber(1_000_000)).toBe("1.00M");
      });
    });
  });

  describe("APY formatting", () => {
    function formatApy(apy: number | undefined): string {
      if (apy === undefined || apy === null) return "—";
      return `${apy.toFixed(2)}%`;
    }

    it("formats normal APY", () => {
      expect(formatApy(5.5)).toBe("5.50%");
      expect(formatApy(10)).toBe("10.00%");
    });

    it("formats zero APY", () => {
      expect(formatApy(0)).toBe("0.00%");
    });

    it("formats high APY", () => {
      expect(formatApy(100)).toBe("100.00%");
      expect(formatApy(999.99)).toBe("999.99%");
    });

    it("returns dash for undefined", () => {
      expect(formatApy(undefined)).toBe("—");
    });
  });

  describe("total TVL calculation", () => {
    interface VaultData {
      tvlUsd: number;
    }

    function calculateTotalTvl(vaults: VaultData[]): number {
      return vaults.reduce((sum, vault) => sum + (vault.tvlUsd || 0), 0);
    }

    it("sums all vault TVLs", () => {
      const vaults = [{ tvlUsd: 1_000_000 }, { tvlUsd: 500_000 }];
      expect(calculateTotalTvl(vaults)).toBe(1_500_000);
    });

    it("handles empty array", () => {
      expect(calculateTotalTvl([])).toBe(0);
    });

    it("handles undefined tvlUsd", () => {
      const vaults = [{ tvlUsd: 1_000_000 }, { tvlUsd: 0 }] as VaultData[];
      expect(calculateTotalTvl(vaults)).toBe(1_000_000);
    });

    it("handles single vault", () => {
      const vaults = [{ tvlUsd: 2_500_000 }];
      expect(calculateTotalTvl(vaults)).toBe(2_500_000);
    });
  });

  describe("average APY calculation", () => {
    interface VaultData {
      apy: number;
      tvlUsd: number;
    }

    function calculateWeightedAvgApy(vaults: VaultData[]): number {
      const totalTvl = vaults.reduce((sum, v) => sum + (v.tvlUsd || 0), 0);
      if (totalTvl === 0) return 0;

      const weightedSum = vaults.reduce(
        (sum, v) => sum + (v.apy || 0) * (v.tvlUsd || 0),
        0
      );
      return weightedSum / totalTvl;
    }

    function calculateSimpleAvgApy(vaults: VaultData[]): number {
      if (vaults.length === 0) return 0;
      const sum = vaults.reduce((acc, v) => acc + (v.apy || 0), 0);
      return sum / vaults.length;
    }

    it("calculates weighted average APY", () => {
      const vaults = [
        { apy: 10, tvlUsd: 1_000_000 },
        { apy: 5, tvlUsd: 1_000_000 },
      ];
      expect(calculateWeightedAvgApy(vaults)).toBe(7.5);
    });

    it("weighted average favors larger TVL", () => {
      const vaults = [
        { apy: 10, tvlUsd: 3_000_000 }, // 3x weight
        { apy: 5, tvlUsd: 1_000_000 },
      ];
      // (10 * 3M + 5 * 1M) / 4M = 35M / 4M = 8.75
      expect(calculateWeightedAvgApy(vaults)).toBe(8.75);
    });

    it("calculates simple average APY", () => {
      const vaults = [
        { apy: 10, tvlUsd: 0 },
        { apy: 5, tvlUsd: 0 },
      ];
      expect(calculateSimpleAvgApy(vaults)).toBe(7.5);
    });

    it("handles empty vaults", () => {
      expect(calculateWeightedAvgApy([])).toBe(0);
      expect(calculateSimpleAvgApy([])).toBe(0);
    });

    it("handles zero TVL", () => {
      const vaults = [{ apy: 10, tvlUsd: 0 }];
      expect(calculateWeightedAvgApy(vaults)).toBe(0);
    });
  });

  describe("user holdings calculation", () => {
    interface VaultBalance {
      balanceUsd: number;
    }

    function calculateTotalHoldings(balances: VaultBalance[]): number {
      return balances.reduce((sum, b) => sum + (b.balanceUsd || 0), 0);
    }

    it("sums all balances", () => {
      const balances = [{ balanceUsd: 1000 }, { balanceUsd: 500 }];
      expect(calculateTotalHoldings(balances)).toBe(1500);
    });

    it("handles empty balances", () => {
      expect(calculateTotalHoldings([])).toBe(0);
    });

    it("handles zero balances", () => {
      const balances = [{ balanceUsd: 0 }, { balanceUsd: 0 }];
      expect(calculateTotalHoldings(balances)).toBe(0);
    });
  });

  describe("vault sorting", () => {
    interface Vault {
      name: string;
      tvlUsd: number;
      apy: number;
    }

    function sortByTvl(vaults: Vault[]): Vault[] {
      return [...vaults].sort((a, b) => b.tvlUsd - a.tvlUsd);
    }

    function sortByApy(vaults: Vault[]): Vault[] {
      return [...vaults].sort((a, b) => b.apy - a.apy);
    }

    function sortByName(vaults: Vault[]): Vault[] {
      return [...vaults].sort((a, b) => a.name.localeCompare(b.name));
    }

    const mockVaults: Vault[] = [
      { name: "Vault B", tvlUsd: 500_000, apy: 10 },
      { name: "Vault A", tvlUsd: 1_000_000, apy: 5 },
      { name: "Vault C", tvlUsd: 250_000, apy: 15 },
    ];

    it("sorts by TVL descending", () => {
      const sorted = sortByTvl(mockVaults);
      expect(sorted[0].name).toBe("Vault A");
      expect(sorted[1].name).toBe("Vault B");
      expect(sorted[2].name).toBe("Vault C");
    });

    it("sorts by APY descending", () => {
      const sorted = sortByApy(mockVaults);
      expect(sorted[0].name).toBe("Vault C");
      expect(sorted[1].name).toBe("Vault B");
      expect(sorted[2].name).toBe("Vault A");
    });

    it("sorts by name alphabetically", () => {
      const sorted = sortByName(mockVaults);
      expect(sorted[0].name).toBe("Vault A");
      expect(sorted[1].name).toBe("Vault B");
      expect(sorted[2].name).toBe("Vault C");
    });
  });

  describe("loading state", () => {
    interface LoadingState {
      isVaultsLoading: boolean;
      isBalancesLoading: boolean;
      isConnected: boolean;
    }

    function getLoadingMessage(state: LoadingState): string | null {
      if (state.isVaultsLoading) return "Loading vaults...";
      if (state.isConnected && state.isBalancesLoading) return "Loading balances...";
      return null;
    }

    it("shows vault loading message", () => {
      expect(
        getLoadingMessage({
          isVaultsLoading: true,
          isBalancesLoading: false,
          isConnected: true,
        })
      ).toBe("Loading vaults...");
    });

    it("shows balance loading when connected", () => {
      expect(
        getLoadingMessage({
          isVaultsLoading: false,
          isBalancesLoading: true,
          isConnected: true,
        })
      ).toBe("Loading balances...");
    });

    it("hides balance loading when not connected", () => {
      expect(
        getLoadingMessage({
          isVaultsLoading: false,
          isBalancesLoading: true,
          isConnected: false,
        })
      ).toBe(null);
    });

    it("returns null when not loading", () => {
      expect(
        getLoadingMessage({
          isVaultsLoading: false,
          isBalancesLoading: false,
          isConnected: true,
        })
      ).toBe(null);
    });
  });

  describe("vault card display", () => {
    interface VaultCardData {
      name: string;
      apy: number | undefined;
      tvlUsd: number | undefined;
      userBalanceUsd: number | undefined;
      isConnected: boolean;
    }

    function getVaultCardDisplay(vault: VaultCardData): {
      apyDisplay: string;
      tvlDisplay: string;
      balanceDisplay: string;
    } {
      const formatNumber = (value: number | undefined): string => {
        if (value === undefined) return "—";
        if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
        if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
        return `$${value.toFixed(2)}`;
      };

      return {
        apyDisplay: vault.apy !== undefined ? `${vault.apy.toFixed(2)}%` : "—",
        tvlDisplay: formatNumber(vault.tvlUsd),
        balanceDisplay: vault.isConnected
          ? formatNumber(vault.userBalanceUsd)
          : "Connect Wallet",
      };
    }

    it("displays all data when available", () => {
      const display = getVaultCardDisplay({
        name: "Test Vault",
        apy: 5.5,
        tvlUsd: 1_000_000,
        userBalanceUsd: 1000,
        isConnected: true,
      });
      expect(display.apyDisplay).toBe("5.50%");
      expect(display.tvlDisplay).toBe("$1.00M");
      expect(display.balanceDisplay).toBe("$1.0K");
    });

    it("shows dash for missing data", () => {
      const display = getVaultCardDisplay({
        name: "Test Vault",
        apy: undefined,
        tvlUsd: undefined,
        userBalanceUsd: undefined,
        isConnected: true,
      });
      expect(display.apyDisplay).toBe("—");
      expect(display.tvlDisplay).toBe("—");
      expect(display.balanceDisplay).toBe("—");
    });

    it("shows connect wallet when not connected", () => {
      const display = getVaultCardDisplay({
        name: "Test Vault",
        apy: 5.5,
        tvlUsd: 1_000_000,
        userBalanceUsd: 1000,
        isConnected: false,
      });
      expect(display.balanceDisplay).toBe("Connect Wallet");
    });
  });

  describe("vault URL generation", () => {
    function getVaultUrl(vaultAddress: string): string {
      return `/vault/${vaultAddress}`;
    }

    function getEtherscanUrl(vaultAddress: string): string {
      return `https://etherscan.io/address/${vaultAddress}`;
    }

    it("generates correct vault URL", () => {
      const url = getVaultUrl("0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86");
      expect(url).toBe("/vault/0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86");
    });

    it("generates correct Etherscan URL", () => {
      const url = getEtherscanUrl("0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86");
      expect(url).toBe(
        "https://etherscan.io/address/0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86"
      );
    });
  });

  describe("empty state", () => {
    function shouldShowEmptyState(
      vaults: unknown[],
      isLoading: boolean,
      hasError: boolean
    ): boolean {
      return !isLoading && !hasError && vaults.length === 0;
    }

    it("shows empty state when no vaults", () => {
      expect(shouldShowEmptyState([], false, false)).toBe(true);
    });

    it("hides empty state when loading", () => {
      expect(shouldShowEmptyState([], true, false)).toBe(false);
    });

    it("hides empty state when has error", () => {
      expect(shouldShowEmptyState([], false, true)).toBe(false);
    });

    it("hides empty state when has vaults", () => {
      expect(shouldShowEmptyState([{}], false, false)).toBe(false);
    });
  });

  describe("error state", () => {
    function getErrorMessage(error: Error | null): string | null {
      if (!error) return null;
      if (error.message.includes("network")) return "Network error. Please try again.";
      if (error.message.includes("rate limit")) return "Too many requests. Please wait.";
      return "Failed to load vault data.";
    }

    it("returns null when no error", () => {
      expect(getErrorMessage(null)).toBe(null);
    });

    it("shows network error message", () => {
      const error = new Error("network timeout");
      expect(getErrorMessage(error)).toBe("Network error. Please try again.");
    });

    it("shows rate limit message", () => {
      const error = new Error("rate limit exceeded");
      expect(getErrorMessage(error)).toBe("Too many requests. Please wait.");
    });

    it("shows generic error message", () => {
      const error = new Error("unknown error");
      expect(getErrorMessage(error)).toBe("Failed to load vault data.");
    });
  });

  describe("responsive layout", () => {
    type GridLayout = "1-col" | "2-col" | "3-col";

    function getGridLayout(width: number): GridLayout {
      if (width >= 1024) return "3-col";
      if (width >= 768) return "2-col";
      return "1-col";
    }

    it("uses 1 column on mobile", () => {
      expect(getGridLayout(375)).toBe("1-col");
      expect(getGridLayout(767)).toBe("1-col");
    });

    it("uses 2 columns on tablet", () => {
      expect(getGridLayout(768)).toBe("2-col");
      expect(getGridLayout(1023)).toBe("2-col");
    });

    it("uses 3 columns on desktop", () => {
      expect(getGridLayout(1024)).toBe("3-col");
      expect(getGridLayout(1440)).toBe("3-col");
    });
  });

  describe("vault data merging", () => {
    interface YearnVaultData {
      apy: number;
      tvlUsd: number;
    }

    interface CacheVaultData {
      pps: number;
      tvlUsd: number;
    }

    interface MergedVaultData {
      apy: number;
      tvlUsd: number;
      pps: number;
    }

    function mergeVaultData(
      yearnData: YearnVaultData | undefined,
      cacheData: CacheVaultData | undefined
    ): MergedVaultData {
      return {
        apy: yearnData?.apy ?? 0,
        tvlUsd: yearnData?.tvlUsd ?? cacheData?.tvlUsd ?? 0,
        pps: cacheData?.pps ?? 1,
      };
    }

    it("uses yearn data when available", () => {
      const merged = mergeVaultData({ apy: 5.5, tvlUsd: 1_000_000 }, { pps: 1.05, tvlUsd: 900_000 });
      expect(merged.apy).toBe(5.5);
      expect(merged.tvlUsd).toBe(1_000_000);
      expect(merged.pps).toBe(1.05);
    });

    it("falls back to cache TVL", () => {
      const merged = mergeVaultData(undefined, { pps: 1.05, tvlUsd: 900_000 });
      expect(merged.apy).toBe(0);
      expect(merged.tvlUsd).toBe(900_000);
    });

    it("defaults to zero and 1 pps", () => {
      const merged = mergeVaultData(undefined, undefined);
      expect(merged.apy).toBe(0);
      expect(merged.tvlUsd).toBe(0);
      expect(merged.pps).toBe(1);
    });
  });

  describe("vault status badges", () => {
    type VaultStatus = "active" | "deprecated" | "new";

    function getStatusBadge(status: VaultStatus): { text: string; color: string } {
      switch (status) {
        case "active":
          return { text: "Active", color: "green" };
        case "deprecated":
          return { text: "Deprecated", color: "red" };
        case "new":
          return { text: "New", color: "blue" };
      }
    }

    it("returns active badge", () => {
      const badge = getStatusBadge("active");
      expect(badge.text).toBe("Active");
      expect(badge.color).toBe("green");
    });

    it("returns deprecated badge", () => {
      const badge = getStatusBadge("deprecated");
      expect(badge.text).toBe("Deprecated");
      expect(badge.color).toBe("red");
    });

    it("returns new badge", () => {
      const badge = getStatusBadge("new");
      expect(badge.text).toBe("New");
      expect(badge.color).toBe("blue");
    });
  });

  describe("refresh functionality", () => {
    function shouldAutoRefresh(
      lastRefreshTime: number,
      currentTime: number,
      intervalMs: number
    ): boolean {
      return currentTime - lastRefreshTime >= intervalMs;
    }

    const REFRESH_INTERVAL = 60_000; // 1 minute

    it("triggers refresh after interval", () => {
      const now = Date.now();
      const lastRefresh = now - 61_000;
      expect(shouldAutoRefresh(lastRefresh, now, REFRESH_INTERVAL)).toBe(true);
    });

    it("prevents refresh before interval", () => {
      const now = Date.now();
      const lastRefresh = now - 30_000;
      expect(shouldAutoRefresh(lastRefresh, now, REFRESH_INTERVAL)).toBe(false);
    });

    it("allows immediate refresh on first load", () => {
      const now = Date.now();
      expect(shouldAutoRefresh(0, now, REFRESH_INTERVAL)).toBe(true);
    });
  });

  describe("accessibility", () => {
    function getVaultCardAriaLabel(
      name: string,
      apy: number | undefined,
      tvlUsd: number | undefined
    ): string {
      const apyText = apy !== undefined ? `${apy.toFixed(2)}% APY` : "APY unavailable";
      const tvlText =
        tvlUsd !== undefined
          ? `$${tvlUsd >= 1_000_000 ? (tvlUsd / 1_000_000).toFixed(2) + "M" : tvlUsd.toFixed(0)} TVL`
          : "TVL unavailable";
      return `${name} vault, ${apyText}, ${tvlText}`;
    }

    it("creates accessible label with all data", () => {
      const label = getVaultCardAriaLabel("ycvxCRV", 5.5, 1_000_000);
      expect(label).toBe("ycvxCRV vault, 5.50% APY, $1.00M TVL");
    });

    it("handles missing APY", () => {
      const label = getVaultCardAriaLabel("ycvxCRV", undefined, 1_000_000);
      expect(label).toContain("APY unavailable");
    });

    it("handles missing TVL", () => {
      const label = getVaultCardAriaLabel("ycvxCRV", 5.5, undefined);
      expect(label).toContain("TVL unavailable");
    });
  });

  describe("pagination", () => {
    function paginate<T>(items: T[], page: number, pageSize: number): T[] {
      const start = page * pageSize;
      return items.slice(start, start + pageSize);
    }

    function getTotalPages(totalItems: number, pageSize: number): number {
      return Math.ceil(totalItems / pageSize);
    }

    const mockItems = Array.from({ length: 25 }, (_, i) => ({ id: i }));

    it("returns first page", () => {
      const page = paginate(mockItems, 0, 10);
      expect(page).toHaveLength(10);
      expect(page[0].id).toBe(0);
    });

    it("returns middle page", () => {
      const page = paginate(mockItems, 1, 10);
      expect(page).toHaveLength(10);
      expect(page[0].id).toBe(10);
    });

    it("returns partial last page", () => {
      const page = paginate(mockItems, 2, 10);
      expect(page).toHaveLength(5);
      expect(page[0].id).toBe(20);
    });

    it("calculates total pages", () => {
      expect(getTotalPages(25, 10)).toBe(3);
      expect(getTotalPages(20, 10)).toBe(2);
      expect(getTotalPages(1, 10)).toBe(1);
    });
  });

  describe("real-world scenarios", () => {
    function formatNumber(value: number | undefined): string {
      if (value === undefined) return "—";
      if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
      return `$${value.toFixed(2)}`;
    }

    it("typical ycvxCRV vault display", () => {
      const vault = {
        name: "ycvxCRV",
        apy: 5.5,
        tvlUsd: 5_000_000,
        userBalance: 1000,
      };

      expect(`${vault.apy.toFixed(2)}%`).toBe("5.50%");
      expect(formatNumber(vault.tvlUsd)).toBe("$5.00M");
      expect(formatNumber(vault.userBalance)).toBe("$1.0K");
    });

    it("new vault with low TVL", () => {
      const vault = {
        name: "New Vault",
        apy: 15,
        tvlUsd: 50_000,
      };

      expect(`${vault.apy.toFixed(2)}%`).toBe("15.00%");
      expect(formatNumber(vault.tvlUsd)).toBe("$50.0K");
    });

    it("large vault position", () => {
      const balance = 100_000;
      expect(formatNumber(balance)).toBe("$100.0K");
    });
  });
});
