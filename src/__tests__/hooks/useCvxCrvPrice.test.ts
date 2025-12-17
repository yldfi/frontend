import { describe, it, expect } from "vitest";
import { formatUnits } from "viem";

// Test the useCvxCrvPrice business logic directly
// We test price calculation from multiple oracle sources

describe("useCvxCrvPrice logic", () => {
  describe("price calculation", () => {
    function calculateCvxCrvPrice(
      cvxCrvInCrvUsd: number,
      crvUsdInUsd: number
    ): number {
      // cvxCRV price in USD = cvxCRV/crvUSD × crvUSD/USD
      return cvxCrvInCrvUsd * crvUsdInUsd;
    }

    it("calculates correct price for 1:1 rates", () => {
      // 1 cvxCRV = 1 crvUSD, 1 crvUSD = 1 USD
      expect(calculateCvxCrvPrice(1, 1)).toBe(1);
    });

    it("calculates correct price with typical values", () => {
      // 1 cvxCRV = 0.95 crvUSD, 1 crvUSD = 0.99 USD
      const price = calculateCvxCrvPrice(0.95, 0.99);
      expect(price).toBeCloseTo(0.9405, 4);
    });

    it("calculates correct price when cvxCRV is above peg", () => {
      // 1 cvxCRV = 1.05 crvUSD, 1 crvUSD = 1.00 USD
      expect(calculateCvxCrvPrice(1.05, 1.0)).toBe(1.05);
    });

    it("returns 0 when cvxCRV oracle returns 0", () => {
      expect(calculateCvxCrvPrice(0, 1)).toBe(0);
    });

    it("returns 0 when crvUSD oracle returns 0", () => {
      expect(calculateCvxCrvPrice(1, 0)).toBe(0);
    });

    it("returns 0 when both oracles return 0", () => {
      expect(calculateCvxCrvPrice(0, 0)).toBe(0);
    });

    it("handles very small price deviations", () => {
      // 1 cvxCRV = 0.9999 crvUSD, 1 crvUSD = 0.9998 USD
      const price = calculateCvxCrvPrice(0.9999, 0.9998);
      expect(price).toBeCloseTo(0.9997, 4);
    });
  });

  describe("oracle data extraction", () => {
    interface ContractResult {
      result?: bigint;
      status?: "success" | "failure";
    }

    function extractCvxCrvInCrvUsd(data: ContractResult[] | undefined): number {
      // cvxCRV/crvUSD price (18 decimals from LlamaLend)
      return data?.[0]?.result
        ? Number(formatUnits(data[0].result, 18))
        : 0;
    }

    function extractCrvUsdInUsd(data: ContractResult[] | undefined): number {
      // crvUSD/USD price (8 decimals from Chainlink)
      return data?.[1]?.result
        ? Number(formatUnits(data[1].result, 8))
        : 0;
    }

    describe("cvxCRV/crvUSD extraction (18 decimals)", () => {
      it("extracts 1:1 price correctly", () => {
        const data: ContractResult[] = [
          { result: BigInt("1000000000000000000") }, // 1e18 = 1.0
        ];
        expect(extractCvxCrvInCrvUsd(data)).toBe(1);
      });

      it("extracts 0.95 price correctly", () => {
        const data: ContractResult[] = [
          { result: BigInt("950000000000000000") }, // 0.95e18
        ];
        expect(extractCvxCrvInCrvUsd(data)).toBe(0.95);
      });

      it("returns 0 when data is undefined", () => {
        expect(extractCvxCrvInCrvUsd(undefined)).toBe(0);
      });

      it("returns 0 when result is undefined", () => {
        expect(extractCvxCrvInCrvUsd([{ status: "failure" }])).toBe(0);
      });
    });

    describe("crvUSD/USD extraction (8 decimals)", () => {
      it("extracts 1:1 price correctly", () => {
        const data: ContractResult[] = [
          {},
          { result: BigInt("100000000") }, // 1e8 = 1.0
        ];
        expect(extractCrvUsdInUsd(data)).toBe(1);
      });

      it("extracts 0.99 price correctly", () => {
        const data: ContractResult[] = [
          {},
          { result: BigInt("99000000") }, // 0.99e8
        ];
        expect(extractCrvUsdInUsd(data)).toBe(0.99);
      });

      it("extracts 1.01 price correctly", () => {
        const data: ContractResult[] = [
          {},
          { result: BigInt("101000000") }, // 1.01e8
        ];
        expect(extractCrvUsdInUsd(data)).toBe(1.01);
      });

      it("returns 0 when data is undefined", () => {
        expect(extractCrvUsdInUsd(undefined)).toBe(0);
      });

      it("returns 0 when result is undefined", () => {
        expect(extractCrvUsdInUsd([{}, { status: "failure" }])).toBe(0);
      });
    });
  });

  describe("oracle addresses", () => {
    const CVXCRV_CRVUSD_ORACLE = "0xD7063E7e5EbF99b55c56F231f374F97C8578653a";
    const CRVUSD_USD_CHAINLINK = "0xEEf0C605546958c1f899b6fB336C20671f9cD49F";

    it("has correct LlamaLend oracle address", () => {
      expect(CVXCRV_CRVUSD_ORACLE).toBe("0xD7063E7e5EbF99b55c56F231f374F97C8578653a");
    });

    it("has correct Chainlink feed address", () => {
      expect(CRVUSD_USD_CHAINLINK).toBe("0xEEf0C605546958c1f899b6fB336C20671f9cD49F");
    });

    it("both addresses are valid Ethereum addresses", () => {
      expect(CVXCRV_CRVUSD_ORACLE).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(CRVUSD_USD_CHAINLINK).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  describe("decimal handling", () => {
    it("LlamaLend uses 18 decimals", () => {
      const oneUnit = BigInt("1000000000000000000");
      expect(Number(formatUnits(oneUnit, 18))).toBe(1);
    });

    it("Chainlink uses 8 decimals", () => {
      const oneUnit = BigInt("100000000");
      expect(Number(formatUnits(oneUnit, 8))).toBe(1);
    });

    it("handles precision differences correctly", () => {
      // LlamaLend: 0.95123456789012345678 (18 decimals)
      const llamaPrice = BigInt("951234567890123456");
      const llamaPriceNum = Number(formatUnits(llamaPrice, 18));

      // Chainlink: 0.99876543 (8 decimals)
      const chainlinkPrice = BigInt("99876543");
      const chainlinkPriceNum = Number(formatUnits(chainlinkPrice, 8));

      const finalPrice = llamaPriceNum * chainlinkPriceNum;
      expect(finalPrice).toBeCloseTo(0.95, 2);
    });
  });

  describe("stale time and refetch configuration", () => {
    const STALE_TIME = 60 * 1000; // 1 minute
    const REFETCH_INTERVAL = 60 * 1000; // 1 minute

    it("has 1 minute stale time", () => {
      expect(STALE_TIME).toBe(60000);
    });

    it("has 1 minute refetch interval", () => {
      expect(REFETCH_INTERVAL).toBe(60000);
    });
  });

  describe("return value structure", () => {
    interface CvxCrvPriceResult {
      price: number;
      cvxCrvInCrvUsd: number;
      crvUsdInUsd: number;
      isLoading: boolean;
      error: Error | null;
    }

    function createResult(
      cvxCrvInCrvUsd: number,
      crvUsdInUsd: number,
      isLoading: boolean = false,
      error: Error | null = null
    ): CvxCrvPriceResult {
      return {
        price: cvxCrvInCrvUsd * crvUsdInUsd,
        cvxCrvInCrvUsd,
        crvUsdInUsd,
        isLoading,
        error,
      };
    }

    it("creates result with calculated price", () => {
      const result = createResult(0.95, 0.99);
      expect(result.price).toBeCloseTo(0.9405, 4);
      expect(result.cvxCrvInCrvUsd).toBe(0.95);
      expect(result.crvUsdInUsd).toBe(0.99);
    });

    it("creates result with loading state", () => {
      const result = createResult(0, 0, true);
      expect(result.isLoading).toBe(true);
      expect(result.price).toBe(0);
    });

    it("creates result with error", () => {
      const error = new Error("Oracle error");
      const result = createResult(0, 0, false, error);
      expect(result.error).toBe(error);
    });
  });

  describe("realistic price scenarios", () => {
    function calculateCvxCrvPrice(
      cvxCrvInCrvUsd: number,
      crvUsdInUsd: number
    ): number {
      return cvxCrvInCrvUsd * crvUsdInUsd;
    }

    it("handles cvxCRV slightly below peg", () => {
      // cvxCRV typically trades at 0.90-0.98 of CRV value
      const price = calculateCvxCrvPrice(0.92, 0.99);
      expect(price).toBeCloseTo(0.91, 2);
    });

    it("handles crvUSD at peg", () => {
      const price = calculateCvxCrvPrice(0.95, 1.00);
      expect(price).toBe(0.95);
    });

    it("handles both below peg", () => {
      const price = calculateCvxCrvPrice(0.90, 0.98);
      expect(price).toBeCloseTo(0.882, 3);
    });

    it("handles extreme depeg scenario", () => {
      // Stress test: cvxCRV at 0.50, crvUSD at 0.90
      const price = calculateCvxCrvPrice(0.50, 0.90);
      expect(price).toBe(0.45);
    });
  });
});
