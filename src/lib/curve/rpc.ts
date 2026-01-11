/**
 * Curve Pool RPC Helpers
 *
 * Optimized RPC calls for Curve pool interactions with batching support
 * to reduce network latency.
 */

import { PUBLIC_RPC_URLS } from "@/config/rpc";

// Use DEBUG_RPC_URL if available (more reliable, higher rate limits)
// Falls back to public llamarpc for production
const getRpcUrl = (): string => {
  if (typeof process !== "undefined" && process.env?.DEBUG_RPC_URL) {
    return process.env.DEBUG_RPC_URL;
  }
  return PUBLIC_RPC_URLS.llamarpc;
};

const getRpcAuth = (): string | undefined => {
  if (typeof process !== "undefined" && process.env?.DEBUG_RPC_AUTH) {
    return process.env.DEBUG_RPC_AUTH;
  }
  return undefined;
};

// Function selectors (exported for helpers)
export const SELECTORS = {
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

// CryptoSwap (Curve V2) selectors
export const CRYPTOSWAP_SELECTORS = {
  A: "0xf446c1d0", // A()
  GAMMA: "0xb1373929", // gamma()
  D: "0x0f529ba2", // D()
  MID_FEE: "0x92526c0c", // mid_fee()
  OUT_FEE: "0xee8de675", // out_fee()
  FEE_GAMMA: "0x72d4f0e2", // fee_gamma()
  PRICE_SCALE: "0xb9e8c9fd", // price_scale()
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
 * Includes retry logic for RPC resilience
 */
export async function batchRpcCalls(calls: RpcCall[]): Promise<(bigint | null)[]> {
  if (calls.length === 0) return [];

  const rpcUrl = getRpcUrl();
  const rpcAuth = getRpcAuth();

  const batch = calls.map((call, id) => ({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: call.to, data: call.data }, "latest"],
  }));

  const maxRetries = 5;
  const baseDelayMs = 500;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (rpcAuth) {
        headers["Authorization"] = `Basic ${rpcAuth}`;
      }

      const response = await fetch(rpcUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
      });

      if (!response.ok) {
        throw new Error(`RPC batch request failed: ${response.status}`);
      }

      const json = await response.json();

      // Handle case where response is not an array (RPC error, invalid response, etc.)
      if (!Array.isArray(json)) {
        throw new Error("RPC batch response is not an array");
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
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  console.error("batchRpcCalls failed after retries:", lastError);
  return calls.map(() => null);
}

/**
 * Encode a uint256 parameter for calldata
 */
function encodeUint256(value: bigint | string | number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  baseDelayMs = 500
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Get expected output from an old-style Curve pool (uses int128 indices)
 * These are pools like CVX1/cvgCVX that use get_dy(int128,int128,uint256)
 * Includes retry logic for RPC resilience
 */
export async function getCurveGetDy(
  poolAddress: string,
  i: number,
  j: number,
  dx: string
): Promise<bigint | null> {
  const rpcUrl = getRpcUrl();
  const rpcAuth = getRpcAuth();

  const data =
    SELECTORS.GET_DY_INT128 +
    encodeUint256(i) +
    encodeUint256(j) +
    encodeUint256(dx);

  try {
    return await withRetry(async () => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (rpcAuth) {
        headers["Authorization"] = `Basic ${rpcAuth}`;
      }

      const response = await fetch(rpcUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_call",
          params: [{ to: poolAddress, data }, "latest"],
          id: 1,
        }),
      });

      if (!response.ok) {
        throw new Error(`RPC request failed: ${response.status}`);
      }

      const result = (await response.json()) as { result?: string; error?: { message: string } };
      if (result.error) {
        throw new Error(`RPC error: ${result.error.message}`);
      }
      if (result.result && result.result !== "0x") {
        return BigInt(result.result);
      }
      return null;
    });
  } catch (error) {
    console.error("Error fetching get_dy after retries:", error);
    return null;
  }
}

/**
 * Get expected output from a factory-style Curve pool (uses uint256 indices)
 * These are newer pools like lpxCVX/CVX that use get_dy(uint256,uint256,uint256)
 * Includes retry logic for RPC resilience
 */
export async function getCurveGetDyFactory(
  poolAddress: string,
  i: number,
  j: number,
  dx: string
): Promise<bigint | null> {
  const rpcUrl = getRpcUrl();
  const rpcAuth = getRpcAuth();

  const data =
    SELECTORS.GET_DY_UINT256 +
    encodeUint256(i) +
    encodeUint256(j) +
    encodeUint256(dx);

  try {
    return await withRetry(async () => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (rpcAuth) {
        headers["Authorization"] = `Basic ${rpcAuth}`;
      }

      const response = await fetch(rpcUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_call",
          params: [{ to: poolAddress, data }, "latest"],
          id: 1,
        }),
      });

      if (!response.ok) {
        throw new Error(`RPC request failed: ${response.status}`);
      }

      const result = (await response.json()) as { result?: string; error?: { message: string } };
      if (result.error) {
        throw new Error(`RPC error: ${result.error.message}`);
      }
      if (result.result && result.result !== "0x") {
        return BigInt(result.result);
      }
      return null;
    });
  } catch (error) {
    console.error("Error fetching get_dy (factory) after retries:", error);
    return null;
  }
}

// ============================================
// ETH → CVX On-Chain Pricing (via Curve V2 Pool)
// ============================================

// Curve V2 ETH/CVX Pool (WETH/CVX) - used for on-chain price discovery
// Index 0: WETH, Index 1: CVX
const CURVE_ETH_CVX_POOL = "0xB576491F1E6e5E62f1d8F26062Ee822B40B0E0d4";

// Cache for ETH→CVX rate (valid for 30 seconds to reduce RPC calls)
let ethToCvxRateCache: {
  rate: bigint; // CVX per ETH (in wei units, e.g., 1500e18 means 1 ETH = 1500 CVX)
  timestamp: number;
} | null = null;
const ETH_CVX_CACHE_TTL = 30 * 1000; // 30 seconds

/**
 * Get estimated CVX output for ETH input using on-chain Curve pool pricing.
 * This avoids making a separate Enso route call for price discovery.
 * Uses RPC calls which don't count against Enso's API rate limit.
 *
 * @param ethAmount - Amount of ETH in wei
 * @returns Estimated CVX output in wei
 * @throws Error if RPC call fails after retries
 */
export async function getEthToCvxEstimate(ethAmount: string): Promise<string> {
  const now = Date.now();
  const ethBigInt = BigInt(ethAmount);

  // Check cache first
  if (ethToCvxRateCache && now - ethToCvxRateCache.timestamp < ETH_CVX_CACHE_TTL) {
    const cvxEstimate = (ethBigInt * ethToCvxRateCache.rate) / (10n ** 18n);
    return cvxEstimate.toString();
  }

  // Fetch real-time price from Curve V2 ETH/CVX pool via RPC
  // Index 0: WETH, Index 1: CVX (V2 pools use uint256 indices)
  // Retry up to 3 times with exponential backoff
  let cvxOutput: bigint | null = null;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 100ms, 200ms
      await new Promise(resolve => setTimeout(resolve, 100 * attempt));
    }

    cvxOutput = await getCurveGetDyFactory(CURVE_ETH_CVX_POOL, 0, 1, ethAmount);

    if (cvxOutput && cvxOutput > 0n) {
      break;
    }

    lastError = new Error(`Attempt ${attempt + 1}: RPC returned ${cvxOutput}`);
  }

  if (!cvxOutput || cvxOutput === 0n) {
    throw new Error(`Failed to fetch ETH/CVX price from Curve pool after 3 attempts: ${lastError?.message}`);
  }

  // Update cache with implied rate
  if (ethBigInt > 0n) {
    const rate = (cvxOutput * (10n ** 18n)) / ethBigInt;
    ethToCvxRateCache = { rate, timestamp: now };
  }

  return cvxOutput.toString();
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
import { stableswap, cryptoswap, A_PRECISION } from "@yldfi/curve-amm-math";
import type { TwocryptoParams } from "@yldfi/curve-amm-math";
const { getDy } = stableswap;
const N_COINS = 2n; // For 2-coin StableSwap pools

// Additional selectors for StableSwapNG pools
export const STABLESWAP_SELECTORS = {
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

// ============================================
// CryptoSwap (Curve V2) Pool Helpers
// ============================================

/**
 * CryptoSwap pool parameters - matches TwocryptoParams from curve-amm-math
 */
export type CryptoSwapParams = TwocryptoParams;

// Cache for CryptoSwap pool params (12 second TTL matches quote refresh)
const cryptoPoolParamsCache = new Map<string, { data: CryptoSwapParams; timestamp: number }>();
const CRYPTO_POOL_PARAMS_CACHE_TTL = 12_000; // 12 seconds

/**
 * Get CryptoSwap (Curve V2) pool parameters with caching
 * Fetches A, gamma, D, fees, priceScale, and balances in a single batched call
 * Retries up to 3 times on failure.
 *
 * @throws Error if critical parameters (A, gamma, D) are zero/missing after retries
 */
export async function getCryptoSwapParams(poolAddress: string): Promise<CryptoSwapParams> {
  const cacheKey = poolAddress.toLowerCase();
  const now = Date.now();
  const cached = cryptoPoolParamsCache.get(cacheKey);

  if (cached && now - cached.timestamp < CRYPTO_POOL_PARAMS_CACHE_TTL) {
    return cached.data;
  }

  // Build batch call for all pool parameters
  const calls: RpcCall[] = [
    { to: poolAddress, data: CRYPTOSWAP_SELECTORS.A },
    { to: poolAddress, data: CRYPTOSWAP_SELECTORS.GAMMA },
    { to: poolAddress, data: CRYPTOSWAP_SELECTORS.D },
    { to: poolAddress, data: CRYPTOSWAP_SELECTORS.MID_FEE },
    { to: poolAddress, data: CRYPTOSWAP_SELECTORS.OUT_FEE },
    { to: poolAddress, data: CRYPTOSWAP_SELECTORS.FEE_GAMMA },
    { to: poolAddress, data: CRYPTOSWAP_SELECTORS.PRICE_SCALE },
    { to: poolAddress, data: buildBalancesCalldata(0) },
    { to: poolAddress, data: buildBalancesCalldata(1) },
  ];

  // Retry up to 3 times with exponential backoff
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 100ms, 200ms
      await new Promise(resolve => setTimeout(resolve, 100 * attempt));
    }

    const results = await batchRpcCalls(calls);

    const A = results[0] ?? 0n;
    const gamma = results[1] ?? 0n;
    const D = results[2] ?? 0n;
    const midFee = results[3] ?? 0n;
    const outFee = results[4] ?? 0n;
    const feeGamma = results[5] ?? 0n;
    const priceScale = results[6] ?? 0n;
    const balance0 = results[7] ?? 0n;
    const balance1 = results[8] ?? 0n;

    // Validate critical parameters
    if (A === 0n) {
      lastError = new Error(`CryptoSwap pool ${poolAddress}: A parameter is zero (attempt ${attempt + 1})`);
      continue;
    }
    if (gamma === 0n) {
      lastError = new Error(`CryptoSwap pool ${poolAddress}: gamma parameter is zero (attempt ${attempt + 1})`);
      continue;
    }
    if (D === 0n && (balance0 > 0n || balance1 > 0n)) {
      lastError = new Error(`CryptoSwap pool ${poolAddress}: D is zero but pool has balances (attempt ${attempt + 1})`);
      continue;
    }

    // Success - all critical params are valid
    const data: CryptoSwapParams = {
      A,
      gamma,
      D,
      midFee,
      outFee,
      feeGamma,
      priceScale,
      balances: [balance0, balance1],
    };

    // Update cache
    cryptoPoolParamsCache.set(cacheKey, { data, timestamp: Date.now() });

    return data;
  }

  // All retries failed
  throw lastError ?? new Error(`CryptoSwap pool ${poolAddress}: failed to fetch params after 3 attempts`);
}

/**
 * Clear CryptoSwap pool params cache (useful for testing)
 */
export function clearCryptoPoolParamsCache(): void {
  cryptoPoolParamsCache.clear();
}

/**
 * Get swap estimate for CryptoSwap pool using cached params + off-chain math
 */
export async function estimateCryptoSwapOffchain(
  poolAddress: string,
  i: number,
  j: number,
  dx: string | bigint
): Promise<bigint> {
  const poolParams = await getCryptoSwapParams(poolAddress);
  const inputAmount = typeof dx === "string" ? BigInt(dx) : dx;

  return cryptoswap.getDy(poolParams, i, j, inputAmount);
}

/**
 * Find peg point for CryptoSwap pool (max amount where output >= input)
 */
export async function findCryptoSwapPegPoint(
  poolAddress: string,
  i: number,
  j: number
): Promise<bigint> {
  const poolParams = await getCryptoSwapParams(poolAddress);
  return cryptoswap.findPegPoint(poolParams, i, j);
}
