import { describe, it, expect } from "vitest";
import { isSameAmount, sanitizeAmount } from "@/lib/sanitize";

describe("sanitizeAmount", () => {
  it("passes through plain numbers", () => {
    expect(sanitizeAmount("123")).toBe("123");
  });

  it("passes through decimal numbers", () => {
    expect(sanitizeAmount("1.5")).toBe("1.5");
  });

  it("passes through small decimal numbers", () => {
    expect(sanitizeAmount("0.001")).toBe("0.001");
  });

  it("strips letters", () => {
    expect(sanitizeAmount("12abc34")).toBe("1234");
  });

  it("strips special characters but keeps decimal", () => {
    expect(sanitizeAmount("$1,000.50")).toBe("1000.50");
  });

  it("strips negative sign", () => {
    expect(sanitizeAmount("-5.5")).toBe("5.5");
  });

  it("strips spaces", () => {
    expect(sanitizeAmount(" 1 2 . 3 ")).toBe("12.3");
  });

  it("removes second decimal point in 1.2.3", () => {
    expect(sanitizeAmount("1.2.3")).toBe("1.23");
  });

  it("removes last extra decimal in 1.2.3.4 via greedy match", () => {
    // The greedy regex /(\..*)\./g matches "(.2.3)." and replaces with ".2.3",
    // yielding "1.2.34" — only one extra dot is removed per greedy match.
    expect(sanitizeAmount("1.2.3.4")).toBe("1.2.34");
  });

  it("preserves leading decimal", () => {
    expect(sanitizeAmount(".5")).toBe(".5");
  });

  it("preserves trailing decimal", () => {
    expect(sanitizeAmount("5.")).toBe("5.");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeAmount("")).toBe("");
  });

  it("returns empty string for only non-numeric characters", () => {
    expect(sanitizeAmount("abc")).toBe("");
  });

  it("removes one extra dot from consecutive dots", () => {
    // "..." after stripping non-numeric is still "...", then greedy regex
    // matches "(..)." → replaces with ".." → result is ".."
    expect(sanitizeAmount("...")).toBe("..");
  });

  it("strips currency symbols when pasting", () => {
    expect(sanitizeAmount("€100.50")).toBe("100.50");
  });
});

describe("isSameAmount", () => {
  it("treats trailing zeros as the same amount", () => {
    expect(isSameAmount("1.5", "1.50", 18)).toBe(true);
    expect(isSameAmount("1", "1.0", 6)).toBe(true);
    expect(isSameAmount("0.1", "0.10", 18)).toBe(true);
  });

  it("distinguishes different amounts", () => {
    expect(isSameAmount("1.5", "1.51", 18)).toBe(false);
    expect(isSameAmount("200", "297.900852", 6)).toBe(false);
  });

  it("treats identical empty strings as equal", () => {
    expect(isSameAmount("", "", 18)).toBe(true);
  });

  it("treats unparseable input as only equal to itself", () => {
    expect(isSameAmount("abc", "abc", 18)).toBe(true);
    expect(isSameAmount("abc", "1", 18)).toBe(false);
  });

  it("short-circuits identical strings that do not fit the decimals", () => {
    expect(isSameAmount("1.1234567", "1.1234567", 6)).toBe(true);
  });
});
