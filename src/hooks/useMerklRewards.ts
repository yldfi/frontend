"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContracts } from "wagmi";

// Merkl Distributor — authoritative on-chain source for claimed amounts.
const MERKL_DISTRIBUTOR = "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae" as const;
const MERKL_DISTRIBUTOR_CLAIMED_ABI = [
  {
    name: "claimed",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint208" },
      { name: "timestamp", type: "uint40" },
      { name: "merkleRoot", type: "bytes32" },
    ],
  },
] as const;

// Merkl API calls are proxied through our Next.js server (see
// src/app/api/merkl/[...path]/route.ts) because Merkl's Cloudflare edge
// blocks many VPN / datacenter exit IPs directly from the browser.
const MERKL_API = "/api/merkl";
const MERKL_APP_FALLBACK = "https://app.merkl.fr";

async function merklFetch(path: string): Promise<Response> {
  const res = await fetch(`${MERKL_API}${path}`);
  if (!res.ok) throw new Error(`Merkl API error: ${res.status}`);
  return res;
}

function getMerklAppBaseUrl(): string {
  // app.merkl.xyz has DNS issues — prefer .fr for now
  return MERKL_APP_FALLBACK;
}

export interface MerklToken {
  chainId: number;
  address: string;
  decimals: number;
  symbol: string;
  price: number;
}

export interface MerklBreakdown {
  root: string;
  distributionChainId: number;
  reason: string;
  amount: string;
  claimed: string;
  pending: string;
  campaignId: string;
}

export interface MerklReward {
  root: string;
  distributionChainId: number;
  amount: string;
  claimed: string;
  pending: string;
  proofs: string[];
  recipient: string;
  token: MerklToken;
  breakdowns: MerklBreakdown[];
}

export interface MerklRewardsResponse {
  chain: {
    endOfDisputePeriod: number;
    explorers: { chainId: number; id: string; type: string; url: string }[];
    icon: string;
    id: number;
    liveCampaigns: number;
    name: string;
  };
  rewards: MerklReward[];
}

async function fetchMerklRewards(address: string, chainId: number): Promise<MerklRewardsResponse[]> {
  const res = await merklFetch(`/v4/users/${address}/rewards?chainId=${chainId}`);
  return res.json();
}

export interface MerklOpportunity {
  identifier: string;
  name: string;
  status: string;
  chainId: number;
  type: string;
  apr: number;
  tvl: number;
}

async function fetchMerklOpportunities(): Promise<MerklOpportunity[]> {
  const res = await merklFetch("/v4/opportunities?chainId=1&type=ENCOMPASSING");
  return res.json();
}

export function useMerklRewards(chainId = 1) {
  const { address } = useAccount();

  const query = useQuery({
    queryKey: ["merkl-rewards", address, chainId],
    queryFn: () => fetchMerklRewards(address!, chainId),
    enabled: !!address,
    staleTime: 2 * 60 * 1000, // 2 min
    refetchInterval: 5 * 60 * 1000, // 5 min
  });

  // Collect unique (chainId, token) pairs across all rewards so we can query
  // the distributor's claimed mapping on-chain. Merkl's off-chain indexer can
  // lag the actual claim state by hours; using the chain data prevents the
  // "already claimed" badge from lingering.
  const tokenPairs = useMemo(() => {
    const seen = new Map<string, { chainId: number; token: `0x${string}` }>();
    for (const chunk of query.data ?? []) {
      for (const r of chunk.rewards) {
        const key = `${r.token.chainId}:${r.token.address.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.set(key, { chainId: r.token.chainId, token: r.token.address as `0x${string}` });
        }
      }
    }
    return Array.from(seen.values());
  }, [query.data]);

  const { data: onChainClaimed } = useReadContracts({
    contracts: address
      ? tokenPairs.map((t) => ({
          address: MERKL_DISTRIBUTOR,
          abi: MERKL_DISTRIBUTOR_CLAIMED_ABI,
          functionName: "claimed" as const,
          args: [address, t.token] as const,
          chainId: t.chainId,
        }))
      : [],
    query: {
      enabled: !!address && tokenPairs.length > 0,
      staleTime: 30 * 1000,
      refetchInterval: 60 * 1000,
    },
  });

  // Build a (chainId:token) → on-chain claimed amount map. Viem v2 returns
  // multi-named outputs as a tuple, but we accept objects too in case that
  // changes.
  const onChainClaimedMap = useMemo(() => {
    const map = new Map<string, bigint>();
    tokenPairs.forEach((t, i) => {
      const raw = onChainClaimed?.[i]?.result as
        | readonly [bigint, number, `0x${string}`]
        | { amount?: bigint }
        | undefined;
      let amount: bigint | undefined;
      if (raw) {
        if (Array.isArray(raw)) amount = raw[0] as bigint;
        else amount = (raw as { amount?: bigint }).amount;
      }
      if (amount !== undefined) {
        map.set(`${t.chainId}:${t.token.toLowerCase()}`, amount);
      }
    });
    return map;
  }, [onChainClaimed, tokenPairs]);

  // Override each reward's `claimed` with max(apiClaimed, onChainClaimed).
  const mergedData = useMemo(() => {
    if (!query.data) return query.data;
    if (onChainClaimedMap.size === 0) return query.data;
    return query.data.map((chunk) => ({
      ...chunk,
      rewards: chunk.rewards.map((r) => {
        const key = `${r.token.chainId}:${r.token.address.toLowerCase()}`;
        const onChain = onChainClaimedMap.get(key);
        if (onChain === undefined) return r;
        const apiClaimed = BigInt(r.claimed);
        return onChain > apiClaimed ? { ...r, claimed: onChain.toString() } : r;
      }),
    }));
  }, [query.data, onChainClaimedMap]);

  return { ...query, data: mergedData };
}

export function useMerklOpportunities() {
  return useQuery({
    queryKey: ["merkl-opportunities"],
    queryFn: fetchMerklOpportunities,
    staleTime: 10 * 60 * 1000, // 10 min
  });
}

export function getMerklOpportunityUrl(opportunity: MerklOpportunity) {
  return `${getMerklAppBaseUrl()}/opportunities/ethereum/${opportunity.type}/${opportunity.identifier}`;
}
