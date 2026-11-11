import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxUint256, parseUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useWaitForTransactionReceipt } from "wagmi";

import { useZapActions } from "@/hooks/useZapActions";
import type { EnsoToken, ZapQuote } from "@/types/enso";

vi.mock("@/hooks/useDirectWriteContract", () => ({
  useDirectWriteContract: vi.fn(() => ({
    writeContract: vi.fn(),
    data: undefined,
    reset: vi.fn(),
    error: null,
  })),
}));

vi.mock("@/contexts/TestNetworkContext", () => ({
  useTestNetwork: vi.fn(() => ({ testNetworkType: null })),
}));

vi.mock("@/hooks/useFlashbotsProtect", () => ({
  useFlashbotsProtect: vi.fn(() => ({
    isFlashbotsEnabled: false,
    isFlashbotsSupported: false,
    toggleFlashbots: vi.fn(),
  })),
}));

vi.mock("@/hooks/useSendTx", () => ({
  useSendTx: vi.fn(() => ({ sendTx: vi.fn() })),
}));

const ETH: EnsoToken = {
  address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  chainId: 1,
  name: "Ethereum",
  symbol: "ETH",
  decimals: 18,
  type: "base",
};

const USDC: EnsoToken = {
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  chainId: 1,
  name: "USD Coin",
  symbol: "USDC",
  decimals: 6,
  type: "base",
};

function quoteFor(token: EnsoToken, amount: string): ZapQuote {
  return {
    inputToken: token,
    inputAmount: amount,
    outputAmount: "0",
    outputAmountFormatted: "0",
    exchangeRate: 1,
    inputUsdValue: 1,
    outputUsdValue: 1,
    priceImpact: 0,
    gasEstimate: "200000",
    tx: { to: "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E", data: "0xabcdef", value: "0" },
    route: [],
  };
}

function withAllowance(allowance: bigint | undefined) {
  vi.mocked(useReadContract).mockReturnValue({
    data: allowance,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useReadContract>);
}

function renderQuote(quote: ZapQuote | null | undefined) {
  return renderHook(() => useZapActions(quote));
}

describe("useZapActions needsApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAccount).mockReturnValue({
      address: "0x1234567890123456789012345678901234567890",
      chainId: 1,
      isConnected: true,
    } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(usePublicClient).mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(1n),
      readContract: vi.fn(),
    } as unknown as ReturnType<typeof usePublicClient>);
    vi.mocked(useWaitForTransactionReceipt).mockReturnValue({
      isLoading: false,
      isSuccess: false,
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>);
    withAllowance(undefined);
  });

  it("never needs an approval for ETH", () => {
    withAllowance(0n);

    const { result } = renderQuote(quoteFor(ETH, "100"));

    expect(result.current.needsApproval()).toBe(false);
  });

  it("never needs an approval for the mixed-case ETH placeholder", () => {
    withAllowance(0n);
    const mixedCaseEth: EnsoToken = {
      ...ETH,
      address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    };

    const { result } = renderQuote(quoteFor(mixedCaseEth, "100"));

    expect(result.current.needsApproval()).toBe(false);
  });

  it("needs no approval without a quote", () => {
    withAllowance(0n);

    expect(renderQuote(null).result.current.needsApproval()).toBe(false);
    expect(renderQuote(undefined).result.current.needsApproval()).toBe(false);
  });

  it("needs no approval when withdrawing vault shares", () => {
    withAllowance(0n);
    const quote: ZapQuote = {
      ...quoteFor({ ...USDC, symbol: "ysCVX", type: "defi" }, "100"),
      tx: { to: "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e", data: "0xredeem", value: "0" },
      directVault: {
        vaultAddress: "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e",
        action: "withdraw",
        symbol: "ysCVX",
      },
    };

    const { result } = renderQuote(quote);

    expect(result.current.needsApproval()).toBe(false);
  });

  it("asks for approval while the allowance is unknown", () => {
    const { result } = renderQuote(quoteFor(USDC, "100"));

    expect(result.current.needsApproval()).toBe(true);
  });

  it("asks for approval for a zero allowance", () => {
    withAllowance(0n);

    const { result } = renderQuote(quoteFor(USDC, "1"));

    expect(result.current.needsApproval()).toBe(true);
  });

  it("asks for approval when the allowance is below the quoted amount", () => {
    withAllowance(parseUnits("50", 6));

    const { result } = renderQuote(quoteFor(USDC, "100"));

    expect(result.current.needsApproval()).toBe(true);
  });

  it("does not ask for approval when the allowance equals the quoted amount", () => {
    withAllowance(parseUnits("100", 6));

    const { result } = renderQuote(quoteFor(USDC, "100"));

    expect(result.current.needsApproval()).toBe(false);
  });

  it("does not ask for approval when the allowance exceeds the quoted amount", () => {
    withAllowance(parseUnits("100", 6));

    const { result } = renderQuote(quoteFor(USDC, "50"));

    expect(result.current.needsApproval()).toBe(false);
  });

  it("does not ask for approval against an unlimited allowance", () => {
    withAllowance(maxUint256);

    const { result } = renderQuote(quoteFor(USDC, "1000000000"));

    expect(result.current.needsApproval()).toBe(false);
  });

  it("asks for approval for an amount that cannot be parsed", () => {
    withAllowance(parseUnits("100", 6));

    const { result } = renderQuote(quoteFor(USDC, "invalid"));

    expect(result.current.needsApproval()).toBe(true);
  });

  it("compares an 8-decimal quote against the allowance", () => {
    withAllowance(parseUnits("1", 8));
    const wbtc: EnsoToken = { ...USDC, symbol: "WBTC", decimals: 8 };

    const { result } = renderQuote(quoteFor(wbtc, "0.5"));

    expect(result.current.needsApproval()).toBe(false);
  });

  it("starts idle and not loading", () => {
    const { result } = renderQuote(quoteFor(ETH, "1"));

    expect(result.current.status).toBe("idle");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
