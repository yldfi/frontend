/** A zero, negative or non-finite quote is not usable USD pricing. */
export function validSimulationUsd(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export interface SimulationVaultPriceInfo {
  underlying: string;
  underlyingDecimals: number;
}

export interface PricedSimulationAsset {
  address: string;
  rawAmount: string;
  decimals: number;
  dollarValue?: string;
}

interface PricingDependencies {
  fetchPrice: (address: string) => Promise<number | undefined>;
  knownVault?: (address: string) => SimulationVaultPriceInfo | null;
  lookupVault: (address: string) => Promise<SimulationVaultPriceInfo | null>;
  convertToAssets: (address: string, rawAmount: string) => Promise<bigint>;
  timeoutMs: number;
  onFailure?: (stage: string, address: string, reason: "timeout" | "lookup_failed") => void;
}

/**
 * Prefer Enso even for nonzero Tenderly values. Vault shares use on-chain NAV
 * and the underlying's actual price when available. Independent lookups share
 * one deadline, so a slow/unpriced token cannot discard another token's price.
 */
export async function enrichSimulationPrices<T extends PricedSimulationAsset>(
  changes: T[],
  dependencies: PricingDependencies,
): Promise<T[]> {
  const deadline = Date.now() + dependencies.timeoutMs;
  const prices = new Map<string, Promise<number | undefined>>();
  const vaults = new Map<string, Promise<SimulationVaultPriceInfo | null | undefined>>();
  const conversions = new Map<string, Promise<bigint | undefined>>();

  async function bounded<V>(stage: string, address: string, work: () => Promise<V>): Promise<V | undefined> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Error("pricing deadline");
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeout), remaining); }),
      ]);
    } catch (error) {
      // Upstream errors/URLs may contain credentials; record only the failure class.
      dependencies.onFailure?.(stage, address, error === timeout ? "timeout" : "lookup_failed");
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  function price(address: string) {
    const key = address.toLowerCase();
    if (!prices.has(key)) {
      prices.set(key, bounded("enso_price", key, () => dependencies.fetchPrice(key))
        .then(validSimulationUsd));
    }
    return prices.get(key)!;
  }

  function vault(address: string) {
    const key = address.toLowerCase();
    if (!vaults.has(key)) vaults.set(key, bounded("vault_lookup", key, () => dependencies.lookupVault(key)));
    return vaults.get(key)!;
  }

  async function nav(change: T): Promise<number | undefined> {
    const info = await vault(change.address);
    if (!info) return undefined;
    // Two rows for the same vault can have different amounts.
    const key = `${change.address.toLowerCase()}:${change.rawAmount}`;
    if (!conversions.has(key)) {
      conversions.set(key, bounded("vault_conversion", change.address,
        () => dependencies.convertToAssets(change.address, change.rawAmount)));
    }
    const [underlyingPrice, assets] = await Promise.all([price(info.underlying), conversions.get(key)!]);
    if (underlyingPrice === undefined || assets === undefined) return undefined;
    return validSimulationUsd(Number(assets) / 10 ** info.underlyingDecimals * underlyingPrice);
  }

  return Promise.all(changes.map(async (change) => {
    // Avoid asking Enso for known vault shares unless their NAV cannot be priced.
    let directPrice: number | undefined;
    let vaultValue: number | undefined;
    if (dependencies.knownVault?.(change.address)) {
      vaultValue = await nav(change);
      if (vaultValue === undefined) directPrice = await price(change.address);
    } else {
      [directPrice, vaultValue] = await Promise.all([price(change.address), nav(change)]);
    }
    const directValue = directPrice === undefined ? undefined
      : validSimulationUsd(Number(change.rawAmount) / 10 ** change.decimals * directPrice);
    const dollarValue = vaultValue ?? directValue ?? validSimulationUsd(change.dollarValue);
    return { ...change, dollarValue: dollarValue?.toString() };
  }));
}
