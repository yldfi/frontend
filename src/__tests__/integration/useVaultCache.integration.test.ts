import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { useVaultCache } from "@/hooks/useVaultCache";

// Get the mocked function
const mockUseQuery = vi.mocked(useQuery);

describe("useVaultCache integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockCacheResponse = {
    ycvxcrv: {
      address: "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86",
      totalAssets: "1500000000000000000000000",
      pricePerShare: "1050000000000000000",
      tvl: 1500000,
      pps: 1.05,
      tvlUsd: 1395000,
    },
    yscvxcrv: {
      address: "0x27B5739e22ad9033bcBf192059122d163b60349D",
      totalAssets: "500000000000000000000000",
      pricePerShare: "1020000000000000000",
      tvl: 500000,
      pps: 1.02,
      tvlUsd: 465000,
    },
    cvxCrvPrice: 0.93,
    lastUpdated: "2024-01-15T12:00:00Z",
  };

  it("returns vault cache data when loaded", () => {
    mockUseQuery.mockReturnValue({
      data: mockCacheResponse,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useVaultCache());

    expect(result.current.data).toBeDefined();
    expect(result.current.data?.ycvxcrv.pps).toBe(1.05);
    expect(result.current.data?.yscvxcrv.pps).toBe(1.02);
    expect(result.current.data?.cvxCrvPrice).toBe(0.93);
  });

  it("returns loading state", () => {
    mockUseQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useVaultCache());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
  });

  it("returns error state", () => {
    const testError = new Error("Failed to fetch vault cache");
    mockUseQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: testError,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useVaultCache());

    expect(result.current.error).toBe(testError);
    expect(result.current.data).toBeUndefined();
  });

  it("provides ycvxcrv vault data", () => {
    mockUseQuery.mockReturnValue({
      data: mockCacheResponse,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useVaultCache());

    const ycvxcrv = result.current.data?.ycvxcrv;
    expect(ycvxcrv?.address).toBe("0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86");
    expect(ycvxcrv?.tvl).toBe(1500000);
    expect(ycvxcrv?.tvlUsd).toBe(1395000);
  });

  it("provides yscvxcrv vault data", () => {
    mockUseQuery.mockReturnValue({
      data: mockCacheResponse,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useVaultCache());

    const yscvxcrv = result.current.data?.yscvxcrv;
    expect(yscvxcrv?.address).toBe("0x27B5739e22ad9033bcBf192059122d163b60349D");
    expect(yscvxcrv?.tvl).toBe(500000);
    expect(yscvxcrv?.tvlUsd).toBe(465000);
  });

  it("provides cvxCRV price", () => {
    mockUseQuery.mockReturnValue({
      data: mockCacheResponse,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useVaultCache());

    expect(result.current.data?.cvxCrvPrice).toBe(0.93);
  });

  it("provides lastUpdated timestamp", () => {
    mockUseQuery.mockReturnValue({
      data: mockCacheResponse,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useVaultCache());

    expect(result.current.data?.lastUpdated).toBe("2024-01-15T12:00:00Z");
  });

  it("calls useQuery with correct configuration", () => {
    mockUseQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useQuery>);

    renderHook(() => useVaultCache());

    expect(mockUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["vault-cache"],
        staleTime: 60000,
        gcTime: 300000,
        refetchInterval: 60000,
      })
    );
  });
});
