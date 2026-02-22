"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits } from "viem";
import { CACHE_TIMES } from "@/config/query";

const CURVE_PRICES_API = "https://prices.curve.finance";

interface SnapshotDataPoint {
  timestamp: string;
  price_oracle: number;
  base_price: number;
  amm_price: number;
}

export interface OraclePricePoint {
  time: number; // unix seconds
  value: number; // oracle price (collateral in crvUSD terms)
}

export interface OraclePriceHistory {
  data: OraclePricePoint[];
  currentOraclePrice: number | null;
}

const CONTROLLER_ABI = [
  {
    name: "amm",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const AMM_ABI = [
  {
    name: "price_oracle",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "get_base_price",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "active_band",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int256" }],
  },
  {
    name: "min_band",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int256" }],
  },
  {
    name: "max_band",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int256" }],
  },
  {
    name: "bands_x",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "n", type: "int256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "bands_y",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "n", type: "int256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "p_oracle_up",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "n", type: "int256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "p_oracle_down",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "n", type: "int256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "A",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export { AMM_ABI };

async function fetchSnapshotHistory(
  controllerAddress: string,
): Promise<OraclePricePoint[]> {
  // Fetch up to 100 daily snapshots (max allowed)
  const url = `${CURVE_PRICES_API}/v1/lending/markets/ethereum/${controllerAddress}/snapshots?agg=day&limit=100`;
  const response = await fetch(url);
  if (!response.ok) return [];

  const json: { data?: SnapshotDataPoint[] } = await response.json();
  const data: SnapshotDataPoint[] = json.data ?? [];

  // Convert to chart-friendly format, reverse for chronological order
  return data
    .map((d) => ({
      time: Math.floor(new Date(d.timestamp).getTime() / 1000),
      value: d.price_oracle,
    }))
    .reverse();
}

export function useOraclePriceHistory(
  controllerAddress: `0x${string}` | undefined,
) {
  const publicClient = usePublicClient();

  return useQuery<OraclePriceHistory>({
    queryKey: ["oraclePriceHistory", controllerAddress],
    queryFn: async () => {
      if (!controllerAddress || !publicClient) {
        return { data: [], currentOraclePrice: null };
      }

      // Fetch historical data from API and current price from RPC in parallel
      const ammAddress = await publicClient.readContract({
        address: controllerAddress,
        abi: CONTROLLER_ABI,
        functionName: "amm",
      });

      const [history, currentPrice] = await Promise.all([
        fetchSnapshotHistory(controllerAddress),
        publicClient
          .readContract({
            address: ammAddress as `0x${string}`,
            abi: AMM_ABI,
            functionName: "price_oracle",
          })
          .then((p) => Number(formatUnits(p as bigint, 18)))
          .catch(() => null),
      ]);

      return {
        data: history,
        currentOraclePrice: currentPrice,
      };
    },
    enabled: !!controllerAddress && !!publicClient,
    ...CACHE_TIMES.SEMI_REALTIME,
  });
}

// Band data for the bands sidebar visualization
export interface BandData {
  n: number;
  pUp: number; // upper price boundary
  pDown: number; // lower price boundary
  collateral: bigint; // bands_x - collateral amount
  stablecoin: bigint; // bands_y - crvUSD amount
  collateralUsd: number; // approximate USD value
}

export interface MarketBandsData {
  bands: BandData[];
  activeBand: number;
  oraclePrice: number;
  A: number;
}

export function useMarketBands(
  controllerAddress: `0x${string}` | undefined,
) {
  const publicClient = usePublicClient();

  return useQuery<MarketBandsData | null>({
    queryKey: ["marketBands", controllerAddress],
    queryFn: async () => {
      if (!controllerAddress || !publicClient) return null;

      const ammAddress = (await publicClient.readContract({
        address: controllerAddress,
        abi: CONTROLLER_ABI,
        functionName: "amm",
      })) as `0x${string}`;

      // Fetch basic AMM info
      const [activeBandRaw, minBandRaw, maxBandRaw, oraclePriceRaw, aRaw] =
        await Promise.all([
          publicClient.readContract({
            address: ammAddress,
            abi: AMM_ABI,
            functionName: "active_band",
          }),
          publicClient.readContract({
            address: ammAddress,
            abi: AMM_ABI,
            functionName: "min_band",
          }),
          publicClient.readContract({
            address: ammAddress,
            abi: AMM_ABI,
            functionName: "max_band",
          }),
          publicClient.readContract({
            address: ammAddress,
            abi: AMM_ABI,
            functionName: "price_oracle",
          }),
          publicClient.readContract({
            address: ammAddress,
            abi: AMM_ABI,
            functionName: "A",
          }),
        ]);

      const activeBand = Number(activeBandRaw);
      const minBand = Number(minBandRaw);
      const maxBand = Number(maxBandRaw);
      const oraclePrice = Number(formatUnits(oraclePriceRaw as bigint, 18));
      const A = Number(aRaw);

      // Limit band range to avoid excessive RPC calls
      const bandCount = maxBand - minBand + 1;
      if (bandCount <= 0 || bandCount > 200) return null;

      // Fetch band balances and prices via multicall
      const calls: {
        address: `0x${string}`;
        abi: typeof AMM_ABI;
        functionName: string;
        args: [bigint];
      }[] = [];

      for (let n = minBand; n <= maxBand; n++) {
        calls.push(
          {
            address: ammAddress,
            abi: AMM_ABI,
            functionName: "bands_x",
            args: [BigInt(n)],
          },
          {
            address: ammAddress,
            abi: AMM_ABI,
            functionName: "bands_y",
            args: [BigInt(n)],
          },
          {
            address: ammAddress,
            abi: AMM_ABI,
            functionName: "p_oracle_up",
            args: [BigInt(n)],
          },
          {
            address: ammAddress,
            abi: AMM_ABI,
            functionName: "p_oracle_down",
            args: [BigInt(n)],
          },
        );
      }

      const results = await publicClient.multicall({
        contracts: calls as Parameters<typeof publicClient.multicall>[0]["contracts"],
      });

      const bands: BandData[] = [];
      for (let i = 0; i < bandCount; i++) {
        const n = minBand + i;
        const baseIdx = i * 4;
        const collateral = (results[baseIdx]?.result as bigint) ?? 0n;
        const stablecoin = (results[baseIdx + 1]?.result as bigint) ?? 0n;
        const pUp = Number(
          formatUnits((results[baseIdx + 2]?.result as bigint) ?? 0n, 18),
        );
        const pDown = Number(
          formatUnits((results[baseIdx + 3]?.result as bigint) ?? 0n, 18),
        );

        // Skip empty bands
        if (collateral === 0n && stablecoin === 0n) continue;

        // Approximate USD value using geometric mean price
        const midPrice = Math.sqrt(pUp * pDown);
        const collateralNum = Number(formatUnits(collateral, 18));
        const stablecoinNum = Number(formatUnits(stablecoin, 18));
        const collateralUsd = collateralNum * midPrice + stablecoinNum;

        bands.push({
          n,
          pUp,
          pDown,
          collateral,
          stablecoin,
          collateralUsd,
        });
      }

      return { bands, activeBand, oraclePrice, A };
    },
    enabled: !!controllerAddress && !!publicClient,
    ...CACHE_TIMES.SEMI_REALTIME,
  });
}
