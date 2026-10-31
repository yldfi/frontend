import { describe, expect, it } from "vitest";

import { getHarvestConfig } from "@/config/harvest";
import { VAULT_ADDRESSES } from "@/config/vaults";

describe("getHarvestConfig", () => {
  it("maps a parent vault to its underlying strategy harvest configuration", () => {
    expect(getHarvestConfig(VAULT_ADDRESSES.YCVXCRV)).toMatchObject({
      kind: "yscvxcrv",
      strategy: VAULT_ADDRESSES.YSCVXCRV,
    });
  });

  it("has no harvest configuration for the sunset yscvgCVX strategy", () => {
    expect(getHarvestConfig("0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359")).toBeNull();
  });
});
