/**
 * Centralized vault configuration - single source of truth
 *
 * All vault metadata, addresses, and display data should be defined here.
 * Components should import from this file rather than defining their own.
 *
 * Note: workers/vault-cache.ts cannot import from src/ due to Cloudflare Worker
 * bundling constraints. Keep addresses there in sync manually.
 */

// Token addresses
export const TOKENS = {
  CVX: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B" as const,
  CVXCRV: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7" as const,
  STKCVXCRV: "0xaa0C3f5F7DFD688C6E646F66CD2a6B66ACdbE434" as const,
  CVGCVX: "0x2191DF768ad71140F9F3E96c1e4407A4aA31d082" as const,
  PXCVX: "0xBCe0Cf87F513102F22232436CCa2ca49e815C3aC" as const,
  LPXCVX: "0x389fB29230D02e67eB963C1F5A00f2b16f95BEb7" as const, // Wrapped pxCVX for Curve swap
  CVX1: "0x6C9815826FdF8c7a45cCfEd2064dbaB33a078712" as const, // CVX wrapper for Convergence
} as const;

// All vault underlying tokens - excluded from zap (use deposit/withdraw tabs instead)
export const VAULT_UNDERLYING_TOKENS = [
  TOKENS.CVXCRV,  // ycvxCRV, yscvxCRV underlying
  TOKENS.CVGCVX,  // yscvgCVX underlying
  TOKENS.PXCVX,   // yspxCVX underlying
] as const;

// Tangent/Convergence infrastructure for cvgCVX zaps
export const TANGENT = {
  // LiquidBoost staking contract - can deposit ETH/CVX and get cvgCVX
  LIQUID_BOOST: "0x2c1D293c50C6d1a4370ebb442A02c5956bbAb119" as const,
  // Curve pool for CVX1 <-> cvgCVX swaps
  CVX1_CVGCVX_POOL: "0xc50E191F703FB3160fC15d8b168A8c740fec3666" as const,
  // cvgCVX token contract (has mint function for 1:1 CVX -> cvgCVX)
  CVGCVX_CONTRACT: "0x2191DF768ad71140F9F3E96c1e4407A4aA31d082" as const,
  // Curve CryptoSwap pool for ETH <-> CVX swaps (coin0=WETH, coin1=CVX)
  CVX_ETH_POOL: "0xB576491F1E6e5E62f1d8F26062Ee822B40B0E0d4" as const,
  // IN_TOKEN_TYPE enum values for deposit()
  IN_TOKEN_TYPE: {
    cvgCVX: 0,
    CVX1: 1,
    CVX: 2,
    ETH: 3,
  } as const,
  // OUT_TOKEN_TYPE enum values for withdraw()
  OUT_TOKEN_TYPE: {
    cvgCVX: 0,
    CVX1: 1,
    CVX: 2,
  } as const,
} as const;

// Pirex infrastructure for pxCVX zaps
export const PIREX = {
  // lpxCVX contract - wraps pxCVX and provides swap to CVX via Curve
  LPXCVX: "0x389fB29230D02e67eB963C1F5A00f2b16f95BEb7" as const,
  // Curve CryptoSwap pool for lpxCVX <-> CVX swaps (uses uint256 indices)
  LPXCVX_CVX_POOL: "0x72725C0C879489986D213A9A6D2116dE45624c1c" as const,
  // Pirex CVX deposit contract - locks CVX to mint pxCVX at 1:1
  // deposit(uint256 assets, address receiver, bool shouldCompound, address developer)
  PIREX_CVX: "0x35A398425d9f1029021A92bc3d2557D42C8588D7" as const,
  // pxCVX token
  PXCVX: "0xBCe0Cf87F513102F22232436CCa2ca49e815C3aC" as const,
  // Token enum for lpxCVX.swap() function
  TOKEN_ENUM: {
    CVX: 0,
    pxCVX: 1,
  } as const,
  // Curve pool indices: coin[0]=CVX, coin[1]=lpxCVX
  POOL_INDEX: {
    CVX: 0,
    LPXCVX: 1,
  } as const,
} as const;

// ============================================================================
// External Vault Infrastructure (Llama Airforce, Concentrator, Beefy)
// Users holding these tokens can zap directly into yld vaults
// ============================================================================

// Llama Airforce (Union) vaults
export const LLAMA_AIRFORCE = {
  // uCVX - ERC4626 vault for pxCVX
  UCVX: "0x8659Fc767cad6005de79AF65dAfE4249C57927AF" as const,
  UCVX_UNDERLYING: "0xBCe0Cf87F513102F22232436CCa2ca49e815C3aC" as const, // pxCVX

  // uCRV - Custom vault for cvxCRV (NOT ERC4626!)
  // Uses withdraw(_to, _shares) instead of redeem(shares, receiver, owner)
  UCRV: "0xde2bEF0A01845257b4aEf2A2EAa48f6EAeAfa8B7" as const,
  UCRV_UNDERLYING: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7" as const, // cvxCRV
} as const;

// Concentrator (Aladdin) vaults - both are ERC4626 compliant
export const CONCENTRATOR = {
  // aCVX - ERC4626 vault for CVX
  ACVX: "0xb0903Ab70a7467eE5756074b31ac88aEBb8fB777" as const,
  ACVX_UNDERLYING: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B" as const, // CVX

  // aCRV - ERC4626 vault for cvxCRV
  ACRV: "0x2b95A1Dcc3D405535f9ed33c219ab38E8d7e0884" as const,
  ACRV_UNDERLYING: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7" as const, // cvxCRV
} as const;

// Beefy Finance vaults - uses withdraw(shares) interface (not ERC4626)
export const BEEFY = {
  // mooCvxCRV - Beefy vault for cvxCRV
  MOO_CVX_CRV: "0x4115150523599D1F6C6Fa27F5A4C27D578Fd8ce5" as const,
  MOO_CVX_CRV_UNDERLYING: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7" as const, // cvxCRV

  // mooCvxCVX - Beefy vault for CVX
  MOO_CVX_CVX: "0xf12DD69a5ab0cfbf41758052D871B881DC0fC8e0" as const,
  MOO_CVX_CVX_UNDERLYING: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B" as const, // CVX
} as const;

// Curve Savings vault - ERC4626 vault for crvUSD
export const CURVE_SAVINGS = {
  SCRVUSD: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367" as const,
  SCRVUSD_UNDERLYING: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E" as const, // crvUSD
} as const;

// Asymmetry Finance vaults - ERC4626 compliant with withdrawal fee
export const ASYMMETRY = {
  // afCVX - ERC4626 vault for CVX (has 3% withdrawal fee)
  AFCVX: "0x8668a15b7b023Dc77B372a740FCb8939E15257Cf" as const,
  AFCVX_UNDERLYING: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B" as const, // CVX
} as const;

// All external vaults that can be used as zap input sources
export const EXTERNAL_VAULT_TOKENS = [
  // Llama Airforce
  LLAMA_AIRFORCE.UCVX,
  LLAMA_AIRFORCE.UCRV,
  // Concentrator
  CONCENTRATOR.ACVX,
  CONCENTRATOR.ACRV,
  // Beefy
  BEEFY.MOO_CVX_CRV,
  BEEFY.MOO_CVX_CVX,
  // Asymmetry
  ASYMMETRY.AFCVX,
  // Curve Savings
  CURVE_SAVINGS.SCRVUSD,
  // Pirex (lpxCVX is a liquidity wrapper, not useful as zap out target)
  PIREX.LPXCVX,
] as const;

// External vault interface types
export type ExternalVaultInterface = "erc4626" | "ucrv" | "beefy";

// External vault config for routing
export interface ExternalVaultConfig {
  address: string;
  underlying: string;
  underlyingSymbol: string;
  interface: ExternalVaultInterface;
  symbol: string;
  name: string;
  protocol: string;
}

// Map of external vault addresses to their configurations
export const EXTERNAL_VAULT_CONFIG: Record<string, ExternalVaultConfig> = {
  // Llama Airforce
  [LLAMA_AIRFORCE.UCVX.toLowerCase()]: {
    address: LLAMA_AIRFORCE.UCVX,
    underlying: LLAMA_AIRFORCE.UCVX_UNDERLYING,
    underlyingSymbol: "pxCVX",
    interface: "erc4626",
    symbol: "uCVX",
    name: "Union CVX",
    protocol: "Llama Airforce",
  },
  [LLAMA_AIRFORCE.UCRV.toLowerCase()]: {
    address: LLAMA_AIRFORCE.UCRV,
    underlying: LLAMA_AIRFORCE.UCRV_UNDERLYING,
    underlyingSymbol: "cvxCRV",
    interface: "ucrv", // Custom interface: withdraw(_to, _shares)
    symbol: "uCRV",
    name: "Union CRV",
    protocol: "Llama Airforce",
  },
  // Concentrator
  [CONCENTRATOR.ACVX.toLowerCase()]: {
    address: CONCENTRATOR.ACVX,
    underlying: CONCENTRATOR.ACVX_UNDERLYING,
    underlyingSymbol: "CVX",
    interface: "erc4626",
    symbol: "aCVX",
    name: "Aladdin CVX",
    protocol: "Concentrator",
  },
  [CONCENTRATOR.ACRV.toLowerCase()]: {
    address: CONCENTRATOR.ACRV,
    underlying: CONCENTRATOR.ACRV_UNDERLYING,
    underlyingSymbol: "cvxCRV",
    interface: "erc4626",
    symbol: "aCRV",
    name: "Aladdin CRV",
    protocol: "Concentrator",
  },
  // Beefy
  [BEEFY.MOO_CVX_CRV.toLowerCase()]: {
    address: BEEFY.MOO_CVX_CRV,
    underlying: BEEFY.MOO_CVX_CRV_UNDERLYING,
    underlyingSymbol: "cvxCRV",
    interface: "beefy", // Custom interface: withdraw(_shares)
    symbol: "mooCvxCRV",
    name: "Moo Convex CRV",
    protocol: "Beefy",
  },
  [BEEFY.MOO_CVX_CVX.toLowerCase()]: {
    address: BEEFY.MOO_CVX_CVX,
    underlying: BEEFY.MOO_CVX_CVX_UNDERLYING,
    underlyingSymbol: "CVX",
    interface: "beefy",
    symbol: "mooCvxCVX",
    name: "Moo Convex CVX",
    protocol: "Beefy",
  },
  // Asymmetry
  [ASYMMETRY.AFCVX.toLowerCase()]: {
    address: ASYMMETRY.AFCVX,
    underlying: ASYMMETRY.AFCVX_UNDERLYING,
    underlyingSymbol: "CVX",
    interface: "erc4626",
    symbol: "afCVX",
    name: "Asymmetry Finance CVX",
    protocol: "Asymmetry",
  },
  // Curve Savings
  [CURVE_SAVINGS.SCRVUSD.toLowerCase()]: {
    address: CURVE_SAVINGS.SCRVUSD,
    underlying: CURVE_SAVINGS.SCRVUSD_UNDERLYING,
    underlyingSymbol: "crvUSD",
    interface: "erc4626",
    symbol: "scrvUSD",
    name: "Savings crvUSD",
    protocol: "Curve",
  },
};

// Check if address is an external vault token
export function isExternalVaultToken(address: string): boolean {
  return address.toLowerCase() in EXTERNAL_VAULT_CONFIG;
}

// Get external vault config
export function getExternalVaultConfig(address: string): ExternalVaultConfig | undefined {
  return EXTERNAL_VAULT_CONFIG[address.toLowerCase()];
}

// Get the underlying token for an external vault
export function getExternalVaultUnderlying(address: string): string | undefined {
  const config = getExternalVaultConfig(address);
  return config?.underlying;
}

// Vault addresses
export const VAULT_ADDRESSES = {
  // CVX vaults (not yet deployed - update when deployed)
  YCVX: "0x0000000000000000000000000000000000000000" as const,
  YSCVX: "0x0000000000000000000000000000000000000000" as const,
  // cvxCRV vaults
  YCVXCRV: "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86" as const,
  YSCVXCRV: "0xCa960E6DF1150100586c51382f619efCCcF72706" as const,
  // cvgCVX vault
  YSCVGCVX: "0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359" as const,
  // pxCVX vault
  YSPXCVX: "0xB246DB2A73EEE3ee026153660c74657C123f8E42" as const,
} as const;

// Curve LlamaLend controller for ycvxCRV
export const CURVE_CONTROLLERS = {
  [VAULT_ADDRESSES.YCVXCRV]: "0x24174143cCF438f0A1F6dCF93B468C127123A96E" as const,
} as const;

// Vault type
export type VaultType = "vault" | "strategy";

// Full vault configuration
export interface VaultConfig {
  // Identifiers
  id: string;
  name: string;
  symbol: string;

  // Contract info
  address: `0x${string}`;
  type: VaultType;
  underlyingStrategy?: `0x${string}`;

  // Asset info
  asset: string;
  assetSymbol: string;
  assetAddress: `0x${string}`;
  decimals: number;
  assetDecimals: number;

  // Display metadata
  description: string;
  longDescription: string;
  strategy: string;
  badges: string[];
  logo: string;
  logoSmall: string;

  // Fee info (basis points for management, percentage for performance display)
  fees: {
    management: number;
    performance: number;
  };
  feeBreakdown: string;

  // External links
  links: {
    etherscan: string;
    curve?: string;
  };

  // Protocol
  chain: string;
  version: string;

  // Visibility
  hidden?: boolean; // Hide from UI but still accessible via direct URL
}

// All vaults configuration
export const VAULTS: Record<string, VaultConfig> = {
  // CVX vaults (not yet deployed)
  ycvx: {
    id: "ycvx",
    name: "yCVX",
    symbol: "yCVX",
    address: VAULT_ADDRESSES.YCVX,
    type: "vault",
    underlyingStrategy: VAULT_ADDRESSES.YSCVX,
    asset: "CVX",
    assetSymbol: "CVX",
    assetAddress: TOKENS.CVX,
    decimals: 18,
    assetDecimals: 18,
    description:
      "Auto-compounding CVX staking rewards via Convex",
    longDescription:
      "Deposits are allocated to the yscvx strategy, which stakes CVX on Convex Finance to earn cvxCRV rewards. Rewards are automatically auctioned for more CVX and re-deposited to compound your position. Use as collateral on Curve LlamaLend to borrow crvUSD.",
    strategy: "Convex CVX Compounder",
    badges: ["Convex", "CVX", "Compounder", "Collateral (LlamaLend)"],
    logo: "/ycvx-128.png",
    logoSmall: "/ycvx-64.png",
    fees: { management: 0, performance: 20 },
    feeBreakdown: "15% to LlamaLend lenders + 5% strategy",
    links: {
      etherscan: `https://etherscan.io/address/${VAULT_ADDRESSES.YCVX}`,
      // curve: TBD when LlamaLend market is created
    },
    chain: "Ethereum",
    version: "v3",
    hidden: true, // Not yet deployed
  },
  yscvx: {
    id: "yscvx",
    name: "yscvx",
    symbol: "yscvx",
    address: VAULT_ADDRESSES.YSCVX,
    type: "strategy",
    asset: "CVX",
    assetSymbol: "CVX",
    assetAddress: TOKENS.CVX,
    decimals: 18,
    assetDecimals: 18,
    description: "Auto-compounding CVX staking rewards via Convex",
    longDescription:
      "This strategy accepts CVX deposits and stakes them on Convex Finance's cvxRewardPool. Earned cvxCRV rewards are automatically auctioned for more CVX and re-deposited to compound your position. Lower 5% performance fee but cannot be used as collateral on LlamaLend.",
    strategy: "Convex CVX Compounder",
    badges: ["Convex", "CVX", "Compounder"],
    logo: "/yscvx-128.png",
    logoSmall: "/yscvx-64.png",
    fees: { management: 0, performance: 5 },
    feeBreakdown: "5% strategy",
    links: {
      etherscan: `https://etherscan.io/address/${VAULT_ADDRESSES.YSCVX}`,
    },
    chain: "Ethereum",
    version: "v3",
    hidden: true, // Not yet deployed
  },
  // cvxCRV vaults
  ycvxcrv: {
    id: "ycvxcrv",
    name: "ycvxCRV",
    symbol: "ycvxCRV",
    address: VAULT_ADDRESSES.YCVXCRV,
    type: "vault",
    underlyingStrategy: VAULT_ADDRESSES.YSCVXCRV,
    asset: "cvxCRV",
    assetSymbol: "cvxCRV",
    assetAddress: TOKENS.CVXCRV,
    decimals: 18,
    assetDecimals: 18,
    description:
      "Auto-compounding cvxCRV staking rewards via Convex",
    longDescription:
      "Deposits are allocated to the yscvxCRV strategy, which auto-compounds cvxCRV staking rewards from Convex. ycvxCRV can be used as collateral on Curve LlamaLend to borrow crvUSD. All vault fees are distributed to LlamaLend lenders to encourage borrowing liquidity.",
    strategy: "cvxCRV Compounder",
    badges: ["Convex", "cvxCRV", "Compounder", "Collateral (LlamaLend)"],
    logo: "/ycvxcrv-128.png",
    logoSmall: "/ycvxcrv-64.png",
    fees: { management: 0, performance: 20 },
    feeBreakdown: "15% to LlamaLend lenders + 5% strategy",
    links: {
      etherscan: `https://etherscan.io/address/${VAULT_ADDRESSES.YCVXCRV}`,
      curve: "https://www.curve.finance/lend/ethereum/markets/one-way-market-35/create",
    },
    chain: "Ethereum",
    version: "v3",
  },
  yscvxcrv: {
    id: "yscvxcrv",
    name: "yscvxCRV",
    symbol: "yscvxCRV",
    address: VAULT_ADDRESSES.YSCVXCRV,
    type: "strategy",
    asset: "cvxCRV",
    assetSymbol: "cvxCRV",
    assetAddress: TOKENS.CVXCRV,
    decimals: 18,
    assetDecimals: 18,
    description: "Auto-compounding cvxCRV staking rewards via Convex",
    longDescription:
      "This strategy accepts cvxCRV deposits and stakes them on Convex Finance. crvUSD rewards are automatically harvested, swapped to cvxCRV and compounded.",
    strategy: "cvxCRV Compounder",
    badges: ["Convex", "cvxCRV", "Compounder"],
    logo: "/yscvxcrv-128.png",
    logoSmall: "/yscvxcrv-64.png",
    fees: { management: 0, performance: 5 },
    feeBreakdown: "5% strategy",
    links: {
      etherscan: `https://etherscan.io/address/${VAULT_ADDRESSES.YSCVXCRV}`,
    },
    chain: "Ethereum",
    version: "v3",
  },
  yscvgcvx: {
    id: "yscvgcvx",
    name: "yscvgCVX",
    symbol: "yscvgCVX",
    address: VAULT_ADDRESSES.YSCVGCVX,
    type: "strategy",
    asset: "cvgCVX",
    assetSymbol: "cvgCVX",
    assetAddress: TOKENS.CVGCVX,
    decimals: 18,
    assetDecimals: 18,
    description: "Auto-compounding cvgCVX staking rewards via Tangent LiquidBoost",
    longDescription:
      "This strategy accepts cvgCVX deposits and stakes them on Tangent Finance's LiquidBoost platform. Earned voting incentives, CVX1 wrapper returns, and treasury boost rewards are automatically harvested and compounded.",
    strategy: "Staked cvgCVX Compounder",
    badges: ["LiquidBoost", "cvgCVX", "Compounder"],
    logo: "/yscvgcvx-128.png",
    logoSmall: "/yscvgcvx-64.png",
    fees: { management: 0, performance: 0 },
    feeBreakdown: "No fees",
    links: {
      etherscan: `https://etherscan.io/address/${VAULT_ADDRESSES.YSCVGCVX}`,
    },
    chain: "Ethereum",
    version: "v3",
  },
  yspxcvx: {
    id: "yspxcvx",
    name: "yspxCVX",
    symbol: "yspxCVX",
    address: VAULT_ADDRESSES.YSPXCVX,
    type: "strategy",
    asset: "pxCVX",
    assetSymbol: "pxCVX",
    assetAddress: TOKENS.PXCVX,
    decimals: 18,
    assetDecimals: 18,
    description: "Auto-compounding pxCVX Votium snapshot rewards via Pirex",
    longDescription:
      "This strategy accepts pxCVX deposits and claims Votium snapshot rewards from Pirex CVX. Earned reward tokens are automatically auctioned for more pxCVX and re-deposited to compound your position. pxCVX is a liquid derivative of CVX that earns vlCVX voting incentives without locking.",
    strategy: "Pirex pxCVX Compounder",
    badges: ["Votium", "pxCVX", "Compounder"],
    logo: "/yspxcvx-128.png",
    logoSmall: "/yspxcvx-64.png",
    fees: { management: 0, performance: 5 },
    feeBreakdown: "5% strategy",
    links: {
      etherscan: `https://etherscan.io/address/${VAULT_ADDRESSES.YSPXCVX}`,
    },
    chain: "Ethereum",
    version: "v3",
    hidden: true, // Coming soon
  },
} as const;

// Helper to get vault by ID
export function getVault(id: string): VaultConfig | undefined {
  return VAULTS[id.toLowerCase()];
}

// Helper to get vault by address
export function getVaultByAddress(address: string): VaultConfig | undefined {
  const normalizedAddress = address.toLowerCase();
  return Object.values(VAULTS).find((v) => v.address.toLowerCase() === normalizedAddress);
}

// Get all vault addresses as array
export function getAllVaultAddresses(): `0x${string}`[] {
  return Object.values(VAULTS).map((v) => v.address);
}

// Helper to get vault's underlying token address
export function getVaultUnderlyingToken(vaultAddress: string): `0x${string}` | undefined {
  const vault = getVaultByAddress(vaultAddress);
  return vault?.assetAddress;
}


// Get all vault IDs
export function getAllVaultIds(): string[] {
  return Object.keys(VAULTS);
}

// Check if address is a yld vault
export function isYldfiVault(address: string): boolean {
  // Exclude zero address (used for undeployed vaults)
  if (address.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    return false;
  }
  return getVaultByAddress(address) !== undefined;
}

// Tokens with limited/no DEX liquidity that require special acquisition methods
export const ILLIQUID_TOKENS: Record<string, {
  symbol: string;
  acquireMethod: string;
  acquireSteps: string[];
  acquireUrl: string;
  acquireButtonText: string;
}> = {
  [TOKENS.CVGCVX.toLowerCase()]: {
    symbol: "cvgCVX",
    acquireMethod: "cvgCVX is acquired through Tangent's LiquidBoost. You can deposit ETH or CVX to get cvgCVX.",
    acquireSteps: [
      "Deposit ETH or CVX on Tangent LiquidBoost",
      "Withdraw your position as cvgCVX tokens",
      "Return here and use the Deposit tab",
    ],
    acquireUrl: "https://liquidboost.tangent.finance/stake/cvx",
    acquireButtonText: "Go to Tangent LiquidBoost",
  },
} as const;

// Check if a token has limited DEX liquidity
export function isIlliquidToken(address: string): boolean {
  return address.toLowerCase() in ILLIQUID_TOKENS;
}

// Get illiquid token info
export function getIlliquidTokenInfo(address: string) {
  return ILLIQUID_TOKENS[address.toLowerCase()];
}

// Get parent vault for a strategy
export function getParentVault(strategyAddress: string): VaultConfig | undefined {
  const normalized = strategyAddress.toLowerCase();
  return Object.values(VAULTS).find(
    (v) => v.type === "vault" && v.underlyingStrategy?.toLowerCase() === normalized
  );
}
