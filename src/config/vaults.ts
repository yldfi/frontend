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
  CVX1: "0x6c9815826fdf8c7a45ccfed2064dbab33a078712" as const, // CVX wrapper for Convergence
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
  CVX1_CVGCVX_POOL: "0xc50e191f703fb3160fc15d8b168a8c740fec3666" as const,
  // cvgCVX token contract (has mint function for 1:1 CVX -> cvgCVX)
  CVGCVX_CONTRACT: "0x2191DF768ad71140F9F3E96c1e4407A4aA31d082" as const,
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
  LPXCVX_CVX_POOL: "0x72725c0c879489986d213a9a6d2116de45624c1c" as const,
  // Pirex CVX deposit contract - locks CVX to mint pxCVX at 1:1
  // deposit(uint256 assets, address receiver, bool shouldCompound, address developer)
  PIREX_CVX: "0x35a398425d9f1029021a92bc3d2557d42c8588d7" as const,
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
      "Auto-compounding CVX staking rewards via Convex. Use as collateral on Curve LlamaLend to borrow crvUSD.",
    longDescription:
      "Deposits are allocated to the yscvx strategy, which stakes CVX on Convex Finance to earn cvxCRV rewards. Rewards are automatically auctioned for more CVX and re-deposited to compound your position. Use as collateral on Curve LlamaLend to borrow crvUSD.",
    strategy: "Convex CVX Compounder",
    badges: ["CVX", "Compounder", "Collateral (LlamaLend)"],
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
    description: "Auto-compounding CVX staking rewards via Convex. Lower 5% fee but no collateral support.",
    longDescription:
      "This strategy accepts CVX deposits and stakes them on Convex Finance's cvxRewardPool. Earned cvxCRV rewards are automatically auctioned for more CVX and re-deposited to compound your position. Lower 5% performance fee but cannot be used as collateral on LlamaLend.",
    strategy: "Convex CVX Compounder",
    badges: ["CVX", "Compounder"],
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
      "Auto-compounding cvxCRV staking rewards via Convex. Use as collateral on Curve LlamaLend to borrow crvUSD.",
    longDescription:
      "Deposits are allocated to the yscvxCRV strategy, which auto-compounds cvxCRV staking rewards from Convex. Use as collateral on Curve LlamaLend to borrow crvUSD. 15% of the 20% performance fee on yield is distributed to LlamaLend lenders to encourage borrowing liquidity.",
    strategy: "Convex cvxCRV Compounder",
    badges: ["cvxCRV", "Compounder", "Collateral (LlamaLend)"],
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
    description: "Auto-compounding cvxCRV staking rewards via Convex. Lower 5% fee but no collateral support.",
    longDescription:
      "This strategy accepts cvxCRV deposits and stakes them on Convex Finance. Earned CRV, CVX, and 3CRV rewards are automatically harvested, swapped to cvxCRV, and re-deposited to compound your position. Lower 5% performance fee but cannot be used as collateral on LlamaLend.",
    strategy: "Convex cvxCRV Compounder",
    badges: ["cvxCRV", "Compounder"],
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
    description: "Auto-compounding cvgCVX staking rewards via Tangent LiquidBoost. Earn vlCVX voting incentives without locking.",
    longDescription:
      "This strategy accepts cvgCVX deposits and stakes them on Tangent Finance's LiquidBoost platform. Earned voting incentives, CVX1 wrapper returns, and treasury boost rewards are automatically harvested, swapped to cvgCVX, and re-deposited to compound your position. cvgCVX is a liquid derivative of vlCVX that can be staked or unstaked anytime.",
    strategy: "Staked cvgCVX Compounder",
    badges: ["cvgCVX", "Compounder", "LiquidBoost"],
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
    description: "Auto-compounding pxCVX Votium snapshot rewards via Pirex. Earn vlCVX voting incentives without locking.",
    longDescription:
      "This strategy accepts pxCVX deposits and claims Votium snapshot rewards from Pirex CVX. Earned reward tokens are automatically auctioned for more pxCVX and re-deposited to compound your position. pxCVX is a liquid derivative of CVX that earns vlCVX voting incentives without locking.",
    strategy: "Pirex pxCVX Compounder",
    badges: ["pxCVX", "Compounder", "Votium"],
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

// Check if address is a yld_fi vault
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
    acquireUrl: "https://app.tangent.finance/liquid-boost/cvx",
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
