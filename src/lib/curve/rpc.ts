/**
 * Curve Pool RPC Helpers
 *
 * Optimized RPC calls for Curve pool interactions with batching support
 * to reduce network latency.
 */

import { PUBLIC_RPC_URLS } from "@/config/rpc";

// Function selectors
const SELECTORS = {
  // Old-style pools (int128 indices)
  GET_DY_INT128: "0x5e0d443f", // get_dy(int128,int128,uint256)
  // Factory-style pools (uint256 indices)
  GET_DY_UINT256: "0x556d6e9f", // get_dy(uint256,uint256,uint256)
  // Pool parameters
  BALANCES: "0x4903b0d1", // balances(uint256)
  A: "0xf446c1d0", // A() - amplification coefficient (some pools)
  A_PRECISE: "0x76a2f0f0", // A_precise() - amplification coefficient (other pools)
  FEE: "0xddca3f43", // fee()
  // Vault
  PREVIEW_REDEEM: "0x4cdad506", // previewRedeem(uint256)
  CONVERT_TO_ASSETS: "0x07a2d13a", // convertToAssets(uint256)
} as const;

interface RpcCall {
  to: string;
  data: string;
}

interface RpcBatchResult {
  id: number;
  result?: string;
  error?: { message: string };
}

/**
 * Execute multiple eth_call requests in a single HTTP request
 * Reduces latency by batching RPC calls
 */
export async function batchRpcCalls(calls: RpcCall[]): Promise<(bigint | null)[]> {
  if (calls.length === 0) return [];

  const batch = calls.map((call, id) => ({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: call.to, data: call.data }, "latest"],
  }));

  const response = await fetch(PUBLIC_RPC_URLS.llamarpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });

  const json = await response.json();

  // Handle case where response is not an array (RPC error, invalid response, etc.)
  if (!Array.isArray(json)) {
    return calls.map(() => null);
  }

  const results = json as RpcBatchResult[];

  // Sort by id to maintain order
  results.sort((a, b) => a.id - b.id);

  return results.map((r) => {
    if (r.result && r.result !== "0x" && r.result !== "0x0") {
      return BigInt(r.result);
    }
    return null;
  });
}

/**
 * Encode a uint256 parameter for calldata
 */
function encodeUint256(value: bigint | string | number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

/**
 * Get expected output from an old-style Curve pool (uses int128 indices)
 * These are pools like CVX1/cvgCVX that use get_dy(int128,int128,uint256)
 */
export async function getCurveGetDy(
  poolAddress: string,
  i: number,
  j: number,
  dx: string
): Promise<bigint | null> {
  try {
    const data =
      SELECTORS.GET_DY_INT128 +
      encodeUint256(i) +
      encodeUint256(j) +
      encodeUint256(dx);

    const response = await fetch(PUBLIC_RPC_URLS.llamarpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{ to: poolAddress, data }, "latest"],
        id: 1,
      }),
    });

    const result = (await response.json()) as { result?: string };
    if (result.result && result.result !== "0x") {
      return BigInt(result.result);
    }
    return null;
  } catch (error) {
    console.error("Error fetching get_dy:", error);
    return null;
  }
}

/**
 * Get expected output from a factory-style Curve pool (uses uint256 indices)
 * These are newer pools like lpxCVX/CVX that use get_dy(uint256,uint256,uint256)
 */
export async function getCurveGetDyFactory(
  poolAddress: string,
  i: number,
  j: number,
  dx: string
): Promise<bigint | null> {
  try {
    const data =
      SELECTORS.GET_DY_UINT256 +
      encodeUint256(i) +
      encodeUint256(j) +
      encodeUint256(dx);

    const response = await fetch(PUBLIC_RPC_URLS.llamarpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{ to: poolAddress, data }, "latest"],
        id: 1,
      }),
    });

    const result = (await response.json()) as { result?: string };
    if (result.result && result.result !== "0x") {
      return BigInt(result.result);
    }
    return null;
  } catch (error) {
    console.error("Error fetching get_dy (factory):", error);
    return null;
  }
}

/**
 * Build calldata for getCurveGetDy (int128 indices)
 */
export function buildGetDyCalldata(i: number, j: number, dx: string): string {
  return (
    SELECTORS.GET_DY_INT128 +
    encodeUint256(i) +
    encodeUint256(j) +
    encodeUint256(dx)
  );
}

/**
 * Build calldata for getCurveGetDyFactory (uint256 indices)
 */
export function buildGetDyFactoryCalldata(i: number, j: number, dx: string): string {
  return (
    SELECTORS.GET_DY_UINT256 +
    encodeUint256(i) +
    encodeUint256(j) +
    encodeUint256(dx)
  );
}

/**
 * Build calldata for previewRedeem
 */
export function buildPreviewRedeemCalldata(shares: string): string {
  return SELECTORS.PREVIEW_REDEEM + encodeUint256(shares);
}

/**
 * Build calldata for getting pool balance at index
 */
export function buildBalancesCalldata(index: number): string {
  return SELECTORS.BALANCES + encodeUint256(index);
}

/**
 * Fetch pool balances in a single batched call
 */
export async function getPoolBalances(
  poolAddress: string,
  numCoins: number = 2
): Promise<bigint[]> {
  const calls: RpcCall[] = [];
  for (let i = 0; i < numCoins; i++) {
    calls.push({
      to: poolAddress,
      data: buildBalancesCalldata(i),
    });
  }

  const results = await batchRpcCalls(calls);
  return results.map((r) => r ?? 0n);
}

export interface CurvePoolParams {
  balances: bigint[];
  A: bigint;
  fee: bigint;
}

/**
 * Fetch all pool parameters needed for off-chain swap calculation
 * Returns balances, A (amplification), and fee in a single batched call
 */
export async function getPoolParams(
  poolAddress: string,
  numCoins: number = 2
): Promise<CurvePoolParams> {
  const calls: RpcCall[] = [];

  // Add balance calls
  for (let i = 0; i < numCoins; i++) {
    calls.push({
      to: poolAddress,
      data: buildBalancesCalldata(i),
    });
  }

  // Add A call (try A_precise first, fall back to A)
  calls.push({
    to: poolAddress,
    data: SELECTORS.A_PRECISE,
  });

  // Add fee call
  calls.push({
    to: poolAddress,
    data: SELECTORS.FEE,
  });

  const results = await batchRpcCalls(calls);

  const balances = results.slice(0, numCoins).map((r) => r ?? 0n);
  let A = results[numCoins] ?? 0n;
  const fee = results[numCoins + 1] ?? 0n;

  // If A_precise returned 0, the pool might use A() instead
  // A_precise returns A * 100, A() returns A directly
  // We need to handle both cases
  if (A === 0n) {
    // Try fetching A() separately
    const [aResult] = await batchRpcCalls([
      { to: poolAddress, data: SELECTORS.A },
    ]);
    A = (aResult ?? 100n) * 100n; // Multiply by 100 to match A_precise format
  }

  return { balances, A, fee };
}

/**
 * Combined fetch: previewRedeem + getCurveGetDy in optimized sequence
 *
 * Since getCurveGetDy depends on previewRedeem result, we can't fully batch them.
 * But we can batch previewRedeem with pool params, then calculate locally if needed.
 *
 * This function fetches previewRedeem and immediately calls getCurveGetDy with the result.
 * The optimization is mainly in code organization - true batching requires off-chain math.
 */
export async function previewRedeemAndGetDy(
  vaultAddress: string,
  shares: string,
  poolAddress: string,
  i: number,
  j: number,
  poolType: "int128" | "uint256" = "int128"
): Promise<{ redeemAmount: bigint; swapOutput: bigint | null }> {
  // First call: previewRedeem
  const [redeemResult] = await batchRpcCalls([
    { to: vaultAddress, data: buildPreviewRedeemCalldata(shares) },
  ]);

  if (redeemResult === null) {
    throw new Error(`Failed to preview redeem for vault ${vaultAddress}`);
  }

  // Second call: getCurveGetDy with the redeem result
  const getDyFn = poolType === "int128" ? getCurveGetDy : getCurveGetDyFactory;
  const swapOutput = await getDyFn(poolAddress, i, j, redeemResult.toString());

  return {
    redeemAmount: redeemResult,
    swapOutput,
  };
}

/**
 * Preview redeem amount from an ERC4626 vault
 */
export async function previewRedeem(vaultAddress: string, shares: string): Promise<string> {
  const [result] = await batchRpcCalls([
    { to: vaultAddress, data: buildPreviewRedeemCalldata(shares) },
  ]);

  if (result === null) {
    throw new Error(`Failed to preview redeem for vault ${vaultAddress}`);
  }

  return result.toString();
}

/**
 * Batch multiple previewRedeem calls
 */
export async function batchPreviewRedeem(
  vaults: { address: string; shares: string }[]
): Promise<string[]> {
  const calls = vaults.map((v) => ({
    to: v.address,
    data: buildPreviewRedeemCalldata(v.shares),
  }));

  const results = await batchRpcCalls(calls);

  return results.map((r, i) => {
    if (r === null) {
      throw new Error(`Failed to preview redeem for vault ${vaults[i].address}`);
    }
    return r.toString();
  });
}

// ============================================
// Optimized Combined Helpers
// These batch multiple RPC calls and use off-chain math
// ============================================

// Import math functions for off-chain calculations
import { getDy, A_PRECISION, N_COINS } from "./math";

// Additional selectors for StableSwapNG pools
const STABLESWAP_SELECTORS = {
  OFFPEG_FEE_MULTIPLIER: "0x8edfdd5f", // offpeg_fee_multiplier()
} as const;

/**
 * StableSwap pool parameters with cache
 */
export interface StableSwapParams {
  balances: [bigint, bigint];
  A: bigint;
  Ann: bigint;
  fee: bigint;
  offpegFeeMultiplier: bigint;
}

// Cache for pool params (12 second TTL matches quote refresh)
const poolParamsCache = new Map<string, { data: StableSwapParams; timestamp: number }>();
const POOL_PARAMS_CACHE_TTL = 12_000; // 12 seconds

/**
 * Get StableSwap pool parameters with caching
 * Fetches balances, A, fee, and offpeg_fee_multiplier in a single batched call
 */
export async function getStableSwapParams(poolAddress: string): Promise<StableSwapParams> {
  const cacheKey = poolAddress.toLowerCase();
  const now = Date.now();
  const cached = poolParamsCache.get(cacheKey);

  if (cached && now - cached.timestamp < POOL_PARAMS_CACHE_TTL) {
    return cached.data;
  }

  // Build batch call for all pool parameters
  const calls: RpcCall[] = [
    { to: poolAddress, data: buildBalancesCalldata(0) },
    { to: poolAddress, data: buildBalancesCalldata(1) },
    { to: poolAddress, data: SELECTORS.A },
    { to: poolAddress, data: SELECTORS.FEE },
    { to: poolAddress, data: STABLESWAP_SELECTORS.OFFPEG_FEE_MULTIPLIER },
  ];

  const results = await batchRpcCalls(calls);

  const balance0 = results[0] ?? 0n;
  const balance1 = results[1] ?? 0n;
  const A = results[2] ?? 0n;
  const fee = results[3] ?? 0n;
  const offpegFeeMultiplier = results[4] ?? 0n;

  // Compute Ann = A * A_PRECISION * N_COINS
  const Ann = A * A_PRECISION * N_COINS;

  const data: StableSwapParams = {
    balances: [balance0, balance1],
    A,
    Ann,
    fee,
    offpegFeeMultiplier,
  };

  // Update cache
  poolParamsCache.set(cacheKey, { data, timestamp: now });

  return data;
}

/**
 * Clear pool params cache (useful for testing)
 */
export function clearPoolParamsCache(): void {
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
  const calls: RpcCall[] = [
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
    const balance0 = results[1] ?? 0n;
    const balance1 = results[2] ?? 0n;
    const A = results[3] ?? 0n;
    const fee = results[4] ?? 0n;
    const offpegFeeMultiplier = results[5] ?? 0n;
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

/**
 * OPTIMIZED: Get swap estimate using cached pool params + off-chain math
 *
 * Uses cached pool parameters when available, otherwise fetches and caches.
 * Calculates output using off-chain StableSwap math instead of RPC call.
 */
export async function estimateSwapOffchain(
  poolAddress: string,
  i: number,
  j: number,
  dx: string | bigint
): Promise<bigint> {
  const poolParams = await getStableSwapParams(poolAddress);
  const inputAmount = typeof dx === "string" ? BigInt(dx) : dx;

  return getDy(
    i,
    j,
    inputAmount,
    poolParams.balances,
    poolParams.Ann,
    poolParams.fee,
    poolParams.offpegFeeMultiplier
  );
}
