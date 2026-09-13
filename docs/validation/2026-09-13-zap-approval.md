# Zap approval recovery validation — 13 September 2026

Base revision: `9d888de62c46c7faf5e9ed296c33239834957c1c`; tested content is the local working-tree patch identified below. No publication or deployment was performed.

## Behavior

Every execution checks allowance using a fresh RPC head and an eth_call pinned to that block. After a successful approval receipt, the head must be at least the receipt block. Three bounded attempts (3 seconds each, 500 ms between attempts) distinguish unavailable data from a verified insufficient allowance. The verified value updates the wagmi query cache. Confirming a preview uses this same check. A recovered allowance clears stale pending-approval state; the page no longer retries execution automatically after a null preview result. Pending reads are cancelled on reset, wallet/chain/input/spender changes and unmount. Successful receipts are required before continuing a zero-reset approval sequence.

## Environment and provenance

macOS; repository pnpm lockfile installed with `pnpm install --frozen-lockfile`. Vitest/jsdom executes the real useZapActions hook with controlled wallet, receipt, cache and simulation boundaries. The page component suite exercises the null-preview behavior. A separate real viem transport test checks calldata encoding and block selection.

Anvil ran exclusively at `127.0.0.1:18549`, chain ID 31337, without a mainnet fork or upstream provider. A local Solidity allowance-mapping fixture was compiled with Solc 0.8.33. Anvil's disposable unlocked account deployed and approved this fixture. No production wallet, signing key, transaction, notification or listener was used. The Vitest configuration loads the existing environment file, but this replay explicitly targets only localhost and its fixture. The disposable replay harness and fixture are retained in `/private/tmp/yld-approval-validation/`.

## Scenarios and results

- USDT and USDC: approval → successful preview → confirm → exactly one send, while query data remains stale.
- USDT zero-reset: waits for both successful receipts; a reverted reset does not trigger the second approval or a zap.
- Failed allowance reads: retryable error, no approval request/send, successful manual retry.
- Late cache recovery: approval card state clears and the action becomes idle.
- Delayed reads followed by reset, changed input, changed wallet or unmount: no simulation/send continuation.
- RPC transport: rejects a head before the receipt block; encodes allowance(owner, spender); pins eth_call to the recovered block.
- Unresponsive RPC: bounded failure after three attempts, never treated as zero allowance.
- Page preview returning null: one execution attempt, no fall-through send.

`pnpm exec vitest run src/__tests__/hooks/useZapActions.preview.test.ts src/__tests__/lib/zap-allowance.test.ts src/__tests__/components/ZapPageContent.test.tsx`: **49 passed**.

Isolated Anvil replay: **1 passed**. Pre-approval allowance was zero. After mining approval, a deliberately lagging first head was rejected; the second head and pinned call returned 10804821 units. Evidence:

```json
{
  "chainId": 31337,
  "token": "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  "approvalHash": "0xb1cd523482e0adbd3737094cdbd52d7a72b2ba2e7f9689966b35bcb58a765067",
  "approvalBlock": "2",
  "allowance": "10804821",
  "headReads": 2
}
```

`pnpm type-check`: passed, including generated Cloudflare declaration checks and app/worker TypeScript. After final edits, `pnpm exec tsc --noEmit`, targeted ESLint and `git diff --check` also passed.

## Limitations and readiness

The old `useZapActions.integration.test.ts` suite reports 10 failures both on this patch and on the unchanged base hook. These are pre-existing fixture/API mismatches (e.g. it mocks useSendTransaction while the hook uses useSendTx); that suite is unchanged. The focused hook, component and transport tests above are green.

The real local chain replay validates a minimal allowance fixture, not deployed USDT/USDC implementations or Enso routing. The full approval/preview flow is exercised with controlled dependency fixtures, not a live wallet/browser transaction. The earlier Brave observations establish the production symptom and refresh workaround, not validation of this new code. No production claim is made.

The patch is ready for review based on the reproduced regression, failure/cancellation coverage, local RPC replay and static checks. Publishing/deployment and subsequent production verification remain separate steps.

## Release validation refresh

The release branch is based on current origin/main. Its base tree is identical to the earlier validated base. All six content hashes still match. Re-ran the real local Anvil replay and focused regressions together: 50 passed. Full unit suite: 1,809 passed across 81 files.

## Tested content (SHA-256)

- `src/hooks/useZapActions.ts`: `cce02bf1c0314c73e90338d3afb9d17ceeb69c6d9cf3d40517451568234c7027`
- `src/lib/zap-allowance.ts`: `2a2ac587b1cb317d74c57e85d0c96b2a23667dfd8f44e521bd81108f9c2e6651`
- `src/components/ZapPageContent.tsx`: `3c5b55114d84a071ce4cdb5055ed69306ce072338462b0d09efa1a9f664cf467`
- `src/__tests__/hooks/useZapActions.preview.test.ts`: `ce9f4a0583ed19022332758eb6e4396a25236076b95d5e900ed9a9a6b9036295`
- `src/__tests__/lib/zap-allowance.test.ts`: `0b852a1daa6aaeb14b9f0b4a19609970ba5bd0cf06da273930080f0071e8d23d`
- `src/__tests__/components/ZapPageContent.test.tsx`: `e3e5d4aeea5a298f0c4c4b70e162f1b62ec0d90fcaf725ea238a9c7167a88738`
