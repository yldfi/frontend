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
  CVXCRV: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7" as const,
  STKCVXCRV: "0xaa0C3f5F7DFD688C6E646F66CD2a6B66ACdbE434" as const,
} as const;

// Vault addresses
export const VAULT_ADDRESSES = {
  YCVXCRV: "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86" as const,
  YSCVXCRV: "0xCa960E6DF1150100586c51382f619efCCcF72706" as const,
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
}

// All vaults configuration
export const VAULTS: Record<string, VaultConfig> = {
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

// Get all vault IDs
export function getAllVaultIds(): string[] {
  return Object.keys(VAULTS);
}

// Check if address is a yld_fi vault
export function isYldfiVault(address: string): boolean {
  return getVaultByAddress(address) !== undefined;
}

// Get parent vault for a strategy
export function getParentVault(strategyAddress: string): VaultConfig | undefined {
  const normalized = strategyAddress.toLowerCase();
  return Object.values(VAULTS).find(
    (v) => v.type === "vault" && v.underlyingStrategy?.toLowerCase() === normalized
  );
}
