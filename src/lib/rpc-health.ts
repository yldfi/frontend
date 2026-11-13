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

/** How long a provider that timed out is tried last instead of first. */
export const RPC_COOLDOWN_MS = 60_000;
/** Attempts at least this slow are logged even when they succeed. */
export const RPC_SLOW_LOG_MS = 1_000;

const cooldownUntil = new Map<string, number>();

/** Remember that this provider just timed out. */
export function markRpcTimedOut(url: string, now = Date.now()): void {
  cooldownUntil.set(url, now + RPC_COOLDOWN_MS);
}

/** Same URLs, same relative order, but providers in cooldown moved to the end. */
export function orderRpcUrls(urls: readonly string[], now = Date.now()): string[] {
  const present = new Set(urls);
  // Keep the map bounded by the lists actually in use.
  for (const url of [...cooldownUntil.keys()]) {
    if (!present.has(url)) cooldownUntil.delete(url);
  }

  const ready: string[] = [];
  const coolingDown: string[] = [];
  for (const url of urls) {
    const until = cooldownUntil.get(url);
    if (until === undefined) {
      ready.push(url);
    } else if (until <= now) {
      cooldownUntil.delete(url);
      ready.push(url);
    } else {
      coolingDown.push(url);
    }
  }
  return [...ready, ...coolingDown];
}

/** Forget all cooldowns (tests). */
export function resetRpcHealth(): void {
  cooldownUntil.clear();
}

export type RpcAttemptOutcome = "ok" | "timeout" | "http_error" | "rpc_error" | "error";

/** One log line for an attempt that failed or was slow. Host only, never the URL. */
export function logRpcAttempt(url: string, startedAt: number, outcome: RpcAttemptOutcome, where: string): void {
  const ms = Date.now() - startedAt;
  if (outcome === "ok" && ms < RPC_SLOW_LOG_MS) return;
  console.log("[RPC] attempt", JSON.stringify({ host: redactRpcUrl(url), ms, outcome, where }));
}
