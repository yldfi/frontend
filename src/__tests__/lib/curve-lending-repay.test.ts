import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mock setup (vi.hoisted pattern)
// ============================================================================

const {
  mockFetchRoute,
  mockEnsoFetchBundle,
  mockGetLpxCvxToCvxSwapRate,
} = vi.hoisted(() => ({
  mockFetchRoute: vi.fn(),
  mockEnsoFetchBundle: vi.fn(),
  mockGetLpxCvxToCvxSwapRate: vi.fn(),
}));

// Mock @/lib/enso
vi.mock("@/lib/enso", () => ({
  fetchRoute: mockFetchRoute,
  fetchBundle: mockEnsoFetchBundle,
  getLpxCvxToCvxSwapRate: mockGetLpxCvxToCvxSwapRate,
  getCvgCvxReverseSwapRate: vi.fn(),
  ENSO_SHORTCUTS: "0x4Fe93ebC4Ce6Ae4f81601cC7Ce7139023919E003",
  ENSO_ROUTER_V2: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
}));

// Mock viem's decodeFunctionData — used by extractInnerSwapData in curve-lending.ts
vi.mock("viem", () => ({
  decodeFunctionData: vi.fn(() => ({
    functionName: "routeSingle",
    args: [{ tokenType: 0, data: "0x" }, "0xinnerswapdata"],
  })),
}));

// Mock @/lib/curve
vi.mock("@/lib/curve", () => ({
  calculateMinDy: vi.fn((amount: bigint, _bps: number) => amount.toString()),
}));

// Mock @/lib/curve/rpc — previewRedeem and getCurveGetDy
vi.mock("@/lib/curve/rpc", () => ({
  previewRedeem: vi.fn(() => Promise.resolve("950000000000000000")),
  getCurveGetDy: vi.fn(() => Promise.resolve(940000000000000000n)),
}));

// Mock @/lib/zapper — re-exports CRVUSD_ADDRESS and ZAPPER_ADDRESS
vi.mock("@/lib/zapper", () => ({
  CRVUSD_ADDRESS: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
  ZAPPER_ADDRESS: "0xED653FF2410A4686a0B69Fc4C0D1c0cccDFddb83",
}));

import { fetchRepayBundle, fetchRepayWithSwapBundle } from "@/lib/curve-lending";
import { TOKENS, VAULT_ADDRESSES, CURVE_CONTROLLERS, PIREX, CURVE_SAVINGS } from "@/config/vaults";

// ============================================================================
// Constants
// ============================================================================

const ENSO_SHORTCUTS = "0x4Fe93ebC4Ce6Ae4f81601cC7Ce7139023919E003";
const CRVUSD = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E";
const CONTROLLER = CURVE_CONTROLLERS[VAULT_ADDRESSES.YCVXCRV];
const USER = "0xUserAddress";
const MAX_UINT256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const MAX_INT256 = "57896044618658097711785492504343953926634992332820282019728792003956564819967";

const MOCK_ROUTE_RESPONSE = {
  tx: { to: "0xrouter", data: "0xmockroutedata", value: "0" },
  gas: "200000",
  amountOut: "1000000000000000000",
  route: [],
};

const MOCK_BUNDLE_RESPONSE = {
  tx: { to: "0xrouter", data: "0xmockbundledata", value: "0", from: "0xuser" },
  gas: "500000",
  amountsOut: {},
};

/** Helper: extract the actions array passed to fetchBundle (the first arg). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function capturedBundleParams(): any {
  expect(mockEnsoFetchBundle).toHaveBeenCalledTimes(1);
  return mockEnsoFetchBundle.mock.calls[0][0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function capturedActions(): any[] {
  return capturedBundleParams().actions;
}

// ============================================================================
// Test suite
// ============================================================================

describe("fetchRepayBundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRoute.mockResolvedValue(MOCK_ROUTE_RESPONSE);
    mockEnsoFetchBundle.mockResolvedValue(MOCK_BUNDLE_RESPONSE);
    mockGetLpxCvxToCvxSwapRate.mockResolvedValue(940000000000000000n);
  });

  it("builds a router bundle with Enso quote simulation skipped", async () => {
    await fetchRepayBundle({
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
      repayAmount: "1000000000000000000",
    });

    const bundleCall = capturedBundleParams();
    expect(bundleCall.routingStrategy).toBe("router");
    expect(bundleCall.skipQuote).toBe(true);
    expect(bundleCall.actions).toHaveLength(1);
    expect(bundleCall.actions[0].protocol).toBe("curve-lending");
    expect(bundleCall.actions[0].action).toBe("repay");
  });
});

describe("fetchRepayWithSwapBundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRoute.mockResolvedValue(MOCK_ROUTE_RESPONSE);
    mockEnsoFetchBundle.mockResolvedValue(MOCK_BUNDLE_RESPONSE);
    mockGetLpxCvxToCvxSwapRate.mockResolvedValue(940000000000000000n);
  });

  // --------------------------------------------------------------------------
  // pxCVX vault input path
  // --------------------------------------------------------------------------

  describe("pxCVX vault input (yspxCVX tokenIn)", () => {
    const BASE_PARAMS = {
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
      tokenIn: VAULT_ADDRESSES.YSPXCVX,
      amountIn: "1000000000000000000",
    };

    it("normal repay: produces 7 actions (redeem + approve + wrap + approve + exchange + route + curve-lending/repay)", async () => {
      await fetchRepayWithSwapBundle(BASE_PARAMS);

      const bundleCall = capturedBundleParams();
      expect(bundleCall.routingStrategy).toBe("router");
      expect(bundleCall.skipQuote).toBe(true);

      const actions = capturedActions();
      expect(actions).toHaveLength(7);

      // Action 0: erc4626/redeem
      expect(actions[0].protocol).toBe("erc4626");
      expect(actions[0].action).toBe("redeem");
      expect(actions[0].args.tokenOut).toBe(TOKENS.PXCVX);

      // Action 1: erc20/approve pxCVX → lpxCVX contract
      expect(actions[1].protocol).toBe("erc20");
      expect(actions[1].action).toBe("approve");
      expect(actions[1].args.token).toBe(TOKENS.PXCVX);
      expect(actions[1].args.spender).toBe(PIREX.LPXCVX);

      // Action 2: call wrap on lpxCVX
      expect(actions[2].protocol).toBe("enso");
      expect(actions[2].action).toBe("call");
      expect(actions[2].args.method).toBe("wrap");

      // Action 3: erc20/approve lpxCVX → Curve pool
      expect(actions[3].protocol).toBe("erc20");
      expect(actions[3].action).toBe("approve");
      expect(actions[3].args.token).toBe(PIREX.LPXCVX);
      expect(actions[3].args.spender).toBe(PIREX.LPXCVX_CVX_POOL);

      // Action 4: exchange lpxCVX→CVX
      expect(actions[4].protocol).toBe("enso");
      expect(actions[4].action).toBe("call");
      expect(actions[4].args.method).toBe("exchange");

      // Action 5: route CVX→crvUSD
      expect(actions[5].protocol).toBe("enso");
      expect(actions[5].action).toBe("route");
      expect(actions[5].args.tokenIn).toBe(TOKENS.CVX);
      expect(actions[5].args.tokenOut).toBe(CRVUSD);
      expect(actions[5].args.slippage).toBe("100");
      expect(actions[5].args.minAmountOut).toBeUndefined();

      // Action 6: curve-lending/repay
      expect(actions[6].protocol).toBe("curve-lending");
      expect(actions[6].action).toBe("repay");
      expect(actions[6].args.primaryAddress).toBe(CONTROLLER);
    });

    it("soft-liquidation repay: produces 8 actions (last 2 are buildDirectRepayActions)", async () => {
      await fetchRepayWithSwapBundle({ ...BASE_PARAMS, inSoftLiquidation: true });

      const actions = capturedActions();
      expect(actions).toHaveLength(8);

      // Actions 0-5 are same as normal path
      expect(actions[0].protocol).toBe("erc4626");
      expect(actions[4].args.method).toBe("exchange");
      expect(actions[5].action).toBe("route");

      // Action 6: erc20/approve crvUSD → controller
      expect(actions[6].protocol).toBe("erc20");
      expect(actions[6].action).toBe("approve");
      expect(actions[6].args.token).toBe(CRVUSD);
      expect(actions[6].args.spender).toBe(CONTROLLER);

      // Action 7: enso/call repay(uint256,address,int256)
      expect(actions[7].protocol).toBe("enso");
      expect(actions[7].action).toBe("call");
      expect(actions[7].args.method).toBe("repay");
      expect(actions[7].args.abi).toBe("function repay(uint256 _d_debt, address _for, int256 max_active_band)");
      expect(actions[7].args.args).toEqual([{ useOutputOfCallAt: 5 }, USER, MAX_INT256]);
    });

    it("throws when getLpxCvxToCvxSwapRate returns 0n", async () => {
      mockGetLpxCvxToCvxSwapRate.mockResolvedValue(0n);

      await expect(fetchRepayWithSwapBundle(BASE_PARAMS))
        .rejects
        .toThrow("Failed to estimate Curve lpxCVX→CVX swap output");
    });
  });

  // --------------------------------------------------------------------------
  // crvUSD-underlying vault (scrvUSD input)
  // --------------------------------------------------------------------------

  describe("crvUSD-underlying vault input (scrvUSD tokenIn)", () => {
    const SCRVUSD = CURVE_SAVINGS.SCRVUSD;
    const BASE_PARAMS = {
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
      tokenIn: SCRVUSD,
      amountIn: "1000000000000000000",
    };

    it("normal repay: 2 actions (erc4626/redeem + curve-lending/repay with useOutputOfCallAt: 0)", async () => {
      await fetchRepayWithSwapBundle(BASE_PARAMS);

      const actions = capturedActions();
      expect(actions).toHaveLength(2);

      // Action 0: erc4626/redeem scrvUSD → crvUSD
      expect(actions[0].protocol).toBe("erc4626");
      expect(actions[0].action).toBe("redeem");
      expect(actions[0].args.tokenIn).toBe(SCRVUSD);
      expect(actions[0].args.tokenOut).toBe(CRVUSD);

      // Action 1: curve-lending/repay
      expect(actions[1].protocol).toBe("curve-lending");
      expect(actions[1].action).toBe("repay");
      expect(actions[1].args.amountIn).toEqual({ useOutputOfCallAt: 0 });
      expect(actions[1].args.primaryAddress).toBe(CONTROLLER);
    });

    it("soft-liquidation: 3 actions (erc4626/redeem + approve + direct repay)", async () => {
      await fetchRepayWithSwapBundle({ ...BASE_PARAMS, inSoftLiquidation: true });

      const actions = capturedActions();
      expect(actions).toHaveLength(3);

      // Action 0: redeem
      expect(actions[0].protocol).toBe("erc4626");
      expect(actions[0].action).toBe("redeem");

      // Action 1: approve crvUSD → controller
      expect(actions[1].protocol).toBe("erc20");
      expect(actions[1].action).toBe("approve");
      expect(actions[1].args.token).toBe(CRVUSD);
      expect(actions[1].args.spender).toBe(CONTROLLER);
      expect(actions[1].args.amount).toEqual({ useOutputOfCallAt: 0 });

      // Action 2: direct repay call
      expect(actions[2].protocol).toBe("enso");
      expect(actions[2].action).toBe("call");
      expect(actions[2].args.method).toBe("repay");
      expect(actions[2].args.args).toEqual([{ useOutputOfCallAt: 0 }, USER, MAX_INT256]);
    });
  });

  // --------------------------------------------------------------------------
  // Standard vault (ycvxCRV input — underlying cvxCRV)
  // --------------------------------------------------------------------------

  describe("standard vault input (ycvxCRV tokenIn → cvxCRV → route → crvUSD)", () => {
    const BASE_PARAMS = {
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
      tokenIn: VAULT_ADDRESSES.YCVXCRV,
      amountIn: "1000000000000000000",
    };

    it("normal repay: 3 actions (redeem + route + curve-lending/repay)", async () => {
      await fetchRepayWithSwapBundle(BASE_PARAMS);

      const actions = capturedActions();
      expect(actions).toHaveLength(3);

      // Action 0: erc4626/redeem ycvxCRV → cvxCRV
      expect(actions[0].protocol).toBe("erc4626");
      expect(actions[0].action).toBe("redeem");
      expect(actions[0].args.tokenOut).toBe(TOKENS.CVXCRV);

      // Action 1: route cvxCRV → crvUSD
      expect(actions[1].protocol).toBe("enso");
      expect(actions[1].action).toBe("route");
      expect(actions[1].args.tokenIn).toBe(TOKENS.CVXCRV);
      expect(actions[1].args.tokenOut).toBe(CRVUSD);
      expect(actions[1].args.amountIn).toEqual({ useOutputOfCallAt: 0 });

      // Action 2: curve-lending/repay
      expect(actions[2].protocol).toBe("curve-lending");
      expect(actions[2].action).toBe("repay");
      expect(actions[2].args.amountIn).toEqual({ useOutputOfCallAt: 1 });
    });

    it("soft-liquidation: 4 actions (redeem + route + approve + direct repay)", async () => {
      await fetchRepayWithSwapBundle({ ...BASE_PARAMS, inSoftLiquidation: true });

      const actions = capturedActions();
      expect(actions).toHaveLength(4);

      // Action 0: redeem
      expect(actions[0].protocol).toBe("erc4626");
      // Action 1: route
      expect(actions[1].action).toBe("route");
      // Action 2: approve crvUSD → controller
      expect(actions[2].protocol).toBe("erc20");
      expect(actions[2].action).toBe("approve");
      expect(actions[2].args.spender).toBe(CONTROLLER);
      // Action 3: direct repay
      expect(actions[3].args.method).toBe("repay");
      expect(actions[3].args.abi).toBe("function repay(uint256 _d_debt, address _for, int256 max_active_band)");
      expect(actions[3].args.args).toEqual([{ useOutputOfCallAt: 1 }, USER, MAX_INT256]);
    });

    it("close loan: guards cvxCRV route output, repays max debt, and refunds crvUSD dust", async () => {
      await fetchRepayWithSwapBundle({
        ...BASE_PARAMS,
        closeLoan: true,
        maxRepayAmount: "1200000000000000000",
      });

      const actions = capturedActions();
      expect(actions).toHaveLength(7);

      expect(actions[0].action).toBe("redeem");
      expect(actions[1].action).toBe("route");
      expect(actions[1].args.minAmountOut).toBe("1200000000000000000");
      expect(actions[1].args.slippage).toBeUndefined();
      expect(actions[2].action).toBe("minamountout");
      expect(actions[2].args.amountOut).toEqual({ useOutputOfCallAt: 1 });
      expect(actions[2].args.minAmountOut).toBe("1200000000000000000");
      expect(actions[3].action).toBe("approve");
      expect(actions[4].args.method).toBe("repay");
      expect(actions[4].args.args).toEqual([MAX_UINT256, USER, MAX_INT256]);
      expect(actions[5].action).toBe("balance");
      expect(actions[6].action).toBe("transfer");
      expect(actions[6].args.receiver).toBe(USER);
      expect(actions.some((action) => action.protocol === "curve-lending")).toBe(false);
      expect(actions.some((action) => action.args?.method === "remove_collateral")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Regular ERC20 (non-vault)
  // --------------------------------------------------------------------------

  describe("regular ERC20 input (non-vault token)", () => {
    const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    const BASE_PARAMS = {
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
      tokenIn: WETH,
      amountIn: "1000000000000000000",
    };

    it("normal repay: 3 actions (route + min output guard + curve-lending/repay)", async () => {
      await fetchRepayWithSwapBundle(BASE_PARAMS);

      const actions = capturedActions();
      expect(actions).toHaveLength(3);

      // Action 0: route WETH → crvUSD
      expect(actions[0].protocol).toBe("enso");
      expect(actions[0].action).toBe("route");
      expect(actions[0].args.tokenIn).toBe(WETH);
      expect(actions[0].args.tokenOut).toBe(CRVUSD);
      expect(actions[0].args.amountIn).toBe("1000000000000000000");
      expect(actions[0].args.minAmountOut).toBe(MOCK_ROUTE_RESPONSE.amountOut);

      // Action 1: enforce crvUSD minimum output before repay
      expect(actions[1].protocol).toBe("enso");
      expect(actions[1].action).toBe("minamountout");
      expect(actions[1].args.amountOut).toEqual({ useOutputOfCallAt: 0 });
      expect(actions[1].args.minAmountOut).toBe(MOCK_ROUTE_RESPONSE.amountOut);

      // Action 2: curve-lending/repay
      expect(actions[2].protocol).toBe("curve-lending");
      expect(actions[2].action).toBe("repay");
      expect(actions[2].args.amountIn).toEqual({ useOutputOfCallAt: 0 });
      expect(actions[2].args.primaryAddress).toBe(CONTROLLER);
      expect(actions[2].args.onBehalfOf).toBe(USER);
    });

    it("soft-liquidation: 4 actions (route + min output guard + approve + direct repay)", async () => {
      await fetchRepayWithSwapBundle({ ...BASE_PARAMS, inSoftLiquidation: true });

      const actions = capturedActions();
      expect(actions).toHaveLength(4);

      // Action 0: route
      expect(actions[0].action).toBe("route");
      // Action 1: min output guard
      expect(actions[1].action).toBe("minamountout");
      // Action 2: approve
      expect(actions[2].protocol).toBe("erc20");
      expect(actions[2].action).toBe("approve");
      expect(actions[2].args.token).toBe(CRVUSD);
      expect(actions[2].args.spender).toBe(CONTROLLER);
      expect(actions[2].args.amount).toEqual({ useOutputOfCallAt: 0 });
      // Action 3: direct repay
      expect(actions[3].protocol).toBe("enso");
      expect(actions[3].args.method).toBe("repay");
      expect(actions[3].args.address).toBe(CONTROLLER.toLowerCase());
      expect(actions[3].args.args).toEqual([{ useOutputOfCallAt: 0 }, USER, MAX_INT256]);
    });

    it("close loan: swaps to at least debt, repays max debt, and refunds crvUSD dust", async () => {
      await fetchRepayWithSwapBundle({
        ...BASE_PARAMS,
        closeLoan: true,
        maxRepayAmount: "1200000000000000000",
      });

      const actions = capturedActions();
      expect(actions).toHaveLength(6);

      expect(actions[0].action).toBe("route");
      expect(actions[0].args.minAmountOut).toBe("1200000000000000000");
      expect(actions[1].action).toBe("minamountout");
      expect(actions[1].args.minAmountOut).toBe("1200000000000000000");

      expect(actions[2].protocol).toBe("erc20");
      expect(actions[2].action).toBe("approve");
      expect(actions[2].args.token).toBe(CRVUSD);
      expect(actions[2].args.spender).toBe(CONTROLLER);
      expect(actions[2].args.amount).toEqual({ useOutputOfCallAt: 0 });

      expect(actions[3].protocol).toBe("enso");
      expect(actions[3].action).toBe("call");
      expect(actions[3].args.method).toBe("repay");
      expect(actions[3].args.abi).toBe("function repay(uint256 _d_debt, address _for, int256 max_active_band)");
      expect(actions[3].args.args).toEqual([MAX_UINT256, USER, MAX_INT256]);

      expect(actions[4].protocol).toBe("enso");
      expect(actions[4].action).toBe("balance");
      expect(actions[4].args.token).toBe(CRVUSD);
      expect(actions[5].protocol).toBe("erc20");
      expect(actions[5].action).toBe("transfer");
      expect(actions[5].args.token).toBe(CRVUSD);
      expect(actions[5].args.amount).toEqual({ useOutputOfCallAt: 4 });
      expect(actions[5].args.receiver).toBe(USER);
      expect(actions.some((action) => action.protocol === "curve-lending")).toBe(false);
      expect(actions.some((action) => action.args?.method === "remove_collateral")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // buildDirectRepayActions (verified indirectly via soft-liq paths)
  // --------------------------------------------------------------------------

  describe("buildDirectRepayActions (indirect verification via soft-liq paths)", () => {
    it("always produces exactly 2 actions: erc20/approve + enso/call", async () => {
      // Use simplest path (regular ERC20) to isolate the direct repay actions
      await fetchRepayWithSwapBundle({
        fromAddress: USER,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
        tokenIn: "0xSomeToken",
        amountIn: "1000000000000000000",
        inSoftLiquidation: true,
      });

      const actions = capturedActions();
      // Regular ERC20 soft-liq = route + min output guard + 2 direct repay actions
      const directRepayActions = actions.slice(2);
      expect(directRepayActions).toHaveLength(2);

      // First: erc20/approve
      expect(directRepayActions[0].protocol).toBe("erc20");
      expect(directRepayActions[0].action).toBe("approve");

      // Second: enso/call
      expect(directRepayActions[1].protocol).toBe("enso");
      expect(directRepayActions[1].action).toBe("call");
    });

    it("spender in approve is the controller address", async () => {
      await fetchRepayWithSwapBundle({
        fromAddress: USER,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
        tokenIn: "0xSomeToken",
        amountIn: "1000000000000000000",
        inSoftLiquidation: true,
      });

      const actions = capturedActions();
      const approveAction = actions[2];
      expect(approveAction.args.spender).toBe(CONTROLLER);
    });

    it("repay ABI includes max_active_band", async () => {
      await fetchRepayWithSwapBundle({
        fromAddress: USER,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
        tokenIn: "0xSomeToken",
        amountIn: "1000000000000000000",
        inSoftLiquidation: true,
      });

      const actions = capturedActions();
      const repayAction = actions[3];
      expect(repayAction.args.abi).toBe("function repay(uint256 _d_debt, address _for, int256 max_active_band)");
      expect(repayAction.args.args).toHaveLength(3);
    });
  });

  // --------------------------------------------------------------------------
  // Withdraw after repay
  // --------------------------------------------------------------------------

  describe("withdraw after repay", () => {
    it("with withdrawAmount: appends remove_collateral action", async () => {
      await fetchRepayWithSwapBundle({
        fromAddress: USER,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
        tokenIn: "0xSomeToken",
        amountIn: "1000000000000000000",
        withdrawAmount: "500000000000000000",
      });

      const actions = capturedActions();
      // Regular ERC20 normal = route + min output guard + repay + remove_collateral
      expect(actions).toHaveLength(4);

      const removeAction = actions[3];
      expect(removeAction.protocol).toBe("enso");
      expect(removeAction.action).toBe("call");
      expect(removeAction.args.method).toBe("remove_collateral");
      expect(removeAction.args.address).toBe(CONTROLLER.toLowerCase());
      expect(removeAction.args.args).toEqual(["500000000000000000", USER]);
    });

    it("with withdrawAmount + withdrawTokenOut (different from vault): appends a protected collateral route", async () => {
      const SOME_TOKEN = "0xDifferentTokenAddress";

      await fetchRepayWithSwapBundle({
        fromAddress: USER,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
        tokenIn: "0xSomeToken",
        amountIn: "1000000000000000000",
        slippage: 175,
        withdrawAmount: "500000000000000000",
        withdrawTokenOut: SOME_TOKEN,
      });

      const actions = capturedActions();
      // route + min output guard + repay + remove_collateral + route collateral→token
      expect(actions).toHaveLength(5);

      // remove_collateral
      expect(actions[3].args.method).toBe("remove_collateral");

      // route collateral → withdrawTokenOut
      expect(actions[4].protocol).toBe("enso");
      expect(actions[4].action).toBe("route");
      expect(actions[4].args.tokenIn).toBe(VAULT_ADDRESSES.YCVXCRV);
      expect(actions[4].args.tokenOut).toBe(SOME_TOKEN);
      expect(actions[4].args.amountIn).toBe("500000000000000000");
      expect(actions[4].args.slippage).toBe("175");
      expect(actions[4].args.minAmountOut).toBeUndefined();
    });

    it("protects collateral conversion for every repay input path", async () => {
      const inputTokens = [
        VAULT_ADDRESSES.YSPXCVX,
        CURVE_SAVINGS.SCRVUSD,
        VAULT_ADDRESSES.YCVXCRV,
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      ];

      for (const tokenIn of inputTokens) {
        vi.clearAllMocks();
        mockFetchRoute.mockResolvedValue(MOCK_ROUTE_RESPONSE);
        mockEnsoFetchBundle.mockResolvedValue(MOCK_BUNDLE_RESPONSE);
        mockGetLpxCvxToCvxSwapRate.mockResolvedValue(940000000000000000n);

        await fetchRepayWithSwapBundle({
          fromAddress: USER,
          vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
          tokenIn,
          amountIn: "1000000000000000000",
          slippage: 225,
          withdrawAmount: "500000000000000000",
          withdrawTokenOut: "0xDifferentTokenAddress",
        });

        const collateralRoute = capturedActions().at(-1);
        expect(collateralRoute.action).toBe("route");
        expect(collateralRoute.args.slippage).toBe("225");
        expect(collateralRoute.args.minAmountOut).toBeUndefined();
      }
    });

    it("with withdrawAmount + withdrawTokenOut same as vault: only remove_collateral (no route)", async () => {
      await fetchRepayWithSwapBundle({
        fromAddress: USER,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
        tokenIn: "0xSomeToken",
        amountIn: "1000000000000000000",
        withdrawAmount: "500000000000000000",
        withdrawTokenOut: VAULT_ADDRESSES.YCVXCRV,
      });

      const actions = capturedActions();
      // route + min output guard + repay + remove_collateral — no route appended
      expect(actions).toHaveLength(4);
      expect(actions[3].args.method).toBe("remove_collateral");
    });
  });

  // --------------------------------------------------------------------------
  // Security
  // --------------------------------------------------------------------------

  describe("security", () => {
    const TEST_CASES = [
      { tokenIn: VAULT_ADDRESSES.YSPXCVX, label: "pxCVX vault" },
      { tokenIn: CURVE_SAVINGS.SCRVUSD, label: "scrvUSD vault" },
      { tokenIn: VAULT_ADDRESSES.YCVXCRV, label: "standard vault (ycvxCRV)" },
      { tokenIn: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", label: "regular ERC20 (WETH)" },
    ];

    it("no action has transferFrom with ENSO_SHORTCUTS as recipient across all paths", async () => {
      for (const { tokenIn, label } of TEST_CASES) {
        vi.clearAllMocks();
        mockFetchRoute.mockResolvedValue(MOCK_ROUTE_RESPONSE);
        mockEnsoFetchBundle.mockResolvedValue(MOCK_BUNDLE_RESPONSE);
        mockGetLpxCvxToCvxSwapRate.mockResolvedValue(940000000000000000n);

        await fetchRepayWithSwapBundle({
          fromAddress: USER,
          vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
          tokenIn,
          amountIn: "1000000000000000000",
        });

        const actions = capturedActions();
        for (const action of actions) {
          if (action.args?.method === "transferFrom") {
            expect(action.args.args[1], `${label}: transferFrom must not target ENSO_SHORTCUTS`).not.toBe(ENSO_SHORTCUTS);
          }
        }
      }
    });

    it("no erc20 approve targets ENSO_SHORTCUTS as spender across all paths", async () => {
      for (const { tokenIn, label } of TEST_CASES) {
        vi.clearAllMocks();
        mockFetchRoute.mockResolvedValue(MOCK_ROUTE_RESPONSE);
        mockEnsoFetchBundle.mockResolvedValue(MOCK_BUNDLE_RESPONSE);
        mockGetLpxCvxToCvxSwapRate.mockResolvedValue(940000000000000000n);

        await fetchRepayWithSwapBundle({
          fromAddress: USER,
          vaultAddress: VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
          tokenIn,
          amountIn: "1000000000000000000",
          inSoftLiquidation: true,
        });

        const actions = capturedActions();
        for (const action of actions) {
          if (action.protocol === "erc20" && action.action === "approve") {
            expect(action.args.spender, `${label}: erc20/approve must not target ENSO_SHORTCUTS`).not.toBe(ENSO_SHORTCUTS);
          }
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Error cases
  // --------------------------------------------------------------------------

  describe("error cases", () => {
    it("throws for unknown vault address (no controller)", async () => {
      await expect(
        fetchRepayWithSwapBundle({
          fromAddress: USER,
          vaultAddress: "0x0000000000000000000000000000000000000001" as `0x${string}`,
          tokenIn: "0xSomeToken",
          amountIn: "1000000000000000000",
        }),
      ).rejects.toThrow("No controller found for vault");
    });
  });
});
