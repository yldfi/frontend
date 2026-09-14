# Owned vault history

The three tracked strategies use `history/v2/{key}.json` in R2. The old objects
are retained for rollback. The public `/api/history` route serves daily TVL/PPS
from this store; it does not query Kong. Current-day values remain in `/api/vaults`.

Each completed UTC day uses its final Ethereum block. Binary search plus the
adjacent block establishes the timestamp boundary, including missed slots.
Stored points include block number/hash/timestamp, raw totalAssets/PPS, pricing
call results, and the derived USD value. Genuine zero assets produce zero TVL;
failed asset/PPS reads do not create points; missing/stale prices produce null
TVL while retaining PPS. The API inserts nulls for missing dates. Corrupt objects
return 503 instead of silently resetting history.

Valuation is an estimate at that block, using the same sources as yldfi's price
hooks: CVX uses Chainlink CVX/USD; cvgCVX uses CVX/USD divided by the Curve
CVX1→cvgCVX one-token quote; cvxCRV uses the LlamaLend cvxCRV/crvUSD oracle times
Chainlink crvUSD/USD. This is a quoted/oracle valuation, not a guarantee of
liquidation proceeds. Feed answers must be positive, completed, and no more than
48 hours old. Token amounts have 18 decimals; Chainlink feeds have 8 decimals.

Cron samples the previous completed day independently of Kong/current cache
success. It also fills one older missing day per vault per invocation. R2
conditional writes preserve concurrent updates. Previously valid completed
points are immutable; unavailable pricing can be retried.

## Reproduce and validate (local only)

Use the locked project dependencies and `ethcli` with the configured Muupe
archive endpoint. `ETHCLI_BIN` can select another CLI path. No production signing
credentials are needed or loaded. The reconstruction script makes only read RPC
calls and writes only the selected local directory.

```
node workers/testing/repair-history.mjs local/history-repair
node workers/testing/verify-history-artifacts.mjs local/history-repair
node workers/testing/replay-vault-history.mjs local/history-repair
node workers/testing/replay-vault-cache.mjs
pnpm type-check
pnpm test:unit
```

The artifact audit recomputes every value from recorded RPC replies and verifies
both boundary blocks, daily continuity and complete pricing. The worker replay
loads the exact artifacts into isolated Miniflare R2 and compares public route
responses for both metrics and all three vaults. It also exercises cold/corrupt
data, RPC/price failure, true zero, invalid/stale oracle rounds, missed block
slots, pricing repair, and cron sampling during a Kong outage.

## 14 September 2026 repair

Reconstructed 677 daily points through 13 September: yscvgCVX 330 (from
19 October 2025), yscvxCRV 290 (from 28 November 2025), ysCVX 57 (from
19 July 2026). No missing or null valuations. All 24 zero-valued yscvgCVX days
in the old Kong history had nonzero day-close assets. ysCVX's 30 August gap is
filled. yscvxCRV's deployment day has verified zero assets and remains zero.

Before publication, record the exact code revision and artifact hashes, retain
the old R2 keys, and upload only the audited files to the new v2 keys. Verify the
uploaded content before deploying the API switch. Do not overwrite a live v2
object with an older offline snapshot: if v2 already exists, merge through the
conditional-write path or stop and inspect it. Then verify the deployed worker
revision, all public series, and the consumer's live charts separately.
