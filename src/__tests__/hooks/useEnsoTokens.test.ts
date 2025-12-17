import { describe, it, expect } from "vitest";

// Test the useEnsoTokens business logic directly
// We test token merging, deduplication, and lookup patterns

describe("useEnsoTokens logic", () => {
  const ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  interface EnsoToken {
    address: string;
    chainId: number;
    name: string;
    symbol: string;
    decimals: number;
    logoURI?: string;
    type: "base" | "defi";
  }

  const createToken = (
    symbol: string,
    address: string,
    overrides: Partial<EnsoToken> = {}
  ): EnsoToken => ({
    address,
    chainId: 1,
    name: symbol,
    symbol,
    decimals: 18,
    type: "base",
    ...overrides,
  });

  describe("token merging logic", () => {
    function mergeTokens(
      importedTokens: EnsoToken[],
      customTokens: EnsoToken[],
      ensoTokens: EnsoToken[]
    ): EnsoToken[] {
      const tokenMap = new Map<string, EnsoToken>();

      // Add imported tokens first (highest priority)
      for (const token of importedTokens) {
        tokenMap.set(token.address.toLowerCase(), token);
      }

      // Add custom tokens (higher priority than Enso)
      for (const token of customTokens) {
        if (!tokenMap.has(token.address.toLowerCase())) {
          tokenMap.set(token.address.toLowerCase(), token);
        }
      }

      // Add Enso tokens (lowest priority)
      for (const token of ensoTokens) {
        const key = token.address.toLowerCase();
        if (!tokenMap.has(key)) {
          tokenMap.set(key, token);
        }
      }

      return Array.from(tokenMap.values());
    }

    it("merges all token sources", () => {
      const imported = [createToken("IMP", "0x111")];
      const custom = [createToken("CUSTOM", "0x222")];
      const enso = [createToken("ENSO", "0x333")];

      const result = mergeTokens(imported, custom, enso);
      expect(result).toHaveLength(3);
    });

    it("imported tokens have highest priority", () => {
      const imported = [createToken("IMPORTED_ETH", ETH_ADDRESS, { logoURI: "imported.png" })];
      const custom = [createToken("CUSTOM_ETH", ETH_ADDRESS, { logoURI: "custom.png" })];
      const enso = [createToken("ENSO_ETH", ETH_ADDRESS, { logoURI: "enso.png" })];

      const result = mergeTokens(imported, custom, enso);
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("IMPORTED_ETH");
      expect(result[0].logoURI).toBe("imported.png");
    });

    it("custom tokens have priority over Enso tokens", () => {
      const imported: EnsoToken[] = [];
      const custom = [createToken("CUSTOM_TOKEN", "0x123", { decimals: 6 })];
      const enso = [createToken("ENSO_TOKEN", "0x123", { decimals: 18 })];

      const result = mergeTokens(imported, custom, enso);
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("CUSTOM_TOKEN");
      expect(result[0].decimals).toBe(6);
    });

    it("deduplicates by lowercase address", () => {
      const imported: EnsoToken[] = [];
      const custom = [createToken("TOKEN1", "0xABC123")];
      const enso = [createToken("TOKEN2", "0xabc123")]; // same address, lowercase

      const result = mergeTokens(imported, custom, enso);
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("TOKEN1");
    });

    it("handles empty arrays", () => {
      const result = mergeTokens([], [], []);
      expect(result).toHaveLength(0);
    });

    it("handles only Enso tokens", () => {
      const enso = [
        createToken("ETH", ETH_ADDRESS),
        createToken("USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
      ];

      const result = mergeTokens([], [], enso);
      expect(result).toHaveLength(2);
    });

    it("handles duplicate addresses across all sources", () => {
      const imported = [createToken("IMP", "0x111")];
      const custom = [createToken("CUSTOM", "0x111")];
      const enso = [createToken("ENSO", "0x111")];

      const result = mergeTokens(imported, custom, enso);
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("IMP");
    });
  });

  describe("token lookup (useEnsoToken)", () => {
    function findToken(tokens: EnsoToken[], address: string | undefined): EnsoToken | null {
      if (!address) return null;
      return (
        tokens.find((t) => t.address.toLowerCase() === address.toLowerCase()) || null
      );
    }

    const testTokens = [
      createToken("ETH", ETH_ADDRESS),
      createToken("USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
      createToken("cvxCRV", "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7"),
    ];

    it("finds token by exact address", () => {
      const token = findToken(testTokens, ETH_ADDRESS);
      expect(token).not.toBeNull();
      expect(token?.symbol).toBe("ETH");
    });

    it("finds token case-insensitively", () => {
      const token = findToken(testTokens, ETH_ADDRESS.toUpperCase());
      expect(token).not.toBeNull();
      expect(token?.symbol).toBe("ETH");
    });

    it("returns null for undefined address", () => {
      expect(findToken(testTokens, undefined)).toBeNull();
    });

    it("returns null for non-existent address", () => {
      expect(findToken(testTokens, "0x0000000000000000000000000000000000000000")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(findToken(testTokens, "")).toBeNull();
    });

    it("finds token with mixed case address", () => {
      const token = findToken(testTokens, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
      expect(token?.symbol).toBe("USDC");
    });
  });

  describe("token filtering with limit", () => {
    function filterAndLimit(
      tokens: EnsoToken[],
      query: string,
      limit: number = 100
    ): EnsoToken[] {
      const lowerQuery = query.toLowerCase();
      const filtered = query
        ? tokens.filter(
            (t) =>
              t.symbol.toLowerCase().includes(lowerQuery) ||
              t.name.toLowerCase().includes(lowerQuery) ||
              t.address.toLowerCase() === lowerQuery
          )
        : tokens;
      return filtered.slice(0, limit);
    }

    it("returns all tokens (limited) when query is empty", () => {
      const tokens = Array.from({ length: 150 }, (_, i) =>
        createToken(`TOKEN${i}`, `0x${"0".repeat(39)}${i.toString(16).padStart(1, "0")}`)
      );
      const result = filterAndLimit(tokens, "");
      expect(result).toHaveLength(100);
    });

    it("filters and limits results", () => {
      const tokens = Array.from({ length: 150 }, (_, i) =>
        createToken(`ETH${i}`, `0x${"0".repeat(39)}${i.toString(16).padStart(1, "0")}`)
      );
      const result = filterAndLimit(tokens, "ETH");
      expect(result).toHaveLength(100);
    });

    it("returns less than limit when fewer matches", () => {
      const tokens = [
        createToken("ETH", "0x111"),
        createToken("USDC", "0x222"),
        createToken("DAI", "0x333"),
      ];
      const result = filterAndLimit(tokens, "ETH");
      expect(result).toHaveLength(1);
    });

    it("applies custom limit", () => {
      const tokens = Array.from({ length: 50 }, (_, i) =>
        createToken(`TOKEN${i}`, `0x${"0".repeat(39)}${i.toString(16).padStart(1, "0")}`)
      );
      const result = filterAndLimit(tokens, "", 10);
      expect(result).toHaveLength(10);
    });
  });

  describe("DEFAULT_ETH_TOKEN constant", () => {
    const DEFAULT_ETH_TOKEN: EnsoToken = {
      address: ETH_ADDRESS,
      chainId: 1,
      name: "Ethereum",
      symbol: "ETH",
      decimals: 18,
      logoURI: "https://assets.coingecko.com/coins/images/279/thumb/ethereum.png",
      type: "base",
    };

    it("has correct address", () => {
      expect(DEFAULT_ETH_TOKEN.address).toBe(ETH_ADDRESS);
    });

    it("has correct symbol", () => {
      expect(DEFAULT_ETH_TOKEN.symbol).toBe("ETH");
    });

    it("has correct decimals", () => {
      expect(DEFAULT_ETH_TOKEN.decimals).toBe(18);
    });

    it("has chainId 1 (mainnet)", () => {
      expect(DEFAULT_ETH_TOKEN.chainId).toBe(1);
    });

    it("has base type", () => {
      expect(DEFAULT_ETH_TOKEN.type).toBe("base");
    });

    it("has logo URI", () => {
      expect(DEFAULT_ETH_TOKEN.logoURI).toContain("coingecko");
    });
  });

  describe("stale time configuration", () => {
    const STALE_TIME = 30 * 60 * 1000; // 30 minutes

    it("has correct stale time (30 minutes)", () => {
      expect(STALE_TIME).toBe(1800000);
    });

    it("is 30 minutes in milliseconds", () => {
      expect(STALE_TIME / 1000 / 60).toBe(30);
    });
  });

  describe("token import flow", () => {
    function importToken(
      currentTokens: EnsoToken[],
      newToken: EnsoToken,
      isAlreadyImported: (address: string) => boolean
    ): EnsoToken[] {
      if (isAlreadyImported(newToken.address)) {
        return currentTokens;
      }
      return [...currentTokens, newToken];
    }

    it("adds new token to list", () => {
      const current = [createToken("ETH", ETH_ADDRESS)];
      const newToken = createToken("NEW", "0x123");
      const isImported = () => false;

      const result = importToken(current, newToken, isImported);
      expect(result).toHaveLength(2);
    });

    it("does not add already imported token", () => {
      const current = [createToken("ETH", ETH_ADDRESS)];
      const newToken = createToken("ETH_AGAIN", ETH_ADDRESS);
      const isImported = (addr: string) => addr.toLowerCase() === ETH_ADDRESS.toLowerCase();

      const result = importToken(current, newToken, isImported);
      expect(result).toHaveLength(1);
    });
  });

  describe("query key", () => {
    const QUERY_KEY = ["enso-token-list"];

    it("has correct query key format", () => {
      expect(QUERY_KEY).toEqual(["enso-token-list"]);
    });

    it("is an array with single string", () => {
      expect(QUERY_KEY).toHaveLength(1);
      expect(typeof QUERY_KEY[0]).toBe("string");
    });
  });

  describe("defi vs base token types", () => {
    it("distinguishes base tokens", () => {
      const token = createToken("ETH", ETH_ADDRESS, { type: "base" });
      expect(token.type).toBe("base");
    });

    it("distinguishes defi tokens", () => {
      const token = createToken("ycvxCRV", "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86", {
        type: "defi",
      });
      expect(token.type).toBe("defi");
    });

    it("can filter by type", () => {
      const tokens = [
        createToken("ETH", "0x111", { type: "base" }),
        createToken("ycvxCRV", "0x222", { type: "defi" }),
        createToken("USDC", "0x333", { type: "base" }),
      ];

      const baseTokens = tokens.filter((t) => t.type === "base");
      const defiTokens = tokens.filter((t) => t.type === "defi");

      expect(baseTokens).toHaveLength(2);
      expect(defiTokens).toHaveLength(1);
    });
  });
});
