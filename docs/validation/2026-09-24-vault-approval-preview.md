# Vault approval and preview handoff validation — 24 September 2026

Base: `3d910e162288a4d5e30132b83941278d62d11edd` (`origin/main`). Tested source SHA-256:

- `src/components/VaultPageContent.tsx`: `675c0a0ddf046be74064470e6c830da77fc0aaf04615c6f306d200adf618b253`
- `src/hooks/useVaultActions.ts`: `b591794875fef49326ee21b54bec27ad99b2ef8d1f113de6313b2b12613e468f`
- `src/__tests__/hooks/useVaultActions.preview.test.ts`: `d3b18ecdfa878358362e5c10791ae4f7fa92d41c60b8d68191ed622a8d2cc9d7`

## Environment and data

Local macOS checkout with installed pnpm dependencies. Vitest/jsdom exercised the real vault action hook with controlled wagmi approval/deposit receipt states, a simulated Tenderly timeout response, and a mocked transaction sender. No production wallet, signing key, or transaction was used. The production Next.js build ran at `http://localhost:3107/vaults/yscvx` in an isolated agent-browser session.

## Scenarios and results

- With an earlier approval receipt still successful, a deposit send remains `waitingTx`; the earlier receipt no longer masks its status.
- With that approval receipt, preview returns a simulation-unavailable result without sending. Confirmation sends exactly one deposit and shows `waitingTx`.
- The page's post-approval transition now calls the same preview as a direct deposit when preview is enabled; the form is restored so its modal can render. With preview disabled, it starts the deposit directly.
- Local production page renders the ysCVX deposit form and the withdrawal form after switching tabs. The observed Brave production symptom was a completely blank action card after CVX approval.

Checks: `pnpm type-check`, targeted ESLint, `pnpm build`, `git diff --check`, focused Vitest (115 passed), full unit suite (1,840 passed). All passed.

## Limitations and readiness

The local browser did not connect a wallet, so it did not complete an actual approval or withdrawal transaction. The controlled receipt/preview replay covers the transaction state and send boundary; the browser check covers form rendering. Production deployment and live verification are separate from this record. The change is ready for review because it fixes the observed blank-state condition and preview bypass, with a regression replay and clean build.
