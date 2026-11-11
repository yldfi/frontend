import type { EnsoToken } from "@/types/enso";
import { WETH_ADDRESS, CRVUSD_ADDRESS, YVUSDC1_ADDRESS } from "@/config/addresses";
import { TOKENS, VAULTS, VAULT_ADDRESSES, CURVE_SAVINGS } from "@/config/vaults";
import {
  CVXCRV_ADDRESS,
  ETH_ADDRESS,
  LEGACY_MORPHO_ADDRESS,
  MORPHO_TOKEN_ADDRESS,
} from "./constants";

const TOKEN_DISPLAY_OVERRIDES: Record<string, { name: string; symbol: string }> = {
  [LEGACY_MORPHO_ADDRESS.toLowerCase()]: {
    name: "Legacy Morpho Token",
    symbol: "Legacy MORPHO",
  },
  [MORPHO_TOKEN_ADDRESS.toLowerCase()]: {
    name: "Morpho",
    symbol: "MORPHO",
  },
};

export function getTokenDisplayOverride(address: string | undefined): { name: string; symbol: string } | undefined {
  return address ? TOKEN_DISPLAY_OVERRIDES[address.toLowerCase()] : undefined;
}

export function applyTokenDisplayOverride<T extends { address: string; name?: string; symbol?: string }>(token: T): T {
  const override = getTokenDisplayOverride(token.address);
  return override ? { ...token, ...override } : token;
}

export const isLegacyMorphoToken = (token: string) =>
  token.toLowerCase() === LEGACY_MORPHO_ADDRESS.toLowerCase();

// Custom tokens not in Uniswap list (Convex ecosystem + yld vaults)
export const CUSTOM_TOKENS: EnsoToken[] = [
  {
    address: ETH_ADDRESS,
    chainId: 1,
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
    logoURI: "/tokens/eth.png",
    type: "base",
  },
  {
    address: WETH_ADDRESS,
    chainId: 1,
    name: "Wrapped Ether",
    symbol: "WETH",
    decimals: 18,
    logoURI: "/tokens/weth.png",
    type: "base",
  },
  {
    address: CVXCRV_ADDRESS,
    chainId: 1,
    name: "Convex CRV",
    symbol: "cvxCRV",
    decimals: 18,
    logoURI: "/tokens/cvxcrv.png",
    type: "base",
  },
  {
    address: CRVUSD_ADDRESS,
    chainId: 1,
    name: "crvUSD",
    symbol: "crvUSD",
    decimals: 18,
    logoURI: "/tokens/crvusd.png",
    type: "base",
  },
  // Curve Savings vault (scrvUSD) - deeply integrated partner token
  {
    address: CURVE_SAVINGS.SCRVUSD,
    chainId: 1,
    name: "Savings crvUSD",
    symbol: "scrvUSD",
    decimals: 18,
    logoURI: "/tokens/scrvusd.png",
    type: "defi",
  },
  // Llama Airforce (Union) vault tokens - external vaults users can zap FROM
  {
    address: "0x8659Fc767cad6005de79AF65dAfE4249C57927AF",
    chainId: 1,
    name: "Union Pirex",
    symbol: "uCVX",
    decimals: 18,
    logoURI: "/tokens/llama-airforce.png",
    type: "defi",
  },
  {
    address: "0xde2bEF0A01845257b4aEf2A2EAa48f6EAeAfa8B7",
    chainId: 1,
    name: "Unionized Convex CRV",
    symbol: "uCRV",
    decimals: 18,
    logoURI: "/tokens/llama-airforce.png",
    type: "defi",
  },
  // Concentrator (Aladdin) vault tokens - external vaults users can zap FROM
  {
    address: "0xb0903Ab70a7467eE5756074b31ac88aEBb8fB777",
    chainId: 1,
    name: "Aladdin CVX",
    symbol: "aCVX",
    decimals: 18,
    logoURI: "/tokens/aladdin-cvx.png",
    type: "defi",
  },
  {
    address: "0x2b95A1Dcc3D405535f9ed33c219ab38E8d7e0884",
    chainId: 1,
    name: "Aladdin cvxCRV",
    symbol: "aCRV",
    decimals: 18,
    logoURI: "/tokens/aladdin-crv.png",
    type: "defi",
  },
  // Beefy Finance vault tokens - external vaults users can zap FROM
  {
    address: "0x4115150523599D1F6C6Fa27F5A4C27D578Fd8ce5",
    chainId: 1,
    name: "Moo Convex CRV",
    symbol: "mooCvxCRV",
    decimals: 18,
    logoURI: "/tokens/beefy.png",
    type: "defi",
  },
  {
    address: "0xf12DD69a5ab0cfbf41758052D871B881DC0fC8e0",
    chainId: 1,
    name: "Moo Convex CVX",
    symbol: "mooCvxCVX",
    decimals: 18,
    logoURI: "/tokens/beefy.png",
    type: "defi",
  },
  // Asymmetry Finance vault token - ERC4626 vault for CVX (3% withdrawal fee)
  {
    address: "0x8668a15b7b023Dc77B372a740FCb8939E15257Cf",
    chainId: 1,
    name: "Asymmetry Finance afCVX",
    symbol: "afCVX",
    decimals: 18,
    logoURI: "/tokens/afcvx.png",
    type: "defi",
  },
  // Pirex tokens - pxCVX and lpxCVX (lpxCVX wraps pxCVX for Curve liquidity)
  {
    address: "0xBCe0Cf87F513102F22232436CCa2ca49e815C3aC",
    chainId: 1,
    name: "Pirex CVX",
    symbol: "pxCVX",
    decimals: 18,
    logoURI: "/tokens/pxcvx.png",
    type: "defi",
  },
  {
    address: "0x389fB29230D02e67eB963C1F5A00f2b16f95BEb7",
    chainId: 1,
    name: "Liquid Pirex CVX",
    symbol: "lpxCVX",
    decimals: 18,
    logoURI: "/tokens/pxcvx.png",
    type: "defi",
  },
  // Yearn V3 vault tokens
  {
    address: YVUSDC1_ADDRESS,
    chainId: 1,
    name: "USDC-1 yVault",
    symbol: "yvUSDC-1",
    decimals: 6,
    logoURI: "/tokens/yearn-v3.svg",
    type: "defi",
  },
  // yld vault tokens - from centralized config
  ...Object.values(VAULTS).map((vault) => ({
    address: vault.address,
    chainId: 1,
    name: `yld ${vault.name}`,
    symbol: vault.symbol,
    decimals: vault.decimals,
    logoURI: vault.logo,
    type: "defi" as const,
  })),
];

export function getCustomTokenMetadata(address: string | undefined): EnsoToken | undefined {
  if (!address) return undefined;
  const lower = address.toLowerCase();
  return CUSTOM_TOKENS.find((token) => token.address.toLowerCase() === lower);
}

export function applyKnownTokenMetadata<T extends EnsoToken>(token: T): T {
  const customToken = getCustomTokenMetadata(token.address);
  const normalized = customToken ? { ...token, ...customToken } : token;
  return applyTokenDisplayOverride(normalized) as T;
}

// Popular token addresses for sorting priority
export const POPULAR_TOKENS = [
  ETH_ADDRESS, // ETH
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
  "0x6B175474E89094C44da98B954EeDcDecB5BE4dBf", // DAI
  WETH_ADDRESS, // WETH
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
  "0xD533a949740bb3306d119CC777fa900bA034cd52", // CRV
  "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B", // CVX
  CVXCRV_ADDRESS, // cvxCRV
  CRVUSD_ADDRESS, // crvUSD
  // Llama Airforce (Union) vault tokens
  "0x8659Fc767cad6005de79AF65dAfE4249C57927AF", // uCVX
  "0xde2bEF0A01845257b4aEf2A2EAa48f6EAeAfa8B7", // uCRV
  // Concentrator (Aladdin) vault tokens
  "0xb0903Ab70a7467eE5756074b31ac88aEBb8fB777", // aCVX
  "0x2b95A1Dcc3D405535f9ed33c219ab38E8d7e0884", // aCRV
  // Beefy Finance vault tokens
  "0x4115150523599D1F6C6Fa27F5A4C27D578Fd8ce5", // mooCvxCRV
  "0xf12DD69a5ab0cfbf41758052D871B881DC0fC8e0", // mooCvxCVX
  // Asymmetry Finance vault token
  "0x8668a15b7b023Dc77B372a740FCb8939E15257Cf", // afCVX
  // Pirex tokens
  "0xBCe0Cf87F513102F22232436CCa2ca49e815C3aC", // pxCVX
  "0x389fB29230D02e67eB963C1F5A00f2b16f95BEb7", // lpxCVX
  ...Object.values(VAULT_ADDRESSES), // yld vaults
];

export const isPxCvxAddress = (token: string) => token.toLowerCase() === TOKENS.PXCVX.toLowerCase();
export const isLpxCvxAddress = (token: string) => token.toLowerCase() === TOKENS.LPXCVX.toLowerCase();

const COMMON_TOKEN_DECIMALS: Record<string, number> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 6, // USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7": 6, // USDT
  "0x6b175474e89094c44da98b954eedcdecb5be4dbf": 18, // DAI
  [WETH_ADDRESS.toLowerCase()]: 18,
  "0xd533a949740bb3306d119cc777fa900ba034cd52": 18, // CRV
};

export function getTokenDecimals(address: string): number {
  const lower = address.toLowerCase();

  const customToken = CUSTOM_TOKENS.find((token) => token.address.toLowerCase() === lower);
  if (customToken) return customToken.decimals;

  const vault = Object.values(VAULTS).find((item) => item.address.toLowerCase() === lower);
  if (vault) return vault.decimals;

  if (COMMON_TOKEN_DECIMALS[lower] !== undefined) return COMMON_TOKEN_DECIMALS[lower];

  return 18;
}

// Additional token symbols for route display
const TOKEN_SYMBOLS: Record<string, string> = {
  [ETH_ADDRESS.toLowerCase()]: "ETH",
  [LEGACY_MORPHO_ADDRESS.toLowerCase()]: "Legacy MORPHO",
  [MORPHO_TOKEN_ADDRESS.toLowerCase()]: "MORPHO",
  [TOKENS.CVX.toLowerCase()]: "CVX",
  [TOKENS.CVXCRV.toLowerCase()]: "cvxCRV",
  [TOKENS.PXCVX.toLowerCase()]: "pxCVX",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
  "0x6b175474e89094c44da98b954eedcdecb5be4dbf": "DAI",
  [WETH_ADDRESS.toLowerCase()]: "WETH",
  "0xd533a949740bb3306d119cc777fa900ba034cd52": "CRV",
  // Llama Airforce (Union) vault tokens
  "0x8659fc767cad6005de79af65dafe4249c57927af": "uCVX",
  "0xde2bef0a01845257b4aef2a2eaa48f6eaeafa8b7": "uCRV",
  // Concentrator (Aladdin) vault tokens
  "0xb0903ab70a7467ee5756074b31ac88aebb8fb777": "aCVX",
  "0x2b95a1dcc3d405535f9ed33c219ab38e8d7e0884": "aCRV",
  // Beefy Finance vault tokens
  "0x4115150523599d1f6c6fa27f5a4c27d578fd8ce5": "mooCvxCRV",
  "0xf12dd69a5ab0cfbf41758052d871b881dc0fc8e0": "mooCvxCVX",
  // Asymmetry Finance vault token
  "0x8668a15b7b023dc77b372a740fcb8939e15257cf": "afCVX",
  // Pirex tokens
  "0x389fb29230d02e67eb963c1f5a00f2b16f95beb7": "lpxCVX",
};

/**
 * Get token symbol by address
 * Looks up in CUSTOM_TOKENS, TOKEN_SYMBOLS, and VAULTS
 */
export function getTokenSymbol(address: string): string {
  const lower = address.toLowerCase();

  // Check custom tokens first
  const customToken = CUSTOM_TOKENS.find(t => t.address.toLowerCase() === lower);
  if (customToken) return customToken.symbol;

  // Check additional symbols
  if (TOKEN_SYMBOLS[lower]) return TOKEN_SYMBOLS[lower];

  // Check vaults
  const vault = Object.values(VAULTS).find(v => v.address.toLowerCase() === lower);
  if (vault) return vault.symbol;

  // Fallback to shortened address
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
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

// Pirex token addresses
export const PIREX_PXCVX = "0xBCe0Cf87F513102F22232436CCa2ca49e815C3aC";
export const PIREX_LPXCVX = "0x389fB29230D02e67eB963C1F5A00f2b16f95BEb7";

/**
 * Check if token is pxCVX
 */
export function isPxCvxToken(address: string): boolean {
  return address.toLowerCase() === PIREX_PXCVX.toLowerCase();
}

/**
 * Check if token is lpxCVX
 */
export function isLpxCvxToken(address: string): boolean {
  return address.toLowerCase() === PIREX_LPXCVX.toLowerCase();
}
