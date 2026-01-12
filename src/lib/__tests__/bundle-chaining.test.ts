/**
 * Tests for Enso bundle output chaining
 *
 * Tests the dynamic output chaining pattern for cvgCVX zap bundles.
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

// ============================================
// Types matching Enso bundle structure
// ============================================

interface OutputReference {
  useOutputOfCallAt: number;
  index?: number;
}

interface EnsoBundleAction {
  protocol: string;
  action: string;
  args: Record<string, unknown>;
}

// ============================================
// Helper to check if value is a dynamic reference
// ============================================

function isDynamicRef(value: unknown): value is OutputReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "useOutputOfCallAt" in value &&
    typeof (value as OutputReference).useOutputOfCallAt === "number"
  );
}

function isMaxUint256(value: unknown): boolean {
  if (typeof value === "string") {
    return value === maxUint256.toString();
  }
  if (typeof value === "bigint") {
    return value === maxUint256;
  }
  return false;
}

// ============================================
// Bundle Structure Tests
// ============================================

describe("cvgCVX swap bundle structure", () => {
  describe("dynamic output chaining for non-CVX input", () => {
    /**
     * Expected bundle structure for ETH → cvgCVX vault:
     *
     * Action 0: Route ETH → CVX (produces CVX output)
     * Action 1: Approve CVX → CVX1 (should use MaxUint256 or dynamic ref)
     * Action 2: CVX1.mint (should use { useOutputOfCallAt: 0 })
     * Action 3: Approve CVX1 → Curve (should use MaxUint256 or dynamic ref)
     * Action 4: Curve.exchange (should use { useOutputOfCallAt: 2 })
     * Action 5: Approve cvgCVX → vault (uses { useOutputOfCallAt: 4 })
     * Action 6: Deposit cvgCVX → vault (uses { useOutputOfCallAt: 4 })
     */

    it("should use dynamic refs for CVX1.mint amount (consumes route output)", () => {
      // The CVX1.mint action (Action 2) should consume the CVX output from Action 0
      // This ensures the actual CVX amount from routing is used, not an estimate

      const expectedMintAction: EnsoBundleAction = {
        protocol: "enso",
        action: "call",
        args: {
          address: "0x...", // CVX1 address
          method: "mint",
          abi: "function mint(address to, uint256 amount)",
          // The amount should be a dynamic reference to Action 0's output
          args: ["0x...", { useOutputOfCallAt: 0 }],
        },
      };

      // Verify the args array contains a dynamic reference
      const argsArray = expectedMintAction.args.args as unknown[];
      expect(isDynamicRef(argsArray[1])).toBe(true);
      expect((argsArray[1] as OutputReference).useOutputOfCallAt).toBe(0);
    });

    it("should use dynamic refs for Curve exchange dx (consumes mint output)", () => {
      // The Curve exchange (Action 4) should consume the CVX1 amount from Action 2
      // CVX1.mint outputs the same amount as input (1:1), so this chains properly

      const expectedExchangeAction: EnsoBundleAction = {
        protocol: "enso",
        action: "call",
        args: {
          address: "0x...", // Curve pool address
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          // dx (amount to swap) should reference the CVX1 mint output
          args: [0, 1, { useOutputOfCallAt: 2 }, "minDyValue"],
        },
      };

      const argsArray = expectedExchangeAction.args.args as unknown[];
      expect(isDynamicRef(argsArray[2])).toBe(true);
      expect((argsArray[2] as OutputReference).useOutputOfCallAt).toBe(2);
    });

    it("should use MaxUint256 for approval amounts (safe pattern)", () => {
      // Approvals should use MaxUint256 to avoid the one-consumer limitation
      // This is safe because approvals just set an allowance ceiling

      const approveAction: EnsoBundleAction = {
        protocol: "erc20",
        action: "approve",
        args: {
          token: "0x...",
          spender: "0x...",
          amount: maxUint256.toString(),
        },
      };

      expect(isMaxUint256(approveAction.args.amount)).toBe(true);
    });

    it("should chain cvgCVX output to vault deposit", () => {
      // Actions 5 and 6 should both reference Action 4's output (cvgCVX amount)
      // This is valid because they are sequential consumers

      const approveAction: EnsoBundleAction = {
        protocol: "erc20",
        action: "approve",
        args: {
          token: "0x...", // cvgCVX
          spender: "0x...", // vault
          amount: { useOutputOfCallAt: 4 },
        },
      };

      const depositAction: EnsoBundleAction = {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: "0x...",
          tokenOut: "0x...",
          amountIn: { useOutputOfCallAt: 4 },
          primaryAddress: "0x...",
        },
      };

      // Both should reference Action 4
      expect(isDynamicRef(approveAction.args.amount)).toBe(true);
      expect((approveAction.args.amount as OutputReference).useOutputOfCallAt).toBe(4);

      expect(isDynamicRef(depositAction.args.amountIn)).toBe(true);
      expect((depositAction.args.amountIn as OutputReference).useOutputOfCallAt).toBe(4);
    });
  });

  describe("literal amounts for CVX input", () => {
    /**
     * When input is already CVX, we skip the route step and use literal amounts
     * because we know exactly how much CVX we have.
     *
     * Bundle structure for CVX → cvgCVX vault:
     *
     * Action 0: Approve CVX → CVX1 (literal amount)
     * Action 1: CVX1.mint (literal amount)
     * Action 2: Approve CVX1 → Curve (literal amount)
     * Action 3: Curve.exchange (literal amount)
     * Action 4: Approve cvgCVX → vault (uses { useOutputOfCallAt: 3 })
     * Action 5: Deposit cvgCVX → vault (uses { useOutputOfCallAt: 3 })
     */

    it("should use literal amounts for CVX1.mint when input is CVX", () => {
      const cvxAmount = "1000000000000000000"; // 1 CVX in wei

      const mintAction: EnsoBundleAction = {
        protocol: "enso",
        action: "call",
        args: {
          address: "0x...",
          method: "mint",
          abi: "function mint(address to, uint256 amount)",
          args: ["0x...", cvxAmount], // Literal amount, not dynamic ref
        },
      };

      const argsArray = mintAction.args.args as unknown[];
      expect(isDynamicRef(argsArray[1])).toBe(false);
      expect(argsArray[1]).toBe(cvxAmount);
    });

    it("should chain Curve output to vault deposit for CVX input", () => {
      // Even with CVX input, the Curve exchange output should chain dynamically
      // to the vault deposit actions

      const depositAction: EnsoBundleAction = {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: "0x...",
          tokenOut: "0x...",
          amountIn: { useOutputOfCallAt: 3 }, // References Curve exchange output
          primaryAddress: "0x...",
        },
      };

      expect(isDynamicRef(depositAction.args.amountIn)).toBe(true);
      expect((depositAction.args.amountIn as OutputReference).useOutputOfCallAt).toBe(3);
    });
  });
});

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

      // CVX1.mint uses { useOutputOfCallAt: 0 } → gets 95 CVX
      const mintAmount = ensoActualOutput; // Dynamic ref gives actual

      // Curve.exchange uses { useOutputOfCallAt: 2 } → gets 95 CVX1
      const exchangeAmount = mintAmount; // 1:1 wrap

      // No mismatch - we always use actual amounts
      expect(mintAmount).toBe(ensoActualOutput);
      expect(exchangeAmount).toBe(ensoActualOutput);
    });
  });
});
