// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// This module is part of an import cycle (see the note at the top of
// conversions.ts); importing it after the mocks keeps the cycle resolvable in
// the unit project, same as enso-conversions-usdc-cvx.test.ts.
vi.mock("@/lib/enso/pxcvx-pool", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/enso/pxcvx-pool")>()),
  getOptimalPxCvxSwapAmount: vi.fn(),
  getPxCvxSwapRate: vi.fn(),
  getLpxCvxToCvxSwapRate: vi.fn(),
}));

import { PIREX, TOKENS } from "@/config/vaults";
import { calculateMinDy } from "@/lib/curve";
import { formatRouteAmount, pushCvxToPxCvxSwapActions } from "@/lib/enso/bundle-helpers";
import { ENSO_SHORTCUTS, ZERO_ADDRESS } from "@/lib/enso/constants";
import {
  appendCvxToPxCvxConversion,
  type ConversionContext,
  type ConversionState,
} from "@/lib/enso/conversions";
import { getOptimalPxCvxSwapAmount, getPxCvxSwapRate } from "@/lib/enso/pxcvx-pool";
import type { EnsoBundleAction, RouteStep } from "@/types/enso";

const ctx: ConversionContext = {
  fromAddress: "0x1234567890123456789012345678901234567890",
  slippage: "100",
  slippageBps: 100,
  totalSlippageBps: 150,
};

// Two leading actions so no converted action lands at index 0 or 1.
const DUMMY_ACTIONS = 2;

function makeActions(): EnsoBundleAction[] {
  return [
    { protocol: "enso", action: "balance", args: { token: TOKENS.CVXCRV } },
    { protocol: "enso", action: "balance", args: { token: TOKENS.STKCVXCRV } },
  ];
}

function fixedState(expectedAmount = 1000n): ConversionState {
  return { token: TOKENS.CVX, amountRef: expectedAmount.toString(), expectedAmount };
}

function dynamicState(expectedAmount = 1000n, index = 1): ConversionState {
  return { token: TOKENS.CVX, amountRef: { useOutputOfCallAt: index }, expectedAmount };
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

function expectPxCvxTail(actions: EnsoBundleAction[], result: ConversionState) {
  expect(actions[actions.length - 1]).toEqual({
    protocol: "enso",
    action: "balance",
    args: { token: PIREX.PXCVX },
  });
  expect(result.amountRef).toEqual({ useOutputOfCallAt: actions.length - 1 });
  for (const action of actions) {
    if (action.args.method === "deposit") {
      expect((action.args.args as unknown[])[1]).toBe(ENSO_SHORTCUTS);
    }
  }
}

function depositActions(actions: EnsoBundleAction[]): EnsoBundleAction[] {
  return actions.filter((action) => action.args.method === "deposit");
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("appendCvxToPxCvxConversion", () => {
  it("fixed input, swap only: swaps the fixed amount and reports the swap output", async () => {
    useSplit(990n, 0n);
    useSwapRates({ "990": 1010n });
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];

    const result = await appendCvxToPxCvxConversion(actions, fixedState(), ctx, routeSteps);

    expect(getOptimalPxCvxSwapAmount).toHaveBeenCalledWith("990");

    const expectedSwapActions: EnsoBundleAction[] = [];
    pushCvxToPxCvxSwapActions(expectedSwapActions, PIREX, "990", calculateMinDy(1010n, 150), false);
    expect(actions.slice(DUMMY_ACTIONS, DUMMY_ACTIONS + 2)).toEqual(expectedSwapActions);

    expect(actions[2]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: PIREX.LPXCVX, amount: "990" },
    });
    const swapCall = actions[3];
    expect(swapCall.protocol).toBe("enso");
    expect(swapCall.action).toBe("call");
    expect(swapCall.args.address).toBe(PIREX.LPXCVX);
    expect(swapCall.args.method).toBe("swap");
    const swapArgs = swapCall.args.args as unknown[];
    expect(swapArgs[1]).toBe("990");
    expect(swapArgs[2]).toBe(calculateMinDy(1010n, 150));

    expect(depositActions(actions)).toHaveLength(0);
    expect(actions).toHaveLength(5);

    expect(result.token).toBe(PIREX.PXCVX);
    expect(result.expectedAmount).toBe(1010n);
    expectPxCvxTail(actions, result);

    expect(routeSteps).toHaveLength(1);
    expect(routeSteps[0].action).toBe("Swap");
    expect(routeSteps[0].protocol).toBe("Curve");
    expect(routeSteps[0].rawAmount).toBe("1000");
    expect(routeSteps[0].amount).toBe(formatRouteAmount(1000n, TOKENS.CVX));
    expect(routeSteps[0].bonus).toBeCloseTo((1010 / 990 - 1) * 100, 6);
    expect(routeSteps[0].bonus).toBeGreaterThan(0);
    expect(routeSteps[0].bonusAmount).toBe(formatRouteAmount(20n, TOKENS.PXCVX));
    expect(routeSteps[0].bonusSymbol).toBe("pxCVX");
  });

  it("fixed input, mint only: approves and deposits the fixed amount, never quoting the pool", async () => {
    useSplit(0n, 990n);
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];

    const result = await appendCvxToPxCvxConversion(actions, fixedState(), ctx, routeSteps);

    expect(getPxCvxSwapRate).not.toHaveBeenCalled();
    expect(actions).toHaveLength(5);
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
        abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
        args: ["990", ENSO_SHORTCUTS, false, ZERO_ADDRESS],
      },
    });

    expect(result.token).toBe(PIREX.PXCVX);
    expect(result.expectedAmount).toBe(990n);
    expectPxCvxTail(actions, result);

    expect(routeSteps).toHaveLength(1);
    expect(routeSteps[0].action).toBe("Mint");
    expect(routeSteps[0].protocol).toBe("Pirex");
    expect(routeSteps[0].rawAmount).toBe("1000");
  });

  it("fixed input, split: swap leg uses the swap amount, mint leg the mint amount", async () => {
    useSplit(400n, 590n);
    useSwapRates({ "400": 404n });
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];

    const result = await appendCvxToPxCvxConversion(actions, fixedState(), ctx, routeSteps);

    expect(actions).toHaveLength(7);
    expect((actions[3].args.args as unknown[])[1]).toBe("400");
    expect(actions[4]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: PIREX.PIREX_CVX, amount: "590" },
    });
    const deposit = actions[5];
    expect(deposit.args.address).toBe(PIREX.PIREX_CVX);
    expect(deposit.args.method).toBe("deposit");
    expect((deposit.args.args as unknown[])[0]).toBe("590");
    // No runtime balance read between the legs for a fixed amount.
    expect(
      actions.filter((action) => action.action === "balance" && action.args.token === TOKENS.CVX),
    ).toHaveLength(0);
    expect(rateCalls()).toEqual(["400"]);

    expect(result.expectedAmount).toBe(404n + 590n);
    expectPxCvxTail(actions, result);

    expect(routeSteps).toHaveLength(2);
    expect(routeSteps[0].action).toBe("Swap");
    expect(routeSteps[0].rawAmount).toBe("400");
    expect(routeSteps[0].bonus).toBeCloseTo((404 / 400 - 1) * 100, 6);
    expect(routeSteps[1].action).toBe("Mint");
    expect(routeSteps[1].rawAmount).toBe("590");
  });

  it("dynamic input, swap only: spends the runtime reference and reports the full-amount rate", async () => {
    useSplit(990n, 0n);
    useSwapRates({ "990": 1010n, "1000": 1020n });
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state = dynamicState();

    const result = await appendCvxToPxCvxConversion(actions, state, ctx, routeSteps);

    expect(getOptimalPxCvxSwapAmount).toHaveBeenCalledWith("990");
    expect(actions[2]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: PIREX.LPXCVX, amount: state.amountRef },
    });
    const swapArgs = actions[3].args.args as unknown[];
    expect(swapArgs[1]).toBe(state.amountRef);
    expect(swapArgs[1]).not.toBe("990");

    expect(rateCalls()).toEqual(["990", "1000"]);
    expect(result.expectedAmount).toBe(1020n);
    expectPxCvxTail(actions, result);

    expect(routeSteps).toHaveLength(1);
    expect(routeSteps[0].action).toBe("Swap");
  });

  it("dynamic input, swap only: falls back to the swap-amount output when the full-amount rate is zero", async () => {
    useSplit(990n, 0n);
    useSwapRates({ "990": 1010n, "1000": 0n });
    const actions = makeActions();

    const result = await appendCvxToPxCvxConversion(actions, dynamicState(), ctx, []);

    expect(rateCalls()).toEqual(["990", "1000"]);
    expect(result.expectedAmount).toBe(1010n);
    expectPxCvxTail(actions, result);
  });

  it("dynamic input, mint only: deposits the runtime reference and reports the state's expected amount", async () => {
    useSplit(0n, 990n);
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];
    const state = dynamicState();

    const result = await appendCvxToPxCvxConversion(actions, state, ctx, routeSteps);

    expect(getPxCvxSwapRate).not.toHaveBeenCalled();
    expect(actions[2]).toEqual({
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: PIREX.PIREX_CVX, amount: state.amountRef },
    });
    const deposit = actions[3];
    expect(deposit.args.method).toBe("deposit");
    expect((deposit.args.args as unknown[])[0]).toBe(state.amountRef);

    expect(result.expectedAmount).toBe(1000n);
    expectPxCvxTail(actions, result);

    expect(routeSteps).toHaveLength(1);
    expect(routeSteps[0].action).toBe("Mint");
  });

  it("dynamic input, split: mints whatever CVX the raw-call swap leg left", async () => {
    useSplit(400n, 590n);
    useSwapRates({ "400": 404n });
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];

    const result = await appendCvxToPxCvxConversion(actions, dynamicState(), ctx, routeSteps);

    const expectedSwapActions: EnsoBundleAction[] = [];
    pushCvxToPxCvxSwapActions(
      expectedSwapActions,
      PIREX,
      "400",
      calculateMinDy(404n, 150),
      true,
    );
    expect(actions.slice(DUMMY_ACTIONS, DUMMY_ACTIONS + 2)).toEqual(expectedSwapActions);
    expect(actions[2]).toEqual({
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX,
        method: "approve",
        abi: "function approve(address spender, uint256 amount) returns (bool)",
        args: [PIREX.LPXCVX, "400"],
      },
    });

    // The remaining-CVX balance read lands right after the swap actions.
    expect(actions[4]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: TOKENS.CVX },
    });
    const remainingRef = { useOutputOfCallAt: 4 };
    expect(actions[5]).toEqual({
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX,
        method: "approve",
        abi: "function approve(address spender, uint256 amount) returns (bool)",
        args: [PIREX.PIREX_CVX, remainingRef],
      },
    });
    const depositArgs = actions[6].args.args as unknown[];
    expect(actions[6].args.method).toBe("deposit");
    expect(depositArgs[0]).toEqual(remainingRef);
    expect(depositArgs[1]).toBe(ENSO_SHORTCUTS);

    expect(rateCalls()).toEqual(["400"]);
    expect(result.expectedAmount).toBe(404n + (1000n - 400n));
    expectPxCvxTail(actions, result);

    expect(routeSteps).toHaveLength(2);
    expect(routeSteps[0].action).toBe("Swap");
    expect(routeSteps[0].rawAmount).toBe("400");
    expect(routeSteps[1].action).toBe("Mint");
    expect(routeSteps[1].rawAmount).toBe("590");
  });

  it("dynamic input, split larger than the expected amount: the remainder clamps to zero", async () => {
    useSplit(1200n, 5n);
    useSwapRates({ "1200": 1212n });
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];

    const result = await appendCvxToPxCvxConversion(actions, dynamicState(), ctx, routeSteps);

    expect(rateCalls()).toEqual(["1200"]);
    expect(result.expectedAmount).toBe(1212n);
    expectPxCvxTail(actions, result);

    expect(routeSteps).toHaveLength(2);
    expect(routeSteps[0].rawAmount).toBe("1200");
    expect(routeSteps[1].rawAmount).toBe("5");
  });

  it("rejects when the swap rate comes back null, before appending anything", async () => {
    useSplit(990n, 0n);
    vi.mocked(getPxCvxSwapRate).mockResolvedValue(null as unknown as bigint);
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];

    await expect(
      appendCvxToPxCvxConversion(actions, fixedState(), ctx, routeSteps),
    ).rejects.toThrow("Failed to estimate Curve CVX→lpxCVX swap output");

    expect(actions).toHaveLength(DUMMY_ACTIONS);
    expect(routeSteps).toHaveLength(0);
  });

  it("rejects when the swap rate comes back zero, before appending anything", async () => {
    useSplit(990n, 0n);
    useSwapRates({ "990": 0n });
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];

    await expect(
      appendCvxToPxCvxConversion(actions, dynamicState(), ctx, routeSteps),
    ).rejects.toThrow("Failed to estimate Curve CVX→lpxCVX swap output");

    expect(actions).toHaveLength(DUMMY_ACTIONS);
    expect(routeSteps).toHaveLength(0);
  });

  it("swap below parity: no bonus on the Swap step", async () => {
    useSplit(990n, 0n);
    useSwapRates({ "990": 980n });
    const actions = makeActions();
    const routeSteps: RouteStep[] = [];

    const result = await appendCvxToPxCvxConversion(actions, fixedState(), ctx, routeSteps);

    expect(result.expectedAmount).toBe(980n);
    expectPxCvxTail(actions, result);

    expect(routeSteps).toHaveLength(1);
    expect(routeSteps[0].action).toBe("Swap");
    expect(routeSteps[0].bonus).toBe(0);
    expect(routeSteps[0].bonusAmount).toBeUndefined();
  });
});
