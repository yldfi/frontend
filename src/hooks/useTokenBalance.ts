"use client";

import { useReadContracts, useAccount } from "wagmi";
import { formatUnits } from "viem";

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

interface TokenBalanceResult {
  balance: bigint;
  decimals: number;
  formatted: string;
}

export function useTokenBalance(
  tokenAddress: `0x${string}`
): TokenBalanceResult & { isLoading: boolean } {
  const { address: userAddress, isConnected } = useAccount();

  const { data, isLoading } = useReadContracts({
    contracts: [
      {
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: userAddress ? [userAddress] : undefined,
      },
      {
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "decimals",
      },
    ],
    query: {
      enabled: isConnected && !!userAddress,
    },
  });

  const balance = (data?.[0]?.result as bigint) ?? 0n;
  const decimals = (data?.[1]?.result as number) ?? 18;
  const formatted = formatUnits(balance, decimals);

  return {
    balance,
    decimals,
    formatted,
    isLoading: isLoading && isConnected,
  };
}
