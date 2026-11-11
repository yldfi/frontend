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
 * Every layer also checks the requested address set (the "identity"), not just the
 * hashed cache slot: the addresses come from the request, so a hash collision must not
 * be able to serve one set's prices to another.
 *
 * Note: the Cloudflare Cache API does not collapse concurrent requests, which is why the
 * in-flight map exists.
 */

export const ENSO_PRICES_CACHE_TTL_SECONDS = 10;

const CACHE_VERSION = "v1";
const MAX_MEMORY_ENTRIES = 256;
const CACHE_ORIGIN = "https://enso-prices.cache.internal";

interface MemoryEntry {
  identity: string;
  value: unknown;
  expiresAt: number;
}

/**
 * Edge body. The Cache API path is a hash, so the body carries the full address-set
 * identity and its expiry; a read that does not match both is treated as a miss.
 */
interface EdgeEnvelope {
  k: string;
  exp: number;
  v: unknown;
}

const memory = new Map<string, MemoryEntry>();
const inFlight = new Map<string, Promise<unknown>>();

/** Collapse concurrent identical lookups onto one upstream call. */
export function dedupeEnsoPrices<T>(
  key: string,
  identity: string,
  produce: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(identity) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = produce().finally(() => {
    inFlight.delete(identity);
  });
  inFlight.set(identity, pending);
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

/**
 * Canonical form of an address set: lowercased, de-duplicated, sorted, joined with ",".
 * This is the value every cache layer compares on a hit.
 */
export function ensoPricesCacheIdentity(addresses: readonly string[]): string {
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))].sort();
  return unique.join(",");
}

/** Cache slot name for an address set: order- and case-insensitive, independent of set size. */
export function ensoPricesCacheKey(addresses: readonly string[]): string {
  const identity = ensoPricesCacheIdentity(addresses);
  // The hash only names the slot. It is not collision-resistant, so a hit is only
  // trusted when the stored identity matches the requested one.
  return `${CACHE_VERSION}:${identity.length.toString(16)}:${fnv1a(identity)}:${fnv1a(identity, 0x9e3779b9)}`;
}

export function readMemoryEnsoPrices(key: string, identity: string): unknown | null {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  // Same slot, different address set: a miss, but the entry may still serve its own set.
  if (entry.identity !== identity) return null;
  return entry.value;
}

export function writeMemoryEnsoPrices(
  key: string,
  identity: string,
  value: unknown,
  expiresAt = Date.now() + ENSO_PRICES_CACHE_TTL_SECONDS * 1000,
): void {
  if (memory.size >= MAX_MEMORY_ENTRIES && !memory.has(key)) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, { identity, value, expiresAt });
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

function parseEdgeEnvelope(
  body: unknown,
  identity: string,
): { value: unknown; expiresAt: number } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { k, exp, v } = body as { k?: unknown; exp?: unknown; v?: unknown };
  if (k !== identity) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= Date.now()) return null;
  // A body without prices is a miss: an envelope's `v` is the price array.
  if (v === undefined) return null;
  return { value: v, expiresAt: exp };
}

export async function readCachedEnsoPrices(
  key: string,
  identity: string,
): Promise<unknown | null> {
  const inMemory = readMemoryEnsoPrices(key, identity);
  if (inMemory !== null) return inMemory;

  const cache = edgeCache();
  if (!cache) return null;

  try {
    const hit = await cache.match(cacheRequest(key));
    if (!hit) return null;
    // Bodies in any other shape — including ones written before the envelope
    // existed — are a miss, never prices attributed to this address set.
    const parsed = parseEdgeEnvelope(await hit.json(), identity);
    if (!parsed) return null;
    // Seed the memory layer with the envelope's expiry, never a fresh TTL.
    writeMemoryEnsoPrices(key, identity, parsed.value, parsed.expiresAt);
    return parsed.value;
  } catch {
    return null;
  }
}

export async function writeCachedEnsoPrices(
  key: string,
  identity: string,
  value: unknown,
): Promise<void> {
  const expiresAt = Date.now() + ENSO_PRICES_CACHE_TTL_SECONDS * 1000;
  writeMemoryEnsoPrices(key, identity, value, expiresAt);

  const cache = edgeCache();
  if (!cache) return;

  const envelope: EdgeEnvelope = { k: identity, exp: expiresAt, v: value };

  try {
    await cache.put(
      cacheRequest(key),
      new Response(JSON.stringify(envelope), {
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
