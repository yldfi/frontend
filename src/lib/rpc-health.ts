/**
 * Provider health for the server-side RPC fallback lists.
 *
 * A provider that just timed out is still tried, but last, for a short while:
 * otherwise every read in a request pays the same full timeout before failing
 * over, which is what made zap quotes slow. Attempts that fail or take long are
 * logged with the host only, never the URL, because some providers keep the API
 * key in the path.
 */

import { redactRpcUrl } from "@/lib/rpc-redact";

/** How long a provider that timed out once is tried last instead of first. */
export const RPC_COOLDOWN_MS = 60_000;
/** Upper bound for the growing cooldown of a provider that keeps timing out. */
export const RPC_COOLDOWN_MAX_MS = 600_000;
/** Attempts at least this slow are logged even when they succeed. */
export const RPC_SLOW_LOG_MS = 1_000;

interface RpcCooldown {
  until: number;
  strikes: number;
}

const cooldowns = new Map<string, RpcCooldown>();

/**
 * Remember that this provider just timed out. A timeout soon after the previous
 * cooldown ended doubles the next one, up to RPC_COOLDOWN_MAX_MS, so an outage
 * costs one timeout per growing interval instead of one per minute. A timeout
 * that arrives while the cooldown is still running is the same outage: it does
 * not add a strike and does not extend the cooldown, because one slow provider
 * times out every read in a batch at once.
 */
export function markRpcTimedOut(url: string, now = Date.now()): void {
  const previous = cooldowns.get(url);
  if (previous !== undefined && now < previous.until) return;
  const strikes =
    previous !== undefined && now - previous.until < RPC_COOLDOWN_MAX_MS
      ? previous.strikes + 1
      : 1;
  const cooldownMs = Math.min(RPC_COOLDOWN_MS * 2 ** (strikes - 1), RPC_COOLDOWN_MAX_MS);
  cooldowns.set(url, { until: now + cooldownMs, strikes });
}

/** A provider that answered is fully reset: no cooldown, no strikes. */
export function markRpcHealthy(url: string): void {
  cooldowns.delete(url);
}

/** Same URLs, same relative order, but providers in cooldown moved to the end. */
export function orderRpcUrls(urls: readonly string[], now = Date.now()): string[] {
  const present = new Set(urls);
  // Keep the map bounded by the lists actually in use, and drop records too old
  // to make a repeat timeout count as a strike.
  for (const [url, entry] of cooldowns) {
    if (!present.has(url) || now - entry.until >= RPC_COOLDOWN_MAX_MS) cooldowns.delete(url);
  }

  const ready: string[] = [];
  const coolingDown: string[] = [];
  for (const url of urls) {
    const entry = cooldowns.get(url);
    // An expired record stays for the strike count but no longer reorders.
    if (entry === undefined || entry.until <= now) {
      ready.push(url);
    } else {
      coolingDown.push(url);
    }
  }
  return [...ready, ...coolingDown];
}

/** Forget all cooldowns (tests). */
export function resetRpcHealth(): void {
  cooldowns.clear();
}

export type RpcAttemptOutcome = "ok" | "timeout" | "http_error" | "rpc_error" | "error";

/** One log line for an attempt that failed or was slow. Host only, never the URL. */
export function logRpcAttempt(url: string, startedAt: number, outcome: RpcAttemptOutcome, where: string): void {
  const ms = Date.now() - startedAt;
  if (outcome === "ok" && ms < RPC_SLOW_LOG_MS) return;
  console.log("[RPC] attempt", JSON.stringify({ host: redactRpcUrl(url), ms, outcome, where }));
}
