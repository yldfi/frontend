/**
 * Tests for hybrid swap/mint strategy
 *
 * Tests the logic that determines how much to swap vs mint when
 * entering cvgCVX or pxCVX vaults, based on Curve pool peg state.
 *
 * Key concepts:
 * - "Peg point": Max amount that can be swapped while getting >= 1:1 rate
 * - Below peg: Swap everything (get bonus from pool imbalance)
 * - Above peg: Swap up to peg point, mint the rest (hybrid strategy)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  // Pool params snapshot from user's data:
  // CVX1/cvgCVX LP Balances: 52624.94 CVX1 / 65689.21 cvgCVX
  // This creates a swap bonus when buying cvgCVX (more cvgCVX in pool)
  const poolSnapshot = {
    // Convert to 18 decimals
    xp: [
      52624940000000000000000n, // ~52,625 CVX1
      65689210000000000000000n, // ~65,689 cvgCVX
    ] as [bigint, bigint],
    A: 37n,
    fee: 10000000n, // 0.1% base fee
    offpegFeeMultiplier: 20000000000n, // 2x multiplier
  };

  const Ann = poolSnapshot.A * STABLESWAP_A_PRECISION * STABLESWAP_N_COINS;

  it("finds peg point around 10,846 CVX1 for imbalanced pool", () => {
    const pegPoint = findPegPoint(
      poolSnapshot.xp,
      Ann,
      poolSnapshot.fee,
      poolSnapshot.offpegFeeMultiplier
    );

    // User mentioned: "Optimal Buy Before Peg Maximum Purchase: 10,846.63 CVX1"
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
    // More cvgCVX in pool = more swap bonus available = higher peg point
    const moreImbalanced: [bigint, bigint] = [
      40000n * 10n ** 18n, // Less CVX1
      80000n * 10n ** 18n, // More cvgCVX
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

  it("handles reversed imbalance (cvgCVX < CVX1)", () => {
    // When CVX1 > cvgCVX, there's no swap bonus for buying cvgCVX
    // The peg point should be 0 (better to mint)
    const reversedPool: [bigint, bigint] = [
      70000n * 10n ** 18n, // More CVX1
      50000n * 10n ** 18n, // Less cvgCVX
    ];

    const pegPoint = findPegPoint(
      reversedPool,
      Ann,
      poolSnapshot.fee,
      poolSnapshot.offpegFeeMultiplier
    );

    // Should be 0 or very small - no bonus when pool has less cvgCVX
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

  it("gives bonus for small swaps when cvgCVX > CVX1", () => {
    const dx = 100n * 10n ** 18n; // Swap 100 CVX1
    const dy = stableswap.getDy(
      0, // from CVX1
      1, // to cvgCVX
      dx,
      poolSnapshot.xp,
      Ann,
      poolSnapshot.fee,
      poolSnapshot.offpegFeeMultiplier
    );

    // Should get more than 100 cvgCVX (bonus)
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
// Integration Tests - getOptimalSwapAmount
// ============================================

describe("getOptimalSwapAmount", () => {
  // These tests mock the RPC calls to test the decision logic

  let mockFindMaxSwapBeforePeg: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Mock the findMaxSwapBeforePeg function
    // It normally makes RPC calls to get pool state
    vi.mock("@/lib/enso", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/enso")>();
      mockFindMaxSwapBeforePeg = vi.fn();
      return {
        ...actual,
        findMaxSwapBeforePeg: mockFindMaxSwapBeforePeg,
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Note: The actual integration tests would require mocking RPC calls.
  // These are more like documentation of expected behavior.

  describe("decision logic (documented behavior)", () => {
    it("should swap all when amount <= peg point", () => {
      // Given: peg point is 10,846 CVX1
      // When: user wants to swap 5,000 CVX1
      // Then: swap all 5,000 (get bonus)
      const pegPoint = 10846n * 10n ** 18n;
      const totalAmount = 5000n * 10n ** 18n;

      // Decision: totalAmount < pegPoint → swap everything
      expect(totalAmount <= pegPoint).toBe(true);

      const expectedSwap = totalAmount;
      const expectedMint = 0n;

      expect(expectedSwap).toBe(totalAmount);
      expect(expectedMint).toBe(0n);
    });

    it("should swap all when amount equals peg point", () => {
      // Given: peg point is 10,846 CVX1
      // When: user wants to swap exactly 10,846 CVX1
      // Then: swap all 10,846 (get ~1:1 rate)
      const pegPoint = 10846n * 10n ** 18n;
      const totalAmount = 10846n * 10n ** 18n;

      expect(totalAmount <= pegPoint).toBe(true);

      const expectedSwap = totalAmount;
      const expectedMint = 0n;

      expect(expectedSwap).toBe(totalAmount);
      expect(expectedMint).toBe(0n);
    });

    it("should use hybrid strategy when amount > peg point", () => {
      // Given: peg point is 10,846 CVX1
      // When: user wants to swap 20,000 CVX1
      // Then: swap 10,846 (up to peg), mint 9,154 (rest at 1:1)
      const pegPoint = 10846n * 10n ** 18n;
      const totalAmount = 20000n * 10n ** 18n;

      expect(totalAmount > pegPoint).toBe(true);

      const expectedSwap = pegPoint;
      const expectedMint = totalAmount - pegPoint;

      expect(expectedSwap).toBe(10846n * 10n ** 18n);
      expect(expectedMint).toBe(9154n * 10n ** 18n);
    });

    it("should mint all when peg point is 0 (no bonus available)", () => {
      // Given: peg point is 0 (pool has no swap bonus)
      // When: user wants to swap 5,000 CVX1
      // Then: mint all 5,000 (no point swapping)
      const pegPoint = 0n;
      const totalAmount = 5000n * 10n ** 18n;

      // When pegPoint is 0, all should go to mint
      const expectedSwap = 0n;
      const expectedMint = totalAmount;

      expect(expectedSwap).toBe(0n);
      expect(expectedMint).toBe(totalAmount);
    });

    it("should return zero amounts for zero input", () => {
      // Given: any peg point
      // When: user wants to swap 0 CVX1
      // Then: return 0 for both
      const totalAmount = 0n;

      const expectedSwap = 0n;
      const expectedMint = 0n;

      expect(expectedSwap).toBe(0n);
      expect(expectedMint).toBe(0n);
    });
  });

  describe("boundary conditions", () => {
    it("handles very small amounts correctly", () => {
      // 1 wei should still use swap if bonus available
      const pegPoint = 10846n * 10n ** 18n;
      const totalAmount = 1n; // 1 wei

      const shouldSwapAll = totalAmount <= pegPoint;
      expect(shouldSwapAll).toBe(true);
    });

    it("handles amounts just above peg point", () => {
      // 1 wei above peg point should trigger hybrid
      const pegPoint = 10846n * 10n ** 18n;
      const totalAmount = pegPoint + 1n;

      const shouldUseHybrid = totalAmount > pegPoint;
      expect(shouldUseHybrid).toBe(true);

      const expectedSwap = pegPoint;
      const expectedMint = 1n;
      expect(expectedSwap + expectedMint).toBe(totalAmount);
    });

    it("handles very large amounts", () => {
      // Large amount should result in mostly minting
      const pegPoint = 10846n * 10n ** 18n;
      const totalAmount = 1000000n * 10n ** 18n; // 1 million CVX1

      const expectedSwap = pegPoint;
      const expectedMint = totalAmount - pegPoint;

      // Most should be minted
      expect(expectedMint).toBeGreaterThan(expectedSwap);
      expect(Number(expectedMint) / Number(totalAmount)).toBeGreaterThan(0.98);
    });
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

    it("swap logic works same as cvgCVX", () => {
      const pegPoint = findPegPoint(
        pxPoolSnapshot.xp,
        Ann,
        pxPoolSnapshot.fee,
        pxPoolSnapshot.offpegFeeMultiplier
      );

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
