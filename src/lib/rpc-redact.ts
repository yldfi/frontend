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
// nothing after it is left behind. The host itself stops at prose delimiters,
// but after the host the rest of the URL runs to whitespace or "<"/">" only:
// a key can contain quotes or brackets, and leaving those characters behind
// would leave the rest of the key visible. The cost is that a URL written
// inside quotes or brackets in prose loses its closing character, which is
// acceptable in a log line. Every character class is a single, non-overlapping
// repeat, so the scan stays linear even on hostile input. Matching the scheme
// without a lookbehind keeps a URL glued to a preceding letter visible. The one
// character after "//" may be ")", so a URL whose host is junk still reaches the
// host reader and is replaced by "<rpc>" instead of being left in the text.
const URL_IN_TEXT = /(?:https?|wss?):\/\/(?:\[[^\]\s"'<>]{1,64}\]|\[[^\s"'<>]*|[^\s"'<>\]])(?:[^\s<>]*)/gi;

// Host of a URL found inside free text. The match may carry junk after the URL
// (a closing quote, the rest of a JSON body), so the host is read with a strict
// pattern instead of a URL parser, which would accept ")" inside a host name.
const HOST_IN_MATCH = /^[a-z]+:\/\/(?:[^@/?#\s]*@)?(\[[0-9a-f:.]{1,64}\]|[a-z0-9](?:[a-z0-9.-]{0,252}[a-z0-9])?)(:\d{1,5})?/i;
function hostOfMatchedUrl(match: string): string {
  const found = HOST_IN_MATCH.exec(match);
  return found ? (found[1] + (found[2] ?? "")).toLowerCase() : "<rpc>";
}

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
    return text.slice(0, MAX_SCRUB_LENGTH).replace(URL_IN_TEXT, (url) => hostOfMatchedUrl(url)) + "…";
  }
  return text.replace(URL_IN_TEXT, (url) => hostOfMatchedUrl(url));
}

