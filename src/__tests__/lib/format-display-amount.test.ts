import { describe, it, expect } from "vitest";
import { formatDisplayAmount } from "@/lib/utils";

describe("formatDisplayAmount", () => {
  it("keeps 4 decimals for normal amounts (unchanged zap display)", () => {
    expect(formatDisplayAmount(1663.40181)).toBe("1663.4018");
    expect(formatDisplayAmount("13.010695194448337133")).toBe("13.0107");
    expect(formatDisplayAmount(0.0265)).toBe("0.0265");
    expect(formatDisplayAmount(1)).toBe("1.0000");
  });

  it("widens for dust so the amount is not shown as 0.0000", () => {
    // 0.0265 CRV → ETH (10 Nov screenshot) rendered "0.0000 ETH"
    expect(formatDisplayAmount(0.00000531)).toBe("0.00000531");
    expect(formatDisplayAmount(0.000266)).toBe("0.000266");
    expect(formatDisplayAmount(0.00002)).toBe("0.00002");
  });

  it("rounds to 4 significant digits on small values", () => {
    expect(formatDisplayAmount(0.0000123456)).toBe("0.00001235");
  });

  it("handles zero, negatives and junk", () => {
    expect(formatDisplayAmount(0)).toBe("0.0000");
    expect(formatDisplayAmount(-0.00000531)).toBe("-0.00000531");
    expect(formatDisplayAmount("abc")).toBe("—");
    expect(formatDisplayAmount(Infinity)).toBe("—");
  });

  it("caps at 18 decimals (smaller rounds to zero)", () => {
    expect(formatDisplayAmount(1e-25)).toBe("0.0000");
    expect(formatDisplayAmount(1.5e-17)).toBe("0.000000000000000015");
  });
});
