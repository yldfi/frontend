import { describe, expect, it } from "vitest";

import {
  EXTERNAL_VAULT_TOKENS,
  getExternalVaultConfig,
  getExternalVaultUnderlying,
  isExternalVaultToken,
  YEARN,
} from "@/config/vaults";
import { USDC_ADDRESS } from "@/config/addresses";

describe("external vault registry", () => {
  it("treats yvUSDC-1 as an external vault token", () => {
    expect(isExternalVaultToken(YEARN.YVUSDC1)).toBe(true);
    expect(
      EXTERNAL_VAULT_TOKENS.some(
        (address) => address.toLowerCase() === YEARN.YVUSDC1.toLowerCase(),
      ),
    ).toBe(true);
  });

  it("stores the correct Yearn ERC4626 metadata for yvUSDC-1", () => {
    expect(getExternalVaultUnderlying(YEARN.YVUSDC1)?.toLowerCase()).toBe(
      USDC_ADDRESS.toLowerCase(),
    );

    expect(getExternalVaultConfig(YEARN.YVUSDC1)).toMatchObject({
      address: YEARN.YVUSDC1,
      underlying: USDC_ADDRESS,
      underlyingSymbol: "USDC",
      interface: "erc4626",
      symbol: "yvUSDC-1",
      name: "USDC-1 yVault",
      protocol: "Yearn",
    });
  });
});
