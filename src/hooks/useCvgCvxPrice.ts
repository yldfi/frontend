"use client";

import { useReadContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { useCvxPrice } from "@/hooks/useCvxPrice";

// Pin on-chain oracle reads to mainnet so dev configs with Anvil/VNet pointing
// elsewhere don't silently return 0.
const MAINNET_ID = 1 as const;

// Curve StableSwap pool for CVX1 <-> cvgCVX swaps (coin0=CVX1, coin1=cvgCVX)
const CVX1_CVGCVX_POOL = "0xc50E191F703FB3160fC15d8b168A8c740fec3666" as `0x${string}`;

const CURVE_STABLESWAP_ABI = [
  {
    name: "get_dy",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "dx", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// cvgCVX has no direct USD oracle — derive it from CVX's Chainlink price via
// the CVX1/cvgCVX Curve pool mid-rate (CVX1 wraps CVX 1:1).
export function useCvgCvxPrice() {
  const { price: cvxPrice, isLoading: cvxLoading, error: cvxError } = useCvxPrice();

  const { data, isLoading, error } = useReadContract({
    address: CVX1_CVGCVX_POOL,
    abi: CURVE_STABLESWAP_ABI,
    functionName: "get_dy",
    args: [0n, 1n, parseUnits("1", 18)], // 1 CVX1 -> cvgCVX
    chainId: MAINNET_ID,
    query: {
      staleTime: 60 * 1000, // 1 minute
      refetchInterval: 60 * 1000, // Refetch every minute
      enabled: cvxPrice > 0,
    },
  });

  // cvgCVX per 1 CVX1 (~1 CVX)
  const cvgCvxPerCvx = data ? Number(formatUnits(data, 18)) : 0;
  const price = cvgCvxPerCvx > 0 ? cvxPrice / cvgCvxPerCvx : 0;

  return {
    price,
    isLoading: cvxLoading || isLoading,
    error: cvxError ?? error,
  };
}
