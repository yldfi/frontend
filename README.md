<p align="center">
  <img src="public/logo-256.png" alt="yldfi" width="128" height="128">
</p>

<h1 align="center">yldfi</h1>

<p align="center">
  Automated yield vaults on Ethereum
</p>

<p align="center">
  <a href="https://yldfi.co">Website</a> •
  <a href="https://docs.yldfi.co">Docs</a> •
  <a href="https://github.com/yldfi">GitHub</a>
</p>

---

## About

yldfi provides automated yield vaults built on Yearn V3's tokenized strategy architecture, following the ERC-4626 standard. Deposit your tokens and earn auto-compounding returns without manual intervention.

## Development

```bash
# Install dependencies
pnpm install

# Run development server
pnpm dev

# Build for production
pnpm build
```

## Deployment

Deployed to Cloudflare Workers using OpenNext:

```bash
pnpm build:cloudflare
wrangler deploy
```

## Environment Variables

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

## License

MIT
