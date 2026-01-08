/**
 * Comprehensive Enso Zap Integration Tests
 *
 * Tests cover:
 * 1. Zap In/Out for all vaults with ETH and USDC
 * 2. Vault-to-vault transfers (same and different underlying)
 * 3. UI validation - blocked operations (same vault, underlying tokens)
 * 4. CVX-specific routes for cvgCVX and pxCVX vaults
 *
 * Run with: pnpm vitest run src/__tests__/integration/enso-zap.integration.test.ts
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import crossFetch from "cross-fetch";

// Restore real fetch for live API tests
// The global mock in vitest.setup.ts breaks network requests
// We use cross-fetch as a real fetch implementation
beforeAll(() => {
  // Replace the mocked fetch with cross-fetch for real network requests
  vi.stubGlobal("fetch", crossFetch);
});

// Add delay between tests to avoid Enso API rate limiting
const RATE_LIMIT_DELAY_MS = 2000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

import { beforeEach } from "vitest";
beforeEach(async () => {
  await sleep(RATE_LIMIT_DELAY_MS);
});

import {
  fetchRoute,
  fetchZapInRoute,
  fetchZapOutRoute,
  fetchVaultToVaultRoute,
  fetchCvgCvxZapInRoute,
  fetchCvgCvxZapOutRoute,
  ETH_ADDRESS,
} from "@/lib/enso";
import { VAULT_ADDRESSES, TOKENS, VAULT_UNDERLYING_TOKENS } from "@/config/vaults";

// Test wallet (vitalik.eth)
const TEST_WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

// Test amounts
const ONE_ETH = "1000000000000000000";
const ONE_THOUSAND_USDC = "1000000000"; // 1000 USDC (6 decimals)
const TEN_VAULT_SHARES = "10000000000000000000";
const ONE_HUNDRED_CVX = "100000000000000000000";

// USDC address
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// Timeout for API calls
const API_TIMEOUT = 30000;

/**
 * Helper to check if output amount is valid
 */
function hasValidOutput(amountsOut: Record<string, string>, tokenAddress: string): boolean {
  const output = amountsOut[tokenAddress.toLowerCase()] || amountsOut[tokenAddress];
  return output !== undefined && BigInt(output) > 0n;
}

/**
 * Helper to check if bundle has valid transaction data
 * Useful for routes where output token is sent directly to user (not tracked in amountsOut)
 */
function isValidBundle(result: { tx?: { to: string; data: string } }): boolean {
  return result.tx !== undefined && result.tx.to !== "" && result.tx.data !== "";
}

describe("Enso Zap Integration Tests", () => {
  // ============================================
  // 1. BASIC ZAP IN/OUT - ycvxCRV (cvxCRV vault)
  // ============================================
  describe("ycvxCRV (cvxCRV vault) - Zap In/Out", () => {
    it("ETH → ycvxCRV (zap in)", async () => {
      const result = await fetchZapInRoute({
        fromAddress: TEST_WALLET,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV,
        inputToken: ETH_ADDRESS,
        amountIn: ONE_ETH,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YCVXCRV)).toBe(true);
      expect(result.tx).toBeDefined();
    }, API_TIMEOUT);

    it("USDC → ycvxCRV (zap in)", async () => {
      const result = await fetchZapInRoute({
        fromAddress: TEST_WALLET,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV,
        inputToken: USDC_ADDRESS,
        amountIn: ONE_THOUSAND_USDC,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YCVXCRV)).toBe(true);
    }, API_TIMEOUT);

    it("ycvxCRV → ETH (zap out)", async () => {
      const result = await fetchZapOutRoute({
        fromAddress: TEST_WALLET,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV,
        outputToken: ETH_ADDRESS,
        amountIn: TEN_VAULT_SHARES,
      });

      expect(hasValidOutput(result.amountsOut, ETH_ADDRESS)).toBe(true);
      expect(result.tx).toBeDefined();
    }, API_TIMEOUT);

    it("ycvxCRV → USDC (zap out)", async () => {
      const result = await fetchZapOutRoute({
        fromAddress: TEST_WALLET,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV,
        outputToken: USDC_ADDRESS,
        amountIn: TEN_VAULT_SHARES,
      });

      expect(hasValidOutput(result.amountsOut, USDC_ADDRESS)).toBe(true);
    }, API_TIMEOUT);
  });

  // ============================================
  // 2. BASIC ZAP IN/OUT - yscvxCRV (cvxCRV strategy vault)
  // ============================================
  describe("yscvxCRV (cvxCRV strategy vault) - Zap In/Out", () => {
    it("ETH → yscvxCRV (zap in)", async () => {
      const result = await fetchZapInRoute({
        fromAddress: TEST_WALLET,
        vaultAddress: VAULT_ADDRESSES.YSCVXCRV,
        inputToken: ETH_ADDRESS,
        amountIn: ONE_ETH,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YSCVXCRV)).toBe(true);
    }, API_TIMEOUT);

    it("USDC → yscvxCRV (zap in)", async () => {
      const result = await fetchZapInRoute({
        fromAddress: TEST_WALLET,
        vaultAddress: VAULT_ADDRESSES.YSCVXCRV,
        inputToken: USDC_ADDRESS,
        amountIn: ONE_THOUSAND_USDC,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YSCVXCRV)).toBe(true);
    }, API_TIMEOUT);

    it("yscvxCRV → ETH (zap out)", async () => {
      const result = await fetchZapOutRoute({
        fromAddress: TEST_WALLET,
        vaultAddress: VAULT_ADDRESSES.YSCVXCRV,
        outputToken: ETH_ADDRESS,
        amountIn: TEN_VAULT_SHARES,
      });

      expect(hasValidOutput(result.amountsOut, ETH_ADDRESS)).toBe(true);
    }, API_TIMEOUT);
  });

  // ============================================
  // 3. BASIC ZAP IN/OUT - yscvgCVX (cvgCVX vault)
  // ============================================
  describe("yscvgCVX (cvgCVX vault) - Zap In/Out", () => {
    it("ETH → yscvgCVX (zap in)", async () => {
      const result = await fetchCvgCvxZapInRoute({
        fromAddress: TEST_WALLET,
        vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
        inputToken: ETH_ADDRESS,
        amountIn: ONE_ETH,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YSCVGCVX)).toBe(true);
    }, API_TIMEOUT);

    it("CVX → yscvgCVX (zap in)", async () => {
      const result = await fetchCvgCvxZapInRoute({
        fromAddress: TEST_WALLET,
        vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
        inputToken: TOKENS.CVX,
        amountIn: ONE_HUNDRED_CVX,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YSCVGCVX)).toBe(true);
    }, API_TIMEOUT);

    it("USDC → yscvgCVX (zap in)", async () => {
      const result = await fetchCvgCvxZapInRoute({
        fromAddress: TEST_WALLET,
        vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
        inputToken: USDC_ADDRESS,
        amountIn: ONE_THOUSAND_USDC,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YSCVGCVX)).toBe(true);
    }, API_TIMEOUT);

    it("yscvgCVX → ETH (zap out)", async () => {
      const result = await fetchCvgCvxZapOutRoute({
        fromAddress: TEST_WALLET,
        vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
        outputToken: ETH_ADDRESS,
        amountIn: TEN_VAULT_SHARES,
      });

      expect(hasValidOutput(result.amountsOut, ETH_ADDRESS)).toBe(true);
    }, API_TIMEOUT);

    it("yscvgCVX → CVX (zap out)", async () => {
      const result = await fetchCvgCvxZapOutRoute({
        fromAddress: TEST_WALLET,
        vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
        outputToken: TOKENS.CVX,
        amountIn: TEN_VAULT_SHARES,
      });

      // CVX1.withdraw() sends CVX directly to user, not tracked in amountsOut
      // Check for valid bundle instead
      expect(isValidBundle(result)).toBe(true);
    }, API_TIMEOUT);
  });

  // ============================================
  // 4. VAULT-TO-VAULT - Same underlying (cvxCRV)
  // ============================================
  describe("Vault-to-Vault - Same underlying (cvxCRV)", () => {
    it("ycvxCRV → yscvxCRV", async () => {
      const result = await fetchVaultToVaultRoute({
        fromAddress: TEST_WALLET,
        sourceVault: VAULT_ADDRESSES.YCVXCRV,
        targetVault: VAULT_ADDRESSES.YSCVXCRV,
        amountIn: TEN_VAULT_SHARES,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YSCVXCRV)).toBe(true);
    }, API_TIMEOUT);

    it("yscvxCRV → ycvxCRV", async () => {
      const result = await fetchVaultToVaultRoute({
        fromAddress: TEST_WALLET,
        sourceVault: VAULT_ADDRESSES.YSCVXCRV,
        targetVault: VAULT_ADDRESSES.YCVXCRV,
        amountIn: TEN_VAULT_SHARES,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YCVXCRV)).toBe(true);
    }, API_TIMEOUT);
  });

  // ============================================
  // 5. VAULT-TO-VAULT - Different underlying
  // ============================================
  describe("Vault-to-Vault - Different underlying", () => {
    it("ycvxCRV → yscvgCVX (cvxCRV → cvgCVX)", async () => {
      const result = await fetchVaultToVaultRoute({
        fromAddress: TEST_WALLET,
        sourceVault: VAULT_ADDRESSES.YCVXCRV,
        targetVault: VAULT_ADDRESSES.YSCVGCVX,
        amountIn: TEN_VAULT_SHARES,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YSCVGCVX)).toBe(true);
    }, API_TIMEOUT);

    it("yscvgCVX → ycvxCRV (cvgCVX → cvxCRV)", async () => {
      const result = await fetchVaultToVaultRoute({
        fromAddress: TEST_WALLET,
        sourceVault: VAULT_ADDRESSES.YSCVGCVX,
        targetVault: VAULT_ADDRESSES.YCVXCRV,
        amountIn: TEN_VAULT_SHARES,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YCVXCRV)).toBe(true);
    }, API_TIMEOUT);

    it("yscvgCVX → yscvxCRV (cvgCVX → cvxCRV strategy)", async () => {
      const result = await fetchVaultToVaultRoute({
        fromAddress: TEST_WALLET,
        sourceVault: VAULT_ADDRESSES.YSCVGCVX,
        targetVault: VAULT_ADDRESSES.YSCVXCRV,
        amountIn: TEN_VAULT_SHARES,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YSCVXCRV)).toBe(true);
    }, API_TIMEOUT);

    it("yscvxCRV → yscvgCVX (cvxCRV strategy → cvgCVX)", async () => {
      const result = await fetchVaultToVaultRoute({
        fromAddress: TEST_WALLET,
        sourceVault: VAULT_ADDRESSES.YSCVXCRV,
        targetVault: VAULT_ADDRESSES.YSCVGCVX,
        amountIn: TEN_VAULT_SHARES,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YSCVGCVX)).toBe(true);
    }, API_TIMEOUT);
  });

  // ============================================
  // 6. UI VALIDATION - Same vault should be blocked
  // ============================================
  describe("UI Validation - Same vault blocked", () => {
    it("ycvxCRV → ycvxCRV should throw error", async () => {
      await expect(
        fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YCVXCRV,
          targetVault: VAULT_ADDRESSES.YCVXCRV,
          amountIn: TEN_VAULT_SHARES,
        })
      ).rejects.toThrow("Cannot zap from a vault to itself");
    });

    it("yscvxCRV → yscvxCRV should throw error", async () => {
      await expect(
        fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YSCVXCRV,
          targetVault: VAULT_ADDRESSES.YSCVXCRV,
          amountIn: TEN_VAULT_SHARES,
        })
      ).rejects.toThrow("Cannot zap from a vault to itself");
    });

    it("yscvgCVX → yscvgCVX should throw error", async () => {
      await expect(
        fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YSCVGCVX,
          targetVault: VAULT_ADDRESSES.YSCVGCVX,
          amountIn: TEN_VAULT_SHARES,
        })
      ).rejects.toThrow("Cannot zap from a vault to itself");
    });

    it("yspxCVX → yspxCVX should throw error", async () => {
      await expect(
        fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YSPXCVX,
          targetVault: VAULT_ADDRESSES.YSPXCVX,
          amountIn: TEN_VAULT_SHARES,
        })
      ).rejects.toThrow("Cannot zap from a vault to itself");
    });
  });

  // ============================================
  // 7. UI VALIDATION - Underlying tokens should be excluded from UI
  //    (use deposit/redeem tabs instead)
  //    These validate that VAULT_UNDERLYING_TOKENS are correctly defined
  // ============================================
  describe("UI Validation - Underlying token exclusion", () => {
    it("VAULT_UNDERLYING_TOKENS includes cvxCRV", () => {
      expect(VAULT_UNDERLYING_TOKENS).toContain(TOKENS.CVXCRV);
    });

    it("VAULT_UNDERLYING_TOKENS includes cvgCVX", () => {
      expect(VAULT_UNDERLYING_TOKENS).toContain(TOKENS.CVGCVX);
    });

    it("VAULT_UNDERLYING_TOKENS includes pxCVX", () => {
      expect(VAULT_UNDERLYING_TOKENS).toContain(TOKENS.PXCVX);
    });

    // These tests validate the UI logic:
    // cvxCRV → ycvxCRV should be blocked (user should use deposit tab)
    // ycvxCRV → cvxCRV should be blocked (user should use redeem tab)
    // The actual validation happens in TokenSelector via excludeTokens
  });

  // ============================================
  // 8. Basic route tests (token → token)
  // ============================================
  describe("Basic Routes", () => {
    it("ETH → cvxCRV", async () => {
      const result = await fetchRoute({
        fromAddress: TEST_WALLET,
        tokenIn: ETH_ADDRESS,
        tokenOut: TOKENS.CVXCRV,
        amountIn: ONE_ETH,
      });

      expect(BigInt(result.amountOut)).toBeGreaterThan(0n);
    }, API_TIMEOUT);

    it("ETH → CVX", async () => {
      const result = await fetchRoute({
        fromAddress: TEST_WALLET,
        tokenIn: ETH_ADDRESS,
        tokenOut: TOKENS.CVX,
        amountIn: ONE_ETH,
      });

      expect(BigInt(result.amountOut)).toBeGreaterThan(0n);
    }, API_TIMEOUT);

    it("USDC → CVX", async () => {
      const result = await fetchRoute({
        fromAddress: TEST_WALLET,
        tokenIn: USDC_ADDRESS,
        tokenOut: TOKENS.CVX,
        amountIn: ONE_THOUSAND_USDC,
      });

      expect(BigInt(result.amountOut)).toBeGreaterThan(0n);
    }, API_TIMEOUT);
  });

  // ============================================
  // 9. VAULT-TO-VAULT with pxCVX
  // ============================================
  describe("Vault-to-Vault - pxCVX routes", () => {
    it("yspxCVX → ycvxCRV (pxCVX → cvxCRV)", async () => {
      const result = await fetchVaultToVaultRoute({
        fromAddress: TEST_WALLET,
        sourceVault: VAULT_ADDRESSES.YSPXCVX,
        targetVault: VAULT_ADDRESSES.YCVXCRV,
        amountIn: TEN_VAULT_SHARES,
      });

      expect(hasValidOutput(result.amountsOut, VAULT_ADDRESSES.YCVXCRV)).toBe(true);
    }, API_TIMEOUT);

    it("ycvxCRV → yspxCVX (cvxCRV → pxCVX)", async () => {
      const result = await fetchVaultToVaultRoute({
        fromAddress: TEST_WALLET,
        sourceVault: VAULT_ADDRESSES.YCVXCRV,
        targetVault: VAULT_ADDRESSES.YSPXCVX,
        amountIn: TEN_VAULT_SHARES,
      });

      // Uses enso.call for final deposit so vault shares not tracked in amountsOut
      expect(isValidBundle(result)).toBe(true);
    }, API_TIMEOUT);
  });
});
