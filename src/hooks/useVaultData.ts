"use client";

import { useReadContracts, useAccount } from "wagmi";

// Yearn V3 Vault ABI (minimal for reading fees)
const vaultAbi = [
  {
    name: "accountant",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "totalAssets",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "pricePerShare",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

// Yearn Accountant ABI (for fees)
const accountantAbi = [
  {
    name: "defaultConfig",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "managementFee", type: "uint16" },
      { name: "performanceFee", type: "uint16" },
      { name: "refundRatio", type: "uint16" },
      { name: "maxFee", type: "uint16" },
      { name: "maxGain", type: "uint16" },
      { name: "maxLoss", type: "uint16" },
    ],
  },
  {
    name: "customConfig",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "vault", type: "address" }],
    outputs: [
      { name: "managementFee", type: "uint16" },
      { name: "performanceFee", type: "uint16" },
      { name: "refundRatio", type: "uint16" },
      { name: "maxFee", type: "uint16" },
      { name: "maxGain", type: "uint16" },
      { name: "maxLoss", type: "uint16" },
    ],
  },
  {
    name: "useCustomConfig",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "vault", type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export interface VaultData {
  totalAssets: bigint;
  pricePerShare: bigint;
  decimals: number;
  accountant: `0x${string}`;
  managementFee: number; // in basis points (e.g., 100 = 1%)
  performanceFee: number; // in basis points (e.g., 1500 = 15%)
  isLoading: boolean;
  error: Error | null;
}

export function useVaultData(vaultAddress: `0x${string}`): VaultData {
  const { chainId } = useAccount();

  // First, read vault data including accountant address
  const { data: vaultData, isLoading: vaultLoading, error: vaultError } = useReadContracts({
    contracts: [
      { address: vaultAddress, abi: vaultAbi, functionName: "accountant", chainId },
      { address: vaultAddress, abi: vaultAbi, functionName: "totalAssets", chainId },
      { address: vaultAddress, abi: vaultAbi, functionName: "pricePerShare", chainId },
      { address: vaultAddress, abi: vaultAbi, functionName: "decimals", chainId },
    ],
  });

  const accountantAddress = vaultData?.[0]?.result as `0x${string}` | undefined;

  // Then read accountant fees
  const { data: accountantData, isLoading: accountantLoading, error: accountantError } = useReadContracts({
    contracts: accountantAddress ? [
      { address: accountantAddress, abi: accountantAbi, functionName: "useCustomConfig", args: [vaultAddress], chainId },
      { address: accountantAddress, abi: accountantAbi, functionName: "customConfig", args: [vaultAddress], chainId },
      { address: accountantAddress, abi: accountantAbi, functionName: "defaultConfig", chainId },
    ] : [],
    query: {
      enabled: !!accountantAddress,
    },
  });

  // Determine which config to use
  const useCustom = accountantData?.[0]?.result as boolean | undefined;
  const customConfig = accountantData?.[1]?.result as readonly [number, number, number, number, number, number] | undefined;
  const defaultConfig = accountantData?.[2]?.result as readonly [number, number, number, number, number, number] | undefined;

  const config = useCustom ? customConfig : defaultConfig;

  return {
    totalAssets: (vaultData?.[1]?.result as bigint) ?? 0n,
    pricePerShare: (vaultData?.[2]?.result as bigint) ?? 0n,
    decimals: (vaultData?.[3]?.result as number) ?? 18,
    accountant: accountantAddress ?? "0x0000000000000000000000000000000000000000",
    managementFee: config?.[0] ?? 0,
    performanceFee: config?.[1] ?? 0,
    isLoading: vaultLoading || accountantLoading,
    error: vaultError || accountantError || null,
  };
}

// Helper to format fee from basis points to percentage
export function formatFee(bps: number): string {
  return (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2);
}
