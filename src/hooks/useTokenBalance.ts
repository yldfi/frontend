"use client";

import { useReadContracts, useAccount } from "wagmi";
import { formatUnits } from "viem";
import { ERC20_BALANCE_ABI } from "@/lib/abis";
import { QUERY_CONFIG } from "@/config/query";

interface TokenBalanceResult {
  balance: bigint;
  decimals: number;
  formatted: string;
  refetch: () => void;
}

export function useTokenBalance(
  tokenAddress: `0x${string}`
): TokenBalanceResult & { isLoading: boolean } {
  const { address: userAddress, isConnected, chainId } = useAccount();

  const { data, isLoading, refetch } = useReadContracts({
    contracts: [
      {
        address: tokenAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: userAddress ? [userAddress] : undefined,
        chainId, // Use connected chain
      },
      {
        address: tokenAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: "decimals",
        chainId, // Use connected chain
      },
    ],
    query: {
      enabled: isConnected && !!userAddress,
      ...QUERY_CONFIG.balance,
      refetchOnMount: true,
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
    refetch,
  };
}
