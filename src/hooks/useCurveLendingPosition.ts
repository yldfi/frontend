"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { CURVE_CONTROLLERS } from "@/config/vaults";
import { CACHE_TIMES } from "@/config/query";

// ABI for Curve LlamaLend Controller read functions
const CONTROLLER_ABI = [
  {
    name: "user_state",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256[4]" }],
  },
  {
    name: "health",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "full", type: "bool" },
    ],
    outputs: [{ name: "", type: "int256" }],
  },
  {
    name: "user_prices",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256[2]" }],
  },
  {
    name: "loan_exists",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "debt",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "max_borrowable",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "collateral", type: "uint256" },
      { name: "N", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "min_collateral",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "debt", type: "uint256" },
      { name: "N", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "calculate_debt_n1",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "collateral", type: "uint256" },
      { name: "debt", type: "uint256" },
      { name: "N", type: "uint256" },
    ],
    outputs: [{ name: "", type: "int256" }],
  },
] as const;

export interface LendingPosition {
  // Raw values from user_state
  collateral: bigint; // user_state[0] - collateral in vault
  stablecoin: bigint; // user_state[1] - crvUSD in AMM (during soft-liquidation)
  debt: bigint; // user_state[2] - total debt
  n1: number; // user_state[3] upper 128 bits - upper band
  n2: number; // user_state[3] lower 128 bits - lower band

  // Health metrics
  health: number; // health(user, false) - percentage (0-100+)
  healthFull: number; // health(user, true) - with price bands

  // Liquidation prices
  liquidationPriceUpper: bigint; // user_prices[0] - upper band price
  liquidationPriceLower: bigint; // user_prices[1] - lower band price

  // Status
  hasLoan: boolean;
  inSoftLiquidation: boolean; // stablecoin > 0 means in soft-liquidation
}

export interface UseCurveLendingPositionResult {
  position: LendingPosition | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useCurveLendingPosition(
  vaultAddress: `0x${string}` | undefined,
  userAddress: `0x${string}` | undefined
): UseCurveLendingPositionResult {
  const publicClient = usePublicClient();

  const controllerAddress = vaultAddress
    ? (CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS] as `0x${string}` | undefined)
    : undefined;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["curveLendingPosition", controllerAddress, userAddress],
    queryFn: async (): Promise<LendingPosition | null> => {
      if (!publicClient || !controllerAddress || !userAddress) {
        return null;
      }

      // Check if loan exists first
      const loanExists = await publicClient.readContract({
        address: controllerAddress,
        abi: CONTROLLER_ABI,
        functionName: "loan_exists",
        args: [userAddress],
      });

      if (!loanExists) {
        return null;
      }

      // Fetch all position data in parallel
      const [userState, health, healthFull, userPrices, debt] = await Promise.all([
        publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "user_state",
          args: [userAddress],
        }),
        publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "health",
          args: [userAddress, false],
        }),
        publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "health",
          args: [userAddress, true],
        }),
        publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "user_prices",
          args: [userAddress],
        }),
        publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "debt",
          args: [userAddress],
        }),
      ]);

      // Parse n1 and n2 from user_state[3] (packed as int256)
      // n1 is upper 128 bits, n2 is lower 128 bits
      const n1n2 = userState[3];
      const n2 = Number(n1n2 & BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"));
      const n1 = Number(n1n2 >> BigInt(128));

      // Health is returned as int256 with 1e18 precision where 1e16 = 1%
      // So we divide by 1e16 to get percentage (e.g., 5e16 = 5%)
      const healthPct = Number(health) / 1e16;
      const healthFullPct = Number(healthFull) / 1e16;

      return {
        collateral: userState[0],
        stablecoin: userState[1],
        debt,
        n1,
        n2,
        health: healthPct,
        healthFull: healthFullPct,
        liquidationPriceUpper: userPrices[0],
        liquidationPriceLower: userPrices[1],
        hasLoan: true,
        inSoftLiquidation: userState[1] > 0n,
      };
    },
    enabled: !!publicClient && !!controllerAddress && !!userAddress,
    ...CACHE_TIMES.SEMI_REALTIME,
  });

  return {
    position: data ?? null,
    isLoading,
    isError,
    error: error as Error | null,
    refetch,
  };
}

// Helper to format health for display
// Based on Curve LlamaLend thresholds:
// - health <= 0: hard liquidatable
// - health < 4: liquidatable (danger)
// - health < 15: warning (orange)
// - health < 40: caution (yellow)
// - health >= 40: healthy (green)
export function formatHealth(health: number): {
  value: number;
  status: "healthy" | "warning" | "danger";
  color: string;
} {
  const status = health >= 15 ? "healthy" : health >= 4 ? "warning" : "danger";
  const color =
    status === "healthy"
      ? "text-green-500"
      : status === "warning"
      ? "text-yellow-500"
      : "text-red-500";

  return { value: health, status, color };
}

// Helper to format liquidation price
export function formatLiquidationPrice(
  price: bigint,
  decimals: number = 18
): string {
  const value = Number(price) / 10 ** decimals;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}
