"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits } from "viem";
import { CACHE_TIMES } from "@/config/query";
import { aprToApy, curveBorrowRateToApr } from "@/lib/lending";

export interface MarketRates {
  policyAddress: `0x${string}`;
  currentBorrowApr: number;
  totalDebt: bigint;
  totalAssets: bigint;
  utilization: number; // 0-1
}

export interface CurveMarketStats {
  borrowApr: number;
  borrowApy: number;
  lendApy: number;
  utilization: number;
  totalSupplied: string;
  totalBorrowed: string;
  availableLiquidity: string;
  raw: MarketRates;
}

const rateAbi = [
  { name: "factory", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "monetary_policy", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "total_debt", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "rate", type: "function", stateMutability: "view", inputs: [{ name: "_for", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "totalAssets", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

function formatCrvUsd(value: bigint): string {
  const num = Number(formatUnits(value, 18));
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toFixed(2);
}

export function buildCurveMarketStats(marketRates: MarketRates): CurveMarketStats {
  const borrowApr = marketRates.currentBorrowApr;
  const available = marketRates.totalAssets - marketRates.totalDebt;
  return {
    borrowApr,
    borrowApy: aprToApy(borrowApr),
    lendApy: borrowApr * marketRates.utilization,
    utilization: marketRates.utilization,
    totalSupplied: formatCrvUsd(marketRates.totalAssets),
    totalBorrowed: formatCrvUsd(marketRates.totalDebt),
    availableLiquidity: formatCrvUsd(available > 0n ? available : 0n),
    raw: marketRates,
  };
}

export function useCurveMarketRates(controllerAddress?: `0x${string}`) {
  const publicClient = usePublicClient();

  const { data: marketRates } = useQuery({
    queryKey: ["curveMarketRates", controllerAddress],
    queryFn: async (): Promise<MarketRates> => {
      const pc = publicClient!;
      const addr = controllerAddress!;
      const [vaultAddr, policyAddr, totalDebt] = await Promise.all([
        pc.readContract({ address: addr, abi: rateAbi, functionName: "factory" }),
        pc.readContract({ address: addr, abi: rateAbi, functionName: "monetary_policy" }),
        pc.readContract({ address: addr, abi: rateAbi, functionName: "total_debt" }),
      ]);
      const [currentRateRaw, totalAssets] = await Promise.all([
        pc.readContract({ address: policyAddr, abi: rateAbi, functionName: "rate", args: [addr] }),
        pc.readContract({ address: vaultAddr, abi: rateAbi, functionName: "totalAssets" }),
      ]);
      const utilization = totalAssets > 0n ? Number(totalDebt) / Number(totalAssets) : 0;
      return {
        policyAddress: policyAddr,
        currentBorrowApr: curveBorrowRateToApr(currentRateRaw),
        totalDebt,
        totalAssets,
        utilization,
      };
    },
    enabled: !!publicClient && !!controllerAddress,
    ...CACHE_TIMES.SEMI_REALTIME,
  });

  return useMemo((): CurveMarketStats | null => {
    if (!marketRates) return null;
    return buildCurveMarketStats(marketRates);
  }, [marketRates]);
}
