/**
 * Opt-in for Cloudflare remote bindings in local development (`pnpm dev`).
 *
 * With YLDFI_DEV_REMOTE_BINDINGS=1, next.config.ts starts wrangler's remote
 * proxy and the site calls the deployed cache worker through its CACHE_WORKER
 * binding; that needs Cloudflare credentials. Without it, local dev starts with
 * no credentials and the cache worker is reached through CACHE_WORKER_URL.
 * Read here only, so next.config.ts and src/lib/cache-worker.ts always agree.
 */
export function devRemoteBindingsEnabled(): boolean {
  return process.env.YLDFI_DEV_REMOTE_BINDINGS === "1";
}
