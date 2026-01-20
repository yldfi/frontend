"use client";

import { useQuery } from "@tanstack/react-query";
import { createPublicClient, http, fallback } from "viem";
import { mainnet } from "viem/chains";
import { getContractSource } from "@/lib/explorer/etherscan";
import { parseStrategySource, generateFlowSteps } from "@/lib/strategy-flow/parser";
import type { StrategyFlow, ParsedStrategy } from "@/lib/strategy-flow/types";
import { RPC_URL_LIST } from "@/config/rpc";

// Permissionless keeper address
const PERMISSIONLESS_KEEPER = "0x52605BbF54845f520a3E94792d019f62407db2f8";

// ABI for reading keeper and auction from TokenizedStrategy
const STRATEGY_ABI = [
  {
    inputs: [],
    name: "keeper",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "auction",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface UseStrategyFlowResult {
  flow: StrategyFlow | null;
  parsed: ParsedStrategy | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Hook to fetch contract source and parse strategy flow
 */
export function useStrategyFlow(
  address: string | undefined,
  chainId: number = 1
): UseStrategyFlowResult {
  const query = useQuery({
    queryKey: ["strategyFlow", chainId, address],
    queryFn: async () => {
      if (!address) throw new Error("No address provided");

      // Create public client for on-chain reads
      const publicClient = createPublicClient({
        chain: mainnet,
        transport: fallback(RPC_URL_LIST.map((url) => http(url))),
      });

      // Fetch contract source from our API (uses Etherscan v2 + KV cache)
      const source = await getContractSource(address, chainId);

      if (!source.source) {
        throw new Error("Contract source not available");
      }

      // Parse the source code
      const parsed = parseStrategySource(
        source.source,
        address,
        source.name,
        source.compiler
      );

      if (!parsed.success || !parsed.config) {
        throw new Error(parsed.errors.join(", ") || "Failed to parse strategy");
      }

      // Read keeper and auction addresses from chain
      try {
        const [keeperAddress, auctionAddress] = await Promise.all([
          publicClient.readContract({
            address: address as `0x${string}`,
            abi: STRATEGY_ABI,
            functionName: "keeper",
          }).catch(() => null),
          publicClient.readContract({
            address: address as `0x${string}`,
            abi: STRATEGY_ABI,
            functionName: "auction",
          }).catch(() => null),
        ]);

        // Update config with on-chain data
        if (keeperAddress) {
          parsed.config.keeper = {
            address: keeperAddress,
            isPermissionless: keeperAddress.toLowerCase() === PERMISSIONLESS_KEEPER.toLowerCase(),
          };
        }

        // Update auction address if we got one from chain
        if (auctionAddress && auctionAddress !== "0x0000000000000000000000000000000000000000") {
          if (parsed.config.compounding.auction) {
            parsed.config.compounding.auction.address = auctionAddress;
          } else if (parsed.config.compounding.mechanism === "auction") {
            parsed.config.compounding.auction = {
              address: auctionAddress,
              enabled: true,
            };
          }
        }
      } catch {
        // On-chain read failed, continue with parsed data
      }

      // Generate flow steps
      const flow = generateFlowSteps(parsed.config);

      return { parsed, flow };
    },
    enabled: !!address,
    staleTime: Infinity, // Contract source never changes
    gcTime: Infinity,
  });

  return {
    flow: query.data?.flow ?? null,
    parsed: query.data?.parsed ?? null,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

/**
 * Parse strategy flow from raw source code (for direct use without fetching)
 */
export function parseStrategyFlow(
  source: string,
  address: string,
  name?: string,
  compiler?: string
): { flow: StrategyFlow | null; parsed: ParsedStrategy } {
  const parsed = parseStrategySource(source, address, name || null, compiler || null);

  if (!parsed.success || !parsed.config) {
    return { flow: null, parsed };
  }

  const flow = generateFlowSteps(parsed.config);
  return { flow, parsed };
}
