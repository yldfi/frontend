// This module is part of an import cycle with the other two of
// conversions.ts, external-vault-zap-in.ts and external-vault-routes.ts.
// Keep it free of top-level initialisers (const/let/class that read an
// import): only imports and function declarations are safe here.
import type { EnsoBundleAction, RouteStep } from "@/types/enso";
import {
  CRVUSD_ADDRESS,
  CURVE_CVX_ETH_POOL,
  USDC_ADDRESS,
  WETH_ADDRESS,
  YVUSDC1_ADDRESS,
} from "@/config/addresses";
import { TOKENS } from "@/config/vaults";
import {
  calculateMinDy,
  getCurveGetDy,
  getCurveGetDyFactory,
  previewRedeem,
} from "@/lib/curve";
import {
  DYNAMIC_INPUT_SAFE_ENSO_AGGREGATORS,
  estimateRouteOutput,
  fetchQuote,
  getDynamicInputAggregatorPolicy,
  rpcWithFallback,
} from "./api";
import {
  CURVE_ROUTER,
  CURVE_TRICRV_POOL,
  CURVE_USDC_CRVUSD_POOL,
  applySlippageBuffer,
  createRouteStep,
  formatRouteAmount,
  intermediateApproveAction,
  isDynamicAmountRef,
  pushCvxToPxCvxSwapActions,
  rawCallConsumingInput,
  remainingCvxForMint,
  type BundleAmountRef,
} from "./bundle-helpers";
import { ENSO_SHORTCUTS, ZERO_ADDRESS } from "./constants";
import {
  getLpxCvxToCvxSwapRate,
  getOptimalPxCvxSwapAmount,
  getPxCvxSwapRate,
} from "./pxcvx-pool";
import { getTokenSymbol, isLpxCvxAddress, isPxCvxAddress } from "./tokens";
import { previewBeefyWithdraw, previewUCrvWithdraw } from "./external-vault-zap-in";

export interface ConversionState {
  token: string;
  amountRef: BundleAmountRef;
  expectedAmount: bigint;
}

export interface ConversionContext {
  fromAddress: string;
  slippage?: string;
  slippageBps: number;
  totalSlippageBps: number;
}

export function toBalanceState(
  actions: EnsoBundleAction[],
  token: string,
  expectedAmount: bigint,
): ConversionState {
  actions.push({
    protocol: "enso",
    action: "balance",
    args: { token },
  });

  return {
    token,
    amountRef: { useOutputOfCallAt: actions.length - 1 },
    expectedAmount,
  };
}

export async function appendCvxToPxCvxConversion(
  actions: EnsoBundleAction[],
  state: ConversionState,
  ctx: ConversionContext,
  routeSteps: RouteStep[],
): Promise<ConversionState> {
  const { PIREX } = await import("@/config/vaults");
  const conservativeCvxAmount = applySlippageBuffer(state.expectedAmount, ctx.slippageBps);
  const cvxIsDynamic = isDynamicAmountRef(state.amountRef);
  const { swapAmount, mintAmount } = await getOptimalPxCvxSwapAmount(conservativeCvxAmount);
  const usesFixedDynamicSplit = cvxIsDynamic && swapAmount > 0n && mintAmount > 0n;

  let expectedSwapPxCvx = 0n;
  let swapMinDy = "0";
  if (swapAmount > 0n) {
    const swapOutput = await getPxCvxSwapRate(swapAmount.toString());
    if (!swapOutput || swapOutput === 0n) {
      throw new Error("Failed to estimate Curve CVX→lpxCVX swap output");
    }
    expectedSwapPxCvx = swapOutput;
    swapMinDy = calculateMinDy(swapOutput, ctx.totalSlippageBps);
  }

  const swapCvxInput: BundleAmountRef =
    cvxIsDynamic && !usesFixedDynamicSplit ? state.amountRef : swapAmount.toString();
  const mintCvxInput: BundleAmountRef =
    cvxIsDynamic && !usesFixedDynamicSplit ? state.amountRef : mintAmount.toString();

  if (swapAmount > 0n) {
    pushCvxToPxCvxSwapActions(
      actions,
      PIREX,
      swapCvxInput,
      swapMinDy,
      usesFixedDynamicSplit,
    );
  }

  if (mintAmount > 0n) {
    const mintInput = usesFixedDynamicSplit ? remainingCvxForMint(actions) : mintCvxInput;
    actions.push(
      intermediateApproveAction(TOKENS.CVX, PIREX.PIREX_CVX, mintInput, usesFixedDynamicSplit),
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.PIREX_CVX,
          method: "deposit",
          abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
          args: [
            mintInput,
            ENSO_SHORTCUTS,
            false,
            ZERO_ADDRESS,
          ],
        },
      },
    );
  }

  let swapBonus = 0;
  let bonusAmount: string | undefined;
  if (swapAmount > 0n && expectedSwapPxCvx > swapAmount) {
    swapBonus = (Number(expectedSwapPxCvx) / Number(swapAmount) - 1) * 100;
    bonusAmount = formatRouteAmount(expectedSwapPxCvx - swapAmount, TOKENS.PXCVX);
  }

  if (swapAmount > 0n && mintAmount > 0n) {
    routeSteps.push(
      createRouteStep({
        tokenAddress: TOKENS.CVX,
        amount: swapAmount,
        action: "Swap",
        description: "CVX for pxCVX",
        protocol: "Curve",
        bonus: swapBonus,
        bonusAmount,
        bonusSymbol: "pxCVX",
      }),
      createRouteStep({
        tokenAddress: TOKENS.CVX,
        amount: mintAmount,
        action: "Mint",
        description: "pxCVX with CVX (1:1)",
        protocol: "Pirex",
      }),
    );
  } else if (swapAmount > 0n) {
    routeSteps.push(createRouteStep({
      tokenAddress: TOKENS.CVX,
      amount: state.expectedAmount,
      action: "Swap",
      description: "CVX for pxCVX",
      protocol: "Curve",
      bonus: swapBonus,
      bonusAmount,
      bonusSymbol: "pxCVX",
    }));
  } else {
    routeSteps.push(createRouteStep({
      tokenAddress: TOKENS.CVX,
      amount: state.expectedAmount,
      action: "Mint",
      description: "pxCVX with CVX (1:1)",
      protocol: "Pirex",
    }));
  }

  // Report the output of what the bundle actually spends. The split is sized from a
  // slippage-buffered CVX estimate, but runtime legs use the whole balance: shown output (and
  // the intent guard's minimum, derived from it) would otherwise sit a full buffer low.
  let expectedPxCvxOut = expectedSwapPxCvx + mintAmount;
  if (cvxIsDynamic) {
    if (usesFixedDynamicSplit) {
      const remainingCvx = state.expectedAmount > swapAmount ? state.expectedAmount - swapAmount : 0n;
      expectedPxCvxOut = expectedSwapPxCvx + remainingCvx;
    } else if (swapAmount > 0n) {
      expectedPxCvxOut = (await getPxCvxSwapRate(state.expectedAmount.toString())) || expectedSwapPxCvx;
    } else {
      expectedPxCvxOut = state.expectedAmount;
    }
  }

  return toBalanceState(
    actions,
    PIREX.PXCVX,
    expectedPxCvxOut,
  );
}

async function appendCvxToLpxCvxConversion(
  actions: EnsoBundleAction[],
  state: ConversionState,
  ctx: ConversionContext,
  routeSteps: RouteStep[],
): Promise<ConversionState> {
  const { PIREX } = await import("@/config/vaults");
  const conservativeCvxAmount = applySlippageBuffer(state.expectedAmount, ctx.slippageBps);
  const cvxIsDynamic = isDynamicAmountRef(state.amountRef);
  const { swapAmount, mintAmount } = await getOptimalPxCvxSwapAmount(conservativeCvxAmount);
  const usesFixedDynamicSplit = cvxIsDynamic && swapAmount > 0n && mintAmount > 0n;

  let expectedSwapLpxCvx = 0n;
  let swapMinDy = "0";
  if (swapAmount > 0n) {
    const swapOutput = await getPxCvxSwapRate(swapAmount.toString());
    if (!swapOutput || swapOutput === 0n) {
      throw new Error("Failed to estimate Curve CVX→lpxCVX swap output");
    }
    expectedSwapLpxCvx = swapOutput;
    swapMinDy = calculateMinDy(swapOutput, ctx.totalSlippageBps);
  }

  const swapCvxInput: BundleAmountRef =
    cvxIsDynamic && !usesFixedDynamicSplit ? state.amountRef : swapAmount.toString();
  const mintCvxInput: BundleAmountRef =
    cvxIsDynamic && !usesFixedDynamicSplit ? state.amountRef : mintAmount.toString();

  if (swapAmount > 0n) {
    actions.push(
      intermediateApproveAction(TOKENS.CVX, PIREX.LPXCVX_CVX_POOL, swapCvxInput, usesFixedDynamicSplit),
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX_CVX_POOL,
          method: "exchange",
          abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
          args: [
            String(PIREX.POOL_INDEX.CVX),
            String(PIREX.POOL_INDEX.LPXCVX),
            swapCvxInput,
            swapMinDy,
          ],
        },
      },
    );
  }

  if (mintAmount > 0n) {
    const mintInput = usesFixedDynamicSplit ? remainingCvxForMint(actions) : mintCvxInput;
    actions.push(
      intermediateApproveAction(TOKENS.CVX, PIREX.PIREX_CVX, mintInput, usesFixedDynamicSplit),
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.PIREX_CVX,
          method: "deposit",
          abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
          args: [
            mintInput,
            ENSO_SHORTCUTS,
            false,
            ZERO_ADDRESS,
          ],
        },
      },
    );

    actions.push({
      protocol: "enso",
      action: "balance",
      args: { token: PIREX.PXCVX },
    });
    const pxCvxAmountRef: BundleAmountRef = { useOutputOfCallAt: actions.length - 1 };

    actions.push(
      intermediateApproveAction(PIREX.PXCVX, PIREX.LPXCVX, pxCvxAmountRef, usesFixedDynamicSplit),
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX,
          method: "wrap",
          abi: "function wrap(uint256 amount)",
          args: [pxCvxAmountRef],
        },
      },
    );
  }

  let swapBonus = 0;
  let bonusAmount: string | undefined;
  if (swapAmount > 0n && expectedSwapLpxCvx > swapAmount) {
    swapBonus = (Number(expectedSwapLpxCvx) / Number(swapAmount) - 1) * 100;
    bonusAmount = formatRouteAmount(expectedSwapLpxCvx - swapAmount, TOKENS.LPXCVX);
  }

  if (swapAmount > 0n && mintAmount > 0n) {
    routeSteps.push(
      createRouteStep({
        tokenAddress: TOKENS.CVX,
        amount: swapAmount,
        action: "Swap",
        description: "CVX for lpxCVX via Curve pool",
        protocol: "Curve",
        bonus: swapBonus,
        bonusAmount,
        bonusSymbol: "lpxCVX",
      }),
      createRouteStep({
        tokenAddress: TOKENS.CVX,
        amount: mintAmount,
        action: "Mint",
        description: "pxCVX with CVX (1:1), then wrap",
        protocol: "Pirex",
      }),
    );
  } else if (swapAmount > 0n) {
    routeSteps.push(createRouteStep({
      tokenAddress: TOKENS.CVX,
      amount: state.expectedAmount,
      action: "Swap",
      description: "CVX for lpxCVX via Curve pool",
      protocol: "Curve",
      bonus: swapBonus,
      bonusAmount,
      bonusSymbol: "lpxCVX",
    }));
  } else {
    routeSteps.push(createRouteStep({
      tokenAddress: TOKENS.CVX,
      amount: state.expectedAmount,
      action: "Mint",
      description: "pxCVX with CVX (1:1), then wrap",
      protocol: "Pirex",
    }));
  }

  // Output of what the bundle actually spends (see appendCvxToPxCvxConversion).
  let expectedOut = expectedSwapLpxCvx + mintAmount;
  if (cvxIsDynamic) {
    if (usesFixedDynamicSplit) {
      expectedOut = expectedSwapLpxCvx + (state.expectedAmount > swapAmount ? state.expectedAmount - swapAmount : 0n);
    } else if (swapAmount > 0n) {
      expectedOut = (await getPxCvxSwapRate(state.expectedAmount.toString())) || expectedSwapLpxCvx;
    } else {
      expectedOut = state.expectedAmount;
    }
  }

  return toBalanceState(
    actions,
    PIREX.LPXCVX,
    expectedOut,
  );
}

async function appendRouteConversion(
  actions: EnsoBundleAction[],
  state: ConversionState,
  targetToken: string,
  ctx: ConversionContext,
  routeSteps: RouteStep[],
): Promise<ConversionState> {
  const expectedAmount = BigInt(
    await estimateRouteOutput(
      ctx.fromAddress,
      state.token,
      targetToken,
      state.expectedAmount.toString(),
      ctx.slippage,
    ),
  );

  actions.push({
    protocol: "enso",
    action: "route",
    args: {
      tokenIn: state.token,
      tokenOut: targetToken,
      amountIn: state.amountRef,
      slippage: ctx.slippage ?? "100",
    },
  });

  routeSteps.push(createRouteStep({
    tokenAddress: state.token,
    amount: state.expectedAmount,
    action: "Swap",
    description: `${getTokenSymbol(state.token)} for ${getTokenSymbol(targetToken)}`,
    protocol: "Enso",
  }));

  return {
    token: targetToken,
    amountRef: { useOutputOfCallAt: actions.length - 1 },
    expectedAmount,
  };
}

interface CurveUsdcToCvxQuote {
  expectedCrvUsd: bigint;
  expectedWeth: bigint;
  expectedCvx: bigint;
}

async function quoteCurveUsdcToCvx(expectedUsdc: bigint): Promise<CurveUsdcToCvxQuote> {
  const expectedCrvUsd = await getCurveGetDy(
    CURVE_USDC_CRVUSD_POOL,
    0,
    1,
    expectedUsdc.toString(),
  );
  if (!expectedCrvUsd || expectedCrvUsd === 0n) {
    throw new Error("Failed to estimate Curve USDC→crvUSD output");
  }

  const expectedWeth = await getCurveGetDyFactory(
    CURVE_TRICRV_POOL,
    0,
    1,
    expectedCrvUsd.toString(),
  );
  if (!expectedWeth || expectedWeth === 0n) {
    throw new Error("Failed to estimate Curve crvUSD→WETH output");
  }

  const expectedCvx = await getCurveGetDyFactory(
    CURVE_CVX_ETH_POOL,
    0,
    1,
    expectedWeth.toString(),
  );
  if (!expectedCvx || expectedCvx === 0n) {
    throw new Error("Failed to estimate Curve WETH→CVX output");
  }

  return { expectedCrvUsd, expectedWeth, expectedCvx };
}

async function appendCurveUsdcToCvxConversion(
  actions: EnsoBundleAction[],
  amountRef: BundleAmountRef,
  expectedUsdc: bigint,
  ctx: ConversionContext,
  routeSteps: RouteStep[],
  quote?: CurveUsdcToCvxQuote,
): Promise<ConversionState> {
  const { expectedCvx } = quote ?? await quoteCurveUsdcToCvx(expectedUsdc);

  const minCvx = calculateMinDy(expectedCvx, ctx.totalSlippageBps);
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  actions.push(
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: USDC_ADDRESS.toLowerCase(),
        spender: CURVE_ROUTER,
        amount: amountRef,
      },
    },
    {
      protocol: "enso",
      action: "call",
      args: {
        address: CURVE_ROUTER,
        method: "exchange_multiple",
        abi: "function exchange_multiple(address[9] _route, uint256[3][4] _swap_params, uint256 _amount, uint256 _expected, address[4] _pools, address _receiver) payable returns (uint256)",
        args: [
          [
            USDC_ADDRESS,
            CURVE_USDC_CRVUSD_POOL,
            CRVUSD_ADDRESS,
            CURVE_TRICRV_POOL,
            WETH_ADDRESS,
            CURVE_CVX_ETH_POOL,
            TOKENS.CVX,
            zeroAddress,
            zeroAddress,
          ],
          [
            [0, 1, 1],
            [0, 1, 3],
            [0, 1, 3],
            [0, 0, 0],
          ],
          amountRef,
          minCvx,
          [zeroAddress, zeroAddress, zeroAddress, zeroAddress],
          ENSO_SHORTCUTS,
        ],
      },
    },
  );

  routeSteps.push(createRouteStep({
    tokenAddress: USDC_ADDRESS,
    amount: expectedUsdc,
    action: "Swap",
    description: "USDC for CVX",
    protocol: "Curve",
  }));

  return {
    token: TOKENS.CVX,
    amountRef: { useOutputOfCallAt: actions.length - 1 },
    expectedAmount: expectedCvx,
  };
}

export async function appendBestExactUsdcToCvxConversion(
  actions: EnsoBundleAction[],
  amountRef: BundleAmountRef,
  expectedUsdc: bigint,
  ctx: ConversionContext,
  routeSteps: RouteStep[],
): Promise<ConversionState> {
  const curveQuotePromise = quoteCurveUsdcToCvx(expectedUsdc).catch(() => null);
  const ensoQuotePromise = (async () => {
    try {
      const { availableSafeAggregators, ignoreAggregators } =
        await getDynamicInputAggregatorPolicy();
      if (availableSafeAggregators.length === 0) return null;
      const route = await fetchQuote({
        fromAddress: ctx.fromAddress,
        tokenIn: USDC_ADDRESS,
        tokenOut: TOKENS.CVX,
        amountIn: expectedUsdc.toString(),
        ignoreAggregators,
      });
      const usedSafeAggregator = route.route.find((hop) =>
        DYNAMIC_INPUT_SAFE_ENSO_AGGREGATORS.has(hop.protocol.toLowerCase())
      );
      if (!usedSafeAggregator) return null;

      return {
        expectedCvx: BigInt(route.amountOut),
        ignoreAggregators,
        protocol: usedSafeAggregator.protocol,
      };
    } catch {
      return null;
    }
  })();

  const [curveQuote, ensoQuote] = await Promise.all([curveQuotePromise, ensoQuotePromise]);
  if (ensoQuote && (!curveQuote || ensoQuote.expectedCvx > curveQuote.expectedCvx)) {
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: USDC_ADDRESS,
        tokenOut: TOKENS.CVX,
        amountIn: amountRef,
        slippage: ctx.slippage ?? "100",
        ignoreAggregators: ensoQuote.ignoreAggregators,
      },
    });
    const protocol = ensoQuote.protocol === "grapher" ? "Grapher" : ensoQuote.protocol;
    routeSteps.push(createRouteStep({
      tokenAddress: USDC_ADDRESS,
      amount: expectedUsdc,
      action: "Swap",
      description: "USDC for CVX",
      protocol,
    }));
    return {
      token: TOKENS.CVX,
      amountRef: { useOutputOfCallAt: actions.length - 1 },
      expectedAmount: ensoQuote.expectedCvx,
    };
  }

  if (!curveQuote) {
    throw new Error("No exact-amount-safe USDC→CVX route is currently available");
  }

  return appendCurveUsdcToCvxConversion(
    actions,
    amountRef,
    expectedUsdc,
    ctx,
    routeSteps,
    curveQuote,
  );
}

async function appendConversionToCvx(
  actions: EnsoBundleAction[],
  state: ConversionState,
  ctx: ConversionContext,
  routeSteps: RouteStep[],
): Promise<ConversionState> {
  const sourceToken = state.token.toLowerCase();

  if (sourceToken === TOKENS.CVX.toLowerCase()) {
    return state;
  }

  if (isPxCvxAddress(state.token)) {
    const { PIREX } = await import("@/config/vaults");
    // The legs spend the runtime balance (state.amountRef), so quote the unbuffered amount.
    const expectedCvx = await getLpxCvxToCvxSwapRate(state.expectedAmount.toString());
    if (!expectedCvx || expectedCvx === 0n) {
      throw new Error("Failed to estimate Curve lpxCVX→CVX swap output");
    }
    const minDy = calculateMinDy(expectedCvx, ctx.totalSlippageBps);

    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.PXCVX,
          spender: PIREX.LPXCVX,
          amount: state.amountRef,
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX,
          method: "wrap",
          abi: "function wrap(uint256 amount)",
          args: [state.amountRef],
        },
      },
      // lpxCVX comes from the void wrap(); a fixed erc20 approval would make Enso pull it from the wallet
      intermediateApproveAction(PIREX.LPXCVX, PIREX.LPXCVX_CVX_POOL, state.amountRef, !isDynamicAmountRef(state.amountRef)),
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX_CVX_POOL,
          method: "exchange",
          abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
          args: [
            String(PIREX.POOL_INDEX.LPXCVX),
            String(PIREX.POOL_INDEX.CVX),
            state.amountRef,
            minDy,
          ],
        },
      },
    );

    routeSteps.push(
      createRouteStep({
        tokenAddress: TOKENS.PXCVX,
        amount: state.expectedAmount,
        action: "Wrap",
        description: "pxCVX to lpxCVX (1:1)",
        protocol: "Pirex",
      }),
      createRouteStep({
        tokenAddress: PIREX.LPXCVX,
        amount: state.expectedAmount,
        action: "Swap",
        description: "lpxCVX for CVX via Curve",
        protocol: "Curve",
      }),
    );

    return {
      token: TOKENS.CVX,
      amountRef: { useOutputOfCallAt: actions.length - 1 },
      expectedAmount: expectedCvx,
    };
  }

  if (isLpxCvxAddress(state.token)) {
    const { PIREX } = await import("@/config/vaults");
    const expectedCvx = await getLpxCvxToCvxSwapRate(state.expectedAmount.toString());
    if (!expectedCvx || expectedCvx === 0n) {
      throw new Error("Failed to estimate Curve lpxCVX→CVX swap output");
    }
    const minDy = calculateMinDy(expectedCvx, ctx.totalSlippageBps);

    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.LPXCVX,
          spender: PIREX.LPXCVX_CVX_POOL,
          amount: state.amountRef,
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX_CVX_POOL,
          method: "exchange",
          abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
          args: [
            String(PIREX.POOL_INDEX.LPXCVX),
            String(PIREX.POOL_INDEX.CVX),
            state.amountRef,
            minDy,
          ],
        },
      },
    );

    routeSteps.push(createRouteStep({
      tokenAddress: TOKENS.LPXCVX,
      amount: state.expectedAmount,
      action: "Swap",
      description: "lpxCVX for CVX via Curve",
      protocol: "Curve",
    }));

    return {
      token: TOKENS.CVX,
      amountRef: { useOutputOfCallAt: actions.length - 1 },
      expectedAmount: expectedCvx,
    };
  }

  return appendRouteConversion(actions, state, TOKENS.CVX, ctx, routeSteps);
}

export async function convertStateToToken(
  actions: EnsoBundleAction[],
  state: ConversionState,
  targetToken: string,
  ctx: ConversionContext,
  routeSteps: RouteStep[],
): Promise<ConversionState> {
  if (state.token.toLowerCase() === targetToken.toLowerCase()) {
    return state;
  }

  if (isPxCvxAddress(targetToken)) {
    if (isLpxCvxAddress(state.token)) {
      // Unwrap lpxCVX → pxCVX (1:1). A fixed amount is the wallet input, so declare it on the raw
      // call; relabelling the amount as pxCVX made Enso pull pxCVX from the wallet instead.
      const { PIREX } = await import("@/config/vaults");
      // unwrap() returns nothing, so read the produced pxCVX with a balance action.
      actions.push(rawCallConsumingInput(state.amountRef, TOKENS.LPXCVX, {
        address: PIREX.LPXCVX,
        method: "unwrap",
        abi: "function unwrap(uint256 amount)",
        args: [state.amountRef],
      }));
      return toBalanceState(actions, TOKENS.PXCVX, state.expectedAmount);
    }
    const cvxState =
      state.token.toLowerCase() === TOKENS.CVX.toLowerCase()
        ? state
        : await appendConversionToCvx(actions, state, ctx, routeSteps);
    return appendCvxToPxCvxConversion(actions, cvxState, ctx, routeSteps);
  }

  if (isLpxCvxAddress(targetToken)) {
    if (isPxCvxAddress(state.token)) {
      const { PIREX } = await import("@/config/vaults");
      actions.push(
        {
          protocol: "erc20",
          action: "approve",
          args: {
            token: TOKENS.PXCVX,
            spender: PIREX.LPXCVX,
            amount: state.amountRef,
          },
        },
        {
          protocol: "enso",
          action: "call",
          args: {
            address: PIREX.LPXCVX,
            method: "wrap",
            abi: "function wrap(uint256 amount)",
            args: [state.amountRef],
          },
        },
      );

      routeSteps.push(createRouteStep({
        tokenAddress: TOKENS.PXCVX,
        amount: state.expectedAmount,
        action: "Wrap",
        description: "pxCVX to lpxCVX (1:1)",
        protocol: "Pirex",
      }));

      // wrap() returns nothing. Carrying the fixed pxCVX amount on as lpxCVX made Enso treat lpxCVX
      // as a second wallet input; read the wrapped balance instead.
      return toBalanceState(actions, TOKENS.LPXCVX, state.expectedAmount);
    }
    const cvxState =
      state.token.toLowerCase() === TOKENS.CVX.toLowerCase()
        ? state
        : await appendConversionToCvx(actions, state, ctx, routeSteps);
    return appendCvxToLpxCvxConversion(actions, cvxState, ctx, routeSteps);
  }

  if (isPxCvxAddress(state.token) || isLpxCvxAddress(state.token)) {
    const cvxState = await appendConversionToCvx(actions, state, ctx, routeSteps);
    if (targetToken.toLowerCase() === TOKENS.CVX.toLowerCase()) {
      return cvxState;
    }
    return appendRouteConversion(actions, cvxState, targetToken, ctx, routeSteps);
  }

  return appendRouteConversion(actions, state, targetToken, ctx, routeSteps);
}

export async function buildInitialConversionState(params: {
  inputToken: string;
  amountIn: string;
  targetToken: string;
  ctx: ConversionContext;
}): Promise<{ actions: EnsoBundleAction[]; state: ConversionState; steps: RouteStep[] }> {
  const actions: EnsoBundleAction[] = [];
  const steps: RouteStep[] = [];
  const { getExternalVaultConfig, isExternalVaultToken, LLAMA_AIRFORCE } = await import("@/config/vaults");

  if (!isExternalVaultToken(params.inputToken)) {
    return {
      actions,
      steps,
      state: {
        token: params.inputToken,
        amountRef: params.amountIn,
        expectedAmount: BigInt(params.amountIn),
      },
    };
  }

  const config = getExternalVaultConfig(params.inputToken);
  if (!config) {
    throw new Error(`Unknown external vault: ${params.inputToken}`);
  }

  if (config.interface === "ucrv") {
    const expectedUnderlying = await previewUCrvWithdraw(params.amountIn);
    steps.push(createRouteStep({
      tokenAddress: config.address,
      tokenSymbol: config.symbol,
      amount: params.amountIn,
      action: "Withdraw",
      description: `${config.symbol} for ${config.underlyingSymbol}`,
      protocol: config.protocol,
    }));
    actions.push(rawCallConsumingInput(params.amountIn, config.address, {
      address: config.address,
      method: "withdraw",
      abi: "function withdraw(address _to, uint256 _shares) returns (uint256)",
      args: [ENSO_SHORTCUTS, params.amountIn],
    }));

    return {
      actions,
      steps,
      state: {
        token: LLAMA_AIRFORCE.UCRV_UNDERLYING,
        amountRef: { useOutputOfCallAt: 0 },
        expectedAmount: BigInt(expectedUnderlying),
      },
    };
  }

  if (config.interface === "beefy") {
    const expectedUnderlying = await previewBeefyWithdraw(config.address, params.amountIn);
    steps.push(createRouteStep({
      tokenAddress: config.address,
      tokenSymbol: config.symbol,
      amount: params.amountIn,
      action: "Withdraw",
      description: `${config.symbol} for ${config.underlyingSymbol}`,
      protocol: config.protocol,
    }));
    actions.push(
      rawCallConsumingInput(params.amountIn, config.address, {
        address: config.address,
        method: "withdraw",
        abi: "function withdraw(uint256 _shares)",
        args: [params.amountIn],
      }),
      {
        protocol: "enso",
        action: "balance",
        args: {
          token: config.underlying,
        },
      },
    );

    return {
      actions,
      steps,
      state: {
        token: config.underlying,
        amountRef: { useOutputOfCallAt: 1 },
        expectedAmount: BigInt(expectedUnderlying),
      },
    };
  }

  const expectedUnderlying = await previewRedeem(config.address, params.amountIn);
  steps.push(createRouteStep({
    tokenAddress: config.address,
    tokenSymbol: config.symbol,
    amount: params.amountIn,
    action: "Redeem",
    description: `${config.symbol} for ${config.underlyingSymbol}`,
    protocol: config.protocol,
  }));
  const routeTarget =
    isPxCvxAddress(params.targetToken) || isLpxCvxAddress(params.targetToken)
      ? TOKENS.CVX
      : params.targetToken;

  actions.push({
    protocol: "erc4626",
    action: "redeem",
    args: {
      tokenIn: config.address,
      tokenOut: config.underlying,
      amountIn: params.amountIn,
      primaryAddress: config.address,
    },
  });

  if (
    config.address.toLowerCase() === YVUSDC1_ADDRESS.toLowerCase() &&
    routeTarget.toLowerCase() === TOKENS.CVX.toLowerCase()
  ) {
    const state = await appendBestExactUsdcToCvxConversion(
      actions,
      { useOutputOfCallAt: 0 },
      BigInt(expectedUnderlying),
      params.ctx,
      steps,
    );
    return { actions, steps, state };
  }

  return {
    actions,
    steps,
    state: {
      token: config.underlying,
      amountRef: { useOutputOfCallAt: 0 },
      expectedAmount: BigInt(expectedUnderlying),
    },
  };
}

export async function estimateExternalVaultShares(params: {
  vaultAddress: string;
  vaultInterface: "erc4626" | "ucrv" | "beefy";
  underlyingAmount: bigint;
}): Promise<string> {
  if (params.underlyingAmount === 0n) return "0";

  if (params.vaultInterface === "erc4626") {
    const selector = "0xef8b30f7"; // previewDeposit(uint256)
    const data =
      selector + params.underlyingAmount.toString(16).padStart(64, "0");
    const res = await rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: params.vaultAddress, data }, "latest"],
    });
    if (res.result && res.result !== "0x") {
      return BigInt(res.result).toString();
    }
    throw new Error("Failed to estimate external vault shares: previewDeposit returned no result");
  }

  if (params.vaultInterface === "beefy") {
    const res = await rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: params.vaultAddress, data: "0x77c7b8fc" }, "latest"],
    });
    const ppsRaw = res.result;
    if (!ppsRaw || ppsRaw === "0x") {
      throw new Error("Failed to estimate external vault shares: pricePerFullShare is zero");
    }
    const pps = BigInt(ppsRaw);
    if (pps > 0n) {
      return ((params.underlyingAmount * (10n ** 18n)) / pps).toString();
    }
    throw new Error("Failed to estimate external vault shares: pricePerFullShare is zero");
  }

  const [totalUnderlyingRes, totalSupplyRes] = await Promise.all([
    rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0",
      id: 0,
      method: "eth_call",
      params: [{ to: params.vaultAddress, data: "0xc70920bc" }, "latest"],
    }),
    rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: params.vaultAddress, data: "0x18160ddd" }, "latest"],
    }),
  ]);
  const totalUnderlyingRaw = totalUnderlyingRes.result;
  const totalSupplyRaw = totalSupplyRes.result;
  if (!totalUnderlyingRaw || totalUnderlyingRaw === "0x" || !totalSupplyRaw || totalSupplyRaw === "0x") {
    throw new Error("Failed to estimate external vault shares: totalUnderlying/totalSupply unavailable");
  }
  const totalUnderlying = BigInt(totalUnderlyingRaw);
  const totalSupply = BigInt(totalSupplyRaw);
  if (totalUnderlying > 0n && totalSupply > 0n) {
    return ((params.underlyingAmount * totalSupply) / totalUnderlying).toString();
  }
  throw new Error("Failed to estimate external vault shares: totalUnderlying/totalSupply unavailable");
}
