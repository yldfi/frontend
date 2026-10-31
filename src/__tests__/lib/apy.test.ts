import { describe, expect, it } from "vitest";

import { APY_DISPLAY_CAP, averageDisplayApy, formatApy, isApyOffScale } from "@/lib/apy";

describe("APY display", () => {
  it("formats normal APYs as before", () => {
    expect(formatApy(8.91)).toBe("8.91%");
    expect(formatApy(0)).toBe("0.00%");
    expect(formatApy(12.345, 1)).toBe("12.3%");
    expect(formatApy(APY_DISPLAY_CAP - 0.01)).toBe("9999.99%");
  });

  it("shows ∞ for off-scale APYs such as ysCVX's 3,823,238.62%", () => {
    expect(formatApy(3_823_238.62)).toBe("∞");
    expect(formatApy(83_392_758)).toBe("∞");
    expect(formatApy(APY_DISPLAY_CAP)).toBe("∞");
    expect(formatApy(Infinity)).toBe("∞");
    expect(isApyOffScale(3_823_238.62)).toBe(true);
    expect(isApyOffScale(8.91)).toBe(false);
  });

  it("shows a dash when there's no number", () => {
    expect(formatApy(null)).toBe("—");
    expect(formatApy(undefined)).toBe("—");
    expect(formatApy(NaN)).toBe("—");
  });

  it("leaves off-scale vaults out of the average", () => {
    expect(averageDisplayApy([3_823_238.62, 8.91, 0])).toBeCloseTo(4.455);
    expect(averageDisplayApy([3_823_238.62])).toBe(0);
    expect(averageDisplayApy([])).toBe(0);
  });
});
