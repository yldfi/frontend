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

function describeError(err: unknown, request: Request) {
  const url = new URL(request.url);
  const safe = (s: string, max: number) => s.length > max ? `${s.slice(0, max)}…` : s;
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return {
    message: safe(detail, 2000),
    meta: {
      method: request.method,
      pathname: url.pathname + url.search,
      country: request.headers.get("cf-ipcountry") ?? null,
      referer: request.headers.get("referer") ?? null,
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

export default {
  async fetch(request: Request, env: YldfiEdgeEnv, ctx: ExecutionContext): Promise<Response> {
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