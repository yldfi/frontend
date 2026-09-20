# Simulation USD pricing validation — 20 September 2026

## Behaviour

Enso is preferred over Tenderly, including nonzero Tenderly values that may be stale. Known vault shares use convertToAssets and the underlying asset's Enso price; direct Enso share pricing is a fallback. Valid positive finite Tenderly values remain usable when Enso cannot price a row. Zero, negative, missing and non-finite values are omitted from the API/UI. USD-derived impact and grouped totals require complete pricing. This does not certify either provider's positive quote as economically correct.

The simulation path no longer prices pxCVX/lpxCVX/cvgCVX at assumed CVX parity. Known underlyings are batched, HTTP 429 gets one bounded retry, and HTTP 400/404 batches fall back to independent lookups. Partial successes survive failures. All pricing shares a maximum four-second budget within the existing twelve-second request deadline. Discovery reads underlying decimals and caches only successful results.

## Environment and provenance

- Base revision: 181ff49886b916b2f444be115eb90b4f3d82eeed
- Local Node/Bun execution; captured Tenderly data and read-only live Enso + application-default Ethereum RPC. No signing, live transaction submission, production writes or deployment.
- Fixture source: saved Tenderly simulation `3b0f453a-2cb3-47c4-ac3c-01c3eb54531b`, replayed at block 26019865. Both quick/full replays returned zero USD for ysCVX and pxCVX. The original saved response body was unavailable; the captured production API confirmed the same amounts and zeros.
- The committed fixture contains the two relevant asset changes, synthetic wallet identity, and captured Enso price response. Prices are test evidence only, never runtime fallback constants.
- The live local handler used the captured Tenderly response, actual Enso SDK calls and actual RPC convertToAssets. HTTP 200 in 1292 ms, with both rows priced. This is fixture-based local runtime evidence, not production deployment verification.

## Checks

- `pnpm exec vitest run src/__tests__/api/simulate-pricing-replay.test.ts src/__tests__/lib/simulation-pricing.test.ts src/__tests__/components/SimulationModal.test.tsx src/__tests__/api/simulate.test.ts src/__tests__/lib/tenderly-simulation-bundle.test.ts`: 90 passed.
- Actual handler replay covers both zero values repaired, vault RPC failure with surviving pxCVX pricing, complete pricing outage with omitted fields, bounded 429 retry, and unsupported batch with one hanging isolated lookup.
- Pricing tests cover stale nonzero Tenderly replacement, valid Tenderly fallback, invalid/zero pricing rejection, no assumed CVX parity, underlying decimals, distinct same-vault amounts, conversion failure, partial timeout and a price arriving after 1.5 seconds.
- Rendered modal tests cover missing/invalid dollar values, priced/unpriced rows, hidden incomplete USD impact and sub-cent values.
- `pnpm exec tsc --noEmit`: passed.
- Publication check: `pnpm build` passed (Next.js middleware deprecation and framework Edge Runtime `process.cwd` warnings).
- ESLint on all six changed TypeScript/TSX files: passed.
- After the final guard for incomplete leverage group totals, reran modal tests, TypeScript and lint.

## Live evidence

```json
{
  "at": "2026-09-20T16:42:40.356Z",
  "status": 200,
  "elapsedMs": 1292,
  "assetChanges": [
    {
      "type": "send",
      "symbol": "ysCVX",
      "amount": "1746",
      "rawAmount": "1746000000000000000000",
      "address": "0x1fd0a85084fc61c397ac619c4f0ba2350ea1ce9e",
      "decimals": 18,
      "dollarValue": "3407.32393217649"
    },
    {
      "type": "receive",
      "symbol": "pxCVX",
      "amount": "1854.181861460125248314",
      "rawAmount": "1854181861460125248314",
      "address": "0xbce0cf87f513102f22232436cca2ca49e815c3ac",
      "decimals": 18,
      "dollarValue": "3623.9135602633337"
    }
  ]
}
```

## Tested content (SHA-256)

- `src/app/api/simulate/route.ts`: `7a792c7d8a79f0eb4c8d5e4ea31b75b6a3f0e07c22f78d08ab6cf18325aaf314`
- `src/lib/simulation-pricing.ts`: `bd036082e0f030b6654a823e9ca9728190197efc1bd57b0c65f8798652eb151e`
- `src/components/SimulationModal.tsx`: `7ec4ebd14143bc9a1cde72ef991083984229c29d9660214fbfaf2cfd11261f5a`
- `src/__tests__/api/simulate-pricing-replay.test.ts`: `fe8623c40920861838532a2aa6772459cce7a4c262149749619b66f56c753303`
- `src/__tests__/lib/simulation-pricing.test.ts`: `81ff009c89c9bced51e6821ef1209e49f1289c2f9f33a906f36a3f3bb6c608e1`
- `src/__tests__/components/SimulationModal.test.tsx`: `a2b8cee8632023b04772154e4f628ed62ad4bf6e84bd79db04ecc86ce51ac71e`
- `src/__tests__/fixtures/simulation-pricing-yscvx-pxcvx.json`: `f99f13a7cadf7148b09f9831c5e932c9d3ba9d560b900a979873fb5cdf1c3c7a`

## Limits and readiness

Local fixture replay and live pricing exercise support the change. Enso rate limits were observed during investigation; persistent rate limits or RPC failures can still prevent valuation, in which case valid Tenderly pricing is retained or dollar values are omitted. The production build passed before branch publication. No deployment was performed; a production release still needs its normal CI/merge checks and separate production verification.
