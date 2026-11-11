/**
 * Known input/output vectors for the off-chain Curve StableSwap maths that
 * src/lib/enso.ts uses. The implementation lives in @yldfi/curve-amm-math and
 * is re-exported by src/lib/curve.
 */
import { describe, it, expect } from "vitest";

import {
  A_PRECISION,
  N_COINS,
  STABLESWAP_FEE_DENOMINATOR,
  computeAnn,
  dynamicFee,
  getD,
  getDy01,
  getY,
} from "@/lib/curve";

const A = 37n;
const Ann = computeAnn(A, 2);

describe("StableSwap maths", () => {
  describe("getD", () => {
    it("returns 0 for an empty pool", () => {
      expect(getD([0n, 0n], Ann)).toBe(0n);
    });

    it("returns about the sum of the balances for a balanced pool", () => {
      const balance = 1000n * 10n ** 18n;

      const D = getD([balance, balance], Ann);

      expect(D).toBe(2000000000000000000000n);
      expect(D).toBeGreaterThan(1990n * 10n ** 18n);
      expect(D).toBeLessThan(2010n * 10n ** 18n);
    });

    it("stays between the sum and twice the smaller balance for an imbalanced pool", () => {
      const D = getD([50000n * 10n ** 18n, 70000n * 10n ** 18n], Ann);

      expect(D).toBeGreaterThan(100000n * 10n ** 18n);
      expect(D).toBeLessThan(120000n * 10n ** 18n);
    });
  });

  describe("getY", () => {
    it("prices a 1000-token swap close to the peg", () => {
      const xp: [bigint, bigint] = [50000n * 10n ** 18n, 70000n * 10n ** 18n];
      const D = getD(xp, Ann);

      const y = getY(0, 1, xp[0] + 1000n * 10n ** 18n, xp, Ann, D);

      expect(y).toBeLessThan(xp[1]);
      expect(y).toBeGreaterThan(xp[1] - 1100n * 10n ** 18n);
    });
  });

  describe("dynamicFee", () => {
    const baseFee = 10000000n; // 0.1%

    it("returns the base fee when the multiplier is 0", () => {
      expect(dynamicFee(50000n * 10n ** 18n, 50000n * 10n ** 18n, baseFee, 0n)).toBe(baseFee);
    });

    it("returns the base fee when the multiplier equals the denominator", () => {
      expect(
        dynamicFee(50000n * 10n ** 18n, 50000n * 10n ** 18n, baseFee, STABLESWAP_FEE_DENOMINATOR),
      ).toBe(baseFee);
    });

    it("increases the fee for an imbalanced pool", () => {
      const feeMultiplier = 20000000000n; // 2x

      const balancedFee = dynamicFee(50000n * 10n ** 18n, 50000n * 10n ** 18n, baseFee, feeMultiplier);
      const imbalancedFee = dynamicFee(30000n * 10n ** 18n, 70000n * 10n ** 18n, baseFee, feeMultiplier);

      expect(imbalancedFee).toBeGreaterThan(balancedFee);
    });
  });

  describe("getDy01", () => {
    // Snapshot of a 2-coin StableSwap pool with an off-peg fee multiplier.
    const xp: [bigint, bigint] = [52847921620037742048865n, 65464805601413182150594n];
    const fee = 10000000n;
    const offpegFeeMultiplier = 20000000000n;

    it("quotes slightly more than the input when the output side is heavier", () => {
      const dy = getDy01(100n * 10n ** 18n, xp, Ann, fee, offpegFeeMultiplier);

      expect(dy).toBe(100469378842931378953n);
      expect(dy).toBeGreaterThan(100n * 10n ** 18n);
      expect(dy).toBeLessThan(101n * 10n ** 18n);
    });

    it("quotes 1000 tokens with a smaller per-token bonus", () => {
      const dy = getDy01(1000n * 10n ** 18n, xp, Ann, fee, offpegFeeMultiplier);

      expect(dy).toBe(1004267579216845920174n);
      expect(dy).toBeGreaterThan(1000n * 10n ** 18n);
      expect(dy).toBeLessThan(1010n * 10n ** 18n);
    });

    it("shows diminishing returns for a larger swap", () => {
      const dx1 = 1000n * 10n ** 18n;
      const dx2 = 50000n * 10n ** 18n;

      const rate1 = Number(getDy01(dx1, xp, Ann, fee, offpegFeeMultiplier)) / Number(dx1);
      const rate2 = Number(getDy01(dx2, xp, Ann, fee, offpegFeeMultiplier)) / Number(dx2);

      expect(rate2).toBeLessThan(rate1);
    });
  });

  describe("computeAnn", () => {
    it("scales A by A_PRECISION and the coin count", () => {
      expect(Ann).toBe(A * A_PRECISION * N_COINS);
    });
  });
});
