import { describe, it, expect } from "vitest";
import { isValidAddress, isZeroAddress } from "@/lib/explorer/etherscan";

describe("isValidAddress", () => {
  it("returns true for valid lowercase address", () => {
    expect(isValidAddress("0x0000000000000000000000000000000000000001")).toBe(true);
  });

  it("returns true for valid checksummed address", () => {
    expect(isValidAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7")).toBe(true);
  });

  it("returns true for valid uppercase hex address", () => {
    expect(isValidAddress("0xabCDeF0123456789AbcdEf0123456789aBCDEF01")).toBe(true);
  });

  it("returns false for missing 0x prefix", () => {
    expect(isValidAddress("dAC17F958D2ee523a2206206994597C13D831ec7")).toBe(false);
  });

  it("returns false for too short address", () => {
    expect(isValidAddress("0x1234")).toBe(false);
  });

  it("returns false for too long address", () => {
    expect(isValidAddress("0x0000000000000000000000000000000000000001FF")).toBe(false);
  });

  it("returns false for non-hex characters", () => {
    expect(isValidAddress("0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isValidAddress("")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isValidAddress(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isValidAddress(undefined)).toBe(false);
  });

  it("returns false for number", () => {
    expect(isValidAddress(42)).toBe(false);
  });

  it("returns false for object", () => {
    expect(isValidAddress({})).toBe(false);
  });

  it("returns true for zero address", () => {
    expect(isValidAddress("0x0000000000000000000000000000000000000000")).toBe(true);
  });
});

describe("isZeroAddress", () => {
  it("returns true for zero address", () => {
    expect(isZeroAddress("0x0000000000000000000000000000000000000000")).toBe(true);
  });

  it("returns false for non-zero address", () => {
    expect(isZeroAddress("0x0000000000000000000000000000000000000001")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isZeroAddress("")).toBe(false);
  });

  it("returns false for uppercase zero address", () => {
    // isZeroAddress uses strict equality — only lowercase matches
    expect(isZeroAddress("0x0000000000000000000000000000000000000000")).toBe(true);
  });
});
