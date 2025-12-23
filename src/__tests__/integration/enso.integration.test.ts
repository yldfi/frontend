import { describe, it, expect, vi, beforeEach } from "vitest";
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
  ETH_ADDRESS,
  CVXCRV_ADDRESS,
  ENSO_ROUTER,
  CUSTOM_TOKENS,
  POPULAR_TOKENS,
  YLDFI_VAULT_ADDRESSES,
} from "@/lib/enso";

// Get mocked fetch
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
      const mockResponse = {
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
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const tokens = await fetchEnsoTokenList();

      expect(tokens).toHaveLength(1);
      expect(tokens[0].symbol).toBe("USDC");
      expect(tokens[0].decimals).toBe(6);
      expect(tokens[0].logoURI).toBe("https://example.com/usdc.png");
    });

    it("throws error on failed fetch", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      await expect(fetchEnsoTokenList()).rejects.toThrow(
        "Failed to fetch token list"
      );
    });

    it("handles tokens without logoUri", async () => {
      const mockResponse = {
        data: [
          {
            address: "0x123",
            chainId: 1,
            name: "Test Token",
            symbol: "TEST",
            decimals: 18,
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const tokens = await fetchEnsoTokenList();

      expect(tokens[0].logoURI).toBeUndefined();
    });

    it("handles 400 bad request error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
      } as Response);

      await expect(fetchEnsoTokenList()).rejects.toThrow("Failed to fetch token list");
    });

    it("handles 429 rate limit error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
      } as Response);

      await expect(fetchEnsoTokenList()).rejects.toThrow("Failed to fetch token list");
    });

    it("handles network timeout", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network timeout"));

      await expect(fetchEnsoTokenList()).rejects.toThrow("Network timeout");
    });

    it("handles malformed API response (missing data)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      // Returns empty array for malformed responses (graceful degradation)
      const tokens = await fetchEnsoTokenList();
      expect(tokens).toEqual([]);
    });

    it("handles empty token list", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      } as Response);

      const tokens = await fetchEnsoTokenList();
      expect(tokens).toHaveLength(0);
    });
  });

  describe("fetchWalletBalances", () => {
    it("fetches wallet balances", async () => {
      const mockBalances = [
        {
          token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          amount: "1000000000",
          chainId: 1,
          decimals: 6,
          price: 1.0,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockBalances),
      } as Response);

      const balances = await fetchWalletBalances("0x1234567890123456789012345678901234567890");

      expect(balances).toHaveLength(1);
      expect(balances[0].token).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    });

    it("throws on failed fetch", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
      } as Response);

      await expect(
        fetchWalletBalances("0x1234567890123456789012345678901234567890")
      ).rejects.toThrow("Failed to fetch wallet balances");
    });
  });

  describe("fetchTokenPrices", () => {
    it("fetches token prices", async () => {
      const mockPrices = [
        {
          chainId: 1,
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          price: 1.0,
          decimals: 6,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockPrices),
      } as Response);

      const prices = await fetchTokenPrices([
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ]);

      expect(prices).toHaveLength(1);
      expect(prices[0].price).toBe(1.0);
    });

    it("returns empty array for empty addresses", async () => {
      const prices = await fetchTokenPrices([]);
      expect(prices).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("handles API error for token prices", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      await expect(
        fetchTokenPrices(["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"])
      ).rejects.toThrow();
    });
  });

  describe("fetchRoute", () => {
    it("fetches optimal route", async () => {
      const mockRoute = {
        amountOut: "1000000",
        gas: "100000",
        tx: {
          to: ENSO_ROUTER,
          data: "0x...",
          value: "0",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockRoute),
      } as Response);

      const route = await fetchRoute({
        fromAddress: "0x1234567890123456789012345678901234567890",
        tokenIn: ETH_ADDRESS,
        tokenOut: CVXCRV_ADDRESS,
        amountIn: "1000000000000000000",
      });

      expect(route.amountOut).toBe("1000000");
      expect(route.tx.to).toBe(ENSO_ROUTER);
    });

    it("uses default slippage", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      await fetchRoute({
        fromAddress: "0x1234567890123456789012345678901234567890",
        tokenIn: ETH_ADDRESS,
        tokenOut: CVXCRV_ADDRESS,
        amountIn: "1000000000000000000",
      });

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain("slippage=100"); // 1% default
    });

    it("uses custom slippage", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      await fetchRoute({
        fromAddress: "0x1234567890123456789012345678901234567890",
        tokenIn: ETH_ADDRESS,
        tokenOut: CVXCRV_ADDRESS,
        amountIn: "1000000000000000000",
        slippage: "50", // 0.5%
      });

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain("slippage=50");
    });

    it("handles route API failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      await expect(
        fetchRoute({
          fromAddress: "0x1234567890123456789012345678901234567890",
          tokenIn: ETH_ADDRESS,
          tokenOut: CVXCRV_ADDRESS,
          amountIn: "1000000000000000000",
        })
      ).rejects.toThrow();
    });

    it("handles no route found (400 error)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
      } as Response);

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
    it("bundles multiple actions", async () => {
      const mockBundle = {
        amountOut: "1000000",
        tx: {
          to: ENSO_ROUTER,
          data: "0x...",
          value: "0",
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockBundle),
      } as Response);

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
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("bundle"),
        expect.objectContaining({
          method: "POST",
        })
      );
    });
  });

  describe("fetchZapInRoute", () => {
    it("creates zap in bundle with swap and deposit", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ amountOut: "1000", tx: {} }),
      } as Response);

      await fetchZapInRoute({
        fromAddress: "0x1234567890123456789012345678901234567890",
        vaultAddress: YLDFI_VAULT_ADDRESSES.ycvxCRV,
        inputToken: ETH_ADDRESS,
        amountIn: "1000000000000000000",
      });

      // Verify the POST body contains swap + deposit actions
      const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(callBody).toHaveLength(2);
      expect(callBody[0].action).toBe("route");
      expect(callBody[1].action).toBe("deposit");
    });
  });

  describe("fetchZapOutRoute", () => {
    it("creates zap out bundle with redeem and swap", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ amountOut: "1000", tx: {} }),
      } as Response);

      await fetchZapOutRoute({
        fromAddress: "0x1234567890123456789012345678901234567890",
        vaultAddress: YLDFI_VAULT_ADDRESSES.ycvxCRV,
        outputToken: ETH_ADDRESS,
        amountIn: "1000000000000000000",
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(callBody).toHaveLength(2);
      expect(callBody[0].action).toBe("redeem");
      expect(callBody[1].action).toBe("route");
    });
  });

  describe("fetchVaultToVaultRoute", () => {
    it("creates vault-to-vault bundle with redeem and deposit", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ amountOut: "1000", tx: {} }),
      } as Response);

      await fetchVaultToVaultRoute({
        fromAddress: "0x1234567890123456789012345678901234567890",
        sourceVault: YLDFI_VAULT_ADDRESSES.ycvxCRV,
        targetVault: YLDFI_VAULT_ADDRESSES.yscvxCRV,
        amountIn: "1000000000000000000",
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(callBody).toHaveLength(2);
      expect(callBody[0].action).toBe("redeem");
      expect(callBody[1].action).toBe("deposit");
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
});
