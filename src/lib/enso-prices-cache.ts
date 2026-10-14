/**
 * Very short-lived cache for Enso batch prices.
 *
 * A wallet page can fire several identical /api/enso/prices requests in a short burst
 * (multiple components, re-renders, remounts). Every cache miss fans out into up to
 * ENSO_PRICE_MAX_ADDRESSES / ENSO_PRICE_BATCH_SIZE sequential Enso calls, which burns
 * the Worker CPU budget and helps trip Enso's rate limiter. Collapsing such a burst into
 * a single upstream round-trip removes most of that work.
 *
 * Prices are only cached for a few seconds so the UI stays effectively real-time; the
 * entry-to-entry win comes from collapsing the burst, not from a long TTL.
 *
 * Layers, both best-effort:
 *  - a per-isolate in-flight map, which collapses concurrent duplicates immediately;
 *  - a short in-isolate value map, which absorbs repeats within the TTL;
 *  - the Cloudflare Cache API, which absorbs repeats across isolates in the same colo.
 *
 * Note: the Cloudflare Cache API does not collapse concurrent requests, which is why the
 * in-flight map exists.
 */

export const ENSO_PRICES_CACHE_TTL_SECONDS = 10;

const CACHE_VERSION = "v1";
const MAX_MEMORY_ENTRIES = 256;
const CACHE_ORIGIN = "https://enso-prices.cache.internal";

interface MemoryEntry {
  value: unknown;
  expiresAt: number;
}

const memory = new Map<string, MemoryEntry>();
const inFlight = new Map<string, Promise<unknown>>();

/** Collapse concurrent identical lookups onto one upstream call. */
export function dedupeEnsoPrices<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = produce().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

function fnv1a(input: string, seed = 0x811c9dc5): string {
  let hash = seed;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Stable key for an address set: order- and case-insensitive, independent of set size. */
export function ensoPricesCacheKey(addresses: readonly string[]): string {
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))].sort();
  const joined = unique.join(",");
  // Two independent hashes -> 64 bits, so a collision can't return another set's prices.
  return `${CACHE_VERSION}:${joined.length.toString(16)}:${fnv1a(joined)}:${fnv1a(joined, 0x9e3779b9)}`;
}

export function readMemoryEnsoPrices(key: string): unknown | null {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

export function writeMemoryEnsoPrices(key: string, value: unknown): void {
  if (memory.size >= MAX_MEMORY_ENTRIES && !memory.has(key)) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, { value, expiresAt: Date.now() + ENSO_PRICES_CACHE_TTL_SECONDS * 1000 });
}

/** Drop all in-isolate state. Exposed for tests. */
export function clearMemoryEnsoPrices(): void {
  memory.clear();
  inFlight.clear();
}

function edgeCache(): Cache | null {
  try {
    const store = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
    return store?.default ?? null;
  } catch {
    return null;
  }
}

function cacheRequest(key: string): Request {
  return new Request(`${CACHE_ORIGIN}/${key}`, { method: "GET" });
}

export async function readCachedEnsoPrices(key: string): Promise<unknown | null> {
  const inMemory = readMemoryEnsoPrices(key);
  if (inMemory !== null) return inMemory;

  const cache = edgeCache();
  if (!cache) return null;

  try {
    const hit = await cache.match(cacheRequest(key));
    if (!hit) return null;
    const value: unknown = await hit.json();
    writeMemoryEnsoPrices(key, value);
    return value;
  } catch {
    return null;
  }
}

export async function writeCachedEnsoPrices(key: string, value: unknown): Promise<void> {
  writeMemoryEnsoPrices(key, value);

  const cache = edgeCache();
  if (!cache) return;

  try {
    await cache.put(
      cacheRequest(key),
      new Response(JSON.stringify(value), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${ENSO_PRICES_CACHE_TTL_SECONDS}`,
        },
      }),
    );
  } catch {
    // Cache API is best-effort; the in-isolate map still absorbs repeats.
  }
}
