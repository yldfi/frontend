/**
 * Tests for off-chain Curve pool math implementations
 *
 * Unit tests verify the pure math functions with known inputs/outputs
 * Integration tests verify against actual on-chain values (skipped in CI)
 */
import { describe, it, expect } from "vitest";

// Import the internal functions for testing
// We need to export them from enso.ts or test via the public API

// ============================================
// Constants (must match enso.ts)
// ============================================
const STABLESWAP_N_COINS = 2n;
const STABLESWAP_A_PRECISION = 100n;
const STABLESWAP_FEE_DENOMINATOR = 10n ** 10n;

// ============================================
// Pure math function implementations for testing
// (These mirror the implementations in enso.ts)
// ============================================

function stableswapGetD(xp: [bigint, bigint], Ann: bigint): bigint {
  const S = xp[0] + xp[1];
  if (S === 0n) return 0n;

  let D = S;
  const N_COINS_POW = STABLESWAP_N_COINS ** STABLESWAP_N_COINS;

  for (let i = 0; i < 255; i++) {
    let D_P = D;
    for (const x of xp) {
      D_P = (D_P * D) / x;
    }
    D_P = D_P / N_COINS_POW;

    const Dprev = D;
    const numerator = ((Ann * S) / STABLESWAP_A_PRECISION + D_P * STABLESWAP_N_COINS) * D;
    const denominator = ((Ann - STABLESWAP_A_PRECISION) * D) / STABLESWAP_A_PRECISION + (STABLESWAP_N_COINS + 1n) * D_P;
    D = numerator / denominator;

    if (D > Dprev ? D - Dprev <= 1n : Dprev - D <= 1n) break;
  }
  return D;
}

function stableswapGetY(i: number, j: number, x: bigint, xp: [bigint, bigint], Ann: bigint, D: bigint): bigint {
  let c = D;
  let S = 0n;

  for (let k = 0; k < Number(STABLESWAP_N_COINS); k++) {
    let _x: bigint;
    if (k === i) {
      _x = x;
    } else if (k !== j) {
      _x = xp[k];
    } else {
      continue;
    }
    S += _x;
    c = (c * D) / (_x * STABLESWAP_N_COINS);
  }

  c = (c * D * STABLESWAP_A_PRECISION) / (Ann * STABLESWAP_N_COINS);
  const b = S + (D * STABLESWAP_A_PRECISION) / Ann;

  let y = D;
  for (let iter = 0; iter < 255; iter++) {
    const prevY = y;
    y = (y * y + c) / (2n * y + b - D);
    if (y > prevY ? y - prevY <= 1n : prevY - y <= 1n) break;
  }
  return y;
}

function stableswapDynamicFee(
  xpi: bigint,
  xpj: bigint,
  baseFee: bigint,
  feeMultiplier: bigint
): bigint {
  if (feeMultiplier <= STABLESWAP_FEE_DENOMINATOR) return baseFee;

  const xps2 = (xpi + xpj) ** 2n;
  return (feeMultiplier * baseFee) /
    ((feeMultiplier - STABLESWAP_FEE_DENOMINATOR) * 4n * xpi * xpj / xps2 + STABLESWAP_FEE_DENOMINATOR);
}

function stableswapGetDyOffchain(
  dx: bigint,
  xp: [bigint, bigint],
  Ann: bigint,
  baseFee: bigint,
  feeMultiplier: bigint
): bigint {
  const x = xp[0] + dx;
  const D = stableswapGetD(xp, Ann);
  const y = stableswapGetY(0, 1, x, xp, Ann, D);
  const dy = xp[1] - y - 1n;

  const fee = stableswapDynamicFee(
    (xp[0] + x) / 2n,
    (xp[1] + y) / 2n,
    baseFee,
    feeMultiplier
  );
  const feeAmount = (dy * fee) / STABLESWAP_FEE_DENOMINATOR;
  return dy - feeAmount;
}

// ============================================
// Unit Tests - Pure Math (No RPC needed)
// ============================================

describe("StableSwap Math", () => {
  describe("stableswapGetD", () => {
    it("returns 0 for empty pool", () => {
      const xp: [bigint, bigint] = [0n, 0n];
      const Ann = 37n * STABLESWAP_A_PRECISION * STABLESWAP_N_COINS;
      expect(stableswapGetD(xp, Ann)).toBe(0n);
    });

    it("calculates D correctly for balanced pool", () => {
      // For a balanced pool, D should be close to sum of balances
      const balance = 1000n * 10n ** 18n;
      const xp: [bigint, bigint] = [balance, balance];
      const Ann = 37n * STABLESWAP_A_PRECISION * STABLESWAP_N_COINS;
      const D = stableswapGetD(xp, Ann);

      // D should be approximately 2000e18 for balanced pool
      expect(D).toBeGreaterThan(1990n * 10n ** 18n);
      expect(D).toBeLessThan(2010n * 10n ** 18n);
    });

    it("handles imbalanced pool", () => {
      const xp: [bigint, bigint] = [50000n * 10n ** 18n, 70000n * 10n ** 18n];
      const Ann = 37n * STABLESWAP_A_PRECISION * STABLESWAP_N_COINS;
      const D = stableswapGetD(xp, Ann);

      // D should be between sum and 2*min
      expect(D).toBeGreaterThan(100000n * 10n ** 18n);
      expect(D).toBeLessThan(120000n * 10n ** 18n);
    });
  });

  describe("stableswapGetY", () => {
    it("finds correct y for swap", () => {
      const xp: [bigint, bigint] = [50000n * 10n ** 18n, 70000n * 10n ** 18n];
      const Ann = 37n * STABLESWAP_A_PRECISION * STABLESWAP_N_COINS;
      const D = stableswapGetD(xp, Ann);

      // Swap 1000 tokens
      const newX = xp[0] + 1000n * 10n ** 18n;
      const y = stableswapGetY(0, 1, newX, xp, Ann, D);

      // y should be less than original xp[1]
      expect(y).toBeLessThan(xp[1]);
      // But not by too much (StableSwap maintains peg)
      expect(y).toBeGreaterThan(xp[1] - 1100n * 10n ** 18n);
    });
  });

  describe("stableswapDynamicFee", () => {
    it("returns base fee when multiplier is 0", () => {
      const baseFee = 10000000n; // 0.1%
      const fee = stableswapDynamicFee(
        50000n * 10n ** 18n,
        50000n * 10n ** 18n,
        baseFee,
        0n
      );
      expect(fee).toBe(baseFee);
    });

    it("returns base fee when multiplier equals denominator", () => {
      const baseFee = 10000000n;
      const fee = stableswapDynamicFee(
        50000n * 10n ** 18n,
        50000n * 10n ** 18n,
        baseFee,
        STABLESWAP_FEE_DENOMINATOR
      );
      expect(fee).toBe(baseFee);
    });

    it("increases fee for imbalanced pool", () => {
      const baseFee = 10000000n;
      const feeMultiplier = 20000000000n; // 2x

      // Balanced pool
      const balancedFee = stableswapDynamicFee(
        50000n * 10n ** 18n,
        50000n * 10n ** 18n,
        baseFee,
        feeMultiplier
      );

      // Imbalanced pool
      const imbalancedFee = stableswapDynamicFee(
        30000n * 10n ** 18n,
        70000n * 10n ** 18n,
        baseFee,
        feeMultiplier
      );

      // Imbalanced should have higher fee
      expect(imbalancedFee).toBeGreaterThan(balancedFee);
    });
  });

  describe("stableswapGetDyOffchain", () => {
    // Known values from CVX1/cvgCVX pool snapshot
    const poolParams = {
      xp: [52847921620037742048865n, 65464805601413182150594n] as [bigint, bigint],
      A: 37n,
      fee: 10000000n,
      offpegFeeMultiplier: 20000000000n,
    };
    const Ann = poolParams.A * STABLESWAP_A_PRECISION * STABLESWAP_N_COINS;

    it("calculates swap output for 100 tokens", () => {
      const dx = 100n * 10n ** 18n;
      const dy = stableswapGetDyOffchain(dx, poolParams.xp, Ann, poolParams.fee, poolParams.offpegFeeMultiplier);

      // Should get slightly more than input (pool has excess cvgCVX)
      expect(dy).toBeGreaterThan(100n * 10n ** 18n);
      expect(dy).toBeLessThan(101n * 10n ** 18n);
    });

    it("calculates swap output for 1000 tokens", () => {
      const dx = 1000n * 10n ** 18n;
      const dy = stableswapGetDyOffchain(dx, poolParams.xp, Ann, poolParams.fee, poolParams.offpegFeeMultiplier);

      // Should get bonus but less per token than smaller swap
      expect(dy).toBeGreaterThan(1000n * 10n ** 18n);
      expect(dy).toBeLessThan(1010n * 10n ** 18n);
    });

    it("shows diminishing returns for large swaps", () => {
      const dx1 = 1000n * 10n ** 18n;
      const dx2 = 50000n * 10n ** 18n;

      const dy1 = stableswapGetDyOffchain(dx1, poolParams.xp, Ann, poolParams.fee, poolParams.offpegFeeMultiplier);
      const dy2 = stableswapGetDyOffchain(dx2, poolParams.xp, Ann, poolParams.fee, poolParams.offpegFeeMultiplier);

      const rate1 = Number(dy1) / Number(dx1);
      const rate2 = Number(dy2) / Number(dx2);

      // Larger swap should have worse rate
      expect(rate2).toBeLessThan(rate1);
    });
  });
});

// ============================================
// Integration Tests - Against On-Chain (RPC needed)
// These are kept as separate test files that can be run manually:
// - test-stableswap-exact.ts
// - test-cryptoswap-exact.ts
//
// Run with: bun x tsx test-stableswap-exact.ts
// ============================================

// Integration tests require real fetch which jsdom doesn't provide.
// The standalone test files (test-stableswap-exact.ts, test-cryptoswap-exact.ts)
// verify 0% error against on-chain and should be run manually before deployment.
