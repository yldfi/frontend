"use client";

import { useReadContracts } from "wagmi";
import { formatUnits } from "viem";

// LlamaLend price oracle for cvxCRV/crvUSD
// Returns cvxCRV price in crvUSD (18 decimals)
const CVXCRV_CRVUSD_ORACLE = "0xD7063E7e5EbF99b55c56F231f374F97C8578653a" as `0x${string}`;

// Chainlink crvUSD/USD price feed
// Returns crvUSD price in USD (8 decimals)
const CRVUSD_USD_CHAINLINK = "0xEEf0C605546958c1f899b6fB336C20671f9cD49F" as `0x${string}`;

const LLAMALEND_ORACLE_ABI = [
  {
    name: "price",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const CHAINLINK_ABI = [
  {
    name: "latestAnswer",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int256" }],
  },
] as const;

export function useCvxCrvPrice() {
  const { data, isLoading, error } = useReadContracts({
    contracts: [
      {
        address: CVXCRV_CRVUSD_ORACLE,
        abi: LLAMALEND_ORACLE_ABI,
        functionName: "price",
      },
      {
        address: CRVUSD_USD_CHAINLINK,
        abi: CHAINLINK_ABI,
        functionName: "latestAnswer",
      },
    ],
    query: {
      staleTime: 60 * 1000, // 1 minute
      refetchInterval: 60 * 1000, // Refetch every minute
    },
  });

  // cvxCRV/crvUSD price (18 decimals)
  const cvxCrvInCrvUsd = data?.[0]?.result
    ? Number(formatUnits(data[0].result as bigint, 18))
    : 0;

  // crvUSD/USD price (8 decimals from Chainlink)
  const crvUsdInUsd = data?.[1]?.result
    ? Number(formatUnits(data[1].result as bigint, 8))
    : 0;

  // cvxCRV price in USD = cvxCRV/crvUSD × crvUSD/USD
  const price = cvxCrvInCrvUsd * crvUsdInUsd;

  return {
    price,
    cvxCrvInCrvUsd,
    crvUsdInUsd,
    isLoading,
    error,
  };
}
