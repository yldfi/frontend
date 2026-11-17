import { getCloudflareContext } from "@opennextjs/cloudflare";
import { devRemoteBindingsEnabled } from "@/lib/dev-remote-bindings";

/** Path of the cache worker's vault payload. */
export const CACHE_WORKER_VAULTS_PATH = "/api/vaults";

// Service bindings ignore the hostname; the cache worker routes on the path only.
const BINDING_ORIGIN = "https://cache-worker.internal";

/** Sends a request for `path` (with its query string) to the cache worker. */
export type CacheWorkerFetch = (path: string, init?: RequestInit) => Promise<Response>;

function getCacheWorkerBinding(): Fetcher | null {
  // In `pnpm dev` without remote bindings, wrangler still provides a local
  // CACHE_WORKER stub for a worker that is not running (it answers 503), so the
  // binding is used in development only when remote bindings are on.
  if (process.env.NODE_ENV === "development" && !devRemoteBindingsEnabled()) return null;
  try {
    return getCloudflareContext().env.CACHE_WORKER ?? null;
  } catch {
    // Not running in Cloudflare environment (local dev, tests)
    return null;
  }
}

/**
 * How the site reaches the cache worker: the CACHE_WORKER service binding when the
 * site runs on Cloudflare (and in local dev with YLDFI_DEV_REMOTE_BINDINGS=1),
 * otherwise the CACHE_WORKER_URL environment variable (local dev). CACHE_WORKER_URL
 * is the full vaults URL; other paths resolve against its origin. Returns null
 * when neither is configured.
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
