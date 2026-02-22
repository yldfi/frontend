import type { NextRequest } from "next/server";

/**
 * Simple in-memory rate limiter with automatic eviction.
 * Note: On Cloudflare Workers, each isolate has its own state.
 * This provides best-effort protection, not a distributed guarantee.
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

export function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
