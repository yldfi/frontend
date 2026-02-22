"use client";

import { useReadContracts, useAccount } from "wagmi";
import { useMemo, useEffect, useState } from "react";
import { isAddress, getAddress } from "viem";
import { ERC20_METADATA_ABI } from "@/lib/abis";
import type { EnsoToken } from "@/types/enso";

/**
 * Try to fetch a token logo from known sources.
 * Returns the first URL that resolves, or undefined.
 */
async function fetchTokenLogo(address: string): Promise<string | undefined> {
  const checksummed = getAddress(address);

  const candidates = [
    // Trust Wallet assets (most popular tokens)
    `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${checksummed}/logo.png`,
    // 1inch token logos
    `https://tokens.1inch.io/v1.2/1/${address.toLowerCase()}.png`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok) return url;
    } catch {
      // try next
    }
  }

  // CoinGecko API fallback (rate-limited, try last)
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/ethereum/contract/${address.toLowerCase()}`
    );
    if (res.ok) {
      const data = await res.json() as { image?: { small?: string; thumb?: string } };
      const logo = data?.image?.small || data?.image?.thumb;
      if (logo) return logo;
    }
  } catch {
    // no logo found
  }

  return undefined;
}

/**
 * Fetch token metadata from blockchain by address
 * Used for importing custom tokens not in the token list
 */
export function useTokenMetadata(address: string | undefined) {
  const { chainId } = useAccount();
  const isValidAddress = address && isAddress(address);
  const tokenAddress = isValidAddress ? (address as `0x${string}`) : undefined;
  const [logoState, setLogoState] = useState<{ address: string; uri?: string } | null>(null);

  const { data, isLoading, error } = useReadContracts({
    contracts: tokenAddress
      ? [
          {
            address: tokenAddress,
            abi: ERC20_METADATA_ABI,
            functionName: "name",
            chainId,
          },
          {
            address: tokenAddress,
            abi: ERC20_METADATA_ABI,
            functionName: "symbol",
            chainId,
          },
          {
            address: tokenAddress,
            abi: ERC20_METADATA_ABI,
            functionName: "decimals",
            chainId,
          },
        ]
      : undefined,
    query: {
      enabled: !!tokenAddress,
    },
  });

  // Fetch logo in parallel — keyed by address so stale logos don't linger
  useEffect(() => {
    if (!tokenAddress) return;
    let cancelled = false;
    fetchTokenLogo(tokenAddress).then((uri) => {
      if (!cancelled) setLogoState({ address: tokenAddress, uri });
    });
    return () => { cancelled = true; };
  }, [tokenAddress]);

  // Only use logo if it matches the current address
  const logoURI = logoState?.address === tokenAddress ? logoState?.uri : undefined;

  const token = useMemo<EnsoToken | null>(() => {
    if (!tokenAddress || !data) return null;

    const [nameResult, symbolResult, decimalsResult] = data;

    if (
      nameResult.status !== "success" ||
      symbolResult.status !== "success" ||
      decimalsResult.status !== "success"
    ) {
      return null;
    }

    return {
      address: tokenAddress,
      chainId: chainId ?? 1,
      name: nameResult.result as string,
      symbol: symbolResult.result as string,
      decimals: decimalsResult.result as number,
      logoURI,
      type: "base",
    };
  }, [tokenAddress, data, chainId, logoURI]);

  return {
    token,
    isLoading,
    error,
    isValidAddress: !!isValidAddress,
  };
}
