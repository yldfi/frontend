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
wrangler secret put --config workers/wrangler.x-weekly-apy.toml CLOUDFLARE_API_TOKEN
wrangler secret put --config workers/wrangler.x-weekly-apy.toml X_CLIENT_ID
wrangler secret put --config workers/wrangler.x-weekly-apy.toml X_CLIENT_SECRET
# Optional: Telegram alert when a cron run fails
wrangler secret put --config workers/wrangler.x-weekly-apy.toml TELEGRAM_BOT_TOKEN
wrangler secret put --config workers/wrangler.x-weekly-apy.toml TELEGRAM_CHAT_ID
```

`CLOUDFLARE_ACCOUNT_ID` is a plain `[vars]` entry in `workers/wrangler.x-weekly-apy.toml`, not a secret.

4. In the X Developer app settings, add this callback URL:

```text
https://<worker-host>/oauth/callback
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

Send the secret as a header, not in the URL:

```bash
# SOCIAL_RUN_SECRET must be in your shell environment; never paste it into a URL.
curl -s -H "Authorization: Bearer $SOCIAL_RUN_SECRET" "https://<worker-host>/status"
curl -s -H "Authorization: Bearer $SOCIAL_RUN_SECRET" "https://<worker-host>/screenshot" -o weekly-apy.png
curl -s -H "Authorization: Bearer $SOCIAL_RUN_SECRET" "https://<worker-host>/run"                 # dry run
curl -s -X POST -H "Authorization: Bearer $SOCIAL_RUN_SECRET" "https://<worker-host>/run?post=1"   # post now
curl -s -X POST -H "Authorization: Bearer $SOCIAL_RUN_SECRET" "https://<worker-host>/run?post=1&force=1"
```

The first call reports whether the worker is connected to X and whether today's
post is already marked as posted; the second renders a protected PNG preview;
the third runs without posting; the last two post immediately, the final one
even if today is already marked as posted.

The `?secret=<SOCIAL_RUN_SECRET>` query form still works, but a secret in a query
string ends up in browser history, shell history and request logs. Use it only
for `/oauth/start`, which must be opened in a browser (it redirects to X) — and
rotate `SOCIAL_RUN_SECRET` afterwards if that URL may have been recorded
anywhere.

### After a failure alert

The Telegram alert means the Monday cron did not post. Check `/status`, then run
the post-now command with `&date=<YYYY-MM-DD from the alert>` appended to the
`/run?post=1` URL; a `/run` without `post=1` only renders.
