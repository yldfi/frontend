// @vitest-environment node
import { describe, it, expect } from "vitest";
import { timingSafeEqual } from "../../../workers/timing-safe-equal";

describe("timingSafeEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqual("correct-horse", "correct-horse")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(timingSafeEqual("correct-horse", "correct-house")).toBe(false);
  });

  it("returns false when one string is a prefix of the other", () => {
    expect(timingSafeEqual("secret", "secret-longer")).toBe(false);
    expect(timingSafeEqual("secret-longer", "secret")).toBe(false);
  });

  it("returns false for empty vs non-empty", () => {
    expect(timingSafeEqual("", "secret")).toBe(false);
    expect(timingSafeEqual("secret", "")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("returns true for equal non-ASCII strings", () => {
    expect(timingSafeEqual("sécret-ü-日本語", "sécret-ü-日本語")).toBe(true);
    expect(timingSafeEqual("sécret-ü-日本語", "sécret-ü-日本")).toBe(false);
  });
});
