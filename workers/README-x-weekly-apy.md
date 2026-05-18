# Weekly APY X Worker

This worker renders `https://yldfi.co/social/weekly-apy`, screenshots it with
Cloudflare Browser Rendering, uploads the PNG to X, and posts it every Monday
at `10:00 UTC`.

## Setup

1. Create a KV namespace for social automation state.

```bash
wrangler kv namespace create SOCIAL_CACHE
```

2. Put the returned KV id into `workers/wrangler.x-weekly-apy.toml`.

3. Set production secrets.

```bash
wrangler secret put --config workers/wrangler.x-weekly-apy.toml SOCIAL_RUN_SECRET
wrangler secret put --config workers/wrangler.x-weekly-apy.toml CLOUDFLARE_ACCOUNT_ID
wrangler secret put --config workers/wrangler.x-weekly-apy.toml CLOUDFLARE_API_TOKEN
wrangler secret put --config workers/wrangler.x-weekly-apy.toml X_CLIENT_ID
wrangler secret put --config workers/wrangler.x-weekly-apy.toml X_CLIENT_SECRET
```

4. In the X Developer app settings, add this callback URL:

```text
https://yldfi-x-weekly-apy.michael-dimmock.workers.dev/oauth/callback
```

5. Deploy the worker.

```bash
wrangler deploy --config workers/wrangler.x-weekly-apy.toml
```

6. Connect the X account once.

```text
https://<worker-host>/oauth/start?secret=<SOCIAL_RUN_SECRET>
```

The OAuth callback stores the refresh token in `SOCIAL_CACHE`. The worker
updates the stored token when X rotates refresh tokens.

## Manual Checks

Check whether the worker is connected to X and whether today's post is marked
as posted:

```text
https://<worker-host>/status?secret=<SOCIAL_RUN_SECRET>
```

Render a protected PNG preview:

```text
https://<worker-host>/screenshot?secret=<SOCIAL_RUN_SECRET>
```

Run without posting:

```text
https://<worker-host>/run?secret=<SOCIAL_RUN_SECRET>
```

Post immediately:

```text
https://<worker-host>/run?secret=<SOCIAL_RUN_SECRET>&post=1
```

Re-post the same UTC day if needed:

```text
https://<worker-host>/run?secret=<SOCIAL_RUN_SECRET>&post=1&force=1
```
