import { describe, expect, it } from "vitest";

import {
  annotateEnsoStepSlippage,
  calculateCvxLegPriceImpact,
  calculateRoutePriceImpact,
  routeHasEnsoSwap,
  routeHasSwap,
} from "@/lib/price-impact";
import type { RouteInfo } from "@/types/enso";

describe("price impact route semantics", () => {
  it("hides price impact for direct vault actions with no swap", () => {
    const routeInfo: RouteInfo = {
      steps: [
        { tokenSymbol: "yvUSDC-1", action: "Redeem", protocol: "yld" },
        { tokenSymbol: "yvUSDC-2", action: "Deposit", protocol: "yld" },
        { tokenSymbol: "yvUSDC-2", action: "Receive", protocol: "yld" },
      ],
    };

    expect(routeHasSwap(routeInfo)).toBe(false);
    expect(calculateRoutePriceImpact(100, 98, routeInfo)).toBeNull();
  });

  it("uses USD delta for routes that actually swap", () => {
    const routeInfo: RouteInfo = {
      steps: [
        { tokenSymbol: "USDC", action: "Swap", protocol: "Enso" },
        { tokenSymbol: "CVX", action: "Receive", protocol: "Enso" },
      ],
    };

    expect(routeHasSwap(routeInfo)).toBe(true);
    expect(calculateRoutePriceImpact(100, 98, routeInfo)).toBe(2);
  });

  it("falls back to Enso bps for swap routes when USD values are missing", () => {
    const routeInfo: RouteInfo = {
      steps: [{ tokenSymbol: "USDC", action: "Swap", protocol: "Enso" }],
    };

    expect(calculateRoutePriceImpact(null, null, routeInfo, 0)).toBe(0);
    expect(calculateRoutePriceImpact(null, null, routeInfo, 75)).toBe(0.75);
  });

  it("calculates CVX-leg impact for hybrid CVX-derivative routes", () => {
    const routeInfo: RouteInfo = {
      steps: [{ tokenSymbol: "USDC", action: "Swap", protocol: "Enso" }],
      hybrid: {
        swapAmount: (49n * 10n ** 18n).toString(),
        mintAmount: 0n.toString(),
        swapBonus: 0,
        swapProtocol: "Curve",
        mintProtocol: "Pirex",
      },
    };

    expect(calculateCvxLegPriceImpact({
      inputUsd: 100,
      cvxUsd: 2,
      routeInfo,
    })).toBe(2);
  });

  it("hides CVX-leg price impact when the route starts from CVX directly", () => {
    const routeInfo: RouteInfo = {
      steps: [
        { tokenSymbol: "CVX", action: "Swap", protocol: "Curve" },
        { tokenSymbol: "CVX", action: "Mint", protocol: "Pirex" },
        { tokenSymbol: "pxCVX", action: "Receive", protocol: "Pirex" },
      ],
      hybrid: {
        swapAmount: (18_043n * 10n ** 18n).toString(),
        mintAmount: (81_957n * 10n ** 18n).toString(),
        swapBonus: 0.0067,
        swapProtocol: "Curve",
        mintProtocol: "Pirex",
      },
    };

    expect(routeHasSwap(routeInfo)).toBe(true);
    expect(routeHasEnsoSwap(routeInfo)).toBe(false);
    expect(calculateCvxLegPriceImpact({
      inputUsd: 167_339.2,
      cvxUsd: 1.673392,
      routeInfo,
    })).toBeNull();
  });

  it("can derive CVX-leg impact from raw route step amounts", () => {
    const routeInfo: RouteInfo = {
      steps: [
        { tokenSymbol: "USDC", action: "Swap", protocol: "Enso" },
        {
          tokenSymbol: "CVX",
          tokenAddress: "0x4e3FBD56CD56c3e72c1403e103b45d2fB6b4ccd",
          action: "Swap",
          protocol: "Curve",
          rawAmount: (49n * 10n ** 18n).toString(),
        },
      ],
    };

    expect(calculateCvxLegPriceImpact({
      inputUsd: 100,
      cvxUsd: 2,
      routeInfo,
    })).toBe(2);
  });

  it("adds slippage only to the Enso step when impact is meaningful", () => {
    const routeInfo: RouteInfo = {
      steps: [
        { tokenSymbol: "USDC", action: "Swap", protocol: "Enso" },
        { tokenSymbol: "CVX", action: "Swap", protocol: "Curve" },
      ],
    };

    const annotated = annotateEnsoStepSlippage(routeInfo, 0.75);

    expect(annotated?.steps[0].slippage).toBe(0.75);
    expect(annotated?.steps[1].slippage).toBeUndefined();
  });
});
