// Enso API Service
// Docs: https://docs.enso.build

import type { EnsoToken, EnsoTokensResponse, EnsoRouteResponse, EnsoBundleAction, EnsoBundleResponse } from "@/types/enso";

const ENSO_API_BASE = "https://api.enso.finance/api/v1";
const CHAIN_ID = 1; // Ethereum mainnet

// ETH placeholder address used by Enso
export const ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

// cvxCRV token address
export const CVXCRV_ADDRESS = "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7";

// Enso router contract address (for approvals)
export const ENSO_ROUTER = "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E";

// yld_fi referral code for Enso attribution
export const ENSO_REFERRAL_CODE = "yldfi";


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
  // yld_fi vault tokens
  {
    address: "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86",
    chainId: 1,
    name: "yld_fi cvxCRV yVault",
    symbol: "ycvxCRV",
    decimals: 18,
    logoURI: "/ycvxcrv-128.png",
    type: "defi",
  },
  {
    address: "0xCa960E6DF1150100586c51382f619efCCcF72706",
    chainId: 1,
    name: "yld_fi Convex cvxCRV Compounder",
    symbol: "yscvxCRV",
    decimals: 18,
    logoURI: "/yscvxcrv-128.png",
    type: "defi",
  },
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
  "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86", // ycvxCRV
  "0xCa960E6DF1150100586c51382f619efCCcF72706", // yscvxCRV
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

  const response = await fetch(`${ENSO_API_BASE}/tokens?${searchParams}`, {
    headers: getHeaders(),
  });

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

  const response = await fetch(
    `${ENSO_API_BASE}/shortcuts/route?${searchParams}`,
    { headers: getHeaders() }
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
export const YLDFI_VAULT_ADDRESSES = {
  ycvxCRV: "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86",
  yscvxCRV: "0xCa960E6DF1150100586c51382f619efCCcF72706",
} as const;

/**
 * Check if an address is a yld_fi vault
 */
export function isYldfiVault(address: string): boolean {
  const lowerAddress = address.toLowerCase();
  return Object.values(YLDFI_VAULT_ADDRESSES).some(
    (vaultAddr) => vaultAddr.toLowerCase() === lowerAddress
  );
}

/**
 * Bundle multiple DeFi actions into a single transaction
 * Used for vault-to-vault zaps (redeem from one vault, deposit to another)
 */
export async function fetchBundle(params: {
  fromAddress: string;
  actions: EnsoBundleAction[];
  receiver?: string;
}): Promise<EnsoBundleResponse> {
  const searchParams = new URLSearchParams({
    chainId: String(CHAIN_ID),
    fromAddress: params.fromAddress,
    routingStrategy: "router",
    referralCode: ENSO_REFERRAL_CODE,
  });

  if (params.receiver) {
    searchParams.set("receiver", params.receiver);
  }

  const response = await fetch(
    `${ENSO_API_BASE}/shortcuts/bundle?${searchParams}`,
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(params.actions),
    }
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
 */
export async function fetchVaultToVaultRoute(params: {
  fromAddress: string;
  sourceVault: string;
  targetVault: string;
  amountIn: string;
  underlyingToken?: string; // defaults to cvxCRV
}): Promise<EnsoBundleResponse> {
  const underlying = params.underlyingToken || CVXCRV_ADDRESS;

  const actions: EnsoBundleAction[] = [
    // Step 1: Redeem from source vault to get underlying token
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.sourceVault,
        tokenOut: underlying,
        amountIn: params.amountIn,
        primaryAddress: params.sourceVault,
      },
    },
    // Step 2: Deposit underlying into target vault
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: underlying,
        tokenOut: params.targetVault,
        amountIn: { useOutputOfCallAt: 0 }, // Use output from redeem
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
