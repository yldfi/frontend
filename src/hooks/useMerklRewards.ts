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

// Mock: crvUSD rewards from borrowing against ycvxCRV
// Real campaign: debt-proportional rewards scaled by ycvxcrr_ratio (soft-liq scaling)
const MOCK_DATA: MerklRewardsResponse[] = [
  {
    chain: {
      endOfDisputePeriod: 0,
      explorers: [{ chainId: 1, id: "etherscan", type: "etherscan", url: "https://etherscan.io" }],
      icon: "",
      id: 1,
      liveCampaigns: 1,
      name: "Ethereum",
    },
    rewards: [
      {
        root: "0x0000000000000000000000000000000000000000000000000000000000000000",
        distributionChainId: 1,
        amount: "47500000000000000000", // 47.5 crvUSD earned
        claimed: "12000000000000000000", // 12 crvUSD claimed
        pending: "3200000000000000000", // 3.2 crvUSD pending
        proofs: [],
        recipient: "0x0000000000000000000000000000000000000000",
        token: {
          chainId: 1,
          address: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
          decimals: 18,
          symbol: "crvUSD",
          price: 1.0,
        },
        breakdowns: [
          {
            root: "0x0",
            distributionChainId: 1,
            reason: "Borrow against ycvxCRV — debt-proportional rewards",
            amount: "47500000000000000000",
            claimed: "12000000000000000000",
            pending: "3200000000000000000",
            campaignId: "0xmock1",
          },
        ],
      },
    ],
  },
];

const USE_MOCK = process.env.NODE_ENV === "development";

async function fetchMerklRewards(address: string, chainId: number): Promise<MerklRewardsResponse[]> {
  if (USE_MOCK) return MOCK_DATA;
  const res = await fetch(
    `https://api.merkl.xyz/v4/users/${address}/rewards?chainId=${chainId}`
  );
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
