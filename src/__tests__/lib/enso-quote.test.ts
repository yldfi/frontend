// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetQuoteData, mockGetRouteData } = vi.hoisted(() => ({
  mockGetQuoteData: vi.fn(),
  mockGetRouteData: vi.fn(),
}));

vi.mock("@ensofinance/sdk", () => ({
  EnsoClient: class MockEnsoClient {
    getQuoteData = mockGetQuoteData;
    getRouteData = mockGetRouteData;
  },
}));

import { fetchDynamicInputEstimate, fetchQuote } from "@/lib/enso";

const USER = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const CVX = "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B";

describe("fetchQuote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetQuoteData.mockResolvedValue({
      amountOut: 49277653475340641617n,
      priceImpact: 12,
      route: [{ action: "swap", protocol: "uniswap-v3", tokenIn: [USDC], tokenOut: [CVX] }],
    });
    mockGetRouteData.mockResolvedValue({
      tx: { to: "0xrouter", data: "0x", value: 0n },
      gas: 1n,
      amountOut: 1n,
      priceImpact: 0,
      route: [],
    });
  });

  it("uses Enso's quoter (no calldata) and maps its response", async () => {
    const quote = await fetchQuote({ fromAddress: USER, tokenIn: USDC, tokenOut: CVX, amountIn: "100000000", ignoreAggregators: ["0x"] });

    expect(mockGetQuoteData).toHaveBeenCalledWith(expect.objectContaining({
      chainId: 1,
      routingStrategy: "router",
      tokenIn: [USDC],
      tokenOut: [CVX],
      amountIn: ["100000000"],
      ignoreAggregators: ["0x"],
    }));
    expect(mockGetRouteData).not.toHaveBeenCalled();
    expect(quote).toEqual({
      amountOut: "49277653475340641617",
      priceImpact: 12,
      route: [{ action: "swap", protocol: "uniswap-v3", tokenIn: [USDC], tokenOut: [CVX] }],
    });
  });

  it("falls back to /route when the quoter fails, so an outage only costs credits", async () => {
    mockGetQuoteData.mockRejectedValue(new Error("quoter unavailable"));
    mockGetRouteData.mockResolvedValue({
      tx: { to: "0xrouter", data: "0x", value: 0n },
      gas: 1n,
      amountOut: 42n,
      priceImpact: 5,
      route: [{ action: "swap", protocol: "curve", tokenIn: [USDC], tokenOut: [CVX] }],
    });

    const quote = await fetchQuote({ fromAddress: USER, tokenIn: USDC, tokenOut: CVX, amountIn: "100000000" });

    expect(mockGetRouteData).toHaveBeenCalledTimes(1);
    expect(quote.amountOut).toBe("42");
    expect(quote.route[0]).toMatchObject({ protocol: "curve" });
  });

  it("serves the estimate-only helper from the quoter instead of building a route", async () => {
    const estimate = await fetchDynamicInputEstimate({ fromAddress: USER, tokenIn: USDC, tokenOut: CVX, amountIn: "100000000", slippage: "100" });

    expect(estimate.amountOut).toBe("49277653475340641617");
    expect(mockGetQuoteData).toHaveBeenCalledTimes(1);
    expect(mockGetRouteData).not.toHaveBeenCalled();
  });
});
