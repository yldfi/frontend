# Auction market-crossing correction

## Tested content and environment

- Base revision: `de4ebb767227bd6dac0f6a2fb3a93472b31c24b0`, with local changes.
- Node `v24.13.0`, installed workspace dependencies, Vitest/jsdom and React Testing Library.
- SHA-256 `src/components/VaultHarvestPanel.tsx`: `2fd10b9a2fb9c332e52eff5893684355f7620c5c9ffefd0c0cc255aa1bc47984`.
- SHA-256 `src/__tests__/components/VaultHarvestPanel.test.tsx`: `6b4549d6df14e6635cc7085a93041b826d0402958ca638722538560cc0c28713`.

## Evidence and fixture provenance

The supplied screenshots show roughly 15.8117 crvUSD available, startingPrice 1000, 36-second steps, 50 bps decay, and an auction above market after approximately 4h6m. The regression fixture uses those rounded values and Zaplet's displayed 6.9559 market rate; it is not a block-pinned chain snapshot. Initial inventory is assumed equal to the shown inventory for this fixture.

Local Yearn Auction source at `../strategyStCVXCRV/lib/tokenized-strategy-periphery/src/Auctions/Auction.sol` calculates `wdiv(startingPrice * 1e18, scaledAvailable)`. Zaplet's `src/cvxcrv-auction/utils/auction-math.util.ts` also treats startingPrice as unscaled. The frontend previously formatted it as payment-token wei, shrinking the initial unit price by 1e18.

## Scenarios exercised

- Rendered the real panel with mocked read results for the screenshot auction: future crossing, 8.0595 cvxCRV auction rate, 6.9559 market rate, explicit per-crvUSD units, disabled no-balance action, no writes.
- Repeated with remaining inventory reduced to 1 crvUSD: crossing still uses the original inventory.
- Failed initial-inventory read: estimate unavailable instead of substituting remaining inventory.
- Checked first qualifying decay step (442), six-decimal auction inventory, and crossing after close.
- Existing approval, partial-take, above-market warning, and harvest interaction regressions passed.

## Results and limits

- `pnpm exec vitest run src/__tests__/components/VaultHarvestPanel.test.tsx`: 18 passed.
- `pnpm type-check`: passed, including generated Cloudflare types and worker TypeScript checks.
- `pnpm exec eslint src/components/VaultHarvestPanel.tsx src/__tests__/components/VaultHarvestPanel.test.tsx`: passed.
- `git diff --check`: passed before this record was added.
- Runtime validation includes the jsdom component replay and a Next.js development browser check of `/vaults/yscvx?auction-preview=no-balance`, Harvest tab. Verified future-crossing wording, separate Start/Market/Close labels, per-token units, and disabled no-balance action. Screenshot: `/private/tmp/auction-time-local-panel.png`. The development preview supplies its own timeline values; the calculation itself is exercised by the component regression fixture. No wallet transaction was sent. Production verification is performed separately after deployment.
- Retains the existing 45 bps conservative crossing adjustment. Rounded screenshot inputs predict 4h25m12s after kick, roughly 19m12s after a 4h6m observation; this is not a claim to reproduce Zaplet's exact displayed countdown.
- Price-source parity is unresolved by this change: yld uses cached Enso cvxCRV USD pricing and assumes crvUSD is $1; Zaplet obtains Curve route quotes. The displayed 7.01777 versus 6.9559 difference cannot be attributed precisely without synchronized source observations.

Ready to publish: contract-unit matching and the rendered component regression reproduce the reported timing error, while browser inspection verifies the layout changes. Source hashes are unchanged after rebase to current main. Exact live auction countdown parity remains limited by market-price source differences and the historical auction having already ended.
