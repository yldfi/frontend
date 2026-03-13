import { formatUnits } from "viem";

export interface LendingPositionDisplay {
  /** Formatted collateral amount (e.g., "37,565.33") */
  collateralFormatted: string;
  /** Formatted debt amount (e.g., "2,505.39") */
  debtFormatted: string;
  /** Current leverage ratio (e.g., 1.43) */
  leverage: number;
  /** Formatted leverage (e.g., "1.43x") */
  leverageFormatted: string;
  /** Collateral APY as percentage (e.g., 11.5 for 11.5%) */
  collateralApy: number;
  /** Borrow APR as percentage (e.g., 7.43 for 7.43%) */
  borrowApr: number;
  /** Net rate after leverage */
  netRate: number;
  /** Formatted collateral APY (e.g., "+11.50%") */
  collateralApyFormatted: string;
  /** Formatted borrow APR (e.g., "-7.43%") */
  borrowAprFormatted: string;
  /** Formatted net rate (e.g., "+13.25%") */
  netRateFormatted: string;
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
 * Compute net rate for a leveraged lending position.
 * net = (collateralRate * leverage) - (borrowRate * (leverage - 1))
 */
export function computeNetRate(collateralRate: number, borrowRate: number, leverage: number): number {
  return (collateralRate * leverage) - (borrowRate * (leverage - 1));
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
 * Build display data for a lending position.
 * Collateral rate is APY (auto-compounding vault), borrow rate is APR (Curve convention).
 *
 * @param collateral - Raw collateral amount (bigint)
 * @param debt - Raw debt amount (bigint, 18 decimals for crvUSD)
 * @param collateralPriceUsd - USD price of one unit of collateral token
 * @param collateralApy - APY earned on collateral (percentage, e.g., 8.62)
 * @param borrowApr - APR paid on debt (percentage, e.g., 16.17)
 * @param collateralDecimals - Decimals for collateral token (default 18)
 * @param stablecoin - crvUSD in AMM from soft-liquidation (bigint, 18 decimals, default 0)
 */
export function buildLendingPositionDisplay(
  collateral: bigint,
  debt: bigint,
  collateralPriceUsd: number,
  collateralApy: number,
  borrowApr: number,
  collateralDecimals: number = 18,
  stablecoin: bigint = 0n,
): LendingPositionDisplay {
  const collateralNum = Number(formatUnits(collateral, collateralDecimals));
  const debtNum = Number(formatUnits(debt, 18)); // crvUSD is always 18 decimals
  const stablecoinNum = Number(formatUnits(stablecoin, 18));

  // Total collateral value: vault token value + stablecoin in AMM (from soft-liquidation)
  const collateralValueUsd = collateralNum * collateralPriceUsd + stablecoinNum;
  const debtValueUsd = debtNum;

  const leverage = computeLeverage(collateralValueUsd, debtValueUsd);
  const netRate = computeNetRate(collateralApy, borrowApr, leverage);

  return {
    collateralFormatted: formatNumber(collateralNum, collateralNum >= 1000 ? 2 : 4),
    debtFormatted: formatNumber(debtNum, 2),
    leverage,
    leverageFormatted: `${leverage.toFixed(2)}x`,
    collateralApy,
    borrowApr,
    netRate,
    collateralApyFormatted: formatRate(collateralApy),
    borrowAprFormatted: formatRate(-borrowApr),
    netRateFormatted: formatRate(netRate),
    hasLoan: true,
  };
}
