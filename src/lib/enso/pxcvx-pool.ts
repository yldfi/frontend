import type { TwocryptoParams } from "@yldfi/curve-amm-math";
import { PIREX } from "@/config/vaults";
import { cryptoswap, getCryptoSwapParams } from "@/lib/curve";
import { rpcWithFallback } from "./api";

/** Longest the peg-point re-check may take before it counts as a failed read. */
const PEG_RECHECK_TIMEOUT_MS = 2_500;

// ============================================================================
// pxCVX Pool Helper Functions (CryptoSwap pool - uses uint256 indices)
// ============================================================================

/**
 * Get the Curve CryptoSwap pool swap rate for CVX → lpxCVX
 * Returns the amount of lpxCVX you'd get for a given amount of CVX
 *
 * Uses off-chain math with cached pool parameters for reliability.
 * Falls back to on-chain RPC call if off-chain calculation fails.
 */
export async function getPxCvxSwapRate(amountIn: string): Promise<bigint> {
  try {
    // Use cached pool params + off-chain math (more reliable, no RPC rate limits)
    const params = await getCryptoSwapParams(PIREX.LPXCVX_CVX_POOL);
    return cryptoswap.getDy(params, 0, 1, BigInt(amountIn)); // CVX (0) → lpxCVX (1)
  } catch {
    // Fallback to on-chain RPC call
    const selector = "0x556d6e9f"; // get_dy(uint256,uint256,uint256)
    const i = "0".padStart(64, "0"); // CVX index
    const j = "1".padStart(64, "0"); // lpxCVX index
    const dx = BigInt(amountIn).toString(16).padStart(64, "0");

    const result = await rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: PIREX.LPXCVX_CVX_POOL, data: selector + i + j + dx }, "latest"],
    });
    return BigInt(result.result || "0");
  }
}

/**
 * Get expected CVX output for lpxCVX → CVX swap on Curve CryptoSwap pool
 * This is the reverse direction of getPxCvxSwapRate (for zap out)
 *
 * Uses off-chain math with cached pool parameters for reliability.
 * Falls back to on-chain RPC call if off-chain calculation fails.
 */
export async function getLpxCvxToCvxSwapRate(amountIn: string): Promise<bigint> {
  try {
    // Use cached pool params + off-chain math (more reliable, no RPC rate limits)
    const params = await getCryptoSwapParams(PIREX.LPXCVX_CVX_POOL);
    return cryptoswap.getDy(params, 1, 0, BigInt(amountIn)); // lpxCVX (1) → CVX (0)
  } catch {
    // Fallback to on-chain RPC call
    const selector = "0x556d6e9f"; // get_dy(uint256,uint256,uint256)
    const i = "1".padStart(64, "0"); // lpxCVX index
    const j = "0".padStart(64, "0"); // CVX index
    const dx = BigInt(amountIn).toString(16).padStart(64, "0");

    const result = await rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: PIREX.LPXCVX_CVX_POOL, data: selector + i + j + dx }, "latest"],
    });
    return BigInt(result.result || "0");
  }
}

// ============================================================================
// CryptoSwap Off-Chain Math (for pxCVX pool)
// Uses @yldfi/curve-amm-math via @/lib/curve for calculations
// ============================================================================

// Use cryptoswap functions from npm package via curve lib
export function cryptoSwapGetDy(
  params: TwocryptoParams,
  i: number,
  j: number,
  dx: bigint
): bigint {
  return cryptoswap.getDy(params, i, j, dx);
}

/**
 * Find peg point using off-chain CryptoSwap math (binary search)
 * Returns the maximum amount where swap output >= input (rate >= 1:1)
 * Wrapper for backwards compatibility (i=0, j=1)
 */
export function findPegPointOffchainCryptoSwap(params: TwocryptoParams): bigint {
  return cryptoswap.findPegPoint(params, 0, 1);
}

/** Read get_dy(i, j, dx) from the pool contract itself. Rejects when the node
 *  returns no usable result. */
async function getPoolDyOnChain(i: number, j: number, amountIn: bigint): Promise<bigint> {
  const selector = "0x556d6e9f"; // get_dy(uint256,uint256,uint256)
  const word = (n: bigint) => n.toString(16).padStart(64, "0");
  const result = await rpcWithFallback<{ result?: string }>({
    jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to: PIREX.LPXCVX_CVX_POOL, data: selector + word(BigInt(i)) + word(BigInt(j)) + word(amountIn) }, "latest"],
  });
  if (!result.result || result.result === "0x") {
    throw new Error("Pool get_dy returned no data");
  }
  return BigInt(result.result);
}

/**
 * Calculate optimal swap amount for pxCVX hybrid swap/mint strategy
 * Uses off-chain CryptoSwap math for efficiency (1 batched RPC call for the pool parameters, 1 eth_call to re-check the peg point)
 *
 * If swap rate (CVX → lpxCVX) > 1:1, swap gives bonus pxCVX
 * If swap rate < 1:1, mint directly via Pirex at 1:1
 */
export async function getOptimalPxCvxSwapAmount(totalCvxAmount: string): Promise<{ swapAmount: bigint; mintAmount: bigint }> {
  const totalAmount = BigInt(totalCvxAmount);

  if (totalAmount === 0n) {
    return { swapAmount: 0n, mintAmount: 0n };
  }

  try {
    // RPC call 1: Get all pool parameters in single batch (with caching)
    const params = await getCryptoSwapParams(PIREX.LPXCVX_CVX_POOL);

    // Check swap rate for total amount using off-chain math
    const dyForTotal = cryptoSwapGetDy(params, 0, 1, totalAmount);

    // If swapping everything gives >= 1:1, swap it all
    if (dyForTotal >= totalAmount) {
      return { swapAmount: totalAmount, mintAmount: 0n };
    }

    // Rate is < 1:1, find peg point using off-chain binary search
    let pegPoint = findPegPointOffchainCryptoSwap(params);

    if (pegPoint === 0n) {
      // No swap bonus available - mint everything
      return { swapAmount: 0n, mintAmount: totalAmount };
    }

    // Re-check the peg point against the pool contract's own get_dy. If the chain
    // gives less than 1:1 the off-chain model was optimistic: swap 1% less. If the
    // read fails, swap 2% less. A read that takes longer than the cap counts as
    // failed.
    try {
      const read = getPoolDyOnChain(0, 1, pegPoint);
      // The read may still settle after the cap fires; it must not surface as an
      // unhandled rejection.
      read.catch(() => {});

      let timer: ReturnType<typeof setTimeout> | undefined;
      const onChainDy = await Promise.race([
        read,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Peg point re-check timed out")),
            PEG_RECHECK_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timer));

      if (onChainDy < pegPoint) {
        // Off-chain was slightly optimistic, reduce by 1% for safety
        pegPoint = (pegPoint * 99n) / 100n;
      }
    } catch {
      // If verification fails, reduce by 2% as extra safety margin
      pegPoint = (pegPoint * 98n) / 100n;
    }

    // Cap at total amount
    const swapAmount = pegPoint > totalAmount ? totalAmount : pegPoint;

    return {
      swapAmount,
      mintAmount: totalAmount - swapAmount,
    };
  } catch (error) {
    console.error("Error calculating optimal pxCVX swap amount:", error);
    // On error, mint everything (safe fallback)
    return { swapAmount: 0n, mintAmount: totalAmount };
  }
}
