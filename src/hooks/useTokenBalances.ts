"use client";

import { useQuery } from "@tanstack/react-query";
import { useBalance, usePublicClient } from "wagmi";
import { useAccount } from "wagmi";
import { useMemo } from "react";
import { fetchWalletBalances, fetchTokenPrices, ETH_ADDRESS } from "@/lib/enso";
import { useTenderly } from "@/contexts/TenderlyContext";
import type { EnsoToken } from "@/types/enso";
import { erc20Abi } from "viem";

/**
 * Fetch wallet balances and return sorted tokens.
 * - Mainnet: Enso API (efficient, includes prices)
 * - Test networks (Anvil/Tenderly): on-chain multicall balanceOf
 */
export function useTokenBalances(tokens: EnsoToken[]) {
  const { address: userAddress, isConnected } = useAccount();
  const { isTestNetwork } = useTenderly();
  const publicClient = usePublicClient();

  // Get ETH balance separately (Enso may not include native ETH)
  const { data: ethBalance } = useBalance({
    address: userAddress,
    query: {
      enabled: isConnected,
    },
  });

  // --- Mainnet path: Enso API ---
  const { data: ensoBalances, isLoading: ensoBalancesLoading } = useQuery({
    queryKey: ["enso-wallet-balances", userAddress],
    queryFn: () => fetchWalletBalances(userAddress!),
    enabled: !!userAddress && isConnected && !isTestNetwork,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });

  // --- Test network path: on-chain multicall ---
  const erc20Addresses = useMemo(() => {
    return tokens
      .filter((t) => t.address.toLowerCase() !== ETH_ADDRESS.toLowerCase())
      .map((t) => t.address as `0x${string}`);
  }, [tokens]);

  const { data: onchainBalances, isLoading: onchainLoading } = useQuery({
    queryKey: ["onchain-balances", userAddress, erc20Addresses.length],
    queryFn: async () => {
      if (!publicClient || !userAddress) return [];

      const calls = erc20Addresses.map((addr) => ({
        address: addr,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [userAddress] as const,
      }));

      const results = await publicClient.multicall({ contracts: calls });

      return erc20Addresses.map((addr, i) => ({
        address: addr.toLowerCase(),
        balance: (results[i].status === "success" ? results[i].result : 0n) as bigint,
      }));
    },
    enabled: !!userAddress && isConnected && isTestNetwork && !!publicClient,
    staleTime: 10 * 1000,
    refetchInterval: 15 * 1000,
  });

  // Prices (from Enso — works for both paths, prices are mainnet-based anyway)
  const popularTokenAddresses = useMemo(() => {
    return tokens.slice(0, 20).map((t) => t.address);
  }, [tokens]);

  const { data: tokenPrices, isLoading: pricesLoading } = useQuery({
    queryKey: ["enso-token-prices", popularTokenAddresses],
    queryFn: () => fetchTokenPrices(popularTokenAddresses),
    enabled: popularTokenAddresses.length > 0,
    staleTime: 60 * 1000,
  });

  // Build balance and price maps, sort tokens
  const { balanceMap, priceMap, sortedTokens } = useMemo(() => {
    const balances = new Map<string, bigint>();
    const prices = new Map<string, number>();

    // Add ETH balance
    if (ethBalance) {
      balances.set(ETH_ADDRESS.toLowerCase(), ethBalance.value);
    }

    // Add prices from batch price fetch
    if (tokenPrices) {
      for (const item of tokenPrices) {
        prices.set(item.address.toLowerCase(), item.price);
      }
    }

    if (isTestNetwork) {
      // Test network: use on-chain multicall results
      if (onchainBalances) {
        for (const item of onchainBalances) {
          if (item.balance > 0n) {
            balances.set(item.address, item.balance);
          }
        }
      }
    } else {
      // Mainnet: use Enso balances (overrides batch prices with more accurate data)
      if (ensoBalances) {
        for (const item of ensoBalances) {
          const address = item.token.toLowerCase();
          balances.set(address, BigInt(item.amount));
          if (item.price > 0) {
            prices.set(address, item.price);
          }
        }
      }
    }

    // Sort tokens: those with balance first, then by original order
    const sorted = [...tokens].sort((a, b) => {
      const balanceA = balances.get(a.address.toLowerCase()) ?? 0n;
      const balanceB = balances.get(b.address.toLowerCase()) ?? 0n;

      if ((balanceA > 0n) === (balanceB > 0n)) return 0;
      return balanceB > 0n ? 1 : -1;
    });

    return { balanceMap: balances, priceMap: prices, sortedTokens: sorted };
  }, [tokens, ensoBalances, onchainBalances, ethBalance, tokenPrices, isTestNetwork]);

  return {
    sortedTokens,
    balanceMap,
    priceMap,
    isLoading: isTestNetwork
      ? onchainLoading || pricesLoading
      : ensoBalancesLoading || pricesLoading,
  };
}
