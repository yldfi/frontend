import { describe, expect, it } from "vitest";

import {
  getYldMerklCampaignIds,
  splitMerklRewardsByCampaign,
  YLD_MERKL_OPPORTUNITY_IDENTIFIER,
  type MerklReward,
} from "@/hooks/useMerklRewards";

const YLD_CAMPAIGN = "0xb12032fde1bfb5ba7a853ed91ddfb164764b0eb3813cbfa25799af06efe117be";

function reward(overrides: Partial<MerklReward> = {}): MerklReward {
  return {
    root: "0xroot",
    distributionChainId: 1,
    amount: "130",
    claimed: "30",
    pending: "13",
    proofs: ["0xproof"],
    recipient: "0xrecipient",
    token: {
      chainId: 1,
      address: "0xtoken",
      decimals: 18,
      symbol: "TEST",
      price: 1,
    },
    breakdowns: [
      {
        root: "0xroot",
        distributionChainId: 1,
        reason: "yld",
        amount: "100",
        claimed: "20",
        pending: "10",
        campaignId: YLD_CAMPAIGN,
      },
      {
        root: "0xroot",
        distributionChainId: 1,
        reason: "other",
        amount: "30",
        claimed: "10",
        pending: "3",
        campaignId: "0xother",
      },
    ],
    ...overrides,
  };
}

describe("Merkl campaign classification", () => {
  it("includes fallback and dynamically discovered yld campaign IDs", () => {
    const ids = getYldMerklCampaignIds([
      {
        identifier: YLD_MERKL_OPPORTUNITY_IDENTIFIER,
        name: "Yld Borrow crvUSD",
        status: "LIVE",
        chainId: 1,
        type: "ENCOMPASSING",
        apr: 1,
        tvl: 1,
        campaigns: [{ campaignId: "0xFutureYldCampaign" }],
      },
    ]);

    expect(ids.has(YLD_CAMPAIGN)).toBe(true);
    expect(ids.has("0xfutureyldcampaign")).toBe(true);
  });

  it("splits a token reward into yld and non-yld campaign amounts", () => {
    const result = splitMerklRewardsByCampaign([reward()], new Set([YLD_CAMPAIGN]));

    expect(result.yldRewards).toHaveLength(1);
    expect(result.yldRewards[0]).toMatchObject({
      amount: "100",
      claimed: "20",
      pending: "10",
    });
    expect(result.otherRewards).toHaveLength(1);
    expect(result.otherRewards[0]).toMatchObject({
      amount: "30",
      claimed: "10",
      pending: "3",
    });
  });

  it("keeps unattributed token totals in other Merkl rewards", () => {
    const result = splitMerklRewardsByCampaign(
      [reward({ amount: "150", claimed: "35", pending: "20" })],
      new Set([YLD_CAMPAIGN]),
    );

    expect(result.otherRewards[0]).toMatchObject({
      amount: "50",
      claimed: "15",
      pending: "10",
    });
  });
});
