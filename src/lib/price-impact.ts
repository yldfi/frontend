import { TOKENS } from "@/config/vaults";
import type { RouteInfo, RouteStep } from "@/types/enso";

function isSwapStep(step: RouteStep): boolean {
  return step.action?.toLowerCase() === "swap";
}

// A mint at par (CVX -> pxCVX) changes market value like a swap does: pxCVX can trade
// below CVX, so a large zap that mints loses value even with no "Swap" step.
// Wrap/Unwrap/Exit/Redeem/Deposit are 1:1 or at NAV and stay excluded.
function isValueChangingStep(step: RouteStep): boolean {
  // Compound labels such as "Swap + Mint" count too.
  return /\b(swap|mint)\b/i.test(step.action ?? "");
}

function parseRawTokenAmount(value: string | undefined, decimals = 18): number | null {
  if (!value) return null;
  try {
    return Number(BigInt(value)) / 10 ** decimals;
  } catch {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
}

function cvxAmountFromHybrid(routeInfo: RouteInfo): number | null {
  const hybrid = routeInfo.hybrid;
  if (!hybrid) return null;

  const swapAmount = parseRawTokenAmount(hybrid.swapAmount);
  const mintAmount = parseRawTokenAmount(hybrid.mintAmount);
  if (swapAmount === null && mintAmount === null) return null;
  return (swapAmount ?? 0) + (mintAmount ?? 0);
}

function cvxAmountFromSteps(routeInfo: RouteInfo): number | null {
  let total = 0;

  for (const step of routeInfo.steps) {
    const tokenAddress = step.tokenAddress?.toLowerCase();
    const tokenSymbol = step.tokenSymbol?.toLowerCase();
    const isCvxStep =
      tokenAddress === TOKENS.CVX.toLowerCase() ||
      tokenSymbol === "cvx";
    const action = step.action?.toLowerCase();

    if (!isCvxStep || (action !== "swap" && action !== "mint")) continue;

    const amount = parseRawTokenAmount(step.rawAmount) ?? parseRawTokenAmount(step.amount);
    if (amount !== null && amount > 0) total += amount;
  }

  return total > 0 ? total : null;
}

export function normalizeEnsoPriceImpact(priceImpactBps: number | null | undefined): number | null {
  if (priceImpactBps == null) return null;
  if (!Number.isFinite(priceImpactBps)) return null;
  return priceImpactBps / 100;
}

export function calculateValueDeltaImpact(
  inputUsd: number | null,
  outputUsd: number | null,
  fallbackEnsoPriceImpactBps?: number | null,
): number | null {
  if (inputUsd === null || outputUsd === null || inputUsd === 0) {
    return normalizeEnsoPriceImpact(fallbackEnsoPriceImpactBps);
  }
  return ((inputUsd - outputUsd) / inputUsd) * 100;
}

export function routeHasSwap(routeInfo: RouteInfo | null | undefined): boolean {
  return Boolean(routeInfo?.steps.some(isValueChangingStep));
}

export function routeHasEnsoSwap(routeInfo: RouteInfo | null | undefined): boolean {
  return Boolean(
    routeInfo?.steps.some(
      (step) => isSwapStep(step) && step.protocol?.toLowerCase() === "enso",
    ),
  );
}

export function calculateRoutePriceImpact(
  inputUsd: number | null,
  outputUsd: number | null,
  routeInfo?: RouteInfo | null,
  fallbackEnsoPriceImpactBps?: number | null,
): number | null {
  if (routeInfo && !routeHasSwap(routeInfo)) return null;
  return calculateValueDeltaImpact(inputUsd, outputUsd, fallbackEnsoPriceImpactBps);
}

export function calculateCvxLegPriceImpact(params: {
  inputUsd: number | null;
  cvxUsd: number | null;
  routeInfo?: RouteInfo | null;
}): number | null {
  const { inputUsd, cvxUsd, routeInfo } = params;
  if (inputUsd === null || cvxUsd === null || inputUsd === 0 || cvxUsd === 0 || !routeInfo) {
    return null;
  }
  if (!routeHasEnsoSwap(routeInfo)) return null;

  const cvxAmount = cvxAmountFromHybrid(routeInfo) ?? cvxAmountFromSteps(routeInfo);
  if (cvxAmount === null || cvxAmount <= 0) return null;

  const idealCvxAtMarket = inputUsd / cvxUsd;
  if (idealCvxAtMarket <= 0) return null;
  return ((idealCvxAtMarket - cvxAmount) / idealCvxAtMarket) * 100;
}

export function annotateEnsoStepSlippage(
  routeInfo: RouteInfo | undefined,
  priceImpact: number | null,
): RouteInfo | undefined {
  if (!routeInfo?.steps.length || priceImpact === null || priceImpact <= 0.05) {
    return routeInfo;
  }

  const ensoStepIdx = routeInfo.steps.findIndex((step) => step.protocol === "Enso");
  if (ensoStepIdx < 0) return routeInfo;

  return {
    ...routeInfo,
    steps: routeInfo.steps.map((step, index) =>
      index === ensoStepIdx ? { ...step, slippage: priceImpact } : step,
    ),
  };
}

// A bundle quote this far below the route's own standalone estimate is a bad
// Enso quote, not market impact: the standalone leg and the bundle are priced
// in the same request, so honest quotes agree to within a few tenths of a
// percent. 5 Nov 2026: yvUSDC-1 → yscvxCRV bundled 1,095.65 shares while every
// on-chain path (and the standalone leg, 2,028 cvxCRV) gave ~1,777 shares. The
// bundle's slippage floor is derived from its own quote, so executing it would
// have locked in the ~38% loss.
export const ROUTE_QUOTE_SHORTFALL_LIMIT_PCT = 5;

export const ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX = "Enso returned a bad quote";

function parseDisplayAmount(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Amount of the vault's underlying that the route's standalone estimate says
 * will be deposited (the "Deposit" step that feeds the target vault).
 */
export function routeDepositEstimate(
  routeInfo: RouteInfo | null | undefined,
  underlyingSymbol: string,
): number | null {
  const symbol = underlyingSymbol.toLowerCase();
  const steps = routeInfo?.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.action?.toLowerCase() !== "deposit") continue;
    if (step.tokenSymbol?.toLowerCase() !== symbol) continue;
    return parseDisplayAmount(step.amount);
  }
  return null;
}

/** Percent by which the bundle delivers less than the estimate (negative = more). */
export function routeQuoteShortfallPct(
  estimatedUnderlying: number | null,
  bundleUnderlying: number | null,
): number | null {
  if (estimatedUnderlying === null || bundleUnderlying === null) return null;
  if (!(estimatedUnderlying > 0) || !Number.isFinite(bundleUnderlying)) return null;
  return ((estimatedUnderlying - bundleUnderlying) / estimatedUnderlying) * 100;
}

/**
 * Throws when a zap into a vault would deposit far less of the underlying than
 * the route's standalone estimate. `bundleUnderlying` is the bundle's share
 * output × assets-per-share. Skips silently when either side is unknown.
 */
export function assertBundleMatchesRouteEstimate(params: {
  routeInfo: RouteInfo | null | undefined;
  underlyingSymbol: string;
  bundleUnderlying: number | null;
  /** User slippage in bps. Some builders size bundle legs with this buffer, so the limit never drops below it. */
  slippageBps?: string | number;
}): void {
  const estimate = routeDepositEstimate(params.routeInfo, params.underlyingSymbol);
  const shortfall = routeQuoteShortfallPct(estimate, params.bundleUnderlying);
  const slippagePct = Number(params.slippageBps ?? 0) / 100;
  const limit = Math.max(
    ROUTE_QUOTE_SHORTFALL_LIMIT_PCT,
    Number.isFinite(slippagePct) ? slippagePct + 1 : 0,
  );
  if (shortfall === null || shortfall <= limit) return;
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  throw new Error(
    `${ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX}: the zap would deposit ~${fmt(params.bundleUnderlying!)} ` +
      `${params.underlyingSymbol}, ${shortfall.toFixed(1)}% below the ~${fmt(estimate!)} ` +
      `${params.underlyingSymbol} the market route gives. Try again in a moment or change the amount.`,
  );
}
