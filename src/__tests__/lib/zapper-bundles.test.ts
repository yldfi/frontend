import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mock setup (vi.hoisted pattern)
// ============================================================================

const { mockFetchRoute, mockFetchBundle, mockGetCvgCvxSwapRate, mockGetLpxCvxToCvxSwapRate, mockGetCurveGetDyFactory } = vi.hoisted(() => ({
  mockFetchRoute: vi.fn(),
  mockFetchBundle: vi.fn(),
  mockGetCvgCvxSwapRate: vi.fn(),
  mockGetLpxCvxToCvxSwapRate: vi.fn(),
  mockGetCurveGetDyFactory: vi.fn(),
}));

// Mock @/lib/enso — the functions buildVaultInputSwapBundle/buildExoticOutputSwapData import
vi.mock("@/lib/enso", () => ({
  fetchRoute: mockFetchRoute,
  fetchBundle: mockFetchBundle,
  getCvgCvxSwapRate: mockGetCvgCvxSwapRate,
  getLpxCvxToCvxSwapRate: mockGetLpxCvxToCvxSwapRate,
  ENSO_SHORTCUTS: "0x4Fe93ebC4Ce6Ae4f81601cC7Ce7139023919E003",
  ENSO_ROUTER_V2: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
}));

// Mock viem's decodeFunctionData — used by extractInnerSwapData
vi.mock("viem", () => ({
  decodeFunctionData: vi.fn(() => ({
    functionName: "routeSingle",
    args: [
      { tokenType: 0, data: "0x" },
      "0xinnerswapdata",
    ],
  })),
}));

// Mock @/lib/curve — calculateMinDy
vi.mock("@/lib/curve", () => ({
  calculateMinDy: vi.fn((amount: bigint, _bps: number) => amount.toString()),
  getCurveGetDyFactory: mockGetCurveGetDyFactory,
}));

import { buildVaultInputSwapBundle, buildExoticOutputSwapData, ZAPPER_ADDRESS } from "@/lib/zapper";
import { TOKENS, TANGENT } from "@/config/vaults";

// ============================================================================
// Shared fixtures
// ============================================================================

const MOCK_ROUTE_RESPONSE = {
  tx: { to: "0xrouter", data: "0xmockroutedata", value: "0" },
  gas: "200000",
  amountOut: "1000000000000000000",
  route: [],
};

const MOCK_BUNDLE_RESPONSE = {
  tx: { to: "0xrouter", data: "0xmockbundledata", value: "0", from: "0xuser" },
  gas: "500000",
  amountsOut: { "0xtarget": "900000000000000000" },
};

const ENSO_SHORTCUTS = "0x4Fe93ebC4Ce6Ae4f81601cC7Ce7139023919E003";

// ============================================================================
// buildExoticOutputSwapData
// ============================================================================

describe("buildExoticOutputSwapData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRoute.mockResolvedValue(MOCK_ROUTE_RESPONSE);
    mockFetchBundle.mockResolvedValue(MOCK_BUNDLE_RESPONSE);
    mockGetCvgCvxSwapRate.mockResolvedValue(950000000000000000n);
    mockGetCurveGetDyFactory.mockResolvedValue(930000000000000000n);
  });

  it("cvgCvx path: routes crvUSD→CVX then mints CVX1 and Curve exchanges to cvgCVX", async () => {
    const result = await buildExoticOutputSwapData({
      amountIn: "1000000000000000000",
      type: "cvgCvx",
      slippage: 100,
    });

    // Should fetch route crvUSD→CVX
    expect(mockFetchRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAddress: ZAPPER_ADDRESS,
        tokenOut: TOKENS.CVX,
        amountIn: "1000000000000000000",
      }),
    );

    // Should call fetchBundle with 7 actions (routeMulti + balanceOf + approve + mint + approve + exchange + transfer)
    expect(mockFetchBundle).toHaveBeenCalledTimes(1);
    const bundleCall = mockFetchBundle.mock.calls[0][0];
    expect(bundleCall.actions).toHaveLength(7);

    // Action 5 should be Curve exchange CVX1→cvgCVX
    expect(bundleCall.actions[5].args.method).toBe("exchange");
    expect(bundleCall.actions[5].args.args[3]).toBe("950000000000000000");
    // Action 6 should transfer cvgCVX to ZAPPER_ADDRESS
    expect(bundleCall.actions[6].action).toBe("transfer");
    expect(bundleCall.skipQuote).toBe(true);

    expect(result.swapData).toBe("0xmockbundledata");
    expect(result.expectedOut).toBe("950000000000000000");
  });

  it("pxCvx path: routes crvUSD→CVX then Curve swaps to lpxCVX and unwraps to pxCVX", async () => {
    const result = await buildExoticOutputSwapData({
      amountIn: "1000000000000000000",
      type: "pxCvx",
      slippage: 100,
    });

    const bundleCall = mockFetchBundle.mock.calls[0][0];
    // 7 actions: routeMulti + balanceOf + approve + exchange + approve + unwrap + transfer
    expect(bundleCall.actions).toHaveLength(7);
    // Action 3 should be Curve exchange CVX→lpxCVX
    expect(bundleCall.actions[3].args.method).toBe("exchange");
    expect(bundleCall.actions[3].args.args[3]).toBe("930000000000000000");
    // Action 5 should unwrap lpxCVX→pxCVX
    expect(bundleCall.actions[5].args.method).toBe("unwrap");
    expect(result.expectedOut).toBe("930000000000000000");
  });

  it("action structure: addresses lowercased, balanceOf ref at index 1", async () => {
    await buildExoticOutputSwapData({
      amountIn: "1000000000000000000",
      type: "cvgCvx",
      slippage: 100,
    });

    const actions = mockFetchBundle.mock.calls[0][0].actions;

    // Action 0: routeMulti
    expect(actions[0].args.address).toBe(
      "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf".toLowerCase(),
    );
    expect(actions[0].args.method).toBe("routeMulti");

    // Action 1: balanceOf CVX in ENSO_SHORTCUTS
    expect(actions[1].args.address).toBe(TOKENS.CVX.toLowerCase());
    expect(actions[1].args.method).toBe("balanceOf");
    expect(actions[1].args.args).toContain(ENSO_SHORTCUTS);

    // Action 2: approve CVX → CVX1 wrapper
    expect(actions[2].args.method).toBe("approve");
    expect(actions[2].args.args[1]).toEqual({ useOutputOfCallAt: 1 });
  });

  it("receiver is set to ZAPPER_ADDRESS for all bundle calls", async () => {
    await buildExoticOutputSwapData({
      amountIn: "1000000000000000000",
      type: "cvgCvx",
      slippage: 100,
    });

    const bundleCall = mockFetchBundle.mock.calls[0][0];
    expect(bundleCall.receiver).toBe(ZAPPER_ADDRESS);
    expect(bundleCall.fromAddress).toBe(ZAPPER_ADDRESS);
  });

  it("SECURITY: no action contains transferFrom targeting ENSO_SHORTCUTS", async () => {
    // Test both paths
    for (const type of ["cvgCvx", "pxCvx"] as const) {
      vi.clearAllMocks();
      mockFetchRoute.mockResolvedValue(MOCK_ROUTE_RESPONSE);
      mockFetchBundle.mockResolvedValue(MOCK_BUNDLE_RESPONSE);
      mockGetCvgCvxSwapRate.mockResolvedValue(950000000000000000n);
      mockGetCurveGetDyFactory.mockResolvedValue(930000000000000000n);

      await buildExoticOutputSwapData({ amountIn: "1000000000000000000", type, slippage: 100 });

      const actions = mockFetchBundle.mock.calls[0][0].actions;
      for (const action of actions) {
        if (action.args?.method === "transferFrom") {
          expect(action.args.args[1]).not.toBe(ENSO_SHORTCUTS);
        }
        if (action.protocol === "erc20" && action.action === "approve") {
          expect(action.args.spender).not.toBe(ENSO_SHORTCUTS);
        }
      }
    }
  });
});

// ============================================================================
// buildVaultInputSwapBundle
// ============================================================================

describe("buildVaultInputSwapBundle", () => {
  const TARGET_TOKEN = "0xTargetCollateral";

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRoute.mockResolvedValue(MOCK_ROUTE_RESPONSE);
    mockFetchBundle.mockResolvedValue(MOCK_BUNDLE_RESPONSE);
    mockGetLpxCvxToCvxSwapRate.mockResolvedValue(900000000000000000n);
  });

  it("pxCVX underlying: builds 6 actions (redeem + 5 swap steps), skipQuote=true", async () => {
    const result = await buildVaultInputSwapBundle({
      vaultAddress: "0xVault",
      underlying: TOKENS.PXCVX,
      targetToken: TARGET_TOKEN,
      amountIn: "1000000000000000000",
      estimatedUnderlying: "950000000000000000",
      isCvgCvx: false,
    });

    expect(mockGetLpxCvxToCvxSwapRate).toHaveBeenCalledWith("950000000000000000");
    expect(mockFetchRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAddress: ZAPPER_ADDRESS,
        tokenIn: TOKENS.CVX,
        tokenOut: TARGET_TOKEN,
      }),
    );

    const bundleCall = mockFetchBundle.mock.calls[0][0];
    // 1 redeem + 5 actions (approve pxCVX, wrap, approve lpxCVX, exchange, routeMulti)
    expect(bundleCall.actions).toHaveLength(6);
    expect(bundleCall.skipQuote).toBe(true);

    // Action 1: approve pxCVX → LPXCVX
    expect(bundleCall.actions[1].args.token || bundleCall.actions[1].args.spender).toBeTruthy();
    // Action 2: wrap
    expect(bundleCall.actions[2].args.method).toBe("wrap");
    // Action 4: exchange lpxCVX→CVX
    expect(bundleCall.actions[4].args.method).toBe("exchange");
    // Action 5: routeMulti
    expect(bundleCall.actions[5].args.method).toBe("routeMulti");

    expect(result).toEqual({
      swapData: "0xmockbundledata",
      expectedOut: MOCK_ROUTE_RESPONSE.amountOut,
    });
  });

  it("cvgCVX underlying: builds 6 actions (redeem + 5 swap steps), skipQuote=true", async () => {
    await buildVaultInputSwapBundle({
      vaultAddress: "0xVault",
      underlying: TOKENS.CVGCVX,
      targetToken: TARGET_TOKEN,
      amountIn: "1000000000000000000",
      estimatedUnderlying: "950000000000000000",
      isCvgCvx: true,
      estimatedCvx1: "940000000000000000",
    });

    const bundleCall = mockFetchBundle.mock.calls[0][0];
    // 1 redeem + 4 actions (approve cvgCVX, exchange, CVX1.withdraw, routeMulti)
    expect(bundleCall.actions).toHaveLength(5);
    expect(bundleCall.skipQuote).toBe(true);

    // Action 2: exchange cvgCVX→CVX1
    expect(bundleCall.actions[2].args.method).toBe("exchange");
    expect(bundleCall.actions[2].args.address).toBe(TANGENT.CVX1_CVGCVX_POOL.toLowerCase());

    // Action 3: CVX1.withdraw → CVX to ENSO_SHORTCUTS
    expect(bundleCall.actions[3].args.method).toBe("withdraw");
    expect(bundleCall.actions[3].args.address).toBe(TOKENS.CVX1.toLowerCase());

    // Action 4: routeMulti
    expect(bundleCall.actions[4].args.method).toBe("routeMulti");
  });

  it("standard underlying: 2 actions (redeem + route), no skipQuote", async () => {
    await buildVaultInputSwapBundle({
      vaultAddress: "0xVault",
      underlying: "0xStandardToken",
      targetToken: TARGET_TOKEN,
      amountIn: "1000000000000000000",
      estimatedUnderlying: "950000000000000000",
      isCvgCvx: false,
    });

    const bundleCall = mockFetchBundle.mock.calls[0][0];
    expect(bundleCall.actions).toHaveLength(2);
    expect(bundleCall.actions[1].action).toBe("route");
    expect(bundleCall.skipQuote).toBeUndefined();
  });

  it("pxCVX path throws when getLpxCvxToCvxSwapRate returns 0", async () => {
    mockGetLpxCvxToCvxSwapRate.mockResolvedValue(0n);

    await expect(
      buildVaultInputSwapBundle({
        vaultAddress: "0xVault",
        underlying: TOKENS.PXCVX,
        targetToken: TARGET_TOKEN,
        amountIn: "1000000000000000000",
        estimatedUnderlying: "950000000000000000",
        isCvgCvx: false,
      }),
    ).rejects.toThrow("Failed to estimate lpxCVX→CVX swap output");
  });

  it("SECURITY: no action in any path contains transferFrom targeting ENSO_SHORTCUTS", async () => {
    const paths = [
      { underlying: TOKENS.PXCVX, isCvgCvx: false },
      { underlying: TOKENS.CVGCVX, isCvgCvx: true, estimatedCvx1: "940000000000000000" },
      { underlying: "0xStandardToken", isCvgCvx: false },
    ];

    for (const pathConfig of paths) {
      vi.clearAllMocks();
      mockFetchRoute.mockResolvedValue(MOCK_ROUTE_RESPONSE);
      mockFetchBundle.mockResolvedValue(MOCK_BUNDLE_RESPONSE);
      mockGetLpxCvxToCvxSwapRate.mockResolvedValue(900000000000000000n);

      await buildVaultInputSwapBundle({
        vaultAddress: "0xVault",
        targetToken: TARGET_TOKEN,
        amountIn: "1000000000000000000",
        estimatedUnderlying: "950000000000000000",
        ...pathConfig,
      });

      const actions = mockFetchBundle.mock.calls[0][0].actions;
      for (const action of actions) {
        // No transferFrom with ENSO_SHORTCUTS as recipient
        if (action.args?.method === "transferFrom") {
          expect(action.args.args[1]).not.toBe(ENSO_SHORTCUTS);
        }
      }
    }
  });
});
