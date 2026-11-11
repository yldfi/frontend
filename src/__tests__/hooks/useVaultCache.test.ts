import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";

import { useVaultCache, type VaultCacheResponse } from "@/hooks/useVaultCache";

const CACHE: VaultCacheResponse = {
  ycvxcrv: {
    address: "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86",
    totalAssets: "1000000000000000000000",
    pricePerShare: "1050000000000000000",
    tvl: 1000,
    pps: 1.05,
    tvlUsd: 930,
    apy: 4.2,
  },
  yscvxcrv: {
    address: "0xCa960E6DF1150100586c51382f619efCCcF72706",
    totalAssets: "500000000000000000000",
    pricePerShare: "1020000000000000000",
    tvl: 500,
    pps: 1.02,
    tvlUsd: 465,
    apy: null,
  },
  yscvx: {
    address: "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e",
    totalAssets: "0",
    pricePerShare: "1000000000000000000",
    tvl: 0,
    pps: 1,
    tvlUsd: 0,
    apy: null,
  },
  yspxcvx: {
    address: "0x0000000000000000000000000000000000000001",
    totalAssets: "0",
    pricePerShare: "1000000000000000000",
    tvl: 0,
    pps: 1,
    tvlUsd: 0,
    apy: null,
  },
  cvxCrvPrice: 0.93,
  pxCvxPrice: 1.94,
  cvxPrice: 1.93,
  lastUpdated: "2026-11-10T12:00:00Z",
};

type QueryOptions = {
  queryKey: string[];
  queryFn: () => Promise<VaultCacheResponse>;
};

function captureQuery() {
  renderHook(() => useVaultCache());
  const [options] = vi.mocked(useQuery).mock.calls.at(-1)! as unknown as [QueryOptions];
  return options;
}

describe("useVaultCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useQuery).mockReturnValue({
      data: CACHE,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useQuery>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the cache payload from the query", () => {
    const { result } = renderHook(() => useVaultCache());

    expect(result.current.data).toBe(CACHE);
  });

  it("requests the vault cache proxy and parses its JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(CACHE)));

    const response = await captureQuery().queryFn();

    expect(fetch).toHaveBeenCalledWith(
      "/api/vaults",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(response).toEqual(CACHE);
  });

  it("fails the query when the cache proxy errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502 })));

    await expect(captureQuery().queryFn()).rejects.toThrow("Failed to fetch vault cache");
  });

  it("reads the cache under one stable key", () => {
    expect(captureQuery().queryKey).toEqual(["vault-cache"]);
  });

  it("passes loading and error state through", () => {
    const error = new Error("boom");
    vi.mocked(useQuery).mockReturnValue({
      data: undefined,
      isLoading: true,
      error,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useVaultCache());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBe(error);
  });
});
