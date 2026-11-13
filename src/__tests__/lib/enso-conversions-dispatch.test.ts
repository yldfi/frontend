// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// This module is part of an import cycle (see the note at the top of
// conversions.ts); importing it after the mocks keeps the cycle resolvable in
// the unit project, same as enso-conversions-cvx-pxcvx.test.ts.
vi.mock("@/lib/enso/pxcvx-pool", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/enso/pxcvx-pool")>()),
  getOptimalPxCvxSwapAmount: vi.fn(),
  getPxCvxSwapRate: vi.fn(),
  getLpxCvxToCvxSwapRate: vi.fn(),
}));

vi.mock("@/lib/enso/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/enso/api")>()),
  estimateRouteOutput: vi.fn(),
}));

import { PIREX, TOKENS } from "@/config/vaults";
import { calculateMinDy } from "@/lib/curve";
import { estimateRouteOutput } from "@/lib/enso/api";
import {
  intermediateApproveAction,
  rawCallConsumingInput,
} from "@/lib/enso/bundle-helpers";
import { ENSO_SHORTCUTS, ZERO_ADDRESS } from "@/lib/enso/constants";
import {
  convertStateToToken,
  type ConversionContext,
  type ConversionState,
} from "@/lib/enso/conversions";
import {
  getLpxCvxToCvxSwapRate,
  getOptimalPxCvxSwapAmount,
  getPxCvxSwapRate,
} from "@/lib/enso/pxcvx-pool";
import type { EnsoBundleAction, RouteStep } from "@/types/enso";

// A token that is none of CVX, pxCVX or lpxCVX.
const OTHER = TOKENS.CVXCRV;

const ctx: ConversionContext = {
  fromAddress: "0x1234567890123456789012345678901234567890",
  slippage: "100",
  slippageBps: 100,
  totalSlippageBps: 150,
};

// Two leading actions so no converted action lands at index 0 or 1.
const DUMMY_ACTIONS = 2;

const WRAP_ABI = "function wrap(uint256 amount)";
const UNWRAP_ABI = "function unwrap(uint256 amount)";
const EXCHANGE_ABI =
  "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)";
const DEPOSIT_ABI =
  "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)";
const SWAP_ABI =
  "function swap(uint8 source, uint256 amount, uint256 minReceived, uint256 fromIndex, uint256 toIndex)";

function makeActions(): EnsoBundleAction[] {
  return [
    { protocol: "enso", action: "balance", args: { token: TOKENS.CVXCRV } },
    { protocol: "enso", action: "balance", args: { token: TOKENS.STKCVXCRV } },
  ];
}

function fixedState(token: string, amount = 1000n): ConversionState {
  return { token, amountRef: amount.toString(), expectedAmount: amount };
}

function dynamicState(token: string, amount = 1000n, index = 1): ConversionState {
  return { token, amountRef: { useOutputOfCallAt: index }, expectedAmount: amount };
}

function useSplit(swapAmount: bigint, mintAmount: bigint) {
  vi.mocked(getOptimalPxCvxSwapAmount).mockResolvedValue({ swapAmount, mintAmount });
}

function useSwapRates(rates: Record<string, bigint | null>) {
  vi.mocked(getPxCvxSwapRate).mockImplementation(async (amountIn: string) => {
    if (!(amountIn in rates)) {
      throw new Error(`unexpected getPxCvxSwapRate(${amountIn})`);
    }
    return rates[amountIn] as bigint;
  });
}

function rateCalls(): string[] {
  return vi.mocked(getPxCvxSwapRate).mock.calls.map(([amountIn]) => amountIn);
}

function useCvxQuote(quote: bigint | null) {
  vi.mocked(getLpxCvxToCvxSwapRate).mockResolvedValue(quote as bigint);
}

function useRouteEstimates(...estimates: string[]) {
  const mock = vi.mocked(estimateRouteOutput);
  mock.mockReset();
  for (const estimate of estimates) {
    mock.mockResolvedValueOnce(estimate);
  }
}

// Case 14 helper: every returned reference must be a real index into the bundle.
function expectRefAt(
  actions: EnsoBundleAction[],
  result: ConversionState,
  expectedIndex: number,
) {
  expect(result.amountRef).toEqual({ useOutputOfCallAt: expectedIndex });
  expect(expectedIndex).toBeGreaterThanOrEqual(0);
  expect(expectedIndex).toBeLessThan(actions.length);
}

function expectDummiesUntouched(actions: EnsoBundleAction[]) {
  expect(actions.slice(0, DUMMY_ACTIONS)).toEqual(makeActions());
}

function exchangeAction(amountRef: string | { useOutputOfCallAt: number }, minDy: string) {
  return {
    protocol: "enso",
    action: "call",
    args: {
      address: PIREX.LPXCVX_CVX_POOL,
      method: "exchange",
      abi: EXCHANGE_ABI,
      args: [
        String(PIREX.POOL_INDEX.LPXCVX),
        String(PIREX.POOL_INDEX.CVX),
        amountRef,
        minDy,
      ],
    },
  };
}

// appendCvxToLpxCvxConversion exchanges with coin indices (CVX, lpxCVX).
function cvxToLpxExchangeAction(
  amountRef: string | { useOutputOfCallAt: number },
  minDy: string,
) {
  return {
    protocol: "enso",
    action: "call",
    args: {
      address: PIREX.LPXCVX_CVX_POOL,
      method: "exchange",
      abi: EXCHANGE_ABI,
      args: [
        String(PIREX.POOL_INDEX.CVX),
        String(PIREX.POOL_INDEX.LPXCVX),
        amountRef,
        minDy,
      ],
    },
  };
}

function pirexSwapAction(
  amountRef: string | { useOutputOfCallAt: number },
  minReceived: string,
) {
  return {
    protocol: "enso",
    action: "call",
    args: {
      address: PIREX.LPXCVX,
      method: "swap",
      abi: SWAP_ABI,
      args: [
        String(PIREX.TOKEN_ENUM.CVX),
        amountRef,
        minReceived,
        String(PIREX.POOL_INDEX.CVX),
        String(PIREX.POOL_INDEX.LPXCVX),
      ],
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("convertStateToToken: same token", () => {
  it("returns the state object unchanged, case-insensitively, without touching mocks", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state: ConversionState = {
      token: TOKENS.CVX,
      amountRef: "1000",
      expectedAmount: 1000n,
    };

    const result = await convertStateToToken(
      actions,
      state,
      TOKENS.CVX.toLowerCase(),
      ctx,
      routeSteps,
    );

    expect(result).toBe(state);
    expect(actions).toHaveLength(DUMMY_ACTIONS);
    expect(routeSteps).toHaveLength(0);
    expect(getOptimalPxCvxSwapAmount).not.toHaveBeenCalled();
    expect(getPxCvxSwapRate).not.toHaveBeenCalled();
    expect(getLpxCvxToCvxSwapRate).not.toHaveBeenCalled();
    expect(estimateRouteOutput).not.toHaveBeenCalled();
    expectDummiesUntouched(actions);
  });
});

describe("convertStateToToken: lpxCVX -> pxCVX", () => {
  it("unwraps a fixed amount and reads the pxCVX balance", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state = fixedState(TOKENS.LPXCVX);

    const result = await convertStateToToken(actions, state, TOKENS.PXCVX, ctx, routeSteps);

    const expectedUnwrap = rawCallConsumingInput("1000", TOKENS.LPXCVX, {
      address: PIREX.LPXCVX,
      method: "unwrap",
      abi: UNWRAP_ABI,
      args: ["1000"],
    });
    expect(actions[2]).toEqual(expectedUnwrap);
    expect(actions[2].args.address).toBe(PIREX.LPXCVX);
    expect(actions[2].args.method).toBe("unwrap");
    expect(actions[2].args.args).toEqual(["1000"]);
    expect(actions[2].args.tokenIn).toBe(TOKENS.LPXCVX);
    expect(actions[2].args.amountIn).toBe("1000");
    expect(actions[3]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: TOKENS.PXCVX },
    });
    expect(actions).toHaveLength(4);

    expect(result.token).toBe(TOKENS.PXCVX);
    expect(result.expectedAmount).toBe(1000n);
    expectRefAt(actions, result, 3);
    expect(routeSteps).toHaveLength(0);

    expect(getOptimalPxCvxSwapAmount).not.toHaveBeenCalled();
    expect(getPxCvxSwapRate).not.toHaveBeenCalled();
    expect(getLpxCvxToCvxSwapRate).not.toHaveBeenCalled();
    expect(estimateRouteOutput).not.toHaveBeenCalled();
    expectDummiesUntouched(actions);
  });

  it("uses the runtime reference for a dynamic amount, declaring no tokenIn or amountIn", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state = dynamicState(TOKENS.LPXCVX);
    const amountRef = state.amountRef as { useOutputOfCallAt: number };

    const result = await convertStateToToken(actions, state, TOKENS.PXCVX, ctx, routeSteps);

    const expectedUnwrap = rawCallConsumingInput(amountRef, TOKENS.LPXCVX, {
      address: PIREX.LPXCVX,
      method: "unwrap",
      abi: UNWRAP_ABI,
      args: [amountRef],
    });
    expect(actions[2]).toEqual(expectedUnwrap);
    expect(actions[2].args.tokenIn).toBeUndefined();
    expect(actions[2].args.amountIn).toBeUndefined();
    expect((actions[2].args.args as unknown[])[0]).toBe(amountRef);
    expect(actions[3]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: TOKENS.PXCVX },
    });

    expect(result.token).toBe(TOKENS.PXCVX);
    expect(result.expectedAmount).toBe(1000n);
    expectRefAt(actions, result, 3);
    expect(routeSteps).toHaveLength(0);
    expectDummiesUntouched(actions);
  });
});

describe("convertStateToToken: pxCVX -> lpxCVX", () => {
  it("approves, wraps and reads the lpxCVX balance", async () => {
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state = fixedState(TOKENS.PXCVX);

    const result = await convertStateToToken(actions, state, TOKENS.LPXCVX, ctx, routeSteps);

    expect(actions[2]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.PXCVX, spender: PIREX.LPXCVX, amount: "1000" },
    });
    expect(actions[3]).toEqual({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "wrap",
        abi: WRAP_ABI,
        args: ["1000"],
      },
    });
    expect(actions[4]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: TOKENS.LPXCVX },
    });
    expect(actions).toHaveLength(5);

    expect(result.token).toBe(TOKENS.LPXCVX);
    expect(result.expectedAmount).toBe(1000n);
    expectRefAt(actions, result, 4);

    expect(routeSteps).toHaveLength(1);
    expect(routeSteps[0].action).toBe("Wrap");
    expect(routeSteps[0].protocol).toBe("Pirex");
    expect(routeSteps[0].tokenAddress).toBe(TOKENS.PXCVX);
    expect(routeSteps[0].rawAmount).toBe("1000");
    expect(getLpxCvxToCvxSwapRate).not.toHaveBeenCalled();
    expect(estimateRouteOutput).not.toHaveBeenCalled();
    expectDummiesUntouched(actions);
  });
});

describe("convertStateToToken: pxCVX -> CVX", () => {
  const cases = [
    { label: "fixed amount", fixed: true },
    { label: "dynamic amount", fixed: false },
  ] as const;

  it.each(cases)(
    "wrap, swap and return the exchange ($label)",
    async ({ fixed }) => {
      useCvxQuote(1100n);
      const actions = makeActions();
      const routeSteps: RouteStep[] = [];
      const state = fixed ? fixedState(TOKENS.PXCVX) : dynamicState(TOKENS.PXCVX);
      const amountRef = state.amountRef;

      const result = await convertStateToToken(actions, state, TOKENS.CVX, ctx, routeSteps);

      expect(getLpxCvxToCvxSwapRate).toHaveBeenCalledWith("1000");

      expect(actions[2]).toEqual({
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.PXCVX, spender: PIREX.LPXCVX, amount: amountRef },
      });
      expect(actions[3]).toEqual({
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX,
          method: "wrap",
          abi: WRAP_ABI,
          args: [amountRef],
        },
      });

      // A fixed input needs the raw-call approve (the lpxCVX comes from the void wrap);
      // a runtime amount uses the plain erc20 approval.
      const expectedApprove = intermediateApproveAction(
        PIREX.LPXCVX,
        PIREX.LPXCVX_CVX_POOL,
        amountRef,
        fixed,
      );
      expect(actions[4]).toEqual(expectedApprove);
      if (fixed) {
        expect(actions[4].protocol).toBe("enso");
        expect(actions[4].args.address).toBe(PIREX.LPXCVX);
        expect(actions[4].args.method).toBe("approve");
        expect((actions[4].args.args as unknown[])[0]).toBe(PIREX.LPXCVX_CVX_POOL);
        expect((actions[4].args.args as unknown[])[1]).toBe("1000");
      } else {
        expect(actions[4]).toEqual({
          protocol: "erc20",
          action: "approve",
          args: {
            token: PIREX.LPXCVX,
            spender: PIREX.LPXCVX_CVX_POOL,
            amount: amountRef,
          },
        });
      }

      expect(actions[5]).toEqual(
        exchangeAction(amountRef, calculateMinDy(1100n, 150)),
      );
      expect((actions[5].args.args as unknown[])[0]).toBe("1");
      expect((actions[5].args.args as unknown[])[1]).toBe("0");
      expect(actions).toHaveLength(6);

      expect(result.token).toBe(TOKENS.CVX);
      expect(result.expectedAmount).toBe(1100n);
      expectRefAt(actions, result, 5);

      expect(routeSteps).toHaveLength(2);
      expect(routeSteps[0].action).toBe("Wrap");
      expect(routeSteps[0].protocol).toBe("Pirex");
      expect(routeSteps[1].action).toBe("Swap");
      expect(routeSteps[1].protocol).toBe("Curve");
      expect(routeSteps[1].tokenAddress).toBe(PIREX.LPXCVX);
      expect(estimateRouteOutput).not.toHaveBeenCalled();
      expectDummiesUntouched(actions);
    },
  );
  it.each([
    { label: "null", quote: null },
    { label: "zero", quote: 0n },
  ])(
    "rejects when the quote comes back $label, before appending anything",
    async ({ quote }) => {
      useCvxQuote(quote);
      const actions = makeActions();
      const routeSteps: RouteStep[] = [];

      await expect(
        convertStateToToken(actions, fixedState(TOKENS.PXCVX), TOKENS.CVX, ctx, routeSteps),
      ).rejects.toThrow("Failed to estimate Curve lpxCVX→CVX swap output");

      expect(getLpxCvxToCvxSwapRate).toHaveBeenCalledTimes(1);
      expect(getLpxCvxToCvxSwapRate).toHaveBeenCalledWith("1000");
      expect(actions).toHaveLength(DUMMY_ACTIONS);
      expect(routeSteps).toHaveLength(0);
    },
  );
});

describe("convertStateToToken: lpxCVX -> CVX", () => {
  it("approves lpxCVX to the pool and swaps, with no wrap pair", async () => {
    useCvxQuote(1050n);
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state = fixedState(TOKENS.LPXCVX);

    const result = await convertStateToToken(actions, state, TOKENS.CVX, ctx, routeSteps);

    expect(getLpxCvxToCvxSwapRate).toHaveBeenCalledWith("1000");
    expect(actions[2]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.LPXCVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: "1000",
      },
    });
    expect(actions[3]).toEqual(exchangeAction("1000", calculateMinDy(1050n, 150)));
    expect(actions).toHaveLength(4);

    expect(result.token).toBe(TOKENS.CVX);
    expect(result.expectedAmount).toBe(1050n);
    expectRefAt(actions, result, 3);

    expect(routeSteps).toHaveLength(1);
    expect(routeSteps[0].action).toBe("Swap");
    expect(routeSteps[0].protocol).toBe("Curve");
    expect(routeSteps[0].tokenAddress).toBe(TOKENS.LPXCVX);
    expectDummiesUntouched(actions);
  });

  it("rejects when the quote comes back null, before appending anything", async () => {
    useCvxQuote(null);
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];

    await expect(
      convertStateToToken(actions, fixedState(TOKENS.LPXCVX), TOKENS.CVX, ctx, routeSteps),
    ).rejects.toThrow("Failed to estimate Curve lpxCVX→CVX swap output");

    expect(actions).toHaveLength(DUMMY_ACTIONS);
    expect(routeSteps).toHaveLength(0);
  });

  it("rejects when the quote comes back zero, before appending anything", async () => {
    useCvxQuote(0n);
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];

    await expect(
      convertStateToToken(actions, fixedState(TOKENS.LPXCVX), TOKENS.CVX, ctx, routeSteps),
    ).rejects.toThrow("Failed to estimate Curve lpxCVX→CVX swap output");

    expect(actions).toHaveLength(DUMMY_ACTIONS);
    expect(routeSteps).toHaveLength(0);
  });
});

describe("convertStateToToken: other tokens -> CVX", () => {
  it("appends one routed swap using the context slippage", async () => {
    useRouteEstimates("4321");
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state = fixedState(OTHER);

    const result = await convertStateToToken(actions, state, TOKENS.CVX, ctx, routeSteps);

    expect(estimateRouteOutput).toHaveBeenCalledTimes(1);
    expect(estimateRouteOutput).toHaveBeenCalledWith(
      ctx.fromAddress,
      OTHER,
      TOKENS.CVX,
      "1000",
      "100",
    );
    expect(actions[2]).toEqual({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: OTHER,
        tokenOut: TOKENS.CVX,
        amountIn: "1000",
        slippage: "100",
      },
    });
    expect(actions).toHaveLength(3);

    expect(result.token).toBe(TOKENS.CVX);
    expect(result.expectedAmount).toBe(4321n);
    expectRefAt(actions, result, 2);

    expect(routeSteps).toHaveLength(1);
    expect(routeSteps[0].action).toBe("Swap");
    expect(routeSteps[0].protocol).toBe("Enso");
    expect(routeSteps[0].tokenAddress).toBe(OTHER);
    expect(routeSteps[0].rawAmount).toBe("1000");
    expectDummiesUntouched(actions);
  });

  it("defaults the route slippage to 100 and passes undefined to the estimator", async () => {
    useRouteEstimates("4321");
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const noSlippageCtx: ConversionContext = {
      fromAddress: ctx.fromAddress,
      slippageBps: 100,
      totalSlippageBps: 150,
    };

    const result = await convertStateToToken(
      actions,
      fixedState(OTHER),
      TOKENS.CVX,
      noSlippageCtx,
      routeSteps,
    );

    expect(estimateRouteOutput).toHaveBeenCalledWith(
      noSlippageCtx.fromAddress,
      OTHER,
      TOKENS.CVX,
      "1000",
      undefined,
    );
    expect(actions[2].args.slippage).toBe("100");
    expect(result.expectedAmount).toBe(4321n);
    expectRefAt(actions, result, 2);
    expectDummiesUntouched(actions);
  });
});

describe("convertStateToToken: chained conversions", () => {
  it("pxCVX -> other converts to CVX first, then routes the exchange output", async () => {
    useCvxQuote(1100n);
    useRouteEstimates("990");
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state = fixedState(TOKENS.PXCVX);

    const result = await convertStateToToken(actions, state, OTHER, ctx, routeSteps);

    // The to-CVX leg.
    expect(actions[2].action).toBe("approve");
    expect(actions[5].args.method).toBe("exchange");
    const exchangeRef = { useOutputOfCallAt: 5 };

    // The routed leg spends the exchange's output.
    expect(actions[6]).toEqual({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: OTHER,
        amountIn: exchangeRef,
        slippage: "100",
      },
    });
    expect(actions).toHaveLength(7);

    expect(estimateRouteOutput).toHaveBeenCalledTimes(1);
    expect(estimateRouteOutput).toHaveBeenCalledWith(
      ctx.fromAddress,
      TOKENS.CVX,
      OTHER,
      "1100",
      "100",
    );

    expect(result.token).toBe(OTHER);
    expect(result.expectedAmount).toBe(990n);
    expectRefAt(actions, result, 6);

    expect(routeSteps).toHaveLength(3);
    expect(routeSteps[0].action).toBe("Wrap");
    expect(routeSteps[1].action).toBe("Swap");
    expect(routeSteps[1].protocol).toBe("Curve");
    expect(routeSteps[2].action).toBe("Swap");
    expect(routeSteps[2].protocol).toBe("Enso");
    expectDummiesUntouched(actions);
  });

  it("other -> pxCVX routes to CVX, then splits the runtime reference into the swap leg", async () => {
    useRouteEstimates("5000");
    useSplit(4900n, 0n);
    useSwapRates({ "4900": 4950n, "5000": 5050n });
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state = fixedState(OTHER, 5000n);

    const result = await convertStateToToken(actions, state, TOKENS.PXCVX, ctx, routeSteps);

    // Route to CVX first.
    expect(actions[2].action).toBe("route");
    expect(actions[2].args.tokenIn).toBe(OTHER);
    expect(actions[2].args.tokenOut).toBe(TOKENS.CVX);
    const routeRef = { useOutputOfCallAt: 2 };

    // The split is sized from the slippage-buffered estimate.
    expect(getOptimalPxCvxSwapAmount).toHaveBeenCalledWith("4950");
    // A dynamic input is spent by reference, not by the fixed split amount.
    expect(actions[3]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: PIREX.LPXCVX, amount: routeRef },
    });
    expect(actions[4]).toEqual(pirexSwapAction(routeRef, calculateMinDy(4950n, 150)));
    expect((actions[4].args.args as unknown[])[1]).toEqual(routeRef);
    expect(actions[5]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: TOKENS.PXCVX },
    });
    expect(actions).toHaveLength(6);

    expect(rateCalls()).toEqual(["4900", "5000"]);
    expect(result.token).toBe(TOKENS.PXCVX);
    expect(result.expectedAmount).toBe(5050n);
    expectRefAt(actions, result, 5);

    expect(routeSteps).toHaveLength(2);
    expect(routeSteps[0].protocol).toBe("Enso");
    expect(routeSteps[1].protocol).toBe("Curve");
    expectDummiesUntouched(actions);
  });

  it("other -> lpxCVX routes to CVX, then swaps the runtime reference in the Curve pool", async () => {
    useRouteEstimates("5000");
    useSplit(4900n, 0n);
    useSwapRates({ "4900": 4950n, "5000": 5050n });
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state = fixedState(OTHER, 5000n);

    const result = await convertStateToToken(actions, state, TOKENS.LPXCVX, ctx, routeSteps);

    expect(actions[2].args.tokenOut).toBe(TOKENS.CVX);
    const routeRef = { useOutputOfCallAt: 2 };

    expect(getOptimalPxCvxSwapAmount).toHaveBeenCalledWith("4950");
    expect(actions[3]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: routeRef,
      },
    });
    expect(actions[4]).toEqual(cvxToLpxExchangeAction(routeRef, calculateMinDy(4950n, 150)));
    expect(actions[5]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: TOKENS.LPXCVX },
    });
    expect(actions).toHaveLength(6);

    expect(rateCalls()).toEqual(["4900", "5000"]);
    expect(result.token).toBe(TOKENS.LPXCVX);
    expect(result.expectedAmount).toBe(5050n);
    expectRefAt(actions, result, 5);

    expect(routeSteps).toHaveLength(2);
    expect(routeSteps[0].protocol).toBe("Enso");
    expect(routeSteps[1].protocol).toBe("Curve");
    expectDummiesUntouched(actions);
  });
});

describe("convertStateToToken: CVX -> lpxCVX with a fixed amount", () => {
  it("swap only: approves CVX to the pool and exchanges", async () => {
    useSplit(990n, 0n);
    useSwapRates({ "990": 1010n });
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state = fixedState(TOKENS.CVX);

    const result = await convertStateToToken(actions, state, TOKENS.LPXCVX, ctx, routeSteps);

    expect(getOptimalPxCvxSwapAmount).toHaveBeenCalledWith("990");
    expect(rateCalls()).toEqual(["990"]);

    expect(actions[2]).toEqual(
      intermediateApproveAction(TOKENS.CVX, PIREX.LPXCVX_CVX_POOL, "990", false),
    );
    expect(actions[2]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: PIREX.LPXCVX_CVX_POOL, amount: "990" },
    });
    // The swap approves the pool, not the lpxCVX contract.
    expect(actions[2].args.spender).not.toBe(PIREX.LPXCVX);

    expect(actions[3]).toEqual({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX_CVX_POOL,
        method: "exchange",
        abi: EXCHANGE_ABI,
        args: [
          String(PIREX.POOL_INDEX.CVX),
          String(PIREX.POOL_INDEX.LPXCVX),
          "990",
          calculateMinDy(1010n, 150),
        ],
      },
    });
    expect((actions[3].args.args as unknown[])[0]).toBe("0");
    expect((actions[3].args.args as unknown[])[1]).toBe("1");
    expect(actions[4]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: PIREX.LPXCVX },
    });
    expect(actions).toHaveLength(5);

    expect(result.token).toBe(PIREX.LPXCVX);
    expect(result.expectedAmount).toBe(1010n);
    expectRefAt(actions, result, 4);

    expect(routeSteps).toHaveLength(1);
    expect(routeSteps[0].action).toBe("Swap");
    expect(routeSteps[0].protocol).toBe("Curve");
    expect(routeSteps[0].rawAmount).toBe("1000");
    expectDummiesUntouched(actions);
  });

  it("mint only: deposits 1:1, wraps the pxCVX balance and returns lpxCVX", async () => {
    useSplit(0n, 990n);
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state = fixedState(TOKENS.CVX);

    const result = await convertStateToToken(actions, state, TOKENS.LPXCVX, ctx, routeSteps);

    expect(getPxCvxSwapRate).not.toHaveBeenCalled();
    expect(actions[2]).toEqual(
      intermediateApproveAction(TOKENS.CVX, PIREX.PIREX_CVX, "990", false),
    );
    expect(actions[2]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: PIREX.PIREX_CVX, amount: "990" },
    });
    expect(actions[3]).toEqual({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.PIREX_CVX,
        method: "deposit",
        abi: DEPOSIT_ABI,
        args: ["990", ENSO_SHORTCUTS, false, ZERO_ADDRESS],
      },
    });
    expect(actions[4]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: PIREX.PXCVX },
    });
    const pxCvxRef = { useOutputOfCallAt: 4 };
    expect(actions[5]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: { token: PIREX.PXCVX, spender: PIREX.LPXCVX, amount: pxCvxRef },
    });
    expect(actions[6]).toEqual({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "wrap",
        abi: WRAP_ABI,
        args: [pxCvxRef],
      },
    });
    expect((actions[6].args.args as unknown[])[0]).toEqual(pxCvxRef);
    expect(actions[7]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: PIREX.LPXCVX },
    });
    expect(actions).toHaveLength(8);

    expect(result.token).toBe(PIREX.LPXCVX);
    expect(result.expectedAmount).toBe(990n);
    expectRefAt(actions, result, 7);

    expect(routeSteps).toHaveLength(1);
    expect(routeSteps[0].action).toBe("Mint");
    expect(routeSteps[0].protocol).toBe("Pirex");
    expect(routeSteps[0].rawAmount).toBe("1000");
    expectDummiesUntouched(actions);
  });

  it("split: swaps the swap leg then mints and wraps the mint leg", async () => {
    useSplit(400n, 590n);
    useSwapRates({ "400": 404n });
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state = fixedState(TOKENS.CVX);

    const result = await convertStateToToken(actions, state, TOKENS.LPXCVX, ctx, routeSteps);

    expect(getOptimalPxCvxSwapAmount).toHaveBeenCalledWith("990");
    expect(rateCalls()).toEqual(["400"]);

    // Swap leg.
    expect(actions[2]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: PIREX.LPXCVX_CVX_POOL, amount: "400" },
    });
    expect(actions[3].args.address).toBe(PIREX.LPXCVX_CVX_POOL);
    expect(actions[3].args.method).toBe("exchange");
    expect((actions[3].args.args as unknown[])[2]).toBe("400");
    expect((actions[3].args.args as unknown[])[3]).toBe(calculateMinDy(404n, 150));

    // Mint leg.
    expect(actions[4]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: PIREX.PIREX_CVX, amount: "590" },
    });
    expect(actions[5].args.address).toBe(PIREX.PIREX_CVX);
    expect(actions[5].args.method).toBe("deposit");
    expect((actions[5].args.args as unknown[])[0]).toBe("590");
    expect((actions[5].args.args as unknown[])[1]).toBe(ENSO_SHORTCUTS);
    expect(actions[6]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: PIREX.PXCVX },
    });
    const pxCvxRef = { useOutputOfCallAt: 6 };
    expect(actions[7]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: { token: PIREX.PXCVX, spender: PIREX.LPXCVX, amount: pxCvxRef },
    });
    expect(actions[8].args.method).toBe("wrap");
    expect((actions[8].args.args as unknown[])[0]).toEqual(pxCvxRef);
    expect(actions[9]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: PIREX.LPXCVX },
    });
    expect(actions).toHaveLength(10);

    expect(result.token).toBe(PIREX.LPXCVX);
    expect(result.expectedAmount).toBe(404n + 590n);
    expectRefAt(actions, result, 9);

    expect(routeSteps).toHaveLength(2);
    expect(routeSteps[0].action).toBe("Swap");
    expect(routeSteps[0].rawAmount).toBe("400");
    expect(routeSteps[1].action).toBe("Mint");
    expect(routeSteps[1].rawAmount).toBe("590");
    expectDummiesUntouched(actions);
  });
});

// Case 14 also holds for the flows above (each asserts expectRefAt and
// expectDummiesUntouched); this repeats the invariant across all three families.
describe("convertStateToToken: returned references", () => {
  it("always point into the bundle and leave the leading actions untouched", async () => {
    useRouteEstimates("4321");
    const routedActions = makeActions();
    const routed = await convertStateToToken(
      routedActions,
      fixedState(OTHER),
      TOKENS.CVX,
      ctx,
      [],
    );
    expect(routed.amountRef).toEqual({ useOutputOfCallAt: routedActions.length - 1 });
    expect(routedActions[routedActions.length - 1].action).toBe("route");
    expectRefAt(routedActions, routed, routedActions.length - 1);
    expectDummiesUntouched(routedActions);

    useCvxQuote(1100n);
    const swapActions = makeActions();
    const swapped = await convertStateToToken(
      swapActions,
      fixedState(TOKENS.PXCVX),
      TOKENS.CVX,
      ctx,
      [],
    );
    expect(swapped.amountRef).toEqual({ useOutputOfCallAt: swapActions.length - 1 });
    expect(swapActions[swapActions.length - 1].args.method).toBe("exchange");
    expectRefAt(swapActions, swapped, swapActions.length - 1);
    expectDummiesUntouched(swapActions);

    const wrapActions = makeActions();
    const wrapped = await convertStateToToken(
      wrapActions,
      fixedState(TOKENS.PXCVX),
      TOKENS.LPXCVX,
      ctx,
      [],
    );
    expect(wrapped.amountRef).toEqual({ useOutputOfCallAt: wrapActions.length - 1 });
    expect(wrapActions[wrapActions.length - 1]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: TOKENS.LPXCVX },
    });
    expectRefAt(wrapActions, wrapped, wrapActions.length - 1);
    expectDummiesUntouched(wrapActions);
  });
});
