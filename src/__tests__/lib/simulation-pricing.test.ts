import { describe, expect, it } from "vitest";

import { TOKENS } from "@/config/vaults";
import {
  getSimulationPriceLookupAddresses,
  isCvxEquivalentPriceToken,
  resolveSimulationDollarValue,
  resolveSimulationTokenPrice,
} from "@/lib/simulation-pricing";

describe("simulation pricing fallbacks", () => {
  it("flags cvx-equivalent wrapper tokens for fallback pricing", () => {
    expect(isCvxEquivalentPriceToken(TOKENS.PXCVX)).toBe(true);
    expect(isCvxEquivalentPriceToken(TOKENS.LPXCVX)).toBe(true);
    expect(isCvxEquivalentPriceToken(TOKENS.CVGCVX)).toBe(true);
    expect(isCvxEquivalentPriceToken(TOKENS.CVX)).toBe(false);
  });

  it("adds CVX to lookup addresses when a wrapped CVX token is present", () => {
    expect(
      getSimulationPriceLookupAddresses([TOKENS.PXCVX, TOKENS.PXCVX, TOKENS.CVXCRV]),
    ).toEqual([
      TOKENS.PXCVX.toLowerCase(),
      TOKENS.CVXCRV.toLowerCase(),
      TOKENS.CVX.toLowerCase(),
    ]);
  });

  it("uses a direct price when one exists", () => {
    const priceMap = new Map<string, number>([
      [TOKENS.PXCVX.toLowerCase(), 3.25],
      [TOKENS.CVX.toLowerCase(), 2.5],
    ]);

    expect(resolveSimulationTokenPrice(TOKENS.PXCVX, priceMap)).toBe(3.25);
  });

  it("falls back to CVX price when a wrapped CVX token has no direct price", () => {
    const priceMap = new Map<string, number>([
      [TOKENS.CVX.toLowerCase(), 2.5],
    ]);

    expect(resolveSimulationTokenPrice(TOKENS.PXCVX, priceMap)).toBe(2.5);
    expect(resolveSimulationTokenPrice(TOKENS.LPXCVX, priceMap)).toBe(2.5);
    expect(resolveSimulationTokenPrice(TOKENS.CVGCVX, priceMap)).toBe(2.5);
  });

  it("treats zero direct prices as missing and falls back to CVX", () => {
    const priceMap = new Map<string, number>([
      [TOKENS.PXCVX.toLowerCase(), 0],
      [TOKENS.CVX.toLowerCase(), 2.5],
    ]);

    expect(resolveSimulationTokenPrice(TOKENS.PXCVX, priceMap)).toBe(2.5);
  });

  it("does not invent fallback prices for unrelated assets", () => {
    const priceMap = new Map<string, number>([
      [TOKENS.CVX.toLowerCase(), 2.5],
    ]);

    expect(resolveSimulationTokenPrice(TOKENS.CVXCRV, priceMap)).toBeUndefined();
  });

  it("prices vault shares from their underlying using CVX fallback pricing", () => {
    const priceMap = new Map<string, number>([
      [TOKENS.CVX.toLowerCase(), 2.5],
    ]);

    expect(
      resolveSimulationDollarValue({
        address: "0xdeadbeef",
        rawAmount: "5441668000000000000",
        decimals: 18,
        priceMap,
        vaultInfo: {
          underlying: TOKENS.PXCVX,
          underlyingDecimals: 18,
        },
        underlyingAmount: "7976000000000000000",
      }),
    ).toBe("19.94");
  });

  it("prefers a direct token price before vault underlying pricing", () => {
    const priceMap = new Map<string, number>([
      ["0xdeadbeef", 4],
      [TOKENS.CVX.toLowerCase(), 2.5],
    ]);

    expect(
      resolveSimulationDollarValue({
        address: "0xdeadbeef",
        rawAmount: "5000000000000000000",
        decimals: 18,
        priceMap,
        vaultInfo: {
          underlying: TOKENS.PXCVX,
          underlyingDecimals: 18,
        },
        underlyingAmount: "10000000000000000000",
      }),
    ).toBe("20");
  });
});
