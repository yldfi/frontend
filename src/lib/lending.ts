import { formatUnits } from "viem";

const CURVE_SECONDS_PER_YEAR = 365 * 86400;

export interface LendingPositionDisplay {
  /** Formatted collateral amount (e.g., "37,565.33") */
  collateralFormatted: string;
  /** Formatted debt amount (e.g., "2,505.39") */
  debtFormatted: string;
  /** Current leverage ratio (e.g., 1.43) */
  leverage: number;
  /** Formatted leverage (e.g., "1.43x") */
  leverageFormatted: string;
  /** Collateral APY as percentage (e.g., 8.62) */
  collateralApy: number;
  /** Borrow APY as percentage (e.g., 17.55) */
  borrowApy: number;
  /** Net APY after leverage */
  netApy: number;
  /** Formatted collateral APY (e.g., "+8.62%") */
  collateralApyFormatted: string;
  /** Formatted borrow APY (e.g., "-17.55%") */
  borrowApyFormatted: string;
  /** Formatted net APY (e.g., "+0.76%") */
  netApyFormatted: string;
  /** Whether the user has an active loan */
  hasLoan: boolean;
}

/**
 * Compute leverage from collateral value and debt in the same denomination.
 * Returns 1.0 if no debt or invalid.
 */
export function computeLeverage(collateralValueUsd: number, debtValueUsd: number): number {
  if (collateralValueUsd <= 0 || collateralValueUsd <= debtValueUsd) return 1;
  return collateralValueUsd / (collateralValueUsd - debtValueUsd);
}

/**
 * Compute net APY for a leveraged lending position.
 * netAPY = (collateralApy * earningLeverage) - (borrowApy * (leverage - 1))
 *
 * `collateralYieldRatio` is the share of total collateral value that still
 * earns collateral APY. During soft-liquidation, crvUSD in the AMM counts
 * toward position value but no longer earns vault staking rewards.
 */
export function computeNetApy(
  collateralApy: number,
  borrowApy: number,
  leverage: number,
  collateralYieldRatio: number = 1
): number {
  const safeYieldRatio = Number.isFinite(collateralYieldRatio)
    ? Math.min(Math.max(collateralYieldRatio, 0), 1)
    : 0;
  return (collateralApy * leverage * safeYieldRatio) - (borrowApy * (leverage - 1));
}

/**
 * Convert Curve monetary policy per-second raw rate to APR percentage.
 * Curve policies scale rates by 1e18 and annualize over 365 days.
 */
export function curveBorrowRateToApr(rawRate: bigint): number {
  return Number(rawRate) * CURVE_SECONDS_PER_YEAR / 1e18 * 100;
}

export function aprToApy(aprPercent: number): number {
  return (Math.exp(aprPercent / 100) - 1) * 100;
}

/**
 * Format a number with commas and decimal places.
 */
function formatNumber(value: number, decimals: number = 2): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format a rate as a signed percentage string.
 */
function formatRate(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

/**
 * Build display data for a lending position. All rates as APY.
 *
 * @param collateral - Raw collateral amount (bigint)
 * @param debt - Raw debt amount (bigint, 18 decimals for crvUSD)
 * @param collateralPriceUsd - USD price of one unit of collateral token
 * @param collateralApy - APY earned on collateral (percentage, e.g., 8.62)
 * @param borrowApy - APY paid on debt (percentage, e.g., 17.55)
 * @param collateralDecimals - Decimals for collateral token (default 18)
 * @param stablecoin - crvUSD in AMM from soft-liquidation (bigint, 18 decimals, default 0)
 */
export function buildLendingPositionDisplay(
  collateral: bigint,
  debt: bigint,
  collateralPriceUsd: number,
  collateralApy: number,
  borrowApy: number,
  collateralDecimals: number = 18,
  stablecoin: bigint = 0n,
): LendingPositionDisplay {
  const collateralNum = Number(formatUnits(collateral, collateralDecimals));
  const debtNum = Number(formatUnits(debt, 18)); // crvUSD is always 18 decimals
  const stablecoinNum = Number(formatUnits(stablecoin, 18));

  // Total position value includes vault token collateral plus crvUSD in AMM
  // bands. Only the remaining vault token collateral earns vault APY.
  const yieldBearingCollateralValueUsd = collateralNum * collateralPriceUsd;
  const collateralValueUsd = yieldBearingCollateralValueUsd + stablecoinNum;
  const debtValueUsd = debtNum;

  const leverage = computeLeverage(collateralValueUsd, debtValueUsd);
  const collateralYieldRatio = collateralValueUsd > 0
    ? yieldBearingCollateralValueUsd / collateralValueUsd
    : 0;
  const netApy = computeNetApy(collateralApy, borrowApy, leverage, collateralYieldRatio);

  return {
    collateralFormatted: formatNumber(collateralNum, collateralNum >= 1000 ? 2 : 4),
    debtFormatted: formatNumber(debtNum, 2),
    leverage,
    leverageFormatted: `${leverage.toFixed(2)}x`,
    collateralApy,
    borrowApy,
    netApy,
    collateralApyFormatted: formatRate(collateralApy),
    borrowApyFormatted: formatRate(-borrowApy),
    netApyFormatted: formatRate(netApy),
    hasLoan: true,
  };
}
