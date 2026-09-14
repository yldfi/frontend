# Vault cache runtime replay

Run `node workers/testing/replay-vault-cache.mjs` from the frontend root after
installing the locked dependencies. Uses Wrangler's installed Miniflare and
esbuild dependencies; no production env file or keys are loaded.

The real worker is bundled and run in workerd, with isolated temporary KV/D1/R2.
Every outbound request is handled by fixtures; unexpected hosts fail. Contract
asset/share values are derived from the captured public yldfi API response dated
14 September 2026 (`lastUpdated` 08:56 UTC). Curve quote outputs, Enso prices and
APY lookback responses are controlled fixtures, not a live economic simulation.

Exercises: successful manual/scheduled refreshes; failed RPC reads; invalid share
prices; GraphQL errors and missing vaults; negative TVL; missing token prices;
last snapshot/timestamp retention; cold 503; genuine zero assets; null APY when
archive reads fail; recovery; 24-hour KV retention; scheduled R2 history sampling.

The worker publishes a complete snapshot atomically: missing balance/price data
for any of its six configured vaults retains the previous whole snapshot. APY
alone may be null. This trades update availability for avoiding fabricated zero
balances and mixing observation times. Existing cache expiration remains 24h;
consumers must use lastUpdated to identify stale values.
