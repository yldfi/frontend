import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

export default defineCloudflareConfig({
  // This app is a static site: prerendered routes are read straight from the Workers
  // static assets bundle, so no R2/KV/queue is needed for the incremental cache.
  incrementalCache: staticAssetsIncrementalCache,
  // Serve cached routes without loading the Next server bundle, which cuts cold-start
  // CPU for /, /zap, /terms and the other prerendered pages.
  enableCacheInterception: false,
});
