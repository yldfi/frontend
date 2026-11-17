import { getCloudflareContext } from "@opennextjs/cloudflare";

/** Path of the cache worker's vault payload. */
export const CACHE_WORKER_VAULTS_PATH = "/api/vaults";

// Service bindings ignore the hostname; the cache worker routes on the path only.
const BINDING_ORIGIN = "https://cache-worker.internal";

/** Sends a request for `path` (with its query string) to the cache worker. */
export type CacheWorkerFetch = (path: string, init?: RequestInit) => Promise<Response>;

function getCacheWorkerBinding(): Fetcher | null {
  try {
    return getCloudflareContext().env.CACHE_WORKER ?? null;
  } catch {
    // Not running in Cloudflare environment (local dev, tests)
    return null;
  }
}

/**
 * How the site reaches the cache worker: the CACHE_WORKER service binding when the
 * site runs on Cloudflare, otherwise the CACHE_WORKER_URL environment variable
 * (local dev). CACHE_WORKER_URL is the full vaults URL; other paths resolve
 * against its origin. Returns null when neither is configured.
 */
export function getCacheWorkerFetch(): CacheWorkerFetch | null {
  const binding = getCacheWorkerBinding();
  if (binding) {
    return (path, init) => binding.fetch(new Request(new URL(path, BINDING_ORIGIN), init));
  }

  const cacheWorkerUrl = process.env.CACHE_WORKER_URL;
  if (!cacheWorkerUrl) return null;
  return (path, init) =>
    fetch(
      path === CACHE_WORKER_VAULTS_PATH ? cacheWorkerUrl : new URL(path, cacheWorkerUrl).toString(),
      init
    );
}
