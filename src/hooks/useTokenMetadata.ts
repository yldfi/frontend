"use client";

import { useReadContracts } from "wagmi";
import { useMemo, useEffect, useState } from "react";
import { isAddress, getAddress } from "viem";
import { ERC20_METADATA_ABI } from "@/lib/abis";
import type { EnsoToken } from "@/types/enso";

/**
 * Try to fetch a token logo from known sources.
 * Returns the first URL that resolves, or undefined.
 */
async function fetchTokenLogo(
  address: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const checksummed = getAddress(address);

  const candidates = [
    // Trust Wallet assets (most popular tokens)
    `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${checksummed}/logo.png`,
    // 1inch token logos
    `https://tokens.1inch.io/v1.2/1/${address.toLowerCase()}.png`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: "HEAD", signal });
      if (res.ok) return url;
    } catch {
      if (signal?.aborted) return undefined;
    }
  }

  // CoinGecko API fallback (rate-limited, try last)
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/ethereum/contract/${address.toLowerCase()}`,
      { signal },
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
  // App is mainnet-only; hardcode chainId: 1 so imports work even when the
  // wallet is on a test network/different chain.
  const chainId = 1 as const;
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

  // Fetch logo in parallel — abort on unmount or address change
  useEffect(() => {
    if (!tokenAddress) return;
    const ac = new AbortController();
    fetchTokenLogo(tokenAddress, ac.signal).then((uri) => {
      if (!ac.signal.aborted) setLogoState({ address: tokenAddress, uri });
    });
    return () => ac.abort();
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
      chainId,
      name: nameResult.result as string,
      symbol: symbolResult.result as string,
      decimals: decimalsResult.result as number,
      logoURI,
      type: "base",
    };
  }, [tokenAddress, data, logoURI]);

  return {
    token,
    isLoading,
    error,
    isValidAddress: !!isValidAddress,
  };
}
