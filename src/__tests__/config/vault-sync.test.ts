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
import { VAULT_ADDRESSES, TOKENS } from "@/config/vaults";

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
