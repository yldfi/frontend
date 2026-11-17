<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## What this repo is

DeFi yield-vault frontend: deposit, withdraw and zap move real user money on Ethereum mainnet.
Next.js App Router built with OpenNext and served from Cloudflare Workers; three Workers are deployed from this repo.
Quote, approval and transaction-building code is money-path code — change it carefully.

Package manager is pnpm 10: `pnpm install --frozen-lockfile`, `pnpm dev` for the dev server, `pnpm build` for a production build.

## Checks you can run safely

Run these in order and stop at the first failure:

1. `pnpm lint`
2. `pnpm type-check` — checks the committed Cloudflare types, then `tsc` for the app and for `workers/`
3. `pnpm exec vitest run --project unit <path>` — a single spec while iterating
4. `pnpm test:unit` — the unit project
5. `pnpm test:sweep` — mocked, slow (about 2,700 cases); CI shards it with `SWEEP_PART` and `SWEEP_TOTAL`
6. Worker replays: `node workers/testing/replay-vault-cache.mjs` and `node workers/testing/replay-vault-history.mjs` — fixture-backed, no network

## Commands that hit live, paid services

**`pnpm test:integration` calls live upstreams.** The integration project talks to live, rate-limited and billed upstream services (the Enso routing API, an archive RPC and token-holder APIs). It runs nightly in CI (`.github/workflows/nightly.yml`). Do not run it locally unless the maintainer asks, and never loop it.

`pnpm test:e2e` runs in CI on every pull request and push to main (`.github/workflows/ci.yml`): it starts the app server (`pnpm dev` locally, `pnpm start` on CI after the build); it mocks `/api/vaults`, `/api/history`, `/api/enso/tokens` and `/api/enso/prices`, and replays `/api/kong/*` and `/api/merkl/*` from `e2e/fixtures/upstream-responses.json`, calling live for anything unrecorded; every other request (other `/api/*` routes, browser RPC) goes to the real service. Do not run it locally unless the maintainer asks. A failing e2e job blocks the site deploy.

`pnpm test` runs the unit project only; it does not reach the network.
The pre-commit hook runs `pnpm lint-staged`, and CI always names its projects, so no workflow or hook depends on bare `pnpm test`.

## Environment

`cp .env.example .env.local` lists every name the app reads; values are empty, and optional tuning names are commented out with their defaults.
Ask the maintainer for real values.
Never print, commit or paste a secret, and never read `.env.local` into a transcript.
Production secrets are Cloudflare Worker secrets, not a committed file.
Optional cache-worker variables are listed in `workers/.dev.vars.example`.
In `pnpm dev` the site reaches the cache worker one of two ways: with `YLDFI_DEV_REMOTE_BINDINGS=1` (needs Cloudflare credentials), through a remote `CACHE_WORKER` binding to the deployed worker; without it, through `CACHE_WORKER_URL` pointing at a locally running cache worker. See `.env.example`; `pnpm dev` starts without credentials either way.

## Deploy map

| Worker | Config | Entry | Deployed by |
|---|---|---|---|
| `yldfi` (the site, routes `yldfi.co/*`, `www.yldfi.co/*`) | `wrangler.jsonc` | `workers/yldfi-edge.ts` wrapping the OpenNext build in `.open-next/` | CI job `deploy` on push to `main`, after lint, type-check, unit, sweep and browser (e2e) tests and the Cloudflare build |
| `yldfi-cache` (cron vault cache to KV, D1 and R2; no public address, the site calls it through the `CACHE_WORKER` service binding) | `workers/wrangler.toml` | `workers/vault-cache.ts` | CI job `deploy-cache-worker` on push to `main` |
| `yldfi-x-weekly-apy` (weekly X post) | `workers/wrangler.x-weekly-apy.toml` | `workers/x-weekly-apy.ts` | by hand; see `workers/README-x-weekly-apy.md` |

Merging to `main` deploys the first two automatically.
The manual equivalent of the site deploy is `pnpm run deploy` (Cloudflare build, populate the static-assets cache, `wrangler deploy`); it must be `pnpm run deploy` because `pnpm deploy` is pnpm's own built-in command.
Rollback is `wrangler rollback` or the Cloudflare dashboard's deployment list; maintainer only.

## Conventions

- Ethereum address literals must be EIP-55 checksummed or all-lowercase; lint enforces it (`evm-address/checksum`).
- Commit subjects are "Area: plain sentence"; branches are `fix/...`, `feat/...`, `perf/...`.
- The generated `cloudflare-runtime.d.ts`, `workers/worker-runtime.d.ts` and `workers/*-env.d.ts` files are committed; regenerate them with `pnpm typegen`, never edit by hand.
- Read `node_modules/next/dist/docs/` before using a Next.js API — this version differs from older docs.
- The lending market was removed in November 2026 (it had no open loans); old `/vaults/[id]/lending` URLs redirect to the vault page. Do not reintroduce lending code without the maintainer.
- Do not re-enable Workers Caching in `wrangler.jsonc`: a cached page once leaked past the regulatory geo-block in `src/middleware.ts`.
- Risky money-path changes get a dated validation record in `docs/validation/`.
