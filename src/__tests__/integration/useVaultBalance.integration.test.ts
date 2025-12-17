import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReadContracts, useAccount } from "wagmi";
import { useVaultBalance, useMultipleVaultBalances } from "@/hooks/useVaultBalance";

// Get the mocked functions
const mockUseReadContracts = vi.mocked(useReadContracts);
const mockUseAccount = vi.mocked(useAccount);

describe("useVaultBalance integration", () => {
  const VAULT_ADDRESS = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86" as `0x${string}`;
  const USER_ADDRESS = "0x1234567890123456789012345678901234567890" as `0x${string}`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("useVaultBalance", () => {
    it("returns zero balance when not connected", () => {
      mockUseAccount.mockReturnValue({
        address: undefined,
        isConnected: false,
      } as ReturnType<typeof useAccount>);

      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultBalance(VAULT_ADDRESS));

      expect(result.current.balance).toBe(0n);
      expect(result.current.formatted).toBe("0");
      expect(result.current.formattedUsd).toBe("$0");
      expect(result.current.isLoading).toBe(false);
    });

    it("returns balance when connected", () => {
      mockUseAccount.mockReturnValue({
        address: USER_ADDRESS,
        isConnected: true,
      } as ReturnType<typeof useAccount>);

      mockUseReadContracts.mockReturnValue({
        data: [
          { result: BigInt("1000000000000000000000"), status: "success" }, // 1000 tokens
          { result: 18, status: "success" }, // 18 decimals
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() =>
        useVaultBalance(VAULT_ADDRESS, 1.05, 0.93)
      );

      expect(result.current.balance).toBe(BigInt("1000000000000000000000"));
      expect(result.current.formatted).toBe("1000");
      expect(result.current.decimals).toBe(18);
      // USD = 1000 * 1.05 * 0.93 = 976.5
      expect(result.current.formattedUsd).toBe("$976.50");
    });

    it("formats large USD values with K suffix", () => {
      mockUseAccount.mockReturnValue({
        address: USER_ADDRESS,
        isConnected: true,
      } as ReturnType<typeof useAccount>);

      mockUseReadContracts.mockReturnValue({
        data: [
          { result: BigInt("10000000000000000000000"), status: "success" }, // 10000 tokens
          { result: 18, status: "success" },
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() =>
        useVaultBalance(VAULT_ADDRESS, 1.05, 0.93)
      );

      // USD = 10000 * 1.05 * 0.93 = 9765
      expect(result.current.formattedUsd).toBe("$9.8K");
    });

    it("formats small USD values with 4 decimals", () => {
      mockUseAccount.mockReturnValue({
        address: USER_ADDRESS,
        isConnected: true,
      } as ReturnType<typeof useAccount>);

      mockUseReadContracts.mockReturnValue({
        data: [
          { result: BigInt("100000000000000000"), status: "success" }, // 0.1 tokens
          { result: 18, status: "success" },
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() =>
        useVaultBalance(VAULT_ADDRESS, 1, 1)
      );

      // USD = 0.1 * 1 * 1 = 0.1
      expect(result.current.formattedUsd).toBe("$0.1000");
    });

    it("shows loading only when connected", () => {
      mockUseAccount.mockReturnValue({
        address: USER_ADDRESS,
        isConnected: true,
      } as ReturnType<typeof useAccount>);

      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultBalance(VAULT_ADDRESS));

      expect(result.current.isLoading).toBe(true);
    });

    it("hides loading when not connected even if query is loading", () => {
      mockUseAccount.mockReturnValue({
        address: undefined,
        isConnected: false,
      } as ReturnType<typeof useAccount>);

      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultBalance(VAULT_ADDRESS));

      expect(result.current.isLoading).toBe(false);
    });

    it("uses default decimals when not returned", () => {
      mockUseAccount.mockReturnValue({
        address: USER_ADDRESS,
        isConnected: true,
      } as ReturnType<typeof useAccount>);

      mockUseReadContracts.mockReturnValue({
        data: [
          { result: BigInt("1000000000000000000"), status: "success" },
          { result: undefined, status: "failure" }, // decimals call failed
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultBalance(VAULT_ADDRESS));

      expect(result.current.decimals).toBe(18); // default
      expect(result.current.formatted).toBe("1");
    });
  });

  describe("useMultipleVaultBalances", () => {
    const VAULTS = [
      {
        address: "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86" as `0x${string}`,
        pricePerShare: 1.05,
        assetPriceUsd: 0.93,
      },
      {
        address: "0x27B5739e22ad9033bcBf192059122d163b60349D" as `0x${string}`,
        pricePerShare: 1.02,
        assetPriceUsd: 0.93,
      },
    ];

    it("returns balances for multiple vaults when connected", () => {
      mockUseAccount.mockReturnValue({
        address: USER_ADDRESS,
        isConnected: true,
      } as ReturnType<typeof useAccount>);

      mockUseReadContracts.mockReturnValue({
        data: [
          { result: BigInt("1000000000000000000000"), status: "success" }, // vault 1 balance
          { result: 18, status: "success" }, // vault 1 decimals
          { result: BigInt("500000000000000000000"), status: "success" }, // vault 2 balance
          { result: 18, status: "success" }, // vault 2 decimals
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useMultipleVaultBalances(VAULTS));

      expect(result.current.balances).toHaveLength(2);
      expect(result.current.balances[0].formatted).toBe("1000");
      expect(result.current.balances[1].formatted).toBe("500");
      expect(result.current.isConnected).toBe(true);
    });

    it("calculates USD values for each vault", () => {
      mockUseAccount.mockReturnValue({
        address: USER_ADDRESS,
        isConnected: true,
      } as ReturnType<typeof useAccount>);

      mockUseReadContracts.mockReturnValue({
        data: [
          { result: BigInt("1000000000000000000000"), status: "success" },
          { result: 18, status: "success" },
          { result: BigInt("500000000000000000000"), status: "success" },
          { result: 18, status: "success" },
        ],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useMultipleVaultBalances(VAULTS));

      // Vault 1: 1000 * 1.05 * 0.93 = 976.5
      expect(result.current.balances[0].usdValue).toBeCloseTo(976.5, 1);
      // Vault 2: 500 * 1.02 * 0.93 = 474.3
      expect(result.current.balances[1].usdValue).toBeCloseTo(474.3, 1);
    });

    it("returns zero balances when not connected", () => {
      mockUseAccount.mockReturnValue({
        address: undefined,
        isConnected: false,
      } as ReturnType<typeof useAccount>);

      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useMultipleVaultBalances(VAULTS));

      expect(result.current.balances).toHaveLength(2);
      expect(result.current.balances[0].balance).toBe(0n);
      expect(result.current.balances[1].balance).toBe(0n);
      expect(result.current.isConnected).toBe(false);
    });

    it("handles empty vault array", () => {
      mockUseAccount.mockReturnValue({
        address: USER_ADDRESS,
        isConnected: true,
      } as ReturnType<typeof useAccount>);

      mockUseReadContracts.mockReturnValue({
        data: [],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useMultipleVaultBalances([]));

      expect(result.current.balances).toHaveLength(0);
    });
  });
});
