"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits } from "viem";
import { CACHE_TIMES } from "@/config/query";

export interface MarketRates {
  minRate: number; // APR %
  maxRate: number; // APR %
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

const SECONDS_PER_YEAR = 365.25 * 86400;

const rateAbi = [
  { name: "factory", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "monetary_policy", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "total_debt", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "min_rate", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "max_rate", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "totalAssets", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

// Semilog interest rate model: rate = minRate * (maxRate / minRate) ^ utilization
function semilogBorrowAPR(utilization: number, minRate: number, maxRate: number): number {
  if (minRate <= 0 || maxRate <= 0 || utilization < 0) return 0;
  const util = Math.min(utilization, 1);
  return minRate * Math.pow(maxRate / minRate, util);
}

function formatCrvUsd(value: bigint): string {
  const num = Number(formatUnits(value, 18));
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toFixed(2);
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
      const [minRateRaw, maxRateRaw, totalAssets] = await Promise.all([
        pc.readContract({ address: policyAddr, abi: rateAbi, functionName: "min_rate" }),
        pc.readContract({ address: policyAddr, abi: rateAbi, functionName: "max_rate" }),
        pc.readContract({ address: vaultAddr, abi: rateAbi, functionName: "totalAssets" }),
      ]);
      const minRate = Number(minRateRaw) * SECONDS_PER_YEAR / 1e18 * 100;
      const maxRate = Number(maxRateRaw) * SECONDS_PER_YEAR / 1e18 * 100;
      const utilization = totalAssets > 0n ? Number(totalDebt) / Number(totalAssets) : 0;
      return { minRate, maxRate, totalDebt, totalAssets, utilization };
    },
    enabled: !!publicClient && !!controllerAddress,
    ...CACHE_TIMES.SEMI_REALTIME,
  });

  return useMemo((): CurveMarketStats | null => {
    if (!marketRates) return null;
    const borrowApr = semilogBorrowAPR(marketRates.utilization, marketRates.minRate, marketRates.maxRate);
    const borrowApy = (Math.exp(borrowApr / 100) - 1) * 100;
    const lendApy = borrowApr * marketRates.utilization;
    const available = marketRates.totalAssets - marketRates.totalDebt;
    return {
      borrowApr,
      borrowApy,
      lendApy,
      utilization: marketRates.utilization,
      totalSupplied: formatCrvUsd(marketRates.totalAssets),
      totalBorrowed: formatCrvUsd(marketRates.totalDebt),
      availableLiquidity: formatCrvUsd(available > 0n ? available : 0n),
      raw: marketRates,
    };
  }, [marketRates]);
}
