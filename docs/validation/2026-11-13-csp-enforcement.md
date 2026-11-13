# Content security policy enforcement — 13 November 2026

## What changed

Production now enforces the content security policy that was previously sent only as `Content-Security-Policy-Report-Only`: browsers block what it refuses instead of just logging it. Development is unchanged and still sends the full policy report-only next to the enforced `frame-ancestors` header. The allowed sources are the same, plus the MetaMask SDK relay host (found by the phone check below) and the origin of the local fork RPC when one is configured.

## Evidence before the change

13 November 2026, production, a browser session from an allowed region, with the policy report-only:

- No wallet: home, zap, rewards and the vault pages — zero violations.
- With a connected read-only test wallet: zap with a live quote and the token selector, home, the vault pages (deposit, withdraw and zap tabs), rewards, the account dialog — one violation, `connect-src` for the host of the wallet's ENS avatar (see the note in `src/lib/csp.ts`; no visible effect).
- Wallet connect dialog: the WalletConnect, MetaMask and Rainbow QR flows and the Base option — zero violations.
- Phone-browser emulation (two device profiles) against a production build with the policy enforced: page load and the Rainbow and Base options — zero violations; MetaMask — blocked websocket to the MetaMask SDK relay (fixed in this change by allowing that host); the WalletConnect option's own dialog requests a web font stylesheet from a third-party font host, which stays blocked (the dialog falls back to a system font).
- Desktop, production build with the policy enforced, connected read-only test wallet: same pages as above; the only block is the ENS avatar lookup.

## Not exercised

- The transaction preview with a real wallet under the enforced policy.
- Sending a transaction.
- The Base/Coinbase wallet popup.
- The site running inside Safe{Wallet}.
- A real phone with a wallet app installed (deep link and return).
- The MetaMask install helper, which loads a frame from a MetaMask host; the frame is blocked and nothing visible depends on it.

## Still broad by design

- `img-src https:` allows images from any secure host.
- `script-src 'unsafe-inline'` is required by the prerendered pages.

## After deploy

- The six pages above load with no console policy errors.
- Connect a wallet, get a quote and open the preview.
- On a phone browser: connect with MetaMask and with WalletConnect.
- Open the site as a Safe App.

## Rollback

Revert this change (or roll the site Worker back); the previous behaviour returns with no data migration.
