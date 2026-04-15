"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

// Historical TVL/PPS updates at most once per day. Cache aggressively so
// tab-switches and page revisits don't re-hit the proxy.
const HISTORY_CACHE = {
  staleTime: 10 * 60_000, // 10 minutes
  refetchInterval: false as const,
  refetchOnWindowFocus: false,
  gcTime: 60 * 60_000, // 1 hour
} as const;

// Route through Next.js GET proxy so Cloudflare can cache at the edge.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Strategies with no Yearn vault — not in Kong API
const KONG_EXCLUDED_VAULTS = new Set([
  "0xB246DB2A73EEE3ee026153660c74657C123f8E42".toLowerCase(), // yspxcvx
]);

interface TimeseriesPoint {
  value: number;
  time: string;
}

interface TimeseriesResponse {
  data: { timeseries: TimeseriesPoint[] };
}

async function fetchTimeseries(op: "tvl" | "pps", params: {
  chainId: number;
  address: string;
  limit: number;
}): Promise<TimeseriesPoint[]> {
  const qs = new URLSearchParams({
    chainId: String(params.chainId),
    address: params.address,
    limit: String(params.limit),
  });
  const response = await fetch(`/api/kong/${op}?${qs.toString()}`);

  if (!response.ok) throw new Error("Failed to fetch Kong timeseries");
  const result: TimeseriesResponse = await response.json();
  return result.data?.timeseries ?? [];
}

function isQueryable(address: string) {
  return !!address && address !== ZERO_ADDRESS && !KONG_EXCLUDED_VAULTS.has(address.toLowerCase());
}

export interface HistoryPoint {
  time: number; // unix seconds
  value: number;
}

// Kong occasionally returns multiple points with identical timestamps
// (eg multiple harvests/reports recorded in the same block). lightweight-charts
// requires strictly ascending time, so collapse duplicates keeping the last
// value for each timestamp.
function dedupeByTime(points: HistoryPoint[]): HistoryPoint[] {
  const byTime = new Map<number, number>();
  for (const p of points) byTime.set(p.time, p.value);
  return Array.from(byTime, ([time, value]) => ({ time, value })).sort(
    (a, b) => a.time - b.time,
  );
}

export function useVaultTvlHistory(address: string, chainId = 1, limit = 365) {
  const enabled = isQueryable(address);
  return useQuery({
    queryKey: ["yearn-history", "tvl", chainId, address, limit],
    queryFn: async (): Promise<HistoryPoint[]> => {
      const points = await fetchTimeseries("tvl", { chainId, address, limit });
      return dedupeByTime(points.map((p) => ({ time: Number(p.time), value: p.value })));
    },
    ...HISTORY_CACHE,
    enabled,
  });
}

export function useVaultPpsHistory(address: string, chainId = 1, limit = 395) {
  // Fetch extra 30 points so 30d APY can be derived at the oldest date
  const enabled = isQueryable(address);
  return useQuery({
    queryKey: ["yearn-history", "pps", chainId, address, limit],
    queryFn: async (): Promise<HistoryPoint[]> => {
      const points = await fetchTimeseries("pps", { chainId, address, limit });
      return dedupeByTime(points.map((p) => ({ time: Number(p.time), value: p.value })));
    },
    ...HISTORY_CACHE,
    enabled,
  });
}

export interface ApyPoint {
  time: number;
  apy: number | null; // annualized 30-day rolling APY, %
}

// Derive rolling 30d APY from PPS timeseries (zaplet's formula):
// annualized = (pps_now / pps_30d_ago - 1) * (365 / 30) * 100
export function useVault30dApyHistory(address: string, chainId = 1) {
  const ppsQuery = useVaultPpsHistory(address, chainId, 395);

  const data = useMemo<ApyPoint[] | undefined>(() => {
    if (!ppsQuery.data || ppsQuery.data.length < 2) return undefined;
    const pps = ppsQuery.data;
    const DAYS_AGO = 30;
    // PPS can jump sharply (harvest credit), producing absurd annualized
    // values. Clip anything outside this range — it's a calc artifact.
    const MAX_SANE_APY = 200;

    return pps.map((current) => {
      const targetTs = current.time - DAYS_AGO * 86400;
      let closest = pps[0];
      for (const p of pps) {
        if (p.time <= targetTs) closest = p;
        else break;
      }
      if (Math.abs(closest.time - targetTs) > 2 * 86400) return { time: current.time, apy: null };
      if (closest.value <= 0 || current.value <= 0) return { time: current.time, apy: null };
      const growth = current.value / closest.value - 1;
      const apy = growth * (365 / DAYS_AGO) * 100;
      if (!Number.isFinite(apy) || Math.abs(apy) > MAX_SANE_APY) return { time: current.time, apy: null };
      return { time: current.time, apy };
    });
  }, [ppsQuery.data]);

  return { data, isLoading: ppsQuery.isLoading, error: ppsQuery.error };
}
