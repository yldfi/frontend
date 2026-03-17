"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient, useBlockNumber } from "wagmi";
import { ERC4626_ABI } from "@/lib/abis";

const SECONDS_PER_DAY = 86400;
const ETH_BLOCK_TIME = 12; // seconds
const BLOCKS_PER_DAY = Math.floor(SECONDS_PER_DAY / ETH_BLOCK_TIME);
const ASSET_UNIT = BigInt(10 ** 18); // 1e18 shares

/**
 * Calculate vault APY on-chain using convertToAssets at current vs 24h-ago block.
 * Formula: ((priceNow / priceYesterday) ** 365 - 1) * 100
 * Matches DefiLlama's getERC4626Info methodology.
 */
export function useOnChainAPY(vaultAddress: `0x${string}`) {
  const publicClient = usePublicClient();
  const { data: currentBlock } = useBlockNumber({ watch: false });

  return useQuery({
    queryKey: ["onchain-apy", vaultAddress, currentBlock ? Number(currentBlock) : 0],
    queryFn: async () => {
      if (!publicClient || !currentBlock) return null;

      const blockYesterday = currentBlock - BigInt(BLOCKS_PER_DAY);

      const [priceNow, priceYesterday] = await Promise.all([
        publicClient.readContract({
          address: vaultAddress,
          abi: ERC4626_ABI,
          functionName: "convertToAssets",
          args: [ASSET_UNIT],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: vaultAddress,
          abi: ERC4626_ABI,
          functionName: "convertToAssets",
          args: [ASSET_UNIT],
          blockNumber: blockYesterday,
        }) as Promise<bigint>,
      ]);

      if (!priceYesterday || priceYesterday === 0n) return null;

      const ratio = Number(priceNow) / Number(priceYesterday);
      const apy = (ratio ** 365 - 1) * 100;

      return apy;
    },
    enabled: !!publicClient && !!currentBlock,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval: 5 * 60 * 1000,
  });
}
