import { TOKENS } from "@/config/vaults";

const CVX_ADDRESS_LOWER = TOKENS.CVX.toLowerCase();

const CVX_EQUIVALENT_PRICE_TOKENS = new Set([
  TOKENS.CVGCVX.toLowerCase(),
  TOKENS.PXCVX.toLowerCase(),
  TOKENS.LPXCVX.toLowerCase(),
]);

export function isCvxEquivalentPriceToken(address: string | null | undefined): boolean {
  if (!address) return false;
  return CVX_EQUIVALENT_PRICE_TOKENS.has(address.toLowerCase());
}

export function getSimulationPriceLookupAddresses(addresses: string[]): string[] {
  const deduped = new Set<string>();
  let needsCvxFallback = false;

  for (const address of addresses) {
    const normalized = address.toLowerCase();
    deduped.add(normalized);
    if (isCvxEquivalentPriceToken(normalized)) {
      needsCvxFallback = true;
    }
  }

  if (needsCvxFallback) {
    deduped.add(CVX_ADDRESS_LOWER);
  }

  return [...deduped];
}

export function resolveSimulationTokenPrice(
  address: string,
  priceMap: Map<string, number>,
): number | undefined {
  const normalized = address.toLowerCase();
  const directPrice = priceMap.get(normalized);

  if (directPrice !== undefined && directPrice !== 0) {
    return directPrice;
  }

  if (isCvxEquivalentPriceToken(normalized)) {
    const cvxFallbackPrice = priceMap.get(CVX_ADDRESS_LOWER);
    if (cvxFallbackPrice !== undefined && cvxFallbackPrice !== 0) {
      return cvxFallbackPrice;
    }
  }

  return directPrice;
}
