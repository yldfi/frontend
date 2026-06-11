import { describe, it, expect } from "vitest";

// Health bar color function
function getColor(h: number): string {
  if (h <= 0) return "#ef4444";
  if (h < 5) return "#ef4444";
  if (h < 10) return "#f97316";
  if (h < 20) return "#eab308";
  if (h < 40) return "#84cc16";
  return "#22c55e";
}

describe("LendingInterface", () => {
  describe("getColor", () => {
    it("returns red for health = 0", () => {
      expect(getColor(0)).toBe("#ef4444");
    });

    it("returns red for negative health", () => {
      expect(getColor(-10)).toBe("#ef4444");
    });

    it("returns red for health < 5", () => {
      expect(getColor(4.99)).toBe("#ef4444");
    });

    it("returns orange for health = 5", () => {
      expect(getColor(5)).toBe("#f97316");
    });

    it("returns orange for health < 10", () => {
      expect(getColor(9.99)).toBe("#f97316");
    });

    it("returns yellow for health = 10", () => {
      expect(getColor(10)).toBe("#eab308");
    });

    it("returns yellow for health < 20", () => {
      expect(getColor(19.99)).toBe("#eab308");
    });

    it("returns lime for health = 20", () => {
      expect(getColor(20)).toBe("#84cc16");
    });

    it("returns lime for health < 40", () => {
      expect(getColor(39.99)).toBe("#84cc16");
    });

    it("returns green for health = 40", () => {
      expect(getColor(40)).toBe("#22c55e");
    });

    it("returns green for health = 100", () => {
      expect(getColor(100)).toBe("#22c55e");
    });

    // Boundary tests
    it("transitions at each boundary", () => {
      expect(getColor(4.999)).toBe("#ef4444");
      expect(getColor(5)).toBe("#f97316");
      expect(getColor(9.999)).toBe("#f97316");
      expect(getColor(10)).toBe("#eab308");
      expect(getColor(19.999)).toBe("#eab308");
      expect(getColor(20)).toBe("#84cc16");
      expect(getColor(39.999)).toBe("#84cc16");
      expect(getColor(40)).toBe("#22c55e");
    });
  });
});
