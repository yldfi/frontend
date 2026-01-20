/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReadContracts, useAccount } from "wagmi";
import { useTokenMetadata } from "@/hooks/useTokenMetadata";

// Get the mocked functions
const mockUseReadContracts = vi.mocked(useReadContracts);
const mockUseAccount = vi.mocked(useAccount);

describe("useTokenMetadata", () => {
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
      chain: { id: 1, name: "mainnet" },
      chainId: 1,
      connector: undefined,
    } as any);
  });

  describe("address validation", () => {
    it("returns isValidAddress true for valid address", () => {
      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
        isPending: false,
        isSuccess: false,
        status: "pending",
        dataUpdatedAt: 0,
        errorUpdatedAt: 0,
        failureCount: 0,
        failureReason: null,
        errorUpdateCount: 0,
        isFetched: false,
        isFetchedAfterMount: false,
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

      const { result } = renderHook(() =>
        useTokenMetadata("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
      );

      expect(result.current.isValidAddress).toBe(true);
    });

    it("returns isValidAddress false for invalid address", () => {
      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
        isPending: false,
        isSuccess: false,
        status: "pending",
        dataUpdatedAt: 0,
        errorUpdatedAt: 0,
        failureCount: 0,
        failureReason: null,
        errorUpdateCount: 0,
        isFetched: false,
        isFetchedAfterMount: false,
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

      const { result } = renderHook(() => useTokenMetadata("not-an-address"));

      expect(result.current.isValidAddress).toBe(false);
      expect(result.current.token).toBeNull();
    });

    it("returns isValidAddress false for undefined address", () => {
      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
        isPending: false,
        isSuccess: false,
        status: "pending",
        dataUpdatedAt: 0,
        errorUpdatedAt: 0,
        failureCount: 0,
        failureReason: null,
        errorUpdateCount: 0,
        isFetched: false,
        isFetchedAfterMount: false,
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

      const { result } = renderHook(() => useTokenMetadata(undefined));

      expect(result.current.isValidAddress).toBe(false);
      expect(result.current.token).toBeNull();
    });

    it("returns isValidAddress false for empty string", () => {
      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
        isPending: false,
        isSuccess: false,
        status: "pending",
        dataUpdatedAt: 0,
        errorUpdatedAt: 0,
        failureCount: 0,
        failureReason: null,
        errorUpdateCount: 0,
        isFetched: false,
        isFetchedAfterMount: false,
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

      const { result } = renderHook(() => useTokenMetadata(""));

      expect(result.current.isValidAddress).toBe(false);
    });
  });

  describe("loading state", () => {
    it("returns isLoading true when fetching", () => {
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

      const { result } = renderHook(() =>
        useTokenMetadata("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
      );

      expect(result.current.isLoading).toBe(true);
      expect(result.current.token).toBeNull();
    });
  });

  describe("successful token fetch", () => {
    it("creates token from successful contract calls", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: "USD Coin", status: "success" },
          { result: "USDC", status: "success" },
          { result: 6, status: "success" },
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

      const { result } = renderHook(() =>
        useTokenMetadata("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
      );

      expect(result.current.token).not.toBeNull();
      expect(result.current.token?.name).toBe("USD Coin");
      expect(result.current.token?.symbol).toBe("USDC");
      expect(result.current.token?.decimals).toBe(6);
      expect(result.current.token?.chainId).toBe(1);
      expect(result.current.token?.type).toBe("base");
      expect(result.current.token?.address).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    });

    it("creates token with 18 decimals", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: "Wrapped Ether", status: "success" },
          { result: "WETH", status: "success" },
          { result: 18, status: "success" },
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

      const { result } = renderHook(() =>
        useTokenMetadata("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2")
      );

      expect(result.current.token?.decimals).toBe(18);
    });
  });

  describe("failed contract calls", () => {
    it("returns null token when name call fails", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: undefined, status: "failure" },
          { result: "USDC", status: "success" },
          { result: 6, status: "success" },
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

      const { result } = renderHook(() =>
        useTokenMetadata("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
      );

      expect(result.current.token).toBeNull();
    });

    it("returns null token when symbol call fails", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: "USD Coin", status: "success" },
          { result: undefined, status: "failure" },
          { result: 6, status: "success" },
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

      const { result } = renderHook(() =>
        useTokenMetadata("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
      );

      expect(result.current.token).toBeNull();
    });

    it("returns null token when decimals call fails", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: "USD Coin", status: "success" },
          { result: "USDC", status: "success" },
          { result: undefined, status: "failure" },
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

      const { result } = renderHook(() =>
        useTokenMetadata("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
      );

      expect(result.current.token).toBeNull();
    });
  });

  describe("error handling", () => {
    it("returns error when contract call errors", () => {
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

      const { result } = renderHook(() =>
        useTokenMetadata("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
      );

      expect(result.current.error).toBe(testError);
      expect(result.current.token).toBeNull();
    });
  });

  describe("chainId handling", () => {
    it("uses connected chainId for token", () => {
      mockUseAccount.mockReturnValue({
        address: "0x1234567890123456789012345678901234567890" as `0x${string}`,
        isConnected: true,
        isConnecting: false,
        isDisconnected: false,
        isReconnecting: false,
        status: "connected",
        addresses: ["0x1234567890123456789012345678901234567890" as `0x${string}`],
        chain: { id: 42161, name: "arbitrum" },
        chainId: 42161,
        connector: undefined,
      } as any);

      mockUseReadContracts.mockReturnValue({
        data: [
          { result: "Arbitrum Token", status: "success" },
          { result: "ARB", status: "success" },
          { result: 18, status: "success" },
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

      const { result } = renderHook(() =>
        useTokenMetadata("0x912ce59144191c1204e64559fe8253a0e49e6548")
      );

      expect(result.current.token?.chainId).toBe(42161);
    });

    it("defaults to chainId 1 when undefined", () => {
      mockUseAccount.mockReturnValue({
        address: undefined,
        isConnected: false,
        isConnecting: false,
        isDisconnected: true,
        isReconnecting: false,
        status: "disconnected",
        addresses: undefined,
        chain: undefined,
        chainId: undefined,
        connector: undefined,
      } as any);

      mockUseReadContracts.mockReturnValue({
        data: [
          { result: "Test Token", status: "success" },
          { result: "TEST", status: "success" },
          { result: 18, status: "success" },
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

      const { result } = renderHook(() =>
        useTokenMetadata("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
      );

      expect(result.current.token?.chainId).toBe(1);
    });
  });
});
