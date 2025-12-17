"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, useMemo, useCallback } from "react";
import {
  fetchEnsoTokenList,
  CUSTOM_TOKENS,
  filterTokens,
  sortTokensByPopularity,
  ETH_ADDRESS,
} from "@/lib/enso";
import { useImportedTokens } from "@/hooks/useImportedTokens";
import type { EnsoToken } from "@/types/enso";

// Default ETH token for when we need it immediately
export const DEFAULT_ETH_TOKEN: EnsoToken = {
  address: ETH_ADDRESS,
  chainId: 1,
  name: "Ethereum",
  symbol: "ETH",
  decimals: 18,
  logoURI: "https://assets.coingecko.com/coins/images/279/thumb/ethereum.png",
  type: "base",
};

export function useEnsoTokens() {
  const [searchQuery, setSearchQuery] = useState("");
  const { importedTokens, addToken, isImported } = useImportedTokens();

  // Fetch Enso token list with metadata
  const {
    data: ensoTokens,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["enso-token-list"],
    queryFn: fetchEnsoTokenList,
    staleTime: 30 * 60 * 1000, // 30 minutes
    refetchOnWindowFocus: false,
  });

  // Merge Enso tokens with custom tokens and imported tokens, dedupe by address
  const allTokens = useMemo(() => {
    const tokenMap = new Map<string, EnsoToken>();

    // Add imported tokens first (highest priority - user added)
    for (const token of importedTokens) {
      tokenMap.set(token.address.toLowerCase(), token);
    }

    // Add custom tokens (higher priority - cvxCRV, vault tokens, etc.)
    for (const token of CUSTOM_TOKENS) {
      if (!tokenMap.has(token.address.toLowerCase())) {
        tokenMap.set(token.address.toLowerCase(), token);
      }
    }

    // Add Enso tokens (won't override custom/imported tokens)
    if (ensoTokens) {
      for (const token of ensoTokens) {
        const key = token.address.toLowerCase();
        if (!tokenMap.has(key)) {
          tokenMap.set(key, token);
        }
      }
    }

    // Convert to array and sort
    const tokens = Array.from(tokenMap.values());
    return sortTokensByPopularity(tokens);
  }, [ensoTokens, importedTokens]);

  // Filter tokens by search query
  const filteredTokens = useMemo(() => {
    const filtered = filterTokens(allTokens, searchQuery);
    // Limit to 100 tokens for performance
    return filtered.slice(0, 100);
  }, [allTokens, searchQuery]);

  // Import a new token (persists to localStorage)
  const importToken = useCallback((token: EnsoToken) => {
    addToken(token);
  }, [addToken]);

  return {
    tokens: filteredTokens,
    allTokens,
    searchQuery,
    setSearchQuery,
    isLoading,
    error,
    refetch,
    importToken,
    isImported,
  };
}

/**
 * Get a specific token by address
 */
export function useEnsoToken(address: string | undefined) {
  const { allTokens, isLoading } = useEnsoTokens();

  const token = useMemo(() => {
    if (!address) return null;
    return (
      allTokens.find(
        (t) => t.address.toLowerCase() === address.toLowerCase()
      ) || null
    );
  }, [allTokens, address]);

  return { token, isLoading };
}
