import crossFetch from "cross-fetch";

/**
 * Probe a JSON-RPC endpoint once before an integration suite runs.
 *
 * These suites need a debug/archive node (`debug_traceCall` with state
 * overrides). When the configured endpoint is missing, expired, rate-limited or
 * behind a proxy that answers with HTML, every test fails with an opaque parse
 * error and the nightly run goes red for a reason the code cannot fix. Probing
 * first turns that into an explicit skip with a loud reason, while genuine
 * assertion failures still fail.
 *
 * @returns null when the endpoint answered a JSON-RPC request, otherwise the
 * reason it cannot be used.
 */
export async function probeRpc(
  url: string | undefined,
  auth?: string,
  timeoutMs = 8_000,
): Promise<string | null> {
  if (!url) return "no simulation RPC configured (set DEBUG_RPC_URL)";

  try {
    const response = await crossFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: auth.startsWith("Basic ") ? auth : `Basic ${auth}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return `RPC answered HTTP ${response.status}`;
    }

    const text = await response.text();
    if (!text.trimStart().startsWith("{")) {
      // Hosted providers put their throttle/block page here.
      return "RPC answered with a non-JSON body (blocked, throttled or wrong URL)";
    }

    const body = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      return `RPC error: ${body.error.message ?? "unknown"}`;
    }
    if (typeof body.result !== "string") {
      return "RPC answered without a chain id";
    }
    return null;
  } catch (error) {
    return `RPC unreachable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Log why a suite is being skipped. Deliberately noisy: a skipped-on-CI suite
 * means a secret or endpoint needs attention, not that everything is fine.
 */
export function logSkippedSuite(suite: string, reason: string): void {
  console.warn(`\n[integration] SKIPPING ${suite}: ${reason}\n`);
}
