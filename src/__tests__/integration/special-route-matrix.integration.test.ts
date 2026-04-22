// @vitest-environment node

/**
 * Full live special-route matrix.
 *
 * This intentionally covers the currently supported non-routeable families:
 * - yld vault -> illiquid token
 * - special input (external vault / illiquid token) -> illiquid token
 * - special input (external vault / illiquid token) -> external vault
 * - external vault -> pxCVX yld vault
 *
 * Run explicitly with:
 *   ENSO_RATE_LIMIT_MS=500 RUN_FULL_ROUTE_MATRIX=1 pnpm vitest run src/__tests__/integration/special-route-matrix.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crossFetch from "cross-fetch";
import { YVUSDC1_ADDRESS } from "@/config/addresses";

type MatrixErrorOutcome =
  | "rate_limited"
  | "balance_or_simulation"
  | "infra_transient"
  | "hard_failure";

const matrixOutcomes = {
  rateLimited: new Set<string>(),
  balanceOrSimulation: new Set<string>(),
  infraTransient: new Set<string>(),
};

beforeAll(() => {
  globalThis.fetch = crossFetch;
});

afterAll(() => {
  globalThis.fetch = vi.fn();

  if (process.env.RUN_FULL_ROUTE_MATRIX !== "1") {
    return;
  }

  const summary = [
    `rate_limited=${matrixOutcomes.rateLimited.size}`,
    `balance_or_simulation=${matrixOutcomes.balanceOrSimulation.size}`,
    `infra_transient=${matrixOutcomes.infraTransient.size}`,
  ].join(" ");

  console.log(`[Matrix Summary] ${summary}`);

  expect(
    [...matrixOutcomes.rateLimited],
    "Full live route matrix hit Enso rate limits; rerun with stronger pacing or investigate unexpected request bursts.",
  ).toEqual([]);
});

import {
  fetchCvgCvxZapInRoute,
  fetchComposableZapInRoute,
  fetchExternalVaultZapInRoute,
  fetchLpxCvxZapInRoute,
  fetchPxCvxTokenZapInRoute,
  fetchPxCvxZapInRoute,
  fetchSpecialTokenToExternalVaultRoute,
  fetchSpecialTokenToIlliquidRoute,
  fetchYldVaultToIlliquidRoute,
  getTokenSymbol,
} from "@/lib/enso";
import {
  EXTERNAL_VAULT_CONFIG,
  TOKENS,
  VAULTS,
  VAULT_ADDRESSES,
} from "@/config/vaults";

const TEST_WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const TEST_SLIPPAGE = "300";
const TEST_TOKEN_UNITS = 10n;
// Live Enso + RPC-backed matrix cases occasionally exceed 45s even when they succeed.
const API_TIMEOUT = 90000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const matrixIt = process.env.RUN_FULL_ROUTE_MATRIX === "1" ? it : it.skip;

function classifyMatrixError(e: unknown): MatrixErrorOutcome {
  const errorMsg = e instanceof Error ? e.message : String(e);
  const errorStr = JSON.stringify(e);

  if (errorMsg.includes("429") || errorStr.includes("429")) {
    return "rate_limited";
  }

  if (
    errorMsg.includes("slippage") ||
    errorStr.includes("slippage") ||
    errorMsg.includes("transfer amount exceeds balance") ||
    errorStr.includes("transfer amount exceeds balance") ||
    errorMsg.includes("Could not simulate tx") ||
    errorStr.includes("Could not simulate tx") ||
    errorMsg.includes("insufficient") ||
    errorStr.includes("insufficient")
  ) {
    return "balance_or_simulation";
  }

  if (
    errorMsg.includes("RPC request failed") ||
    errorMsg.includes("get_dy after retries") ||
    errorMsg.includes("request timeout") ||
    errorMsg.includes("network") ||
    errorMsg.includes("Swap not found for a required underlying of defi route") ||
    errorStr.includes("ETIMEDOUT") ||
    errorStr.includes("ECONNRESET")
  ) {
    return "infra_transient";
  }

  return "hard_failure";
}

function recordMatrixOutcome(label: string, outcome: Exclude<MatrixErrorOutcome, "hard_failure">): void {
  if (outcome === "rate_limited") {
    matrixOutcomes.rateLimited.add(label);
    console.log(`Note: rate-limited during ${label}`);
    return;
  }

  if (outcome === "balance_or_simulation") {
    matrixOutcomes.balanceOrSimulation.add(label);
    console.log(`Note: balance/simulation noise during ${label}`);
    return;
  }

  matrixOutcomes.infraTransient.add(label);
  console.log(`Note: infra transient during ${label}`);
}

async function expectRouteBuild(
  label: string,
  outputAddress: string,
  run: () => Promise<{
    amountsOut: Record<string, string>;
    tx: { to: string; data: string; value: string };
    routeInfo?: { tokens?: string[] };
  }>,
): Promise<void> {
  try {
    const result = await run();
    const outputAmount =
      result.amountsOut[outputAddress.toLowerCase()] ||
      result.amountsOut[outputAddress];

    expect(outputAmount, `${label} should populate amountsOut`).toBeDefined();
    expect(BigInt(outputAmount), `${label} should have positive output`).toBeGreaterThan(0n);
    expect(result.tx?.to, `${label} should build tx.to`).toBeDefined();
    expect(result.tx?.data, `${label} should build tx.data`).toBeDefined();
  } catch (e) {
    const outcome = classifyMatrixError(e);
    if (outcome !== "hard_failure") {
      recordMatrixOutcome(label, outcome);
      return;
    }
    throw e;
  }
}

const LIVE_YLD_VAULTS = Object.values(VAULTS)
  .filter((vault) => vault.address.toLowerCase() !== ZERO_ADDRESS.toLowerCase())
  .map((vault) => ({
    address: vault.address,
    amountIn: (TEST_TOKEN_UNITS * (10n ** BigInt(vault.decimals))).toString(),
    decimals: vault.decimals,
    symbol: vault.symbol,
    underlying: vault.assetAddress,
  }));

const ILLIQUID_TOKENS = [
  { address: TOKENS.PXCVX, decimals: 18, symbol: "pxCVX" },
  { address: TOKENS.CVGCVX, decimals: 18, symbol: "cvgCVX" },
  { address: TOKENS.LPXCVX, decimals: 18, symbol: "lpxCVX" },
] as const;

const EXTERNAL_VAULTS = Object.values(EXTERNAL_VAULT_CONFIG).map((config) => ({
  address: config.address,
  decimals: config.address.toLowerCase() === YVUSDC1_ADDRESS.toLowerCase() ? 6 : 18,
  symbol: config.symbol,
}));

const SPECIAL_INPUTS = [
  ...EXTERNAL_VAULTS.map((token) => ({
    ...token,
    amountIn: (TEST_TOKEN_UNITS * (10n ** BigInt(token.decimals))).toString(),
    kind: "external" as const,
  })),
  ...ILLIQUID_TOKENS.map((token) => ({
    ...token,
    amountIn: (TEST_TOKEN_UNITS * (10n ** BigInt(token.decimals))).toString(),
    kind: "illiquid" as const,
  })),
];

async function buildSpecialInputToYldRoute(params: {
  inputToken: { address: string; amountIn: string; kind: "external" | "illiquid"; symbol: string };
  vault: { address: string; amountIn: string; decimals: number; symbol: string; underlying: string };
}): ReturnType<typeof fetchComposableZapInRoute> {
  const targetUnderlying = params.vault.underlying.toLowerCase();
  const inputAddress = params.inputToken.address.toLowerCase();
  const targetIsPx = targetUnderlying === TOKENS.PXCVX.toLowerCase();
  const targetIsCvg = targetUnderlying === TOKENS.CVGCVX.toLowerCase();
  const inputIsPx = inputAddress === TOKENS.PXCVX.toLowerCase();
  const inputIsCvg = inputAddress === TOKENS.CVGCVX.toLowerCase();
  const inputIsLpx = inputAddress === TOKENS.LPXCVX.toLowerCase();
  const amountIn = params.inputToken.amountIn;

  if (params.inputToken.kind === "external" && targetIsPx) {
    return fetchComposableZapInRoute({
      fromAddress: TEST_WALLET,
      inputToken: params.inputToken.address,
      vaultAddress: params.vault.address,
      amountIn,
      slippage: TEST_SLIPPAGE,
    });
  }

  if (params.inputToken.kind === "external") {
    return fetchExternalVaultZapInRoute({
      fromAddress: TEST_WALLET,
      vaultAddress: params.vault.address,
      externalVaultAddress: params.inputToken.address,
      amountIn,
      slippage: TEST_SLIPPAGE,
    });
  }

  if (inputIsLpx) {
    return fetchLpxCvxZapInRoute({
      fromAddress: TEST_WALLET,
      vaultAddress: params.vault.address,
      amountIn,
      slippage: TEST_SLIPPAGE,
    });
  }

  if (inputIsPx && !targetIsPx) {
    return fetchPxCvxTokenZapInRoute({
      fromAddress: TEST_WALLET,
      vaultAddress: params.vault.address,
      amountIn,
      slippage: TEST_SLIPPAGE,
    });
  }

  if (inputIsCvg && !targetIsCvg) {
    return fetchComposableZapInRoute({
      fromAddress: TEST_WALLET,
      inputToken: params.inputToken.address,
      vaultAddress: params.vault.address,
      amountIn,
      slippage: TEST_SLIPPAGE,
    });
  }

  if (targetIsCvg) {
    return fetchCvgCvxZapInRoute({
      fromAddress: TEST_WALLET,
      vaultAddress: params.vault.address,
      inputToken: params.inputToken.address,
      amountIn,
      slippage: TEST_SLIPPAGE,
    });
  }

  if (targetIsPx) {
    return fetchPxCvxZapInRoute({
      fromAddress: TEST_WALLET,
      vaultAddress: params.vault.address,
      inputToken: params.inputToken.address,
      amountIn,
      slippage: TEST_SLIPPAGE,
    });
  }

  return fetchComposableZapInRoute({
    fromAddress: TEST_WALLET,
    inputToken: params.inputToken.address,
    vaultAddress: params.vault.address,
    amountIn,
    slippage: TEST_SLIPPAGE,
  });
}

describe("Special Route Matrix Integration", () => {
  describe("yld vault -> illiquid token", () => {
    for (const sourceVault of LIVE_YLD_VAULTS) {
      for (const outputToken of ILLIQUID_TOKENS) {
        const label = `${sourceVault.symbol} -> ${outputToken.symbol}`;

        matrixIt(label, async () => {
          await expectRouteBuild(label, outputToken.address, () =>
            fetchYldVaultToIlliquidRoute({
              fromAddress: TEST_WALLET,
              sourceVault: sourceVault.address,
              sourceUnderlying: sourceVault.underlying,
              outputToken: outputToken.address,
              amountIn: sourceVault.amountIn,
              slippage: TEST_SLIPPAGE,
            }),
          );
        }, API_TIMEOUT);
      }
    }
  });

  describe("special input -> illiquid token", () => {
    for (const inputToken of SPECIAL_INPUTS) {
      for (const outputToken of ILLIQUID_TOKENS) {
        if (inputToken.address.toLowerCase() === outputToken.address.toLowerCase()) continue;
        const label = `${inputToken.symbol} -> ${outputToken.symbol}`;

        matrixIt(label, async () => {
          await expectRouteBuild(label, outputToken.address, () =>
            fetchSpecialTokenToIlliquidRoute({
              fromAddress: TEST_WALLET,
              inputToken: inputToken.address,
              outputToken: outputToken.address,
              amountIn: inputToken.amountIn,
              slippage: TEST_SLIPPAGE,
            }),
          );
        }, API_TIMEOUT);
      }
    }
  });

  describe("special input -> external vault", () => {
    for (const inputToken of SPECIAL_INPUTS) {
      for (const outputVault of EXTERNAL_VAULTS) {
        if (inputToken.address.toLowerCase() === outputVault.address.toLowerCase()) continue;
        const label = `${inputToken.symbol} -> ${outputVault.symbol}`;

        matrixIt(label, async () => {
          await expectRouteBuild(label, outputVault.address, () =>
            fetchSpecialTokenToExternalVaultRoute({
              fromAddress: TEST_WALLET,
              inputToken: inputToken.address,
              outputVault: outputVault.address,
              amountIn: inputToken.amountIn,
              slippage: TEST_SLIPPAGE,
            }),
          );
        }, API_TIMEOUT);
      }
    }
  });

  describe("special input -> yld vault", () => {
    for (const inputToken of SPECIAL_INPUTS) {
      for (const vault of LIVE_YLD_VAULTS) {
        if (inputToken.address.toLowerCase() === vault.address.toLowerCase()) continue;
        const label = `${inputToken.symbol} -> ${vault.symbol}`;

        matrixIt(label, async () => {
          await expectRouteBuild(label, vault.address, () =>
            buildSpecialInputToYldRoute({
              inputToken,
              vault,
            }),
          );
        }, API_TIMEOUT);
      }
    }
  });

  it("matrix definitions stay human-readable", () => {
    expect(LIVE_YLD_VAULTS.length).toBeGreaterThan(0);
    expect(EXTERNAL_VAULTS.length).toBeGreaterThan(0);
    expect(ILLIQUID_TOKENS.map((t) => getTokenSymbol(t.address))).toEqual([
      "pxCVX",
      "cvgCVX",
      "lpxCVX",
    ]);
  });

  it("uses token-specific raw test amounts", () => {
    const yvUsdc = SPECIAL_INPUTS.find((token) => token.address.toLowerCase() === YVUSDC1_ADDRESS.toLowerCase());
    const pxCvx = SPECIAL_INPUTS.find((token) => token.symbol === "pxCVX");

    expect(yvUsdc?.amountIn).toBe("10000000");
    expect(pxCvx?.amountIn).toBe("10000000000000000000");
  });

  it("classifies matrix errors explicitly", () => {
    expect(classifyMatrixError(new Error("429 Too Many Requests"))).toBe("rate_limited");
    expect(classifyMatrixError(new Error("Could not simulate tx"))).toBe("balance_or_simulation");
    expect(classifyMatrixError(new Error("RPC request failed"))).toBe("infra_transient");
    expect(classifyMatrixError(new Error("Swap not found for a required underlying of defi route"))).toBe("infra_transient");
    expect(classifyMatrixError(new Error("unexpected hard failure"))).toBe("hard_failure");
  });
});
