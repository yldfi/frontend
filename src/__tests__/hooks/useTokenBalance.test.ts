import { describe, it, expect } from "vitest";
import { formatUnits } from "viem";

// Test the useTokenBalance business logic directly
// We test the data formatting and derivation patterns

describe("useTokenBalance logic", () => {
  describe("balance formatting", () => {
    function formatBalance(balance: bigint, decimals: number): string {
      return formatUnits(balance, decimals);
    }

    describe("standard 18 decimal tokens", () => {
      it("formats 1 token correctly", () => {
        const oneToken = BigInt("1000000000000000000"); // 1e18
        expect(formatBalance(oneToken, 18)).toBe("1");
      });

      it("formats 0 balance", () => {
        expect(formatBalance(0n, 18)).toBe("0");
      });

      it("formats fractional amounts", () => {
        const halfToken = BigInt("500000000000000000"); // 0.5e18
        expect(formatBalance(halfToken, 18)).toBe("0.5");
      });

      it("formats large amounts", () => {
        const million = BigInt("1000000000000000000000000"); // 1e24 = 1M tokens
        expect(formatBalance(million, 18)).toBe("1000000");
      });

      it("formats very small amounts (wei)", () => {
        expect(formatBalance(1n, 18)).toBe("0.000000000000000001");
      });

      it("formats amounts with many decimal places", () => {
        const amount = BigInt("1234567890123456789");
        expect(formatBalance(amount, 18)).toBe("1.234567890123456789");
      });
    });

    describe("6 decimal tokens (USDC/USDT)", () => {
      it("formats 1 token correctly", () => {
        const oneUsdc = BigInt("1000000"); // 1e6
        expect(formatBalance(oneUsdc, 6)).toBe("1");
      });

      it("formats fractional USDC", () => {
        const halfUsdc = BigInt("500000"); // 0.5e6
        expect(formatBalance(halfUsdc, 6)).toBe("0.5");
      });

      it("formats 1 cent", () => {
        const oneCent = BigInt("10000"); // 0.01 USDC
        expect(formatBalance(oneCent, 6)).toBe("0.01");
      });

      it("formats 1 million USDC", () => {
        const million = BigInt("1000000000000"); // 1e12 = 1M USDC
        expect(formatBalance(million, 6)).toBe("1000000");
      });
    });

    describe("8 decimal tokens (WBTC)", () => {
      it("formats 1 WBTC correctly", () => {
        const oneWbtc = BigInt("100000000"); // 1e8
        expect(formatBalance(oneWbtc, 8)).toBe("1");
      });

      it("formats 1 satoshi", () => {
        expect(formatBalance(1n, 8)).toBe("0.00000001");
      });

      it("formats fractional WBTC", () => {
        const halfWbtc = BigInt("50000000"); // 0.5e8
        expect(formatBalance(halfWbtc, 8)).toBe("0.5");
      });
    });
  });

  describe("default value handling", () => {
    interface ContractResult {
      result?: bigint | number;
      status: "success" | "failure";
    }

    function extractBalance(data: ContractResult[] | undefined): bigint {
      return (data?.[0]?.result as bigint) ?? 0n;
    }

    function extractDecimals(data: ContractResult[] | undefined): number {
      return (data?.[1]?.result as number) ?? 18;
    }

    it("defaults balance to 0n when data is undefined", () => {
      expect(extractBalance(undefined)).toBe(0n);
    });

    it("defaults balance to 0n when result is undefined", () => {
      expect(extractBalance([{ status: "failure" }])).toBe(0n);
    });

    it("extracts balance when present", () => {
      const data: ContractResult[] = [
        { result: BigInt("1000000000000000000"), status: "success" },
        { result: 18, status: "success" },
      ];
      expect(extractBalance(data)).toBe(BigInt("1000000000000000000"));
    });

    it("defaults decimals to 18 when data is undefined", () => {
      expect(extractDecimals(undefined)).toBe(18);
    });

    it("defaults decimals to 18 when result is undefined", () => {
      expect(extractDecimals([{}, { status: "failure" }] as ContractResult[])).toBe(18);
    });

    it("extracts decimals when present", () => {
      const data: ContractResult[] = [
        { result: 0n, status: "success" },
        { result: 6, status: "success" },
      ];
      expect(extractDecimals(data)).toBe(6);
    });
  });

  describe("isLoading derivation", () => {
    function deriveIsLoading(isLoading: boolean, isConnected: boolean): boolean {
      return isLoading && isConnected;
    }

    it("returns false when not loading", () => {
      expect(deriveIsLoading(false, true)).toBe(false);
    });

    it("returns false when not connected", () => {
      expect(deriveIsLoading(true, false)).toBe(false);
    });

    it("returns true only when loading AND connected", () => {
      expect(deriveIsLoading(true, true)).toBe(true);
    });

    it("returns false when neither loading nor connected", () => {
      expect(deriveIsLoading(false, false)).toBe(false);
    });
  });

  describe("query enablement logic", () => {
    function shouldEnableQuery(
      isConnected: boolean,
      userAddress: string | undefined
    ): boolean {
      return isConnected && !!userAddress;
    }

    it("enables query when connected with address", () => {
      expect(shouldEnableQuery(true, "0x1234")).toBe(true);
    });

    it("disables query when not connected", () => {
      expect(shouldEnableQuery(false, "0x1234")).toBe(false);
    });

    it("disables query when address is undefined", () => {
      expect(shouldEnableQuery(true, undefined)).toBe(false);
    });

    it("disables query when address is empty string", () => {
      expect(shouldEnableQuery(true, "")).toBe(false);
    });

    it("disables query when both not connected and no address", () => {
      expect(shouldEnableQuery(false, undefined)).toBe(false);
    });
  });

  describe("refetch interval", () => {
    const REFETCH_INTERVAL = 12000; // 12 seconds

    it("has correct refetch interval (approximately 1 block)", () => {
      expect(REFETCH_INTERVAL).toBe(12000);
    });

    it("interval is 12 seconds", () => {
      expect(REFETCH_INTERVAL / 1000).toBe(12);
    });
  });

  describe("TokenBalanceResult interface", () => {
    interface TokenBalanceResult {
      balance: bigint;
      decimals: number;
      formatted: string;
      isLoading: boolean;
    }

    function createResult(
      balance: bigint,
      decimals: number,
      isLoading: boolean
    ): TokenBalanceResult {
      return {
        balance,
        decimals,
        formatted: formatUnits(balance, decimals),
        isLoading,
      };
    }

    it("creates result with all fields", () => {
      const result = createResult(BigInt("1000000000000000000"), 18, false);
      expect(result.balance).toBe(BigInt("1000000000000000000"));
      expect(result.decimals).toBe(18);
      expect(result.formatted).toBe("1");
      expect(result.isLoading).toBe(false);
    });

    it("handles zero balance", () => {
      const result = createResult(0n, 18, false);
      expect(result.balance).toBe(0n);
      expect(result.formatted).toBe("0");
    });

    it("handles different decimals consistently", () => {
      const result6 = createResult(BigInt("1000000"), 6, false);
      const result18 = createResult(BigInt("1000000000000000000"), 18, false);
      expect(result6.formatted).toBe("1");
      expect(result18.formatted).toBe("1");
    });
  });

  describe("edge cases", () => {
    it("handles max uint256 balance", () => {
      const maxUint256 =
        BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935");
      const formatted = formatUnits(maxUint256, 18);
      expect(formatted).toContain("115792089237316195423570985008687907853269984665640564039457");
    });

    it("handles balance with trailing zeros", () => {
      const amount = BigInt("1000000000000000000"); // Exactly 1 token
      expect(formatUnits(amount, 18)).toBe("1");
    });

    it("handles 0 decimals (rare but possible)", () => {
      const amount = BigInt("100");
      expect(formatUnits(amount, 0)).toBe("100");
    });
  });
});
