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

export interface SimulationVaultPriceInfo {
  underlying: string;
  underlyingDecimals: number;
}

interface ResolveSimulationDollarValueParams {
  address: string;
  rawAmount: string | bigint;
  decimals: number;
  priceMap: Map<string, number>;
  vaultInfo?: SimulationVaultPriceInfo | null;
  underlyingAmount?: string | bigint;
}

export function resolveSimulationDollarValue({
  address,
  rawAmount,
  decimals,
  priceMap,
  vaultInfo,
  underlyingAmount,
}: ResolveSimulationDollarValueParams): string | undefined {
  const directPrice = resolveSimulationTokenPrice(address, priceMap);
  if (directPrice !== undefined && directPrice !== 0) {
    const amount = Number(rawAmount) / 10 ** decimals;
    return (amount * directPrice).toString();
  }

  if (!vaultInfo || underlyingAmount === undefined) {
    return undefined;
  }

  const underlyingPrice = resolveSimulationTokenPrice(vaultInfo.underlying, priceMap);
  if (underlyingPrice === undefined || underlyingPrice === 0) {
    return undefined;
  }

  const underlyingValue = Number(underlyingAmount) / 10 ** vaultInfo.underlyingDecimals;
  return (underlyingValue * underlyingPrice).toString();
}
