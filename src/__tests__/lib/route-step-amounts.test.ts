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

vi.mock("@/lib/zapper", () => ({
  extractInnerSwapData: vi.fn(() => "0xinner"),
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
  fetchAnyToCvgCvxRoute,
  fetchAnyToPxCvxRoute,
  fetchAnyToLpxCvxRoute,
  fetchComposableZapInRoute,
  fetchLpxCvxZapInRoute,
  fetchLegacyMorphoWrapRoute,
  fetchLegacyMorphoZapInRoute,
  fetchSpecialTokenToExternalVaultRoute,
  fetchSpecialTokenToIlliquidRoute,
  fetchVaultToVaultRoute,
  fetchYldVaultToIlliquidRoute,
  ENSO_ROUTER_V2,
  ENSO_SHORTCUTS,
  ETH_ADDRESS,
  LEGACY_MORPHO_ADDRESS,
  MORPHO_BUNDLER3_ADDRESS,
  MORPHO_GENERAL_ADAPTER1_ADDRESS,
  MORPHO_TOKEN_ADDRESS,
} from "@/lib/enso";
import { cryptoswap, findPegPoint, getCurveGetDy, getStableSwapParams } from "@/lib/curve";
import { LLAMA_AIRFORCE, PIREX, TANGENT, TOKENS, VAULT_ADDRESSES } from "@/config/vaults";
import { USDC_ADDRESS, YVUSDC1_ADDRESS } from "@/config/addresses";
import type { EnsoBundleAction } from "@/types/enso";

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

type TestBundleAction = EnsoBundleAction & {
  args: Record<string, unknown>;
};

const ONE_ETHER = 10n ** 18n;

function makeRpcResponse(result: string): Response {
  return {
    ok: true,
    json: async () => ({ result }),
  } as unknown as Response;
}

function lastBundleActions(): TestBundleAction[] {
  const calls = mockGetBundleData.mock.calls;
  const lastCall = calls[calls.length - 1];
  expect(lastCall, "expected getBundleData to be called").toBeDefined();
  return lastCall[1] as TestBundleAction[];
}

function isOutputRef(value: unknown): value is { useOutputOfCallAt: number } {
  return typeof value === "object" && value !== null && "useOutputOfCallAt" in value;
}

function fixedErc20Approvals(actions: TestBundleAction[], token: string): TestBundleAction[] {
  return actions.filter((action) =>
    action.protocol === "erc20" &&
    action.action === "approve" &&
    String(action.args.token).toLowerCase() === token.toLowerCase() &&
    typeof action.args.amount === "string"
  );
}

function rawApproveCalls(actions: TestBundleAction[], token: string): TestBundleAction[] {
  return actions.filter((action) =>
    action.protocol === "enso" &&
    action.action === "call" &&
    String(action.args.address).toLowerCase() === token.toLowerCase() &&
    action.args.method === "approve"
  );
}

function rawApproveSpender(action: TestBundleAction): string {
  return String((action.args.args as unknown[])[0]);
}

function rawApproveAmount(action: TestBundleAction): unknown {
  return (action.args.args as unknown[])[1];
}

function callActions(actions: TestBundleAction[], address: string, method: string): TestBundleAction[] {
  return actions.filter((action) =>
    action.protocol === "enso" &&
    action.action === "call" &&
    String(action.args.address).toLowerCase() === address.toLowerCase() &&
    action.args.method === method
  );
}

function balanceIndex(actions: TestBundleAction[], token: string): number {
  return actions.findIndex((action) =>
    action.protocol === "enso" &&
    action.action === "balance" &&
    String(action.args.token).toLowerCase() === token.toLowerCase()
  );
}

function mockPxCvxHybridSplit(): void {
  vi.mocked(cryptoswap.getDy).mockImplementation((_params: unknown, i: number, j: number, dx: bigint) => {
    if (i === 0 && j === 1) return dx > ONE_ETHER ? (dx * 9n) / 10n : (dx * 11n) / 10n;
    if (i === 1 && j === 0) return dx - (dx / 10n);
    return dx;
  });
  vi.mocked(cryptoswap.findPegPoint).mockReturnValue(ONE_ETHER);
}

function mockCvgCvxHybridSplit(): void {
  vi.mocked(getStableSwapParams).mockResolvedValue({
    balances: [0n, 0n],
    A: 0n,
    Ann: 0n,
    fee: 0n,
    offpegFeeMultiplier: 0n,
  });
  vi.mocked(findPegPoint).mockReturnValue(ONE_ETHER);
  vi.mocked(getCurveGetDy).mockImplementation(async (_pool: string, i: number, j: number, amount: string) => {
    const rawAmount = BigInt(amount);
    if (i === 0 && j === 1) return rawAmount + (rawAmount / 10n);
    return rawAmount;
  });
}

describe("route step amounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(cryptoswap.getDy).mockImplementation((_params: unknown, i: number, j: number, dx: bigint) => {
      if (i === 0 && j === 1) return dx + (dx / 10n);
      if (i === 1 && j === 0) return dx - (dx / 10n);
      return dx;
    });
    vi.mocked(cryptoswap.findPegPoint).mockReturnValue(0n);
    vi.mocked(findPegPoint).mockReturnValue(0n);
    vi.mocked(getStableSwapParams).mockResolvedValue({
      balances: [0n, 0n],
      A: 0n,
      Ann: 0n,
      fee: 0n,
      offpegFeeMultiplier: 0n,
    });
    vi.mocked(getCurveGetDy).mockImplementation(async (_pool: string, i: number, j: number, amount: string) => {
      const rawAmount = BigInt(amount);
      if (i === 0 && j === 1) return rawAmount + (rawAmount / 10n);
      return rawAmount;
    });

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

  it("wraps legacy MORPHO before routing through current MORPHO", async () => {
    mockGetRouteData.mockResolvedValueOnce({
      amountOut: "1110269870387989",
      gas: "368151",
      priceImpact: 33,
      tx: { to: "0xroute", data: "0xrouteData", value: "0" },
      route: [],
    });

    const result = await fetchLegacyMorphoWrapRoute({
      fromAddress: TEST_WALLET,
      outputToken: ETH_ADDRESS,
      amountIn: "1162575544199150998",
      slippage: "100",
    });

    expect(mockGetRouteData).toHaveBeenCalledWith(expect.objectContaining({
      fromAddress: TEST_WALLET,
      tokenIn: [MORPHO_TOKEN_ADDRESS],
      tokenOut: [ETH_ADDRESS],
      amountIn: ["1162575544199150998"],
    }));

    expect(mockGetBundleData).not.toHaveBeenCalled();
    expect(result.tx.to).toBe(MORPHO_BUNDLER3_ADDRESS);
    expect(result.tx.data).toBe("0x");
    expect(result.legacyMorphoPermit).toMatchObject({
      token: LEGACY_MORPHO_ADDRESS,
      spender: MORPHO_GENERAL_ADAPTER1_ADDRESS,
      amount: "1162575544199150998",
    });
    expect(result.legacyMorphoPermit?.postPermitCalls).toHaveLength(3);
    expect(result.legacyMorphoPermit?.postPermitCalls[0].to).toBe(MORPHO_GENERAL_ADAPTER1_ADDRESS);
    expect(result.legacyMorphoPermit?.postPermitCalls[1].to).toBe(MORPHO_GENERAL_ADAPTER1_ADDRESS);
    expect(result.legacyMorphoPermit?.postPermitCalls[2].to).toBe(ENSO_ROUTER_V2);
    expect(result.amountsOut[ETH_ADDRESS.toLowerCase()]).toBe("1110269870387989");
    expect(result.priceImpact).toBe(33);
    expect(result.gas).toBe("528151");
    expect(result.routeInfo?.steps.map((step) => step.action)).toEqual(["Wrap", "Swap", "Receive"]);
  });

  it("wraps legacy MORPHO directly when output is current MORPHO", async () => {
    const result = await fetchLegacyMorphoWrapRoute({
      fromAddress: TEST_WALLET,
      outputToken: MORPHO_TOKEN_ADDRESS,
      amountIn: "1000000000000000000",
      slippage: "100",
    });

    expect(mockGetRouteData).not.toHaveBeenCalled();
    expect(mockGetBundleData).not.toHaveBeenCalled();
    expect(result.tx.to).toBe(MORPHO_BUNDLER3_ADDRESS);
    expect(result.legacyMorphoPermit).toMatchObject({
      token: LEGACY_MORPHO_ADDRESS,
      spender: MORPHO_GENERAL_ADAPTER1_ADDRESS,
      amount: "1000000000000000000",
    });
    expect(result.legacyMorphoPermit?.postPermitCalls).toHaveLength(2);
    expect(result.legacyMorphoPermit?.postPermitCalls[0].to).toBe(MORPHO_GENERAL_ADAPTER1_ADDRESS);
    expect(result.legacyMorphoPermit?.postPermitCalls[1].to).toBe(MORPHO_GENERAL_ADAPTER1_ADDRESS);
    expect(result.amountsOut[MORPHO_TOKEN_ADDRESS.toLowerCase()]).toBe("1000000000000000000");
    expect(result.gas).toBe("150000");
    expect(result.routeInfo?.steps.map((step) => step.action)).toEqual(["Wrap", "Receive"]);
  });

  it("wraps legacy MORPHO before depositing into a yld vault", async () => {
    mockGetRouteData.mockResolvedValueOnce({
      amountOut: "27538222472939391973",
      gas: "411888",
      priceImpact: 0,
      tx: { to: "0xroute", data: "0xrouteData", value: "0" },
      route: [],
    });
    mockGetBundleData.mockResolvedValueOnce({
      ...BUNDLE_RESPONSE,
      gas: "0",
      amountsOut: {},
    });
    globalThis.fetch = vi.fn(async () =>
      makeRpcResponse(`0x${BigInt("25000000000000000000").toString(16)}`)
    ) as unknown as typeof fetch;

    const result = await fetchLegacyMorphoZapInRoute({
      fromAddress: TEST_WALLET,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV,
      amountIn: "1162575544199150998",
      slippage: "100",
      underlyingToken: TOKENS.CVXCRV,
    });

    expect(mockGetRouteData).toHaveBeenCalledWith(expect.objectContaining({
      fromAddress: TEST_WALLET,
      tokenIn: [MORPHO_TOKEN_ADDRESS],
      tokenOut: [TOKENS.CVXCRV],
      amountIn: ["1162575544199150998"],
      receiver: ENSO_SHORTCUTS,
    }));

    const actions = lastBundleActions();
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: MORPHO_TOKEN_ADDRESS,
        tokenOut: TOKENS.CVXCRV,
        amountIn: "1162575544199150998",
        slippage: "100",
      },
    });
    expect(actions[1]).toMatchObject({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: TOKENS.CVXCRV,
        tokenOut: VAULT_ADDRESSES.YCVXCRV,
        amountIn: { useOutputOfCallAt: 0 },
        primaryAddress: VAULT_ADDRESSES.YCVXCRV,
      },
    });
    expect(result.tx.to).toBe(MORPHO_BUNDLER3_ADDRESS);
    expect(result.tx.data).toBe("0x");
    expect(result.legacyMorphoPermit).toMatchObject({
      token: LEGACY_MORPHO_ADDRESS,
      spender: MORPHO_GENERAL_ADAPTER1_ADDRESS,
      amount: "1162575544199150998",
    });
    expect(result.legacyMorphoPermit?.postPermitCalls).toHaveLength(3);
    expect(result.legacyMorphoPermit?.postPermitCalls[0].to).toBe(MORPHO_GENERAL_ADAPTER1_ADDRESS);
    expect(result.legacyMorphoPermit?.postPermitCalls[1].to).toBe(MORPHO_GENERAL_ADAPTER1_ADDRESS);
    expect(result.legacyMorphoPermit?.postPermitCalls[2].to).toBe(ENSO_ROUTER_V2);
    expect(result.amountsOut[TOKENS.CVXCRV.toLowerCase()]).toBe("27538222472939391973");
    expect(result.amountsOut[VAULT_ADDRESSES.YCVXCRV.toLowerCase()]).toBe("25000000000000000000");
    expect(result.gas).toBe("571888");
    expect(result.routeInfo?.steps.map((step) => step.action)).toEqual(["Wrap", "Swap", "Deposit", "Receive"]);
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

  it("keeps yld vault -> pxCVX hybrid split without classifying intermediate CVX as wallet input", async () => {
    mockPxCvxHybridSplit();

    await fetchYldVaultToIlliquidRoute({
      fromAddress: TEST_WALLET,
      sourceVault: VAULT_ADDRESSES.YCVXCRV,
      sourceUnderlying: TOKENS.CVXCRV,
      outputToken: TOKENS.PXCVX,
      amountIn: "1000000000000000000",
      slippage: "100",
    });

    const actions = lastBundleActions();
    expect(fixedErc20Approvals(actions, TOKENS.CVX)).toEqual([]);

    const cvxApprovals = rawApproveCalls(actions, TOKENS.CVX);
    expect(cvxApprovals.map(rawApproveSpender)).toEqual(expect.arrayContaining([
      PIREX.LPXCVX,
      PIREX.PIREX_CVX,
    ]));
    expect(cvxApprovals.map(rawApproveAmount).every((amount) => typeof amount === "string" && BigInt(amount) > 0n)).toBe(true);
    expect(callActions(actions, PIREX.LPXCVX, "swap")).toHaveLength(1);
    expect(callActions(actions, PIREX.LPXCVX, "unwrap")).toHaveLength(0);
    expect(callActions(actions, PIREX.LPXCVX_CVX_POOL, "exchange")).toHaveLength(0);

    const pxCvxBalanceIdx = balanceIndex(actions, TOKENS.PXCVX);
    expect(pxCvxBalanceIdx).toBeGreaterThan(-1);
    const finalTransfer = actions[actions.length - 1];
    expect(finalTransfer.protocol).toBe("erc20");
    expect(finalTransfer.action).toBe("transfer");
    expect(finalTransfer.args.token).toBe(TOKENS.PXCVX);
    expect(finalTransfer.args.amount).toEqual({ useOutputOfCallAt: pxCvxBalanceIdx });
  });

  it("uses lpxCVX.swap for any token -> pxCVX hybrid routes", async () => {
    mockPxCvxHybridSplit();

    mockGetBundleData.mockResolvedValueOnce({
      ...BUNDLE_RESPONSE,
      amountsOut: {
        [PIREX.PXCVX.toLowerCase()]: "1100000000000000000",
      },
    });

    const result = await fetchAnyToPxCvxRoute({
      fromAddress: TEST_WALLET,
      inputToken: USDC_ADDRESS,
      amountIn: "10000000",
      slippage: "100",
    });

    const actions = lastBundleActions();
    expect(fixedErc20Approvals(actions, TOKENS.CVX)).toEqual([]);

    const cvxApprovals = rawApproveCalls(actions, TOKENS.CVX);
    expect(cvxApprovals.map(rawApproveSpender)).toEqual(expect.arrayContaining([
      PIREX.LPXCVX,
      PIREX.PIREX_CVX,
    ]));
    expect(callActions(actions, PIREX.LPXCVX, "swap")).toHaveLength(1);
    expect(callActions(actions, PIREX.LPXCVX, "unwrap")).toHaveLength(0);
    expect(callActions(actions, PIREX.LPXCVX_CVX_POOL, "exchange")).toHaveLength(0);
    expect(result.amountsOut[PIREX.PXCVX.toLowerCase()]).toBe("5050000000000000000");

    const pxCvxBalanceIdx = balanceIndex(actions, TOKENS.PXCVX);
    expect(pxCvxBalanceIdx).toBeGreaterThan(-1);
    const finalTransfer = actions[actions.length - 1];
    expect(finalTransfer.protocol).toBe("erc20");
    expect(finalTransfer.action).toBe("transfer");
    expect(finalTransfer.args.token).toBe(PIREX.PXCVX);
    expect(finalTransfer.args.amount).toEqual({ useOutputOfCallAt: pxCvxBalanceIdx });
  });

  it("keeps any token -> cvgCVX hybrid split without fixed intermediate erc20 approvals", async () => {
    mockCvgCvxHybridSplit();

    await fetchAnyToCvgCvxRoute({
      fromAddress: TEST_WALLET,
      inputToken: USDC_ADDRESS,
      amountIn: "10000000",
      slippage: "100",
    });

    const actions = lastBundleActions();
    expect(fixedErc20Approvals(actions, TOKENS.CVX)).toEqual([]);
    expect(fixedErc20Approvals(actions, TOKENS.CVX1)).toEqual([]);

    expect(rawApproveCalls(actions, TOKENS.CVX).map(rawApproveSpender)).toEqual(expect.arrayContaining([
      TOKENS.CVX1,
      TANGENT.CVGCVX_CONTRACT,
    ]));
    expect(rawApproveCalls(actions, TOKENS.CVX1).map(rawApproveSpender)).toContain(TANGENT.CVX1_CVGCVX_POOL);

    const cvgCvxBalanceIdx = balanceIndex(actions, TOKENS.CVGCVX);
    expect(cvgCvxBalanceIdx).toBeGreaterThan(-1);
    const finalTransfer = actions[actions.length - 1];
    expect(finalTransfer.protocol).toBe("erc20");
    expect(finalTransfer.action).toBe("transfer");
    expect(finalTransfer.args.token).toBe(TOKENS.CVGCVX);
    expect(finalTransfer.args.amount).toEqual({ useOutputOfCallAt: cvgCvxBalanceIdx });
  });

  it("wraps produced pxCVX through a balance ref for any token -> lpxCVX hybrid routes", async () => {
    mockPxCvxHybridSplit();

    await fetchAnyToLpxCvxRoute({
      fromAddress: TEST_WALLET,
      inputToken: USDC_ADDRESS,
      amountIn: "10000000",
      slippage: "100",
    });

    const actions = lastBundleActions();
    expect(fixedErc20Approvals(actions, TOKENS.CVX)).toEqual([]);

    const pxCvxApprove = actions.find((action) =>
      action.protocol === "erc20" &&
      action.action === "approve" &&
      String(action.args.token).toLowerCase() === PIREX.PXCVX.toLowerCase() &&
      action.args.spender === PIREX.LPXCVX
    );
    expect(pxCvxApprove).toBeDefined();
    expect(isOutputRef(pxCvxApprove?.args.amount)).toBe(true);
    const pxCvxBalanceIdx = (pxCvxApprove!.args.amount as { useOutputOfCallAt: number }).useOutputOfCallAt;
    expect(actions[pxCvxBalanceIdx]).toMatchObject({
      protocol: "enso",
      action: "balance",
      args: { token: PIREX.PXCVX },
    });

    const lpxCvxBalanceIdx = balanceIndex(actions, PIREX.LPXCVX);
    expect(lpxCvxBalanceIdx).toBeGreaterThan(-1);
    const finalTransfer = actions[actions.length - 1];
    expect(finalTransfer.protocol).toBe("erc20");
    expect(finalTransfer.action).toBe("transfer");
    expect(finalTransfer.args.token).toBe(PIREX.LPXCVX);
    expect(finalTransfer.args.amount).toEqual({ useOutputOfCallAt: lpxCvxBalanceIdx });
  });
});
