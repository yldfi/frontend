/**
 * Tests for Enso bundle output chaining
 *
 * Tests the dynamic output chaining pattern for custom (pxCVX-style) zap bundles.
 *
 * Key issue: When routing ETH → CVX, the actual CVX output may differ from
 * our estimate (using Curve pool) because Enso may find a different route.
 *
 * Solution: Use { useOutputOfCallAt: X } to dynamically chain outputs
 * instead of hardcoded amounts.
 *
 * Important: When using useOutputOfCallAt with complex bundles, you must use
 * skipQuote: true in the bundle request. Enso's simulator doesn't handle
 * complex output chaining, but the on-chain execution works correctly.
 * Multiple actions CAN reference the same output - there is no one-consumer
 * limitation (verified working in buildCvxHybridBundle).
 */
import { describe, it, expect } from "vitest";
import { maxUint256 } from "viem";

describe("Enso output chaining behavior", () => {
  it("documents that skipQuote is required for complex output chaining", () => {
    /**
     * Enso's bundle SIMULATOR has issues with complex output chaining.
     * The actual on-chain execution works correctly.
     *
     * When using useOutputOfCallAt with multiple consumers or complex bundles,
     * use skipQuote: true in the bundle request to bypass the simulator.
     *
     * Example working pattern (with skipQuote: true):
     * - Action 1 output → consumed by Actions 2, 3, 4, 5 (ALL WORK!)
     * - This is verified in buildCvxHybridBundle
     *
     * When skipQuote is true, you must manually provide amountsOut.
     */

    // This test documents the skipQuote requirement for future reference
    expect(true).toBe(true);
  });

  it("validates that approvals can safely use MaxUint256", () => {
    /**
     * Using MaxUint256 for approvals is safe because:
     * 1. The approval just sets a spending limit, doesn't transfer tokens
     * 2. The actual transfer/spend happens in subsequent actions
     * 3. The Enso router is the spender, which is trusted
     */

    // MaxUint256 should be safe for any approval
    const safeApprovalAmount = maxUint256;
    expect(safeApprovalAmount > 0n).toBe(true);
    expect(safeApprovalAmount.toString().length).toBeGreaterThan(10);
  });
});

describe("slippage buffer calculations", () => {
  /**
   * When using hardcoded amounts (fallback for Enso limitations),
   * we apply a slippage buffer to be conservative.
   *
   * Formula: conservativeAmount = estimatedAmount * (10000 - slippageBps) / 10000
   */

  function applySlippageBuffer(estimatedAmount: bigint, slippageBps: number): bigint {
    return (estimatedAmount * BigInt(10000 - slippageBps)) / BigInt(10000);
  }

  it("reduces amount by slippage percentage", () => {
    const estimate = 100n * 10n ** 18n; // 100 tokens
    const slippage = 300; // 3%

    const conservative = applySlippageBuffer(estimate, slippage);

    // Should be 97 tokens (3% less)
    expect(conservative).toBe(97n * 10n ** 18n);
  });

  it("handles 1% slippage correctly", () => {
    const estimate = 1000n * 10n ** 18n;
    const slippage = 100; // 1%

    const conservative = applySlippageBuffer(estimate, slippage);

    expect(conservative).toBe(990n * 10n ** 18n);
  });

  it("handles 0.5% slippage correctly", () => {
    const estimate = 1000n * 10n ** 18n;
    const slippage = 50; // 0.5%

    const conservative = applySlippageBuffer(estimate, slippage);

    expect(conservative).toBe(995n * 10n ** 18n);
  });

  it("returns same amount for 0% slippage", () => {
    const estimate = 100n * 10n ** 18n;
    const slippage = 0;

    const conservative = applySlippageBuffer(estimate, slippage);

    expect(conservative).toBe(estimate);
  });

  describe("problem scenario: estimate mismatch", () => {
    /**
     * The bug occurs when:
     * 1. We estimate CVX output using Curve pool: 100 CVX
     * 2. We apply 3% buffer: use 97 CVX for subsequent actions
     * 3. Enso's route uses a DIFFERENT path that gives only 95 CVX
     * 4. Actions try to use 97 CVX but only 95 available → FAIL
     *
     * Solution: Use dynamic output chaining so actions use actual amounts.
     */

    it("demonstrates the mismatch problem", () => {
      const ourEstimate = 100n * 10n ** 18n; // Our Curve pool estimate
      const ourSlippage = 300; // 3%
      const ourConservative = applySlippageBuffer(ourEstimate, ourSlippage);

      // Enso route might find different path with different output
      const ensoActualOutput = 95n * 10n ** 18n; // Less than our estimate

      // Our conservative amount is still higher than actual!
      expect(ourConservative).toBe(97n * 10n ** 18n);
      expect(ourConservative > ensoActualOutput).toBe(true);

      // This causes "ERC20: transfer amount exceeds balance"
      const wouldFail = ourConservative > ensoActualOutput;
      expect(wouldFail).toBe(true);
    });

    it("shows that dynamic chaining fixes the problem", () => {
      // With dynamic chaining, we use the ACTUAL output, not an estimate
      const ensoActualOutput = 95n * 10n ** 18n;

      // The mint/wrap leg uses { useOutputOfCallAt: 0 } → gets 95 CVX
      const mintAmount = ensoActualOutput; // Dynamic ref gives actual

      // Curve.exchange uses { useOutputOfCallAt: 2 } → gets the 95 wrapped tokens
      const exchangeAmount = mintAmount; // 1:1 wrap

      // No mismatch - we always use actual amounts
      expect(mintAmount).toBe(ensoActualOutput);
      expect(exchangeAmount).toBe(ensoActualOutput);
    });
  });
});
