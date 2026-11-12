// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/curve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/curve")>()),
  getCurveGetDy: vi.fn(),
  getCurveGetDyFactory: vi.fn(),
}));

vi.mock("@/lib/enso/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/enso/api")>()),
  fetchQuote: vi.fn(),
  getDynamicInputAggregatorPolicy: vi.fn(),
}));

import {
  appendBestExactUsdcToCvxConversion,
  toBalanceState,
  type ConversionContext,
} from "@/lib/enso/conversions";
import {
  CRVUSD_ADDRESS,
  CURVE_CVX_ETH_POOL,
  USDC_ADDRESS,
  WETH_ADDRESS,
} from "@/config/addresses";
import { TOKENS } from "@/config/vaults";
import { calculateMinDy, getCurveGetDy, getCurveGetDyFactory } from "@/lib/curve";
import { fetchQuote, getDynamicInputAggregatorPolicy } from "@/lib/enso/api";
import {
  CURVE_ROUTER,
  CURVE_TRICRV_POOL,
  CURVE_USDC_CRVUSD_POOL,
} from "@/lib/enso/bundle-helpers";
import { ENSO_SHORTCUTS } from "@/lib/enso/constants";
import type { EnsoBundleAction, EnsoQuoteResponse, RouteStep } from "@/types/enso";

const ZERO = "0x0000000000000000000000000000000000000000";

const ctx: ConversionContext = {
  fromAddress: "0x1234567890123456789012345678901234567890",
  slippage: "50",
  slippageBps: 50,
  totalSlippageBps: 150,
};

const amountRef = { useOutputOfCallAt: 0 };
const expectedUsdc = 1_000_000n;

function makeActions(): EnsoBundleAction[] {
  return [{ protocol: "enso", action: "balance", args: { token: USDC_ADDRESS } }];
}

function usePoolQuote({
  crvUsd = 2_000_000n,
  weth = 3_000n,
  cvx = 4_000n,
}: {
  crvUsd?: bigint | null;
  weth?: bigint | null;
  cvx?: bigint | null;
} = {}) {
  vi.mocked(getCurveGetDy).mockResolvedValue(crvUsd);
  vi.mocked(getCurveGetDyFactory).mockImplementation(async (pool: string) => {
    if (pool === CURVE_TRICRV_POOL) return weth;
    if (pool === CURVE_CVX_ETH_POOL) return cvx;
    throw new Error(`unexpected pool ${pool}`);
  });
}

function useRouterQuote(
  amountOut: bigint,
  protocol = "grapher",
  ignoreAggregators: string[] = ["0x"],
) {
  vi.mocked(getDynamicInputAggregatorPolicy).mockResolvedValue({
    availableSafeAggregators: [protocol],
    ignoreAggregators,
  });
  const quote: EnsoQuoteResponse = {
    amountOut: amountOut.toString(),
    route: [{ action: "swap", protocol, tokenIn: [USDC_ADDRESS], tokenOut: [TOKENS.CVX] }],
  };
  vi.mocked(fetchQuote).mockResolvedValue(quote);
}

function useNoRouterQuote() {
  vi.mocked(getDynamicInputAggregatorPolicy).mockResolvedValue({
    availableSafeAggregators: [],
    ignoreAggregators: ["0x"],
  });
}

describe("toBalanceState", () => {
  it("appends a balance action and points amountRef at it", () => {
    const actions = makeActions();

    const state = toBalanceState(actions, TOKENS.CVX, 7_000n);

    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: TOKENS.CVX },
    });
    expect(state).toEqual({
      token: TOKENS.CVX,
      amountRef: { useOutputOfCallAt: 1 },
      expectedAmount: 7_000n,
    });
  });
});

describe("appendBestExactUsdcToCvxConversion", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("uses the Curve pool path with the full exchange_multiple call", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    useNoRouterQuote();
    usePoolQuote({ crvUsd: 2_000_000n, weth: 3_000n, cvx: 4_000n });

    const state = await appendBestExactUsdcToCvxConversion(
      actions,
      amountRef,
      expectedUsdc,
      ctx,
      routeSteps,
    );

    expect(actions).toHaveLength(3);
    expect(actions[1]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: {
        token: USDC_ADDRESS.toLowerCase(),
        spender: CURVE_ROUTER,
        amount: amountRef,
      },
    });

    const call = actions[2];
    expect(call.protocol).toBe("enso");
    expect(call.action).toBe("call");
    expect(call.args.address).toBe(CURVE_ROUTER);
    expect(call.args.method).toBe("exchange_multiple");
    expect(call.args.abi).toBe(
      "function exchange_multiple(address[9] _route, uint256[3][4] _swap_params, uint256 _amount, uint256 _expected, address[4] _pools, address _receiver) payable returns (uint256)",
    );
    const args = call.args.args as unknown[];
    expect(args[0]).toEqual([
      USDC_ADDRESS,
      CURVE_USDC_CRVUSD_POOL,
      CRVUSD_ADDRESS,
      CURVE_TRICRV_POOL,
      WETH_ADDRESS,
      CURVE_CVX_ETH_POOL,
      TOKENS.CVX,
      ZERO,
      ZERO,
    ]);
    expect(args[1]).toEqual([
      [0, 1, 1],
      [0, 1, 3],
      [0, 1, 3],
      [0, 0, 0],
    ]);
    expect(args[2]).toBe(amountRef);
    expect(args[3]).toBe(calculateMinDy(4_000n, 150));
    expect(args[4]).toEqual([ZERO, ZERO, ZERO, ZERO]);
    expect(args[5]).toBe(ENSO_SHORTCUTS);

    expect(state).toEqual({
      token: TOKENS.CVX,
      amountRef: { useOutputOfCallAt: 2 },
      expectedAmount: 4_000n,
    });
    expect(routeSteps).toHaveLength(1);
    expect(routeSteps[0]).toMatchObject({
      tokenAddress: USDC_ADDRESS,
      action: "Swap",
      protocol: "Curve",
    });
    expect(fetchQuote).not.toHaveBeenCalled();
  });

  it("chains the three pool reads, passing each result as a decimal string", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    useNoRouterQuote();
    usePoolQuote({ crvUsd: 1_234n, weth: 2_345n, cvx: 3_456n });

    await appendBestExactUsdcToCvxConversion(actions, amountRef, expectedUsdc, ctx, routeSteps);

    expect(getCurveGetDy).toHaveBeenCalledTimes(1);
    expect(getCurveGetDy).toHaveBeenCalledWith(
      CURVE_USDC_CRVUSD_POOL,
      0,
      1,
      expectedUsdc.toString(),
    );
    expect(getCurveGetDyFactory).toHaveBeenCalledTimes(2);
    expect(getCurveGetDyFactory).toHaveBeenNthCalledWith(1, CURVE_TRICRV_POOL, 0, 1, "1234");
    expect(getCurveGetDyFactory).toHaveBeenNthCalledWith(2, CURVE_CVX_ETH_POOL, 0, 1, "2345");
  });

  it("takes the router route when its quote is strictly better than the pool", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    usePoolQuote({ cvx: 4_000n });
    useRouterQuote(4_001n, "grapher", ["0xbad"]);

    const state = await appendBestExactUsdcToCvxConversion(
      actions,
      amountRef,
      expectedUsdc,
      ctx,
      routeSteps,
    );

    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: USDC_ADDRESS,
        tokenOut: TOKENS.CVX,
        amountIn: amountRef,
        slippage: "50",
        ignoreAggregators: ["0xbad"],
      },
    });
    expect(fetchQuote).toHaveBeenCalledWith({
      fromAddress: ctx.fromAddress,
      tokenIn: USDC_ADDRESS,
      tokenOut: TOKENS.CVX,
      amountIn: expectedUsdc.toString(),
      ignoreAggregators: ["0xbad"],
    });
    expect(state).toEqual({
      token: TOKENS.CVX,
      amountRef: { useOutputOfCallAt: 1 },
      expectedAmount: 4_001n,
    });
    expect(routeSteps).toHaveLength(1);
    expect(routeSteps[0]).toMatchObject({
      tokenAddress: USDC_ADDRESS,
      action: "Swap",
      protocol: "Grapher",
    });
  });

  it("keeps the Curve pool path when the router quote equals the pool quote", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    usePoolQuote({ cvx: 4_000n });
    useRouterQuote(4_000n);

    const state = await appendBestExactUsdcToCvxConversion(
      actions,
      amountRef,
      expectedUsdc,
      ctx,
      routeSteps,
    );

    expect(actions).toHaveLength(3);
    expect(actions[1].protocol).toBe("erc20");
    expect(actions[2].action).toBe("call");
    expect(state.expectedAmount).toBe(4_000n);
    expect(routeSteps[0].protocol).toBe("Curve");
  });

  it("keeps the Curve pool path when the router quote is worse", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    usePoolQuote({ cvx: 4_000n });
    useRouterQuote(3_999n);

    const state = await appendBestExactUsdcToCvxConversion(
      actions,
      amountRef,
      expectedUsdc,
      ctx,
      routeSteps,
    );

    expect(actions).toHaveLength(3);
    expect(actions[1].protocol).toBe("erc20");
    expect(actions[2].action).toBe("call");
    expect(state.expectedAmount).toBe(4_000n);
    expect(routeSteps[0].protocol).toBe("Curve");
  });

  it("takes the router route when the first pool read returns null", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    usePoolQuote({ crvUsd: null });
    useRouterQuote(4_000n);

    const state = await appendBestExactUsdcToCvxConversion(
      actions,
      amountRef,
      expectedUsdc,
      ctx,
      routeSteps,
    );

    expect(actions).toHaveLength(2);
    expect(actions[1].protocol).toBe("enso");
    expect(actions[1].action).toBe("route");
    expect(state.expectedAmount).toBe(4_000n);
    expect(routeSteps[0].protocol).toBe("Grapher");
  });

  it("takes the router route when the second pool read returns zero", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    usePoolQuote({ weth: 0n });
    useRouterQuote(4_000n);

    const state = await appendBestExactUsdcToCvxConversion(
      actions,
      amountRef,
      expectedUsdc,
      ctx,
      routeSteps,
    );

    expect(actions).toHaveLength(2);
    expect(actions[1].action).toBe("route");
    expect(state.expectedAmount).toBe(4_000n);
    expect(routeSteps[0].protocol).toBe("Grapher");
  });

  it("takes the router route when a pool read rejects", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    vi.mocked(getCurveGetDy).mockRejectedValue(new Error("rpc down"));
    useRouterQuote(4_000n);

    const state = await appendBestExactUsdcToCvxConversion(
      actions,
      amountRef,
      expectedUsdc,
      ctx,
      routeSteps,
    );

    expect(actions).toHaveLength(2);
    expect(actions[1].action).toBe("route");
    expect(state.expectedAmount).toBe(4_000n);
    expect(routeSteps[0].protocol).toBe("Grapher");
  });

  it("rejects a router hop whose protocol is not in the safe set and keeps the pool path", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    usePoolQuote({ cvx: 4_000n });
    vi.mocked(getDynamicInputAggregatorPolicy).mockResolvedValue({
      availableSafeAggregators: ["grapher"],
      ignoreAggregators: ["0x"],
    });
    vi.mocked(fetchQuote).mockResolvedValue({
      amountOut: "9_000_000",
      route: [{ action: "swap", protocol: "0x", tokenIn: [USDC_ADDRESS], tokenOut: [TOKENS.CVX] }],
    });

    const state = await appendBestExactUsdcToCvxConversion(
      actions,
      amountRef,
      expectedUsdc,
      ctx,
      routeSteps,
    );

    expect(actions).toHaveLength(3);
    expect(actions[1].protocol).toBe("erc20");
    expect(actions[2].action).toBe("call");
    expect(state.expectedAmount).toBe(4_000n);
    expect(routeSteps[0].protocol).toBe("Curve");
  });

  it("treats a mixed-case OpenOcean hop as safe and keeps the hop's own protocol name", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    usePoolQuote({ cvx: 4_000n });
    useRouterQuote(4_500n, "OpenOcean");

    const state = await appendBestExactUsdcToCvxConversion(
      actions,
      amountRef,
      expectedUsdc,
      ctx,
      routeSteps,
    );

    expect(actions).toHaveLength(2);
    expect(actions[1].action).toBe("route");
    expect(state.expectedAmount).toBe(4_500n);
    expect(routeSteps).toHaveLength(1);
    expect(routeSteps[0].protocol).toBe("OpenOcean");
  });

  it("falls back to the pool path when fetchQuote rejects", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    usePoolQuote({ cvx: 4_000n });
    vi.mocked(getDynamicInputAggregatorPolicy).mockResolvedValue({
      availableSafeAggregators: ["grapher"],
      ignoreAggregators: ["0x"],
    });
    vi.mocked(fetchQuote).mockRejectedValue(new Error("quote failed"));

    const state = await appendBestExactUsdcToCvxConversion(
      actions,
      amountRef,
      expectedUsdc,
      ctx,
      routeSteps,
    );

    expect(actions).toHaveLength(3);
    expect(actions[1].protocol).toBe("erc20");
    expect(actions[2].action).toBe("call");
    expect(state.expectedAmount).toBe(4_000n);
    expect(routeSteps[0].protocol).toBe("Curve");
  });

  it("falls back to the pool path when the aggregator policy rejects", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    usePoolQuote({ cvx: 4_000n });
    vi.mocked(getDynamicInputAggregatorPolicy).mockRejectedValue(new Error("policy failed"));

    const state = await appendBestExactUsdcToCvxConversion(
      actions,
      amountRef,
      expectedUsdc,
      ctx,
      routeSteps,
    );

    expect(fetchQuote).not.toHaveBeenCalled();
    expect(actions).toHaveLength(3);
    expect(actions[1].protocol).toBe("erc20");
    expect(actions[2].action).toBe("call");
    expect(state.expectedAmount).toBe(4_000n);
    expect(routeSteps[0].protocol).toBe("Curve");
  });

  it("throws when neither a safe router quote nor a pool quote is available", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    useNoRouterQuote();
    vi.mocked(getCurveGetDy).mockResolvedValue(null);
    vi.mocked(getCurveGetDyFactory).mockRejectedValue(new Error("should not be read"));

    await expect(
      appendBestExactUsdcToCvxConversion(actions, amountRef, expectedUsdc, ctx, routeSteps),
    ).rejects.toThrow("No exact-amount-safe USDC→CVX route is currently available");

    expect(actions).toHaveLength(1);
    expect(routeSteps).toHaveLength(0);
  });

  it("defaults the router action slippage to 100 when ctx.slippage is undefined", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    usePoolQuote({ cvx: 4_000n });
    useRouterQuote(4_001n);
    const ctxWithoutSlippage: ConversionContext = {
      fromAddress: ctx.fromAddress,
      slippageBps: 50,
      totalSlippageBps: 150,
    };

    await appendBestExactUsdcToCvxConversion(
      actions,
      amountRef,
      expectedUsdc,
      ctxWithoutSlippage,
      routeSteps,
    );

    expect(actions).toHaveLength(2);
    expect(actions[1]).toMatchObject({
      protocol: "enso",
      action: "route",
      args: { slippage: "100" },
    });
  });
});
