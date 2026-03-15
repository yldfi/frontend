"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";

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
  const res = await fetch(
    `https://api.merkl.xyz/v4/users/${address}/rewards?chainId=${chainId}`
  );
  if (!res.ok) throw new Error(`Merkl API error: ${res.status}`);
  return res.json();
}

export interface MerklOpportunity {
  identifier: string;
  name: string;
  status: string;
  chainId: number;
  type: string;
}

async function fetchMerklOpportunities(): Promise<MerklOpportunity[]> {
  const res = await fetch("https://api.merkl.xyz/v4/opportunities?chainId=1&type=ENCOMPASSING");
  if (!res.ok) throw new Error(`Merkl API error: ${res.status}`);
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
  return `https://app.merkl.xyz/opportunities/ethereum/${opportunity.type}/${opportunity.identifier}`;
}
