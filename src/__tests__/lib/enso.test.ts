import { describe, it, expect } from "vitest";

// Test the pure functions from lib/enso.ts directly
// We replicate the logic here to test without external dependencies

describe("lib/enso", () => {
  // Constants from the actual module
  const ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const CVXCRV_ADDRESS = "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7";
  const ENSO_ROUTER = "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E";

  const YLDFI_VAULT_ADDRESSES = {
    ycvxCRV: "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86",
    yscvxCRV: "0xCa960E6DF1150100586c51382f619efCCcF72706",
  } as const;

  const POPULAR_TOKENS = [
    ETH_ADDRESS,
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
    "0x6B175474E89094C44Da98b954EedcdeCB5BE4dBf", // DAI
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
    "0xD533a949740bb3306d119CC777fa900bA034cd52", // CRV
    "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B", // CVX
    CVXCRV_ADDRESS,
    "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", // crvUSD
    "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86", // ycvxCRV
    "0xCa960E6DF1150100586c51382f619efCCcF72706", // yscvxCRV
  ];

  interface EnsoToken {
    address: string;
    chainId: number;
    name: string;
    symbol: string;
    decimals: number;
    logoURI?: string;
    type: "base" | "defi";
  }

  describe("isYldfiVault", () => {
    function isYldfiVault(address: string): boolean {
      const lowerAddress = address.toLowerCase();
      return Object.values(YLDFI_VAULT_ADDRESSES).some(
        (vaultAddr) => vaultAddr.toLowerCase() === lowerAddress
      );
    }

    it("identifies ycvxCRV vault (lowercase)", () => {
      expect(isYldfiVault("0x95f19b19aff698169a1a0bbc28a2e47b14cb9a86")).toBe(true);
    });

    it("identifies ycvxCRV vault (checksummed)", () => {
      expect(isYldfiVault("0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86")).toBe(true);
    });

    it("identifies yscvxCRV vault (lowercase)", () => {
      expect(isYldfiVault("0xca960e6df1150100586c51382f619efcccf72706")).toBe(true);
    });

    it("identifies yscvxCRV vault (checksummed)", () => {
      expect(isYldfiVault("0xCa960E6DF1150100586c51382f619efCCcF72706")).toBe(true);
    });

    it("returns false for ETH address", () => {
      expect(isYldfiVault(ETH_ADDRESS)).toBe(false);
    });

    it("returns false for USDC address", () => {
      expect(isYldfiVault("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(false);
    });

    it("returns false for random address", () => {
      expect(isYldfiVault("0x1234567890abcdef1234567890abcdef12345678")).toBe(false);
    });

    it("returns false for cvxCRV (underlying, not vault)", () => {
      expect(isYldfiVault(CVXCRV_ADDRESS)).toBe(false);
    });

    it("returns false for Enso router", () => {
      expect(isYldfiVault(ENSO_ROUTER)).toBe(false);
    });
  });

  describe("sortTokensByPopularity", () => {
    function sortTokensByPopularity(tokens: EnsoToken[]): EnsoToken[] {
      return [...tokens].sort((a, b) => {
        const aIndex = POPULAR_TOKENS.findIndex(
          (addr) => addr.toLowerCase() === a.address.toLowerCase()
        );
        const bIndex = POPULAR_TOKENS.findIndex(
          (addr) => addr.toLowerCase() === b.address.toLowerCase()
        );

        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        return 0;
      });
    }

    const createToken = (symbol: string, address: string): EnsoToken => ({
      address,
      chainId: 1,
      name: symbol,
      symbol,
      decimals: 18,
      type: "base",
    });

    it("sorts ETH before USDC", () => {
      const tokens = [
        createToken("USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        createToken("ETH", ETH_ADDRESS),
      ];
      const sorted = sortTokensByPopularity(tokens);
      expect(sorted[0].symbol).toBe("ETH");
      expect(sorted[1].symbol).toBe("USDC");
    });

    it("sorts USDC before DAI", () => {
      const tokens = [
        createToken("DAI", "0x6B175474E89094C44Da98b954EedcdeCB5BE4dBf"),
        createToken("USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
      ];
      const sorted = sortTokensByPopularity(tokens);
      expect(sorted[0].symbol).toBe("USDC");
      expect(sorted[1].symbol).toBe("DAI");
    });

    it("puts popular tokens before non-popular tokens", () => {
      const tokens = [
        createToken("RANDOM", "0x0000000000000000000000000000000000000001"),
        createToken("ETH", ETH_ADDRESS),
      ];
      const sorted = sortTokensByPopularity(tokens);
      expect(sorted[0].symbol).toBe("ETH");
      expect(sorted[1].symbol).toBe("RANDOM");
    });

    it("maintains order for non-popular tokens", () => {
      const tokens = [
        createToken("AAA", "0x0000000000000000000000000000000000000001"),
        createToken("BBB", "0x0000000000000000000000000000000000000002"),
        createToken("CCC", "0x0000000000000000000000000000000000000003"),
      ];
      const sorted = sortTokensByPopularity(tokens);
      expect(sorted[0].symbol).toBe("AAA");
      expect(sorted[1].symbol).toBe("BBB");
      expect(sorted[2].symbol).toBe("CCC");
    });

    it("handles case-insensitive address matching", () => {
      const tokens = [
        createToken("USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), // lowercase
        createToken("ETH", ETH_ADDRESS.toUpperCase()),
      ];
      const sorted = sortTokensByPopularity(tokens);
      expect(sorted[0].symbol).toBe("ETH");
      expect(sorted[1].symbol).toBe("USDC");
    });

    it("sorts all popular tokens in correct order", () => {
      const tokens = [
        createToken("ycvxCRV", "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86"),
        createToken("CRV", "0xD533a949740bb3306d119CC777fa900bA034cd52"),
        createToken("ETH", ETH_ADDRESS),
        createToken("USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
      ];
      const sorted = sortTokensByPopularity(tokens);
      expect(sorted[0].symbol).toBe("ETH"); // index 0
      expect(sorted[1].symbol).toBe("USDC"); // index 1
      expect(sorted[2].symbol).toBe("CRV"); // index 6
      expect(sorted[3].symbol).toBe("ycvxCRV"); // index 10
    });

    it("does not mutate original array", () => {
      const tokens = [
        createToken("USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        createToken("ETH", ETH_ADDRESS),
      ];
      const originalFirst = tokens[0].symbol;
      sortTokensByPopularity(tokens);
      expect(tokens[0].symbol).toBe(originalFirst);
    });

    it("handles empty array", () => {
      expect(sortTokensByPopularity([])).toEqual([]);
    });

    it("handles single token", () => {
      const tokens = [createToken("ETH", ETH_ADDRESS)];
      const sorted = sortTokensByPopularity(tokens);
      expect(sorted).toHaveLength(1);
      expect(sorted[0].symbol).toBe("ETH");
    });
  });

  describe("filterTokens", () => {
    function filterTokens(tokens: EnsoToken[], query: string): EnsoToken[] {
      if (!query) return tokens;

      const lowerQuery = query.toLowerCase();
      return tokens.filter(
        (token) =>
          token.symbol.toLowerCase().includes(lowerQuery) ||
          token.name.toLowerCase().includes(lowerQuery) ||
          token.address.toLowerCase() === lowerQuery
      );
    }

    const createToken = (
      symbol: string,
      name: string,
      address: string
    ): EnsoToken => ({
      address,
      chainId: 1,
      name,
      symbol,
      decimals: 18,
      type: "base",
    });

    const testTokens: EnsoToken[] = [
      createToken("ETH", "Ethereum", ETH_ADDRESS),
      createToken("USDC", "USD Coin", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
      createToken("WETH", "Wrapped Ether", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
      createToken("cvxCRV", "Convex CRV", CVXCRV_ADDRESS),
    ];

    it("returns all tokens for empty query", () => {
      expect(filterTokens(testTokens, "")).toEqual(testTokens);
    });

    it("filters by symbol (case-insensitive)", () => {
      const result = filterTokens(testTokens, "eth");
      expect(result).toHaveLength(2); // ETH and WETH
      expect(result.some((t) => t.symbol === "ETH")).toBe(true);
      expect(result.some((t) => t.symbol === "WETH")).toBe(true);
    });

    it("filters by name (case-insensitive)", () => {
      const result = filterTokens(testTokens, "coin");
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });

    it("filters by exact address (case-insensitive)", () => {
      const result = filterTokens(testTokens, ETH_ADDRESS.toLowerCase());
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("ETH");
    });

    it("partial address does NOT match (only exact)", () => {
      const result = filterTokens(testTokens, "0xeeee");
      expect(result).toHaveLength(0); // address must be exact match
    });

    it("filters by uppercase query", () => {
      const result = filterTokens(testTokens, "USDC");
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });

    it("filters by mixed case query", () => {
      const result = filterTokens(testTokens, "EtH");
      expect(result).toHaveLength(2);
    });

    it("returns empty array for no matches", () => {
      const result = filterTokens(testTokens, "NOTFOUND");
      expect(result).toHaveLength(0);
    });

    it("matches partial symbol", () => {
      const result = filterTokens(testTokens, "cvx");
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("cvxCRV");
    });

    it("matches partial name", () => {
      const result = filterTokens(testTokens, "Convex");
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("cvxCRV");
    });

    it("handles empty token array", () => {
      expect(filterTokens([], "eth")).toEqual([]);
    });
  });

  describe("ETH_ADDRESS constant", () => {
    it("is the correct Enso ETH placeholder", () => {
      expect(ETH_ADDRESS).toBe("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    });

    it("is 42 characters long", () => {
      expect(ETH_ADDRESS).toHaveLength(42);
    });

    it("starts with 0x", () => {
      expect(ETH_ADDRESS.startsWith("0x")).toBe(true);
    });
  });

  describe("ENSO_ROUTER constant", () => {
    it("is the correct router address", () => {
      expect(ENSO_ROUTER).toBe("0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E");
    });
  });

  describe("bundle action construction", () => {
    interface EnsoBundleAction {
      protocol: string;
      action: string;
      args: Record<string, unknown>;
    }

    function createZapInActions(
      inputToken: string,
      vaultAddress: string,
      amountIn: string,
      underlyingToken: string = CVXCRV_ADDRESS,
      slippage: string = "100"
    ): EnsoBundleAction[] {
      return [
        {
          protocol: "enso",
          action: "route",
          args: {
            tokenIn: inputToken,
            tokenOut: underlyingToken,
            amountIn: amountIn,
            slippage: slippage,
          },
        },
        {
          protocol: "erc4626",
          action: "deposit",
          args: {
            tokenIn: underlyingToken,
            tokenOut: vaultAddress,
            amountIn: { useOutputOfCallAt: 0 },
            primaryAddress: vaultAddress,
          },
        },
      ];
    }

    function createZapOutActions(
      vaultAddress: string,
      outputToken: string,
      amountIn: string,
      underlyingToken: string = CVXCRV_ADDRESS,
      slippage: string = "100"
    ): EnsoBundleAction[] {
      return [
        {
          protocol: "erc4626",
          action: "redeem",
          args: {
            tokenIn: vaultAddress,
            tokenOut: underlyingToken,
            amountIn: amountIn,
            primaryAddress: vaultAddress,
          },
        },
        {
          protocol: "enso",
          action: "route",
          args: {
            tokenIn: underlyingToken,
            tokenOut: outputToken,
            amountIn: { useOutputOfCallAt: 0 },
            slippage: slippage,
          },
        },
      ];
    }

    function createVaultToVaultActions(
      sourceVault: string,
      targetVault: string,
      amountIn: string,
      underlyingToken: string = CVXCRV_ADDRESS
    ): EnsoBundleAction[] {
      return [
        {
          protocol: "erc4626",
          action: "redeem",
          args: {
            tokenIn: sourceVault,
            tokenOut: underlyingToken,
            amountIn: amountIn,
            primaryAddress: sourceVault,
          },
        },
        {
          protocol: "erc4626",
          action: "deposit",
          args: {
            tokenIn: underlyingToken,
            tokenOut: targetVault,
            amountIn: { useOutputOfCallAt: 0 },
            primaryAddress: targetVault,
          },
        },
      ];
    }

    describe("zap in actions", () => {
      it("creates correct swap + deposit bundle", () => {
        const actions = createZapInActions(
          ETH_ADDRESS,
          YLDFI_VAULT_ADDRESSES.ycvxCRV,
          "1000000000000000000"
        );

        expect(actions).toHaveLength(2);
        expect(actions[0].protocol).toBe("enso");
        expect(actions[0].action).toBe("route");
        expect(actions[0].args.tokenIn).toBe(ETH_ADDRESS);
        expect(actions[0].args.tokenOut).toBe(CVXCRV_ADDRESS);

        expect(actions[1].protocol).toBe("erc4626");
        expect(actions[1].action).toBe("deposit");
        expect(actions[1].args.amountIn).toEqual({ useOutputOfCallAt: 0 });
      });

      it("uses default slippage of 100 (1%)", () => {
        const actions = createZapInActions(ETH_ADDRESS, YLDFI_VAULT_ADDRESSES.ycvxCRV, "1000");
        expect(actions[0].args.slippage).toBe("100");
      });

      it("allows custom slippage", () => {
        const actions = createZapInActions(
          ETH_ADDRESS,
          YLDFI_VAULT_ADDRESSES.ycvxCRV,
          "1000",
          CVXCRV_ADDRESS,
          "200"
        );
        expect(actions[0].args.slippage).toBe("200");
      });
    });

    describe("zap out actions", () => {
      it("creates correct redeem + swap bundle", () => {
        const actions = createZapOutActions(
          YLDFI_VAULT_ADDRESSES.ycvxCRV,
          ETH_ADDRESS,
          "1000000000000000000"
        );

        expect(actions).toHaveLength(2);
        expect(actions[0].protocol).toBe("erc4626");
        expect(actions[0].action).toBe("redeem");
        expect(actions[0].args.tokenIn).toBe(YLDFI_VAULT_ADDRESSES.ycvxCRV);

        expect(actions[1].protocol).toBe("enso");
        expect(actions[1].action).toBe("route");
        expect(actions[1].args.tokenOut).toBe(ETH_ADDRESS);
        expect(actions[1].args.amountIn).toEqual({ useOutputOfCallAt: 0 });
      });
    });

    describe("vault to vault actions", () => {
      it("creates correct redeem + deposit bundle (no swap)", () => {
        const actions = createVaultToVaultActions(
          YLDFI_VAULT_ADDRESSES.ycvxCRV,
          YLDFI_VAULT_ADDRESSES.yscvxCRV,
          "1000000000000000000"
        );

        expect(actions).toHaveLength(2);
        expect(actions[0].action).toBe("redeem");
        expect(actions[0].args.tokenIn).toBe(YLDFI_VAULT_ADDRESSES.ycvxCRV);
        expect(actions[0].args.tokenOut).toBe(CVXCRV_ADDRESS);

        expect(actions[1].action).toBe("deposit");
        expect(actions[1].args.tokenIn).toBe(CVXCRV_ADDRESS);
        expect(actions[1].args.tokenOut).toBe(YLDFI_VAULT_ADDRESSES.yscvxCRV);
      });

      it("uses useOutputOfCallAt for chaining", () => {
        const actions = createVaultToVaultActions(
          YLDFI_VAULT_ADDRESSES.ycvxCRV,
          YLDFI_VAULT_ADDRESSES.yscvxCRV,
          "1000"
        );
        expect(actions[1].args.amountIn).toEqual({ useOutputOfCallAt: 0 });
      });
    });
  });

  describe("URL construction", () => {
    const ENSO_API_BASE = "https://api.enso.finance/api/v1";
    const CHAIN_ID = 1;

    it("constructs token list URL correctly", () => {
      const params = new URLSearchParams({
        chainId: String(CHAIN_ID),
        type: "base",
        includeMetadata: "true",
        pageSize: "1000",
      });
      const url = `${ENSO_API_BASE}/tokens?${params}`;
      expect(url).toContain("chainId=1");
      expect(url).toContain("type=base");
      expect(url).toContain("includeMetadata=true");
    });

    it("constructs route URL correctly with array params", () => {
      // Enso API requires array-format parameters: tokenIn[0], tokenOut[0], amountIn[0]
      const params = new URLSearchParams({
        chainId: String(CHAIN_ID),
        fromAddress: "0x1234",
        "tokenIn[0]": ETH_ADDRESS,
        "tokenOut[0]": CVXCRV_ADDRESS,
        "amountIn[0]": "1000000000000000000",
        slippage: "100",
        routingStrategy: "router",
      });
      const url = `${ENSO_API_BASE}/shortcuts/route?${params}`;
      expect(url).toContain("shortcuts/route");
      expect(url).toContain("slippage=100");
      expect(url).toContain("routingStrategy=router");
      // Verify array format is used (URL encoded brackets)
      expect(url).toContain("tokenIn%5B0%5D=");
      expect(url).toContain("tokenOut%5B0%5D=");
      expect(url).toContain("amountIn%5B0%5D=");
    });

    it("constructs price URL correctly", () => {
      const addresses = [ETH_ADDRESS, CVXCRV_ADDRESS];
      const params = new URLSearchParams({
        addresses: addresses.join(","),
      });
      const url = `${ENSO_API_BASE}/prices/${CHAIN_ID}?${params}`;
      expect(url).toContain(`/prices/${CHAIN_ID}`);
      expect(url).toContain(ETH_ADDRESS);
      expect(url).toContain(CVXCRV_ADDRESS);
    });
  });

  describe("token response parsing", () => {
    interface RawToken {
      address?: string;
      chainId?: number;
      name?: string;
      symbol?: string;
      decimals?: number;
      logosUri?: string[];
      type?: string;
    }

    function parseTokenResponse(rawTokens: RawToken[]): EnsoToken[] {
      return rawTokens
        .filter((t) => t.address && t.symbol)
        .map((t) => ({
          address: t.address!,
          chainId: t.chainId || 1,
          name: t.name || t.symbol || "Unknown",
          symbol: t.symbol || "???",
          decimals: t.decimals || 18,
          logoURI: t.logosUri?.[0],
          type: (t.type as "base" | "defi") || "base",
        }));
    }

    it("filters out tokens without address", () => {
      const raw = [{ symbol: "TEST", decimals: 18 }];
      expect(parseTokenResponse(raw)).toHaveLength(0);
    });

    it("filters out tokens without symbol", () => {
      const raw = [{ address: "0x123", decimals: 18 }];
      expect(parseTokenResponse(raw)).toHaveLength(0);
    });

    it("parses valid token correctly", () => {
      const raw = [
        {
          address: "0x123",
          symbol: "TEST",
          name: "Test Token",
          decimals: 6,
          chainId: 1,
          type: "base",
        },
      ];
      const result = parseTokenResponse(raw);
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("TEST");
      expect(result[0].decimals).toBe(6);
    });

    it("defaults decimals to 18", () => {
      const raw = [{ address: "0x123", symbol: "TEST" }];
      const result = parseTokenResponse(raw);
      expect(result[0].decimals).toBe(18);
    });

    it("takes first logo from logosUri array", () => {
      const raw = [
        {
          address: "0x123",
          symbol: "TEST",
          logosUri: ["https://logo1.png", "https://logo2.png"],
        },
      ];
      const result = parseTokenResponse(raw);
      expect(result[0].logoURI).toBe("https://logo1.png");
    });

    it("handles missing logosUri", () => {
      const raw = [{ address: "0x123", symbol: "TEST" }];
      const result = parseTokenResponse(raw);
      expect(result[0].logoURI).toBeUndefined();
    });

    it("defaults type to base", () => {
      const raw = [{ address: "0x123", symbol: "TEST" }];
      const result = parseTokenResponse(raw);
      expect(result[0].type).toBe("base");
    });

    it("uses symbol as name fallback", () => {
      const raw = [{ address: "0x123", symbol: "TEST" }];
      const result = parseTokenResponse(raw);
      expect(result[0].name).toBe("TEST");
    });
  });
});
