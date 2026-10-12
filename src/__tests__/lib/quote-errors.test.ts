import { describe, expect, it } from "vitest";
import { parseQuoteError } from "@/lib/quote-errors";

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
