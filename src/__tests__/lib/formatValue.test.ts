import { describe, it, expect } from "vitest";
import { formatValue } from "@/lib/explorer/contractReader";

const MAX_UINT256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;

describe("formatValue", () => {
  // --- Null/undefined ---

  it("returns 'null' for null", () => {
    expect(formatValue(null, "uint256")).toBe("null");
  });

  it("returns 'null' for undefined", () => {
    expect(formatValue(undefined, "uint256")).toBe("null");
  });

  // --- BigInt paths ---

  it("returns 'Unlimited' for MAX_UINT256", () => {
    expect(formatValue(MAX_UINT256, "uint256")).toBe("Unlimited");
  });

  it("returns 'Unlimited' for values within 1000 of MAX_UINT256", () => {
    expect(formatValue(MAX_UINT256 - 500n, "uint256")).toBe("Unlimited");
  });

  it("formats BigInt fee field as basis points", () => {
    expect(formatValue(250n, "uint256", "fee")).toBe("2.50%");
  });

  it("formats BigInt bps field as basis points (whole percentage)", () => {
    expect(formatValue(10000n, "uint256", "bps")).toBe("100%");
  });

  it("formats BigInt timestamp-range value as date string", () => {
    // 1700000000 = Nov 2023
    const result = formatValue(BigInt(1700000000), "uint256");
    expect(result).toContain("202");
  });

  it("formats BigInt duration field as human-readable duration", () => {
    expect(formatValue(BigInt(86400), "uint256", "lockTime")).toBe("1 day");
  });

  it("formats large BigInt (>10^15) as decimal with 18 decimals", () => {
    // 1e18 = 1.0 in 18-decimal format
    const result = formatValue(1000000000000000000n, "uint256");
    expect(result).toContain("1");
  });

  it("formats large BigInt >= 1M with max 2 fraction digits", () => {
    // 2_000_000e18 => 2,000,000 (formatted with locale)
    const result = formatValue(2000000000000000000000000n, "uint256");
    expect(result).toContain("2");
    expect(result).toContain("000");
  });

  it("formats large BigInt < 1 with significant digits", () => {
    // 0.001e18 = 1e15 => just above threshold, 0.001 in 18 decimals
    const result = formatValue(10n ** 15n + 1n, "uint256");
    // Should be a small decimal like 0.001...
    expect(result).toContain("0");
  });

  it("formats small BigInt with uint256 via toLocaleString", () => {
    const result = formatValue(42n, "uint256");
    // toLocaleString for 42 should contain "42"
    expect(result).toContain("42");
  });

  it("formats BigInt with non-uint256 type via toString", () => {
    expect(formatValue(42n, "uint8")).toBe("42");
  });

  it("does not treat BigInt rate field with 'unlock' as basis points", () => {
    // "unlockRate" includes "rate" but also "unlock", so isBasisPointsField returns false
    const result = formatValue(500n, "uint256", "unlockRate");
    // Should NOT be "5%" - should fall through to uint256 formatting
    expect(result).not.toBe("5%");
    expect(result).toContain("500");
  });

  // --- Array paths ---

  it("returns '[]' for empty array", () => {
    expect(formatValue([], "uint256[]")).toBe("[]");
  });

  it("formats array of values joined with comma-space", () => {
    const result = formatValue([true, false], "bool[]");
    expect(result).toBe("true, false");
  });

  // --- Object/struct paths ---

  it("formats object as '{ key: value }' filtering numeric keys", () => {
    // Solidity structs from viem come back with both numeric and named keys
    const structValue = { 0: 100n, 1: true, amount: 100n, active: true };
    const result = formatValue(structValue, "tuple");
    expect(result).toContain("amount:");
    expect(result).toContain("active:");
    // Numeric keys (0, 1) should be filtered out
    expect(result).not.toMatch(/\b0:/);
    expect(result).not.toMatch(/\b1:/);
  });

  // --- Boolean paths ---

  it("returns 'true' for boolean true", () => {
    expect(formatValue(true, "bool")).toBe("true");
  });

  it("returns 'false' for boolean false", () => {
    expect(formatValue(false, "bool")).toBe("false");
  });

  // --- String paths ---

  it("returns string as-is", () => {
    expect(formatValue("hello world", "string")).toBe("hello world");
  });

  // --- Number paths ---

  it("formats number fee field as basis points", () => {
    expect(formatValue(500, "uint16", "fee")).toBe("5%");
  });

  it("formats number duration field as human-readable duration", () => {
    expect(formatValue(3600, "uint32", "cooldown")).toBe("1 hour");
  });

  it("formats number timestamp as date string", () => {
    // 1700000000 = Nov 2023
    const result = formatValue(1700000000, "uint32");
    expect(result).toContain("202");
  });

  it("formats regular number via toLocaleString", () => {
    const result = formatValue(12345, "uint32");
    // toLocaleString output varies by locale but should contain the digits
    expect(result).toContain("12");
    expect(result).toContain("345");
  });

  // --- Fallback ---

  it("falls back to String() for unknown types", () => {
    // Symbol can't be matched by earlier branches
    expect(formatValue(Symbol.for("test"), "unknown")).toBe("Symbol(test)");
  });
});
