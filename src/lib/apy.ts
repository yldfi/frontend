/**
 * APY at or above this (percent) is displayed as ∞.
 *
 * Annualising a short window magnifies small-balance effects. E.g. ysCVX
 * reported profit while its TVL was ~$10k, then most of it was withdrawn,
 * so the 24 h share-price jump compounded to millions of percent. The number
 * is arithmetically right but meaningless to show, and it overflowed its box.
 */
export const APY_DISPLAY_CAP = 10_000;

export function isApyOffScale(apy: number): boolean {
  return !Number.isFinite(apy) || apy >= APY_DISPLAY_CAP;
}

export function formatApy(apy: number | null | undefined, digits = 2): string {
  if (apy == null || Number.isNaN(apy)) return "—";
  if (isApyOffScale(apy)) return "∞";
  return `${apy.toFixed(digits)}%`;
}

export const OFF_SCALE_APY_TITLE =
  `Above ${APY_DISPLAY_CAP.toLocaleString("en-US")}%: a recent profit landed on a small balance, so the annualised figure isn't meaningful.`;

/** Average of the APYs that are on the display scale (off-scale ones would swamp it). */
export function averageDisplayApy(apys: number[]): number {
  const onScale = apys.filter((apy) => !isApyOffScale(apy));
  return onScale.length > 0 ? onScale.reduce((sum, apy) => sum + apy, 0) / onScale.length : 0;
}
