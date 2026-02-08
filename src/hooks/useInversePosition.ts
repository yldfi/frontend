"use client";

import { useReadContracts, useReadContract } from "wagmi";

// Inverse Finance FiRM cvxCRV market
export const INVERSE_MARKET = "0x3474ad0e3a9775c9f68b415a7a9880b0cab9397a" as const;
export const DOLA_ADDRESS = "0x865377367054516e17014CcdED1e7d814EDC9ce4" as const;
export const INVERSE_CVXCRV = "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7" as const;

export interface InversePosition {
  hasPosition: boolean;
  debt: bigint;
  collateralValue: bigint;
  creditLimit: bigint;
  withdrawalLimit: bigint;
  escrowAddress: string;
  collateralBalance: bigint;
  healthFactor: number;
}

// ABI fragments for Inverse FiRM market contract
const MARKET_ABI = [
  {
    name: "debts",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getCollateralValue",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getCreditLimit",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getWithdrawalLimit",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "escrows",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

// Standard ERC20 balanceOf ABI fragment
const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Reads a user's Inverse Finance FiRM cvxCRV market position.
 * Uses multicall for the market contract reads, then a dependent
 * read for the cvxCRV balance held in the user's escrow.
 */
export function useInversePosition(
  userAddress: string | undefined
): InversePosition | null {
  const typedUser = userAddress as `0x${string}` | undefined;

  // Step 1: Multicall for market contract reads
  const { data: marketData } = useReadContracts({
    contracts: [
      {
        address: INVERSE_MARKET,
        abi: MARKET_ABI,
        functionName: "debts",
        args: typedUser ? [typedUser] : undefined,
      },
      {
        address: INVERSE_MARKET,
        abi: MARKET_ABI,
        functionName: "getCollateralValue",
        args: typedUser ? [typedUser] : undefined,
      },
      {
        address: INVERSE_MARKET,
        abi: MARKET_ABI,
        functionName: "getCreditLimit",
        args: typedUser ? [typedUser] : undefined,
      },
      {
        address: INVERSE_MARKET,
        abi: MARKET_ABI,
        functionName: "getWithdrawalLimit",
        args: typedUser ? [typedUser] : undefined,
      },
      {
        address: INVERSE_MARKET,
        abi: MARKET_ABI,
        functionName: "escrows",
        args: typedUser ? [typedUser] : undefined,
      },
    ],
    query: {
      refetchInterval: 30_000,
      enabled: !!userAddress,
    },
  });

  const escrowAddress = marketData?.[4]?.result as `0x${string}` | undefined;

  // Step 2: Dependent read for cvxCRV balance in the user's escrow
  const { data: collateralBalance } = useReadContract({
    address: INVERSE_CVXCRV,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: escrowAddress ? [escrowAddress] : undefined,
    query: {
      refetchInterval: 30_000,
      enabled: !!userAddress && !!escrowAddress,
    },
  });

  // Return null when not connected or data not loaded
  if (!userAddress || !marketData) {
    return null;
  }

  const debt = (marketData[0]?.result as bigint) ?? 0n;
  const collateralValue = (marketData[1]?.result as bigint) ?? 0n;
  const creditLimit = (marketData[2]?.result as bigint) ?? 0n;
  const withdrawalLimit = (marketData[3]?.result as bigint) ?? 0n;
  const escrow = (marketData[4]?.result as string) ?? "";
  const balance = (collateralBalance as bigint) ?? 0n;

  const healthFactor = debt > 0n ? Number(creditLimit) / Number(debt) : 0;

  return {
    hasPosition: debt > 0n,
    debt,
    collateralValue,
    creditLimit,
    withdrawalLimit,
    escrowAddress: escrow,
    collateralBalance: balance,
    healthFactor,
  };
}
