"use client";

import { useQuery } from "@tanstack/react-query";
import { CACHE_TIMES } from "@/config/query";

const R2_BASE = "https://data.yldfi.co";

interface R2PricePoint {
  t: number; // unix seconds
  v: number; // price value
}

interface R2PriceHistoryResponse {
  version: number;
  generatedAt: string;
  cvxcrv: R2PricePoint[];
  ycvxcrv: R2PricePoint[];
  pricePerShare: R2PricePoint[];
}

export interface PricePoint {
  time: number;
  value: number;
}

export interface R2PriceHistory {
  ycvxcrvData: PricePoint[];
  cvxcrvData: PricePoint[];
  pricePerShareData: PricePoint[];
}

function expandPoints(raw: R2PricePoint[]): PricePoint[] {
  return raw.map((p) => ({ time: p.t, value: p.v }));
}

export function useR2PriceHistory() {
  return useQuery<R2PriceHistory | null>({
    queryKey: ["r2PriceHistory"],
    queryFn: async () => {
      const res = await fetch(
        `${R2_BASE}/prices/ycvxcrv/price-history.json`,
      );
      if (!res.ok) return null;

      const json: R2PriceHistoryResponse = await res.json();
      return {
        ycvxcrvData: expandPoints(json.ycvxcrv),
        cvxcrvData: expandPoints(json.cvxcrv),
        pricePerShareData: expandPoints(json.pricePerShare),
      };
    },
    ...CACHE_TIMES.STATIC,
  });
}
