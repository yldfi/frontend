import { TOKENS } from "@/config/vaults";
import type { RouteInfo, RouteStep } from "@/types/enso";

function isSwapStep(step: RouteStep): boolean {
  return step.action?.toLowerCase() === "swap";
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
  return Boolean(routeInfo?.steps.some(isSwapStep));
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
