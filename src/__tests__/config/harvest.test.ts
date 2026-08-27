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

  it("does not configure an auction for yscvgCVX", () => {
    expect(getHarvestConfig(VAULT_ADDRESSES.YSCVGCVX)).toEqual({
      kind: "yscvgcvx",
      strategy: VAULT_ADDRESSES.YSCVGCVX,
    });
  });
});

