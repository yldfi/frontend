import { redactUrlsInText } from "@/lib/rpc-redact";

/** Longest text written to a log for one value. */
export const SAFE_LOG_MAX_LENGTH = 500;

// The serialised text is cut before the redaction scan: that scan is linear in
// its input, and the result is cut to the caller's limit anyway, so a huge
// upstream body is never redacted in full.
const MAX_INPUT_LENGTH = 4000;

const UNSERIALISABLE = "[unserialisable]";

function serialise(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const text = JSON.stringify(value);
    return text === undefined ? UNSERIALISABLE : text;
  } catch {
    return UNSERIALISABLE;
  }
}

/**
 * Text of an arbitrary value that is safe to log: serialised, URLs reduced to
 * their host, bounded. Returns undefined for undefined/null so callers can omit it.
 */
export function safeLogData(value: unknown, maxLength = SAFE_LOG_MAX_LENGTH): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const bounded = serialise(value).slice(0, MAX_INPUT_LENGTH);
  return redactUrlsInText(bounded.replace(/\s+/g, " ")).slice(0, maxLength);
}

/**
 * The upstream body carried by an SDK error (`responseData`) or an HTTP-client
 * error (`response.data`).
 */
export function upstreamErrorBody(error: unknown): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const carrier = error as { responseData?: unknown; response?: unknown };
  if (carrier.responseData !== undefined) {
    return carrier.responseData;
  }
  const response = carrier.response;
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  return (response as { data?: unknown }).data;
}
