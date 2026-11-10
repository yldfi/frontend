import { describe, it, expect } from "vitest";
import {
  ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX,
  assertBundleMatchesRouteEstimate,
  routeDepositEstimate,
  routeQuoteShortfallPct,
} from "@/lib/price-impact";
import { parseQuoteError } from "@/lib/quote-errors";
import type { RouteInfo } from "@/types/enso";

// Route as built by fetchErc4626ExternalVaultZapInRoute on 5 Nov 2026 (block 26,351,233).
const ROUTE_5_NOV: RouteInfo = {
  steps: [
    { tokenSymbol: "yvUSDC-1", amount: "177.7308", action: "Exit", description: "yvUSDC-1 for USDC", protocol: "Yearn" },
    { tokenSymbol: "USDC", amount: "199.8261", action: "Swap", description: "USDC for cvxCRV", protocol: "Enso" },
    { tokenSymbol: "cvxCRV", amount: "2,028.2231", action: "Deposit", description: "cvxCRV into yscvxCRV", protocol: "yld" },
    { tokenSymbol: "yscvxCRV", action: "Receive", description: "vault shares", protocol: "yld" },
  ],
};
const PPS_5_NOV = 1.137657847235088;

describe("bundle vs route-estimate guard", () => {
  it("reads the deposit estimate, ignoring thousands separators", () => {
    expect(routeDepositEstimate(ROUTE_5_NOV, "cvxCRV")).toBeCloseTo(2028.2231, 6);
    expect(routeDepositEstimate(ROUTE_5_NOV, "CVX")).toBeNull();
    expect(routeDepositEstimate(undefined, "cvxCRV")).toBeNull();
  });

  it("rejects the 5 Nov yvUSDC-1 → yscvxCRV bundle (1,095.65 shares, ~38% short)", () => {
    const bundleUnderlying = 1095.6524 * PPS_5_NOV;
    expect(routeQuoteShortfallPct(2028.2231, bundleUnderlying)).toBeCloseTo(38.5, 0);
    expect(() =>
      assertBundleMatchesRouteEstimate({ routeInfo: ROUTE_5_NOV, underlyingSymbol: "cvxCRV", bundleUnderlying }),
    ).toThrow(ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX);
  });

  it("accepts a bundle within normal slippage of the estimate", () => {
    // 10 Nov quote: 1,617.59 shares at pps 1.1395 vs 1,845.64 cvxCRV estimate (~0.1%)
    const route: RouteInfo = {
      steps: ROUTE_5_NOV.steps.map((s) => (s.action === "Deposit" ? { ...s, amount: "1,845.6442" } : s)),
    };
    expect(() =>
      assertBundleMatchesRouteEstimate({ routeInfo: route, underlyingSymbol: "cvxCRV", bundleUnderlying: 1617.5943 * 1.1395 }),
    ).not.toThrow();
  });

  it("widens the limit to the user's slippage + 1%", () => {
    // 8% short: rejected at 0.5% slippage, allowed at 10% slippage (builders buffer legs by it)
    const args = { routeInfo: ROUTE_5_NOV, underlyingSymbol: "cvxCRV", bundleUnderlying: 2028.2231 * 0.92 };
    expect(() => assertBundleMatchesRouteEstimate({ ...args, slippageBps: "50" })).toThrow();
    expect(() => assertBundleMatchesRouteEstimate({ ...args, slippageBps: "1000" })).not.toThrow();
    // ...but the 5 Nov 38% shortfall is still rejected at 10% slippage
    expect(() =>
      assertBundleMatchesRouteEstimate({ ...args, bundleUnderlying: 1095.6524 * PPS_5_NOV, slippageBps: "1000" }),
    ).toThrow();
  });

  it("skips when either side is unknown or the bundle beats the estimate", () => {
    expect(() =>
      assertBundleMatchesRouteEstimate({ routeInfo: ROUTE_5_NOV, underlyingSymbol: "cvxCRV", bundleUnderlying: null }),
    ).not.toThrow();
    expect(() =>
      assertBundleMatchesRouteEstimate({ routeInfo: { steps: [] }, underlyingSymbol: "cvxCRV", bundleUnderlying: 1 }),
    ).not.toThrow();
    expect(() =>
      assertBundleMatchesRouteEstimate({ routeInfo: ROUTE_5_NOV, underlyingSymbol: "cvxCRV", bundleUnderlying: 2500 }),
    ).not.toThrow();
    // Enso omits amountsOut for some vault outputs → outRaw "0" is "unknown", not a 100% loss
    expect(() =>
      assertBundleMatchesRouteEstimate({ routeInfo: ROUTE_5_NOV, underlyingSymbol: "cvxCRV", bundleUnderlying: 0 }),
    ).not.toThrow();
  });

  it("shows the guard message to the user unchanged", () => {
    let error: Error | null = null;
    try {
      assertBundleMatchesRouteEstimate({ routeInfo: ROUTE_5_NOV, underlyingSymbol: "cvxCRV", bundleUnderlying: 1246 });
    } catch (e) {
      error = e as Error;
    }
    expect(error).not.toBeNull();
    expect(parseQuoteError(error)).toBe(error!.message);
    expect(error!.message).toContain("cvxCRV");
  });
});
