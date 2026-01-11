/**
 * Vault + Curve Combined Helpers
 *
 * Optimized helpers that combine ERC4626 vault operations with Curve pool math.
 * These batch RPC calls and use off-chain calculations for efficiency.
 */

import { stableswap, A_PRECISION } from "@yldfi/curve-amm-math";
import {
  batchRpcCalls,
  buildPreviewRedeemCalldata,
  buildBalancesCalldata,
  SELECTORS,
  STABLESWAP_SELECTORS,
  type StableSwapParams,
} from "@/lib/curve/rpc";

const { getDy } = stableswap;
const N_COINS = 2n;

// Cache for pool params (12 second TTL matches quote refresh)
const poolParamsCache = new Map<string, { data: StableSwapParams; timestamp: number }>();
const POOL_PARAMS_CACHE_TTL = 12_000; // 12 seconds

/**
 * Clear pool params cache (useful for testing)
 */
export function clearVaultCurveCache(): void {
  poolParamsCache.clear();
}

/**
 * OPTIMIZED: Batch previewRedeem + pool params, calculate getDy locally
 *
 * This reduces 2 sequential RPC calls to 1 batched call + local computation.
 * ~50% latency reduction for vault-to-vault routes.
 *
 * @param vaultAddress - ERC4626 vault to redeem from
 * @param shares - Amount of vault shares
 * @param poolAddress - Curve pool for swap estimation
 * @param i - Input token index in pool
 * @param j - Output token index in pool
 * @param conservativeBuffer - Reduce input by this factor (default 0.99 = 1% buffer)
 * @returns Redeem amount and estimated swap output
 */
export async function batchRedeemAndEstimateSwap(
  vaultAddress: string,
  shares: string,
  poolAddress: string,
  i: number,
  j: number,
  conservativeBuffer: number = 0.99
): Promise<{ redeemAmount: bigint; swapOutput: bigint }> {
  // Check pool params cache first
  const cacheKey = poolAddress.toLowerCase();
  const now = Date.now();
  const cachedParams = poolParamsCache.get(cacheKey);
  const needsPoolParams = !cachedParams || now - cachedParams.timestamp >= POOL_PARAMS_CACHE_TTL;

  // Build batch call - always include previewRedeem, optionally include pool params
  const calls: { to: string; data: string }[] = [
    { to: vaultAddress, data: buildPreviewRedeemCalldata(shares) },
  ];

  if (needsPoolParams) {
    calls.push(
      { to: poolAddress, data: buildBalancesCalldata(0) },
      { to: poolAddress, data: buildBalancesCalldata(1) },
      { to: poolAddress, data: SELECTORS.A },
      { to: poolAddress, data: SELECTORS.FEE },
      { to: poolAddress, data: STABLESWAP_SELECTORS.OFFPEG_FEE_MULTIPLIER }
    );
  }

  const results = await batchRpcCalls(calls);

  // Extract redeem amount
  const redeemAmount = results[0];
  if (redeemAmount === null) {
    throw new Error(`Failed to preview redeem for vault ${vaultAddress}`);
  }

  // Get pool params (from batch or cache)
  let poolParams: StableSwapParams;
  if (needsPoolParams) {
    const balance0 = results[1];
    const balance1 = results[2];
    const A = results[3];
    const fee = results[4] ?? 0n;
    const offpegFeeMultiplier = results[5] ?? 0n;

    // Validate critical pool parameters
    if (balance0 === null || balance1 === null || A === null) {
      throw new Error(`Failed to fetch pool parameters for ${poolAddress}`);
    }

    // Validate balances are non-zero to avoid division by zero in getD
    if (balance0 === 0n || balance1 === 0n) {
      throw new Error(`Pool ${poolAddress} has zero balance - cannot calculate swap output`);
    }

    const Ann = A * A_PRECISION * N_COINS;

    poolParams = {
      balances: [balance0, balance1],
      A,
      Ann,
      fee,
      offpegFeeMultiplier,
    };

    // Update cache
    poolParamsCache.set(cacheKey, { data: poolParams, timestamp: now });
  } else {
    poolParams = cachedParams!.data;
  }

  // Apply conservative buffer to redeem amount
  const conservativeInput = BigInt(Math.floor(Number(redeemAmount) * conservativeBuffer));

  // Calculate swap output using off-chain math
  const swapOutput = getDy(
    i,
    j,
    conservativeInput,
    poolParams.balances,
    poolParams.Ann,
    poolParams.fee,
    poolParams.offpegFeeMultiplier
  );

  return {
    redeemAmount,
    swapOutput,
  };
}
