/**
 * Enso's price endpoint takes addresses as GET query parameters, so one call with a few hundred
 * tokens (a wallet's whole balance list) exceeds the URL/header limit and fails with HTTP 431.
 */
export const ENSO_PRICE_BATCH_SIZE = 50;

/** Upper bound per /api/enso/prices request, so one call can't fan out into dozens of Enso calls. */
export const ENSO_PRICE_MAX_ADDRESSES = 500;

/** Dedupe (case-insensitively) and fetch in sequential batches, concatenating the results. */
export async function fetchPricesInBatches<T>(
  addresses: readonly string[],
  fetchBatch: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  const unique = [...new Map(addresses.map((address) => [address.toLowerCase(), address])).values()];
  const results: T[] = [];
  for (let i = 0; i < unique.length; i += ENSO_PRICE_BATCH_SIZE) {
    results.push(...(await fetchBatch(unique.slice(i, i + ENSO_PRICE_BATCH_SIZE))));
  }
  return results;
}
