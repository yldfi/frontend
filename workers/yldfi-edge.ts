import openNextWorker from "../.open-next/worker.js";

interface YldfiEdgeEnv {
  ASSETS: Fetcher;
  VAULT_CACHE: KVNamespace;
  EXPLORER_CACHE: KVNamespace;
  LOGS: D1Database;
}

type OpenNextWorker = {
  fetch: (request: Request, env: YldfiEdgeEnv, ctx: ExecutionContext) => Promise<Response>;
};

/** Origin + path of the referer, without query string or fragment. */
function refererWithoutQuery(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.origin + parsed.pathname;
  } catch {
    return null;
  }
}

function describeError(err: unknown, request: Request) {
  const url = new URL(request.url);
  const safe = (s: string, max: number) => s.length > max ? `${s.slice(0, max)}…` : s;
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return {
    message: safe(detail, 2000),
    meta: {
      method: request.method,
      // Path only: query strings can carry wallet addresses and signed
      // share-link parameters, and this row is stored in D1.
      pathname: url.pathname,
      country: request.headers.get("cf-ipcountry") ?? null,
      referer: refererWithoutQuery(request.headers.get("referer")),
    },
  };
}

async function logToD1(db: D1Database, message: string, meta: Record<string, unknown>) {
  try {
    await db
      .prepare("INSERT INTO logs (timestamp, level, source, message, meta) VALUES (?, ?, ?, ?, ?)")
      .bind(new Date().toISOString(), "error", "frontend", message, JSON.stringify(meta))
      .run();
  } catch (e) {
    console.error("Failed to write frontend error to D1:", e);
  }
}

/**
 * Workers Caching keys responses by path (and a few other dimensions), not by country.
 * Our Geo-block is regulatory, so without this a cached page could be served to a region
 * we must block. `Vary: cf-ipcountry` stores a separate cached variant per country; blocked
 * regions get an uncacheable (no-store) 451, so no cacheable variant exists for them and
 * their request always falls through to the Worker.
 */
export function withCountryVary(request: Request, response: Response): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return response;
  const headers = new Headers(response.headers);
  headers.append("Vary", "cf-ipcountry");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Static images and fonts are served by Workers static assets before the
// Worker runs, so one that reaches the Worker does not exist. Answer it with a
// bare 404 instead of rendering the Next.js not-found page: scanner bursts of
// asset-shaped probes otherwise cost a full render each (Workers Free 10 ms CPU).
// /api/ is excluded because API routes may legitimately serve images.
const MISSING_ASSET_PATH = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)$/i;

export function isMissingStaticAsset(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const { pathname } = new URL(request.url);
  return !pathname.startsWith("/api/") && MISSING_ASSET_PATH.test(pathname);
}

export default {
  async fetch(request: Request, env: YldfiEdgeEnv, ctx: ExecutionContext): Promise<Response> {
    if (isMissingStaticAsset(request)) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=300" },
      });
    }
    try {
      const openNext = openNextWorker as OpenNextWorker;
      return withCountryVary(request, await openNext.fetch(request, env, ctx));
    } catch (err) {
      const { message, meta } = describeError(err, request);
      console.error(`[frontend] uncaught server error: ${message}`, meta);
      ctx.waitUntil(logToD1(env.LOGS, message, meta));
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};