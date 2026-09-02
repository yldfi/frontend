const BROWSER_RENDERING_ENDPOINT =
  "https://api.cloudflare.com/client/v4/accounts";
const DEFAULT_SITE_URL = "https://yldfi.co";
const DEFAULT_RENDER_PATH = "/social/weekly-apy";
const DEFAULT_TWEET_COPY = "Weekly vault yields are live.\n\nyldfi.co";
const MAX_X_IMAGE_BYTES = 5 * 1024 * 1024;
const OAUTH_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "media.write",
  "offline.access",
];
const REFRESH_TOKEN_KEY = "x:oauth:refresh-token";
const OAUTH_STATE_PREFIX = "x:oauth:state:";
const POSTED_KEY_PREFIX = "x:weekly-apy:posted:";
const LAST_RUN_KEY = "x:weekly-apy:last-run";

interface Env extends XWeeklyApyEnv {
  CLOUDFLARE_API_TOKEN: string;
  SOCIAL_RUN_SECRET?: string;
  X_CLIENT_ID: string;
  X_CLIENT_SECRET?: string;
  X_REDIRECT_URI?: string;
  X_REFRESH_TOKEN?: string;
}

interface BrowserImage {
  browserMsUsed: string | null;
  bytes: ArrayBuffer;
  renderUrl: string;
}

interface XTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface XMediaUploadResponse {
  data?: {
    id?: string;
    media_key?: string;
    size?: number;
  };
  detail?: string;
  errors?: XApiError[];
  title?: string;
}

interface XCreatePostResponse {
  data?: {
    id?: string;
    text?: string;
  };
  detail?: string;
  errors?: XApiError[];
  status?: number;
  title?: string;
  type?: string;
}

interface XApiError {
  detail?: string;
  status?: number;
  title?: string;
  type?: string;
}

interface RunOptions {
  dryRun?: boolean;
  force?: boolean;
  source: "cron" | "manual";
}

interface OAuthState {
  codeVerifier: string;
  redirectUri: string;
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const scheduledAt = new Date(controller.scheduledTime);

    try {
      const result = await runWeeklyPost(env, scheduledAt, {
        dryRun: isTruthy(env.X_DRY_RUN),
        source: "cron",
      });
      await saveLastRun(env, result);
      console.log(JSON.stringify(result));
    } catch (error) {
      await saveLastRun(env, {
        ok: false,
        date: toDateKey(scheduledAt),
        error: getErrorMessage(error),
        source: "cron",
      });
      console.error("weekly APY X post failed", error);
      throw error;
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        return json({ ok: true });
      }

      if (url.pathname === "/status") {
        if (!isAuthorized(request, env)) return unauthorized();

        const scheduledAt = parseScheduledDate(url.searchParams.get("date"));
        return json(await getStatus(env, scheduledAt));
      }

      if (url.pathname === "/run") {
        if (!isAuthorized(request, env)) return unauthorized();

        const scheduledAt = parseScheduledDate(url.searchParams.get("date"));
        try {
          const result = await runWeeklyPost(env, scheduledAt, {
            dryRun: !isTruthy(url.searchParams.get("post")) && !isFalsey(url.searchParams.get("dry")),
            force: isTruthy(url.searchParams.get("force")),
            source: "manual",
          });
          await saveLastRun(env, result);
          return json(result);
        } catch (error) {
          await saveLastRun(env, {
            ok: false,
            date: toDateKey(scheduledAt),
            error: getErrorMessage(error),
            source: "manual",
          });
          throw error;
        }
      }

      if (url.pathname === "/screenshot") {
        if (!isAuthorized(request, env)) return unauthorized();

        const scheduledAt = parseScheduledDate(url.searchParams.get("date"));
        const image = await renderWeeklyApyImage(env, scheduledAt);
        return new Response(image.bytes, {
          headers: {
            "cache-control": "no-store",
            "content-type": "image/png",
            ...(image.browserMsUsed ? { "x-browser-ms-used": image.browserMsUsed } : {}),
          },
        });
      }

      if (url.pathname === "/oauth/start") {
        if (!isAuthorized(request, env)) return unauthorized();
        return startOAuth(request, env);
      }

      if (url.pathname === "/oauth/callback") {
        return completeOAuth(request, env);
      }

      return json({
        ok: true,
        endpoints: {
          health: "/health",
          oauthStart: "/oauth/start?secret=...",
          status: "/status?secret=...",
          screenshot: "/screenshot?secret=...",
          dryRun: "/run?secret=...",
          postNow: "/run?secret=...&post=1",
        },
      });
    } catch (error) {
      console.error("weekly APY worker request failed", error);
      return json({ ok: false, error: getErrorMessage(error) }, { status: 500 });
    }
  },
};

async function runWeeklyPost(env: Env, scheduledAt: Date, options: RunOptions) {
  const dateKey = toDateKey(scheduledAt);
  const postedKey = `${POSTED_KEY_PREFIX}${dateKey}`;

  if (!options.dryRun && !options.force && env.SOCIAL_CACHE) {
    const existing = await env.SOCIAL_CACHE.get(postedKey, "json");
    if (existing) {
      return {
        ok: true,
        date: dateKey,
        skipped: true,
        reason: "already-posted",
        existing,
      };
    }
  }

  const image = await renderWeeklyApyImage(env, scheduledAt);
  if (image.bytes.byteLength > MAX_X_IMAGE_BYTES) {
    throw new Error(
      `Rendered image is ${image.bytes.byteLength} bytes, above X image limit ${MAX_X_IMAGE_BYTES}`
    );
  }

  if (options.dryRun) {
    return {
      ok: true,
      browserMsUsed: image.browserMsUsed,
      date: dateKey,
      dryRun: true,
      imageBytes: image.bytes.byteLength,
      renderUrl: image.renderUrl,
      source: options.source,
    };
  }

  const accessToken = await getXAccessToken(env);
  const mediaId = await uploadXImage(accessToken, image.bytes);
  const post = await createXPost(accessToken, mediaId, env.X_WEEKLY_COPY || DEFAULT_TWEET_COPY);

  const result = {
    ok: true,
    browserMsUsed: image.browserMsUsed,
    date: dateKey,
    dryRun: false,
    imageBytes: image.bytes.byteLength,
    mediaId,
    renderUrl: image.renderUrl,
    source: options.source,
    tweetId: post.id,
  };

  if (env.SOCIAL_CACHE) {
    await env.SOCIAL_CACHE.put(postedKey, JSON.stringify(result), {
      expirationTtl: 60 * 60 * 24 * 180,
    });
  }

  return result;
}

async function getStatus(env: Env, scheduledAt: Date) {
  const dateKey = toDateKey(scheduledAt);
  const postedKey = `${POSTED_KEY_PREFIX}${dateKey}`;
  const kvRefreshToken = await env.SOCIAL_CACHE?.get(REFRESH_TOKEN_KEY);
  const postedToday = await env.SOCIAL_CACHE?.get(postedKey, "json");
  const lastRun = await env.SOCIAL_CACHE?.get(LAST_RUN_KEY, "json");

  return {
    ok: true,
    date: dateKey,
    hasSocialCache: Boolean(env.SOCIAL_CACHE),
    hasKvRefreshToken: Boolean(kvRefreshToken),
    hasFallbackRefreshTokenSecret: Boolean(env.X_REFRESH_TOKEN),
    tokenSource: kvRefreshToken ? "kv" : env.X_REFRESH_TOKEN ? "secret" : "missing",
    postedToday: Boolean(postedToday),
    postedTodayRecord: postedToday || null,
    lastRun: lastRun || null,
  };
}

async function saveLastRun(env: Env, result: unknown): Promise<void> {
  if (!env.SOCIAL_CACHE) return;

  await env.SOCIAL_CACHE.put(
    LAST_RUN_KEY,
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      result,
    }),
    { expirationTtl: 60 * 60 * 24 * 180 }
  );
}

async function renderWeeklyApyImage(env: Env, scheduledAt: Date): Promise<BrowserImage> {
  requireEnv(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");
  requireEnv(env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");

  const renderUrl = buildRenderUrl(env, scheduledAt);
  const endpoint = `${BROWSER_RENDERING_ENDPOINT}/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/screenshot`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url: renderUrl,
      gotoOptions: {
        waitUntil: "networkidle0",
        timeout: 45000,
      },
      screenshotOptions: {
        fullPage: false,
        type: "png",
      },
      selector: ".weekly-apy-card",
      viewport: {
        width: 1200,
        height: 675,
        deviceScaleFactor: 1,
      },
      waitForSelector: {
        selector: ".weekly-apy-card",
        timeout: 45000,
        visible: true,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Cloudflare screenshot failed: ${response.status} ${await response.text()}`);
  }

  return {
    browserMsUsed: response.headers.get("x-browser-ms-used"),
    bytes: await response.arrayBuffer(),
    renderUrl,
  };
}

async function getXAccessToken(env: Env): Promise<string> {
  requireEnv(env.X_CLIENT_ID, "X_CLIENT_ID");

  const refreshToken = (await env.SOCIAL_CACHE?.get(REFRESH_TOKEN_KEY)) || env.X_REFRESH_TOKEN;
  requireEnv(refreshToken, "X_REFRESH_TOKEN or SOCIAL_CACHE refresh token");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (!env.X_CLIENT_SECRET) {
    body.set("client_id", env.X_CLIENT_ID);
  }

  const token = await fetchXToken(env, body);
  if (!token.access_token) {
    throw new Error("X refresh token response did not include an access token");
  }

  if (token.refresh_token && env.SOCIAL_CACHE) {
    await env.SOCIAL_CACHE.put(REFRESH_TOKEN_KEY, token.refresh_token);
  }

  return token.access_token;
}

async function uploadXImage(accessToken: string, image: ArrayBuffer): Promise<string> {
  const response = await fetch("https://api.x.com/2/media/upload", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      media: arrayBufferToBase64(image),
      media_category: "tweet_image",
      media_type: "image/png",
      shared: false,
    }),
  });
  const result = (await parseXJson(response)) as XMediaUploadResponse;
  const mediaId = result.data?.id;

  if (!response.ok || !mediaId) {
    throw new Error(`X media upload failed: ${formatXError(response, result)}`);
  }

  return mediaId;
}

async function createXPost(
  accessToken: string,
  mediaId: string,
  text: string
): Promise<{ id: string; text?: string }> {
  const response = await fetch("https://api.x.com/2/tweets", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text,
      media: {
        media_ids: [mediaId],
      },
    }),
  });
  const result = (await parseXJson(response)) as XCreatePostResponse;
  const postId = result.data?.id;

  if (!response.ok || !postId) {
    throw new Error(`X post failed: ${formatXError(response, result)}`);
  }

  return {
    id: postId,
    text: result.data?.text,
  };
}

async function startOAuth(request: Request, env: Env): Promise<Response> {
  requireEnv(env.X_CLIENT_ID, "X_CLIENT_ID");
  if (!env.SOCIAL_CACHE) {
    throw new Error("SOCIAL_CACHE KV binding is required for OAuth setup");
  }

  const redirectUri = getRedirectUri(request, env);
  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);

  await env.SOCIAL_CACHE.put(
    `${OAUTH_STATE_PREFIX}${state}`,
    JSON.stringify({ codeVerifier, redirectUri } satisfies OAuthState),
    { expirationTtl: 600 }
  );

  const params = new URLSearchParams({
    client_id: env.X_CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    state,
  });

  return Response.redirect(`https://x.com/i/oauth2/authorize?${params.toString()}`, 302);
}

async function completeOAuth(request: Request, env: Env): Promise<Response> {
  requireEnv(env.X_CLIENT_ID, "X_CLIENT_ID");
  if (!env.SOCIAL_CACHE) {
    throw new Error("SOCIAL_CACHE KV binding is required for OAuth setup");
  }

  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return html(`X authorization failed: ${escapeHtml(error)}`, { status: 400 });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return html("Missing OAuth code or state.", { status: 400 });
  }

  const stateKey = `${OAUTH_STATE_PREFIX}${state}`;
  const storedState = await env.SOCIAL_CACHE.get<OAuthState>(stateKey, "json");
  if (!storedState) {
    return html("OAuth state expired or invalid.", { status: 400 });
  }
  await env.SOCIAL_CACHE.delete(stateKey);

  const body = new URLSearchParams({
    code,
    code_verifier: storedState.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: storedState.redirectUri,
  });
  if (!env.X_CLIENT_SECRET) {
    body.set("client_id", env.X_CLIENT_ID);
  }

  const token = await fetchXToken(env, body);
  if (!token.refresh_token) {
    throw new Error("X OAuth response did not include a refresh token. Confirm offline.access scope is enabled.");
  }

  await env.SOCIAL_CACHE.put(REFRESH_TOKEN_KEY, token.refresh_token);
  return html("X account connected. The weekly APY worker can now post using the stored refresh token.");
}

async function fetchXToken(env: Env, body: URLSearchParams): Promise<XTokenResponse> {
  const headers: HeadersInit = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (env.X_CLIENT_SECRET) {
    headers.authorization = `Basic ${stringToBase64(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`)}`;
  }

  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers,
    body,
  });
  const token = (await response.json()) as XTokenResponse;

  if (!response.ok || token.error) {
    throw new Error(
      `X OAuth token request failed: ${response.status} ${token.error || ""} ${token.error_description || ""}`.trim()
    );
  }

  return token;
}

function buildRenderUrl(env: Env, scheduledAt: Date): string {
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  const renderPath = env.SOCIAL_RENDER_PATH || DEFAULT_RENDER_PATH;
  const url = renderPath.startsWith("http")
    ? new URL(renderPath)
    : new URL(renderPath, siteUrl);

  url.searchParams.set("date", toDateKey(scheduledAt));
  return url.toString();
}

function getRedirectUri(request: Request, env: Env): string {
  if (env.X_REDIRECT_URI) return env.X_REDIRECT_URI;
  return new URL("/oauth/callback", request.url).toString();
}

function isAuthorized(request: Request, env: Env): boolean {
  const secret = env.SOCIAL_RUN_SECRET;
  if (!secret) return false;

  const url = new URL(request.url);
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return timingSafeEqual(url.searchParams.get("secret") || bearer || "", secret);
}

function unauthorized(): Response {
  return json({ ok: false, error: "Unauthorized" }, { status: 401 });
}

function parseScheduledDate(value: string | null): Date {
  if (!value) return new Date();
  const parsed = new Date(`${value}T09:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isTruthy(value: string | undefined | null): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function isFalsey(value: string | undefined | null): boolean {
  return value === "0" || value === "false" || value === "no";
}

function requireEnv(value: string | undefined | null, name: string): asserts value is string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><body>${body}</body>`, {
    ...init,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      ...init.headers,
    },
  });
}

async function parseXJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { errors: [{ title: text || response.statusText }] };
  }
}

function formatXError(response: Response, body: XMediaUploadResponse | XCreatePostResponse): string {
  const messages = [
    body.title,
    body.detail,
    ...(body.errors?.map((error) => error.detail || error.title) || []),
  ].filter(Boolean);

  return `${response.status}${messages.length ? ` ${messages.join("; ")}` : ""}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const maxLength = Math.max(a.length, b.length);
  for (let i = 0; i < maxLength; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

function stringToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function randomBase64Url(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
