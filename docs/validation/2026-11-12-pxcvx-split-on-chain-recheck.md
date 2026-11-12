# pxCVX split: on-chain re-check of the peg point — 12 November 2026

`src/lib/enso/pxcvx-pool.ts` blob: `50a9b3e2d08a6cb3fb6c9bc467368706e3629f5e`.

## What changed

`getOptimalPxCvxSwapAmount` sizes how much CVX a zap swaps on the CVX/lpxCVX pool and how much it mints 1:1. After finding the largest amount that still swaps at 1:1 or better (the peg point) with off-chain math on cached pool parameters, it re-checked that amount by repeating the same off-chain calculation, which could not disagree. It now reads the pool contract's own `get_dy` for that amount. Below 1:1 on chain: swap 1% less. Failed or empty read: swap 2% less. The read is capped at 2.5 seconds; a slower read counts as failed. The two rate helpers used elsewhere are unchanged.

## Environment and data

Read-only `eth_call`s against a public mainnet RPC endpoint at block 26401108; no wallet, no transaction. Pool parameters (`A`, `gamma`, `D`, fees, `price_scale`, balances) were read at that block and fed to the same math library the app uses; results were compared with the pool's `get_dy` at the same block. Unit tests ran under Vitest with the RPC helper mocked.

## Scenarios and results

- Pool balances 28,298 CVX / 16,070 lpxCVX; off-chain peg point 6,456.8868 CVX.
- Off-chain `getDy` equalled on-chain `get_dy` to the wei at 1, 100, 1,000 and 10,000 CVX, at the peg point (6,457.153248 out, at or above 1:1) and at 1% above it (6,514.899454 out for 6,521.4556 in, below 1:1).
- So with current parameters the model is exact; the re-check can differ only when the cached parameters (up to 12 seconds old) are behind the chain.
- Unit tests pin: chain at or above the peg point keeps it; one wei below cuts 1%; missing result, empty result and a rejected read each cut 2%; the off-chain value is not consulted for the re-check; no chain read happens when the whole amount swaps at 1:1 or better, when there is no peg point, or when the amount is zero; swap plus mint always equals the input; a read slower than the cap cuts 2% and leaves no timer behind.

Checks: `pnpm lint`, `pnpm type-check`, `pnpm test:unit`, `pnpm test:sweep`. All passed.

## Limitations and readiness

One block was sampled. No zap was simulated or sent with the new code; the transaction's minimum-output protection is separate from this check and unchanged. The change adds one `eth_call` per pxCVX zap quote that finds a peg point. After a 1% or 2% cut the reduced amount is not re-checked. Production deployment and live verification are separate from this record.
