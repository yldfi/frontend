/**
 * Curve Pool RPC Helpers
 *
 * Optimized RPC calls for Curve pool interactions with batching support
 * to reduce network latency.
 */

import { redactRpcUrl } from "@/lib/rpc-redact";
import { getAllRpcUrls, isRpcTimeout, RPC_TIMEOUT_MS, rpcAuthHeaderFor } from "@/config/rpc";
import { CURVE_CVX_ETH_POOL } from "@/config/addresses";

// Use DEBUG_RPC_URL if available (more reliable, higher rate limits)
// Falls back to public RPCs + dynamic chainlist RPCs for resilience
const getRpcUrls = (): string[] => {
  if (typeof process !== "undefined" && process.env?.DEBUG_RPC_URL) {
    return [process.env.DEBUG_RPC_URL, ...getAllRpcUrls()];
  }
  return getAllRpcUrls();
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
 * Check if running in test environment
 * Live integration tests (with ENSO API key) should use normal retry settings
 */
const isTestEnv = typeof process !== "undefined" && (
  process.env.NODE_ENV === "test" ||
  process.env.VITEST === "true"
);

/**
 * Check if running live integration tests (tests with real API access)
 * These need normal retry settings to handle network latency/rate limits
 */
const isLiveIntegrationTest = isTestEnv && typeof process !== "undefined" &&
  Boolean(process.env.ENSO_API_KEY);

/**
 * Execute multiple eth_call requests in a single HTTP request
 * Reduces latency by batching RPC calls
 * Includes retry logic for RPC resilience
 */
export async function batchRpcCalls(calls: RpcCall[]): Promise<(bigint | null)[]> {
  if (calls.length === 0) return [];

  const rpcUrls = getRpcUrls();

  const batch = calls.map((call, id) => ({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: call.to, data: call.data }, "latest"],
  }));

  // Use normal retry settings for live integration tests and production
  // Only use reduced settings for mocked unit tests
  const useMockedSettings = isTestEnv && !isLiveIntegrationTest;
  const retriesPerUrl = useMockedSettings ? 1 : 2;
  const baseDelayMs = useMockedSettings ? 0 : 300;
  let lastError: Error | undefined;

  // Try each RPC URL with retries before moving to the next
  for (const rpcUrl of rpcUrls) {
    for (let attempt = 0; attempt < retriesPerUrl; attempt++) {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json", ...rpcAuthHeaderFor(rpcUrl) };

        const response = await fetch(rpcUrl, {
          method: "POST",
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
          headers,
          body: JSON.stringify(batch),
        });

        if (!response || !response.ok) {
          throw new Error(`RPC batch request failed: ${response?.status ?? 'no response'}`);
        }

        const json = await response.json();

        // Handle case where response is not an array (RPC error, invalid response, etc.)
        if (!Array.isArray(json)) {
          throw new Error("RPC batch response is not an array");
        }

        const results = json as RpcBatchResult[];

        // Sort by id to maintain order
        results.sort((a, b) => a.id - b.id);

        const parsed = results.map((r) => {
          if (r.result && r.result !== "0x" && r.result !== "0x0") {
            return BigInt(r.result);
          }
          return null;
        });

        // Fallback: if a batch entry errored, retry failed entries individually
        if (parsed.some((value) => value === null)) {
          const singleResults = await Promise.all(parsed.map(async (value, index) => {
            if (value !== null) return value;
            const call = calls[index];
            try {
              const single = await fetch(rpcUrl, {
                method: "POST",
                signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
                headers,
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 0,
                  method: "eth_call",
                  params: [{ to: call.to, data: call.data }, "latest"],
                }),
              });
              if (!single || !single.ok) return null;
              const jsonSingle = (await single.json()) as RpcBatchResult;
              if (!jsonSingle.result || jsonSingle.result === "0x" || jsonSingle.result === "0x0") {
                return null;
              }
              return BigInt(jsonSingle.result);
            } catch {
              return null;
            }
          }));

          // If individual retries still have nulls, try next RPC URL
          if (singleResults.some((value) => value === null)) {
            lastError = new Error(`RPC ${redactRpcUrl(rpcUrl)}: ${singleResults.filter(v => v === null).length}/${calls.length} calls returned null`);
            continue;
          }

          return singleResults;
        }

        return parsed;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // A timed-out node is not retried; move on to the next RPC URL.
        if (isRpcTimeout(error)) break;
        if (attempt < retriesPerUrl - 1) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }

  console.error("batchRpcCalls failed after all RPC URLs:", lastError);
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
 * In mocked test mode: 1 retry, no delay (to avoid test timeouts)
 * In live integration tests: normal retry settings (5 retries, 500ms base delay)
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = (isTestEnv && !isLiveIntegrationTest) ? 1 : 5,
  baseDelayMs = (isTestEnv && !isLiveIntegrationTest) ? 0 : 500
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Don't retry a timeout against the same URL; callers fall through to the next one.
      if (isRpcTimeout(error)) throw lastError;
      if (attempt < maxRetries - 1 && baseDelayMs > 0) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Get expected output from an old-style Curve pool (uses int128 indices)
 * These are older StableSwap pools that use get_dy(int128,int128,uint256)
 * Includes retry logic for RPC resilience
 */
export async function getCurveGetDy(
  poolAddress: string,
  i: number,
  j: number,
  dx: string
): Promise<bigint | null> {
  const rpcUrls = getRpcUrls();

  const data =
    SELECTORS.GET_DY_INT128 +
    encodeUint256(i) +
    encodeUint256(j) +
    encodeUint256(dx);

  for (const rpcUrl of rpcUrls) {
    try {
      return await withRetry(async () => {
        const headers: Record<string, string> = { "Content-Type": "application/json", ...rpcAuthHeaderFor(rpcUrl) };

        const response = await fetch(rpcUrl, {
          method: "POST",
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_call",
            params: [{ to: poolAddress, data }, "latest"],
            id: 1,
          }),
        });

        if (!response || !response.ok) {
          throw new Error(`RPC request failed: ${response?.status ?? 'no response'}`);
        }

        const result = (await response.json()) as { result?: string; error?: { message: string } };
        if (result.error) {
          throw new Error(`RPC error: ${result.error.message}`);
        }
        if (result.result && result.result !== "0x") {
          return BigInt(result.result);
        }
        return null;
      }, 2);
    } catch {
      // Try next RPC URL
    }
  }

  console.error("Error fetching get_dy after all RPC URLs");
  return null;
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
  const rpcUrls = getRpcUrls();

  const data =
    SELECTORS.GET_DY_UINT256 +
    encodeUint256(i) +
    encodeUint256(j) +
    encodeUint256(dx);

  for (const rpcUrl of rpcUrls) {
    try {
      return await withRetry(async () => {
        const headers: Record<string, string> = { "Content-Type": "application/json", ...rpcAuthHeaderFor(rpcUrl) };

        const response = await fetch(rpcUrl, {
          method: "POST",
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_call",
            params: [{ to: poolAddress, data }, "latest"],
            id: 1,
          }),
        });

        if (!response || !response.ok) {
          throw new Error(`RPC request failed: ${response?.status ?? 'no response'}`);
        }

        const result = (await response.json()) as { result?: string; error?: { message: string } };
        if (result.error) {
          throw new Error(`RPC error: ${result.error.message}`);
        }
        if (result.result && result.result !== "0x") {
          return BigInt(result.result);
        }
        return null;
      }, 2);
    } catch {
      // Try next RPC URL
    }
  }

  console.error("Error fetching get_dy (factory) after all RPC URLs");
  return null;
}

// ============================================
// ETH → CVX On-Chain Pricing (via Curve V2 Pool)
// ============================================

// Curve V2 ETH/CVX Pool (WETH/CVX) - used for on-chain price discovery
// Index 0: WETH, Index 1: CVX
const CURVE_ETH_CVX_POOL = CURVE_CVX_ETH_POOL;

/**
 * Get estimated CVX output for ETH input using on-chain Curve pool pricing.
 * This avoids making a separate Enso route call for price discovery.
 * Uses RPC calls which don't count against Enso's API rate limit.
 * Always quoted for the exact amount: an AMM rate is size-dependent, so a rate
 * cached from one request must not be scaled to another.
 *
 * @param ethAmount - Amount of ETH in wei
 * @returns Estimated CVX output in wei
 * @throws Error if RPC call fails after retries
 */
export async function getEthToCvxEstimate(ethAmount: string): Promise<string> {
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

  return cvxOutput.toString();
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

// ============================================
// Curve V2 pool parameters
// ============================================

import type { TwocryptoParams } from "@yldfi/curve-amm-math";

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
