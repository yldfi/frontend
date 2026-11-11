import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";

import { formatYearnVaultData, useYearnVault } from "@/hooks/useYearnVault";
import { formatUsd } from "@/lib/utils";

const VAULT = "0x27B5739e22ad9033bcBf192059122d163b60349D";

type QueryOptions = {
  queryKey: unknown[];
  queryFn: () => Promise<unknown>;
  enabled: boolean;
};

function captureQuery(address: string, chainId?: number) {
  renderHook(() => useYearnVault(address, chainId));
  const [options] = vi.mocked(useQuery).mock.calls.at(-1)! as unknown as [QueryOptions];
  return options;
}

function vaultFixture(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 1,
    address: VAULT,
    name: "ycvxCRV Vault",
    symbol: "ycvxCRV",
    asset: {
      address: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7",
      name: "Convex CRV",
      symbol: "cvxCRV",
      decimals: 18,
    },
    accountant: "0x1234567890123456789012345678901234567890",
    pricePerShare: "1050000000000000000",
    totalAssets: "1000000000000000000000",
    totalDebt: "900000000000000000000",
    fees: { managementFee: 0, performanceFee: 1000 },
    tvl: { close: 1500000 },
    apy: { close: 0.155, grossApr: 0.1824, weeklyNet: 0.1485, monthlyNet: 0.1527, inceptionNet: 0.1615 },
    debts: [],
    ...overrides,
  };
}

describe("useYearnVault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useQuery>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keys the query by chain and vault address", () => {
    expect(captureQuery(VAULT, 1).queryKey).toEqual(["yearn-vault", 1, VAULT]);
    expect(captureQuery(VAULT, 8453).queryKey).toEqual(["yearn-vault", 8453, VAULT]);
  });

  it("gives Kong's proxy the chain and address and returns the vault payload", async () => {
    const data = { vault: vaultFixture(), vaultStrategies: [] };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data })));

    await expect(captureQuery(VAULT, 1).queryFn()).resolves.toEqual(data);
    expect(fetch).toHaveBeenCalledWith(
      `/api/kong/vault?chainId=1&address=${encodeURIComponent(VAULT)}`,
    );
  });

  it("fails the query when Kong's proxy errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502 })));

    await expect(captureQuery(VAULT, 1).queryFn()).rejects.toThrow("Failed to fetch Yearn vault data");
  });

  it("queries a normal vault", () => {
    expect(captureQuery(VAULT).enabled).toBe(true);
  });

  it.each([
    ["an empty address", ""],
    ["the zero address", "0x0000000000000000000000000000000000000000"],
    ["yscvx (no Yearn vault)", "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e"],
    ["yspxcvx (no Yearn vault)", "0xB246DB2A73EEE3ee026153660c74657C123f8E42"],
  ])("does not query %s", (_label, address) => {
    expect(captureQuery(address).enabled).toBe(false);
  });
});

describe("formatYearnVaultData", () => {
  it("returns null without a vault", () => {
    expect(formatYearnVaultData(null)).toBeNull();
    expect(formatYearnVaultData(undefined)).toBeNull();
  });

  it("extracts the vault identity, asset and total assets", () => {
    const result = formatYearnVaultData(vaultFixture() as never, [
      { chainId: 1, address: "0x0000000000000000000000000000000000000001", name: "Strategy" },
    ]);

    expect(result).toMatchObject({
      name: "ycvxCRV Vault",
      symbol: "ycvxCRV",
      asset: {
        symbol: "cvxCRV",
        name: "Convex CRV",
        address: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7",
      },
      totalAssets: "1000000000000000000000",
      strategies: [{ chainId: 1, address: "0x0000000000000000000000000000000000000001", name: "Strategy" }],
    });
  });

  it.each([
    [1_500_000, "$1.50M"],
    [123_456_789, "$123.46M"],
    [50_000, "$50.0K"],
    [999_999, "$1000.0K"],
    [999.99, "$999.99"],
    [0, "$0.00"],
  ])("formats a TVL of %d as %s", (close, expected) => {
    const result = formatYearnVaultData(vaultFixture({ tvl: { close } }) as never);

    expect(result?.tvl).toBe(close);
    expect(result?.tvlFormatted).toBe(expected);
  });

  it("scales Kong's decimal APY values to percentages", () => {
    const result = formatYearnVaultData(vaultFixture() as never);

    expect(result).toMatchObject({
      apy: 15.5,
      apyFormatted: "15.50%",
      grossAprFormatted: "18.24%",
      weeklyApy: 14.85,
      weeklyApyFormatted: "14.85%",
      monthlyApy: 15.27,
      monthlyApyFormatted: "15.27%",
      inceptionApyFormatted: "16.15%",
    });
    expect(result?.grossApr).toBeCloseTo(18.24, 6);
    expect(result?.inceptionApy).toBeCloseTo(16.15, 6);
  });

  it("shows an off-scale APY as infinity", () => {
    const result = formatYearnVaultData(vaultFixture({
      apy: { close: 200, grossApr: 200, weeklyNet: 200, monthlyNet: 200, inceptionNet: 200 },
    }) as never);

    expect(result?.apyFormatted).toBe("∞");
  });

  it("derives the weekly APR by adding back the performance fee", () => {
    const result = formatYearnVaultData(vaultFixture() as never);

    expect(result?.weeklyApr).toBeCloseTo(16.5, 6);
    expect(result?.weeklyAprFormatted).toBe("16.50%");

    const fullyFeeVault = formatYearnVaultData(vaultFixture({
      fees: { managementFee: 0, performanceFee: 10000 },
    }) as never);
    expect(fullyFeeVault?.weeklyApr).toBe(0);
    expect(fullyFeeVault?.weeklyAprFormatted).toBe("0.00%");
  });

  it("scales price per share by the asset decimals", () => {
    expect(formatYearnVaultData(vaultFixture() as never)).toMatchObject({
      pricePerShare: 1.05,
      pricePerShareFormatted: "1.0500",
    });

    const sixDecimals = formatYearnVaultData(vaultFixture({
      asset: { address: "0x0000000000000000000000000000000000000002", name: "USD Coin", symbol: "USDC", decimals: 6 },
      pricePerShare: "1050000",
    }) as never);
    expect(sixDecimals?.pricePerShare).toBe(1.05);
    expect(sixDecimals?.pricePerShareFormatted).toBe("1.0500");
  });

  it("formats the fee fields", () => {
    const result = formatYearnVaultData(vaultFixture({
      fees: { managementFee: 200, performanceFee: 1500 },
    }) as never);

    expect(result).toMatchObject({
      managementFee: 200,
      managementFeeFormatted: "2.00%",
      performanceFee: 1500,
      performanceFeeFormatted: "15%",
    });
  });

  it("defaults missing TVL, APY and fees instead of throwing", () => {
    const result = formatYearnVaultData({
      ...vaultFixture(),
      tvl: undefined,
      apy: undefined,
      fees: null,
    } as never);

    expect(result).toMatchObject({
      tvl: 0,
      tvlFormatted: "$0.00",
      apy: 0,
      apyFormatted: "0.00%",
      managementFeeFormatted: "0.00%",
      performanceFeeFormatted: "0%",
      weeklyApr: 0,
    });
  });
});

describe("formatUsd", () => {
  it.each([
    [0, "$0.00"],
    [0.5, "$0.50"],
    [99.99, "$99.99"],
    [999.99, "$999.99"],
    [1000, "$1.0K"],
    [1500, "$1.5K"],
    [999999, "$1000.0K"],
    [1000000, "$1.00M"],
    [1234567, "$1.23M"],
  ])("formats %d as %s", (value, expected) => {
    expect(formatUsd(value)).toBe(expected);
  });
});
