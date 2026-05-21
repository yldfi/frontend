import { describe, it, expect } from "vitest";
import { applyKnownTokenMetadata, getTokenSymbol } from "@/lib/enso";

describe("getTokenSymbol", () => {
  it("returns symbol for a known CUSTOM_TOKENS entry (crvUSD)", () => {
    expect(getTokenSymbol("0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E")).toBe(
      "crvUSD"
    );
  });

  it("is case-insensitive for CUSTOM_TOKENS lookup", () => {
    expect(getTokenSymbol("0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E")).toBe(
      "crvUSD"
    );
  });

  it("returns symbol for a TOKEN_SYMBOLS entry (aCVX)", () => {
    expect(getTokenSymbol("0xb0903ab70a7467ee5756074b31ac88aebb8fb777")).toBe(
      "aCVX"
    );
  });

  it("returns symbol for a vault address (ycvxCRV)", () => {
    expect(getTokenSymbol("0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86")).toBe(
      "ycvxCRV"
    );
  });

  it("returns shortened address for unknown token", () => {
    expect(getTokenSymbol("0x1234567890abcdef1234567890abcdef12345678")).toBe(
      "0x1234...5678"
    );
  });

  it("returns WETH for known address", () => {
    expect(getTokenSymbol("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")).toBe(
      "WETH"
    );
  });

  it("returns lpxCVX for Pirex token", () => {
    expect(getTokenSymbol("0x389fb29230d02e67eb963c1f5a00f2b16f95beb7")).toBe(
      "lpxCVX"
    );
  });

  it("handles mixed-case checksummed addresses correctly", () => {
    // Uppercase version of the aCVX address
    expect(getTokenSymbol("0xb0903Ab70a7467eE5756074b31ac88aEBb8fB777")).toBe(
      "aCVX"
    );
  });

  it("normalizes stale crvUSD metadata to the local custom token entry", () => {
    expect(
      applyKnownTokenMetadata({
        address: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
        chainId: 1,
        name: "Curve.Fi USD Stablecoin",
        symbol: "crvUSD",
        decimals: 18,
        logoURI: "https://assets.coingecko.com/coins/images/30118/thumb/crvusd.jpeg",
        type: "base" as const,
      }),
    ).toMatchObject({
      name: "crvUSD",
      symbol: "crvUSD",
      decimals: 18,
      logoURI: "/tokens/crvusd.png",
      type: "base",
    });
  });
});
