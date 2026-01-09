// Enso API Service
// Docs: https://docs.enso.build
// Using official Enso SDK: https://github.com/EnsoBuild/sdk-ts

import { EnsoClient } from "@ensofinance/sdk";
import type { EnsoToken, EnsoTokensResponse, EnsoRouteResponse, EnsoBundleAction, EnsoBundleResponse } from "@/types/enso";
import { TOKENS, VAULTS, VAULT_ADDRESSES, isYldfiVault as checkIsYldfiVault } from "@/config/vaults";
import { PUBLIC_RPC_URLS } from "@/config/rpc";

// Import Curve helpers from dedicated module
import {
  getCurveGetDy,
  getCurveGetDyFactory,
  previewRedeem,
  batchRpcCalls,
  getPoolParams,
  // Optimized helpers (batch + off-chain math)
  batchRedeemAndEstimateSwap,
  estimateSwapOffchain,
  // StableSwap math
  stableswap,
  findPegPoint as findPegPointOffchain,
  calculateMinDy,
  validateSlippage,
  N_COINS as STABLESWAP_N_COINS,
  A_PRECISION as STABLESWAP_A_PRECISION,
  FEE_DENOMINATOR as STABLESWAP_FEE_DENOMINATOR,
  // CryptoSwap math
  cryptoswap,
} from "@/lib/curve";
import type { CryptoSwapParams as TwocryptoParams } from "@yldfi/curve-amm-math";

// Destructure stableswap functions for existing usage
const stableswapGetD = stableswap.getD;
const stableswapGetY = stableswap.getY;
const stableswapGetDyOffchain = stableswap.getDy;
const stableswapDynamicFee = stableswap.dynamicFee;

const CHAIN_ID = 1; // Ethereum mainnet

// Initialize Enso SDK client
const ensoClient = new EnsoClient({
  apiKey: process.env.NEXT_PUBLIC_ENSO_API_KEY || "",
});

// ETH placeholder address used by Enso
export const ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

// cvxCRV token address - exported for backwards compatibility
export const CVXCRV_ADDRESS = TOKENS.CVXCRV;

// Enso router contract addresses
// EnsoShortcutRouter - for approvals
export const ENSO_ROUTER = "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E";
// Enso Router - holds tokens during bundle execution
export const ENSO_ROUTER_EXECUTOR = "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf";

// yld_fi referral code for Enso attribution
export const ENSO_REFERRAL_CODE = "yldfi";

// ============================================
// Pool Params Cache (for optimal route calculation)
// ============================================

// Cache for pool params (valid for 12 seconds to avoid redundant calls)
let poolParamsCache: {
  poolAddress: string;
  data: { balances: [bigint, bigint]; A: bigint; Ann: bigint; fee: bigint; offpegFeeMultiplier: bigint };
  timestamp: number;
} | null = null;
const POOL_PARAMS_CACHE_TTL = 12 * 1000; // 12 seconds (matches quote refresh interval)

/**
 * Fetch StableSwapNG pool parameters in a single multicall
 * Returns balances, A, fee, and offpeg_fee_multiplier
 * Results are cached for 12 seconds to avoid redundant calls
 */
async function getCurvePoolParams(poolAddress: string): Promise<{
  balances: [bigint, bigint];
  A: bigint;
  Ann: bigint;
  fee: bigint;
  offpegFeeMultiplier: bigint;
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
  const aData = "0xf446c1d0"; // A()
  const feeData = "0xddca3f43"; // fee()
  const offpegData = "0x8edfdd5f"; // offpeg_fee_multiplier()

  // Batch RPC call
  const batch = [
    { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: poolAddress, data: balances0Data }, "latest"] },
    { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: poolAddress, data: balances1Data }, "latest"] },
    { jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: poolAddress, data: aData }, "latest"] },
    { jsonrpc: "2.0", id: 3, method: "eth_call", params: [{ to: poolAddress, data: feeData }, "latest"] },
    { jsonrpc: "2.0", id: 4, method: "eth_call", params: [{ to: poolAddress, data: offpegData }, "latest"] },
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
  const A = BigInt(results[2].result || "0");
  const fee = BigInt(results[3].result || "0");
  const offpegFeeMultiplier = BigInt(results[4].result || "0");

  // Compute Ann = A * A_PRECISION * N_COINS for backward compatibility
  const Ann = A * STABLESWAP_A_PRECISION * STABLESWAP_N_COINS;

  const data = {
    balances: [balance0, balance1] as [bigint, bigint],
    A,
    Ann,
    fee,
    offpegFeeMultiplier,
  };

  // Update cache
  poolParamsCache = { poolAddress, data, timestamp: now };

  return data;
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
 * Fetch token list from Enso API with metadata using SDK
 */
export async function fetchEnsoTokenList(): Promise<EnsoToken[]> {
  // SDK pages are fixed at 1000 tokens per page
  const tokenData = await ensoClient.getTokenData({
    chainId: CHAIN_ID,
    type: "base",
    includeMetadata: true,
  });

  // Map to our type
  return tokenData.data
    .filter((t) => t.address && t.symbol)
    .map((t) => ({
      address: t.address,
      chainId: t.chainId,
      name: t.name || t.symbol || "Unknown",
      symbol: t.symbol || "???",
      decimals: t.decimals,
      logoURI: t.logosUri?.[0], // Take first logo
      type: t.type,
    }));
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
  const balances = await ensoClient.getBalances({
    chainId: CHAIN_ID,
    eoaAddress: walletAddress as `0x${string}`,
    useEoa: true,
  });

  // Transform SDK response to match our expected type
  return balances.map((b) => ({
    token: b.token,
    amount: String(b.amount),
    chainId: CHAIN_ID,
    decimals: b.decimals,
    price: Number(b.price),
    name: b.name,
    symbol: b.symbol,
    logoUri: b.logoUri,
  }));
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

  const priceData = await ensoClient.getMultiplePriceData({
    chainId: CHAIN_ID,
    addresses: addresses as `0x${string}`[],
  });

  // Transform SDK response to match our expected type
  return priceData.map((p) => ({
    chainId: p.chainId,
    address: p.address,
    price: Number(p.price),
    decimals: p.decimals,
    symbol: p.symbol,
    name: undefined, // SDK doesn't return name
  }));
}

/**
 * Fetch available tokens from Enso API using SDK
 */
export async function fetchTokens(params?: {
  chainId?: number;
  type?: "base" | "defi";
  page?: number;
}): Promise<EnsoTokensResponse> {
  const tokenData = await ensoClient.getTokenData({
    chainId: params?.chainId ?? CHAIN_ID,
    type: params?.type,
    page: params?.page,
  });

  // Transform SDK response to match our expected type
  return {
    data: tokenData.data.map((t) => ({
      address: t.address,
      chainId: t.chainId,
      name: t.name ?? "",
      symbol: t.symbol ?? "",
      decimals: t.decimals,
      logoURI: t.logosUri?.[0],
      type: t.type,
    })),
    meta: {
      total: tokenData.meta.total,
      lastPage: tokenData.meta.lastPage,
      currentPage: tokenData.meta.currentPage,
      perPage: tokenData.meta.perPage,
    },
  };
}

/**
 * Fetch optimal route/quote from Enso API using SDK
 */
export async function fetchRoute(params: {
  fromAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage?: string; // basis points, e.g., "100" = 1%
  receiver?: string;
}): Promise<EnsoRouteResponse> {
  const routeData = await ensoClient.getRouteData({
    chainId: CHAIN_ID,
    fromAddress: params.fromAddress as `0x${string}`,
    tokenIn: [params.tokenIn as `0x${string}`],
    tokenOut: [params.tokenOut as `0x${string}`],
    amountIn: [params.amountIn],
    slippage: params.slippage ?? "100", // Default 1% slippage
    routingStrategy: "router",
    referralCode: ENSO_REFERRAL_CODE,
    receiver: params.receiver as `0x${string}` | undefined,
  });

  // Transform SDK response to match our expected type
  return {
    tx: {
      to: routeData.tx.to,
      data: routeData.tx.data,
      value: String(routeData.tx.value),
    },
    gas: String(routeData.gas),
    amountOut: String(routeData.amountOut),
    priceImpact: routeData.priceImpact != null ? Number(routeData.priceImpact) : undefined,
    route: routeData.route.map((hop) => ({
      action: hop.action,
      protocol: hop.protocol,
      tokenIn: hop.tokenIn as string[],
      tokenOut: hop.tokenOut as string[],
      amountIn: [], // SDK Hop type doesn't include amounts
      amountOut: [],
    })),
  };
}

/**
 * Estimate output from an Enso route (for min_dy calculations)
 * Uses the route API to get accurate output estimate
 * @param fromAddress - Wallet address
 * @param tokenIn - Input token address
 * @param tokenOut - Output token address
 * @param amountIn - Input amount (wei string)
 * @param slippage - Slippage in basis points (optional)
 * @returns Expected output amount as string
 * @throws Error if estimation fails (never returns fallback value)
 */
async function estimateRouteOutput(
  fromAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  slippage?: string
): Promise<string> {
  // If tokens are same, return input
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    return amountIn;
  }

  const result = await fetchRoute({
    fromAddress,
    tokenIn,
    tokenOut,
    amountIn,
    slippage,
  });

  if (!result.amountOut) {
    throw new Error(`Failed to estimate route output for ${tokenIn} → ${tokenOut}`);
  }

  return result.amountOut;
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
  // Use SDK to call bundle API
  // Note: SDK BundleAction type is a complex union, we cast our actions
  const bundleData = await ensoClient.getBundleData(
    {
      chainId: CHAIN_ID,
      fromAddress: params.fromAddress as `0x${string}`,
      routingStrategy: params.routingStrategy ?? "router",
      referralCode: ENSO_REFERRAL_CODE,
      receiver: params.receiver as `0x${string}` | undefined,
    },
    // Cast our generic actions to SDK's union type
    params.actions as unknown as Parameters<typeof ensoClient.getBundleData>[1]
  );

  // Transform SDK response to match our expected type
  return {
    tx: {
      to: bundleData.tx.to,
      data: bundleData.tx.data,
      value: String(bundleData.tx.value),
      from: bundleData.tx.from ?? params.fromAddress,
    },
    gas: String(bundleData.gas),
    amountsOut: Object.fromEntries(
      Object.entries(bundleData.amountsOut).map(([k, v]) => [k, String(v)])
    ),
    priceImpact: bundleData.priceImpact,
  };
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
  // Block same-vault zaps (pointless)
  if (params.sourceVault.toLowerCase() === params.targetVault.toLowerCase()) {
    throw new Error("Cannot zap from a vault to itself");
  }

  // Look up underlying tokens from VAULTS config if not provided
  const sourceVaultConfig = Object.values(VAULTS).find(v => v.address.toLowerCase() === params.sourceVault.toLowerCase());
  const targetVaultConfig = Object.values(VAULTS).find(v => v.address.toLowerCase() === params.targetVault.toLowerCase());

  const sourceUnderlying = params.sourceUnderlyingToken ?? sourceVaultConfig?.assetAddress ?? TOKENS.CVXCRV;
  const targetUnderlying = params.targetUnderlyingToken ?? targetVaultConfig?.assetAddress ?? TOKENS.CVXCRV;
  const slippage = params.slippage ?? "100";

  // Same-underlying vault-to-vault: simple redeem → deposit (no swap needed)
  const sameUnderlying = sourceUnderlying.toLowerCase() === targetUnderlying.toLowerCase();
  if (sameUnderlying) {
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

  // NOTE: Check pxCVX source BEFORE cvgCVX target because pxCVX needs special handling
  // that can't be done by fetchVaultToCvgCvxVaultRoute (Enso can't route pxCVX → CVX)
  if (sourceIsPxCvx) {
    // Zapping FROM pxCVX vault: redeem → swap via lpxCVX → route/wrap → deposit
    // This handles both standard targets AND cvgCVX targets (via CVX1 wrap + Curve)
    return fetchPxCvxVaultToVaultRoute({
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      targetVault: params.targetVault,
      amountIn: params.amountIn,
      targetUnderlyingToken: targetUnderlying,
      slippage,
    });
  }

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

  if (targetIsPxCvx) {
    // Zapping TO pxCVX vault: redeem source → route to CVX → hybrid swap/mint → deposit
    // Note: We use the SOURCE UNDERLYING token, not the vault token
    return fetchVaultToPxCvxVaultRoute({
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      targetVault: params.targetVault,
      amountIn: params.amountIn,
      sourceUnderlyingToken: sourceUnderlying,
      slippage,
    });
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

  // Validate slippage parameter
  const slippageBps = validateSlippage(params.slippage);

  // Estimate underlying amount from vault redeem
  const estimatedUnderlying = await previewRedeem(params.sourceVault, params.amountIn);

  // Estimate CVX amount from route (throws on failure)
  const estimatedCvx = await estimateRouteOutput(
    params.fromAddress,
    params.sourceUnderlyingToken,
    TOKENS.CVX,
    estimatedUnderlying,
    params.slippage
  );

  // Apply conservative buffer: reduce input by 1% for upstream slippage
  const conservativeCvx = (BigInt(estimatedCvx) * 99n) / 100n;

  // CVX wraps 1:1 to CVX1
  // Estimate cvgCVX output from Curve swap (CVX1 → cvgCVX)
  const expectedCvgCvx = await getCurveGetDy(
    TANGENT.CVX1_CVGCVX_POOL,
    0, // CVX1 index
    1, // cvgCVX index
    conservativeCvx.toString()
  );

  // CRITICAL: Throw if estimation fails or returns zero - never use min_dy=0
  if (expectedCvgCvx === null || expectedCvgCvx === 0n) {
    throw new Error("Failed to estimate Curve CVX1→cvgCVX swap output for slippage protection");
  }

  // Calculate min_dy with slippage tolerance
  const minDyCvgCvx = calculateMinDy(expectedCvgCvx, slippageBps);

  // Note: Using concrete estimates for amounts to help Enso simulate the bundle correctly
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
    // Action 1: Route source underlying → CVX via Enso (use estimated underlying)
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.sourceUnderlyingToken,
        tokenOut: TOKENS.CVX,
        amountIn: estimatedUnderlying,
        slippage: params.slippage,
      },
    },
    // Action 2: Approve CVX → CVX1 wrapper (use estimated CVX)
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: estimatedCvx },
    },
    // Action 3: Wrap CVX → CVX1 (mint to router so subsequent actions can use it)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "mint",
        abi: "function mint(address to, uint256 amount)",
        args: [ENSO_ROUTER_EXECUTOR, estimatedCvx],
      },
    },
    // Action 4: Approve CVX1 → Curve pool
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX1, spender: TANGENT.CVX1_CVGCVX_POOL, amount: estimatedCvx },
    },
    // Action 5: Swap CVX1 → cvgCVX via Curve pool
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [0, 1, estimatedCvx, minDyCvgCvx], // min_dy with slippage protection
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
    routingStrategy: "router",
  });
}

/**
 * Custom bundle for zapping FROM a cvgCVX vault to another vault
 * Route: source vault → cvgCVX → CVX1 → CVX → target underlying → target vault
 *
 * Note: This function estimates the CVX amount for the route action because
 * KyberSwap routes cannot be quoted with dynamic amounts (useOutputOfCallAt).
 * The estimation uses Curve pool's get_dy and applies conservative slippage.
 */
async function fetchCvgCvxVaultToVaultRoute(params: {
  fromAddress: string;
  sourceVault: string;
  targetVault: string;
  amountIn: string;
  targetUnderlyingToken: string;
  slippage: string;
}): Promise<EnsoBundleResponse> {
  const { TANGENT, PIREX } = await import("@/config/vaults");

  // Validate slippage parameter
  const slippageBps = validateSlippage(params.slippage);

  // Check if target is pxCVX - needs special routing via Curve swap + unwrap
  const targetIsPxCvx = params.targetUnderlyingToken.toLowerCase() === TOKENS.PXCVX.toLowerCase();

  // OPTIMIZED: Batch previewRedeem + pool params in single RPC call
  // Uses off-chain StableSwap math for getDy calculation
  const { redeemAmount: cvgCvxAmount, swapOutput: estimatedCvx1 } = await batchRedeemAndEstimateSwap(
    params.sourceVault,
    params.amountIn,
    TANGENT.CVX1_CVGCVX_POOL,
    1, // cvgCVX index (input)
    0, // CVX1 index (output)
    0.99 // Conservative buffer: reduce input by 1% for upstream slippage
  );

  // CRITICAL: Throw if estimation fails or returns zero - never use min_dy=0
  if (estimatedCvx1 === 0n) {
    throw new Error("Failed to estimate Curve cvgCVX→CVX1 swap output for slippage protection");
  }

  // Calculate min_dy with slippage tolerance
  const minDyCvx1 = calculateMinDy(estimatedCvx1, slippageBps);

  // Use estimated amount with conservative buffer for route quote
  const estimatedCvxForQuote = (estimatedCvx1 * BigInt(10000 - slippageBps * 2)) / BigInt(10000);

  // Build common actions for cvgCVX → CVX conversion
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
        args: [1, 0, { useOutputOfCallAt: 0 }, minDyCvx1], // min_dy with slippage protection
      },
    },
  ];

  if (targetIsPxCvx) {
    // Target is pxCVX - needs custom routing: CVX1 → CVX → lpxCVX → pxCVX
    // CVX1 unwraps 1:1 to CVX, so use CVX1 amount for subsequent operations

    // Use concrete estimates for better Enso simulation
    const estimatedCvxStr = estimatedCvx1.toString(); // CVX1 unwraps 1:1 to CVX

    // Estimate lpxCVX output from CVX → lpxCVX Curve swap
    // Use factory-style helper since lpxCVX/CVX pool uses uint256 indices
    const estimatedLpxCvx = await getCurveGetDyFactory(
      PIREX.LPXCVX_CVX_POOL,
      0, // CVX index
      1, // lpxCVX index
      estimatedCvxStr
    );

    if (estimatedLpxCvx === null || estimatedLpxCvx === 0n) {
      throw new Error("Failed to estimate Curve CVX→lpxCVX swap output for slippage protection");
    }

    const estimatedLpxCvxStr = estimatedLpxCvx.toString();
    // pxCVX wraps 1:1 from lpxCVX
    const estimatedPxCvxStr = estimatedLpxCvxStr;

    actions.push(
      // Action 3: Unwrap CVX1 → CVX (send to router so it can be used in next action)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "withdraw",
          abi: "function withdraw(uint256 amount, address to)",
          args: [estimatedCvxStr, ENSO_ROUTER_EXECUTOR],
        },
      },
      // Action 4: Approve CVX → Curve lpxCVX pool
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX,
          spender: PIREX.LPXCVX_CVX_POOL,
          amount: estimatedCvxStr, // Same as CVX1 (1:1 unwrap)
        },
      },
      // Action 5: Swap CVX → lpxCVX via Curve (RETURNS uint256)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX_CVX_POOL,
          method: "exchange",
          abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
          args: [
            String(PIREX.POOL_INDEX.CVX), // i = 0 (CVX)
            String(PIREX.POOL_INDEX.LPXCVX), // j = 1 (lpxCVX)
            estimatedCvxStr, // dx = CVX amount (same as CVX1)
            "0", // min_dy - bundle slippage handles this
          ],
        },
      },
      // Action 6: Approve lpxCVX for unwrap
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: PIREX.LPXCVX,
          spender: PIREX.LPXCVX,
          amount: estimatedLpxCvxStr, // lpxCVX from Curve swap
        },
      },
      // Action 7: Unwrap lpxCVX → pxCVX
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX,
          method: "unwrap",
          abi: "function unwrap(uint256 amount)",
          args: [estimatedLpxCvxStr],
        },
      },
      // Action 8: Deposit pxCVX into target vault
      // Use erc4626 action so amountsOut tracks the vault shares
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: TOKENS.PXCVX,
          tokenOut: params.targetVault,
          amountIn: estimatedPxCvxStr, // Same as lpxCVX (1:1 unwrap)
          primaryAddress: params.targetVault,
        },
      }
    );

    return fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "router",
    });
  }

  // Standard path: route CVX → target underlying via Enso
  actions.push(
    // Action 3: Unwrap CVX1 → CVX (send to router so it can be used in next action)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "withdraw",
        abi: "function withdraw(uint256 amount, address to)",
        args: [{ useOutputOfCallAt: 2 }, ENSO_ROUTER_EXECUTOR],
      },
    },
    // Action 4: Route CVX → target underlying via Enso
    // Use estimated amount for quote (KyberSwap requires concrete amount at quote time)
    // Execution will use the actual CVX amount received
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.targetUnderlyingToken,
        amountIn: estimatedCvxForQuote.toString(),
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
    }
  );

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
}

/**
 * Custom bundle for zapping TO a pxCVX vault from another vault
 * Route: source vault → source underlying → route to CVX → hybrid swap/mint → pxCVX → deposit
 *
 * Uses the hybrid pxCVX approach:
 * - If Curve pool rate > 1:1: swap CVX → lpxCVX → unwrap → pxCVX
 * - If rate < 1:1: deposit CVX to Pirex for 1:1 pxCVX
 * - Optimal: split between swap and mint at peg point
 */
async function fetchVaultToPxCvxVaultRoute(params: {
  fromAddress: string;
  sourceVault: string;
  targetVault: string;
  amountIn: string;
  sourceUnderlyingToken: string;
  slippage: string;
}): Promise<EnsoBundleResponse> {
  const { PIREX } = await import("@/config/vaults");

  // Validate slippage parameter
  const slippageBps = validateSlippage(params.slippage);

  // Step 1: Check if source underlying is already CVX
  const sourceIsCvx = params.sourceUnderlyingToken.toLowerCase() === TOKENS.CVX.toLowerCase();

  // Step 2: Estimate underlying amount from vault redeem using previewRedeem
  const estimatedUnderlyingAmount = await previewRedeem(params.sourceVault, params.amountIn);

  // Step 3: Estimate how much CVX we'll have after routing
  let estimatedCvxAmount: string;

  if (sourceIsCvx) {
    estimatedCvxAmount = estimatedUnderlyingAmount;
  } else {
    // Estimate CVX from route (throws on failure)
    estimatedCvxAmount = await estimateRouteOutput(
      params.fromAddress,
      params.sourceUnderlyingToken,
      TOKENS.CVX,
      estimatedUnderlyingAmount,
      params.slippage
    );
  }

  // Step 3: Calculate optimal swap vs mint split for pxCVX
  const { swapAmount, mintAmount } = await getOptimalPxCvxSwapAmount(estimatedCvxAmount);

  // Step 4: Calculate expected pxCVX output and min_dy for slippage protection
  // For hybrid path: use swapAmount
  // For swap-only path: use full estimatedCvxAmount
  let expectedSwapPxCvx = 0n;
  let swapMinDy = "0";
  let fullSwapMinDy = "0"; // For swap-only path

  if (swapAmount > 0n) {
    // Apply conservative buffer: reduce input by 1% for upstream slippage
    const conservativeSwapAmount = (swapAmount * 99n) / 100n;
    const swapOutput = await getPxCvxSwapRate(conservativeSwapAmount.toString());
    // CRITICAL: Throw if estimation fails or returns zero - never use min_dy=0
    if (!swapOutput || swapOutput === 0n) {
      throw new Error("Failed to estimate Curve CVX→lpxCVX swap output for slippage protection");
    }
    expectedSwapPxCvx = swapOutput;
    swapMinDy = calculateMinDy(swapOutput, slippageBps);
  }

  // For swap-only path, calculate min_dy for full CVX amount
  if (mintAmount === 0n && swapAmount > 0n) {
    // Apply conservative buffer: reduce input by 1% for upstream slippage
    const conservativeFullCvx = (BigInt(estimatedCvxAmount) * 99n) / 100n;
    const fullSwapOutput = await getPxCvxSwapRate(conservativeFullCvx.toString());
    // CRITICAL: Throw if estimation fails or returns zero
    if (!fullSwapOutput || fullSwapOutput === 0n) {
      throw new Error("Failed to estimate Curve CVX→lpxCVX swap output for slippage protection");
    }
    fullSwapMinDy = calculateMinDy(fullSwapOutput, slippageBps);
  }

  const totalExpectedPxCvx = expectedSwapPxCvx + mintAmount;

  // Build actions
  const actions: EnsoBundleAction[] = [];
  let actionIndex = 0;

  // Action 0: Redeem from source vault to get source underlying
  actions.push({
    protocol: "erc4626",
    action: "redeem",
    args: {
      tokenIn: params.sourceVault,
      tokenOut: params.sourceUnderlyingToken,
      amountIn: params.amountIn,
      primaryAddress: params.sourceVault,
    },
  });
  const redeemIdx = actionIndex++;

  if (!sourceIsCvx) {
    // Action: Route source underlying → CVX
    // NOTE: Use literal amount instead of useOutputOfCallAt because bundle API
    // needs to pre-compute the route and can't do that with dynamic amounts
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.sourceUnderlyingToken,
        tokenOut: TOKENS.CVX,
        amountIn: estimatedUnderlyingAmount,
        slippage: params.slippage,
      },
    });
    actionIndex++;
  }

  // Now we have CVX - apply hybrid pxCVX logic
  // Reference the CVX source (either redeem or route output)
  const cvxSourceIdx = sourceIsCvx ? redeemIdx : actionIndex - 1;

  if (swapAmount > 0n && mintAmount > 0n) {
    // Hybrid: swap portion via Curve, mint portion via Pirex
    // NOTE: We use literal amounts for the hybrid split, not useOutputOfCallAt
    // because we need to split the CVX between two paths

    // Approve CVX to Curve pool for swap portion
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

    // Swap CVX → lpxCVX via Curve (with slippage protection)
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX_CVX_POOL,
        method: "exchange",
        abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
        args: [String(PIREX.POOL_INDEX.CVX), String(PIREX.POOL_INDEX.LPXCVX), swapAmount.toString(), swapMinDy],
      },
    });
    const swapIdx = actionIndex++;

    // Approve lpxCVX for unwrap
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

    // Unwrap lpxCVX → pxCVX
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

    // Approve CVX to Pirex for mint portion
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

    // Deposit CVX to Pirex → pxCVX
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.PIREX_CVX,
        method: "deposit",
        abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
        args: [mintAmount.toString(), params.fromAddress, "false", "0x0000000000000000000000000000000000000000"],
      },
    });
    actionIndex++;

  } else if (swapAmount > 0n) {
    // Swap-only path (all CVX goes through Curve swap)
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: { useOutputOfCallAt: cvxSourceIdx },
      },
    });
    actionIndex++;

    // Swap CVX → lpxCVX via Curve with calculated min_dy for MEV protection
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX_CVX_POOL,
        method: "exchange",
        abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
        args: [String(PIREX.POOL_INDEX.CVX), String(PIREX.POOL_INDEX.LPXCVX), { useOutputOfCallAt: cvxSourceIdx }, fullSwapMinDy],
      },
    });
    const swapIdx = actionIndex++;

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
    // Mint-only path
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.PIREX_CVX,
        amount: { useOutputOfCallAt: cvxSourceIdx },
      },
    });
    actionIndex++;

    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.PIREX_CVX,
        method: "deposit",
        abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
        args: [{ useOutputOfCallAt: cvxSourceIdx }, params.fromAddress, "false", "0x0000000000000000000000000000000000000000"],
      },
    });
    actionIndex++;
  }

  // Final: Deposit pxCVX into target vault
  // Use erc4626 action so amountsOut tracks the vault shares
  actions.push({
    protocol: "erc4626",
    action: "deposit",
    args: {
      tokenIn: PIREX.PXCVX,
      tokenOut: params.targetVault,
      amountIn: totalExpectedPxCvx.toString(),
      primaryAddress: params.targetVault,
    },
  });

  // Use "router" strategy because the enso.route action inside bundles
  // doesn't work well with "delegate" when combined with other actions
  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
}

/**
 * Custom bundle for zapping FROM a pxCVX vault to another vault
 * Route: pxCVX vault → pxCVX → wrap to lpxCVX → Curve swap → CVX → route → target underlying → target vault
 *
 * NOTE: We can't use lpxCVX.swap() because it returns nothing, making it impossible
 * to reference the output CVX amount in subsequent actions. Instead we break it down:
 * 1. Wrap pxCVX → lpxCVX (1:1 ratio)
 * 2. Swap lpxCVX → CVX on Curve directly (returns amount)
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

  // Check if target is cvgCVX - needs custom routing via CVX1/Curve
  const targetIsCvgCvx = params.targetUnderlyingToken.toLowerCase() === TOKENS.CVGCVX.toLowerCase();

  // Calculate estimates upfront for concrete amounts
  // This helps Enso simulate the bundle correctly
  const estimatedPxCvx = await previewRedeem(params.sourceVault, params.amountIn);
  // lpxCVX wraps 1:1 from pxCVX
  const estimatedLpxCvx = estimatedPxCvx;
  // Estimate CVX output from Curve exchange (lpxCVX → CVX)
  const estimatedCvx = await getLpxCvxToCvxSwapRate(estimatedLpxCvx);

  // Note: Using concrete estimates to help Enso simulate the bundle correctly
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
    // Action 1: Approve pxCVX to lpxCVX contract for wrapping
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.PXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: 0 },
      },
    },
    // Action 2: Wrap pxCVX → lpxCVX (1:1 ratio, no return value but amount is same)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "wrap",
        abi: "function wrap(uint256 amount)",
        args: [{ useOutputOfCallAt: 0 }],
      },
    },
    // Action 3: Approve lpxCVX to Curve pool for swap
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: { useOutputOfCallAt: 0 }, // Same amount as pxCVX (1:1 wrap)
      },
    },
    // Action 4: Swap lpxCVX → CVX on Curve pool (RETURNS the CVX amount!)
    // exchange(i=1, j=0, dx, min_dy) where 1=lpxCVX, 0=CVX
    // Note: min_dy=0 for dynamic amounts, bundle's slippage protects final output
    {
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX_CVX_POOL,
        method: "exchange",
        abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [
          String(PIREX.POOL_INDEX.LPXCVX), // i = 1 (lpxCVX)
          String(PIREX.POOL_INDEX.CVX), // j = 0 (CVX)
          { useOutputOfCallAt: 0 }, // dx = amount (same as pxCVX from redeem)
          "0",
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
        amountIn: { useOutputOfCallAt: 4 }, // Use Curve exchange output
        primaryAddress: params.targetVault,
      },
    });
  } else if (targetIsCvgCvx) {
    // Target is cvgCVX - needs custom routing via CVX1 wrap + Curve swap
    const { TANGENT } = await import("@/config/vaults");

    // Use concrete estimated CVX amount for better Enso simulation
    const estimatedCvxStr = estimatedCvx.toString();

    // Estimate cvgCVX output for the deposit action
    const estimatedCvgCvx = await getCvgCvxSwapRate(estimatedCvxStr);
    const estimatedCvgCvxStr = estimatedCvgCvx.toString();

    actions.push(
      // Action 5: Approve CVX → CVX1 wrapper
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX,
          spender: TOKENS.CVX1,
          amount: estimatedCvxStr, // CVX from Curve exchange
        },
      },
      // Action 6: Mint CVX → CVX1 (1:1, mint to router so subsequent actions can use it)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "mint",
          abi: "function mint(address to, uint256 amount)",
          args: [ENSO_ROUTER_EXECUTOR, estimatedCvxStr],
        },
      },
      // Action 7: Approve CVX1 → Curve pool (use CVX amount since mint is 1:1)
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX1,
          spender: TANGENT.CVX1_CVGCVX_POOL,
          amount: estimatedCvxStr, // Use CVX amount (1:1 with CVX1)
        },
      },
      // Action 8: Swap CVX1 → cvgCVX on Curve pool
      // Note: min_dy=0 for dynamic amounts, bundle's slippage protects final output
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVX1_CVGCVX_POOL,
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          args: [
            "0", // i = 0 (CVX1)
            "1", // j = 1 (cvgCVX)
            estimatedCvxStr, // dx = CVX1 amount (same as CVX, 1:1 mint)
            "0", // min_dy - bundle slippage handles this
          ],
        },
      },
      // Action 9: Deposit cvgCVX into target vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: TOKENS.CVGCVX,
          tokenOut: params.targetVault,
          amountIn: estimatedCvgCvxStr, // Use estimated Curve exchange output
          primaryAddress: params.targetVault,
        },
      }
    );
  } else {
    // Need to route CVX → target underlying via Enso
    actions.push(
      // Action 5: Route CVX → target underlying via Enso
      {
        protocol: "enso",
        action: "route",
        args: {
          tokenIn: TOKENS.CVX,
          tokenOut: params.targetUnderlyingToken,
          amountIn: { useOutputOfCallAt: 4 }, // Use Curve exchange output
          slippage: params.slippage,
        },
      },
      // Action 6: Deposit target underlying into target vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: params.targetUnderlyingToken,
          tokenOut: params.targetVault,
          amountIn: { useOutputOfCallAt: 5 }, // Use route output
          primaryAddress: params.targetVault,
        },
      }
    );
  }

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
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
  // Note: Keep using direct RPC call here for backward compatibility with tests
  // Main optimization is in fetchCvgCvxVaultToVaultRoute which uses batchRedeemAndEstimateSwap
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
  const { balances, Ann, fee, offpegFeeMultiplier } = await getCurvePoolParams(TANGENT.CVX1_CVGCVX_POOL);

  // Find peg point using off-chain math (local computation, ~0ms)
  let pegPoint = findPegPointOffchain(balances, Ann, fee, offpegFeeMultiplier);

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
      routingStrategy: "router",
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
      // Action 1: Wrap CVX → CVX1 (mint to router so subsequent actions can use it)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "mint",
          abi: "function mint(address to, uint256 amount)",
          args: [ENSO_ROUTER_EXECUTOR, params.amountIn],
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
      routingStrategy: "router",
    });
  }

  // Standard path: route input → CVX first
  // Note: Using concrete estimates for amounts to help Enso simulate the bundle correctly
  // The route action uses dynamic output, but subsequent actions use the estimated CVX amount
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
    // Action 1: Approve CVX → CVX1 (use estimated CVX amount)
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: expectedCvxOutput },
    },
    // Action 2: Wrap CVX → CVX1 (mint to router so subsequent actions can use it)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "mint",
        abi: "function mint(address to, uint256 amount)",
        args: [ENSO_ROUTER_EXECUTOR, expectedCvxOutput],
      },
    },
    // Action 3: Approve CVX1 → Curve pool
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX1, spender: TANGENT.CVX1_CVGCVX_POOL, amount: expectedCvxOutput },
    },
    // Action 4: Swap CVX1 → cvgCVX via Curve
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [0, 1, expectedCvxOutput, minDy],
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
    routingStrategy: "router",
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
  expectedCvxOutput: string,
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
      // Action 1: Mint cvgCVX from CVX (1:1, isLock=true for no fees, mint to router)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVGCVX_CONTRACT,
          method: "mint",
          abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
          args: [ENSO_ROUTER_EXECUTOR, params.amountIn, true],
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
      routingStrategy: "router",
    });
  }

  // Standard path: route input → CVX first
  // Note: Using concrete estimates for amounts to help Enso simulate the bundle correctly
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
    // Action 1: Approve CVX → cvgCVX contract (use estimated CVX amount)
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TANGENT.CVGCVX_CONTRACT, amount: expectedCvxOutput },
    },
    // Action 2: Mint cvgCVX from CVX (1:1, isLock=true for no fees, mint to router)
    // mint(address to, uint256 amount, bool isLock) returns (uint256)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVGCVX_CONTRACT,
        method: "mint",
        abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
        args: [ENSO_ROUTER_EXECUTOR, expectedCvxOutput, true],
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
    routingStrategy: "router",
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
      // Action 1: Wrap swapAmount CVX → CVX1 (mint to router)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "mint",
          abi: "function mint(address to, uint256 amount)",
          args: [ENSO_ROUTER_EXECUTOR, swapAmount.toString()],
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
      // Action 5: Mint cvgCVX from CVX (1:1, isLock=true, mint to router)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVGCVX_CONTRACT,
          method: "mint",
          abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
          args: [ENSO_ROUTER_EXECUTOR, mintAmount.toString(), true],
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
      routingStrategy: "router",
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
    // Action 2: Wrap swapAmount CVX → CVX1 (mint to router)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "mint",
        abi: "function mint(address to, uint256 amount)",
        args: [ENSO_ROUTER_EXECUTOR, swapAmount.toString()],
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
    // Action 6: Mint cvgCVX from CVX (1:1, isLock=true, mint to router)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVGCVX_CONTRACT,
        method: "mint",
        abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
        args: [ENSO_ROUTER_EXECUTOR, mintAmount.toString(), true],
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
    routingStrategy: "router",
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
      routingStrategy: "router",
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
    // Action 3: Unwrap CVX1 → CVX (send to router so it can be used in route action)
    // withdraw(uint256 amount, address to) - burns CVX1, sends CVX to router
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "withdraw",
        abi: "function withdraw(uint256 amount, address to)",
        args: [{ useOutputOfCallAt: 2 }, ENSO_ROUTER_EXECUTOR],
      },
    },
    // Action 4: Swap CVX to output token (ETH, USDC, etc.)
    // Use estimated CVX amount (CVX1 ≈ CVX 1:1, withdraw doesn't return value)
    // Note: Using concrete estimate because dynamic reference to CVX1 output
    // causes Enso quoting issues when route tokenIn is CVX
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.outputToken,
        amountIn: (expectedCvx1Output ?? BigInt(expectedCvgCvxOutput)).toString(),
        slippage: params.slippage ?? "100",
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
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

  // Validate slippage parameter
  const slippageBps = validateSlippage(params.slippage);

  // Check if output is already CVX - skip final route step
  const outputIsCvx = params.outputToken.toLowerCase() === TOKENS.CVX.toLowerCase();

  // Estimate pxCVX output from vault redeem using previewRedeem (throws on failure)
  const expectedPxCvxOutput = await previewRedeem(params.vaultAddress, params.amountIn);

  // Apply conservative buffer: reduce input by 1% for upstream slippage
  const conservativePxCvxAmount = (BigInt(expectedPxCvxOutput) * 99n) / 100n;

  // Query Curve CryptoSwap pool get_dy to estimate CVX output from lpxCVX swap
  // Uses uint256 indices: lpxCVX (index 1) to CVX (index 0)
  // pxCVX wraps 1:1 to lpxCVX
  const expectedCvxOutput = await getLpxCvxToCvxSwapRate(conservativePxCvxAmount.toString());

  // CRITICAL: Throw if estimation fails or returns zero - never use min_dy=0
  if (expectedCvxOutput === 0n) {
    throw new Error("Failed to estimate Curve lpxCVX→CVX swap output for slippage protection");
  }

  // Calculate min_dy with slippage
  const minDy = calculateMinDy(expectedCvxOutput, slippageBps);

  // Build actions using wrap + exchange pattern (mirrors zap IN's exchange + unwrap)
  // NOTE: lpxCVX.swap() returns void, so we can't use useOutputOfCallAt with it
  // Use separate wrap + Curve exchange where exchange RETURNS uint256
  // wrap is 1:1 (pxCVX → lpxCVX), so lpxCVX amount equals pxCVX amount
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
    // Action 1: Approve pxCVX to lpxCVX contract for wrapping
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.PXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: 0 },
      },
    },
    // Action 2: Wrap pxCVX → lpxCVX (1:1 ratio)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "wrap",
        abi: "function wrap(uint256 amount)",
        args: [{ useOutputOfCallAt: 0 }],
      },
    },
    // Action 3: Approve lpxCVX to Curve pool (same amount as pxCVX due to 1:1 wrap)
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: { useOutputOfCallAt: 0 }, // Same as pxCVX (1:1 wrap)
      },
    },
    // Action 4: Exchange lpxCVX → CVX on Curve pool (RETURNS uint256!)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX_CVX_POOL,
        method: "exchange",
        abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
        args: [
          String(PIREX.POOL_INDEX.LPXCVX), // i = 1 (lpxCVX)
          String(PIREX.POOL_INDEX.CVX), // j = 0 (CVX)
          { useOutputOfCallAt: 0 }, // dx = same as pxCVX (1:1 wrap)
          minDy, // min_dy with slippage
        ],
      },
    },
  ];

  if (!outputIsCvx) {
    // Output is not CVX - need final route step using Curve exchange output
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: 4 }, // Use Curve exchange output (returns uint256)
        slippage: params.slippage ?? "100",
      },
    });
  }

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
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
 * Get expected CVX output for lpxCVX → CVX swap on Curve CryptoSwap pool
 * This is the reverse direction of getPxCvxSwapRate (for zap out)
 *
 * Note: This pool uses uint256 indices (not int128 like StableSwap pools)
 * get_dy(uint256,uint256,uint256) selector: 0x556d6e9f
 */
async function getLpxCvxToCvxSwapRate(amountIn: string): Promise<bigint> {
  const { PIREX } = await import("@/config/vaults");

  // get_dy(uint256 i, uint256 j, uint256 dx) - lpxCVX (1) → CVX (0)
  const selector = "0x556d6e9f";
  const i = "1".padStart(64, "0"); // lpxCVX index
  const j = "0".padStart(64, "0"); // CVX index
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

// ============================================================================
// CryptoSwap Off-Chain Math (for pxCVX pool)
// Uses @yldfi/curve-amm-math for calculations
// ============================================================================

// Local interface extending TwocryptoParams with backwards-compat fee field
interface CryptoSwapParams extends TwocryptoParams {
  fee: bigint; // Current dynamic fee (kept for backwards compat)
}

/**
 * Fetch all CryptoSwap pool parameters in a single batch RPC call
 */
export async function getCryptoSwapPoolParams(poolAddress: string): Promise<CryptoSwapParams> {
  // Function selectors
  const selectors = {
    A: "0xf446c1d0", // A()
    gamma: "0xb1373929", // gamma()
    D: "0x0f529ba2", // D()
    fee: "0xddca3f43", // fee()
    midFee: "0x92526c0c", // mid_fee()
    outFee: "0xee8de675", // out_fee()
    feeGamma: "0x72d4f0e2", // fee_gamma()
    priceScale: "0xb9e8c9fd", // price_scale()
    balances0: "0x4903b0d10000000000000000000000000000000000000000000000000000000000000000",
    balances1: "0x4903b0d10000000000000000000000000000000000000000000000000000000000000001",
  };

  const batch = Object.entries(selectors).map(([key, data], id) => ({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: poolAddress, data }, "latest"],
  }));

  const response = await fetch(PUBLIC_RPC_URLS.llamarpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });

  const results = (await response.json()) as Array<{ id: number; result?: string }>;
  results.sort((a, b) => a.id - b.id);

  return {
    A: BigInt(results[0].result || "0"),
    gamma: BigInt(results[1].result || "0"),
    D: BigInt(results[2].result || "0"),
    fee: BigInt(results[3].result || "0"),
    midFee: BigInt(results[4].result || "0"),
    outFee: BigInt(results[5].result || "0"),
    feeGamma: BigInt(results[6].result || "0"),
    priceScale: BigInt(results[7].result || "0"),
    balances: [BigInt(results[8].result || "0"), BigInt(results[9].result || "0")],
  };
}

// Use cryptoswap functions from npm package
// Wrapper that accepts our CryptoSwapParams interface
export function cryptoSwapGetDy(
  params: CryptoSwapParams,
  i: number,
  j: number,
  dx: bigint
): bigint {
  return cryptoswap.getDy(params, i, j, dx);
}

/**
 * Estimate peg point using pool balance heuristics
 * For CryptoSwap, the peg point is roughly where adding more CVX
 * would push the rate below 1:1
 *
 * This provides a reasonable starting point for on-chain verification
 */
export function estimatePegPointFromBalances(params: CryptoSwapParams): bigint {
  const cvxBalance = params.balances[0];
  const lpxCvxBalance = params.balances[1];

  // If pool has more CVX than lpxCVX, peg point is likely small or zero
  // If pool has more lpxCVX than CVX, peg point is larger

  // Rough heuristic: peg point ~ (lpxCvxBalance - cvxBalance) / 2
  // This is just an estimate to narrow the binary search range
  if (lpxCvxBalance > cvxBalance) {
    // Excess lpxCVX means there's swap bonus available
    const excess = lpxCvxBalance - cvxBalance;
    // Start with a conservative estimate
    return excess / 3n;
  }

  // No excess lpxCVX, likely no swap bonus
  return 0n;
}

/**
 * Find peg point using off-chain CryptoSwap math (binary search)
 * Returns the maximum amount where swap output >= input (rate >= 1:1)
 * Uses npm package for calculations - wrapper for backwards compatibility (i=0, j=1)
 */
export function findPegPointOffchainCryptoSwap(params: CryptoSwapParams): bigint {
  return cryptoswap.findPegPoint(params, 0, 1);
}

/**
 * Calculate optimal swap amount for pxCVX hybrid swap/mint strategy
 * Uses off-chain CryptoSwap math for efficiency (1 batched RPC call + verification)
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
    const { PIREX } = await import("@/config/vaults");

    // RPC call 1: Get all pool parameters in single batch
    const params = await getCryptoSwapPoolParams(PIREX.LPXCVX_CVX_POOL);

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

    // RPC call 2: Verify peg point with on-chain get_dy
    try {
      const onChainDy = await getPxCvxSwapRate(pegPoint.toString());

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

/**
 * Create a custom Zap In route for pxCVX via Pirex infrastructure
 * Route: input token → CVX → (hybrid swap/mint) → pxCVX → vault
 *
 * Hybrid strategy:
 * - If Curve pool rate > 1:1: swap CVX → lpxCVX → unwrap → pxCVX
 * - If rate < 1:1: deposit CVX to Pirex for 1:1 pxCVX
 * - Optimal: split between swap and mint at peg point
 *
 * NOTE: lpxCVX.unwrap() and PirexCVX.deposit() don't return values,
 * so we calculate expected pxCVX amounts upfront for the vault deposit.
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

  // Step 3: Calculate expected pxCVX output for each path
  // - Swap path: CVX → lpxCVX (via Curve) → pxCVX (1:1 unwrap)
  // - Mint path: CVX → pxCVX (1:1 via Pirex)
  const slippageBps = validateSlippage(params.slippage);
  let expectedSwapPxCvx = 0n;
  let swapMinDy = "0";
  if (swapAmount > 0n) {
    // Apply conservative buffer: reduce input by 1% for upstream slippage
    const conservativeSwapAmount = (swapAmount * 99n) / 100n;
    const swapOutput = await getPxCvxSwapRate(conservativeSwapAmount.toString());
    // CRITICAL: Throw if estimation fails or returns zero - never use min_dy=0
    if (!swapOutput || swapOutput === 0n) {
      throw new Error("Failed to estimate Curve CVX→lpxCVX swap output for slippage protection");
    }
    expectedSwapPxCvx = swapOutput;
    swapMinDy = calculateMinDy(swapOutput, slippageBps);
  }
  const expectedMintPxCvx = mintAmount; // 1:1 ratio
  const totalExpectedPxCvx = expectedSwapPxCvx + expectedMintPxCvx;

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
          String(PIREX.POOL_INDEX.CVX), // i = 0 (CVX)
          String(PIREX.POOL_INDEX.LPXCVX), // j = 1 (lpxCVX)
          swapAmount.toString(), // dx
          swapMinDy, // min_dy with slippage protection
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
          "false", // shouldCompound (boolean as string for Enso API)
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
          String(PIREX.POOL_INDEX.CVX),
          String(PIREX.POOL_INDEX.LPXCVX),
          inputIsCvx ? params.amountIn : { useOutputOfCallAt: actionIndex - 2 },
          swapMinDy, // Use calculated min_dy for MEV protection
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
          "false", // shouldCompound (boolean as string for Enso API)
          "0x0000000000000000000000000000000000000000",
        ],
      },
    });
    actionIndex++;
  }

  // Final action: Approve pxCVX to vault and deposit
  // Use calculated total expected pxCVX amount (swap output + mint amount)
  actions.push({
    protocol: "erc20",
    action: "approve",
    args: {
      token: PIREX.PXCVX,
      spender: params.vaultAddress,
      amount: totalExpectedPxCvx.toString(),
    },
  });
  actionIndex++;

  // Action: Deposit pxCVX into vault
  // NOTE: We use the pre-calculated expected pxCVX amount because:
  // - lpxCVX.unwrap() doesn't return a value
  // - PirexCVX.deposit() doesn't return a value
  // The total is: expectedSwapPxCvx (from Curve get_dy) + mintAmount (1:1)
  // IMPORTANT: Use raw call instead of erc4626 action to avoid Enso routing conflicts
  actions.push({
    protocol: "enso",
    action: "call",
    args: {
      address: params.vaultAddress,
      method: "deposit",
      abi: "function deposit(uint256 assets, address receiver) returns (uint256)",
      args: [totalExpectedPxCvx.toString(), params.fromAddress],
    },
  });

  // Fetch bundle result
  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });

  // Calculate expected vault shares using previewDeposit
  // (raw call doesn't track outputs, so we calculate manually)
  try {
    const previewDepositSelector = "0xef8b30f7"; // previewDeposit(uint256)
    const previewData = previewDepositSelector + totalExpectedPxCvx.toString(16).padStart(64, "0");
    const previewResponse = await fetch(PUBLIC_RPC_URLS.llamarpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: params.vaultAddress, data: previewData }, "latest"],
      }),
    });
    const previewResult = await previewResponse.json() as { result?: string };
    if (previewResult.result && previewResult.result !== "0x") {
      const expectedShares = BigInt(previewResult.result).toString();
      bundleResult.amountsOut = {
        ...bundleResult.amountsOut,
        [params.vaultAddress.toLowerCase()]: expectedShares,
      };
    }
  } catch {
    // Ignore preview errors - amountsOut will just be empty
  }

  return bundleResult;
}
