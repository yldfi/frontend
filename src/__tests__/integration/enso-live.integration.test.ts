/**
 * Live Enso API Integration Tests
 *
 * These tests make real API calls to verify our Enso integration works correctly.
 * Run with: pnpm vitest run src/__tests__/integration/enso-live.integration.test.ts
 *
 * Tests mirror the actual UI flows in useZapQuote.ts
 *
 * NOTE: These tests require real network access and hit the live Enso API.
 * They are slower and may fail due to network issues or API rate limits.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Import cross-fetch to use real network requests
// vitest.setup.ts mocks global fetch, but we need real fetch for live API tests
import crossFetch from "cross-fetch";

beforeAll(() => {
  // Replace mocked fetch with real cross-fetch for live API testing
  globalThis.fetch = crossFetch;
});

afterAll(() => {
  // Restore mocked fetch (vitest will handle cleanup)
  globalThis.fetch = vi.fn();
});
import {
  fetchRoute,
  fetchZapInRoute,
  fetchZapOutRoute,
  fetchVaultToVaultRoute,
  fetchCvgCvxZapInRoute,
  fetchCvgCvxZapOutRoute,
  fetchPxCvxZapInRoute,
  fetchPxCvxZapOutRoute,
  ETH_ADDRESS,
} from "@/lib/enso";
import { VAULT_ADDRESSES, TOKENS } from "@/config/vaults";

// Test wallet address (vitalik.eth - has no special permissions, just for API calls)
const TEST_WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

// Test amounts
const ONE_ETH = "1000000000000000000"; // 1 ETH
const TEN_VAULT_SHARES = "10000000000000000000"; // 10 shares

// Timeout for API calls
const API_TIMEOUT = 30000;

describe("Enso Live API Integration", () => {
  describe("fetchRoute - Basic token swaps", () => {
    it(
      "ETH → cvxCRV route works",
      async () => {
        const result = await fetchRoute({
          fromAddress: TEST_WALLET,
          tokenIn: ETH_ADDRESS,
          tokenOut: TOKENS.CVXCRV,
          amountIn: ONE_ETH,
        });

        expect(result.amountOut).toBeDefined();
        expect(BigInt(result.amountOut)).toBeGreaterThan(0n);
        expect(result.tx).toBeDefined();
        expect(result.tx.to).toBeDefined();
        expect(result.tx.data).toBeDefined();
      },
      API_TIMEOUT
    );

    it(
      "ETH → CVX route works",
      async () => {
        const result = await fetchRoute({
          fromAddress: TEST_WALLET,
          tokenIn: ETH_ADDRESS,
          tokenOut: TOKENS.CVX,
          amountIn: ONE_ETH,
        });

        expect(result.amountOut).toBeDefined();
        expect(BigInt(result.amountOut)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );
  });

  describe("fetchZapInRoute - ERC20 → Vault deposits", () => {
    it(
      "ETH → ycvxCRV (standard cvxCRV vault)",
      async () => {
        const result = await fetchZapInRoute({
          fromAddress: TEST_WALLET,
          vaultAddress: VAULT_ADDRESSES.YCVXCRV,
          inputToken: ETH_ADDRESS,
          amountIn: ONE_ETH,
        });

        expect(result.amountsOut).toBeDefined();
        const vaultOutput =
          result.amountsOut[VAULT_ADDRESSES.YCVXCRV.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YCVXCRV];
        expect(vaultOutput).toBeDefined();
        expect(BigInt(vaultOutput)).toBeGreaterThan(0n);
        expect(result.tx).toBeDefined();
      },
      API_TIMEOUT
    );

    it(
      "ETH → yscvxCRV (strategy vault)",
      async () => {
        const result = await fetchZapInRoute({
          fromAddress: TEST_WALLET,
          vaultAddress: VAULT_ADDRESSES.YSCVXCRV,
          inputToken: ETH_ADDRESS,
          amountIn: ONE_ETH,
        });

        expect(result.amountsOut).toBeDefined();
        const vaultOutput =
          result.amountsOut[VAULT_ADDRESSES.YSCVXCRV.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YSCVXCRV];
        expect(vaultOutput).toBeDefined();
        expect(BigInt(vaultOutput)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );
  });

  describe("fetchCvgCvxZapInRoute - ERC20 → cvgCVX vault", () => {
    it(
      "ETH → yscvgCVX (custom cvgCVX routing)",
      async () => {
        const result = await fetchCvgCvxZapInRoute({
          fromAddress: TEST_WALLET,
          vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
          inputToken: ETH_ADDRESS,
          amountIn: ONE_ETH,
        });

        expect(result.amountsOut).toBeDefined();
        const vaultOutput =
          result.amountsOut[VAULT_ADDRESSES.YSCVGCVX.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YSCVGCVX];
        expect(vaultOutput).toBeDefined();
        expect(BigInt(vaultOutput)).toBeGreaterThan(0n);
        expect(result.tx).toBeDefined();
      },
      API_TIMEOUT
    );

    it(
      "CVX → yscvgCVX (direct CVX to cvgCVX)",
      async () => {
        const result = await fetchCvgCvxZapInRoute({
          fromAddress: TEST_WALLET,
          vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
          inputToken: TOKENS.CVX,
          amountIn: "100000000000000000000", // 100 CVX
        });

        expect(result.amountsOut).toBeDefined();
        const vaultOutput =
          result.amountsOut[VAULT_ADDRESSES.YSCVGCVX.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YSCVGCVX];
        expect(vaultOutput).toBeDefined();
        expect(BigInt(vaultOutput)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );
  });

  describe("fetchPxCvxZapInRoute - ERC20 → pxCVX vault", () => {
    it(
      "ETH → yspxCVX (custom pxCVX routing)",
      async () => {
        const result = await fetchPxCvxZapInRoute({
          fromAddress: TEST_WALLET,
          vaultAddress: VAULT_ADDRESSES.YSPXCVX,
          inputToken: ETH_ADDRESS,
          amountIn: ONE_ETH,
        });

        expect(result.amountsOut).toBeDefined();
        const vaultOutput =
          result.amountsOut[VAULT_ADDRESSES.YSPXCVX.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YSPXCVX];
        expect(vaultOutput).toBeDefined();
        expect(BigInt(vaultOutput)).toBeGreaterThan(0n);
        expect(result.tx).toBeDefined();
      },
      API_TIMEOUT
    );
  });

  describe("fetchZapOutRoute - Vault → ERC20 withdrawals", () => {
    it(
      "ycvxCRV → ETH (standard vault withdrawal)",
      async () => {
        const result = await fetchZapOutRoute({
          fromAddress: TEST_WALLET,
          vaultAddress: VAULT_ADDRESSES.YCVXCRV,
          outputToken: ETH_ADDRESS,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const ethOutput =
          result.amountsOut[ETH_ADDRESS.toLowerCase()] || result.amountsOut[ETH_ADDRESS];
        expect(ethOutput).toBeDefined();
        expect(BigInt(ethOutput)).toBeGreaterThan(0n);
        expect(result.tx).toBeDefined();
      },
      API_TIMEOUT
    );
  });

  describe("fetchCvgCvxZapOutRoute - cvgCVX vault → ERC20", () => {
    it(
      "yscvgCVX → ETH (custom cvgCVX routing)",
      async () => {
        const result = await fetchCvgCvxZapOutRoute({
          fromAddress: TEST_WALLET,
          vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
          outputToken: ETH_ADDRESS,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const ethOutput =
          result.amountsOut[ETH_ADDRESS.toLowerCase()] || result.amountsOut[ETH_ADDRESS];
        expect(ethOutput).toBeDefined();
        expect(BigInt(ethOutput)).toBeGreaterThan(0n);
        expect(result.tx).toBeDefined();
      },
      API_TIMEOUT
    );
  });

  describe("fetchPxCvxZapOutRoute - pxCVX vault → ERC20", () => {
    it(
      "yspxCVX → ETH (custom pxCVX routing)",
      async () => {
        const result = await fetchPxCvxZapOutRoute({
          fromAddress: TEST_WALLET,
          vaultAddress: VAULT_ADDRESSES.YSPXCVX,
          outputToken: ETH_ADDRESS,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const ethOutput =
          result.amountsOut[ETH_ADDRESS.toLowerCase()] || result.amountsOut[ETH_ADDRESS];
        expect(ethOutput).toBeDefined();
        expect(BigInt(ethOutput)).toBeGreaterThan(0n);
        expect(result.tx).toBeDefined();
      },
      API_TIMEOUT
    );
  });

  describe("fetchVaultToVaultRoute - Vault → Vault zaps", () => {
    it(
      "ycvxCRV → yscvxCRV (same underlying: cvxCRV)",
      async () => {
        const result = await fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YCVXCRV,
          targetVault: VAULT_ADDRESSES.YSCVXCRV,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const targetOutput =
          result.amountsOut[VAULT_ADDRESSES.YSCVXCRV.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YSCVXCRV];
        expect(targetOutput).toBeDefined();
        expect(BigInt(targetOutput)).toBeGreaterThan(0n);
        expect(result.tx).toBeDefined();
      },
      API_TIMEOUT
    );

    it(
      "yscvxCRV → ycvxCRV (same underlying: cvxCRV, reverse)",
      async () => {
        const result = await fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YSCVXCRV,
          targetVault: VAULT_ADDRESSES.YCVXCRV,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const targetOutput =
          result.amountsOut[VAULT_ADDRESSES.YCVXCRV.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YCVXCRV];
        expect(targetOutput).toBeDefined();
        expect(BigInt(targetOutput)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );

    it(
      "ycvxCRV → yscvgCVX (different underlying: cvxCRV → cvgCVX)",
      async () => {
        const result = await fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YCVXCRV,
          targetVault: VAULT_ADDRESSES.YSCVGCVX,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const targetOutput =
          result.amountsOut[VAULT_ADDRESSES.YSCVGCVX.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YSCVGCVX];
        expect(targetOutput).toBeDefined();
        expect(BigInt(targetOutput)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );

    it(
      "yscvgCVX → ycvxCRV (different underlying: cvgCVX → cvxCRV)",
      async () => {
        const result = await fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YSCVGCVX,
          targetVault: VAULT_ADDRESSES.YCVXCRV,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const targetOutput =
          result.amountsOut[VAULT_ADDRESSES.YCVXCRV.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YCVXCRV];
        expect(targetOutput).toBeDefined();
        expect(BigInt(targetOutput)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );

    it(
      "yspxCVX → ycvxCRV (different underlying: pxCVX → cvxCRV)",
      async () => {
        const result = await fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YSPXCVX,
          targetVault: VAULT_ADDRESSES.YCVXCRV,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const targetOutput =
          result.amountsOut[VAULT_ADDRESSES.YCVXCRV.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YCVXCRV];
        expect(targetOutput).toBeDefined();
        expect(BigInt(targetOutput)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );

    it(
      "yspxCVX → yscvgCVX (different underlying: pxCVX → cvgCVX)",
      async () => {
        const result = await fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YSPXCVX,
          targetVault: VAULT_ADDRESSES.YSCVGCVX,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const targetOutput =
          result.amountsOut[VAULT_ADDRESSES.YSCVGCVX.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YSCVGCVX];
        expect(targetOutput).toBeDefined();
        expect(BigInt(targetOutput)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );

    it(
      "yscvgCVX → yspxCVX (different underlying: cvgCVX → pxCVX)",
      async () => {
        const result = await fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YSCVGCVX,
          targetVault: VAULT_ADDRESSES.YSPXCVX,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const targetOutput =
          result.amountsOut[VAULT_ADDRESSES.YSPXCVX.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YSPXCVX];
        expect(targetOutput).toBeDefined();
        expect(BigInt(targetOutput)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );

    it(
      "ycvxCRV → yspxCVX (different underlying: cvxCRV → pxCVX)",
      async () => {
        const result = await fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YCVXCRV,
          targetVault: VAULT_ADDRESSES.YSPXCVX,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const targetOutput =
          result.amountsOut[VAULT_ADDRESSES.YSPXCVX.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YSPXCVX];
        expect(targetOutput).toBeDefined();
        expect(BigInt(targetOutput)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );

    it(
      "yscvxCRV → yscvgCVX (different underlying: cvxCRV → cvgCVX)",
      async () => {
        const result = await fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YSCVXCRV,
          targetVault: VAULT_ADDRESSES.YSCVGCVX,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const targetOutput =
          result.amountsOut[VAULT_ADDRESSES.YSCVGCVX.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YSCVGCVX];
        expect(targetOutput).toBeDefined();
        expect(BigInt(targetOutput)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );

    it(
      "yscvxCRV → yspxCVX (different underlying: cvxCRV → pxCVX)",
      async () => {
        const result = await fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YSCVXCRV,
          targetVault: VAULT_ADDRESSES.YSPXCVX,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const targetOutput =
          result.amountsOut[VAULT_ADDRESSES.YSPXCVX.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YSPXCVX];
        expect(targetOutput).toBeDefined();
        expect(BigInt(targetOutput)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );

    it(
      "yscvgCVX → yscvxCRV (different underlying: cvgCVX → cvxCRV)",
      async () => {
        const result = await fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YSCVGCVX,
          targetVault: VAULT_ADDRESSES.YSCVXCRV,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const targetOutput =
          result.amountsOut[VAULT_ADDRESSES.YSCVXCRV.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YSCVXCRV];
        expect(targetOutput).toBeDefined();
        expect(BigInt(targetOutput)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );

    it(
      "yspxCVX → yscvxCRV (different underlying: pxCVX → cvxCRV)",
      async () => {
        const result = await fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YSPXCVX,
          targetVault: VAULT_ADDRESSES.YSCVXCRV,
          amountIn: TEN_VAULT_SHARES,
        });

        expect(result.amountsOut).toBeDefined();
        const targetOutput =
          result.amountsOut[VAULT_ADDRESSES.YSCVXCRV.toLowerCase()] ||
          result.amountsOut[VAULT_ADDRESSES.YSCVXCRV];
        expect(targetOutput).toBeDefined();
        expect(BigInt(targetOutput)).toBeGreaterThan(0n);
      },
      API_TIMEOUT
    );

    it("blocks same-vault zaps", async () => {
      await expect(
        fetchVaultToVaultRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YCVXCRV,
          targetVault: VAULT_ADDRESSES.YCVXCRV,
          amountIn: TEN_VAULT_SHARES,
        })
      ).rejects.toThrow("Cannot zap from a vault to itself");
    });
  });
});
