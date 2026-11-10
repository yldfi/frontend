// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAggregators, mockGetBundleData } = vi.hoisted(() => ({
  mockGetAggregators: vi.fn(),
  mockGetBundleData: vi.fn(),
}));

vi.mock("@ensofinance/sdk", () => ({
  EnsoClient: class MockEnsoClient {
    getAggregators = mockGetAggregators;
    getBundleData = mockGetBundleData;
  },
}));

import { DYNAMIC_ROUTE_UNAVAILABLE_MESSAGE, fetchBundle, resetEnsoAggregatorCache } from "@/lib/enso";
import { parseQuoteError } from "@/lib/quote-errors";
import type { EnsoBundleAction } from "@/types/enso";

const USER = "0x1111111111111111111111111111111111111111";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const CVXCRV = "0x62b9c7356a2dc64a1969e19c23e4f579f9810aa7";
const swapNotFound = () => Object.assign(new Error(`API Error: Swap not found for ${USDC}->${CVXCRV}`), { statusCode: 404 });
const okBundle = { tx: { to: "0xrouter", data: "0xabc", value: 0, from: USER }, gas: 1, amountsOut: { [CVXCRV]: "1" }, priceImpact: 0 };

// redeem -> dynamic route (the shape of fetchErc4626ExternalVaultZapInRoute)
const dynamicActions = (): EnsoBundleAction[] => [
  { protocol: "erc4626", action: "redeem", args: { tokenIn: "0xvault", tokenOut: USDC, amountIn: "100", primaryAddress: "0xvault" } },
  { protocol: "enso", action: "route", args: { tokenIn: USDC, tokenOut: CVXCRV, amountIn: { useOutputOfCallAt: 0 }, slippage: "50" } },
] as EnsoBundleAction[];

describe("fetchBundle: dynamic route 'Swap not found'", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEnsoAggregatorCache();
    mockGetAggregators.mockResolvedValue(["grapher", "openocean", "fly"]);
  });

  it("retries once and succeeds when Enso recovers", async () => {
    mockGetBundleData.mockRejectedValueOnce(swapNotFound()).mockResolvedValueOnce(okBundle);
    const r = await fetchBundle({ fromAddress: USER, actions: dynamicActions(), skipQuote: false });
    expect(mockGetBundleData).toHaveBeenCalledTimes(2);
    expect(r.amountsOut[CVXCRV]).toBe("1");
  }, 10_000);

  it("reports a temporary failure (not 'insufficient liquidity') when the retry fails too", async () => {
    mockGetBundleData.mockRejectedValue(swapNotFound());
    const err = await fetchBundle({ fromAddress: USER, actions: dynamicActions(), skipQuote: false }).catch((e: Error) => e);
    expect(mockGetBundleData).toHaveBeenCalledTimes(2);
    expect((err as Error).message.startsWith(DYNAMIC_ROUTE_UNAVAILABLE_MESSAGE)).toBe(true);
    expect(parseQuoteError(err as Error)).toMatch(/can't route this swap right now/);
    expect(parseQuoteError(err as Error)).not.toMatch(/insufficient liquidity/);
  }, 10_000);

  it("does not retry other errors", async () => {
    mockGetBundleData.mockRejectedValue(new Error("API Error: Could not build Bundle shortcut"));
    await expect(fetchBundle({ fromAddress: USER, actions: dynamicActions(), skipQuote: false })).rejects.toThrow(/Could not build/);
    expect(mockGetBundleData).toHaveBeenCalledTimes(1);
  });

  it("does not retry bundles without a dynamic route step", async () => {
    mockGetBundleData.mockRejectedValue(swapNotFound());
    const fixed = [{ protocol: "erc4626", action: "deposit", args: { tokenIn: CVXCRV, tokenOut: "0xvault", amountIn: "1", primaryAddress: "0xvault" } }] as EnsoBundleAction[];
    await expect(fetchBundle({ fromAddress: USER, actions: fixed, skipQuote: false })).rejects.toThrow(/Swap not found/);
    expect(mockGetBundleData).toHaveBeenCalledTimes(1);
  });

  it("keeps the generic mapping for a plain 'Swap not found'", () => {
    expect(parseQuoteError(swapNotFound())).toBe("No route available - insufficient liquidity");
  });
});
