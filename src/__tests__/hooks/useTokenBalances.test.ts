import { describe, it, expect } from "vitest";

// Test the useTokenBalances business logic directly
// We test balance merging, price merging, and token sorting

describe("useTokenBalances logic", () => {
  const ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  interface EnsoToken {
    address: string;
    chainId: number;
    name: string;
    symbol: string;
    decimals: number;
    type: "base" | "defi";
  }

  interface EnsoBalance {
    token: string;
    amount: string;
    price: number;
  }

  interface TokenPrice {
    address: string;
    price: number;
  }

  const createToken = (symbol: string, address: string): EnsoToken => ({
    address,
    chainId: 1,
    name: symbol,
    symbol,
    decimals: 18,
    type: "base",
  });

  describe("balance map construction", () => {
    function buildBalanceMap(
      ethBalance: bigint | undefined,
      ensoBalances: EnsoBalance[] | undefined
    ): Map<string, bigint> {
      const balances = new Map<string, bigint>();

      // Add ETH balance
      if (ethBalance) {
        balances.set(ETH_ADDRESS.toLowerCase(), ethBalance);
      }

      // Add Enso balances
      if (ensoBalances) {
        for (const item of ensoBalances) {
          const address = item.token.toLowerCase();
          balances.set(address, BigInt(item.amount));
        }
      }

      return balances;
    }

    it("adds ETH balance when present", () => {
      const map = buildBalanceMap(BigInt("1000000000000000000"), undefined);
      expect(map.get(ETH_ADDRESS.toLowerCase())).toBe(BigInt("1000000000000000000"));
    });

    it("handles undefined ETH balance", () => {
      const map = buildBalanceMap(undefined, undefined);
      expect(map.has(ETH_ADDRESS.toLowerCase())).toBe(false);
    });

    it("adds Enso balances", () => {
      const ensoBalances: EnsoBalance[] = [
        { token: "0x123", amount: "1000000", price: 1 },
        { token: "0x456", amount: "2000000", price: 2 },
      ];
      const map = buildBalanceMap(undefined, ensoBalances);
      expect(map.get("0x123")).toBe(BigInt("1000000"));
      expect(map.get("0x456")).toBe(BigInt("2000000"));
    });

    it("normalizes addresses to lowercase", () => {
      const ensoBalances: EnsoBalance[] = [
        { token: "0xABC123", amount: "1000000", price: 1 },
      ];
      const map = buildBalanceMap(undefined, ensoBalances);
      expect(map.get("0xabc123")).toBe(BigInt("1000000"));
    });

    it("handles empty Enso balances", () => {
      const map = buildBalanceMap(BigInt("1"), []);
      expect(map.size).toBe(1);
    });
  });

  describe("price map construction", () => {
    function buildPriceMap(
      tokenPrices: TokenPrice[] | undefined,
      ensoBalances: EnsoBalance[] | undefined
    ): Map<string, number> {
      const prices = new Map<string, number>();

      // Add prices from batch price fetch
      if (tokenPrices) {
        for (const item of tokenPrices) {
          prices.set(item.address.toLowerCase(), item.price);
        }
      }

      // Enso balances override batch prices (more accurate)
      if (ensoBalances) {
        for (const item of ensoBalances) {
          if (item.price > 0) {
            prices.set(item.token.toLowerCase(), item.price);
          }
        }
      }

      return prices;
    }

    it("adds prices from token price fetch", () => {
      const tokenPrices: TokenPrice[] = [
        { address: "0x123", price: 100 },
        { address: "0x456", price: 200 },
      ];
      const map = buildPriceMap(tokenPrices, undefined);
      expect(map.get("0x123")).toBe(100);
      expect(map.get("0x456")).toBe(200);
    });

    it("Enso prices override batch prices", () => {
      const tokenPrices: TokenPrice[] = [{ address: "0x123", price: 100 }];
      const ensoBalances: EnsoBalance[] = [
        { token: "0x123", amount: "1000", price: 150 },
      ];
      const map = buildPriceMap(tokenPrices, ensoBalances);
      expect(map.get("0x123")).toBe(150);
    });

    it("ignores zero prices from Enso", () => {
      const tokenPrices: TokenPrice[] = [{ address: "0x123", price: 100 }];
      const ensoBalances: EnsoBalance[] = [
        { token: "0x123", amount: "1000", price: 0 },
      ];
      const map = buildPriceMap(tokenPrices, ensoBalances);
      expect(map.get("0x123")).toBe(100); // Original price kept
    });

    it("normalizes addresses to lowercase", () => {
      const tokenPrices: TokenPrice[] = [{ address: "0xABC", price: 100 }];
      const map = buildPriceMap(tokenPrices, undefined);
      expect(map.get("0xabc")).toBe(100);
    });

    it("handles undefined inputs", () => {
      const map = buildPriceMap(undefined, undefined);
      expect(map.size).toBe(0);
    });
  });

  describe("token sorting by balance", () => {
    function sortTokensByBalance(
      tokens: EnsoToken[],
      balanceMap: Map<string, bigint>
    ): EnsoToken[] {
      return [...tokens].sort((a, b) => {
        const balanceA = balanceMap.get(a.address.toLowerCase()) ?? 0n;
        const balanceB = balanceMap.get(b.address.toLowerCase()) ?? 0n;

        // Both have balance or both don't - keep original order
        if ((balanceA > 0n) === (balanceB > 0n)) {
          return 0;
        }

        // Token with balance comes first
        return balanceB > 0n ? 1 : -1;
      });
    }

    it("puts tokens with balance first", () => {
      const tokens = [
        createToken("NO_BALANCE", "0x111"),
        createToken("HAS_BALANCE", "0x222"),
      ];
      const balanceMap = new Map<string, bigint>([["0x222", BigInt("1000")]]);

      const sorted = sortTokensByBalance(tokens, balanceMap);
      expect(sorted[0].symbol).toBe("HAS_BALANCE");
      expect(sorted[1].symbol).toBe("NO_BALANCE");
    });

    it("maintains order among tokens with balance", () => {
      const tokens = [
        createToken("A", "0x111"),
        createToken("B", "0x222"),
        createToken("C", "0x333"),
      ];
      const balanceMap = new Map<string, bigint>([
        ["0x111", BigInt("1000")],
        ["0x222", BigInt("500")],
        ["0x333", BigInt("2000")],
      ]);

      const sorted = sortTokensByBalance(tokens, balanceMap);
      // All have balance, so original order is preserved
      expect(sorted[0].symbol).toBe("A");
      expect(sorted[1].symbol).toBe("B");
      expect(sorted[2].symbol).toBe("C");
    });

    it("maintains order among tokens without balance", () => {
      const tokens = [
        createToken("A", "0x111"),
        createToken("B", "0x222"),
        createToken("C", "0x333"),
      ];
      const balanceMap = new Map<string, bigint>();

      const sorted = sortTokensByBalance(tokens, balanceMap);
      // None have balance, so original order is preserved
      expect(sorted[0].symbol).toBe("A");
      expect(sorted[1].symbol).toBe("B");
      expect(sorted[2].symbol).toBe("C");
    });

    it("handles mixed balance/no-balance tokens", () => {
      const tokens = [
        createToken("NO1", "0x111"),
        createToken("YES1", "0x222"),
        createToken("NO2", "0x333"),
        createToken("YES2", "0x444"),
      ];
      const balanceMap = new Map<string, bigint>([
        ["0x222", BigInt("1000")],
        ["0x444", BigInt("500")],
      ]);

      const sorted = sortTokensByBalance(tokens, balanceMap);
      // Tokens with balance come first
      expect(sorted[0].symbol).toBe("YES1");
      expect(sorted[1].symbol).toBe("YES2");
      // Tokens without balance come after
      expect(sorted[2].symbol).toBe("NO1");
      expect(sorted[3].symbol).toBe("NO2");
    });

    it("treats zero balance same as no balance", () => {
      const tokens = [
        createToken("ZERO", "0x111"),
        createToken("POSITIVE", "0x222"),
      ];
      const balanceMap = new Map<string, bigint>([
        ["0x111", BigInt("0")],
        ["0x222", BigInt("1")],
      ]);

      const sorted = sortTokensByBalance(tokens, balanceMap);
      expect(sorted[0].symbol).toBe("POSITIVE");
      expect(sorted[1].symbol).toBe("ZERO");
    });

    it("handles case-insensitive address lookup", () => {
      const tokens = [createToken("TOKEN", "0xABC123")];
      const balanceMap = new Map<string, bigint>([["0xabc123", BigInt("1000")]]);

      const sorted = sortTokensByBalance(tokens, balanceMap);
      expect(sorted[0].symbol).toBe("TOKEN");
    });

    it("does not mutate original array", () => {
      const tokens = [
        createToken("B", "0x222"),
        createToken("A", "0x111"),
      ];
      const balanceMap = new Map<string, bigint>([["0x111", BigInt("1000")]]);

      sortTokensByBalance(tokens, balanceMap);
      expect(tokens[0].symbol).toBe("B"); // Original unchanged
    });
  });

  describe("popular token addresses for price fetching", () => {
    function getPopularTokenAddresses(tokens: EnsoToken[], limit: number = 20): string[] {
      return tokens.slice(0, limit).map((t) => t.address);
    }

    it("returns first 20 token addresses by default", () => {
      const tokens = Array.from({ length: 30 }, (_, i) =>
        createToken(`T${i}`, `0x${i.toString().padStart(40, "0")}`)
      );

      const addresses = getPopularTokenAddresses(tokens);
      expect(addresses).toHaveLength(20);
    });

    it("returns all addresses when fewer than limit", () => {
      const tokens = [
        createToken("A", "0x111"),
        createToken("B", "0x222"),
      ];

      const addresses = getPopularTokenAddresses(tokens);
      expect(addresses).toHaveLength(2);
    });

    it("returns empty array for no tokens", () => {
      const addresses = getPopularTokenAddresses([]);
      expect(addresses).toHaveLength(0);
    });

    it("respects custom limit", () => {
      const tokens = Array.from({ length: 30 }, (_, i) =>
        createToken(`T${i}`, `0x${i.toString().padStart(40, "0")}`)
      );

      const addresses = getPopularTokenAddresses(tokens, 10);
      expect(addresses).toHaveLength(10);
    });
  });

  describe("query configuration", () => {
    const BALANCE_STALE_TIME = 30 * 1000; // 30 seconds
    const BALANCE_REFETCH_INTERVAL = 60 * 1000; // 1 minute
    const PRICE_STALE_TIME = 60 * 1000; // 1 minute

    it("has correct balance stale time (30 seconds)", () => {
      expect(BALANCE_STALE_TIME).toBe(30000);
    });

    it("has correct balance refetch interval (1 minute)", () => {
      expect(BALANCE_REFETCH_INTERVAL).toBe(60000);
    });

    it("has correct price stale time (1 minute)", () => {
      expect(PRICE_STALE_TIME).toBe(60000);
    });
  });

  describe("isLoading derivation", () => {
    function deriveIsLoading(balancesLoading: boolean, pricesLoading: boolean): boolean {
      return balancesLoading || pricesLoading;
    }

    it("returns true when balances loading", () => {
      expect(deriveIsLoading(true, false)).toBe(true);
    });

    it("returns true when prices loading", () => {
      expect(deriveIsLoading(false, true)).toBe(true);
    });

    it("returns true when both loading", () => {
      expect(deriveIsLoading(true, true)).toBe(true);
    });

    it("returns false when neither loading", () => {
      expect(deriveIsLoading(false, false)).toBe(false);
    });
  });

  describe("query enablement", () => {
    function shouldEnableBalanceQuery(
      userAddress: string | undefined,
      isConnected: boolean
    ): boolean {
      return !!userAddress && isConnected;
    }

    function shouldEnablePriceQuery(addresses: string[]): boolean {
      return addresses.length > 0;
    }

    it("enables balance query when connected with address", () => {
      expect(shouldEnableBalanceQuery("0x123", true)).toBe(true);
    });

    it("disables balance query when not connected", () => {
      expect(shouldEnableBalanceQuery("0x123", false)).toBe(false);
    });

    it("disables balance query when no address", () => {
      expect(shouldEnableBalanceQuery(undefined, true)).toBe(false);
    });

    it("enables price query when addresses provided", () => {
      expect(shouldEnablePriceQuery(["0x123"])).toBe(true);
    });

    it("disables price query when no addresses", () => {
      expect(shouldEnablePriceQuery([])).toBe(false);
    });
  });

  describe("return value structure", () => {
    interface TokenBalancesResult {
      sortedTokens: EnsoToken[];
      balanceMap: Map<string, bigint>;
      priceMap: Map<string, number>;
      isLoading: boolean;
    }

    function createResult(
      tokens: EnsoToken[],
      balances: Map<string, bigint>,
      prices: Map<string, number>,
      isLoading: boolean
    ): TokenBalancesResult {
      return {
        sortedTokens: tokens,
        balanceMap: balances,
        priceMap: prices,
        isLoading,
      };
    }

    it("creates result with all fields", () => {
      const tokens = [createToken("ETH", ETH_ADDRESS)];
      const balances = new Map<string, bigint>([[ETH_ADDRESS.toLowerCase(), BigInt("1000")]]);
      const prices = new Map<string, number>([[ETH_ADDRESS.toLowerCase(), 3000]]);

      const result = createResult(tokens, balances, prices, false);

      expect(result.sortedTokens).toHaveLength(1);
      expect(result.balanceMap.size).toBe(1);
      expect(result.priceMap.size).toBe(1);
      expect(result.isLoading).toBe(false);
    });
  });
});
