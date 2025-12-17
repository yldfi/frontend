"use client";

import { useQuery } from "@tanstack/react-query";
import { useBalance } from "wagmi";
import { useAccount } from "wagmi";
import { useMemo } from "react";
import { fetchWalletBalances, fetchTokenPrices, ETH_ADDRESS } from "@/lib/enso";
import type { EnsoToken } from "@/types/enso";

/**
 * Fetch wallet balances from Enso API and return sorted tokens
 * Uses Enso's wallet/balances endpoint which is more efficient than multicall
 * Also fetches prices for all tokens (not just ones with balance)
 */
export function useTokenBalances(tokens: EnsoToken[]) {
  const { address: userAddress, isConnected } = useAccount();

  // Get ETH balance separately (Enso may not include native ETH)
  const { data: ethBalance } = useBalance({
    address: userAddress,
    query: {
      enabled: isConnected,
    },
  });

  // Fetch wallet balances from Enso API (includes prices for held tokens)
  const { data: ensoBalances, isLoading: balancesLoading } = useQuery({
    queryKey: ["enso-wallet-balances", userAddress],
    queryFn: () => fetchWalletBalances(userAddress!),
    enabled: !!userAddress && isConnected,
    staleTime: 30 * 1000, // 30 seconds
    refetchInterval: 60 * 1000, // Refresh every minute
  });

  // Get addresses of popular tokens to fetch prices for
  const popularTokenAddresses = useMemo(() => {
    // Get first 20 tokens for price fetching (to avoid too many)
    return tokens.slice(0, 20).map((t) => t.address);
  }, [tokens]);

  // Fetch prices for popular tokens (even if user doesn't hold them)
  const { data: tokenPrices, isLoading: pricesLoading } = useQuery({
    queryKey: ["enso-token-prices", popularTokenAddresses],
    queryFn: () => fetchTokenPrices(popularTokenAddresses),
    enabled: popularTokenAddresses.length > 0,
    staleTime: 60 * 1000, // 1 minute
  });

  // Build balance and price maps, sort tokens
  const { balanceMap, priceMap, sortedTokens } = useMemo(() => {
    const balances = new Map<string, bigint>();
    const prices = new Map<string, number>();

    // Add ETH balance
    if (ethBalance) {
      balances.set(ETH_ADDRESS.toLowerCase(), ethBalance.value);
    }

    // Add prices from batch price fetch (for all popular tokens)
    if (tokenPrices) {
      for (const item of tokenPrices) {
        prices.set(item.address.toLowerCase(), item.price);
      }
    }

    // Add Enso balances and prices (overrides batch prices with more accurate data)
    if (ensoBalances) {
      for (const item of ensoBalances) {
        const address = item.token.toLowerCase();
        balances.set(address, BigInt(item.amount));
        if (item.price > 0) {
          prices.set(address, item.price);
        }
      }
    }

    // Sort tokens: those with balance first, then by original order
    const sorted = [...tokens].sort((a, b) => {
      const balanceA = balances.get(a.address.toLowerCase()) ?? 0n;
      const balanceB = balances.get(b.address.toLowerCase()) ?? 0n;

      // Both have balance or both don't - keep original order
      if ((balanceA > 0n) === (balanceB > 0n)) {
        return 0;
      }

      // Token with balance comes first
      return balanceB > 0n ? 1 : -1;
    });

    return { balanceMap: balances, priceMap: prices, sortedTokens: sorted };
  }, [tokens, ensoBalances, ethBalance, tokenPrices]);

  return {
    sortedTokens,
    balanceMap,
    priceMap,
    isLoading: balancesLoading || pricesLoading,
  };
}
