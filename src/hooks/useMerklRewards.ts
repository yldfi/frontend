"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";

const MERKL_API_PRIMARY = "https://api.merkl.xyz";
const MERKL_API_FALLBACK = "https://api.merkl.fr";
const MERKL_APP_PRIMARY = "https://app.merkl.xyz";
const MERKL_APP_FALLBACK = "https://app.merkl.fr";

async function merklFetch(path: string): Promise<Response> {
  try {
    const res = await fetch(`${MERKL_API_PRIMARY}${path}`);
    if (res.ok) return res;
  } catch {
    // primary unreachable, try fallback
  }
  const res = await fetch(`${MERKL_API_FALLBACK}${path}`);
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

  return useQuery({
    queryKey: ["merkl-rewards", address, chainId],
    queryFn: () => fetchMerklRewards(address!, chainId),
    enabled: !!address,
    staleTime: 2 * 60 * 1000, // 2 min
    refetchInterval: 5 * 60 * 1000, // 5 min
  });
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
