import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReadContracts } from "wagmi";
import { useVaultData, formatFee } from "@/hooks/useVaultData";

// Get mocked function
const mockUseReadContracts = vi.mocked(useReadContracts);

describe("useVaultData integration", () => {
  const VAULT_ADDRESS = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86" as `0x${string}`;
  const ACCOUNTANT_ADDRESS = "0x1234567890123456789012345678901234567890" as `0x${string}`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("vault data retrieval", () => {
    it("returns complete vault data with accountant fees", () => {
      // First call returns vault data
      mockUseReadContracts
        .mockReturnValueOnce({
          data: [
            { result: ACCOUNTANT_ADDRESS, status: "success" }, // accountant
            { result: BigInt("1000000000000000000000000"), status: "success" }, // totalAssets (1M)
            { result: BigInt("1050000000000000000"), status: "success" }, // pricePerShare (1.05)
            { result: 18, status: "success" }, // decimals
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>)
        // Second call returns accountant fees
        .mockReturnValueOnce({
          data: [
            { result: false, status: "success" }, // useCustomConfig
            { result: [0, 0, 0, 0, 0, 0], status: "success" }, // customConfig
            { result: [100, 1500, 0, 0, 5000, 1000], status: "success" }, // defaultConfig (1% mgmt, 15% perf)
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultData(VAULT_ADDRESS));

      expect(result.current.totalAssets).toBe(BigInt("1000000000000000000000000"));
      expect(result.current.pricePerShare).toBe(BigInt("1050000000000000000"));
      expect(result.current.decimals).toBe(18);
      expect(result.current.accountant).toBe(ACCOUNTANT_ADDRESS);
      expect(result.current.managementFee).toBe(100); // 1%
      expect(result.current.performanceFee).toBe(1500); // 15%
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("uses custom config when useCustomConfig is true", () => {
      mockUseReadContracts
        .mockReturnValueOnce({
          data: [
            { result: ACCOUNTANT_ADDRESS, status: "success" },
            { result: BigInt("500000000000000000000000"), status: "success" },
            { result: BigInt("1000000000000000000"), status: "success" },
            { result: 18, status: "success" },
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>)
        .mockReturnValueOnce({
          data: [
            { result: true, status: "success" }, // useCustomConfig = true
            { result: [50, 1000, 0, 0, 3000, 500], status: "success" }, // customConfig (0.5% mgmt, 10% perf)
            { result: [100, 1500, 0, 0, 5000, 1000], status: "success" }, // defaultConfig
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultData(VAULT_ADDRESS));

      expect(result.current.managementFee).toBe(50); // Custom 0.5%
      expect(result.current.performanceFee).toBe(1000); // Custom 10%
    });

    it("handles loading state", () => {
      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
      } as unknown as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultData(VAULT_ADDRESS));

      expect(result.current.isLoading).toBe(true);
      // Defaults
      expect(result.current.totalAssets).toBe(0n);
      expect(result.current.pricePerShare).toBe(0n);
      expect(result.current.decimals).toBe(18);
    });

    it("handles vault read error", () => {
      const vaultError = new Error("Contract read failed");
      mockUseReadContracts.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: vaultError,
      } as unknown as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultData(VAULT_ADDRESS));

      expect(result.current.error).toBe(vaultError);
      expect(result.current.isLoading).toBe(false);
    });

    it("handles accountant read error", () => {
      const accountantError = new Error("Accountant read failed");

      mockUseReadContracts
        .mockReturnValueOnce({
          data: [
            { result: ACCOUNTANT_ADDRESS, status: "success" },
            { result: BigInt("1000000000000000000000000"), status: "success" },
            { result: BigInt("1050000000000000000"), status: "success" },
            { result: 18, status: "success" },
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>)
        .mockReturnValueOnce({
          data: undefined,
          isLoading: false,
          error: accountantError,
        } as unknown as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultData(VAULT_ADDRESS));

      expect(result.current.error).toBe(accountantError);
      // Vault data should still be available
      expect(result.current.totalAssets).toBe(BigInt("1000000000000000000000000"));
    });
  });

  describe("edge cases", () => {
    it("handles missing accountant address", () => {
      mockUseReadContracts
        .mockReturnValueOnce({
          data: [
            { result: undefined, status: "failure" }, // No accountant
            { result: BigInt("1000000000000000000000000"), status: "success" },
            { result: BigInt("1050000000000000000"), status: "success" },
            { result: 18, status: "success" },
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>)
        .mockReturnValueOnce({
          data: [],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultData(VAULT_ADDRESS));

      expect(result.current.accountant).toBe("0x0000000000000000000000000000000000000000");
      expect(result.current.managementFee).toBe(0);
      expect(result.current.performanceFee).toBe(0);
    });

    it("handles partial vault data failure", () => {
      mockUseReadContracts
        .mockReturnValueOnce({
          data: [
            { result: ACCOUNTANT_ADDRESS, status: "success" },
            { result: undefined, status: "failure" }, // totalAssets failed
            { result: undefined, status: "failure" }, // pricePerShare failed
            { result: undefined, status: "failure" }, // decimals failed
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>)
        .mockReturnValueOnce({
          data: [
            { result: false, status: "success" },
            { result: [0, 0, 0, 0, 0, 0], status: "success" },
            { result: [100, 1500, 0, 0, 5000, 1000], status: "success" },
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultData(VAULT_ADDRESS));

      // Should fall back to defaults
      expect(result.current.totalAssets).toBe(0n);
      expect(result.current.pricePerShare).toBe(0n);
      expect(result.current.decimals).toBe(18);
    });

    it("handles zero total assets (empty vault)", () => {
      mockUseReadContracts
        .mockReturnValueOnce({
          data: [
            { result: ACCOUNTANT_ADDRESS, status: "success" },
            { result: BigInt(0), status: "success" }, // Empty vault
            { result: BigInt("1000000000000000000"), status: "success" }, // PPS = 1
            { result: 18, status: "success" },
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>)
        .mockReturnValueOnce({
          data: [
            { result: false, status: "success" },
            { result: [0, 0, 0, 0, 0, 0], status: "success" },
            { result: [100, 1500, 0, 0, 5000, 1000], status: "success" },
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultData(VAULT_ADDRESS));

      expect(result.current.totalAssets).toBe(0n);
    });

    it("handles 6 decimal token vault (USDC-like)", () => {
      mockUseReadContracts
        .mockReturnValueOnce({
          data: [
            { result: ACCOUNTANT_ADDRESS, status: "success" },
            { result: BigInt("1000000000"), status: "success" }, // 1000 USDC
            { result: BigInt("1050000"), status: "success" }, // 1.05 PPS with 6 decimals
            { result: 6, status: "success" },
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>)
        .mockReturnValueOnce({
          data: [
            { result: false, status: "success" },
            { result: [0, 0, 0, 0, 0, 0], status: "success" },
            { result: [100, 1500, 0, 0, 5000, 1000], status: "success" },
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultData(VAULT_ADDRESS));

      expect(result.current.decimals).toBe(6);
      expect(result.current.totalAssets).toBe(BigInt("1000000000"));
    });

    it("handles very high PPS (100x gain)", () => {
      mockUseReadContracts
        .mockReturnValueOnce({
          data: [
            { result: ACCOUNTANT_ADDRESS, status: "success" },
            { result: BigInt("1000000000000000000000000"), status: "success" },
            { result: BigInt("100000000000000000000"), status: "success" }, // 100 PPS
            { result: 18, status: "success" },
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>)
        .mockReturnValueOnce({
          data: [
            { result: false, status: "success" },
            { result: [0, 0, 0, 0, 0, 0], status: "success" },
            { result: [100, 1500, 0, 0, 5000, 1000], status: "success" },
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultData(VAULT_ADDRESS));

      expect(result.current.pricePerShare).toBe(BigInt("100000000000000000000"));
    });

    it("handles zero fees", () => {
      mockUseReadContracts
        .mockReturnValueOnce({
          data: [
            { result: ACCOUNTANT_ADDRESS, status: "success" },
            { result: BigInt("1000000000000000000000000"), status: "success" },
            { result: BigInt("1050000000000000000"), status: "success" },
            { result: 18, status: "success" },
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>)
        .mockReturnValueOnce({
          data: [
            { result: false, status: "success" },
            { result: [0, 0, 0, 0, 0, 0], status: "success" },
            { result: [0, 0, 0, 0, 5000, 1000], status: "success" }, // 0% mgmt, 0% perf
          ],
          isLoading: false,
          error: null,
        } as unknown as ReturnType<typeof useReadContracts>);

      const { result } = renderHook(() => useVaultData(VAULT_ADDRESS));

      expect(result.current.managementFee).toBe(0);
      expect(result.current.performanceFee).toBe(0);
    });
  });

  describe("formatFee helper", () => {
    it("formats whole percentages", () => {
      expect(formatFee(100)).toBe("1"); // 1%
      expect(formatFee(200)).toBe("2"); // 2%
      expect(formatFee(1500)).toBe("15"); // 15%
    });

    it("formats fractional percentages", () => {
      expect(formatFee(50)).toBe("0.50"); // 0.5%
      expect(formatFee(125)).toBe("1.25"); // 1.25%
    });

    it("formats zero", () => {
      expect(formatFee(0)).toBe("0");
    });
  });
});
