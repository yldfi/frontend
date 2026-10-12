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

export default {
  async fetch(request: Request, env: YldfiEdgeEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const openNext = openNextWorker as OpenNextWorker;
      return await openNext.fetch(request, env, ctx);
    } catch (err) {
      const { message, meta } = describeError(err, request);
      console.error(`[frontend] uncaught server error: ${message}`, meta);
      ctx.waitUntil(logToD1(env.LOGS, message, meta));
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};