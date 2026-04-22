import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAccount, usePublicClient } from "wagmi";

import { useZapQuote } from "@/hooks/useZapQuote";
import { useUniversalZap } from "@/hooks/useUniversalZap";

import type { EnsoToken } from "@/types/enso";

vi.mock("@/hooks/useUniversalZap", () => ({
  useUniversalZap: vi.fn(),
}));

const mockUseUniversalZap = vi.mocked(useUniversalZap);
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAccount.mockReturnValue({
      address: USER_ADDRESS,
      isConnected: true,
    } as ReturnType<typeof useAccount>);
    mockUsePublicClient.mockReturnValue({
      readContract: vi.fn(),
      call: vi.fn(),
    } as unknown as ReturnType<typeof usePublicClient>);
    mockUseUniversalZap.mockReturnValue({
      quote: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("adapts zap-in params to the universal hook", () => {
    const quote = {
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
        data: "0x1234",
        value: "1000000000000000000",
      },
      route: [],
    };

    mockUseUniversalZap.mockReturnValue({
      quote,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    const { result } = renderHook(() =>
      useZapQuote({
        inputToken: mockEthToken,
        outputToken: null,
        inputAmount: "1",
        direction: "in",
        vaultAddress: VAULT_ADDRESS,
        slippage: "75",
        paused: true,
      }),
    );

    expect(mockUseUniversalZap).toHaveBeenCalledWith(
      expect.objectContaining({
        inputToken: mockEthToken,
        outputToken: expect.objectContaining({
          address: VAULT_ADDRESS,
          symbol: "ycvxCRV",
          type: "defi",
        }),
        inputAmount: "1",
        slippage: "75",
        paused: true,
      }),
    );
    expect(result.current.quote).toBe(quote);
    expect(result.current.isLoading).toBe(false);
  });

  it("adapts zap-out params to the universal hook", () => {
    const quote = {
      inputToken: {
        address: VAULT_ADDRESS,
        symbol: "ycvxCRV",
        name: "ycvxCRV",
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
        data: "0x5678",
        value: "0",
      },
      route: [],
    };

    mockUseUniversalZap.mockReturnValue({
      quote,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    const { result } = renderHook(() =>
      useZapQuote({
        inputToken: null,
        outputToken: mockUsdcToken,
        inputAmount: "1000",
        direction: "out",
        vaultAddress: VAULT_ADDRESS,
      }),
    );

    expect(mockUseUniversalZap).toHaveBeenCalledWith(
      expect.objectContaining({
        inputToken: expect.objectContaining({
          address: VAULT_ADDRESS,
          symbol: "ycvxCRV",
          type: "defi",
        }),
        outputToken: mockUsdcToken,
        inputAmount: "1000",
        slippage: "50",
        paused: false,
      }),
    );
    expect(result.current.quote).toBe(quote);
  });

  it("passes through loading and error state from the universal hook", () => {
    const error = new Error("Failed to fetch route");
    mockUseUniversalZap.mockReturnValue({
      quote: null,
      isLoading: true,
      error,
      refetch: vi.fn(),
    });

    const { result } = renderHook(() =>
      useZapQuote({
        inputToken: mockEthToken,
        outputToken: null,
        inputAmount: "1",
        direction: "in",
        vaultAddress: VAULT_ADDRESS,
      }),
    );

    expect(result.current.quote).toBeNull();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBe(error);
  });

  it("returns null quote when universal zap is idle", () => {
    mockUseUniversalZap.mockReturnValue({
      quote: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    const { result } = renderHook(() =>
      useZapQuote({
        inputToken: null,
        outputToken: null,
        inputAmount: "0",
        direction: "in",
        vaultAddress: VAULT_ADDRESS,
      }),
    );

    expect(result.current.quote).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
