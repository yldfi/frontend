// Enso API Service
// Docs: https://docs.enso.build

import type { EnsoToken, EnsoTokensResponse, EnsoRouteResponse, EnsoBundleAction, EnsoBundleResponse } from "@/types/enso";
import { TOKENS, VAULTS, VAULT_ADDRESSES, isYldfiVault as checkIsYldfiVault } from "@/config/vaults";
import { PUBLIC_RPC_URLS } from "@/config/wagmi";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

const ENSO_API_BASE = "https://api.enso.finance/api/v1";
const CHAIN_ID = 1; // Ethereum mainnet

// ETH placeholder address used by Enso
export const ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

// cvxCRV token address - exported for backwards compatibility
export const CVXCRV_ADDRESS = TOKENS.CVXCRV;

// Enso router contract address (for approvals)
export const ENSO_ROUTER = "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E";

// yld_fi referral code for Enso attribution
export const ENSO_REFERRAL_CODE = "yldfi";

/**
 * Query Curve pool's get_dy to estimate output amount
 * @param poolAddress - Curve pool address
 * @param i - Input token index (0 = CVX1, 1 = cvgCVX)
 * @param j - Output token index
 * @param dx - Input amount (wei string)
 * @returns Expected output amount as bigint, or null on error
 */
async function getCurveGetDy(
  poolAddress: string,
  i: number,
  j: number,
  dx: string
): Promise<bigint | null> {
  try {
    // get_dy(int128,int128,uint256) selector = 0x5e0d443f (correct for CVX1/cvgCVX pool)
    const selector = "0x5e0d443f";
    const data = selector +
      BigInt(i).toString(16).padStart(64, "0") +
      BigInt(j).toString(16).padStart(64, "0") +
      BigInt(dx).toString(16).padStart(64, "0");

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

    const result = await response.json() as { result?: string };
    if (result.result && result.result !== "0x") {
      return BigInt(result.result);
    }
    return null;
  } catch (error) {
    console.error("Error fetching get_dy:", error);
    return null;
  }
}

// ============================================
// Off-chain StableSwap Math (Curve formulas)
// ============================================

const STABLESWAP_N_COINS = 2n;
const STABLESWAP_A_PRECISION = 100n;

// Cache for pool params (valid for 10 seconds to avoid redundant calls)
let poolParamsCache: {
  poolAddress: string;
  data: { balances: [bigint, bigint]; Ann: bigint; fee: bigint };
  timestamp: number;
} | null = null;
const POOL_PARAMS_CACHE_TTL = 12 * 1000; // 12 seconds (matches quote refresh interval)

/**
 * Fetch Curve pool parameters in a single multicall
 * Returns balances, A_precise, and fee
 * Results are cached for 10 seconds to avoid redundant calls
 */
async function getCurvePoolParams(poolAddress: string): Promise<{
  balances: [bigint, bigint];
  Ann: bigint;
  fee: bigint;
}> {
  // Check cache
  const now = Date.now();
  if (poolParamsCache &&
      poolParamsCache.poolAddress === poolAddress &&
      now - poolParamsCache.timestamp < POOL_PARAMS_CACHE_TTL) {
    return poolParamsCache.data;
  }

  // Encode all calls
  const balances0Data = "0x4903b0d10000000000000000000000000000000000000000000000000000000000000000";
  const balances1Data = "0x4903b0d10000000000000000000000000000000000000000000000000000000000000001";
  const aPreciseData = "0x76a2f0f0"; // A_precise()
  const feeData = "0xddca3f43"; // fee()

  // Batch RPC call
  const batch = [
    { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: poolAddress, data: balances0Data }, "latest"] },
    { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: poolAddress, data: balances1Data }, "latest"] },
    { jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: poolAddress, data: aPreciseData }, "latest"] },
    { jsonrpc: "2.0", id: 3, method: "eth_call", params: [{ to: poolAddress, data: feeData }, "latest"] },
  ];

  const response = await fetch(PUBLIC_RPC_URLS.llamarpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });

  const results = (await response.json()) as Array<{ id: number; result?: string }>;
  results.sort((a, b) => a.id - b.id);

  const balance0 = BigInt(results[0].result || "0");
  const balance1 = BigInt(results[1].result || "0");
  const aPrecise = BigInt(results[2].result || "0");
  const fee = BigInt(results[3].result || "0");

  // Ann = A_precise * N_COINS (A_precise already includes A_PRECISION of 100)
  const Ann = aPrecise * STABLESWAP_N_COINS;

  const data = {
    balances: [balance0, balance1] as [bigint, bigint],
    Ann,
    fee,
  };

  // Update cache
  poolParamsCache = { poolAddress, data, timestamp: now };

  return data;
}

/**
 * Calculate D (StableSwap invariant) using Newton's method
 * D satisfies: A*n^n*sum(x) + D = A*D*n^n + D^(n+1)/(n^n*prod(x))
 */
function stableswapGetD(xp: [bigint, bigint], Ann: bigint): bigint {
  const S = xp[0] + xp[1];
  if (S === 0n) return 0n;

  let D = S;

  for (let i = 0; i < 255; i++) {
    let D_P = D;
    for (const x of xp) {
      D_P = (D_P * D) / (x * STABLESWAP_N_COINS);
    }
    const prevD = D;
    const numerator = (Ann * S / STABLESWAP_A_PRECISION + D_P * STABLESWAP_N_COINS) * D;
    const denominator = (Ann - STABLESWAP_A_PRECISION) * D / STABLESWAP_A_PRECISION + (STABLESWAP_N_COINS + 1n) * D_P;
    D = numerator / denominator;

    if (D > prevD ? D - prevD <= 1n : prevD - D <= 1n) break;
  }
  return D;
}

/**
 * Calculate y given x and D using Newton's method
 * Solves: A*n^n*(x+y) + D = A*D*n^n + D^3/(4*x*y)
 */
function stableswapGetY(i: number, j: number, x: bigint, xp: [bigint, bigint], Ann: bigint, D: bigint): bigint {
  let c = D;
  let S = 0n;

  for (let k = 0; k < Number(STABLESWAP_N_COINS); k++) {
    let _x: bigint;
    if (k === i) {
      _x = x;
    } else if (k !== j) {
      _x = xp[k];
    } else {
      continue;
    }
    S += _x;
    c = (c * D) / (_x * STABLESWAP_N_COINS);
  }

  c = (c * D * STABLESWAP_A_PRECISION) / (Ann * STABLESWAP_N_COINS);
  const b = S + (D * STABLESWAP_A_PRECISION) / Ann;

  let y = D;
  for (let i = 0; i < 255; i++) {
    const prevY = y;
    y = (y * y + c) / (2n * y + b - D);
    if (y > prevY ? y - prevY <= 1n : prevY - y <= 1n) break;
  }
  return y;
}

/**
 * Calculate get_dy off-chain (output amount for input dx)
 * Matches Curve's on-chain implementation with ~0.0002% accuracy
 */
function stableswapGetDyOffchain(
  dx: bigint,
  xp: [bigint, bigint],
  Ann: bigint,
  fee: bigint
): bigint {
  const x = xp[0] + dx;
  const D = stableswapGetD(xp, Ann);
  const y = stableswapGetY(0, 1, x, xp, Ann, D);
  const dy = xp[1] - y - 1n; // -1 for rounding
  const feeAmount = (dy * fee) / 10000000000n;
  return dy - feeAmount;
}

/**
 * Find peg point off-chain using binary search on local math
 * Returns max amount where swap output >= input (rate >= 1:1)
 *
 * This is ~330ms with 1 RPC call (vs ~14s with 16 RPC calls for on-chain binary search)
 */
function findPegPointOffchain(xp: [bigint, bigint], Ann: bigint, fee: bigint): bigint {
  // If pool has more CVX1 than cvgCVX, no swap gives bonus
  if (xp[0] >= xp[1]) {
    return 0n;
  }

  let low = 0n;
  let high = xp[1] - xp[0]; // imbalance as upper bound

  while (high - low > 10n * 10n ** 18n) {
    // 10 token precision
    const mid = (low + high) / 2n;
    const dy = stableswapGetDyOffchain(mid, xp, Ann, fee);
    if (dy >= mid) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Calculate min_dy with slippage tolerance
 * @param expectedOutput - Expected output from get_dy
 * @param slippageBps - Slippage in basis points (100 = 1%)
 * @returns min_dy value accounting for slippage
 */
function calculateMinDy(expectedOutput: bigint, slippageBps: number): string {
  // min_dy = expected * (10000 - slippage) / 10000
  const minDy = (expectedOutput * BigInt(10000 - slippageBps)) / BigInt(10000);
  return minDy.toString();
}

// Custom tokens not in Uniswap list (Convex ecosystem + yld_fi vaults)
export const CUSTOM_TOKENS: EnsoToken[] = [
  {
    address: ETH_ADDRESS,
    chainId: 1,
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
    logoURI: "https://assets.coingecko.com/coins/images/279/thumb/ethereum.png",
    type: "base",
  },
  {
    address: CVXCRV_ADDRESS,
    chainId: 1,
    name: "Convex CRV",
    symbol: "cvxCRV",
    decimals: 18,
    logoURI: "https://assets.coingecko.com/coins/images/15586/thumb/convex-crv.png",
    type: "base",
  },
  {
    address: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
    chainId: 1,
    name: "crvUSD",
    symbol: "crvUSD",
    decimals: 18,
    logoURI: "https://assets.coingecko.com/coins/images/30118/thumb/crvusd.jpeg",
    type: "base",
  },
  // yld_fi vault tokens - from centralized config
  ...Object.values(VAULTS).map((vault) => ({
    address: vault.address,
    chainId: 1,
    name: `yld_fi ${vault.name}`,
    symbol: vault.symbol,
    decimals: vault.decimals,
    logoURI: vault.logo,
    type: "defi" as const,
  })),
];

// Popular token addresses for sorting priority
export const POPULAR_TOKENS = [
  ETH_ADDRESS, // ETH
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
  "0x6B175474E89094C44Da98b954EedcdeCB5BE4dBf", // DAI
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
  "0xD533a949740bb3306d119CC777fa900bA034cd52", // CRV
  "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B", // CVX
  CVXCRV_ADDRESS, // cvxCRV
  "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", // crvUSD
  ...Object.values(VAULT_ADDRESSES), // yld_fi vaults
];

/**
 * Fetch token list from Enso API with metadata
 */
export async function fetchEnsoTokenList(): Promise<EnsoToken[]> {
  const searchParams = new URLSearchParams({
    chainId: String(CHAIN_ID),
    type: "base",
    includeMetadata: "true",
    pageSize: "1000",
  });

  const response = await fetchWithRetry(
    `${ENSO_API_BASE}/tokens?${searchParams}`,
    { headers: getHeaders() },
    { maxRetries: 2 }
  );

  if (!response.ok) {
    throw new Error("Failed to fetch token list");
  }

  interface RawToken {
    address?: string;
    chainId?: number;
    name?: string;
    symbol?: string;
    decimals?: number;
    logosUri?: string[];
    type?: string;
  }

  const data = (await response.json()) as { data?: RawToken[] } | RawToken[];
  const rawTokens: RawToken[] = (Array.isArray(data) ? data : data.data) || [];

  // Map to our type
  const tokens: EnsoToken[] = rawTokens
    .filter((t) => t.address && t.symbol)
    .map((t) => ({
      address: t.address!,
      chainId: t.chainId || CHAIN_ID,
      name: t.name || t.symbol || "Unknown",
      symbol: t.symbol || "???",
      decimals: t.decimals || 18,
      logoURI: t.logosUri?.[0], // Take first logo
      type: (t.type as "base" | "defi") || "base",
    }));

  return tokens;
}

/**
 * Get headers for Enso API requests
 */
function getHeaders(): HeadersInit {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };

  // Add API key if available
  const apiKey = process.env.NEXT_PUBLIC_ENSO_API_KEY;
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  return headers;
}

/**
 * Fetch wallet balances from Enso API
 * Returns token balances with prices for a given wallet address
 */
export interface EnsoWalletBalance {
  token: string;
  amount: string;
  chainId: number;
  decimals: number;
  price: number;
  name?: string;
  symbol?: string;
  logoUri?: string;
}

export async function fetchWalletBalances(walletAddress: string): Promise<EnsoWalletBalance[]> {
  const searchParams = new URLSearchParams({
    chainId: String(CHAIN_ID),
    eoaAddress: walletAddress,
  });

  const response = await fetch(`${ENSO_API_BASE}/wallet/balances?${searchParams}`, {
    headers: getHeaders(),
  });

  if (!response.ok) {
    throw new Error("Failed to fetch wallet balances");
  }

  return response.json();
}

/**
 * Fetch batch token prices from Enso API
 */
export interface EnsoTokenPrice {
  chainId: number;
  address: string;
  price: number;
  decimals: number;
  symbol?: string;
  name?: string;
}

export async function fetchTokenPrices(addresses: string[]): Promise<EnsoTokenPrice[]> {
  if (addresses.length === 0) return [];

  const searchParams = new URLSearchParams({
    addresses: addresses.join(","),
  });

  const response = await fetch(
    `${ENSO_API_BASE}/prices/${CHAIN_ID}?${searchParams}`,
    { headers: getHeaders() }
  );

  if (!response.ok) {
    throw new Error("Failed to fetch token prices");
  }

  return response.json();
}

/**
 * Fetch available tokens from Enso API
 */
export async function fetchTokens(params?: {
  chainId?: number;
  type?: "base" | "defi";
  page?: number;
}): Promise<EnsoTokensResponse> {
  const searchParams = new URLSearchParams({
    chainId: String(params?.chainId ?? CHAIN_ID),
  });

  if (params?.type) {
    searchParams.set("type", params.type);
  }
  if (params?.page) {
    searchParams.set("page", String(params.page));
  }

  const response = await fetch(`${ENSO_API_BASE}/tokens?${searchParams}`, {
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(error.message || "Failed to fetch tokens");
  }

  return response.json() as Promise<EnsoTokensResponse>;
}

/**
 * Fetch optimal route/quote from Enso API
 */
export async function fetchRoute(params: {
  fromAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage?: string; // basis points, e.g., "100" = 1%
  receiver?: string;
}): Promise<EnsoRouteResponse> {
  const searchParams = new URLSearchParams({
    chainId: String(CHAIN_ID),
    fromAddress: params.fromAddress,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
    slippage: params.slippage ?? "100", // Default 1% slippage
    routingStrategy: "router",
    referralCode: ENSO_REFERRAL_CODE,
  });

  if (params.receiver) {
    searchParams.set("receiver", params.receiver);
  }

  const response = await fetchWithRetry(
    `${ENSO_API_BASE}/shortcuts/route?${searchParams}`,
    { headers: getHeaders() },
    { maxRetries: 2 }
  );

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(error.message || "Failed to fetch route");
  }

  return response.json() as Promise<EnsoRouteResponse>;
}

/**
 * Sort tokens with popular tokens first
 */
export function sortTokensByPopularity(tokens: EnsoToken[]): EnsoToken[] {
  return [...tokens].sort((a, b) => {
    const aIndex = POPULAR_TOKENS.findIndex(
      (addr) => addr.toLowerCase() === a.address.toLowerCase()
    );
    const bIndex = POPULAR_TOKENS.findIndex(
      (addr) => addr.toLowerCase() === b.address.toLowerCase()
    );

    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    return 0;
  });
}

/**
 * Filter tokens by search query
 */
export function filterTokens(tokens: EnsoToken[], query: string): EnsoToken[] {
  if (!query) return tokens;

  const lowerQuery = query.toLowerCase();
  return tokens.filter(
    (token) =>
      token.symbol.toLowerCase().includes(lowerQuery) ||
      token.name.toLowerCase().includes(lowerQuery) ||
      token.address.toLowerCase() === lowerQuery
  );
}

// yld_fi vault addresses (for vault-to-vault routing)
// Re-export with backwards-compatible naming (ycvxCRV vs YCVXCRV)
export const YLDFI_VAULT_ADDRESSES = {
  ycvxCRV: VAULT_ADDRESSES.YCVXCRV,
  yscvxCRV: VAULT_ADDRESSES.YSCVXCRV,
} as const;

/**
 * Check if an address is a yld_fi vault
 * Uses centralized config from src/config/vaults.ts
 */
export const isYldfiVault = checkIsYldfiVault;

/**
 * Bundle multiple DeFi actions into a single transaction
 * Used for vault-to-vault zaps (redeem from one vault, deposit to another)
 *
 * @param routingStrategy - "router" for standard routing via Enso executor,
 *                          "delegate" for delegateCalls from user's context
 *                          (required for custom call actions like CVX1.mint)
 */
export async function fetchBundle(params: {
  fromAddress: string;
  actions: EnsoBundleAction[];
  receiver?: string;
  routingStrategy?: "router" | "delegate";
}): Promise<EnsoBundleResponse> {
  const searchParams = new URLSearchParams({
    chainId: String(CHAIN_ID),
    fromAddress: params.fromAddress,
    routingStrategy: params.routingStrategy ?? "router",
    referralCode: ENSO_REFERRAL_CODE,
  });

  if (params.receiver) {
    searchParams.set("receiver", params.receiver);
  }

  const response = await fetchWithRetry(
    `${ENSO_API_BASE}/shortcuts/bundle?${searchParams}`,
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(params.actions),
    },
    { maxRetries: 2 }
  );

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(error.message || "Failed to bundle actions");
  }

  return response.json() as Promise<EnsoBundleResponse>;
}

/**
 * Create a Zap Out bundle (redeem from vault + swap to any token)
 * Used when user wants to exit vault directly to ETH, USDC, etc.
 */
export async function fetchZapOutRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
  underlyingToken?: string; // defaults to cvxCRV
}): Promise<EnsoBundleResponse> {
  const underlying = params.underlyingToken || CVXCRV_ADDRESS;

  const actions: EnsoBundleAction[] = [
    // Step 1: Redeem from vault to get underlying token (cvxCRV)
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.vaultAddress,
        tokenOut: underlying,
        amountIn: params.amountIn,
        primaryAddress: params.vaultAddress,
      },
    },
    // Step 2: Swap underlying (cvxCRV) to output token (ETH, USDC, etc.)
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: underlying,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: 0 }, // Use output from redeem
        slippage: params.slippage ?? "100",
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
  });
}

/**
 * Create a Zap In bundle (swap any token + deposit to vault)
 * Used when user wants to enter vault from ETH, USDC, etc.
 */
export async function fetchZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  inputToken: string;
  amountIn: string;
  slippage?: string;
  underlyingToken?: string; // defaults to cvxCRV
}): Promise<EnsoBundleResponse> {
  const underlying = params.underlyingToken || CVXCRV_ADDRESS;

  const actions: EnsoBundleAction[] = [
    // Step 1: Swap input token to underlying (cvxCRV)
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.inputToken,
        tokenOut: underlying,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      },
    },
    // Step 2: Deposit underlying (cvxCRV) into vault
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: underlying,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 0 }, // Use output from swap
        primaryAddress: params.vaultAddress,
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
  });
}

/**
 * Create a vault-to-vault zap bundle (redeem from source, deposit to target)
 * Handles vaults with different underlying tokens by adding a swap step
 * Special handling for cvgCVX which requires custom routing through Tangent
 */
export async function fetchVaultToVaultRoute(params: {
  fromAddress: string;
  sourceVault: string;
  targetVault: string;
  amountIn: string;
  sourceUnderlyingToken?: string; // Source vault's underlying - looked up from VAULTS if not provided
  targetUnderlyingToken?: string; // Target vault's underlying - looked up from VAULTS if not provided
  slippage?: string; // basis points, default "100" = 1%
}): Promise<EnsoBundleResponse> {
  // Look up underlying tokens from VAULTS config if not provided
  const sourceVaultConfig = Object.values(VAULTS).find(v => v.address.toLowerCase() === params.sourceVault.toLowerCase());
  const targetVaultConfig = Object.values(VAULTS).find(v => v.address.toLowerCase() === params.targetVault.toLowerCase());

  const sourceUnderlying = params.sourceUnderlyingToken ?? sourceVaultConfig?.assetAddress ?? TOKENS.CVXCRV;
  const targetUnderlying = params.targetUnderlyingToken ?? targetVaultConfig?.assetAddress ?? TOKENS.CVXCRV;
  const slippage = params.slippage ?? "100";

  // Check if underlyings are the same (simple case)
  const sameUnderlying = sourceUnderlying.toLowerCase() === targetUnderlying.toLowerCase();

  if (sameUnderlying) {
    // Simple vault-to-vault: redeem → deposit
    const actions: EnsoBundleAction[] = [
      {
        protocol: "erc4626",
        action: "redeem",
        args: {
          tokenIn: params.sourceVault,
          tokenOut: sourceUnderlying,
          amountIn: params.amountIn,
          primaryAddress: params.sourceVault,
        },
      },
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: sourceUnderlying,
          tokenOut: params.targetVault,
          amountIn: { useOutputOfCallAt: 0 },
          primaryAddress: params.targetVault,
        },
      },
    ];

    return fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      receiver: params.fromAddress,
    });
  }

  // Check if cvgCVX is involved - requires custom routing via Tangent
  const targetIsCvgCvx = targetUnderlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
  const sourceIsCvgCvx = sourceUnderlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();

  // Check if pxCVX is involved - requires custom routing via Pirex
  const targetIsPxCvx = targetUnderlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();
  const sourceIsPxCvx = sourceUnderlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();

  if (targetIsCvgCvx) {
    // Zapping TO cvgCVX vault: redeem → route to CVX → wrap → swap → deposit
    return fetchVaultToCvgCvxVaultRoute({
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      targetVault: params.targetVault,
      amountIn: params.amountIn,
      sourceUnderlyingToken: sourceUnderlying,
      slippage,
    });
  }

  if (sourceIsCvgCvx) {
    // Zapping FROM cvgCVX vault: redeem → swap → unwrap → route → deposit
    return fetchCvgCvxVaultToVaultRoute({
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      targetVault: params.targetVault,
      amountIn: params.amountIn,
      targetUnderlyingToken: targetUnderlying,
      slippage,
    });
  }

  if (sourceIsPxCvx) {
    // Zapping FROM pxCVX vault: redeem → swap via lpxCVX → route → deposit
    return fetchPxCvxVaultToVaultRoute({
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      targetVault: params.targetVault,
      amountIn: params.amountIn,
      targetUnderlyingToken: targetUnderlying,
      slippage,
    });
  }

  if (targetIsPxCvx) {
    // Zapping TO pxCVX vault: redeem → route to CVX → lock via Pirex → deposit
    // NOTE: This is complex because getting pxCVX requires locking CVX in Pirex
    // For now, throw an error - users should acquire pxCVX manually
    throw new Error("Zapping into pxCVX vault is not yet supported. Please acquire pxCVX manually via Pirex.");
  }

  // Different underlyings (non-cvgCVX): redeem → swap → deposit
  // Use Enso route action to swap between different underlying tokens
  const actions: EnsoBundleAction[] = [
    // Step 1: Redeem from source vault to get source underlying
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.sourceVault,
        tokenOut: sourceUnderlying,
        amountIn: params.amountIn,
        primaryAddress: params.sourceVault,
      },
    },
    // Step 2: Swap source underlying → target underlying via Enso router
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: sourceUnderlying,
        tokenOut: targetUnderlying,
        amountIn: { useOutputOfCallAt: 0 },
        slippage,
      },
    },
    // Step 3: Deposit target underlying into target vault
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: targetUnderlying,
        tokenOut: params.targetVault,
        amountIn: { useOutputOfCallAt: 1 },
        primaryAddress: params.targetVault,
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
  });
}

/**
 * Custom bundle for zapping TO a cvgCVX vault from another vault
 * Route: source vault → source underlying → CVX → CVX1 → cvgCVX → target vault
 * Uses same pattern as fetchCvgCvxZapInRoute with delegate routing
 */
async function fetchVaultToCvgCvxVaultRoute(params: {
  fromAddress: string;
  sourceVault: string;
  targetVault: string;
  amountIn: string;
  sourceUnderlyingToken: string;
  slippage: string;
}): Promise<EnsoBundleResponse> {
  const { TANGENT } = await import("@/config/vaults");
  const slippageBps = parseInt(params.slippage) || 100;

  const actions: EnsoBundleAction[] = [
    // Action 0: Redeem from source vault to get source underlying
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.sourceVault,
        tokenOut: params.sourceUnderlyingToken,
        amountIn: params.amountIn,
        primaryAddress: params.sourceVault,
      },
    },
    // Action 1: Route source underlying → CVX via Enso
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.sourceUnderlyingToken,
        tokenOut: TOKENS.CVX,
        amountIn: { useOutputOfCallAt: 0 },
        slippage: params.slippage,
      },
    },
    // Action 2: Approve CVX → CVX1 wrapper
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: { useOutputOfCallAt: 1 } },
    },
    // Action 3: Wrap CVX → CVX1
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "mint",
        abi: "function mint(address to, uint256 amount)",
        args: [params.fromAddress, { useOutputOfCallAt: 1 }],
      },
    },
    // Action 4: Approve CVX1 → Curve pool
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX1, spender: TANGENT.CVX1_CVGCVX_POOL, amount: { useOutputOfCallAt: 1 } },
    },
    // Action 5: Swap CVX1 → cvgCVX via Curve pool
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [0, 1, { useOutputOfCallAt: 1 }, "0"], // min_dy=0, rely on final slippage
      },
    },
    // Action 6: Approve cvgCVX → vault
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVGCVX, spender: params.targetVault, amount: { useOutputOfCallAt: 5 } },
    },
    // Action 7: Deposit cvgCVX → target vault
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: TOKENS.CVGCVX,
        tokenOut: params.targetVault,
        amountIn: { useOutputOfCallAt: 5 },
        primaryAddress: params.targetVault,
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "delegate",
  });
}

/**
 * Custom bundle for zapping FROM a cvgCVX vault to another vault
 * Route: source vault → cvgCVX → CVX1 → CVX → target underlying → target vault
 * Uses same pattern as fetchCvgCvxZapOutRoute with delegate routing
 */
async function fetchCvgCvxVaultToVaultRoute(params: {
  fromAddress: string;
  sourceVault: string;
  targetVault: string;
  amountIn: string;
  targetUnderlyingToken: string;
  slippage: string;
}): Promise<EnsoBundleResponse> {
  const { TANGENT } = await import("@/config/vaults");

  const actions: EnsoBundleAction[] = [
    // Action 0: Redeem from source vault to get cvgCVX
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.sourceVault,
        tokenOut: TOKENS.CVGCVX,
        amountIn: params.amountIn,
        primaryAddress: params.sourceVault,
      },
    },
    // Action 1: Approve cvgCVX → Curve pool
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVGCVX, spender: TANGENT.CVX1_CVGCVX_POOL, amount: { useOutputOfCallAt: 0 } },
    },
    // Action 2: Swap cvgCVX → CVX1 via Curve pool (index 1 → 0)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [1, 0, { useOutputOfCallAt: 0 }, "0"], // min_dy=0, rely on final slippage
      },
    },
    // Action 3: Unwrap CVX1 → CVX
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "withdraw",
        abi: "function withdraw(uint256 amount, address to)",
        args: [{ useOutputOfCallAt: 2 }, params.fromAddress],
      },
    },
    // Action 4: Route CVX → target underlying via Enso
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.targetUnderlyingToken,
        amountIn: { useOutputOfCallAt: 2 }, // CVX1 amount ≈ CVX amount
        slippage: params.slippage,
      },
    },
    // Action 5: Deposit target underlying into target vault
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: params.targetUnderlyingToken,
        tokenOut: params.targetVault,
        amountIn: { useOutputOfCallAt: 4 },
        primaryAddress: params.targetVault,
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "delegate",
  });
}

/**
 * Custom bundle for zapping FROM a pxCVX vault to another vault
 * Route: pxCVX vault → pxCVX → lpxCVX.swap → CVX → route → target underlying → target vault
 * Uses lpxCVX contract's swap function which wraps pxCVX and swaps to CVX in one call
 */
async function fetchPxCvxVaultToVaultRoute(params: {
  fromAddress: string;
  sourceVault: string;
  targetVault: string;
  amountIn: string;
  targetUnderlyingToken: string;
  slippage: string;
}): Promise<EnsoBundleResponse> {
  const { PIREX } = await import("@/config/vaults");

  // Check if target is CVX - can skip the route step
  const targetIsCvx = params.targetUnderlyingToken.toLowerCase() === TOKENS.CVX.toLowerCase();

  const actions: EnsoBundleAction[] = [
    // Action 0: Redeem from source vault to get pxCVX
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.sourceVault,
        tokenOut: TOKENS.PXCVX,
        amountIn: params.amountIn,
        primaryAddress: params.sourceVault,
      },
    },
    // Action 1: Approve pxCVX to lpxCVX contract
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.PXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: 0 },
      },
    },
    // Action 2: Swap pxCVX → CVX via lpxCVX.swap()
    // swap(Token.pxCVX, amount, minReceived, fromIndex=1, toIndex=0)
    // The lpxCVX contract wraps pxCVX internally and swaps lpxCVX → CVX via Curve
    {
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "swap",
        abi: "function swap(uint8 source, uint256 amount, uint256 minReceived, uint256 fromIndex, uint256 toIndex)",
        args: [
          PIREX.TOKEN_ENUM.pxCVX, // source = pxCVX (1)
          { useOutputOfCallAt: 0 }, // amount
          "0", // minReceived - rely on final slippage protection
          PIREX.POOL_INDEX.LPXCVX, // fromIndex = 1 (lpxCVX)
          PIREX.POOL_INDEX.CVX, // toIndex = 0 (CVX)
        ],
      },
    },
  ];

  if (targetIsCvx) {
    // Target is CVX - deposit directly into vault
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.targetVault,
        amountIn: { useOutputOfCallAt: 2 },
        primaryAddress: params.targetVault,
      },
    });
  } else {
    // Need to route CVX → target underlying
    actions.push(
      // Action 3: Route CVX → target underlying via Enso
      {
        protocol: "enso",
        action: "route",
        args: {
          tokenIn: TOKENS.CVX,
          tokenOut: params.targetUnderlyingToken,
          amountIn: { useOutputOfCallAt: 2 },
          slippage: params.slippage,
        },
      },
      // Action 4: Deposit target underlying into target vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: params.targetUnderlyingToken,
          tokenOut: params.targetVault,
          amountIn: { useOutputOfCallAt: 3 },
          primaryAddress: params.targetVault,
        },
      }
    );
  }

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "delegate",
  });
}

/**
 * Check if a token requires custom zap routing (not supported by standard Enso routes)
 */
export function requiresCustomZapRoute(tokenAddress: string): boolean {
  const addr = tokenAddress.toLowerCase();
  // cvgCVX requires custom routing through Tangent/CVX1/Curve
  // pxCVX requires custom routing through Pirex/lpxCVX/Curve
  return addr === TOKENS.CVGCVX.toLowerCase() || addr === TOKENS.PXCVX.toLowerCase();
}

/**
 * Get the Curve pool swap rate for CVX1 → cvgCVX
 * Returns the amount of cvgCVX you'd get for a given amount of CVX1
 */
export async function getCvgCvxSwapRate(amountIn: string): Promise<bigint> {
  const { TANGENT } = await import("@/config/vaults");

  // Use centralized getCurveGetDy to avoid duplicate implementations
  const result = await getCurveGetDy(TANGENT.CVX1_CVGCVX_POOL, 0, 1, amountIn);
  return result ?? 0n;
}

/**
 * Get Curve pool balances for CVX1/cvgCVX
 */
export async function getCvgCvxPoolBalances(): Promise<{ cvx1Balance: bigint; cvgCvxBalance: bigint }> {
  const { TANGENT } = await import("@/config/vaults");

  // Batch both balance calls to single RPC request
  const batch = [
    { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: TANGENT.CVX1_CVGCVX_POOL, data: "0x4903b0d10000000000000000000000000000000000000000000000000000000000000000" }, "latest"] },
    { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: TANGENT.CVX1_CVGCVX_POOL, data: "0x4903b0d10000000000000000000000000000000000000000000000000000000000000001" }, "latest"] },
  ];

  const response = await fetch(PUBLIC_RPC_URLS.llamarpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });

  const results = (await response.json()) as Array<{ id: number; result?: string }>;
  results.sort((a, b) => a.id - b.id);

  return {
    cvx1Balance: BigInt(results[0].result || "0"),
    cvgCvxBalance: BigInt(results[1].result || "0"),
  };
}

/**
 * Find the maximum amount of CVX1 that can be swapped for cvgCVX
 * while maintaining a rate >= 1:1 (getting at least 1 cvgCVX per CVX1)
 *
 * Uses off-chain StableSwap math for fast computation (~500ms with 2 RPC calls)
 * vs ~14s with 16 RPC calls for on-chain binary search
 *
 * Hybrid approach (per Codex recommendation):
 * 1. Calculate peg point off-chain using StableSwap math
 * 2. Verify with on-chain get_dy call
 * 3. If verification fails, reduce by 1% for safety margin
 */
export async function findMaxSwapBeforePeg(): Promise<bigint> {
  const { TANGENT } = await import("@/config/vaults");

  // RPC call 1: Get all pool parameters
  const { balances, Ann, fee } = await getCurvePoolParams(TANGENT.CVX1_CVGCVX_POOL);

  // Find peg point using off-chain math (local computation, ~0ms)
  let pegPoint = findPegPointOffchain(balances, Ann, fee);

  if (pegPoint === 0n) {
    return 0n;
  }

  // RPC call 2: Verify with on-chain get_dy
  try {
    const dy = await getCvgCvxSwapRate(pegPoint.toString());

    if (dy < pegPoint) {
      // Off-chain was slightly optimistic, reduce by 1% for safety
      pegPoint = (pegPoint * 99n) / 100n;
    }
  } catch {
    // If verification fails, reduce by 2% as extra safety margin
    pegPoint = (pegPoint * 98n) / 100n;
  }

  return pegPoint;
}

/**
 * Calculate optimal swap amount for hybrid swap/mint strategy
 * Returns the max amount that can be swapped while still getting >= 1:1 rate
 *
 * Uses off-chain StableSwap math with on-chain verification (~500ms, 2 RPC calls)
 * vs ~14s with 16 RPC calls for pure on-chain binary search
 */
export async function getOptimalSwapAmount(totalCvxAmount: string): Promise<{ swapAmount: bigint; mintAmount: bigint }> {
  const totalAmount = BigInt(totalCvxAmount);

  if (totalAmount === 0n) {
    return { swapAmount: 0n, mintAmount: 0n };
  }

  try {
    // Find max amount that can be swapped at >= 1:1 rate
    const maxSwapBeforePeg = await findMaxSwapBeforePeg();

    if (maxSwapBeforePeg === 0n) {
      // No swap bonus available - mint everything
      return { swapAmount: 0n, mintAmount: totalAmount };
    }

    if (maxSwapBeforePeg >= totalAmount) {
      // Can swap everything with bonus
      return { swapAmount: totalAmount, mintAmount: 0n };
    }

    // Hybrid strategy: swap up to max, mint the rest
    return {
      swapAmount: maxSwapBeforePeg,
      mintAmount: totalAmount - maxSwapBeforePeg
    };
  } catch {
    // Default to mint if we can't determine
    return { swapAmount: 0n, mintAmount: totalAmount };
  }
}

/**
 * Determine optimal route for CVX → cvgCVX
 * Returns "swap" if Curve pool gives better rate, "mint" if 1:1 mint is better
 */
export async function getOptimalCvgCvxRoute(cvxAmount: string): Promise<"swap" | "mint"> {
  try {
    // Get swap output from Curve pool (CVX1 is 1:1 with CVX, so use cvxAmount directly)
    const swapOutput = await getCvgCvxSwapRate(cvxAmount);
    const cvxAmountBigInt = BigInt(cvxAmount);

    // If swap gives more cvgCVX than mint (1:1), use swap
    // Otherwise use mint
    return swapOutput > cvxAmountBigInt ? "swap" : "mint";
  } catch {
    // Default to mint if we can't determine
    return "mint";
  }
}

/**
 * Create a custom Zap In route for cvgCVX via Tangent infrastructure
 * Uses hybrid swap/mint strategy for optimal cvgCVX acquisition:
 *
 * - When Curve pool rate > 1.0: Swap through pool to get bonus cvgCVX
 * - When Curve pool rate < 1.0: Direct mint at 1:1 (avoids slippage loss)
 * - Hybrid: Binary search finds optimal split between swap and mint
 *
 * Uses delegate routing strategy because:
 * - CVX1.mint has no return value, so standard router can't track token flow
 * - Delegate executes via delegateCalls from user's context, keeping tokens with user
 */
export async function fetchCvgCvxZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  inputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<EnsoBundleResponse> {
  const { TANGENT } = await import("@/config/vaults");
  const slippageBps = parseInt(params.slippage ?? "100", 10);

  // Check if input is already cvgCVX (vault's underlying) - just deposit directly
  const inputIsCvgCvx = params.inputToken.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
  if (inputIsCvgCvx) {
    // Direct deposit - no routing needed
    const actions: EnsoBundleAction[] = [
      // Action 0: Approve cvgCVX → vault
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: params.amountIn },
      },
      // Action 1: Deposit cvgCVX → vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: TOKENS.CVGCVX,
          tokenOut: params.vaultAddress,
          amountIn: params.amountIn,
          primaryAddress: params.vaultAddress,
        },
      },
    ];

    return fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "delegate",
    });
  }

  // Check if input is already CVX - skip initial route step
  const inputIsCvx = params.inputToken.toLowerCase() === TOKENS.CVX.toLowerCase();

  // Step 1: Get CVX amount (either from route or directly if input is CVX)
  let expectedCvxOutput: string;
  if (inputIsCvx) {
    // Input is already CVX, use amount directly
    expectedCvxOutput = params.amountIn;
  } else {
    // Get quote for input → CVX
    const routeQuote = await fetchRoute({
      fromAddress: params.fromAddress,
      tokenIn: params.inputToken,
      tokenOut: TOKENS.CVX,
      amountIn: params.amountIn,
      slippage: params.slippage,
    });
    expectedCvxOutput = routeQuote.amountOut;
  }

  // Step 2: Calculate optimal split between swap and mint
  const { swapAmount, mintAmount } = await getOptimalSwapAmount(expectedCvxOutput);

  // Step 3: Build bundle based on optimal strategy
  if (mintAmount === 0n) {
    // 100% swap through Curve pool (pool is above peg, get bonus)
    return buildSwapOnlyBundle(params, TANGENT, expectedCvxOutput, slippageBps, inputIsCvx);
  } else if (swapAmount === 0n) {
    // 100% direct mint (pool is below peg, mint at 1:1)
    return buildMintOnlyBundle(params, TANGENT, expectedCvxOutput, slippageBps, inputIsCvx);
  } else {
    // Hybrid: swap some, mint the rest
    return buildHybridBundle(params, TANGENT, swapAmount, mintAmount, slippageBps, inputIsCvx);
  }
}

/**
 * Build bundle for 100% swap path (Curve pool is above peg)
 * Route: input → CVX → CVX1 → cvgCVX (swap) → vault
 * When inputIsCvx=true: CVX → CVX1 → cvgCVX (swap) → vault (skips initial route)
 */
async function buildSwapOnlyBundle(
  params: { fromAddress: string; vaultAddress: string; inputToken: string; amountIn: string; slippage?: string },
  TANGENT: { CVX1_CVGCVX_POOL: string; CVGCVX_CONTRACT: string },
  expectedCvxOutput: string,
  slippageBps: number,
  inputIsCvx: boolean
): Promise<EnsoBundleResponse> {
  // Query Curve pool get_dy for expected output
  const expectedCvgCvxOutput = await getCurveGetDy(
    TANGENT.CVX1_CVGCVX_POOL,
    0, 1, expectedCvxOutput
  );
  const minDy = expectedCvgCvxOutput
    ? calculateMinDy(expectedCvgCvxOutput, slippageBps)
    : "0";

  if (inputIsCvx) {
    // Input is already CVX - skip the route step, use literal amounts
    const actions: EnsoBundleAction[] = [
      // Action 0: Approve CVX → CVX1
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: params.amountIn },
      },
      // Action 1: Wrap CVX → CVX1
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "mint",
          abi: "function mint(address to, uint256 amount)",
          args: [params.fromAddress, params.amountIn],
        },
      },
      // Action 2: Approve CVX1 → Curve pool
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVX1, spender: TANGENT.CVX1_CVGCVX_POOL, amount: params.amountIn },
      },
      // Action 3: Swap CVX1 → cvgCVX via Curve
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVX1_CVGCVX_POOL,
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          args: [0, 1, params.amountIn, minDy],
        },
      },
      // Action 4: Approve cvgCVX → vault
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: { useOutputOfCallAt: 3 } },
      },
      // Action 5: Deposit cvgCVX → vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: TOKENS.CVGCVX,
          tokenOut: params.vaultAddress,
          amountIn: { useOutputOfCallAt: 3 },
          primaryAddress: params.vaultAddress,
        },
      },
    ];

    return fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "delegate",
    });
  }

  // Standard path: route input → CVX first
  const actions: EnsoBundleAction[] = [
    // Action 0: Swap input → CVX
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.inputToken,
        tokenOut: TOKENS.CVX,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      },
    },
    // Action 1: Approve CVX → CVX1
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: { useOutputOfCallAt: 0 } },
    },
    // Action 2: Wrap CVX → CVX1
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "mint",
        abi: "function mint(address to, uint256 amount)",
        args: [params.fromAddress, { useOutputOfCallAt: 0 }],
      },
    },
    // Action 3: Approve CVX1 → Curve pool
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX1, spender: TANGENT.CVX1_CVGCVX_POOL, amount: { useOutputOfCallAt: 0 } },
    },
    // Action 4: Swap CVX1 → cvgCVX via Curve
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [0, 1, { useOutputOfCallAt: 0 }, minDy],
      },
    },
    // Action 5: Approve cvgCVX → vault
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: { useOutputOfCallAt: 4 } },
    },
    // Action 6: Deposit cvgCVX → vault
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: TOKENS.CVGCVX,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 4 },
        primaryAddress: params.vaultAddress,
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "delegate",
  });
}

/**
 * Build bundle for 100% mint path (Curve pool is below peg)
 * Route: input → CVX → cvgCVX (direct mint 1:1) → vault
 * When inputIsCvx=true: CVX → cvgCVX (direct mint 1:1) → vault (skips initial route)
 */
async function buildMintOnlyBundle(
  params: { fromAddress: string; vaultAddress: string; inputToken: string; amountIn: string; slippage?: string },
  TANGENT: { CVX1_CVGCVX_POOL: string; CVGCVX_CONTRACT: string },
  _expectedCvxOutput: string,
  _slippageBps: number,
  inputIsCvx: boolean
): Promise<EnsoBundleResponse> {
  // For mint path, we get 1:1 cvgCVX from CVX
  // The mint function returns the actual minted amount, which we use for deposit
  // Slippage is handled by the initial input → CVX route (if not CVX input)

  if (inputIsCvx) {
    // Input is already CVX - skip the route step, use literal amounts
    const actions: EnsoBundleAction[] = [
      // Action 0: Approve CVX → cvgCVX contract
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVX, spender: TANGENT.CVGCVX_CONTRACT, amount: params.amountIn },
      },
      // Action 1: Mint cvgCVX from CVX (1:1, isLock=true for no fees)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVGCVX_CONTRACT,
          method: "mint",
          abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
          args: [params.fromAddress, params.amountIn, true],
        },
      },
      // Action 2: Approve cvgCVX → vault
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: { useOutputOfCallAt: 1 } },
      },
      // Action 3: Deposit cvgCVX → vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: TOKENS.CVGCVX,
          tokenOut: params.vaultAddress,
          amountIn: { useOutputOfCallAt: 1 },
          primaryAddress: params.vaultAddress,
        },
      },
    ];

    return fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "delegate",
    });
  }

  // Standard path: route input → CVX first
  const actions: EnsoBundleAction[] = [
    // Action 0: Swap input → CVX
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.inputToken,
        tokenOut: TOKENS.CVX,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      },
    },
    // Action 1: Approve CVX → cvgCVX contract
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TANGENT.CVGCVX_CONTRACT, amount: { useOutputOfCallAt: 0 } },
    },
    // Action 2: Mint cvgCVX from CVX (1:1, isLock=true for no fees)
    // mint(address to, uint256 amount, bool isLock) returns (uint256)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVGCVX_CONTRACT,
        method: "mint",
        abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
        args: [params.fromAddress, { useOutputOfCallAt: 0 }, true],
      },
    },
    // Action 3: Approve cvgCVX → vault
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: { useOutputOfCallAt: 2 } },
    },
    // Action 4: Deposit cvgCVX → vault
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: TOKENS.CVGCVX,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 2 },
        primaryAddress: params.vaultAddress,
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "delegate",
  });
}

/**
 * Build bundle for hybrid path (swap some, mint the rest)
 * Route: input → CVX → [split: CVX1→swap + direct mint] → cvgCVX → vault
 * When inputIsCvx=true: CVX → [split: CVX1→swap + direct mint] → cvgCVX → vault (skips initial route)
 *
 * This is complex because Enso bundles don't support amount splitting.
 * We use pre-calculated literal amounts based on expected CVX output.
 */
async function buildHybridBundle(
  params: { fromAddress: string; vaultAddress: string; inputToken: string; amountIn: string; slippage?: string },
  TANGENT: { CVX1_CVGCVX_POOL: string; CVGCVX_CONTRACT: string },
  swapAmount: bigint,
  mintAmount: bigint,
  slippageBps: number,
  inputIsCvx: boolean
): Promise<EnsoBundleResponse> {
  // Calculate expected outputs for each path
  const expectedSwapOutput = await getCurveGetDy(
    TANGENT.CVX1_CVGCVX_POOL,
    0, 1, swapAmount.toString()
  );
  const minSwapDy = expectedSwapOutput
    ? calculateMinDy(expectedSwapOutput, slippageBps)
    : "0";

  // Total expected cvgCVX = swap output + mint amount (1:1)
  const totalExpectedCvgCvx = (expectedSwapOutput ?? swapAmount) + mintAmount;

  if (inputIsCvx) {
    // Input is already CVX - skip the route step, use literal amounts directly
    const actions: EnsoBundleAction[] = [
      // === SWAP PATH (swapAmount CVX → CVX1 → cvgCVX via Curve) ===

      // Action 0: Approve swapAmount CVX → CVX1
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: swapAmount.toString() },
      },
      // Action 1: Wrap swapAmount CVX → CVX1
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "mint",
          abi: "function mint(address to, uint256 amount)",
          args: [params.fromAddress, swapAmount.toString()],
        },
      },
      // Action 2: Approve CVX1 → Curve pool
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVX1, spender: TANGENT.CVX1_CVGCVX_POOL, amount: swapAmount.toString() },
      },
      // Action 3: Swap CVX1 → cvgCVX via Curve
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVX1_CVGCVX_POOL,
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          args: [0, 1, swapAmount.toString(), minSwapDy],
        },
      },

      // === MINT PATH (mintAmount CVX → cvgCVX directly) ===

      // Action 4: Approve mintAmount CVX → cvgCVX contract
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVX, spender: TANGENT.CVGCVX_CONTRACT, amount: mintAmount.toString() },
      },
      // Action 5: Mint cvgCVX from CVX (1:1, isLock=true)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVGCVX_CONTRACT,
          method: "mint",
          abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
          args: [params.fromAddress, mintAmount.toString(), true],
        },
      },

      // === DEPOSIT ALL cvgCVX TO VAULT ===

      // Action 6: Approve all cvgCVX → vault
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: totalExpectedCvgCvx.toString() },
      },
      // Action 7: Deposit all cvgCVX → vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: TOKENS.CVGCVX,
          tokenOut: params.vaultAddress,
          amountIn: totalExpectedCvgCvx.toString(),
          primaryAddress: params.vaultAddress,
        },
      },
    ];

    return fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "delegate",
    });
  }

  // Standard path: route input → CVX first
  const actions: EnsoBundleAction[] = [
    // Action 0: Swap input → CVX
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.inputToken,
        tokenOut: TOKENS.CVX,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      },
    },

    // === SWAP PATH (swapAmount CVX → CVX1 → cvgCVX via Curve) ===

    // Action 1: Approve swapAmount CVX → CVX1
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: swapAmount.toString() },
    },
    // Action 2: Wrap swapAmount CVX → CVX1
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "mint",
        abi: "function mint(address to, uint256 amount)",
        args: [params.fromAddress, swapAmount.toString()],
      },
    },
    // Action 3: Approve CVX1 → Curve pool
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX1, spender: TANGENT.CVX1_CVGCVX_POOL, amount: swapAmount.toString() },
    },
    // Action 4: Swap CVX1 → cvgCVX via Curve
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [0, 1, swapAmount.toString(), minSwapDy],
      },
    },

    // === MINT PATH (mintAmount CVX → cvgCVX directly) ===

    // Action 5: Approve mintAmount CVX → cvgCVX contract
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TANGENT.CVGCVX_CONTRACT, amount: mintAmount.toString() },
    },
    // Action 6: Mint cvgCVX from CVX (1:1, isLock=true)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVGCVX_CONTRACT,
        method: "mint",
        abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
        args: [params.fromAddress, mintAmount.toString(), true],
      },
    },

    // === DEPOSIT ALL cvgCVX TO VAULT ===

    // Action 7: Approve all cvgCVX → vault
    // Use total expected (swap output + mint output)
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: totalExpectedCvgCvx.toString() },
    },
    // Action 8: Deposit all cvgCVX → vault
    // Note: We use totalExpectedCvgCvx as a maximum, actual deposit will use user's balance
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: TOKENS.CVGCVX,
        tokenOut: params.vaultAddress,
        amountIn: totalExpectedCvgCvx.toString(),
        primaryAddress: params.vaultAddress,
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "delegate",
  });
}

/**
 * Create a custom Zap Out route for cvgCVX via Tangent infrastructure
 * Route: vault (redeem) → cvgCVX → CVX1 (Curve swap) → CVX (unwrap) → output token
 * When outputToken=CVX: vault → cvgCVX → CVX1 → CVX (skips final route)
 *
 * Uses delegate routing strategy because:
 * - CVX1.withdraw has no return value, so standard router can't track token flow
 * - Delegate executes via delegateCalls from user's context, keeping tokens with user
 *
 * Action sequence with indices:
 *   0: redeem (vault → cvgCVX)
 *   1: approve (cvgCVX → Curve pool)
 *   2: call (Curve exchange cvgCVX → CVX1) ← returns CVX1 amount
 *   3: call (CVX1.withdraw → CVX)
 *   4: route (CVX → output token) [skipped if output is CVX]
 */
export async function fetchCvgCvxZapOutRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<EnsoBundleResponse> {
  const { TANGENT } = await import("@/config/vaults");
  const slippageBps = parseInt(params.slippage ?? "100", 10);

  // Check if output is already CVX - skip final route step
  const outputIsCvx = params.outputToken.toLowerCase() === TOKENS.CVX.toLowerCase();

  // Step 1: Estimate cvgCVX output from vault redeem
  // For ERC4626, redeem returns assets = shares * pricePerShare
  // Query convertToAssets to get expected output
  const convertToAssetsSelector = "0x07a2d13a"; // convertToAssets(uint256)
  const convertData = convertToAssetsSelector +
    BigInt(params.amountIn).toString(16).padStart(64, "0");

  let expectedCvgCvxOutput: string;
  try {
    const rpcResponse = await fetch(PUBLIC_RPC_URLS.llamarpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{ to: params.vaultAddress, data: convertData }, "latest"],
        id: 1,
      }),
    });
    const result = await rpcResponse.json() as { result?: string };
    expectedCvgCvxOutput = result.result && result.result !== "0x"
      ? BigInt(result.result).toString()
      : params.amountIn; // Fallback to 1:1
  } catch {
    expectedCvgCvxOutput = params.amountIn; // Fallback to 1:1
  }

  // Step 2: Query Curve pool get_dy to estimate CVX1 output
  // get_dy(1, 0, cvgcvx_amount) - cvgCVX (index 1) to CVX1 (index 0)
  const expectedCvx1Output = await getCurveGetDy(
    TANGENT.CVX1_CVGCVX_POOL,
    1, // cvgCVX index
    0, // CVX1 index
    expectedCvgCvxOutput
  );

  // Step 3: Calculate min_dy with slippage (fallback to 0 if get_dy fails)
  const minDy = expectedCvx1Output
    ? calculateMinDy(expectedCvx1Output, slippageBps)
    : "0";

  if (outputIsCvx) {
    // Output is CVX - skip the final route step
    const actions: EnsoBundleAction[] = [
      // Action 0: Redeem from vault to get cvgCVX
      {
        protocol: "erc4626",
        action: "redeem",
        args: {
          tokenIn: params.vaultAddress,
          tokenOut: TOKENS.CVGCVX,
          amountIn: params.amountIn,
          primaryAddress: params.vaultAddress,
        },
      },
      // Action 1: Approve cvgCVX to Curve pool for exchange
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVGCVX,
          spender: TANGENT.CVX1_CVGCVX_POOL,
          amount: { useOutputOfCallAt: 0 },
        },
      },
      // Action 2: Exchange cvgCVX → CVX1 via Curve pool
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVX1_CVGCVX_POOL,
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          args: [1, 0, { useOutputOfCallAt: 0 }, minDy],
        },
      },
      // Action 3: Unwrap CVX1 → CVX (final output)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "withdraw",
          abi: "function withdraw(uint256 amount, address to)",
          args: [{ useOutputOfCallAt: 2 }, params.fromAddress],
        },
      },
    ];

    return fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "delegate",
    });
  }

  // Standard path: route CVX → output token
  const actions: EnsoBundleAction[] = [
    // Action 0: Redeem from vault to get cvgCVX
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.vaultAddress,
        tokenOut: TOKENS.CVGCVX,
        amountIn: params.amountIn,
        primaryAddress: params.vaultAddress,
      },
    },
    // Action 1: Approve cvgCVX to Curve pool for exchange
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVGCVX,
        spender: TANGENT.CVX1_CVGCVX_POOL,
        amount: { useOutputOfCallAt: 0 },
      },
    },
    // Action 2: Exchange cvgCVX → CVX1 via Curve pool
    // exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)
    // i=1 (cvgCVX), j=0 (CVX1) - opposite direction from zap in
    // min_dy calculated from get_dy with slippage protection
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [1, 0, { useOutputOfCallAt: 0 }, minDy],
      },
    },
    // Action 3: Unwrap CVX1 → CVX
    // withdraw(uint256 amount, address to) - burns CVX1, sends CVX to user
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "withdraw",
        abi: "function withdraw(uint256 amount, address to)",
        args: [{ useOutputOfCallAt: 2 }, params.fromAddress],
      },
    },
    // Action 4: Swap CVX to output token (ETH, USDC, etc.)
    // Use Curve exchange output (CVX1 ≈ CVX 1:1)
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: 2 }, // CVX1 amount from Curve = CVX amount
        slippage: params.slippage ?? "100",
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "delegate", // Required for custom call actions
  });
}

/**
 * Create a custom Zap Out route for pxCVX via Pirex infrastructure
 * Route: vault (redeem) → pxCVX → lpxCVX.swap → CVX → output token
 * When outputToken=CVX: vault → pxCVX → CVX (skips final route)
 *
 * Uses lpxCVX.swap() which internally:
 * 1. Wraps pxCVX to lpxCVX
 * 2. Swaps lpxCVX → CVX via Curve pool
 * 3. Sends CVX directly to caller
 */
export async function fetchPxCvxZapOutRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<EnsoBundleResponse> {
  const { PIREX } = await import("@/config/vaults");

  // Check if output is already CVX - skip final route step
  const outputIsCvx = params.outputToken.toLowerCase() === TOKENS.CVX.toLowerCase();

  // Estimate pxCVX output from vault redeem via convertToAssets
  const convertToAssetsSelector = "0x07a2d13a"; // convertToAssets(uint256)
  const convertData = convertToAssetsSelector +
    BigInt(params.amountIn).toString(16).padStart(64, "0");

  let expectedPxCvxOutput: string;
  try {
    const rpcResponse = await fetch(PUBLIC_RPC_URLS.llamarpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{ to: params.vaultAddress, data: convertData }, "latest"],
        id: 1,
      }),
    });
    const result = await rpcResponse.json() as { result?: string };
    expectedPxCvxOutput = result.result && result.result !== "0x"
      ? BigInt(result.result).toString()
      : params.amountIn;
  } catch {
    expectedPxCvxOutput = params.amountIn;
  }

  // Query Curve pool get_dy to estimate CVX output from lpxCVX swap
  // get_dy(1, 0, lpxcvx_amount) - lpxCVX (index 1) to CVX (index 0)
  const expectedCvxOutput = await getCurveGetDy(
    PIREX.LPXCVX_CVX_POOL,
    1, // lpxCVX index
    0, // CVX index
    expectedPxCvxOutput // pxCVX wraps 1:1 to lpxCVX
  );

  // Calculate min_dy with slippage
  const slippageBps = parseInt(params.slippage ?? "100", 10);
  const minDy = expectedCvxOutput
    ? calculateMinDy(expectedCvxOutput, slippageBps)
    : "0";

  if (outputIsCvx) {
    // Output is CVX - skip the final route step
    const actions: EnsoBundleAction[] = [
      // Action 0: Redeem from vault to get pxCVX
      {
        protocol: "erc4626",
        action: "redeem",
        args: {
          tokenIn: params.vaultAddress,
          tokenOut: TOKENS.PXCVX,
          amountIn: params.amountIn,
          primaryAddress: params.vaultAddress,
        },
      },
      // Action 1: Approve pxCVX to lpxCVX contract
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.PXCVX,
          spender: PIREX.LPXCVX,
          amount: { useOutputOfCallAt: 0 },
        },
      },
      // Action 2: Swap pxCVX → CVX via lpxCVX.swap()
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX,
          method: "swap",
          abi: "function swap(uint8 source, uint256 amount, uint256 minReceived, uint256 fromIndex, uint256 toIndex)",
          args: [
            PIREX.TOKEN_ENUM.pxCVX, // source = pxCVX (1)
            { useOutputOfCallAt: 0 }, // amount
            minDy, // minReceived with slippage
            PIREX.POOL_INDEX.LPXCVX, // fromIndex = 1 (lpxCVX)
            PIREX.POOL_INDEX.CVX, // toIndex = 0 (CVX)
          ],
        },
      },
    ];

    return fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "delegate",
    });
  }

  // Output is not CVX - need final route step
  const actions: EnsoBundleAction[] = [
    // Action 0: Redeem from vault to get pxCVX
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.vaultAddress,
        tokenOut: TOKENS.PXCVX,
        amountIn: params.amountIn,
        primaryAddress: params.vaultAddress,
      },
    },
    // Action 1: Approve pxCVX to lpxCVX contract
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.PXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: 0 },
      },
    },
    // Action 2: Swap pxCVX → CVX via lpxCVX.swap()
    {
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "swap",
        abi: "function swap(uint8 source, uint256 amount, uint256 minReceived, uint256 fromIndex, uint256 toIndex)",
        args: [
          PIREX.TOKEN_ENUM.pxCVX, // source = pxCVX (1)
          { useOutputOfCallAt: 0 }, // amount
          minDy, // minReceived with slippage
          PIREX.POOL_INDEX.LPXCVX, // fromIndex = 1 (lpxCVX)
          PIREX.POOL_INDEX.CVX, // toIndex = 0 (CVX)
        ],
      },
    },
    // Action 3: Route CVX → output token
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: 2 },
        slippage: params.slippage ?? "100",
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "delegate",
  });
}

// ============================================================================
// pxCVX Pool Helper Functions (CryptoSwap pool - uses uint256 indices)
// ============================================================================

/**
 * Get the Curve CryptoSwap pool swap rate for CVX → lpxCVX
 * Returns the amount of lpxCVX you'd get for a given amount of CVX
 *
 * Note: This pool uses uint256 indices (not int128 like StableSwap pools)
 * get_dy(uint256,uint256,uint256) selector: 0x556d6e9f
 */
export async function getPxCvxSwapRate(amountIn: string): Promise<bigint> {
  const { PIREX } = await import("@/config/vaults");

  // get_dy(uint256 i, uint256 j, uint256 dx) - CVX (0) → lpxCVX (1)
  const selector = "0x556d6e9f";
  const i = "0".padStart(64, "0"); // CVX index
  const j = "1".padStart(64, "0"); // lpxCVX index
  const dx = BigInt(amountIn).toString(16).padStart(64, "0");

  const response = await fetch(PUBLIC_RPC_URLS.llamarpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_call",
      params: [{ to: PIREX.LPXCVX_CVX_POOL, data: selector + i + j + dx }, "latest"],
      id: 1,
    }),
  });

  const result = (await response.json()) as { result?: string };
  return BigInt(result.result || "0");
}

/**
 * Get Curve pool balances for lpxCVX/CVX
 * coin[0] = CVX, coin[1] = lpxCVX
 */
export async function getPxCvxPoolBalances(): Promise<{ cvxBalance: bigint; lpxCvxBalance: bigint }> {
  const { PIREX } = await import("@/config/vaults");

  // balances(uint256) selector: 0x4903b0d1
  const batch = [
    { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: PIREX.LPXCVX_CVX_POOL, data: "0x4903b0d10000000000000000000000000000000000000000000000000000000000000000" }, "latest"] },
    { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: PIREX.LPXCVX_CVX_POOL, data: "0x4903b0d10000000000000000000000000000000000000000000000000000000000000001" }, "latest"] },
  ];

  const response = await fetch(PUBLIC_RPC_URLS.llamarpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });

  const results = (await response.json()) as Array<{ id: number; result?: string }>;
  results.sort((a, b) => a.id - b.id);

  return {
    cvxBalance: BigInt(results[0].result || "0"),
    lpxCvxBalance: BigInt(results[1].result || "0"),
  };
}

/**
 * Calculate optimal swap amount for pxCVX hybrid swap/mint strategy
 *
 * If swap rate (CVX → lpxCVX) > 1:1, swap gives bonus pxCVX
 * If swap rate < 1:1, mint directly via Pirex at 1:1
 *
 * For CryptoSwap pools, we use a simpler heuristic:
 * - Check swap rate at total amount
 * - If rate > 1, swap everything (bonus)
 * - If rate < 1, binary search for optimal split point
 */
export async function getOptimalPxCvxSwapAmount(totalCvxAmount: string): Promise<{ swapAmount: bigint; mintAmount: bigint }> {
  const totalAmount = BigInt(totalCvxAmount);

  if (totalAmount === 0n) {
    return { swapAmount: 0n, mintAmount: 0n };
  }

  try {
    // Check swap rate for total amount
    const dyForTotal = await getPxCvxSwapRate(totalCvxAmount);

    // If swapping everything gives >= 1:1, swap it all
    if (dyForTotal >= totalAmount) {
      return { swapAmount: totalAmount, mintAmount: 0n };
    }

    // Rate is < 1:1, binary search for peg point
    // Find max amount where swap rate >= 1:1
    let lo = 0n;
    let hi = totalAmount;
    let maxSwap = 0n;

    // 10 iterations for ~0.1% precision
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2n;
      if (mid === 0n) break;

      const dy = await getPxCvxSwapRate(mid.toString());
      if (dy >= mid) {
        // Rate >= 1:1, can swap more
        maxSwap = mid;
        lo = mid + 1n;
      } else {
        // Rate < 1:1, need to swap less
        hi = mid - 1n;
      }
    }

    // Apply 2% safety margin
    const safeSwapAmount = (maxSwap * 98n) / 100n;

    return {
      swapAmount: safeSwapAmount,
      mintAmount: totalAmount - safeSwapAmount,
    };
  } catch (error) {
    console.error("Error calculating optimal pxCVX swap amount:", error);
    // On error, mint everything (safe fallback)
    return { swapAmount: 0n, mintAmount: totalAmount };
  }
}

/**
 * Create a custom Zap In route for pxCVX via Pirex infrastructure
 * Route: input token → CVX → (hybrid swap/mint) → pxCVX → vault
 *
 * Hybrid strategy:
 * - If Curve pool rate > 1:1: swap CVX → lpxCVX → unwrap → pxCVX
 * - If rate < 1:1: deposit CVX to Pirex for 1:1 pxCVX
 * - Optimal: split between swap and mint at peg point
 */
export async function fetchPxCvxZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  inputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<EnsoBundleResponse> {
  const { PIREX } = await import("@/config/vaults");

  // Check if input is already CVX
  const inputIsCvx = params.inputToken.toLowerCase() === TOKENS.CVX.toLowerCase();

  // Step 1: If not CVX, route input → CVX first
  // We need to estimate the CVX amount we'll get
  let estimatedCvxAmount = params.amountIn;

  if (!inputIsCvx) {
    // Get estimated CVX output from Enso route
    try {
      const routeEstimate = await fetchRoute({
        fromAddress: params.fromAddress,
        tokenIn: params.inputToken,
        tokenOut: TOKENS.CVX,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      });
      estimatedCvxAmount = routeEstimate.amountOut || params.amountIn;
    } catch {
      // Fallback: assume 1:1 for estimation
      estimatedCvxAmount = params.amountIn;
    }
  }

  // Step 2: Calculate optimal swap vs mint split
  const { swapAmount, mintAmount } = await getOptimalPxCvxSwapAmount(estimatedCvxAmount);

  // Build actions based on strategy
  const actions: EnsoBundleAction[] = [];
  let actionIndex = 0;

  // Action 0 (if needed): Route input → CVX
  if (!inputIsCvx) {
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.inputToken,
        tokenOut: TOKENS.CVX,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      },
    });
    actionIndex++;
  }

  if (swapAmount > 0n && mintAmount > 0n) {
    // Hybrid strategy: split CVX between swap and mint

    // Action: Approve CVX to Curve pool for swap portion
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: swapAmount.toString(),
      },
    });
    actionIndex++;

    // Action: Swap CVX → lpxCVX via Curve pool
    // exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy)
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX_CVX_POOL,
        method: "exchange",
        abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
        args: [
          PIREX.POOL_INDEX.CVX, // i = 0 (CVX)
          PIREX.POOL_INDEX.LPXCVX, // j = 1 (lpxCVX)
          swapAmount.toString(), // dx
          "0", // min_dy (handled by Enso slippage)
        ],
      },
    });
    const swapIdx = actionIndex++;

    // Action: Approve lpxCVX to itself for unwrap
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: swapIdx },
      },
    });
    actionIndex++;

    // Action: Unwrap lpxCVX → pxCVX
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "unwrap",
        abi: "function unwrap(uint256 amount)",
        args: [{ useOutputOfCallAt: swapIdx }],
      },
    });
    actionIndex++;

    // Action: Approve CVX to Pirex for mint portion
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.PIREX_CVX,
        amount: mintAmount.toString(),
      },
    });
    actionIndex++;

    // Action: Deposit CVX to Pirex → pxCVX
    // deposit(uint256 assets, address receiver, bool shouldCompound, address developer)
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.PIREX_CVX,
        method: "deposit",
        abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
        args: [
          mintAmount.toString(),
          params.fromAddress, // receiver
          false, // shouldCompound
          "0x0000000000000000000000000000000000000000", // developer
        ],
      },
    });
    actionIndex++;

  } else if (swapAmount > 0n) {
    // Swap-only strategy: rate > 1:1 for full amount

    // Action: Approve CVX to Curve pool
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: inputIsCvx ? params.amountIn : { useOutputOfCallAt: actionIndex - 1 },
      },
    });
    actionIndex++;

    // Action: Swap CVX → lpxCVX via Curve pool
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX_CVX_POOL,
        method: "exchange",
        abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
        args: [
          PIREX.POOL_INDEX.CVX,
          PIREX.POOL_INDEX.LPXCVX,
          inputIsCvx ? params.amountIn : { useOutputOfCallAt: actionIndex - 2 },
          "0",
        ],
      },
    });
    const swapIdx = actionIndex++;

    // Action: Approve lpxCVX for unwrap
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: swapIdx },
      },
    });
    actionIndex++;

    // Action: Unwrap lpxCVX → pxCVX
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "unwrap",
        abi: "function unwrap(uint256 amount)",
        args: [{ useOutputOfCallAt: swapIdx }],
      },
    });
    actionIndex++;

  } else {
    // Mint-only strategy: rate < 1:1, deposit to Pirex for 1:1

    // Action: Approve CVX to Pirex
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.PIREX_CVX,
        amount: inputIsCvx ? params.amountIn : { useOutputOfCallAt: actionIndex - 1 },
      },
    });
    actionIndex++;

    // Action: Deposit CVX to Pirex → pxCVX
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.PIREX_CVX,
        method: "deposit",
        abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
        args: [
          inputIsCvx ? params.amountIn : { useOutputOfCallAt: actionIndex - 2 },
          params.fromAddress,
          false,
          "0x0000000000000000000000000000000000000000",
        ],
      },
    });
    actionIndex++;
  }

  // Final action: Approve pxCVX to vault and deposit
  actions.push({
    protocol: "erc20",
    action: "approve",
    args: {
      token: PIREX.PXCVX,
      spender: params.vaultAddress,
      amount: "type(uint256).max", // Max approval for convenience
    },
  });
  actionIndex++;

  // Action: Deposit pxCVX into vault
  actions.push({
    protocol: "erc4626",
    action: "deposit",
    args: {
      vault: params.vaultAddress,
      tokenIn: PIREX.PXCVX,
      amountIn: "useBalance", // Use all pxCVX balance
      receiver: params.fromAddress,
      slippage: params.slippage ?? "100",
    },
  });

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "delegate",
  });
}
