"use client";

import { useReadContracts } from "wagmi";
import { isAddress } from "viem";

const SAFE_ACCOUNT_ABI = [
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "VERSION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

export function isSafeAccountResult(
  owners: readonly `0x${string}`[] | undefined,
  threshold: bigint | undefined,
  version: string | undefined,
): boolean {
  return Boolean(
    owners?.length
      && threshold
      && threshold > 0n
      && threshold <= BigInt(owners.length)
      && version
      && /^\d+\.\d+\.\d+$/.test(version),
  );
}

export function useIsSafeWallet(
  address: string | undefined,
  chainId: number | undefined,
): boolean {
  const safeAddress = address && isAddress(address) ? address : undefined;
  const safeChainId = chainId === 1 ? chainId : undefined;
  const { data } = useReadContracts({
    contracts: [
      {
        address: safeAddress,
        abi: SAFE_ACCOUNT_ABI,
        functionName: "getOwners",
        chainId: safeChainId,
      },
      {
        address: safeAddress,
        abi: SAFE_ACCOUNT_ABI,
        functionName: "getThreshold",
        chainId: safeChainId,
      },
      {
        address: safeAddress,
        abi: SAFE_ACCOUNT_ABI,
        functionName: "VERSION",
        chainId: safeChainId,
      },
    ],
    allowFailure: true,
    query: {
      enabled: Boolean(safeAddress && safeChainId),
      staleTime: Infinity,
      retry: false,
    },
  });

  const owners = data?.[0]?.status === "success"
    ? data[0].result as readonly `0x${string}`[]
    : undefined;
  const threshold = data?.[1]?.status === "success"
    ? data[1].result as bigint
    : undefined;
  const version = data?.[2]?.status === "success"
    ? data[2].result as string
    : undefined;

  return isSafeAccountResult(owners, threshold, version);
}
