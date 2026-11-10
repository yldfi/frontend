/**
 * Zap quote freshness (shared by /zap and the vault-page zap tab).
 *
 * Quotes re-fetch every 60 s while the user is active. Each costs ~30-45 Enso
 * credits, so the loop stops after QUOTE_IDLE_MS without activity. Executing
 * sends the on-screen quote's calldata as-is, so a quote older than
 * QUOTE_MAX_AGE_MS is refreshed instead of sent.
 */
export const QUOTE_IDLE_MS = 3 * 60 * 1000;
export const QUOTE_MAX_AGE_MS = 90 * 1000;

export function isQuoteOlderThan(quoteUpdatedAt: number, maxAgeMs = QUOTE_MAX_AGE_MS, now = Date.now()): boolean {
  return quoteUpdatedAt > 0 && now - quoteUpdatedAt > maxAgeMs;
}
