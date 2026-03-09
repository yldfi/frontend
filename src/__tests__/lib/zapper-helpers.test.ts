import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Mock setup (vi.hoisted pattern)
// ============================================================================

const { mockFetchRoute } = vi.hoisted(() => ({
  mockFetchRoute: vi.fn(),
}));

vi.mock("@/lib/enso", () => ({
  fetchRoute: mockFetchRoute,
  fetchBundle: vi.fn(),
  computeHybridZapParams: vi.fn(),
  getLpxCvxToCvxSwapRate: vi.fn(),
  ENSO_SHORTCUTS: "0x4Fe93ebC4Ce6Ae4f81601cC7Ce7139023919E003",
  ENSO_ROUTER_EXECUTOR: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
  CVX_HYBRID_ZAPPER: "0xEE3FF294c7156090F5b2A37acd131FD3DC652182",
}));

vi.mock("viem", () => ({
  decodeFunctionData: vi.fn(),
}));

vi.mock("@/lib/curve", () => ({
  calculateMinDy: vi.fn(),
}));

import {
  fetchZapperSwapData,
  fetchFromTokenSwapData,
  getDeadline,
  ZAPPER_ADDRESS,
} from "@/lib/zapper";
import { CRVUSD_ADDRESS } from "@/config/addresses";

// ============================================================================
// Shared fixtures
// ============================================================================

const MOCK_ROUTE_RESPONSE = {
  tx: { to: "0xrouter", data: "0xmockroutedata", value: "0" },
  gas: "200000",
  amountOut: "1000000000000000000",
  route: [],
};

// ============================================================================
// fetchZapperSwapData
// ============================================================================

describe("fetchZapperSwapData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRoute.mockResolvedValue(MOCK_ROUTE_RESPONSE);
  });

  it("calls fetchRoute with fromAddress and receiver set to ZAPPER_ADDRESS", async () => {
    await fetchZapperSwapData({
      tokenIn: "0xTokenA",
      tokenOut: "0xTokenB",
      amountIn: "1000",
    });

    expect(mockFetchRoute).toHaveBeenCalledOnce();
    const args = mockFetchRoute.mock.calls[0][0];
    expect(args.fromAddress).toBe(ZAPPER_ADDRESS);
    expect(args.receiver).toBe(ZAPPER_ADDRESS);
  });

  it("returns swapData from route.tx.data and expectedOut from route.amountOut", async () => {
    const result = await fetchZapperSwapData({
      tokenIn: "0xTokenA",
      tokenOut: "0xTokenB",
      amountIn: "1000",
    });

    expect(result).toEqual({
      swapData: "0xmockroutedata",
      expectedOut: "1000000000000000000",
    });
  });

  it("uses default slippage '100' when not specified", async () => {
    await fetchZapperSwapData({
      tokenIn: "0xTokenA",
      tokenOut: "0xTokenB",
      amountIn: "1000",
    });

    const args = mockFetchRoute.mock.calls[0][0];
    expect(args.slippage).toBe("100");
  });

  it("passes through custom slippage when specified", async () => {
    await fetchZapperSwapData({
      tokenIn: "0xTokenA",
      tokenOut: "0xTokenB",
      amountIn: "1000",
      slippage: "300",
    });

    const args = mockFetchRoute.mock.calls[0][0];
    expect(args.slippage).toBe("300");
  });
});

// ============================================================================
// fetchFromTokenSwapData
// ============================================================================

describe("fetchFromTokenSwapData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls fetchRoute twice in parallel — once for input, once for leverage", async () => {
    mockFetchRoute
      .mockResolvedValueOnce({ tx: { data: "0xinputdata" }, amountOut: "500" })
      .mockResolvedValueOnce({ tx: { data: "0xleveragedata" }, amountOut: "1000" });

    await fetchFromTokenSwapData({
      inputToken: "0xUSDC",
      collateralToken: "0xWETH",
      inputAmount: "5000000",
      debtAmount: "10000000000000000000",
    });

    expect(mockFetchRoute).toHaveBeenCalledTimes(2);
  });

  it("uses CRVUSD_ADDRESS as tokenIn for the leverage route", async () => {
    mockFetchRoute
      .mockResolvedValueOnce({ tx: { data: "0xinputdata" }, amountOut: "500" })
      .mockResolvedValueOnce({ tx: { data: "0xleveragedata" }, amountOut: "1000" });

    await fetchFromTokenSwapData({
      inputToken: "0xUSDC",
      collateralToken: "0xWETH",
      inputAmount: "5000000",
      debtAmount: "10000000000000000000",
    });

    // Find the call that used CRVUSD_ADDRESS as tokenIn (leverage route)
    const leverageCall = mockFetchRoute.mock.calls.find(
      (call: unknown[]) => (call[0] as { tokenIn: string }).tokenIn === CRVUSD_ADDRESS
    );
    expect(leverageCall).toBeDefined();
    expect((leverageCall![0] as { amountIn: string }).amountIn).toBe("10000000000000000000");
  });

  it("returns correct mapping: inputSwapData/inputExpectedOut from first route, leverageSwapData/leverageExpectedOut from second", async () => {
    mockFetchRoute
      .mockResolvedValueOnce({ tx: { data: "0xinputdata" }, amountOut: "500" })
      .mockResolvedValueOnce({ tx: { data: "0xleveragedata" }, amountOut: "1000" });

    const result = await fetchFromTokenSwapData({
      inputToken: "0xUSDC",
      collateralToken: "0xWETH",
      inputAmount: "5000000",
      debtAmount: "10000000000000000000",
    });

    expect(result).toEqual({
      inputSwapData: "0xinputdata",
      inputExpectedOut: "500",
      leverageSwapData: "0xleveragedata",
      leverageExpectedOut: "1000",
    });
  });

  it("uses ZAPPER_ADDRESS as fromAddress for both routes", async () => {
    mockFetchRoute
      .mockResolvedValueOnce({ tx: { data: "0xinputdata" }, amountOut: "500" })
      .mockResolvedValueOnce({ tx: { data: "0xleveragedata" }, amountOut: "1000" });

    await fetchFromTokenSwapData({
      inputToken: "0xUSDC",
      collateralToken: "0xWETH",
      inputAmount: "5000000",
      debtAmount: "10000000000000000000",
    });

    for (const call of mockFetchRoute.mock.calls) {
      expect((call[0] as { fromAddress: string }).fromAddress).toBe(ZAPPER_ADDRESS);
    }
  });
});

// ============================================================================
// getDeadline
// ============================================================================

describe("getDeadline", () => {
  // The vitest config loads .env.local which sets NEXT_PUBLIC_ANVIL_RPC.
  // We need to control this env var per test to cover both branches.

  const originalEnv = process.env.NEXT_PUBLIC_ANVIL_RPC;

  afterEach(() => {
    // Restore the original value after each test
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_ANVIL_RPC = originalEnv;
    } else {
      delete process.env.NEXT_PUBLIC_ANVIL_RPC;
    }
  });

  it("returns a bigint roughly 20 minutes in the future by default (production path)", () => {
    // Temporarily clear ANVIL_RPC to test production path
    delete process.env.NEXT_PUBLIC_ANVIL_RPC;

    const before = BigInt(Math.floor(Date.now() / 1000));
    const deadline = getDeadline();
    const after = BigInt(Math.floor(Date.now() / 1000));

    // Default is 20 minutes = 1200 seconds
    expect(deadline).toBeGreaterThanOrEqual(before + 1200n);
    expect(deadline).toBeLessThanOrEqual(after + 1200n);
    expect(typeof deadline).toBe("bigint");
  });

  it("returns a bigint roughly 7 days in the future when NEXT_PUBLIC_ANVIL_RPC is set", () => {
    process.env.NEXT_PUBLIC_ANVIL_RPC = "http://127.0.0.1:8545";

    const before = BigInt(Math.floor(Date.now() / 1000));
    const deadline = getDeadline();
    const after = BigInt(Math.floor(Date.now() / 1000));

    const sevenDays = BigInt(7 * 86400);
    expect(deadline).toBeGreaterThanOrEqual(before + sevenDays);
    expect(deadline).toBeLessThanOrEqual(after + sevenDays);
  });
});
