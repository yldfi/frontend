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

interface VaultBalanceResult {
  balance: bigint;
  decimals: number;
  formatted: string;
  formattedUsd: string;
}

export function useVaultBalance(
  vaultAddress: `0x${string}`,
  pricePerShare: number = 1,
  assetPriceUsd: number = 1
): VaultBalanceResult & { isLoading: boolean } {
  const { address: userAddress, isConnected } = useAccount();

  const { data, isLoading } = useReadContracts({
    contracts: [
      {
        address: vaultAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: userAddress ? [userAddress] : undefined,
      },
      {
        address: vaultAddress,
        abi: ERC20_ABI,
        functionName: "decimals",
      },
    ],
    query: {
      enabled: isConnected && !!userAddress,
      refetchInterval: 12000, // Refetch every 12 seconds (approx 1 block)
      staleTime: 0, // Always refetch on wallet change
      refetchOnMount: true,
    },
  });

  const balance = (data?.[0]?.result as bigint) ?? 0n;
  const decimals = (data?.[1]?.result as number) ?? 18;
  const formatted = formatUnits(balance, decimals);
  const balanceNumber = Number(formatted);

  // Calculate USD value: shares * pricePerShare * assetPriceUsd
  const usdValue = balanceNumber * pricePerShare * assetPriceUsd;
  const formattedUsd = usdValue >= 1000
    ? `$${(usdValue / 1000).toFixed(1)}K`
    : usdValue >= 1
    ? `$${usdValue.toFixed(2)}`
    : usdValue > 0
    ? `$${usdValue.toFixed(4)}`
    : "$0";

  return {
    balance,
    decimals,
    formatted,
    formattedUsd,
    isLoading: isLoading && isConnected,
  };
}

// Hook to get multiple vault balances at once
export function useMultipleVaultBalances(
  vaults: Array<{
    address: `0x${string}`;
    pricePerShare: number;
    assetPriceUsd: number;
  }>
) {
  const { address: userAddress, isConnected } = useAccount();

  const contracts = vaults.flatMap((vault) => [
    {
      address: vault.address,
      abi: ERC20_ABI,
      functionName: "balanceOf" as const,
      args: userAddress ? [userAddress] : undefined,
    },
    {
      address: vault.address,
      abi: ERC20_ABI,
      functionName: "decimals" as const,
    },
  ]);

  const { data, isLoading } = useReadContracts({
    contracts,
    query: {
      enabled: isConnected && !!userAddress,
      refetchInterval: 12000, // Refetch every 12 seconds (approx 1 block)
      staleTime: 0, // Always refetch on wallet change
      refetchOnMount: true,
    },
  });

  const results = vaults.map((vault, index) => {
    const balanceIndex = index * 2;
    const decimalsIndex = index * 2 + 1;

    const balance = (data?.[balanceIndex]?.result as bigint) ?? 0n;
    const decimals = (data?.[decimalsIndex]?.result as number) ?? 18;
    const formatted = formatUnits(balance, decimals);
    const balanceNumber = Number(formatted);

    const usdValue = balanceNumber * vault.pricePerShare * vault.assetPriceUsd;
    const formattedUsd = usdValue >= 1000
      ? `$${(usdValue / 1000).toFixed(1)}K`
      : usdValue >= 1
      ? `$${usdValue.toFixed(2)}`
      : usdValue > 0
      ? `$${usdValue.toFixed(4)}`
      : "$0";

    return {
      address: vault.address,
      balance,
      decimals,
      formatted,
      formattedUsd,
      usdValue,
    };
  });

  return {
    balances: results,
    isLoading: isLoading && isConnected,
    isConnected,
  };
}
