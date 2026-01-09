/**
 * Curve Pool Utilities
 *
 * This module provides helpers for interacting with Curve pools:
 * - RPC helpers for fetching pool data (with batching support)
 * - Off-chain StableSwap/CryptoSwap math via @yldfi/curve-amm-math
 */

// RPC helpers
export {
  batchRpcCalls,
  getCurveGetDy,
  getCurveGetDyFactory,
  buildGetDyCalldata,
  buildGetDyFactoryCalldata,
  buildPreviewRedeemCalldata,
  buildBalancesCalldata,
  getPoolBalances,
  getPoolParams,
  previewRedeemAndGetDy,
  previewRedeem,
  batchPreviewRedeem,
  // Optimized helpers with caching + off-chain math
  getStableSwapParams,
  clearPoolParamsCache,
  estimateSwapOffchain,
  // Selectors for building calldata
  SELECTORS,
  STABLESWAP_SELECTORS,
  type CurvePoolParams,
  type StableSwapParams,
} from "./rpc";

// Vault + Curve combined helpers
export { batchRedeemAndEstimateSwap, clearVaultCurveCache } from "@/lib/helpers/vault-curve";

// Re-export curve-amm-math library
export {
  stableswap,
  stableswapExact,
  cryptoswap,
  A_PRECISION,
  STABLESWAP_FEE_DENOMINATOR,
  CRYPTOSWAP_FEE_DENOMINATOR,
} from "@yldfi/curve-amm-math";

export type {
  StableSwapPoolParams,
  ExactPoolParams,
  CryptoSwapParams,
  TwocryptoParams,
  TricryptoParams,
} from "@yldfi/curve-amm-math";

// Backward compatibility aliases for existing imports
// These re-export stableswap functions at top level for minimal migration
import { stableswap } from "@yldfi/curve-amm-math";

export const N_COINS = 2n; // For backward compat with 2-coin pools
export const FEE_DENOMINATOR = stableswap.FEE_DENOMINATOR;
export const getD = stableswap.getD;
export const getY = stableswap.getY;
export const dynamicFee = stableswap.dynamicFee;
export const getDy = stableswap.getDy;
export const computeAnn = stableswap.computeAnn;
export const calculateMinDy = stableswap.calculateMinDy;
export const validateSlippage = stableswap.validateSlippage;

// findPegPoint wrapper for backward compatibility (2-coin pools with i=0, j=1)
export function findPegPoint(
  xp: [bigint, bigint],
  Ann: bigint,
  fee: bigint,
  feeMultiplier: bigint,
  precision?: bigint
): bigint {
  return stableswap.findPegPoint(0, 1, xp, Ann, fee, feeMultiplier, precision);
}

// Legacy aliases for 2-coin convenience functions
export function getDy01(
  dx: bigint,
  xp: [bigint, bigint],
  Ann: bigint,
  baseFee: bigint,
  feeMultiplier: bigint
): bigint {
  return stableswap.getDy(0, 1, dx, xp, Ann, baseFee, feeMultiplier);
}

export function getDy10(
  dx: bigint,
  xp: [bigint, bigint],
  Ann: bigint,
  baseFee: bigint,
  feeMultiplier: bigint
): bigint {
  return stableswap.getDy(1, 0, dx, xp, Ann, baseFee, feeMultiplier);
}
