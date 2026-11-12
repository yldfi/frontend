import type { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Rate limiting for the API routes, in two layers.
 *
 * The first layer is the in-memory limiter below: a per-isolate request log.
 * On Cloudflare Workers each isolate has its own state, so on its own it only
 * gives best-effort protection.
 *
 * The second layer is a Cloudflare Workers rate-limiting binding, declared in
 * `wrangler.jsonc`, whose counts are shared by all instances of the Worker in a
 * Cloudflare location. It is per-location and approximate, not an exact global
 * counter. `createSharedRateLimiter` combines the two: the in-memory check
 * short-circuits, then the binding makes the shared decision.
 */
export function createRateLimiter(maxRequests: number, windowMs: number = 60_000) {
  const log = new Map<string, number[]>();
  let lastCleanup = Date.now();

  function cleanup(now: number) {
    // Evict stale entries every 5 minutes to prevent unbounded growth
    if (now - lastCleanup < 5 * 60_000) return;
    lastCleanup = now;
    for (const [ip, timestamps] of log) {
      const recent = timestamps.filter((t) => now - t < windowMs);
      if (recent.length === 0) {
        log.delete(ip);
      } else {
        log.set(ip, recent);
      }
    }
  }

  return function isRateLimited(clientIp: string): boolean {
    const now = Date.now();
    cleanup(now);

    const entries = log.get(clientIp) ?? [];
    const recent = entries.filter((t) => now - t < windowMs);

    if (recent.length >= maxRequests) {
      log.set(clientIp, recent);
      return true;
    }

    recent.push(now);
    log.set(clientIp, recent);
    return false;
  };
}

/** Shape of a Workers rate-limiting binding (`env.NAME.limit({ key })`). */
interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

function getRateLimitBinding(bindingName: string): RateLimitBinding | null {
  try {
    const ctx = getCloudflareContext();
    const env = ctx.env as { [name: string]: RateLimitBinding | undefined };
    return env[bindingName] ?? null;
  } catch {
    // Not running in Cloudflare environment (local dev without bindings)
    return null;
  }
}

// A platform fault must not lock users out, so a failing binding fails open.
// Warn once per instance per binding name; the message carries no client IP.
const warnedBindings = new Set<string>();

function warnBindingFailure(bindingName: string): void {
  if (warnedBindings.has(bindingName)) return;
  warnedBindings.add(bindingName);
  console.warn(
    `[rate-limit] shared limiter ${bindingName} unavailable; using in-memory limiting only`,
  );
}

/**
 * Combines the in-memory limiter with a Workers rate-limiting binding shared
 * across instances in a Cloudflare location. Resolves to `true` when the caller
 * is over either limit.
 *
 * Fails open: a missing binding or a binding error never blocks requests.
 */
export function createSharedRateLimiter(
  bindingName: string,
  maxRequests: number,
  windowMs: number = 60_000,
) {
  const isRateLimitedInMemory = createRateLimiter(maxRequests, windowMs);

  return async function isRateLimited(clientIp: string): Promise<boolean> {
    if (isRateLimitedInMemory(clientIp)) return true;

    const binding = getRateLimitBinding(bindingName);
    if (!binding) return false;

    try {
      const outcome = await binding.limit({ key: clientIp });
      if (typeof outcome?.success !== "boolean") {
        warnBindingFailure(bindingName);
        return false;
      }
      return !outcome.success;
    } catch {
      warnBindingFailure(bindingName);
      return false;
    }
  };
}

export function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
