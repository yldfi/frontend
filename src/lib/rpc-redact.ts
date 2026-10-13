/**
 * Host-only form of an RPC URL for logs and error messages. Some providers put the API key in
 * the path (e.g. https://muupe.com/rpc/<key>, Alchemy's /v2/<key>), so a full URL in a log line
 * leaks the key into Workers Logs.
 */
export function redactRpcUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<rpc>";
  }
}
