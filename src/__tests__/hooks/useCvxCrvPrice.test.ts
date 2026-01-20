/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReadContracts, useAccount } from "wagmi";
import { useCvxCrvPrice } from "@/hooks/useCvxCrvPrice";

// Get the mocked functions
const mockUseReadContracts = vi.mocked(useReadContracts);
const mockUseAccount = vi.mocked(useAccount);

describe("useCvxCrvPrice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAccount.mockReturnValue({
      address: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      isConnected: true,
      isConnecting: false,
      isDisconnected: false,
      isReconnecting: false,
      status: "connected",
      addresses: ["0x1234567890123456789012345678901234567890" as `0x${string}`],
      chain: undefined,
      chainId: 1,
      connector: undefined,
    } as any);
  });

  it("returns loading state when data is loading", () => {
    mockUseReadContracts.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      isError: false,
      isPending: true,
      isSuccess: false,
      status: "pending",
      dataUpdatedAt: 0,
      errorUpdatedAt: 0,
      failureCount: 0,
      failureReason: null,
      errorUpdateCount: 0,
      isFetched: false,
      isFetchedAfterMount: false,
      isFetching: true,
      isInitialLoading: true,
      isLoadingError: false,
      isPaused: false,
      isPlaceholderData: false,
      isRefetchError: false,
      isRefetching: false,
      isStale: false,
      fetchStatus: "fetching",
      refetch: vi.fn(),
    } as any);

    const { result } = renderHook(() => useCvxCrvPrice());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.price).toBe(0);
  });

  it("calculates price from oracle data", () => {
    // cvxCRV/crvUSD = 0.95 (18 decimals)
    const cvxCrvInCrvUsd = BigInt("950000000000000000"); // 0.95
    // crvUSD/USD = 0.999 (8 decimals)
    const crvUsdInUsd = BigInt("99900000"); // 0.999

    mockUseReadContracts.mockReturnValue({
      data: [
        { result: cvxCrvInCrvUsd, status: "success" },
        { result: crvUsdInUsd, status: "success" },
      ],
      isLoading: false,
      error: null,
      isError: false,
      isPending: false,
      isSuccess: true,
      status: "success",
      dataUpdatedAt: Date.now(),
      errorUpdatedAt: 0,
      failureCount: 0,
      failureReason: null,
      errorUpdateCount: 0,
      isFetched: true,
      isFetchedAfterMount: true,
      isFetching: false,
      isInitialLoading: false,
      isLoadingError: false,
      isPaused: false,
      isPlaceholderData: false,
      isRefetchError: false,
      isRefetching: false,
      isStale: false,
      fetchStatus: "idle",
      refetch: vi.fn(),
    } as any);

    const { result } = renderHook(() => useCvxCrvPrice());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.cvxCrvInCrvUsd).toBeCloseTo(0.95, 2);
    expect(result.current.crvUsdInUsd).toBeCloseTo(0.999, 3);
    // price = 0.95 * 0.999 ≈ 0.94905
    expect(result.current.price).toBeCloseTo(0.949, 2);
  });

  it("returns zero when data is undefined", () => {
    mockUseReadContracts.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
      isError: false,
      isPending: false,
      isSuccess: false,
      status: "success",
      dataUpdatedAt: 0,
      errorUpdatedAt: 0,
      failureCount: 0,
      failureReason: null,
      errorUpdateCount: 0,
      isFetched: true,
      isFetchedAfterMount: true,
      isFetching: false,
      isInitialLoading: false,
      isLoadingError: false,
      isPaused: false,
      isPlaceholderData: false,
      isRefetchError: false,
      isRefetching: false,
      isStale: false,
      fetchStatus: "idle",
      refetch: vi.fn(),
    } as any);

    const { result } = renderHook(() => useCvxCrvPrice());

    expect(result.current.price).toBe(0);
    expect(result.current.cvxCrvInCrvUsd).toBe(0);
    expect(result.current.crvUsdInUsd).toBe(0);
  });

  it("handles error state", () => {
    const testError = new Error("Contract call failed");
    mockUseReadContracts.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: testError,
      isError: true,
      isPending: false,
      isSuccess: false,
      status: "error",
      dataUpdatedAt: 0,
      errorUpdatedAt: Date.now(),
      failureCount: 1,
      failureReason: testError,
      errorUpdateCount: 1,
      isFetched: true,
      isFetchedAfterMount: true,
      isFetching: false,
      isInitialLoading: false,
      isLoadingError: true,
      isPaused: false,
      isPlaceholderData: false,
      isRefetchError: false,
      isRefetching: false,
      isStale: false,
      fetchStatus: "idle",
      refetch: vi.fn(),
    } as any);

    const { result } = renderHook(() => useCvxCrvPrice());

    expect(result.current.error).toBe(testError);
    expect(result.current.price).toBe(0);
  });
});
