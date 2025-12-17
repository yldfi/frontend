import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReadContracts } from "wagmi";
import { usePricePerShare, useMultiplePricePerShare } from "@/hooks/usePricePerShare";

// Get the mocked function
const mockUseReadContracts = vi.mocked(useReadContracts);

describe("usePricePerShare integration", () => {
  const VAULT_ADDRESS = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86" as `0x${string}`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("usePricePerShare", () => {
    it("returns default values when loading", () => {
      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => usePricePerShare(VAULT_ADDRESS));

      expect(result.current.isLoading).toBe(true);
      expect(result.current.pricePerShare).toBe(1);
      expect(result.current.decimals).toBe(18);
    });

    it("returns correct price per share from contract data", () => {
      // Simulate: decimals = 18, convertToAssets(1e18) = 1.05e18
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: 18, status: "success" },
          { result: BigInt("1050000000000000000"), status: "success" }, // 1.05 PPS
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => usePricePerShare(VAULT_ADDRESS));

      expect(result.current.isLoading).toBe(false);
      expect(result.current.pricePerShare).toBe(1.05);
      expect(result.current.pricePerShareFormatted).toBe("1.0500");
      expect(result.current.decimals).toBe(18);
    });

    it("handles 1:1 price per share", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: 18, status: "success" },
          { result: BigInt("1000000000000000000"), status: "success" }, // 1.0 PPS
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => usePricePerShare(VAULT_ADDRESS));

      expect(result.current.pricePerShare).toBe(1);
      expect(result.current.pricePerShareFormatted).toBe("1.0000");
    });

    it("handles high price per share (2x gain)", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: 18, status: "success" },
          { result: BigInt("2000000000000000000"), status: "success" }, // 2.0 PPS
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => usePricePerShare(VAULT_ADDRESS));

      expect(result.current.pricePerShare).toBe(2);
    });

    it("returns error state", () => {
      const testError = new Error("Contract call failed");
      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: testError,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => usePricePerShare(VAULT_ADDRESS));

      expect(result.current.error).toBe(testError);
      expect(result.current.pricePerShare).toBe(1); // fallback
    });

    it("calls useReadContracts with correct parameters", () => {
      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      renderHook(() => usePricePerShare(VAULT_ADDRESS));

      expect(mockUseReadContracts).toHaveBeenCalledWith(
        expect.objectContaining({
          contracts: expect.arrayContaining([
            expect.objectContaining({
              address: VAULT_ADDRESS,
              functionName: "decimals",
            }),
            expect.objectContaining({
              address: VAULT_ADDRESS,
              functionName: "convertToAssets",
              args: [BigInt(10 ** 18)],
            }),
          ]),
          query: expect.objectContaining({
            staleTime: 60000,
            refetchInterval: 60000,
          }),
        })
      );
    });

    // Edge cases
    it("handles PPS < 1 (vault losing value)", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: 18, status: "success" },
          { result: BigInt("500000000000000000"), status: "success" }, // 0.5 PPS
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => usePricePerShare(VAULT_ADDRESS));

      expect(result.current.pricePerShare).toBe(0.5);
      expect(result.current.pricePerShareFormatted).toBe("0.5000");
    });

    it("handles extremely high PPS (100x gain)", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: 18, status: "success" },
          { result: BigInt("100000000000000000000"), status: "success" }, // 100 PPS
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => usePricePerShare(VAULT_ADDRESS));

      expect(result.current.pricePerShare).toBe(100);
    });

    it("handles 6 decimals (USDC-like vault)", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: 6, status: "success" },
          { result: BigInt("1050000"), status: "success" }, // 1.05 with 6 decimals
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => usePricePerShare(VAULT_ADDRESS));

      expect(result.current.decimals).toBe(6);
      // Note: The hook uses 10**18 for args regardless, so PPS calc depends on implementation
    });

    it("handles 8 decimals (WBTC-like vault)", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: 8, status: "success" },
          { result: BigInt("105000000"), status: "success" }, // 1.05 with 8 decimals
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => usePricePerShare(VAULT_ADDRESS));

      expect(result.current.decimals).toBe(8);
    });

    it("handles partial failure - decimals succeeds, convertToAssets fails", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: 18, status: "success" },
          { result: undefined, status: "failure" },
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => usePricePerShare(VAULT_ADDRESS));

      // Should fallback to default PPS of 1
      expect(result.current.pricePerShare).toBe(1);
    });

    it("handles partial failure - decimals fails, convertToAssets succeeds", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: undefined, status: "failure" },
          { result: BigInt("1050000000000000000"), status: "success" },
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => usePricePerShare(VAULT_ADDRESS));

      // Should use default decimals of 18
      expect(result.current.decimals).toBe(18);
    });

    it("handles zero PPS (vault exploited/drained) - falls back to 1", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: 18, status: "success" },
          { result: BigInt("0"), status: "success" }, // 0 PPS
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => usePricePerShare(VAULT_ADDRESS));

      // Hook returns fallback of 1 when PPS is 0 to avoid display/calculation issues
      expect(result.current.pricePerShare).toBe(1);
    });
  });

  describe("useMultiplePricePerShare", () => {
    const VAULT_ADDRESSES = [
      "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86" as `0x${string}`,
      "0x27B5739e22ad9033bcBf192059122d163b60349D" as `0x${string}`,
    ];

    it("returns prices for multiple vaults", () => {
      // Each vault has 2 results: decimals, convertToAssets
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: 18, status: "success" }, // vault 1 decimals
          { result: BigInt("1050000000000000000"), status: "success" }, // vault 1 PPS
          { result: 18, status: "success" }, // vault 2 decimals
          { result: BigInt("1100000000000000000"), status: "success" }, // vault 2 PPS
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() =>
        useMultiplePricePerShare(VAULT_ADDRESSES)
      );

      expect(result.current.prices).toHaveLength(2);
      expect(result.current.prices[0].pricePerShare).toBe(1.05);
      expect(result.current.prices[0].address).toBe(VAULT_ADDRESSES[0]);
      expect(result.current.prices[1].pricePerShare).toBe(1.1);
      expect(result.current.prices[1].address).toBe(VAULT_ADDRESSES[1]);
    });

    it("returns loading state", () => {
      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() =>
        useMultiplePricePerShare(VAULT_ADDRESSES)
      );

      expect(result.current.isLoading).toBe(true);
      expect(result.current.prices).toHaveLength(2);
      // Defaults to 1 when no data
      expect(result.current.prices[0].pricePerShare).toBe(1);
    });

    it("handles empty vault array", () => {
      mockUseReadContracts.mockReturnValue({
        data: [],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useMultiplePricePerShare([]));

      expect(result.current.prices).toHaveLength(0);
      expect(result.current.isLoading).toBe(false);
    });

    it("handles mixed success/failure across vaults", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: 18, status: "success" }, // vault 1 decimals
          { result: BigInt("1050000000000000000"), status: "success" }, // vault 1 PPS
          { result: undefined, status: "failure" }, // vault 2 decimals failed
          { result: undefined, status: "failure" }, // vault 2 PPS failed
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() =>
        useMultiplePricePerShare(VAULT_ADDRESSES)
      );

      expect(result.current.prices[0].pricePerShare).toBe(1.05);
      expect(result.current.prices[1].pricePerShare).toBe(1); // fallback
    });

    it("handles single vault in array", () => {
      mockUseReadContracts.mockReturnValue({
        data: [
          { result: 18, status: "success" },
          { result: BigInt("1200000000000000000"), status: "success" },
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() =>
        useMultiplePricePerShare([VAULT_ADDRESSES[0]])
      );

      expect(result.current.prices).toHaveLength(1);
      expect(result.current.prices[0].pricePerShare).toBe(1.2);
    });
  });
});
