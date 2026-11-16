import { describe, expect, it } from "vitest";

import { parseStoredToken, toStoredToken } from "@/lib/stored-token";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

describe("toStoredToken", () => {
  it("accepts a token written by this build", () => {
    expect(
      toStoredToken({
        address: USDC,
        chainId: 1,
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        logoURI: "/tokens/usdc.png",
        type: "base",
      }),
    ).toEqual({
      address: USDC,
      chainId: 1,
      name: "USD Coin",
      symbol: "USDC",
      decimals: 6,
      logoURI: "/tokens/usdc.png",
      type: "base",
    });
  });

  it("rejects a token without decimals", () => {
    expect(toStoredToken({ address: USDC, chainId: 1, symbol: "USDC" })).toBeUndefined();
  });

  it("rejects non-numeric decimals", () => {
    expect(
      toStoredToken({ address: USDC, chainId: 1, symbol: "USDC", decimals: "6" }),
    ).toBeUndefined();
    expect(
      toStoredToken({ address: USDC, chainId: 1, symbol: "USDC", decimals: 6.5 }),
    ).toBeUndefined();
  });

  it("rejects a bad address", () => {
    expect(
      toStoredToken({ address: "not-an-address", chainId: 1, symbol: "USDC", decimals: 6 }),
    ).toBeUndefined();
  });

  it("ignores extra fields", () => {
    expect(
      toStoredToken({
        address: USDC,
        chainId: 1,
        symbol: "USDC",
        decimals: 6,
        fromUrl: "https://example.invalid/evil",
      }),
    ).toEqual({
      address: USDC,
      chainId: 1,
      name: "USDC",
      symbol: "USDC",
      decimals: 6,
      logoURI: undefined,
      type: "base",
    });
  });
});

describe("parseStoredToken", () => {
  it("parses a valid JSON entry", () => {
    expect(
      parseStoredToken(JSON.stringify({ address: USDC, symbol: "USDC", decimals: 6 })),
    ).toMatchObject({ address: USDC, symbol: "USDC", decimals: 6 });
  });

  it("rejects non-JSON and empty values", () => {
    expect(parseStoredToken("not json")).toBeUndefined();
    expect(parseStoredToken("")).toBeUndefined();
    expect(parseStoredToken(null)).toBeUndefined();
    expect(parseStoredToken(undefined)).toBeUndefined();
  });
});
