"use client";

import { useReadContract } from "wagmi";
import { formatUnits } from "viem";

// Pin on-chain oracle reads to mainnet so dev configs with Anvil/VNet pointing
// elsewhere don't silently return 0.
const MAINNET_ID = 1 as const;

// Chainlink CVX/USD price feed
const CVX_USD_CHAINLINK = "0xC27E191714b429C51e18FAfba6A4C31135B2e157" as `0x${string}`;

const CHAINLINK_ABI = [
  {
    name: "latestAnswer",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int256" }],
  },
] as const;

export function useCvxPrice() {
  const { data, isLoading, error } = useReadContract({
    address: CVX_USD_CHAINLINK,
    abi: CHAINLINK_ABI,
    functionName: "latestAnswer",
    chainId: MAINNET_ID,
    query: {
      staleTime: 60 * 1000, // 1 minute
      refetchInterval: 60 * 1000, // Refetch every minute
    },
  });

  // Chainlink CVX/USD price (8 decimals)
  const price = data ? Number(formatUnits(data as bigint, 8)) : 0;

  return {
    price,
    isLoading,
    error,
  };
}
