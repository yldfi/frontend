/**
 * Build-time check that vault addresses in workers/vault-cache.ts
 * stay in sync with the source of truth in src/config/vaults.ts
 *
 * This catches drift between the two files since Cloudflare Workers
 * cannot import from src/ due to bundling constraints.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  VAULT_ADDRESSES,
  TOKENS,
  VAULTS,
  isExitOnlyVault,
  isLendingDisabledWithoutPosition,
  isVaultEntryDisabled,
  isVaultHiddenUnlessHolder,
} from "@/config/vaults";

describe("vault address sync", () => {
  const workerPath = join(process.cwd(), "workers/vault-cache.ts");
  const workerContent = readFileSync(workerPath, "utf-8");

  it("worker has correct YCVXCRV_VAULT address", () => {
    const match = workerContent.match(/const YCVXCRV_VAULT = "([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1].toLowerCase()).toBe(VAULT_ADDRESSES.YCVXCRV.toLowerCase());
  });

  it("worker has correct YSCVXCRV_VAULT address", () => {
    const match = workerContent.match(/const YSCVXCRV_VAULT = "([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1].toLowerCase()).toBe(VAULT_ADDRESSES.YSCVXCRV.toLowerCase());
  });

  it("worker has correct CVXCRV_TOKEN address", () => {
    const match = workerContent.match(/const CVXCRV_TOKEN = "([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1].toLowerCase()).toBe(TOKENS.CVXCRV.toLowerCase());
  });
});

describe("vault lifecycle flags", () => {
  it("marks ycvxCRV v1 as deprecated and exit-only", () => {
    expect(VAULTS.ycvxcrv.displayVersion).toBe("ycvxCRV_v1");
    expect(VAULTS.ycvxcrv.deprecated?.badge).toBe("Deprecated");
    expect(isExitOnlyVault(VAULTS.ycvxcrv)).toBe(true);
    expect(isVaultEntryDisabled(VAULTS.ycvxcrv)).toBe(true);
    expect(isVaultHiddenUnlessHolder(VAULTS.ycvxcrv)).toBe(true);
    expect(isLendingDisabledWithoutPosition(VAULTS.ycvxcrv)).toBe(true);
  });

  it("keeps active cvxCRV strategy vault enterable", () => {
    expect(isExitOnlyVault(VAULTS.yscvxcrv)).toBe(false);
    expect(isVaultEntryDisabled(VAULTS.yscvxcrv)).toBe(false);
    expect(isVaultHiddenUnlessHolder(VAULTS.yscvxcrv)).toBe(false);
    expect(isLendingDisabledWithoutPosition(VAULTS.yscvxcrv)).toBe(false);
  });
});
