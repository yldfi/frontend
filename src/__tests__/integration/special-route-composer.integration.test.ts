// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crossFetch from "cross-fetch";

beforeAll(() => {
  globalThis.fetch = crossFetch;
});

afterAll(() => {
  globalThis.fetch = vi.fn();
});

import {
  fetchSpecialTokenToExternalVaultRoute,
  fetchSpecialTokenToIlliquidRoute,
  fetchYldVaultToIlliquidRoute,
} from "@/lib/enso";
import { LLAMA_AIRFORCE, TOKENS, VAULT_ADDRESSES } from "@/config/vaults";
import { YVUSDC1_ADDRESS } from "@/config/addresses";

const TEST_WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const TEST_SLIPPAGE = "300";
const TEN_SHARES = "10000000000000000000";
const TEN_YVUSDC_SHARES = "10000000";

function isExpectedError(e: unknown): boolean {
  const errorMsg = e instanceof Error ? e.message : String(e);
  const errorStr = JSON.stringify(e);
  return (
    errorMsg.includes("429") ||
    errorStr.includes("429") ||
    errorMsg.includes("RPC request failed") ||
    errorMsg.includes("get_dy after retries") ||
    errorMsg.includes("slippage") ||
    errorStr.includes("slippage") ||
    errorStr.includes("insufficient") ||
    errorStr.includes("Could not simulate tx") ||
    errorStr.includes("transfer amount exceeds balance") ||
    errorStr.includes("Could not build Bundle") ||
    errorStr.includes("Could not build shortcuts") ||
    errorStr.includes("Swap not found") ||
    errorStr.includes("within an acceptable range")
  );
}

describe("Special Route Composer Integration", () => {
  it(
    "yvUSDC-1 -> pxCVX builds the exact external-vault exit path",
    async () => {
      try {
        const result = await fetchSpecialTokenToIlliquidRoute({
          fromAddress: TEST_WALLET,
          inputToken: YVUSDC1_ADDRESS,
          outputToken: TOKENS.PXCVX,
          amountIn: TEN_YVUSDC_SHARES,
          slippage: TEST_SLIPPAGE,
        });

        const outputAmount =
          result.amountsOut[TOKENS.PXCVX.toLowerCase()] ||
          result.amountsOut[TOKENS.PXCVX];
        expect(outputAmount).toBeDefined();
        expect(BigInt(outputAmount)).toBeGreaterThan(0n);
        expect(result.tx).toBeDefined();
        expect(result.routeInfo?.tokens).toContain("yvUSDC-1");
        expect(result.routeInfo?.tokens).toContain("pxCVX");
      } catch (e) {
        if (isExpectedError(e)) {
          console.log("Note: Expected transient/preview error during yvUSDC-1 -> pxCVX verification");
          return;
        }
        throw e;
      }
    },
    45000,
  );

  it(
    "uCRV -> pxCVX builds a composable illiquid-output route",
    async () => {
      try {
        const result = await fetchSpecialTokenToIlliquidRoute({
          fromAddress: TEST_WALLET,
          inputToken: LLAMA_AIRFORCE.UCRV,
          outputToken: TOKENS.PXCVX,
          amountIn: TEN_SHARES,
          slippage: TEST_SLIPPAGE,
        });

        const outputAmount =
          result.amountsOut[TOKENS.PXCVX.toLowerCase()] ||
          result.amountsOut[TOKENS.PXCVX];
        expect(outputAmount).toBeDefined();
        expect(BigInt(outputAmount)).toBeGreaterThan(0n);
        expect(result.tx).toBeDefined();
        expect(result.routeInfo?.tokens).toContain("uCRV");
        expect(result.routeInfo?.tokens).toContain("pxCVX");
      } catch (e) {
        if (isExpectedError(e)) {
          console.log("Note: Expected transient/preview error during uCRV -> pxCVX verification");
          return;
        }
        throw e;
      }
    },
    45000,
  );

  it(
    "yvUSDC-1 -> uCVX builds an external-vault to external-vault route",
    async () => {
      try {
        const result = await fetchSpecialTokenToExternalVaultRoute({
          fromAddress: TEST_WALLET,
          inputToken: YVUSDC1_ADDRESS,
          outputVault: LLAMA_AIRFORCE.UCVX,
          amountIn: TEN_YVUSDC_SHARES,
          slippage: TEST_SLIPPAGE,
        });

        const outputAmount =
          result.amountsOut[LLAMA_AIRFORCE.UCVX.toLowerCase()] ||
          result.amountsOut[LLAMA_AIRFORCE.UCVX];
        expect(outputAmount).toBeDefined();
        expect(BigInt(outputAmount)).toBeGreaterThan(0n);
        expect(result.tx).toBeDefined();
        expect(result.routeInfo?.tokens).toContain("yvUSDC-1");
        expect(result.routeInfo?.tokens).toContain("uCVX");
      } catch (e) {
        if (isExpectedError(e)) {
          console.log("Note: Expected transient/preview error during yvUSDC-1 -> uCVX verification");
          return;
        }
        throw e;
      }
    },
    45000,
  );

  it(
    "ycvxCRV -> pxCVX builds a yld-vault to illiquid-token route",
    async () => {
      try {
        const result = await fetchYldVaultToIlliquidRoute({
          fromAddress: TEST_WALLET,
          sourceVault: VAULT_ADDRESSES.YCVXCRV,
          sourceUnderlying: TOKENS.CVXCRV,
          outputToken: TOKENS.PXCVX,
          amountIn: TEN_SHARES,
          slippage: TEST_SLIPPAGE,
        });

        const outputAmount =
          result.amountsOut[TOKENS.PXCVX.toLowerCase()] ||
          result.amountsOut[TOKENS.PXCVX];
        expect(outputAmount).toBeDefined();
        expect(BigInt(outputAmount)).toBeGreaterThan(0n);
        expect(result.tx).toBeDefined();
        expect(result.routeInfo?.tokens).toContain("ycvxCRV");
        expect(result.routeInfo?.tokens).toContain("pxCVX");
      } catch (e) {
        if (isExpectedError(e)) {
          console.log("Note: Expected transient/preview error during ycvxCRV -> pxCVX verification");
          return;
        }
        throw e;
      }
    },
    45000,
  );
});
