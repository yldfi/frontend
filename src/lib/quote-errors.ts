/** Turn a zap quote error (Enso API, intent guard or proxy) into a short user-facing message. */
export function parseQuoteError(error: Error | null | undefined): string {
  if (!error) return "Failed to get quote";
  const msg = error.message || "";
  const normalizedMsg = msg.toLowerCase();

  // Route deliberately disabled (message names the pair and the workaround)
  if (normalizedMsg.includes("temporarily unavailable")) {
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
  if (normalizedMsg.includes("rate limit") || normalizedMsg.includes("429")) {
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
