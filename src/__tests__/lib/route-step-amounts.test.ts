// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetRouteData,
  mockGetBundleData,
} = vi.hoisted(() => ({
  mockGetRouteData: vi.fn(),
  mockGetBundleData: vi.fn(),
}));

vi.mock("@ensofinance/sdk", () => ({
  EnsoClient: class MockEnsoClient {
    getRouteData = mockGetRouteData;
    getBundleData = mockGetBundleData;
  },
}));

vi.mock("@/lib/curve", () => ({
  getCurveGetDy: vi.fn(),
  getCurveGetDyFactory: vi.fn(),
  getEthToCvxEstimate: vi.fn(),
  getStableSwapParams: vi.fn(),
  estimateCryptoSwapOffchain: vi.fn(),
  previewRedeem: vi.fn(async (vaultAddress: string) => {
    const lower = vaultAddress.toLowerCase();
    if (lower === "0xbe53a109b494e5c9f97b9cd39fe969be68bf6204") {
      return "10000000";
    }
    if (lower === "0x95f19b19aff698169a1a0bbc28a2e47b14cb9a86") {
      return "4000000000000000000";
    }
    if (lower === "0x8659fc767cad6005de79af65dafe4249c57927af") {
      return "5000000000000000000";
    }
    return "1000000000000000000";
  }),
  batchRedeemAndEstimateSwap: vi.fn(),
  findPegPoint: vi.fn(() => 0n),
  calculateMinDy: vi.fn((amount: bigint) => amount.toString()),
  validateSlippage: vi.fn((slippage?: string) => Number(slippage ?? "100")),
  cryptoswap: {
    getDy: vi.fn((_params: unknown, i: number, j: number, dx: bigint) => {
      if (i === 0 && j === 1) return dx + (dx / 10n);
      if (i === 1 && j === 0) return dx - (dx / 10n);
      return dx;
    }),
    findPegPoint: vi.fn(() => 0n),
  },
  getCryptoSwapParams: vi.fn(async () => ({})),
}));

import {
  fetchComposableZapInRoute,
  fetchLpxCvxZapInRoute,
  fetchSpecialTokenToExternalVaultRoute,
  fetchSpecialTokenToIlliquidRoute,
  fetchVaultToVaultRoute,
  fetchYldVaultToIlliquidRoute,
} from "@/lib/enso";
import { LLAMA_AIRFORCE, TOKENS, VAULT_ADDRESSES } from "@/config/vaults";
import { YVUSDC1_ADDRESS } from "@/config/addresses";

const TEST_WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const BUNDLE_RESPONSE = {
  tx: {
    to: "0xrouter",
    data: "0xdeadbeef",
    value: 0,
    from: TEST_WALLET,
  },
  gas: 123456,
  amountsOut: {},
  priceImpact: 0,
};

function makeRpcResponse(result: string): Response {
  return {
    ok: true,
    json: async () => ({ result }),
  } as unknown as Response;
}

describe("route step amounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetBundleData.mockResolvedValue(BUNDLE_RESPONSE);
    mockGetRouteData.mockImplementation(async ({ tokenIn, tokenOut }: { tokenIn: string[]; tokenOut: string[] }) => {
      const input = tokenIn[0]?.toLowerCase();
      const output = tokenOut[0]?.toLowerCase();

      if (input === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" && output === TOKENS.CVX.toLowerCase()) {
        return { amountOut: "5000000000000000000", tx: { to: "0xroute", data: "0x1", value: "0" }, route: [] };
      }
      if (input === TOKENS.CVXCRV.toLowerCase() && output === TOKENS.CVX.toLowerCase()) {
        return { amountOut: "2000000000000000000", tx: { to: "0xroute", data: "0x2", value: "0" }, route: [] };
      }
      return { amountOut: "1000000000000000000", tx: { to: "0xroute", data: "0x3", value: "0" }, route: [] };
    });

    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (!Array.isArray(body) && body.method === "eth_call") {
        return makeRpcResponse(`0x${BigInt("5250000000000000000").toString(16)}`);
      }
      return makeRpcResponse("0x0");
    }) as unknown as typeof fetch;
  });

  it("shows external -> illiquid intermediate amounts", async () => {
    const result = await fetchSpecialTokenToIlliquidRoute({
      fromAddress: TEST_WALLET,
      inputToken: YVUSDC1_ADDRESS,
      outputToken: TOKENS.PXCVX,
      amountIn: "10000000",
      slippage: "100",
    });

    expect(result.routeInfo?.steps.map((step) => ({
      token: step.tokenSymbol,
      amount: step.amount,
    }))).toEqual([
      { token: "yvUSDC-1", amount: "10.0000" },
      { token: "USDC", amount: "10.0000" },
      { token: "CVX", amount: "5.0000" },
      { token: "pxCVX", amount: "5.4450" },
    ]);
  });

  it("shows external -> yld vault intermediate amounts", async () => {
    const result = await fetchComposableZapInRoute({
      fromAddress: TEST_WALLET,
      inputToken: YVUSDC1_ADDRESS,
      vaultAddress: VAULT_ADDRESSES.YSPXCVX,
      amountIn: "10000000",
      slippage: "100",
    });

    expect(result.routeInfo?.steps.map((step) => ({
      token: step.tokenSymbol,
      amount: step.amount,
    }))).toEqual([
      { token: "yvUSDC-1", amount: "10.0000" },
      { token: "USDC", amount: "10.0000" },
      { token: "CVX", amount: "5.0000" },
      { token: "pxCVX", amount: "5.4450" },
      { token: "yspxCVX", amount: "5.2500" },
    ]);
  });

  it("shows external -> external vault intermediate amounts", async () => {
    const result = await fetchSpecialTokenToExternalVaultRoute({
      fromAddress: TEST_WALLET,
      inputToken: YVUSDC1_ADDRESS,
      outputVault: LLAMA_AIRFORCE.UCVX,
      amountIn: "10000000",
      slippage: "100",
    });

    expect(result.routeInfo?.steps.map((step) => ({
      token: step.tokenSymbol,
      amount: step.amount,
    }))).toEqual([
      { token: "yvUSDC-1", amount: "10.0000" },
      { token: "USDC", amount: "10.0000" },
      { token: "CVX", amount: "5.0000" },
      { token: "pxCVX", amount: "5.4450" },
      { token: "uCVX", amount: "5.2500" },
    ]);
  });

  it("shows yld vault -> illiquid intermediate amounts", async () => {
    const result = await fetchYldVaultToIlliquidRoute({
      fromAddress: TEST_WALLET,
      sourceVault: VAULT_ADDRESSES.YCVXCRV,
      sourceUnderlying: TOKENS.CVXCRV,
      outputToken: TOKENS.PXCVX,
      amountIn: "1000000000000000000",
      slippage: "100",
    });

    expect(result.routeInfo?.steps.map((step) => ({
      token: step.tokenSymbol,
      amount: step.amount,
    }))).toEqual([
      { token: "ycvxCRV", amount: "1.0000" },
      { token: "cvxCRV", amount: "4.0000" },
      { token: "CVX", amount: "2.0000" },
      { token: "pxCVX", amount: "2.1780" },
    ]);
  });

  it("shows same-underlying vault-to-vault intermediate amounts", async () => {
    const result = await fetchVaultToVaultRoute({
      fromAddress: TEST_WALLET,
      sourceVault: VAULT_ADDRESSES.YSCVXCRV,
      targetVault: VAULT_ADDRESSES.YCVXCRV,
      amountIn: "1000000000000000000",
      slippage: "100",
    });

    expect((result as { routeInfo?: { steps: Array<{ tokenSymbol: string; amount?: string }> } }).routeInfo?.steps.map((step) => ({
      token: step.tokenSymbol,
      amount: step.amount,
    }))).toEqual([
      { token: "yscvxCRV", amount: "1.0000" },
      { token: "cvxCRV", amount: "1.0000" },
      { token: "ycvxCRV", amount: undefined },
    ]);
  });

  it("populates amountsOut for lpxCVX -> cvgCVX vault zaps", async () => {
    const result = await fetchLpxCvxZapInRoute({
      fromAddress: TEST_WALLET,
      vaultAddress: VAULT_ADDRESSES.YCVGCVX,
      amountIn: "1000000000000000000",
      slippage: "100",
    });

    expect(result.amountsOut[TOKENS.CVGCVX.toLowerCase()]).toBeDefined();
    expect(result.amountsOut[VAULT_ADDRESSES.YCVGCVX.toLowerCase()]).toBeDefined();
    expect(BigInt(result.amountsOut[TOKENS.CVGCVX.toLowerCase()])).toBeGreaterThan(0n);
    expect(BigInt(result.amountsOut[VAULT_ADDRESSES.YCVGCVX.toLowerCase()])).toBeGreaterThan(0n);
  });
});
