/**
 * Curve Pool Utilities
 *
 * This module provides helpers for interacting with Curve pools:
 * - RPC helpers for fetching pool data (with batching support)
 * - Off-chain StableSwap math for gas-free calculations
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
  batchRedeemAndEstimateSwap,
  estimateSwapOffchain,
  type CurvePoolParams,
  type StableSwapParams,
} from "./rpc";

// StableSwap math
export {
  // Constants
  N_COINS,
  A_PRECISION,
  FEE_DENOMINATOR,
  // Core math functions
  getD,
  getY,
  dynamicFee,
  getDy,
  getDy01,
  getDy10,
  findPegPoint,
  // Utility functions
  calculateMinDy,
  validateSlippage,
  computeAnn,
  type StableSwapPoolParams,
} from "./math";
