/**
 * Host-only form of an RPC URL for logs and error messages. Some providers put the API key in
 * the path (e.g. https://rpc.example/<key>, or a /v2/<key> path), so a full URL in a log line
 * leaks the key into Workers Logs.
 */
export function redactRpcUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<rpc>";
  }
}

// A bracketed IPv6 host is matched separately, with a bounded inner length, so
// its closing "]" does not end the URL early and an unterminated "http://["
// cannot re-scan the rest of the string from every position. A bracketed host
// that is over-long or unterminated is consumed up to the next delimiter, so
// nothing after it is left behind. The rest of the URL stops at whitespace or
// prose delimiters.
const URL_IN_TEXT = /(?<![A-Za-z])(?:https?|wss?):\/\/(?:\[[^\]\s"'<>]{1,64}\]|\[[^\s"'<>]*|[^\s"'<>)\]])(?:[^\s"'<>)\]]*)/gi;

// Callers only need a short message, so the scrub is bounded on its input: only
// the first MAX_SCRUB_LENGTH characters are scanned, which keeps the cost linear
// in a fixed length even when the text comes from a request. The output can be
// slightly longer than that cut when a matched host is rewritten.
const MAX_SCRUB_LENGTH = 4000;

/**
 * Replace every http(s), ws or wss URL inside a message with its host, so an
 * error string returned to a client or written to a log cannot carry a key
 * that lives in a URL path or query. All other text is left untouched.
 */
export function redactUrlsInText(text: string): string {
  if (text.length > MAX_SCRUB_LENGTH) {
    return text.slice(0, MAX_SCRUB_LENGTH).replace(URL_IN_TEXT, (url) => redactRpcUrl(url)) + "…";
  }
  return text.replace(URL_IN_TEXT, (url) => redactRpcUrl(url));
}

