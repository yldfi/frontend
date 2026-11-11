import { ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX } from "@/lib/price-impact";
import { DYNAMIC_ROUTE_UNAVAILABLE_MESSAGE } from "@/lib/enso";

/**
 * Rate limiting, matched on the status text only: an address or amount that
 * happens to contain "429" is not a rate limit.
 */
const RATE_LIMIT_PATTERNS = [/status code 429\b/, /\btoo many requests\b/, /rate limit/];
const isRateLimitMessage = (lower: string) => RATE_LIMIT_PATTERNS.some((re) => re.test(lower));

/** Turn a zap quote error (Enso API, intent guard or proxy) into a short user-facing message. */
export function parseQuoteError(error: Error | null | undefined): string {
  if (!error) return "Failed to get quote";
  const msg = error.message || "";
  const normalizedMsg = msg.toLowerCase();

  // Route deliberately disabled (message names the pair and the workaround)
  if (normalizedMsg.includes("temporarily unavailable")) {
    return msg;
  }
  // Dynamic swap step temporarily unroutable (fetchBundle, after one retry).
  // Checked before the "swap not found" mapping below: liquidity exists, the
  // restricted aggregator set just can't route it at the moment.
  if (msg.startsWith(DYNAMIC_ROUTE_UNAVAILABLE_MESSAGE)) {
    return "Enso can't route this swap right now. It usually recovers within a minute; the quote retries automatically.";
  }
  // Bundle quote far below the route's standalone estimate (price-impact.ts)
  if (msg.startsWith(ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX)) {
    return msg;
  }
  // Already user-facing from the /api/enso proxy (getFriendlyEnsoError)
  if (normalizedMsg.startsWith("no swap route could")) {
    return msg;
  }
  // Amount too large/out of range
  if (normalizedMsg.includes("amountin") && normalizedMsg.includes("acceptable range")) {
    return "Amount too large to quote - try a smaller amount";
  }
  // Insufficient liquidity
  if (normalizedMsg.includes("insufficient liquidity") || normalizedMsg.includes("no route found") || normalizedMsg.includes("swap not found")) {
    return "No route available - insufficient liquidity";
  }
  // Rate limit
  if (isRateLimitMessage(normalizedMsg)) {
    return "Too many requests - please wait a moment";
  }
  // Enso API errors (checked before the network keywords: "Could not build Bundle shortcut on network 1")
  if (msg.startsWith("API Error:")) {
    return "Quote unavailable - try a different amount";
  }
  // Network/timeout errors
  if (normalizedMsg.includes("timeout") || normalizedMsg.includes("network") || normalizedMsg.includes("fetch")) {
    return "Network error - please try again";
  }
  // The intent guard refused the returned transaction (wrong inputs, outputs or target)
  if (normalizedMsg.startsWith("enso intent")) {
    return "Route failed safety checks - try a different amount or token";
  }

  return "Failed to get quote";
}

/**
 * Whether re-running the whole quote can plausibly succeed. Each attempt
 * re-spends Enso credits, so errors that are deterministic for this input, or
 * that the server has already retried, are not retried from the browser.
 * The 60 s refetch interval still re-quotes later.
 *
 * `failureCount` is react-query's count of failures so far (0 on the first
 * failure), so builders that may already have spent a paid Enso bundle before
 * the failing read get a single retry instead of two.
 */
export function isRetryableQuoteError(error: unknown, failureCount = 0): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  const lower = msg.toLowerCase();
  if (msg.startsWith(DYNAMIC_ROUTE_UNAVAILABLE_MESSAGE)) return false; // server retried once already
  // Match the status text only: a token address or amount that happens to
  // contain "429" is not a rate limit.
  if (isRateLimitMessage(lower)) {
    return false; // server backs off itself; don't pile on
  }
  if (lower.startsWith("enso intent")) return false; // intent guard refused the tx (deterministic for this input)
  if (lower.includes("entry is hidden")) return false; // vault entry disabled in the UI
  if (lower.startsWith("no swap route could")) return false; // Enso could not quote this pair/amount
  if (lower.includes("amountin") && lower.includes("acceptable range")) return false;
  if (lower.includes("insufficient liquidity") || lower.includes("no route found")) return false;
  // A server-side timeout already spent 20 s (40 s with the quoter → route
  // fallback), and each browser retry queues another paid call behind a
  // possibly stalled upstream, so retry it at most once.
  if (/request timeout/i.test(msg)) return failureCount < 1;
  // A paid Enso bundle may already have been spent before the failing read.
  if (lower.startsWith("failed to estimate") || lower.startsWith("failed to preview")) {
    return failureCount < 1;
  }
  return true;
}
