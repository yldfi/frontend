"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { CURVE_CONTROLLERS } from "@/config/vaults";
import { CACHE_TIMES } from "@/config/query";
import {
  DEFISAVER_CURVE_VIEW,
  DEFISAVER_CURVE_HELPER,
  CURVE_VIEW_ABI,
  CURVE_HELPER_ABI,
} from "@/lib/zapper";

export interface LendingPosition {
  // Raw values from user_state
  collateral: bigint; // collateral in vault
  stablecoin: bigint; // crvUSD in AMM (during soft-liquidation)
  debt: bigint; // total debt
  N: number; // number of bands

  // Health metrics
  health: number; // health percentage (full health, 0-100+)
  healthFull: number; // same as health (full health from CurveUsdView)

  // Liquidation prices
  liquidationPriceUpper: bigint; // upper band price
  liquidationPriceLower: bigint; // lower band price

  // Limits
  maxWithdrawable: bigint; // max collateral withdrawable (from DeFi Saver helper)

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

      // Single call via DeFi Saver's CurveUsdView — replaces 6+ separate controller reads
      const userData = await publicClient.readContract({
        address: DEFISAVER_CURVE_VIEW,
        abi: CURVE_VIEW_ABI,
        functionName: "userData",
        args: [controllerAddress, userAddress],
      });

      if (!userData.loanExists) {
        return null;
      }

      // Fetch maxWithdrawable from DeFi Saver's LlamaLendHelper
      // Wrapped in try-catch: the helper has an arithmetic overflow bug for some positions
      // (e.g. positions in soft-liquidation). Default to 0n so position data still loads.
      let maxWithdrawable = 0n;
      try {
        maxWithdrawable = await publicClient.readContract({
          address: DEFISAVER_CURVE_HELPER,
          abi: CURVE_HELPER_ABI,
          functionName: "userMaxWithdraw",
          args: [controllerAddress, userAddress],
        });
      } catch {
        // DeFi Saver helper reverts with arithmetic overflow for some positions
      }

      // Health is returned as int256 with 1e18 precision where 1e16 = 1%
      const healthPct = Number(userData.health) / 1e16;

      return {
        collateral: userData.marketCollateralAmount,
        stablecoin: userData.curveUsdCollateralAmount,
        debt: userData.debtAmount,
        N: Number(userData.N),
        health: healthPct,
        healthFull: healthPct,
        liquidationPriceUpper: userData.priceHigh,
        liquidationPriceLower: userData.priceLow,
        maxWithdrawable,
        hasLoan: true,
        inSoftLiquidation: userData.curveUsdCollateralAmount > 0n,
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
      ? "text-green-600"
      : status === "warning"
      ? "text-yellow-600"
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
