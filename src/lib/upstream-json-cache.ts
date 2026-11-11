/**
 * Cache for upstream JSON fetched by our own proxy route handlers.
 *
 * Call only from inside a route handler. Never use this to cache a response in front of
 * middleware — see wrangler.jsonc on why Workers Caching is disabled.
 *
 * Pages that proxy slow-changing public data (Kong, Merkl opportunities, the cache
 * worker's history and vault payloads) otherwise pay an upstream round-trip on every
 * request: `Cache-Control: s-maxage` is advisory only, and Workers Caching is switched
 * off for regulatory reasons (it does not partition on country). Caching the upstream
 * body here happens after middleware has already decided the request is allowed, so a
 * blocked visitor never reaches this code and can never be served from it.
 *
 * Layers, all best-effort:
 *  - a per-isolate in-flight map, which collapses concurrent duplicates immediately;
 *  - a short in-isolate value map, which absorbs repeats within the TTL;
 *  - the Cloudflare Cache API, which absorbs repeats across isolates in the same colo.
 *
 * Only successful results are stored. Errors are never cached.
 */

export type UpstreamCacheNamespace = "kong" | "merkl" | "history" | "vaults";

export type UpstreamCacheStatus = "memory" | "edge" | "miss";

const CACHE_ORIGIN = "https://upstream-json.cache.internal";
const MAX_MEMORY_ENTRIES = 256;
const MAX_MEMORY_VALUE_LENGTH = 512 * 1024;

interface MemoryEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * Edge body. The Cache API path is a hash, so the body carries the full logical key
 * and its original expiry; a hit that does not match both is treated as a miss.
 */
interface EdgeEnvelope<T> {
  k: string;
  exp: number;
  v: T;
}

const memory = new Map<string, MemoryEntry>();
const inFlight = new Map<string, Promise<unknown>>();

function fnv1a(input: string, seed = 0x811c9dc5): string {
  let hash = seed;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Internal Cache API path for a key. Hashed so arbitrary key text (addresses, query
 * strings) cannot shape the URL, and namespace-scoped so two routes cannot collide.
 */
function cachePath(namespace: UpstreamCacheNamespace, key: string): string {
  // Two independent hashes -> 64 bits. Any collision is still caught by readEdge,
  // which only accepts an envelope whose k matches the full logical key.
  const hash = `${fnv1a(key)}${fnv1a(key, 0x9e3779b9)}`;
  return `${CACHE_ORIGIN}/${namespace}/${hash}`;
}

function cacheRequest(namespace: UpstreamCacheNamespace, key: string): Request {
  return new Request(cachePath(namespace, key), { method: "GET" });
}

function edgeCache(): Cache | null {
  try {
    const store = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
    return store?.default ?? null;
  } catch {
    return null;
  }
}

function readMemory<T>(entryKey: string): T | null {
  const entry = memory.get(entryKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memory.delete(entryKey);
    return null;
  }
  return entry.value as T;
}

function writeMemory(entryKey: string, value: unknown, expiresAt: number): void {
  // A single huge payload would sit in the isolate's heap for a full TTL; serve it,
  // but keep it out of memory (the edge layer still holds it).
  if (!isWithinMemorySizeLimit(value)) return;

  if (memory.size >= MAX_MEMORY_ENTRIES && !memory.has(entryKey)) {
    // Map iterates in insertion order, so the first key is the oldest entry.
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(entryKey, { value, expiresAt });
}

function isWithinMemorySizeLimit(value: unknown): boolean {
  try {
    return JSON.stringify(value).length <= MAX_MEMORY_VALUE_LENGTH;
  } catch {
    // Unserialisable values are never stored in memory.
    return false;
  }
}

function parseEnvelope<T>(
  body: unknown,
  entryKey: string,
): { value: T; expiresAt: number } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { k, exp, v } = body as { k?: unknown; exp?: unknown; v?: unknown };
  if (k !== entryKey) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= Date.now()) return null;
  return { value: v as T, expiresAt: exp };
}

async function readEdge<T>(
  namespace: UpstreamCacheNamespace,
  key: string,
  entryKey: string,
): Promise<{ value: T; expiresAt: number } | null> {
  const cache = edgeCache();
  if (!cache) return null;

  try {
    const hit = await cache.match(cacheRequest(namespace, key));
    if (!hit) return null;
    // Bodies in any other shape — including ones written before the envelope
    // existed — are a miss, never data attributed to this key.
    return parseEnvelope<T>(await hit.json(), entryKey);
  } catch {
    return null;
  }
}

async function writeEdge(
  namespace: UpstreamCacheNamespace,
  key: string,
  entryKey: string,
  ttlSeconds: number,
  expiresAt: number,
  value: unknown,
): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;

  const envelope: EdgeEnvelope<unknown> = { k: entryKey, exp: expiresAt, v: value };

  try {
    await cache.put(
      cacheRequest(namespace, key),
      new Response(JSON.stringify(envelope), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${ttlSeconds}`,
        },
      }),
    );
  } catch {
    // Cache API is best-effort; the in-isolate map still absorbs repeats.
  }
}

function isCacheable(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/** Collapse concurrent identical lookups onto one upstream call. */
function produceOnce<T>(
  entryKey: string,
  namespace: UpstreamCacheNamespace,
  key: string,
  ttlSeconds: number,
  produce: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(entryKey) as Promise<T> | undefined;
  if (existing) return existing;

  const pending = (async () => {
    const value = await produce();
    if (isCacheable(value)) {
      // One expiry for both layers, so an entry cannot outlive the other.
      const expiresAt = Date.now() + ttlSeconds * 1000;
      writeMemory(entryKey, value, expiresAt);
      await writeEdge(namespace, key, entryKey, ttlSeconds, expiresAt, value);
    }
    return value;
  })();

  inFlight.set(entryKey, pending);
  return pending.finally(() => {
    inFlight.delete(entryKey);
  });
}

/**
 * Returns cached JSON for `key`, or runs `produce`, caches its result for
 * `ttlSeconds`, and returns it. `produce` must THROW on any upstream failure;
 * a thrown error is never cached and is rethrown to the caller.
 */
export async function cachedUpstreamJson<T>(
  namespace: UpstreamCacheNamespace,
  key: string,
  ttlSeconds: number,
  produce: () => Promise<T>,
): Promise<{ value: T; status: UpstreamCacheStatus }> {
  const entryKey = `${namespace}:${key}`;

  const inMemory = readMemory<T>(entryKey);
  if (isCacheable(inMemory)) return { value: inMemory as T, status: "memory" };

  const fromEdge = await readEdge<T>(namespace, key, entryKey);
  if (fromEdge && isCacheable(fromEdge.value)) {
    // Re-seed the memory layer with the envelope's expiry, never a fresh TTL: data
    // must not outlive its original expiry in either layer.
    writeMemory(entryKey, fromEdge.value, fromEdge.expiresAt);
    return { value: fromEdge.value, status: "edge" };
  }

  const value = await produceOnce(entryKey, namespace, key, ttlSeconds, produce);
  return { value, status: "miss" };
}

/** Drop all in-isolate state. Exposed for tests. */
export function clearUpstreamJsonCache(): void {
  memory.clear();
  inFlight.clear();
}
