import type { PublicClient } from "viem";

import { CHAINLINK_ETH_USD } from "@/config/addresses";

const CHAINLINK_LATEST_ROUND_DATA_ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** Latest ETH/USD answer from Chainlink, scaled to whole dollars per ETH. */
export async function readEthUsdPrice(client: PublicClient): Promise<number> {
  const [, answer] = await client.readContract({
    address: CHAINLINK_ETH_USD,
    abi: CHAINLINK_LATEST_ROUND_DATA_ABI,
    functionName: "latestRoundData",
  });
  return Number(answer) / 1e8;
}
