import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";
import { useZapQuote } from "@/hooks/useZapQuote";
import type { EnsoToken } from "@/types/enso";

// Get mocked functions
const mockUseQuery = vi.mocked(useQuery);
const mockUseAccount = vi.mocked(useAccount);
const mockUsePublicClient = vi.mocked(usePublicClient);

describe("useZapQuote integration", () => {
  const VAULT_ADDRESS = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86";
  const USER_ADDRESS = "0x1234567890123456789012345678901234567890" as `0x${string}`;

  const mockEthToken: EnsoToken = {
    address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    chainId: 1,
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
    type: "base",
  };

  const mockUsdcToken: EnsoToken = {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    chainId: 1,
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    type: "base",
  };

  const mockCvxCrvToken: EnsoToken = {
    address: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7",
    chainId: 1,
    name: "Convex CRV",
    symbol: "cvxCRV",
    decimals: 18,
    type: "base",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAccount.mockReturnValue({
      address: USER_ADDRESS,
      isConnected: true,
    } as ReturnType<typeof useAccount>);
    mockUsePublicClient.mockReturnValue({
      readContract: vi.fn(),
    } as unknown as ReturnType<typeof usePublicClient>);
  });

  describe("zap in quotes", () => {
    it("returns quote for ETH to vault zap", () => {
      const mockQuote = {
        inputToken: mockEthToken,
        inputAmount: "1",
        outputAmount: "1050000000000000000000",
        outputAmountFormatted: "1050",
        exchangeRate: 1050,
        inputUsdValue: 2000,
        outputUsdValue: 1995,
        priceImpact: 0.25,
        gasEstimate: "200000",
        tx: {
          to: "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E",
          data: "0x...",
          value: "1000000000000000000",
        },
        route: [],
      };

      mockUseQuery.mockReturnValue({
        data: mockQuote,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useZapQuote({
          inputToken: mockEthToken,
          outputToken: null,
          inputAmount: "1",
          direction: "in",
          vaultAddress: VAULT_ADDRESS,
        })
      );

      expect(result.current.quote).toBeDefined();
      expect(result.current.quote?.exchangeRate).toBe(1050);
      expect(result.current.quote?.priceImpact).toBe(0.25);
      expect(result.current.isLoading).toBe(false);
    });

    it("returns quote for USDC to vault zap", () => {
      const mockQuote = {
        inputToken: mockUsdcToken,
        inputAmount: "1000",
        outputAmount: "1100000000000000000000",
        outputAmountFormatted: "1100",
        exchangeRate: 1.1,
        inputUsdValue: 1000,
        outputUsdValue: 990,
        priceImpact: 1.0,
        gasEstimate: "300000",
        tx: {
          to: "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E",
          data: "0x...",
          value: "0",
        },
        route: [],
      };

      mockUseQuery.mockReturnValue({
        data: mockQuote,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useZapQuote({
          inputToken: mockUsdcToken,
          outputToken: null,
          inputAmount: "1000",
          direction: "in",
          vaultAddress: VAULT_ADDRESS,
        })
      );

      expect(result.current.quote).toBeDefined();
      expect(result.current.quote?.inputToken.symbol).toBe("USDC");
      expect(result.current.quote?.priceImpact).toBe(1.0);
    });
  });

  describe("zap out quotes", () => {
    it("returns quote for vault to ETH zap", () => {
      const mockQuote = {
        inputToken: {
          address: VAULT_ADDRESS,
          symbol: "Vault Shares",
          name: "Vault Shares",
          decimals: 18,
          chainId: 1,
          type: "defi" as const,
        },
        inputAmount: "1000",
        outputAmount: "900000000000000000",
        outputAmountFormatted: "0.9",
        exchangeRate: 0.0009,
        inputUsdValue: 930,
        outputUsdValue: 920,
        priceImpact: 1.08,
        gasEstimate: "250000",
        tx: {
          to: "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E",
          data: "0x...",
          value: "0",
        },
        route: [],
      };

      mockUseQuery.mockReturnValue({
        data: mockQuote,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useZapQuote({
          inputToken: null,
          outputToken: mockEthToken,
          inputAmount: "1000",
          direction: "out",
          vaultAddress: VAULT_ADDRESS,
        })
      );

      expect(result.current.quote).toBeDefined();
      expect(result.current.quote?.inputToken.symbol).toBe("Vault Shares");
    });
  });

  describe("loading states", () => {
    it("returns loading when fetching quote", () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: true,
        isFetching: true,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useZapQuote({
          inputToken: mockEthToken,
          outputToken: null,
          inputAmount: "1",
          direction: "in",
          vaultAddress: VAULT_ADDRESS,
        })
      );

      expect(result.current.isLoading).toBe(true);
      expect(result.current.quote).toBeUndefined();
    });

    it("returns loading when refetching", () => {
      mockUseQuery.mockReturnValue({
        data: { inputAmount: "1" },
        isLoading: false,
        isFetching: true,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useZapQuote({
          inputToken: mockEthToken,
          outputToken: null,
          inputAmount: "1",
          direction: "in",
          vaultAddress: VAULT_ADDRESS,
        })
      );

      expect(result.current.isLoading).toBe(true);
    });
  });

  describe("error handling", () => {
    it("returns error when API fails", () => {
      const mockError = new Error("Failed to fetch route");
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        isFetching: false,
        error: mockError,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useZapQuote({
          inputToken: mockEthToken,
          outputToken: null,
          inputAmount: "1",
          direction: "in",
          vaultAddress: VAULT_ADDRESS,
        })
      );

      expect(result.current.error).toBe(mockError);
      expect(result.current.quote).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("returns null when user not connected", () => {
      mockUseAccount.mockReturnValue({
        address: undefined,
        isConnected: false,
      } as ReturnType<typeof useAccount>);

      mockUseQuery.mockReturnValue({
        data: null,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useZapQuote({
          inputToken: mockEthToken,
          outputToken: null,
          inputAmount: "1",
          direction: "in",
          vaultAddress: VAULT_ADDRESS,
        })
      );

      expect(result.current.quote).toBeNull();
    });

    it("handles zero input amount", () => {
      mockUseQuery.mockReturnValue({
        data: null,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useZapQuote({
          inputToken: mockEthToken,
          outputToken: null,
          inputAmount: "0",
          direction: "in",
          vaultAddress: VAULT_ADDRESS,
        })
      );

      expect(result.current.quote).toBeNull();
    });

    it("handles invalid input amount", () => {
      mockUseQuery.mockReturnValue({
        data: null,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useZapQuote({
          inputToken: mockEthToken,
          outputToken: null,
          inputAmount: "abc",
          direction: "in",
          vaultAddress: VAULT_ADDRESS,
        })
      );

      expect(result.current.quote).toBeNull();
    });

    it("handles null input token", () => {
      mockUseQuery.mockReturnValue({
        data: null,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useZapQuote({
          inputToken: null,
          outputToken: null,
          inputAmount: "1",
          direction: "in",
          vaultAddress: VAULT_ADDRESS,
        })
      );

      expect(result.current.quote).toBeNull();
    });
  });

  describe("price impact", () => {
    it("handles positive price impact (loss)", () => {
      const mockQuote = {
        inputToken: mockEthToken,
        inputAmount: "1",
        outputAmount: "1000000000000000000000",
        outputAmountFormatted: "1000",
        exchangeRate: 1000,
        inputUsdValue: 2000,
        outputUsdValue: 1900,
        priceImpact: 5.0, // 5% loss
        gasEstimate: "200000",
        tx: { to: "0x...", data: "0x...", value: "0" },
        route: [],
      };

      mockUseQuery.mockReturnValue({
        data: mockQuote,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useZapQuote({
          inputToken: mockEthToken,
          outputToken: null,
          inputAmount: "1",
          direction: "in",
          vaultAddress: VAULT_ADDRESS,
        })
      );

      expect(result.current.quote?.priceImpact).toBe(5.0);
    });

    it("handles null price impact when prices unavailable", () => {
      const mockQuote = {
        inputToken: mockEthToken,
        inputAmount: "1",
        outputAmount: "1000000000000000000000",
        outputAmountFormatted: "1000",
        exchangeRate: 1000,
        inputUsdValue: null,
        outputUsdValue: null,
        priceImpact: null,
        gasEstimate: "200000",
        tx: { to: "0x...", data: "0x...", value: "0" },
        route: [],
      };

      mockUseQuery.mockReturnValue({
        data: mockQuote,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useZapQuote({
          inputToken: mockEthToken,
          outputToken: null,
          inputAmount: "1",
          direction: "in",
          vaultAddress: VAULT_ADDRESS,
        })
      );

      expect(result.current.quote?.priceImpact).toBeNull();
    });
  });

  describe("custom slippage", () => {
    it("accepts custom slippage parameter", () => {
      mockUseQuery.mockReturnValue({
        data: { slippage: "50" },
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>);

      const { result } = renderHook(() =>
        useZapQuote({
          inputToken: mockEthToken,
          outputToken: null,
          inputAmount: "1",
          direction: "in",
          vaultAddress: VAULT_ADDRESS,
          slippage: "50", // 0.5%
        })
      );

      // Verify hook accepts the slippage param
      expect(result.current.error).toBeNull();
    });
  });
});
