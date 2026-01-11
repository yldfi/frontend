import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Enso SDK module - must be hoisted before imports
const { mockGetTokenData, mockGetBalances, mockGetMultiplePriceData, mockGetRouteData, mockGetBundleData } = vi.hoisted(() => ({
  mockGetTokenData: vi.fn(),
  mockGetBalances: vi.fn(),
  mockGetMultiplePriceData: vi.fn(),
  mockGetRouteData: vi.fn(),
  mockGetBundleData: vi.fn(),
}));

vi.mock("@ensofinance/sdk", () => {
  return {
    EnsoClient: class MockEnsoClient {
      getTokenData = mockGetTokenData;
      getBalances = mockGetBalances;
      getMultiplePriceData = mockGetMultiplePriceData;
      getRouteData = mockGetRouteData;
      getBundleData = mockGetBundleData;
    },
  };
});

import {
  fetchEnsoTokenList,
  fetchWalletBalances,
  fetchTokenPrices,
  fetchRoute,
  fetchBundle,
  fetchZapInRoute,
  fetchZapOutRoute,
  fetchVaultToVaultRoute,
  sortTokensByPopularity,
  filterTokens,
  isYldfiVault,
  requiresCustomZapRoute,
  getCvgCvxSwapRate,
  getCvgCvxPoolBalances,
  getOptimalCvgCvxRoute,
  getOptimalSwapAmount,
  ETH_ADDRESS,
  CVXCRV_ADDRESS,
  ENSO_ROUTER,
  CUSTOM_TOKENS,
  POPULAR_TOKENS,
  YLDFI_VAULT_ADDRESSES,
} from "@/lib/enso";

// Get mocked fetch (used for RPC calls like getCurveGetDy)
const mockFetch = vi.mocked(globalThis.fetch);

describe("enso.ts integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("exports ETH_ADDRESS", () => {
      expect(ETH_ADDRESS).toBe("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    });

    it("exports CVXCRV_ADDRESS", () => {
      expect(CVXCRV_ADDRESS).toBe("0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7");
    });

    it("exports ENSO_ROUTER", () => {
      expect(ENSO_ROUTER).toBe("0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E");
    });

    it("exports CUSTOM_TOKENS with required tokens", () => {
      expect(CUSTOM_TOKENS.length).toBeGreaterThan(0);
      expect(CUSTOM_TOKENS.find((t) => t.symbol === "ETH")).toBeDefined();
      expect(CUSTOM_TOKENS.find((t) => t.symbol === "cvxCRV")).toBeDefined();
    });

    it("exports POPULAR_TOKENS list", () => {
      expect(POPULAR_TOKENS).toContain(ETH_ADDRESS);
      expect(POPULAR_TOKENS).toContain(CVXCRV_ADDRESS);
    });

    it("exports YLDFI_VAULT_ADDRESSES", () => {
      expect(YLDFI_VAULT_ADDRESSES.ycvxCRV).toBe(
        "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86"
      );
    });
  });

  describe("fetchEnsoTokenList", () => {
    it("fetches and maps token list", async () => {
      // SDK returns { data: [...] }
      mockGetTokenData.mockResolvedValueOnce({
        data: [
          {
            address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            chainId: 1,
            name: "USD Coin",
            symbol: "USDC",
            decimals: 6,
            logosUri: ["https://example.com/usdc.png"],
            type: "base",
          },
        ],
      });

      const tokens = await fetchEnsoTokenList();

      expect(tokens).toHaveLength(1);
      expect(tokens[0].symbol).toBe("USDC");
      expect(tokens[0].decimals).toBe(6);
      expect(tokens[0].logoURI).toBe("https://example.com/usdc.png");
    });

    it("throws error on SDK error", async () => {
      mockGetTokenData.mockRejectedValueOnce(new Error("SDK error"));

      // SDK errors bubble up directly
      await expect(fetchEnsoTokenList()).rejects.toThrow("SDK error");
    });

    it("handles tokens without logoUri", async () => {
      mockGetTokenData.mockResolvedValueOnce({
        data: [
          {
            address: "0x123",
            chainId: 1,
            name: "Test Token",
            symbol: "TEST",
            decimals: 18,
          },
        ],
      });

      const tokens = await fetchEnsoTokenList();

      expect(tokens[0].logoURI).toBeUndefined();
    });

    it("handles empty token list", async () => {
      mockGetTokenData.mockResolvedValueOnce({ data: [] });

      const tokens = await fetchEnsoTokenList();
      expect(tokens).toHaveLength(0);
    });
  });

  describe("fetchWalletBalances", () => {
    it("fetches wallet balances", async () => {
      // SDK returns balances directly
      mockGetBalances.mockResolvedValueOnce([
        {
          token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          amount: "1000000000",
          chainId: 1,
          decimals: 6,
          price: 1.0,
        },
      ]);

      const balances = await fetchWalletBalances("0x1234567890123456789012345678901234567890");

      expect(balances).toHaveLength(1);
      expect(balances[0].token).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    });

    it("throws on SDK error", async () => {
      mockGetBalances.mockRejectedValueOnce(new Error("SDK error"));

      // SDK errors bubble up directly
      await expect(
        fetchWalletBalances("0x1234567890123456789012345678901234567890")
      ).rejects.toThrow("SDK error");
    });
  });

  describe("fetchTokenPrices", () => {
    it("fetches token prices", async () => {
      // SDK returns prices directly
      mockGetMultiplePriceData.mockResolvedValueOnce([
        {
          chainId: 1,
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          price: 1.0,
          decimals: 6,
        },
      ]);

      const prices = await fetchTokenPrices([
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ]);

      expect(prices).toHaveLength(1);
      expect(prices[0].price).toBe(1.0);
    });

    it("returns empty array for empty addresses", async () => {
      const prices = await fetchTokenPrices([]);
      expect(prices).toEqual([]);
      // SDK should not be called for empty addresses
      expect(mockGetMultiplePriceData).not.toHaveBeenCalled();
    });

    it("handles SDK error for token prices", async () => {
      mockGetMultiplePriceData.mockRejectedValueOnce(new Error("SDK error"));

      await expect(
        fetchTokenPrices(["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"])
      ).rejects.toThrow();
    });
  });

  describe("fetchRoute", () => {
    it("fetches optimal route", async () => {
      // SDK returns route data with different structure
      mockGetRouteData.mockResolvedValueOnce({
        amountOut: "1000000",
        gas: "100000",
        tx: {
          to: ENSO_ROUTER,
          data: "0x...",
          value: "0",
        },
        route: [],
      });

      const route = await fetchRoute({
        fromAddress: "0x1234567890123456789012345678901234567890",
        tokenIn: ETH_ADDRESS,
        tokenOut: CVXCRV_ADDRESS,
        amountIn: "1000000000000000000",
      });

      expect(route.amountOut).toBe("1000000");
      expect(route.tx.to).toBe(ENSO_ROUTER);
    });

    it("uses default slippage when not provided", async () => {
      mockGetRouteData.mockResolvedValueOnce({
        amountOut: "1000000",
        tx: { to: ENSO_ROUTER, data: "0x", value: "0" },
        route: [],
      });

      await fetchRoute({
        fromAddress: "0x1234567890123456789012345678901234567890",
        tokenIn: ETH_ADDRESS,
        tokenOut: CVXCRV_ADDRESS,
        amountIn: "1000000000000000000",
      });

      // SDK is called with slippage parameter
      expect(mockGetRouteData).toHaveBeenCalledWith(
        expect.objectContaining({
          slippage: "100", // 1% default
        })
      );
    });

    it("uses custom slippage", async () => {
      mockGetRouteData.mockResolvedValueOnce({
        amountOut: "1000000",
        tx: { to: ENSO_ROUTER, data: "0x", value: "0" },
        route: [],
      });

      await fetchRoute({
        fromAddress: "0x1234567890123456789012345678901234567890",
        tokenIn: ETH_ADDRESS,
        tokenOut: CVXCRV_ADDRESS,
        amountIn: "1000000000000000000",
        slippage: "50", // 0.5%
      });

      expect(mockGetRouteData).toHaveBeenCalledWith(
        expect.objectContaining({
          slippage: "50",
        })
      );
    });

    it("handles SDK error", async () => {
      mockGetRouteData.mockRejectedValueOnce(new Error("No route found"));

      await expect(
        fetchRoute({
          fromAddress: "0x1234567890123456789012345678901234567890",
          tokenIn: ETH_ADDRESS,
          tokenOut: CVXCRV_ADDRESS,
          amountIn: "1000000000000000000",
        })
      ).rejects.toThrow();
    });
  });

  describe("fetchBundle", () => {
    // Helper to create valid SDK bundle response
    const createBundleResponse = (overrides = {}) => ({
      tx: {
        to: ENSO_ROUTER,
        data: "0x...",
        value: 0,
        from: "0x1234567890123456789012345678901234567890",
      },
      gas: 100000,
      amountsOut: { "0xtoken": 1000000 },
      priceImpact: 0.01,
      ...overrides,
    });

    it("bundles multiple actions", async () => {
      mockGetBundleData.mockResolvedValueOnce(createBundleResponse());

      const result = await fetchBundle({
        fromAddress: "0x1234567890123456789012345678901234567890",
        actions: [
          {
            protocol: "erc4626",
            action: "deposit",
            args: {
              tokenIn: CVXCRV_ADDRESS,
              tokenOut: YLDFI_VAULT_ADDRESSES.ycvxCRV,
              amountIn: "1000000000000000000",
              primaryAddress: YLDFI_VAULT_ADDRESSES.ycvxCRV,
            },
          },
        ],
      });

      expect(result.tx.to).toBe(ENSO_ROUTER);
      expect(mockGetBundleData).toHaveBeenCalled();
    });

    it("handles SDK error", async () => {
      mockGetBundleData.mockRejectedValueOnce(new Error("Bundle error"));

      await expect(
        fetchBundle({
          fromAddress: "0x1234567890123456789012345678901234567890",
          actions: [],
        })
      ).rejects.toThrow();
    });
  });

  describe("fetchZapInRoute", () => {
    const createBundleResponse = () => ({
      tx: { to: ENSO_ROUTER, data: "0x", value: 0, from: "0x1234567890123456789012345678901234567890" },
      gas: 100000,
      amountsOut: { "0xtoken": 1000 },
      priceImpact: 0.01,
    });

    it("creates zap in bundle with swap and deposit", async () => {
      mockGetBundleData.mockResolvedValueOnce(createBundleResponse());

      await fetchZapInRoute({
        fromAddress: "0x1234567890123456789012345678901234567890",
        vaultAddress: YLDFI_VAULT_ADDRESSES.ycvxCRV,
        inputToken: ETH_ADDRESS,
        amountIn: "1000000000000000000",
      });

      // Verify SDK was called with actions
      expect(mockGetBundleData).toHaveBeenCalled();
      const [, actions] = mockGetBundleData.mock.calls[0];
      expect(actions).toHaveLength(2);
      expect(actions[0].action).toBe("route");
      expect(actions[1].action).toBe("deposit");
    });
  });

  describe("fetchZapOutRoute", () => {
    const createBundleResponse = () => ({
      tx: { to: ENSO_ROUTER, data: "0x", value: 0, from: "0x1234567890123456789012345678901234567890" },
      gas: 100000,
      amountsOut: { "0xtoken": 1000 },
      priceImpact: 0.01,
    });

    it("creates zap out bundle with redeem and swap", async () => {
      mockGetBundleData.mockResolvedValueOnce(createBundleResponse());

      await fetchZapOutRoute({
        fromAddress: "0x1234567890123456789012345678901234567890",
        vaultAddress: YLDFI_VAULT_ADDRESSES.ycvxCRV,
        outputToken: ETH_ADDRESS,
        amountIn: "1000000000000000000",
      });

      expect(mockGetBundleData).toHaveBeenCalled();
      const [, actions] = mockGetBundleData.mock.calls[0];
      expect(actions).toHaveLength(2);
      expect(actions[0].action).toBe("redeem");
      expect(actions[1].action).toBe("route");
    });
  });

  describe("fetchVaultToVaultRoute", () => {
    const createBundleResponse = () => ({
      tx: { to: ENSO_ROUTER, data: "0x", value: 0, from: "0x1234567890123456789012345678901234567890" },
      gas: 100000,
      amountsOut: { "0xtoken": 1000 },
      priceImpact: 0.01,
    });

    it("creates vault-to-vault bundle with redeem and deposit", async () => {
      mockGetBundleData.mockResolvedValueOnce(createBundleResponse());

      await fetchVaultToVaultRoute({
        fromAddress: "0x1234567890123456789012345678901234567890",
        sourceVault: YLDFI_VAULT_ADDRESSES.ycvxCRV,
        targetVault: YLDFI_VAULT_ADDRESSES.yscvxCRV,
        amountIn: "1000000000000000000",
      });

      expect(mockGetBundleData).toHaveBeenCalled();
      const [, actions] = mockGetBundleData.mock.calls[0];
      expect(actions).toHaveLength(2);
      expect(actions[0].action).toBe("redeem");
      expect(actions[1].action).toBe("deposit");
    });
  });

  describe("sortTokensByPopularity", () => {
    it("sorts popular tokens first", () => {
      const tokens = [
        { address: "0x999", chainId: 1, name: "Random", symbol: "RND", decimals: 18, type: "base" as const },
        { address: ETH_ADDRESS, chainId: 1, name: "Ethereum", symbol: "ETH", decimals: 18, type: "base" as const },
        { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chainId: 1, name: "USD Coin", symbol: "USDC", decimals: 6, type: "base" as const },
      ];

      const sorted = sortTokensByPopularity(tokens);

      expect(sorted[0].symbol).toBe("ETH");
      expect(sorted[1].symbol).toBe("USDC");
      expect(sorted[2].symbol).toBe("RND");
    });

    it("preserves order of non-popular tokens", () => {
      const tokens = [
        { address: "0xAAA", chainId: 1, name: "Token A", symbol: "AAA", decimals: 18, type: "base" as const },
        { address: "0xBBB", chainId: 1, name: "Token B", symbol: "BBB", decimals: 18, type: "base" as const },
      ];

      const sorted = sortTokensByPopularity(tokens);

      expect(sorted[0].symbol).toBe("AAA");
      expect(sorted[1].symbol).toBe("BBB");
    });
  });

  describe("filterTokens", () => {
    const tokens = [
      { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chainId: 1, name: "USD Coin", symbol: "USDC", decimals: 6, type: "base" as const },
      { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", chainId: 1, name: "Tether USD", symbol: "USDT", decimals: 6, type: "base" as const },
      { address: ETH_ADDRESS, chainId: 1, name: "Ethereum", symbol: "ETH", decimals: 18, type: "base" as const },
    ];

    it("returns all tokens when query is empty", () => {
      expect(filterTokens(tokens, "")).toHaveLength(3);
    });

    it("returns no tokens when query is whitespace only", () => {
      // Whitespace is truthy so filterTokens tries to match, finding nothing
      expect(filterTokens(tokens, "   ")).toHaveLength(0);
    });

    it("filters by symbol", () => {
      const filtered = filterTokens(tokens, "USDC");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].symbol).toBe("USDC");
    });

    it("filters by name", () => {
      const filtered = filterTokens(tokens, "Ethereum");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].symbol).toBe("ETH");
    });

    it("filters by partial match", () => {
      const filtered = filterTokens(tokens, "USD");
      expect(filtered).toHaveLength(2);
    });

    it("filters by exact address", () => {
      const filtered = filterTokens(tokens, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].symbol).toBe("USDC");
    });

    it("is case insensitive", () => {
      expect(filterTokens(tokens, "usdc")).toHaveLength(1);
      expect(filterTokens(tokens, "USDC")).toHaveLength(1);
    });
  });

  describe("isYldfiVault", () => {
    it("identifies ycvxCRV vault", () => {
      expect(isYldfiVault("0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86")).toBe(true);
    });

    it("identifies yscvxCRV vault", () => {
      expect(isYldfiVault("0xCa960E6DF1150100586c51382f619efCCcF72706")).toBe(true);
    });

    it("identifies vaults case-insensitively", () => {
      expect(isYldfiVault("0x95f19b19aff698169a1a0bbc28a2e47b14cb9a86")).toBe(true);
    });

    it("returns false for non-vault addresses", () => {
      expect(isYldfiVault("0x0000000000000000000000000000000000000000")).toBe(false);
      expect(isYldfiVault(ETH_ADDRESS)).toBe(false);
    });
  });

  describe("requiresCustomZapRoute", () => {
    it("returns true for cvgCVX token", () => {
      expect(requiresCustomZapRoute("0x2191DF768ad71140F9F3E96c1e4407A4aA31d082")).toBe(true);
    });

    it("returns true for cvgCVX token (lowercase)", () => {
      expect(requiresCustomZapRoute("0x2191df768ad71140f9f3e96c1e4407a4aa31d082")).toBe(true);
    });

    it("returns false for other tokens", () => {
      expect(requiresCustomZapRoute(CVXCRV_ADDRESS)).toBe(false);
      expect(requiresCustomZapRoute(ETH_ADDRESS)).toBe(false);
      expect(requiresCustomZapRoute("0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B")).toBe(false); // CVX
    });
  });

  describe("getCvgCvxSwapRate", () => {
    it("queries Curve pool for swap rate", async () => {
      // Mock RPC response for get_dy call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          result: "0x" + (BigInt("980000000000000000")).toString(16).padStart(64, "0"),
        }),
      } as Response);

      const rate = await getCvgCvxSwapRate("1000000000000000000");
      expect(rate).toBe(BigInt("980000000000000000"));
    });

    it("returns 0n on RPC error", { timeout: 30000 }, async () => {
      // Use mockResolvedValue (not Once) to cover all retry attempts
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ error: { message: "RPC error" } }),
      } as Response);

      const rate = await getCvgCvxSwapRate("1000000000000000000");
      expect(rate).toBe(0n);
    });
  });

  describe("getCvgCvxPoolBalances", () => {
    it("queries pool balances via batch RPC", async () => {
      // Mock batch RPC response for balances(0) and balances(1)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          { jsonrpc: "2.0", id: 1, result: "0x" + (BigInt("50000000000000000000000")).toString(16).padStart(64, "0") },
          { jsonrpc: "2.0", id: 2, result: "0x" + (BigInt("60000000000000000000000")).toString(16).padStart(64, "0") },
        ]),
      } as Response);

      const balances = await getCvgCvxPoolBalances();
      expect(balances.cvx1Balance).toBe(BigInt("50000000000000000000000"));
      expect(balances.cvgCvxBalance).toBe(BigInt("60000000000000000000000"));
    });

    it("throws on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      await expect(getCvgCvxPoolBalances()).rejects.toThrow("Network error");
    });
  });

  describe("getOptimalCvgCvxRoute", () => {
    it("returns 'swap' when pool gives more than 1:1", async () => {
      // Mock getCvgCvxSwapRate returning more than input (swap is better)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          // 1.05e18 output for 1e18 input = 5% bonus
          result: "0x" + (BigInt("1050000000000000000")).toString(16).padStart(64, "0"),
        }),
      } as Response);

      const route = await getOptimalCvgCvxRoute("1000000000000000000");
      expect(route).toBe("swap");
    });

    it("returns 'mint' when pool gives less than 1:1", async () => {
      // Mock getCvgCvxSwapRate returning less than input (mint is better)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          // 0.95e18 output for 1e18 input = 5% loss
          result: "0x" + (BigInt("950000000000000000")).toString(16).padStart(64, "0"),
        }),
      } as Response);

      const route = await getOptimalCvgCvxRoute("1000000000000000000");
      expect(route).toBe("mint");
    });

    it("returns 'mint' when pool gives exactly 1:1", async () => {
      // Mock getCvgCvxSwapRate returning exactly input (prefer mint to save gas)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          result: "0x" + (BigInt("1000000000000000000")).toString(16).padStart(64, "0"),
        }),
      } as Response);

      const route = await getOptimalCvgCvxRoute("1000000000000000000");
      expect(route).toBe("mint");
    });

    it("returns 'mint' on RPC error", { timeout: 30000 }, async () => {
      // Use mockRejectedValue (not Once) to cover all retry attempts
      mockFetch.mockRejectedValue(new Error("RPC error"));

      const route = await getOptimalCvgCvxRoute("1000000000000000000");
      expect(route).toBe("mint");
    });

    it("returns 'mint' on invalid RPC response", { timeout: 30000 }, async () => {
      // Use mockResolvedValue (not Once) to cover all retry attempts
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ error: { message: "Invalid call" } }),
      } as Response);

      const route = await getOptimalCvgCvxRoute("1000000000000000000");
      expect(route).toBe("mint");
    });
  });

  describe("getOptimalSwapAmount", () => {
    it("returns zero amounts for zero input", async () => {
      const result = await getOptimalSwapAmount("0");
      expect(result.swapAmount).toBe(0n);
      expect(result.mintAmount).toBe(0n);
    });

    it("returns mint-only when no swap bonus available", async () => {
      // Mock pool params for findMaxSwapBeforePeg
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          // balances(0) - CVX1 higher than cvgCVX (no bonus)
          { jsonrpc: "2.0", id: 0, result: "0x" + (BigInt("100000000000000000000000")).toString(16).padStart(64, "0") },
          // balances(1)
          { jsonrpc: "2.0", id: 1, result: "0x" + (BigInt("50000000000000000000000")).toString(16).padStart(64, "0") },
          // A (amplification)
          { jsonrpc: "2.0", id: 2, result: "0x" + (BigInt("50")).toString(16).padStart(64, "0") },
          // fee
          { jsonrpc: "2.0", id: 3, result: "0x" + (BigInt("4000000")).toString(16).padStart(64, "0") },
        ]),
      } as Response);

      const result = await getOptimalSwapAmount("1000000000000000000");
      // When there's no swap bonus, should return mint-only
      expect(result.mintAmount).toBe(BigInt("1000000000000000000"));
    });

    it("returns mint-only on RPC error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await getOptimalSwapAmount("1000000000000000000");
      expect(result.swapAmount).toBe(0n);
      expect(result.mintAmount).toBe(BigInt("1000000000000000000"));
    });
  });

  // Note: fetchCvgCvxZapInRoute and fetchCvgCvxZapOutRoute are complex functions
  // that require multiple coordinated RPC calls and internal function calls.
  // They are tested via integration tests against real APIs in development.
  // The helper functions (getCvgCvxSwapRate, getCvgCvxPoolBalances) are tested above.
});
