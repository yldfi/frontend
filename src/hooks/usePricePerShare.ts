"use client";

import { useReadContracts } from "wagmi";
import { formatUnits } from "viem";

// ERC-4626 standard ABI for price per share calculation
const ERC4626_ABI = [
  {
    name: "convertToAssets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export function usePricePerShare(vaultAddress: `0x${string}`) {
  const { data, isLoading, error } = useReadContracts({
    contracts: [
      {
        address: vaultAddress,
        abi: ERC4626_ABI,
        functionName: "decimals",
      },
      {
        address: vaultAddress,
        abi: ERC4626_ABI,
        functionName: "convertToAssets",
        args: [BigInt(10 ** 18)], // 1 share with 18 decimals
      },
    ],
    query: {
      staleTime: 60 * 1000, // 1 minute
      refetchInterval: 60 * 1000,
    },
  });

  const decimals = (data?.[0]?.result as number) ?? 18;
  const assetsPerShare = data?.[1]?.result as bigint | undefined;

  // Convert to number: assets returned for 1e18 shares
  // Price per share = assetsPerShare / 1e18 (since we passed 1e18 shares)
  const pricePerShare = assetsPerShare
    ? Number(formatUnits(assetsPerShare, decimals))
    : 1;

  return {
    pricePerShare,
    pricePerShareFormatted: pricePerShare.toFixed(4),
    decimals,
    isLoading,
    error,
  };
}

// Hook to fetch price per share for multiple vaults at once
export function useMultiplePricePerShare(vaultAddresses: `0x${string}`[]) {
  // Build contracts array: for each vault, we need decimals and convertToAssets
  const contracts = vaultAddresses.flatMap((address) => [
    {
      address,
      abi: ERC4626_ABI,
      functionName: "decimals" as const,
    },
    {
      address,
      abi: ERC4626_ABI,
      functionName: "convertToAssets" as const,
      args: [BigInt(10 ** 18)] as const,
    },
  ]);

  const { data, isLoading, error } = useReadContracts({
    contracts,
    query: {
      staleTime: 60 * 1000,
      refetchInterval: 60 * 1000,
    },
  });

  const results = vaultAddresses.map((address, index) => {
    const decimalsIndex = index * 2;
    const assetsIndex = index * 2 + 1;

    const decimals = (data?.[decimalsIndex]?.result as number) ?? 18;
    const assetsPerShare = data?.[assetsIndex]?.result as bigint | undefined;

    const pricePerShare = assetsPerShare
      ? Number(formatUnits(assetsPerShare, decimals))
      : 1;

    return {
      address,
      pricePerShare,
      pricePerShareFormatted: pricePerShare.toFixed(4),
      decimals,
    };
  });

  return {
    prices: results,
    isLoading,
    error,
  };
}
