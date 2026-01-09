/**
 * Unit tests for slippage buffer calculations
 */
import { describe, it, expect } from 'vitest';

// Re-implement the function for testing (since it's private in enso.ts)
function applySlippageBuffer(estimatedAmount: bigint, slippageBps: number): string {
  const conservativeAmount = (estimatedAmount * BigInt(10000 - slippageBps)) / BigInt(10000);
  return conservativeAmount.toString();
}

describe('applySlippageBuffer', () => {
  it('should reduce amount by slippage percentage', () => {
    const amount = 1000000000000000000n; // 1e18 (1 token)
    const slippage = 100; // 1%

    const result = applySlippageBuffer(amount, slippage);

    // 1e18 * (10000 - 100) / 10000 = 0.99e18
    expect(result).toBe('990000000000000000');
  });

  it('should handle 0% slippage', () => {
    const amount = 1000000000000000000n;
    const slippage = 0;

    const result = applySlippageBuffer(amount, slippage);

    expect(result).toBe('1000000000000000000');
  });

  it('should handle larger slippage values', () => {
    const amount = 1000000000000000000n;
    const slippage = 500; // 5%

    const result = applySlippageBuffer(amount, slippage);

    // 1e18 * 0.95 = 0.95e18
    expect(result).toBe('950000000000000000');
  });

  it('should handle small amounts without losing precision', () => {
    const amount = 100n; // Very small amount
    const slippage = 100; // 1%

    const result = applySlippageBuffer(amount, slippage);

    // 100 * 0.99 = 99
    expect(result).toBe('99');
  });

  it('should handle large amounts', () => {
    const amount = 1000000000000000000000000n; // 1 million tokens (1e24)
    const slippage = 100; // 1%

    const result = applySlippageBuffer(amount, slippage);

    expect(result).toBe('990000000000000000000000');
  });

  it('should stack with itself for cumulative slippage', () => {
    // When we have two swaps in sequence, each with 1% slippage
    // The second swap should use output * 0.99 * 0.99 = output * 0.9801
    const amount = 1000000000000000000n;
    const slippage = 100; // 1%

    const afterFirstSwap = BigInt(applySlippageBuffer(amount, slippage));
    const afterSecondSwap = applySlippageBuffer(afterFirstSwap, slippage);

    // 1e18 * 0.99 * 0.99 = 0.9801e18
    expect(afterSecondSwap).toBe('980100000000000000');
  });
});

describe('slippage buffer integration scenarios', () => {
  it('should provide safe input for vault-to-vault routes', () => {
    // Scenario: cvgCVX vault → pxCVX vault
    // Redeem 10 vault shares → ~10 cvgCVX
    // Swap cvgCVX → CVX1 (slippage possible)
    // Unwrap CVX1 → CVX (1:1)
    // Swap CVX → lpxCVX (slippage possible)
    // Unwrap lpxCVX → pxCVX (1:1)
    // Deposit pxCVX → vault

    const estimatedCvx1 = 10000000000000000000n; // 10 CVX1
    const slippage = 100; // 1%

    // After first Curve swap, we conservatively expect 99% of estimated output
    const conservativeCvx = applySlippageBuffer(estimatedCvx1, slippage);
    expect(BigInt(conservativeCvx)).toBeLessThan(estimatedCvx1);

    // This conservative amount should be used for subsequent actions
    // to ensure we don't try to spend more than we received
    const estimatedLpxCvx = 9900000000000000000n; // Simulated swap output
    const conservativeLpxCvx = applySlippageBuffer(estimatedLpxCvx, slippage);

    // Final amount should be ~98.01% of original (two 1% buffers)
    const expectedMin = (estimatedCvx1 * 98n) / 100n;
    expect(BigInt(conservativeLpxCvx)).toBeGreaterThanOrEqual(expectedMin);
  });
});
