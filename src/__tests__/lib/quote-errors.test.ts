import { describe, expect, it } from "vitest";
import { isRetryableQuoteError, parseQuoteError } from "@/lib/quote-errors";
import { DYNAMIC_ROUTE_UNAVAILABLE_MESSAGE } from "@/lib/enso";
import { ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX } from "@/lib/price-impact";

describe("parseQuoteError", () => {
  it.each([
    [null, "Failed to get quote"],
    ["X → Y is temporarily unavailable. Withdraw to CVX instead.", "X → Y is temporarily unavailable. Withdraw to CVX instead."],
    ["No swap route could be quoted for this transaction. Increase the amount.", "No swap route could be quoted for this transaction. Increase the amount."],
    ["amountIn is outside the acceptable range", "Amount too large to quote - try a smaller amount"],
    ["Insufficient liquidity for swap", "No route available - insufficient liquidity"],
    ["Rate limit exceeded", "Too many requests - please wait a moment"],
    ["fetch failed", "Network error - please try again"],
    ["Enso intent must pull exactly one bound input token", "Route failed safety checks - try a different amount or token"],
    ["API Error: Could not build Bundle shortcut on network 1", "Quote unavailable - try a different amount"],
    ["something unexpected", "Failed to get quote"],
  ])("maps %s", (message, expected) => {
    expect(parseQuoteError(message === null ? null : new Error(message))).toBe(expected);
  });
});

describe("isRetryableQuoteError", () => {
  it.each([
    [`${DYNAMIC_ROUTE_UNAVAILABLE_MESSAGE} (API Error: Swap not found)`, false],
    ["Rate limit exceeded", false],
    ["Request failed with status code 429", false],
    ["Too Many Requests", false],
    ["No route found for this swap", false],
    ["Enso intent ysCVX→yspxCVX returned a forbidden transaction target", false],
    ["New yscvgCVX entry is hidden in the UI. Exchange to yscvxCRV instead.", false],
    ["No swap route could be quoted for this transaction. Increase the amount.", false],
    ["amountIn is outside the acceptable range", false],
    ["Insufficient liquidity for swap", false],
    ["API Error: Swap not found for 0xa0b8 -> 0x62b9", true],
    [`${ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX}: the zap would deliver ~1`, true],
    // An address containing "429" is not a rate limit.
    ["API Error: Swap not found for 0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A429 -> 0x62b9", true],
    ["API Error: Request failed with status code 500", true],
    ["RPC mainnet.example.com returned 502", true],
    ["503 Service Temporarily Unavailable", true],
    ["fetch failed", true],
    ["The operation was aborted due to timeout", true],
    ["something unexpected", true],
  ])("returns %s → %s", (message, expected) => {
    expect(isRetryableQuoteError(new Error(message))).toBe(expected);
  });

  it.each([
    [0, true],
    [1, false],
  ])(
    "retries a failed estimate at failureCount %i → %s",
    (failureCount, expected) => {
      expect(
        isRetryableQuoteError(
          new Error("Failed to estimate Curve lpxCVX→CVX swap output"),
          failureCount,
        ),
      ).toBe(expected);
    },
  );

  it.each([
    [0, true],
    [1, false],
  ])(
    "retries an Enso request timeout at failureCount %i → %s",
    (failureCount, expected) => {
      expect(
        isRetryableQuoteError(new Error("Enso request timeout"), failureCount),
      ).toBe(expected);
    },
  );

  it("treats a non-Error value as retryable", () => {
    expect(isRetryableQuoteError("fetch failed")).toBe(true);
  });
});
