import { describe, expect, it } from "vitest";

import { USDC_ADDRESS, YVUSDC1_ADDRESS } from "@/config/addresses";
import { EXTERNAL_VAULT_CONFIG } from "@/config/vaults";

describe("external vault config", () => {
  it("tracks yvUSDC-1 as a 6-decimal USDC-backed vault", () => {
    const config = EXTERNAL_VAULT_CONFIG[YVUSDC1_ADDRESS.toLowerCase()];

    expect(config.underlying).toBe(USDC_ADDRESS);
    expect(config.underlyingSymbol).toBe("USDC");
    expect(config.underlyingDecimals).toBe(6);
  });
});
