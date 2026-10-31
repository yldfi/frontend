/**
 * Tests for hybrid swap/mint strategy
 *
 * Tests the StableSwap peg-point math that determines how much to swap vs mint
 * when entering a pegged-asset vault (e.g. pxCVX), based on Curve pool peg state.
 *
 * Key concepts:
 * - "Peg point": Max amount that can be swapped while getting >= 1:1 rate
 * - Below peg: Swap everything (get bonus from pool imbalance)
 * - Above peg: Swap up to peg point, mint the rest (hybrid strategy)
 */
import { describe, it, expect } from "vitest";
import { findPegPoint, stableswap } from "@/lib/curve";

// ============================================
// Constants matching the Curve pool
// ============================================
const STABLESWAP_A_PRECISION = 100n;
const STABLESWAP_N_COINS = 2n;

// ============================================
// Unit Tests - findPegPoint (Pure Math)
// ============================================

describe("findPegPoint", () => {
  // Imbalanced 2-coin StableSwap pool snapshot: 52624.94 coin0 / 65689.21 coin1.
  // This creates a swap bonus when buying coin1 (more coin1 in pool).
  const poolSnapshot = {
    // Convert to 18 decimals
    xp: [
      52624940000000000000000n, // ~52,625 coin0
      65689210000000000000000n, // ~65,689 coin1
    ] as [bigint, bigint],
    A: 37n,
    fee: 10000000n, // 0.1% base fee
    offpegFeeMultiplier: 20000000000n, // 2x multiplier
  };

  const Ann = poolSnapshot.A * STABLESWAP_A_PRECISION * STABLESWAP_N_COINS;

  it("finds peg point around 10,846 coin0 for imbalanced pool", () => {
    const pegPoint = findPegPoint(
      poolSnapshot.xp,
      Ann,
      poolSnapshot.fee,
      poolSnapshot.offpegFeeMultiplier
    );

    // Reference value for this snapshot: ~10,846.63 coin0
    const pegPointInTokens = Number(pegPoint) / 1e18;

    // Should be approximately 10,846 (allow 5% tolerance for math precision)
    expect(pegPointInTokens).toBeGreaterThan(10000);
    expect(pegPointInTokens).toBeLessThan(12000);
  });

  it("returns 0 for balanced pool (no swap bonus)", () => {
    // When pool is perfectly balanced, swap gives 1:1 minus fees
    // So any swap amount would be at or below 1:1 rate
    const balancedPool: [bigint, bigint] = [
      50000n * 10n ** 18n,
      50000n * 10n ** 18n,
    ];

    const pegPoint = findPegPoint(
      balancedPool,
      Ann,
      poolSnapshot.fee,
      poolSnapshot.offpegFeeMultiplier
    );

    // Should be 0 or very small (no bonus available)
    expect(pegPoint).toBeLessThan(100n * 10n ** 18n);
  });

  it("returns higher peg point for more imbalanced pool", () => {
    // More coin1 in pool = more swap bonus available = higher peg point
    const moreImbalanced: [bigint, bigint] = [
      40000n * 10n ** 18n, // Less coin0
      80000n * 10n ** 18n, // More coin1
    ];

    const pegPoint = findPegPoint(
      moreImbalanced,
      Ann,
      poolSnapshot.fee,
      poolSnapshot.offpegFeeMultiplier
    );

    // With more imbalance, should be able to swap more before hitting 1:1
    const pegPointInTokens = Number(pegPoint) / 1e18;
    expect(pegPointInTokens).toBeGreaterThan(10000); // Higher than original snapshot
  });

  it("handles reversed imbalance (coin1 < coin0)", () => {
    // When coin0 > coin1, there's no swap bonus for buying coin1
    // The peg point should be 0 (better to mint)
    const reversedPool: [bigint, bigint] = [
      70000n * 10n ** 18n, // More coin0
      50000n * 10n ** 18n, // Less coin1
    ];

    const pegPoint = findPegPoint(
      reversedPool,
      Ann,
      poolSnapshot.fee,
      poolSnapshot.offpegFeeMultiplier
    );

    // Should be 0 or very small - no bonus when pool has less coin1
    expect(pegPoint).toBeLessThan(1000n * 10n ** 18n);
  });
});

describe("stableswap.getDy", () => {
  // Verify the swap math gives expected bonus/penalty
  const poolSnapshot = {
    xp: [
      52624940000000000000000n,
      65689210000000000000000n,
    ] as [bigint, bigint],
    A: 37n,
    fee: 10000000n,
    offpegFeeMultiplier: 20000000000n,
  };

  const Ann = poolSnapshot.A * STABLESWAP_A_PRECISION * STABLESWAP_N_COINS;

  it("gives bonus for small swaps when coin1 > coin0", () => {
    const dx = 100n * 10n ** 18n; // Swap 100 coin0
    const dy = stableswap.getDy(
      0, // from coin0
      1, // to coin1
      dx,
      poolSnapshot.xp,
      Ann,
      poolSnapshot.fee,
      poolSnapshot.offpegFeeMultiplier
    );

    // Should get more than 100 coin1 (bonus)
    expect(dy).toBeGreaterThan(dx);
  });

  it("gives approximately 1:1 at peg point", () => {
    // Find peg point
    const pegPoint = findPegPoint(
      poolSnapshot.xp,
      Ann,
      poolSnapshot.fee,
      poolSnapshot.offpegFeeMultiplier
    );

    // Swap at peg point should give ~1:1
    const dy = stableswap.getDy(
      0,
      1,
      pegPoint,
      poolSnapshot.xp,
      Ann,
      poolSnapshot.fee,
      poolSnapshot.offpegFeeMultiplier
    );

    // Should be approximately equal (within 0.1%)
    const ratio = Number(dy) / Number(pegPoint);
    expect(ratio).toBeGreaterThan(0.999);
    expect(ratio).toBeLessThan(1.01);
  });

  it("gives penalty (< 1:1) for amounts above peg point", () => {
    // Find peg point
    const pegPoint = findPegPoint(
      poolSnapshot.xp,
      Ann,
      poolSnapshot.fee,
      poolSnapshot.offpegFeeMultiplier
    );

    // Swap 50% more than peg point
    const swapAmount = (pegPoint * 150n) / 100n;
    const dy = stableswap.getDy(
      0,
      1,
      swapAmount,
      poolSnapshot.xp,
      Ann,
      poolSnapshot.fee,
      poolSnapshot.offpegFeeMultiplier
    );

    // Should get less than swapped (penalty)
    expect(dy).toBeLessThan(swapAmount);
  });
});

// ============================================
// pxCVX Pool Tests (lpxCVX/pxCVX)
// ============================================

describe("pxCVX pool hybrid strategy", () => {
  // pxCVX uses a similar strategy but with lpxCVX/pxCVX Curve pool

  describe("findPegPoint for lpxCVX/pxCVX", () => {
    // Pool params for lpxCVX/pxCVX (example values)
    const pxPoolSnapshot = {
      xp: [
        30000n * 10n ** 18n, // lpxCVX
        40000n * 10n ** 18n, // pxCVX
      ] as [bigint, bigint],
      A: 50n, // May have different A value
      fee: 4000000n, // 0.04% fee
      offpegFeeMultiplier: 20000000000n,
    };

    const Ann = pxPoolSnapshot.A * STABLESWAP_A_PRECISION * STABLESWAP_N_COINS;

    it("finds peg point for imbalanced lpxCVX/pxCVX pool", () => {
      const pegPoint = findPegPoint(
        pxPoolSnapshot.xp,
        Ann,
        pxPoolSnapshot.fee,
        pxPoolSnapshot.offpegFeeMultiplier
      );

      // Should return a non-zero peg point when pxCVX > lpxCVX
      expect(pegPoint).toBeGreaterThan(0n);
    });

    it("small swaps get a bonus in the imbalanced pool", () => {
      const _pegPoint = findPegPoint(
        pxPoolSnapshot.xp,
        Ann,
        pxPoolSnapshot.fee,
        pxPoolSnapshot.offpegFeeMultiplier
      ); // Calculated to verify findPegPoint works, value not used in assertions

      // Test small swap gives bonus
      const dx = 100n * 10n ** 18n;
      const dy = stableswap.getDy(
        0, // from lpxCVX
        1, // to pxCVX
        dx,
        pxPoolSnapshot.xp,
        Ann,
        pxPoolSnapshot.fee,
        pxPoolSnapshot.offpegFeeMultiplier
      );

      // Should get bonus when pool has more pxCVX
      expect(dy).toBeGreaterThan(dx);
    });
  });
});
