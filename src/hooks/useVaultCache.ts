import { useQuery } from "@tanstack/react-query";

const CACHE_API_URL = "/api/vaults";

interface VaultCacheData {
  address: string;
  totalAssets: string;
  pricePerShare: string;
  tvl: number;
  pps: number;
  tvlUsd: number;
}

interface CacheResponse {
  ycvxcrv: VaultCacheData;
  yscvxcrv: VaultCacheData;
  yscvgcvx: VaultCacheData;
  yspxcvx: VaultCacheData;
  cvxCrvPrice: number;
  cvgCvxPrice: number;
  pxCvxPrice: number;
  lastUpdated: string;
}

export function useVaultCache() {
  return useQuery<CacheResponse>({
    queryKey: ["vault-cache"],
    queryFn: async () => {
      const response = await fetch(CACHE_API_URL);
      if (!response.ok) throw new Error("Failed to fetch vault cache");
      return response.json();
    },
    staleTime: 60 * 1000, // 1 minute
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval: 60 * 1000, // Refetch every minute
  });
}
