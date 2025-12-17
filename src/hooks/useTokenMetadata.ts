"use client";

import { useReadContracts } from "wagmi";
import { useMemo } from "react";
import { isAddress } from "viem";
import type { EnsoToken } from "@/types/enso";

// ERC20 ABI for token metadata
const ERC20_METADATA_ABI = [
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

/**
 * Fetch token metadata from blockchain by address
 * Used for importing custom tokens not in the token list
 */
export function useTokenMetadata(address: string | undefined) {
  const isValidAddress = address && isAddress(address);
  const tokenAddress = isValidAddress ? (address as `0x${string}`) : undefined;

  const { data, isLoading, error } = useReadContracts({
    contracts: tokenAddress
      ? [
          {
            address: tokenAddress,
            abi: ERC20_METADATA_ABI,
            functionName: "name",
          },
          {
            address: tokenAddress,
            abi: ERC20_METADATA_ABI,
            functionName: "symbol",
          },
          {
            address: tokenAddress,
            abi: ERC20_METADATA_ABI,
            functionName: "decimals",
          },
        ]
      : undefined,
    query: {
      enabled: !!tokenAddress,
    },
  });

  const token = useMemo<EnsoToken | null>(() => {
    if (!tokenAddress || !data) return null;

    const [nameResult, symbolResult, decimalsResult] = data;

    // Check if all calls succeeded
    if (
      nameResult.status !== "success" ||
      symbolResult.status !== "success" ||
      decimalsResult.status !== "success"
    ) {
      return null;
    }

    return {
      address: tokenAddress,
      chainId: 1,
      name: nameResult.result as string,
      symbol: symbolResult.result as string,
      decimals: decimalsResult.result as number,
      type: "base",
    };
  }, [tokenAddress, data]);

  return {
    token,
    isLoading,
    error,
    isValidAddress: !!isValidAddress,
  };
}
