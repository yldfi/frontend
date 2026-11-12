import { EnsoClient } from "@ensofinance/sdk";

export const CHAIN_ID = 1; // Ethereum mainnet

// Initialize Enso SDK client
export const ensoClient = new EnsoClient({
  apiKey: process.env.ENSO_API_KEY || "",
});

// Rate limit disabled - testing shows Enso API handles rapid requests fine
// Keep env var override in case we need to throttle in the future
const ENSO_RATE_LIMIT_MS = Number(process.env.ENSO_RATE_LIMIT_MS ?? "0");

const DEFAULT_ENSO_MAX_RETRIES = 3;
const DEFAULT_ENSO_CALL_TIMEOUT_MS = 20_000;
// setTimeout stores its delay in a signed 32-bit int, so anything larger fires
// after ~1 ms instead of never.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Env numbers are read once, at import. Number("") is 0, Number("abc") is NaN,
 * and setTimeout treats both as ~0 ms: an unvalidated value would fail every
 * call immediately (or, for retries, skip the attempt loop entirely). An empty
 * or whitespace-only value counts as unset, not as 0.
 */
const readEnvNumber = (
  raw: string | undefined,
  fallback: number,
  isValid: (value: number) => boolean,
): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return isValid(parsed) ? parsed : fallback;
};

const ENSO_MAX_RETRIES = readEnvNumber(
  process.env.ENSO_MAX_RETRIES,
  DEFAULT_ENSO_MAX_RETRIES,
  (value) => Number.isInteger(value) && value >= 0 && value <= 10,
);
// The SDK's axios client has no timeout. Without one, a request that never
// settles holds the queue (and every quote behind it) until the isolate dies.
const ENSO_CALL_TIMEOUT_MS = readEnvNumber(
  process.env.ENSO_CALL_TIMEOUT_MS,
  DEFAULT_ENSO_CALL_TIMEOUT_MS,
  (value) => Number.isFinite(value) && value >= 1_000 && value <= MAX_TIMER_MS,
);

// Frees the queue, not the socket: the SDK takes no abort signal, so a timed-out
// request is not cancelled upstream and may still be billed. During an upstream
// stall a few such requests can remain in flight while the queue moves on.
const withEnsoTimeout = <T>(fn: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Enso request timeout")),
      ENSO_CALL_TIMEOUT_MS,
    );
    fn().then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });

let lastEnsoCallAt = 0;
let ensoQueue: Promise<void> = Promise.resolve();

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const isEnsoRateLimit = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const err = error as { statusCode?: number; response?: { status?: number }; message?: string };
  if (err.statusCode === 429 || err.response?.status === 429) return true;
  if (typeof err.message === "string" && err.message.includes("429")) return true;
  return false;
};

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);

export const isSwapNotFound = (error: unknown): boolean =>
  /swap not found/i.test(errorMessage(error));

/** Shown (via parseQuoteError) when a dynamic swap step can't be routed even after a retry. */
export const DYNAMIC_ROUTE_UNAVAILABLE_MESSAGE =
  "Enso can't route this swap step right now";

export const enqueueEnsoCall = async <T>(fn: () => Promise<T>): Promise<T> => {
  const enqueuedAt = Date.now();
  const run = async (): Promise<T> => {
    const startedAt = Date.now();
    let attempts = 0;
    let ok = false;
    try {
      const now = Date.now();
      if (ENSO_RATE_LIMIT_MS > 0) {
        const waitMs = lastEnsoCallAt + ENSO_RATE_LIMIT_MS - now;
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }
      lastEnsoCallAt = Date.now();

      for (let attempt = 0; attempt <= ENSO_MAX_RETRIES; attempt += 1) {
        attempts = attempt + 1;
        try {
          const result = await withEnsoTimeout(fn);
          ok = true;
          return result;
        } catch (error) {
          if (!isEnsoRateLimit(error) || attempt === ENSO_MAX_RETRIES) {
            throw error;
          }
          // Enso's limit is per second (10 RPS on our plan), so a 429 clears
          // within about a second. The old 1 s / 2 s / 3 s / 4 s ladder held this
          // serial queue (and every quote behind it) for ~10 s; quote timings
          // on 10 Nov clustered at exactly that. Back off 250 ms, 500 ms, 1 s.
          const backoffMs = ENSO_RATE_LIMIT_MS > 0
            ? ENSO_RATE_LIMIT_MS * (attempt + 1)
            : 250 * 2 ** attempt;
          await sleep(backoffMs);
        }
      }
      throw new Error("Enso request failed after retries");
    } finally {
      const queueMs = startedAt - enqueuedAt;
      const runMs = Date.now() - startedAt;
      if (queueMs + runMs >= 5) {
        console.log("[Enso] call", JSON.stringify({ queueMs, runMs, attempts, ok }));
      }
    }
  };

  const resultPromise = ensoQueue.then(run, run);
  ensoQueue = resultPromise.then(() => undefined, () => undefined);
  return resultPromise;
};
