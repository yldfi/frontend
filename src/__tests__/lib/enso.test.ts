import { describe, it, expect } from "vitest";

import {
  CVXCRV_ADDRESS,
  ENSO_ROUTER,
  ENSO_ROUTER_V2,
  ETH_ADDRESS,
  YLDFI_VAULT_ADDRESSES,
  filterTokens,
  isYldfiVault,
  sortTokensByPopularity,
} from "@/lib/enso";
import type { EnsoToken } from "@/types/enso";

const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI_ADDRESS = "0x6B175474E89094C44da98B954EeDcDecB5BE4dBf";
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const CRV_ADDRESS = "0xD533a949740bb3306d119CC777fa900bA034cd52";

function token(symbol: string, address: string, name = symbol): EnsoToken {
  return { address, chainId: 1, name, symbol, decimals: 18, type: "base" };
}

describe("isYldfiVault", () => {
  it("identifies both yld vaults regardless of address casing", () => {
    expect(isYldfiVault("0x95f19b19aff698169a1a0bbc28a2e47b14cb9a86")).toBe(true);
    expect(isYldfiVault("0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86")).toBe(true);
    expect(isYldfiVault("0xca960e6df1150100586c51382f619efcccf72706")).toBe(true);
    expect(isYldfiVault("0xCa960E6DF1150100586c51382f619efCCcF72706")).toBe(true);
    expect(isYldfiVault(YLDFI_VAULT_ADDRESSES.ycvxCRV)).toBe(true);
    expect(isYldfiVault(YLDFI_VAULT_ADDRESSES.yscvxCRV)).toBe(true);
  });

  it("rejects tokens that are not yld vaults", () => {
    expect(isYldfiVault(ETH_ADDRESS)).toBe(false);
    expect(isYldfiVault(USDC_ADDRESS)).toBe(false);
    expect(isYldfiVault("0x1234567890abcdef1234567890abcdef12345678")).toBe(false);
    expect(isYldfiVault(CVXCRV_ADDRESS)).toBe(false);
    expect(isYldfiVault(ENSO_ROUTER_V2)).toBe(false);
  });
});

describe("sortTokensByPopularity", () => {
  it("sorts ETH before USDC and USDC before DAI", () => {
    const sorted = sortTokensByPopularity([
      token("DAI", DAI_ADDRESS),
      token("USDC", USDC_ADDRESS),
      token("ETH", ETH_ADDRESS),
    ]);

    expect(sorted.map((t) => t.symbol)).toEqual(["ETH", "USDC", "DAI"]);
  });

  it("puts popular tokens before non-popular tokens", () => {
    const sorted = sortTokensByPopularity([
      token("RANDOM", "0x0000000000000000000000000000000000000001"),
      token("ETH", ETH_ADDRESS),
    ]);

    expect(sorted.map((t) => t.symbol)).toEqual(["ETH", "RANDOM"]);
  });

  it("keeps the relative order of non-popular tokens", () => {
    const sorted = sortTokensByPopularity([
      token("AAA", "0x0000000000000000000000000000000000000001"),
      token("BBB", "0x0000000000000000000000000000000000000002"),
      token("CCC", "0x0000000000000000000000000000000000000003"),
    ]);

    expect(sorted.map((t) => t.symbol)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("matches popular addresses case-insensitively", () => {
    const sorted = sortTokensByPopularity([
      token("USDC", USDC_ADDRESS.toLowerCase()),
      token("ETH", ETH_ADDRESS.toUpperCase()),
    ]);

    expect(sorted.map((t) => t.symbol)).toEqual(["ETH", "USDC"]);
  });

  it("sorts several popular tokens by their configured position", () => {
    const sorted = sortTokensByPopularity([
      token("ycvxCRV", YLDFI_VAULT_ADDRESSES.ycvxCRV),
      token("CRV", CRV_ADDRESS),
      token("ETH", ETH_ADDRESS),
      token("USDC", USDC_ADDRESS),
    ]);

    expect(sorted.map((t) => t.symbol)).toEqual(["ETH", "USDC", "CRV", "ycvxCRV"]);
  });

  it("does not mutate the input array", () => {
    const tokens = [token("USDC", USDC_ADDRESS), token("ETH", ETH_ADDRESS)];

    sortTokensByPopularity(tokens);

    expect(tokens.map((t) => t.symbol)).toEqual(["USDC", "ETH"]);
  });

  it("handles empty and single-token lists", () => {
    expect(sortTokensByPopularity([])).toEqual([]);

    const single = sortTokensByPopularity([token("ETH", ETH_ADDRESS)]);
    expect(single.map((t) => t.symbol)).toEqual(["ETH"]);
  });
});

describe("filterTokens", () => {
  const testTokens = [
    token("ETH", ETH_ADDRESS, "Ethereum"),
    token("USDC", USDC_ADDRESS, "USD Coin"),
    token("WETH", WETH_ADDRESS, "Wrapped Ether"),
    token("cvxCRV", CVXCRV_ADDRESS, "Convex CRV"),
  ];

  it("returns all tokens for an empty query", () => {
    expect(filterTokens(testTokens, "")).toEqual(testTokens);
  });

  it("filters by symbol case-insensitively", () => {
    const lower = filterTokens(testTokens, "eth");
    const upper = filterTokens(testTokens, "USDC");
    const mixed = filterTokens(testTokens, "EtH");

    expect(lower.map((t) => t.symbol)).toEqual(["ETH", "WETH"]);
    expect(upper.map((t) => t.symbol)).toEqual(["USDC"]);
    expect(mixed.map((t) => t.symbol)).toEqual(["ETH", "WETH"]);
  });

  it("filters by name case-insensitively", () => {
    expect(filterTokens(testTokens, "coin").map((t) => t.symbol)).toEqual(["USDC"]);
    expect(filterTokens(testTokens, "Convex").map((t) => t.symbol)).toEqual(["cvxCRV"]);
  });

  it("matches a partial symbol", () => {
    expect(filterTokens(testTokens, "cvx").map((t) => t.symbol)).toEqual(["cvxCRV"]);
  });

  it("matches an exact address case-insensitively but not a partial address", () => {
    expect(filterTokens(testTokens, ETH_ADDRESS.toLowerCase()).map((t) => t.symbol)).toEqual(["ETH"]);
    expect(filterTokens(testTokens, "0xeeee")).toEqual([]);
  });

  it("returns no tokens when nothing matches or the list is empty", () => {
    expect(filterTokens(testTokens, "NOTFOUND")).toEqual([]);
    expect(filterTokens([], "eth")).toEqual([]);
  });
});

describe("Enso address constants", () => {
  it("keeps the Enso ETH placeholder", () => {
    expect(ETH_ADDRESS).toBe("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  });

  it("keeps ENSO_ROUTER as the legacy Router V1 alias", () => {
    expect(ENSO_ROUTER).toBe("0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E");
  });

  it("uses ENSO_ROUTER_V2 as the current approval spender", () => {
    expect(ENSO_ROUTER_V2).toBe("0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf");
  });
});
