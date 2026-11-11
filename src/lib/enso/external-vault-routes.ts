// This module is part of an import cycle with the other two of
// conversions.ts, external-vault-zap-in.ts and external-vault-routes.ts.
// Keep it free of top-level initialisers (const/let/class that read an
// import): only imports and function declarations are safe here.
import type {
  CustomBundleResponse,
  EnsoBundleAction,
  RouteStep,
} from "@/types/enso";
import { WETH_ADDRESS, YVUSDC1_ADDRESS } from "@/config/addresses";
import { LLAMA_AIRFORCE as STATIC_LLAMA_AIRFORCE, TOKENS } from "@/config/vaults";
import {
  calculateMinDy,
  previewRedeem,
  validateSlippage,
} from "@/lib/curve";
import { fetchEnsoIntent } from "@/lib/enso-intents";
import {
  fetchBundle,
  fetchDynamicInputEstimate,
  fetchQuote,
  rpcWithFallback,
} from "./api";
import {
  appendDynamicRouteFloor,
  appendETHUnwrapIfNeeded,
  buildRouteMetadataFromSteps,
  createRouteStep,
  formatRouteAmount,
  getBufferedSlippageBps,
  rawCallConsumingInput,
} from "./bundle-helpers";
import { ENSO_SHORTCUTS, ETH_ADDRESS, isNativeETH } from "./constants";
import {
  appendBestExactUsdcToCvxConversion,
  appendCvxToPxCvxConversion,
  buildInitialConversionState,
  convertStateToToken,
  estimateExternalVaultShares,
  toBalanceState,
  type ConversionContext,
  type ConversionState,
} from "./conversions";
import { previewBeefyWithdraw, previewUCrvWithdraw } from "./external-vault-zap-in";
import { fetchAnyToPxCvxRoute } from "./pirex-routes";
import { getLpxCvxToCvxSwapRate } from "./pxcvx-pool";
import { getTokenSymbol } from "./tokens";

// ============================================================================
// External ERC4626 Vault → Any Token (universal-zap inputs)
// ============================================================================

/**
 * uCVX → any token. Redeem uCVX for pxCVX, wrap to lpxCVX, Curve swap to CVX,
 * then Enso route CVX → output.
 */
export async function fetchAnyFromUCvxRoute(params: {
  fromAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "externalVaultToAny",
      fromAddress: params.fromAddress,
      externalVaultAddress: STATIC_LLAMA_AIRFORCE.UCVX,
      outputToken: params.outputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const { PIREX, LLAMA_AIRFORCE } = await import("@/config/vaults");
  const outputSymbol = getTokenSymbol(params.outputToken);
  const outputIsCvx = params.outputToken.toLowerCase() === TOKENS.CVX.toLowerCase();
  const slippageBps = validateSlippage(params.slippage);
  const totalSlippageBps = getBufferedSlippageBps(slippageBps);

  // Estimate pxCVX from uCVX redeem (then 1:1 to lpxCVX)
  const expectedPxCvx = await previewRedeem(LLAMA_AIRFORCE.UCVX, params.amountIn);
  // The legs spend the runtime redeem output (useOutputOfCallAt: 0), so quote the unbuffered amount.
  const expectedCvx = await getLpxCvxToCvxSwapRate(BigInt(expectedPxCvx).toString());
  if (!expectedCvx || expectedCvx === 0n) {
    throw new Error("Failed to estimate Curve lpxCVX→CVX swap output");
  }
  const minDy = calculateMinDy(expectedCvx, totalSlippageBps);

  const actions: EnsoBundleAction[] = [
    // 0: Redeem uCVX → pxCVX
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: LLAMA_AIRFORCE.UCVX,
        tokenOut: PIREX.PXCVX,
        amountIn: params.amountIn,
        primaryAddress: LLAMA_AIRFORCE.UCVX,
      },
    },
    // 1: Approve pxCVX to lpxCVX contract (for wrap)
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.PXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: 0 },
      },
    },
    // 2: Wrap pxCVX → lpxCVX (1:1)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "wrap",
        abi: "function wrap(uint256 amount)",
        args: [{ useOutputOfCallAt: 0 }],
      },
    },
    // 3: Approve lpxCVX → Curve pool
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: { useOutputOfCallAt: 0 },
      },
    },
    // 4: Curve swap lpxCVX → CVX
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
          { useOutputOfCallAt: 0 },
          minDy,
        ],
      },
    },
  ];

  // 5: CVX → output token. CVX itself is just sent on (Enso has no CVX → CVX route).
  let cvxLegEstimate = "0";
  if (outputIsCvx) {
    actions.push({
      protocol: "erc20",
      action: "transfer",
      args: { token: TOKENS.CVX, amount: { useOutputOfCallAt: 4 }, receiver: params.fromAddress },
    });
  } else {
    // Standalone estimate of the CVX leg (unrestricted aggregators): the floor
    // below, and the ETH output figure. Execution routes to WETH for ETH.
    cvxLegEstimate = (await fetchDynamicInputEstimate({
      fromAddress: params.fromAddress,
      tokenIn: TOKENS.CVX,
      tokenOut: isNativeETH(params.outputToken) ? WETH_ADDRESS : params.outputToken,
      amountIn: expectedCvx.toString(),
      slippage: params.slippage ?? "100",
    })).amountOut;
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: 4 },
        slippage: params.slippage ?? "100",
      },
    });
    const routeIdx = actions.length - 1;
    appendETHUnwrapIfNeeded(actions, params.outputToken);
    appendDynamicRouteFloor(actions, routeIdx, cvxLegEstimate, params.slippage);
  }

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: true,
  });

  // skipQuote: report the final output token the intent guard binds to. CVX comes straight from
  // the Curve exchange; ETH is the unwrapped WETH that the route quoted.
  if (outputIsCvx) {
    bundleResult.amountsOut = { ...bundleResult.amountsOut, [TOKENS.CVX.toLowerCase()]: expectedCvx.toString() };
  } else {
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      // The CVX leg was already quoted above (WETH for ETH outputs); reuse it.
      ...(isNativeETH(params.outputToken) && !bundleResult.amountsOut?.[ETH_ADDRESS.toLowerCase()] && cvxLegEstimate !== "0"
        ? { [ETH_ADDRESS.toLowerCase()]: String(cvxLegEstimate) }
        : {}),
    };
  }

  const pxCvxFmt = (Number(expectedPxCvx) / 1e18).toFixed(4);
  const cvxFmt = (Number(expectedCvx) / 1e18).toFixed(4);
  const steps: RouteStep[] = [
    { tokenSymbol: "uCVX", action: "Exit", description: "uCVX for pxCVX", protocol: "Llama Airforce" },
    { tokenSymbol: "pxCVX", amount: pxCvxFmt, action: "Wrap", description: "pxCVX to lpxCVX (1:1)", protocol: "Pirex" },
    { tokenSymbol: "lpxCVX", amount: pxCvxFmt, action: "Swap", description: "lpxCVX for CVX via Curve", protocol: "Curve" },
    { tokenSymbol: "CVX", amount: cvxFmt, action: "Swap", description: `CVX for ${outputSymbol}`, protocol: "Enso" },
    { tokenSymbol: outputSymbol, action: "Receive", description: "tokens", protocol: "Enso" },
  ];

  return {
    ...bundleResult,
    routeInfo: {
      steps,
      tokens: ["uCVX", "pxCVX", "lpxCVX", "CVX", outputSymbol],
      protocols: ["Llama Airforce", "Pirex", "Curve", "Enso"],
    },
  };
}

/**
 * Simple ERC4626 external vault → any token, for vaults whose underlying is
 * directly swappable on Enso (CVX, cvxCRV, crvUSD). Used for aCVX, aCRV,
 * afCVX, scrvUSD.
 */
export async function fetchAnyFromErc4626ExternalVaultRoute(params: {
  fromAddress: string;
  externalVault: string;
  externalVaultUnderlying: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
  protocolLabel?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "externalVaultToAny",
      fromAddress: params.fromAddress,
      externalVaultAddress: params.externalVault,
      outputToken: params.outputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const externalSymbol = getTokenSymbol(params.externalVault);
  const underlyingSymbol = getTokenSymbol(params.externalVaultUnderlying);
  const outputSymbol = getTokenSymbol(params.outputToken);
  const protocolLabel = params.protocolLabel ?? "ERC4626";

  const sameAsOutput =
    params.externalVaultUnderlying.toLowerCase() === params.outputToken.toLowerCase();

  const expectedUnderlying = await previewRedeem(params.externalVault, params.amountIn);
  const useExactUsdcRoute =
    params.externalVault.toLowerCase() === YVUSDC1_ADDRESS.toLowerCase() &&
    params.outputToken.toLowerCase() === TOKENS.CVX.toLowerCase();
  let expectedOutput: bigint | undefined;
  let exactSwapProtocol: string | undefined;
  let actions: EnsoBundleAction[];
  if (sameAsOutput) {
    actions = [
      {
        protocol: "erc4626",
        action: "redeem",
        args: {
          tokenIn: params.externalVault,
          tokenOut: params.externalVaultUnderlying,
          amountIn: params.amountIn,
          primaryAddress: params.externalVault,
        },
      },
    ];
  } else if (useExactUsdcRoute) {
    actions = [
      {
        protocol: "erc4626",
        action: "redeem",
        args: {
          tokenIn: params.externalVault,
          tokenOut: params.externalVaultUnderlying,
          amountIn: params.amountIn,
          primaryAddress: params.externalVault,
        },
      },
    ];
    const slippageBps = validateSlippage(params.slippage);
    const exactRouteSteps: RouteStep[] = [];
    const exactState = await appendBestExactUsdcToCvxConversion(
      actions,
      { useOutputOfCallAt: 0 },
      BigInt(expectedUnderlying),
      {
        fromAddress: params.fromAddress,
        slippage: params.slippage,
        slippageBps,
        totalSlippageBps: getBufferedSlippageBps(slippageBps),
      },
      exactRouteSteps,
    );
    // The exact conversion leaves CVX in EnsoShortcuts; deliver it explicitly.
    const delivered = toBalanceState(actions, exactState.token, exactState.expectedAmount);
    actions.push({
      protocol: "erc20",
      action: "transfer",
      args: {
        token: delivered.token,
        amount: delivered.amountRef,
        receiver: params.fromAddress,
      },
    });
    expectedOutput = exactState.expectedAmount;
    exactSwapProtocol = exactRouteSteps.at(-1)?.protocol;
  } else {
    actions = [
      {
        protocol: "erc4626",
        action: "redeem",
        args: {
          tokenIn: params.externalVault,
          tokenOut: params.externalVaultUnderlying,
          amountIn: params.amountIn,
          primaryAddress: params.externalVault,
        },
      },
      {
        protocol: "enso",
        action: "route",
        args: {
          tokenIn: params.externalVaultUnderlying,
          tokenOut: params.outputToken,
          amountIn: { useOutputOfCallAt: 0 },
          slippage: params.slippage ?? "100",
        },
      },
    ];
  }

  appendETHUnwrapIfNeeded(actions, params.outputToken);

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: useExactUsdcRoute,
  });
  if (sameAsOutput || expectedOutput !== undefined) {
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [params.outputToken.toLowerCase()]: expectedOutput?.toString() ?? expectedUnderlying,
    };
  }

  const underlyingFmt = formatRouteAmount(expectedUnderlying, params.externalVaultUnderlying);
  const steps: RouteStep[] = [
    { tokenSymbol: externalSymbol, action: "Exit", description: `${externalSymbol} for ${underlyingSymbol}`, protocol: protocolLabel },
  ];
  if (!sameAsOutput) {
    const swapProtocol = useExactUsdcRoute ? (exactSwapProtocol ?? "Curve") : "Enso";
    steps.push({ tokenSymbol: underlyingSymbol, amount: underlyingFmt, action: "Swap", description: `${underlyingSymbol} for ${outputSymbol}`, protocol: swapProtocol });
    steps.push({ tokenSymbol: outputSymbol, action: "Receive", description: "tokens", protocol: swapProtocol });
  } else {
    steps.push({ tokenSymbol: outputSymbol, amount: underlyingFmt, action: "Receive", description: "tokens", protocol: protocolLabel });
  }

  return {
    ...bundleResult,
    routeInfo: {
      steps,
      tokens: sameAsOutput
        ? [externalSymbol, outputSymbol]
        : [externalSymbol, underlyingSymbol, outputSymbol],
      protocols: sameAsOutput
        ? [protocolLabel]
        : [protocolLabel, useExactUsdcRoute ? (exactSwapProtocol ?? "Curve") : "Enso"],
    },
  };
}

/**
 * uCRV (Llama Airforce) → any token. uCRV uses non-standard
 * `withdraw(_to, _shares)` — cvxCRV is sent to the given receiver, then Enso
 * routes cvxCRV → output.
 */
export async function fetchAnyFromUCrvRoute(params: {
  fromAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "externalVaultToAny",
      fromAddress: params.fromAddress,
      externalVaultAddress: STATIC_LLAMA_AIRFORCE.UCRV,
      outputToken: params.outputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const { LLAMA_AIRFORCE } = await import("@/config/vaults");
  const outputSymbol = getTokenSymbol(params.outputToken);

  const expectedCvxCrv = await previewUCrvWithdraw(params.amountIn);
  const sameAsOutput =
    LLAMA_AIRFORCE.UCRV_UNDERLYING.toLowerCase() === params.outputToken.toLowerCase();

  const actions: EnsoBundleAction[] = [
    // uCRV.withdraw(_to, _shares). cvxCRV output goes straight to the user; otherwise it lands at
    // ENSO_SHORTCUTS for the route below. (Sending it to shortcuts with no route left it stranded.)
    rawCallConsumingInput(params.amountIn, LLAMA_AIRFORCE.UCRV, {
      address: LLAMA_AIRFORCE.UCRV,
      method: "withdraw",
      abi: "function withdraw(address _to, uint256 _shares) returns (uint256)",
      args: [sameAsOutput ? params.fromAddress : ENSO_SHORTCUTS, params.amountIn],
    }),
  ];

  // Quote for display data, then route the actual cvxCRV balance produced by
  // withdraw at runtime. The standalone quote calldata is never executed.
  let expectedOutput = "0";
  if (!sameAsOutput) {
    const dynamicQuote = await fetchDynamicInputEstimate({
      fromAddress: params.fromAddress,
      tokenIn: LLAMA_AIRFORCE.UCRV_UNDERLYING,
      // Execution routes to WETH and unwraps, so quote that leg for ETH outputs.
      tokenOut: isNativeETH(params.outputToken) ? WETH_ADDRESS : params.outputToken,
      amountIn: expectedCvxCrv,
      slippage: params.slippage ?? "100",
    });
    expectedOutput = dynamicQuote.amountOut;
    actions.push({
      protocol: "enso",
      action: "balance",
      args: { token: LLAMA_AIRFORCE.UCRV_UNDERLYING },
    });
    const underlyingBalanceIdx = actions.length - 1;
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: LLAMA_AIRFORCE.UCRV_UNDERLYING,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: underlyingBalanceIdx },
        slippage: params.slippage ?? "100",
      },
    });
    const routeIdx = actions.length - 1;
    appendETHUnwrapIfNeeded(actions, params.outputToken);
    appendDynamicRouteFloor(actions, routeIdx, expectedOutput, params.slippage);
  }

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: true,
  });

  // skipQuote returns no amountsOut — populate manually
  const displayedOutput = sameAsOutput ? expectedCvxCrv : expectedOutput;
  if (displayedOutput !== "0") {
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [params.outputToken.toLowerCase()]: displayedOutput,
    };
  }

  const cvxCrvFmt = (Number(expectedCvxCrv) / 1e18).toFixed(4);
  const steps: RouteStep[] = [
    { tokenSymbol: "uCRV", action: "Exit", description: "uCRV for cvxCRV", protocol: "Llama Airforce" },
  ];
  if (!sameAsOutput) {
    steps.push({ tokenSymbol: "cvxCRV", amount: cvxCrvFmt, action: "Swap", description: `cvxCRV for ${outputSymbol}`, protocol: "Enso" });
    steps.push({ tokenSymbol: outputSymbol, action: "Receive", description: "tokens", protocol: "Enso" });
  } else {
    steps.push({ tokenSymbol: outputSymbol, amount: cvxCrvFmt, action: "Receive", description: "tokens", protocol: "Llama Airforce" });
  }

  return {
    ...bundleResult,
    routeInfo: {
      steps,
      tokens: sameAsOutput ? ["uCRV", outputSymbol] : ["uCRV", "cvxCRV", outputSymbol],
      protocols: sameAsOutput ? ["Llama Airforce"] : ["Llama Airforce", "Enso"],
    },
  };
}

/**
 * Beefy external vault → any token. Beefy uses `withdraw(_shares)` which
 * burns shares and sends underlying to msg.sender (ENSO_SHORTCUTS). Then
 * Enso routes underlying → output.
 */
export async function fetchAnyFromBeefyRoute(params: {
  fromAddress: string;
  beefyVault: string;
  beefyVaultUnderlying: string;
  beefyVaultSymbol: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "externalVaultToAny",
      fromAddress: params.fromAddress,
      externalVaultAddress: params.beefyVault,
      outputToken: params.outputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const outputSymbol = getTokenSymbol(params.outputToken);
  const underlyingSymbol = getTokenSymbol(params.beefyVaultUnderlying);
  const expectedUnderlying = await previewBeefyWithdraw(params.beefyVault, params.amountIn);
  const sameAsOutput =
    params.beefyVaultUnderlying.toLowerCase() === params.outputToken.toLowerCase();

  const actions: EnsoBundleAction[] = [
    // Beefy withdraw(shares) — burns shares and sends underlying to msg.sender
    // (ENSO_SHORTCUTS). A following balance action captures the void call's
    // runtime output.
    rawCallConsumingInput(params.amountIn, params.beefyVault, {
      address: params.beefyVault,
      method: "withdraw",
      abi: "function withdraw(uint256 _shares)",
      args: [params.amountIn],
    }),
  ];

  let expectedOutput = "0";
  let beefyRouteIdx = -1;
  if (!sameAsOutput) {
    // Execution routes to WETH and unwraps (appendETHUnwrapIfNeeded), so quote that leg: a native-ETH
    // quote can pick a different, worse route and understated ETH exits by ~40%.
    const dynamicQuote = await fetchDynamicInputEstimate({
      fromAddress: params.fromAddress,
      tokenIn: params.beefyVaultUnderlying,
      tokenOut: isNativeETH(params.outputToken) ? WETH_ADDRESS : params.outputToken,
      amountIn: expectedUnderlying,
      slippage: params.slippage ?? "100",
    });
    expectedOutput = dynamicQuote.amountOut;
    actions.push({
      protocol: "enso",
      action: "balance",
      args: { token: params.beefyVaultUnderlying },
    });
    const underlyingBalanceIdx = actions.length - 1;
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.beefyVaultUnderlying,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: underlyingBalanceIdx },
        slippage: params.slippage ?? "100",
      },
    });
    beefyRouteIdx = actions.length - 1;
  }

  if (sameAsOutput) {
    // Output is the vault's own underlying: send the withdrawn balance on. Without this it stayed
    // at the shared EnsoShortcuts contract (the intent guard rejected the missing output).
    actions.push({ protocol: "enso", action: "balance", args: { token: params.beefyVaultUnderlying } });
    actions.push({
      protocol: "erc20",
      action: "transfer",
      args: { token: params.beefyVaultUnderlying, amount: { useOutputOfCallAt: actions.length - 1 }, receiver: params.fromAddress },
    });
  }

  appendETHUnwrapIfNeeded(actions, params.outputToken);
  if (beefyRouteIdx >= 0) appendDynamicRouteFloor(actions, beefyRouteIdx, expectedOutput, params.slippage);

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: true,
  });

  // skipQuote leaves amountsOut empty — populate from the standalone route.
  const displayedOutput = sameAsOutput ? expectedUnderlying : expectedOutput;
  if (displayedOutput !== "0") {
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [params.outputToken.toLowerCase()]: displayedOutput,
    };
  }

  const underlyingFmt = formatRouteAmount(expectedUnderlying, params.beefyVaultUnderlying);
  const steps: RouteStep[] = [
    { tokenSymbol: params.beefyVaultSymbol, action: "Exit", description: `${params.beefyVaultSymbol} for ${underlyingSymbol}`, protocol: "Beefy" },
  ];
  if (!sameAsOutput) {
    steps.push({ tokenSymbol: underlyingSymbol, amount: underlyingFmt, action: "Swap", description: `${underlyingSymbol} for ${outputSymbol}`, protocol: "Enso" });
    steps.push({ tokenSymbol: outputSymbol, action: "Receive", description: "tokens", protocol: "Enso" });
  } else {
    steps.push({ tokenSymbol: outputSymbol, amount: underlyingFmt, action: "Receive", description: "tokens", protocol: "Beefy" });
  }

  return {
    ...bundleResult,
    routeInfo: {
      steps,
      tokens: sameAsOutput
        ? [params.beefyVaultSymbol, outputSymbol]
        : [params.beefyVaultSymbol, underlyingSymbol, outputSymbol],
      protocols: sameAsOutput ? ["Beefy"] : ["Beefy", "Enso"],
    },
  };
}

// ============================================================================
// Any Token → External Vault (universal-zap outputs)
// ============================================================================

/**
 * Server-owned dispatcher for liquid token → external vault outputs.
 */
export async function fetchAnyToExternalVaultRoute(params: {
  fromAddress: string;
  inputToken: string;
  externalVaultAddress: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "anyToExternalVault",
      fromAddress: params.fromAddress,
      inputToken: params.inputToken,
      externalVaultAddress: params.externalVaultAddress,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const { getExternalVaultConfig } = await import("@/config/vaults");
  const config = getExternalVaultConfig(params.externalVaultAddress);
  if (!config) {
    throw new Error(`Unknown external vault: ${params.externalVaultAddress}`);
  }

  if (config.interface === "ucrv") {
    return fetchAnyToUCrvRoute({
      fromAddress: params.fromAddress,
      inputToken: params.inputToken,
      amountIn: params.amountIn,
      slippage: params.slippage,
    });
  }

  if (config.interface === "beefy") {
    return fetchAnyToBeefyRoute({
      fromAddress: params.fromAddress,
      inputToken: params.inputToken,
      beefyVault: config.address,
      beefyVaultUnderlying: config.underlying,
      beefyVaultSymbol: config.symbol,
      amountIn: params.amountIn,
      slippage: params.slippage,
    });
  }

  if (config.underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase()) {
    return fetchAnyToPxCvxRoute({
      fromAddress: params.fromAddress,
      inputToken: params.inputToken,
      amountIn: params.amountIn,
      slippage: params.slippage,
      depositIntoVault: config.address,
    });
  }

  return fetchAnyToErc4626ExternalVaultRoute({
    fromAddress: params.fromAddress,
    inputToken: params.inputToken,
    externalVault: config.address,
    externalVaultUnderlying: config.underlying,
    externalVaultSymbol: config.symbol,
    externalVaultProtocol: config.protocol,
    amountIn: params.amountIn,
    slippage: params.slippage,
  });
}

/**
 * Any token → ERC4626 external vault (aCVX, aCRV, afCVX, scrvUSD).
 * Route input → vault's underlying via Enso, then erc4626/deposit. Works for
 * any vault whose underlying Enso indexes liquidly (CVX, cvxCRV, crvUSD).
 */
export async function fetchAnyToErc4626ExternalVaultRoute(params: {
  fromAddress: string;
  inputToken: string;
  externalVault: string;
  externalVaultUnderlying: string;
  externalVaultSymbol: string;
  externalVaultProtocol: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  const inputSymbol = getTokenSymbol(params.inputToken);
  const underlyingSymbol = getTokenSymbol(params.externalVaultUnderlying);

  const inputIsUnderlying =
    params.inputToken.toLowerCase() === params.externalVaultUnderlying.toLowerCase();

  const actions: EnsoBundleAction[] = [];

  if (!inputIsUnderlying) {
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.inputToken,
        tokenOut: params.externalVaultUnderlying,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      },
    });
  }

  actions.push({
    protocol: "erc4626",
    action: "deposit",
    args: {
      tokenIn: params.externalVaultUnderlying,
      tokenOut: params.externalVault,
      amountIn: inputIsUnderlying ? params.amountIn : { useOutputOfCallAt: 0 },
      primaryAddress: params.externalVault,
    },
  });

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: false,
  });

  const underlyingAmountRaw =
    bundleResult.amountsOut[params.externalVaultUnderlying.toLowerCase()] ||
    bundleResult.amountsOut[params.externalVaultUnderlying] ||
    "0";
  const underlyingAmountFmt =
    BigInt(underlyingAmountRaw) > 0n
      ? formatRouteAmount(underlyingAmountRaw, params.externalVaultUnderlying)
      : undefined;

  const steps: RouteStep[] = [];
  if (!inputIsUnderlying) {
    steps.push({
      tokenSymbol: inputSymbol,
      action: "Swap",
      description: `${inputSymbol} for ${underlyingSymbol}`,
      protocol: "Enso",
    });
  }
  steps.push(
    {
      tokenSymbol: underlyingSymbol,
      amount: underlyingAmountFmt,
      action: "Deposit",
      description: `${underlyingSymbol} into ${params.externalVaultSymbol}`,
      protocol: params.externalVaultProtocol,
    },
    {
      tokenSymbol: params.externalVaultSymbol,
      action: "Receive",
      description: "vault shares",
      protocol: params.externalVaultProtocol,
    },
  );

  return {
    ...bundleResult,
    routeInfo: {
      steps,
      tokens: inputIsUnderlying
        ? [underlyingSymbol, params.externalVaultSymbol]
        : [inputSymbol, underlyingSymbol, params.externalVaultSymbol],
      protocols: inputIsUnderlying
        ? [params.externalVaultProtocol]
        : ["Enso", params.externalVaultProtocol],
    },
  };
}

/**
 * Any token → uCRV (Llama Airforce). uCRV uses a non-standard deposit signature
 * `deposit(address _to, uint256 _amount)`. Route input → cvxCRV, approve,
 * deposit with user as receiver.
 */
export async function fetchAnyToUCrvRoute(params: {
  fromAddress: string;
  inputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  const { LLAMA_AIRFORCE } = await import("@/config/vaults");
  const inputSymbol = getTokenSymbol(params.inputToken);
  const inputIsCvxCrv =
    params.inputToken.toLowerCase() === LLAMA_AIRFORCE.UCRV_UNDERLYING.toLowerCase();

  const actions: EnsoBundleAction[] = [];

  if (!inputIsCvxCrv) {
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.inputToken,
        tokenOut: LLAMA_AIRFORCE.UCRV_UNDERLYING,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      },
    });
  }

  const amountRef: string | { useOutputOfCallAt: number } = inputIsCvxCrv
    ? params.amountIn
    : { useOutputOfCallAt: 0 };

  // Approve cvxCRV to uCRV
  actions.push({
    protocol: "erc20",
    action: "approve",
    args: {
      token: LLAMA_AIRFORCE.UCRV_UNDERLYING,
      spender: LLAMA_AIRFORCE.UCRV,
      amount: amountRef,
    },
  });

  // uCRV.deposit(_amount, _to) — mints shares to _to
  actions.push({
    protocol: "enso",
    action: "call",
    args: {
      address: LLAMA_AIRFORCE.UCRV,
      method: "deposit",
      // uCRV is deposit(address _to, uint256 _amount); the reversed order hits a missing selector.
      abi: "function deposit(address _to, uint256 _amount) returns (uint256)",
      args: [params.fromAddress, amountRef],
    },
  });

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: true,
  });

  // Resolve the cvxCRV amount we'll actually deposit. For non-cvxCRV inputs we
  // need to pre-quote the Enso route; using amountIn directly gives wrong
  // decimals (e.g. 1000 USDC = 1000e6, but totalUnderlying/totalSupply are 1e18).
  // A failed quote fails the zap quote: a wrong output becomes the intent guard's minimum.
  const cvxCrvAmount = inputIsCvxCrv
    ? params.amountIn
    : (await fetchQuote({
        fromAddress: params.fromAddress,
        tokenIn: params.inputToken,
        tokenOut: LLAMA_AIRFORCE.UCRV_UNDERLYING,
        amountIn: params.amountIn,
      })).amountOut;

  const [totalUnderlyingRes, totalSupplyRes] = await Promise.all([
    rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0", id: 0, method: "eth_call",
      params: [{ to: LLAMA_AIRFORCE.UCRV, data: "0xc70920bc" }, "latest"],
    }),
    rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: LLAMA_AIRFORCE.UCRV, data: "0x18160ddd" }, "latest"],
    }),
  ]);
  const totalUnderlyingRaw = totalUnderlyingRes.result;
  const totalSupplyRaw = totalSupplyRes.result;
  if (!totalUnderlyingRaw || totalUnderlyingRaw === "0x" || !totalSupplyRaw || totalSupplyRaw === "0x") {
    throw new Error("Failed to estimate uCRV shares");
  }
  const totalUnderlying = BigInt(totalUnderlyingRaw);
  const totalSupply = BigInt(totalSupplyRaw);
  if (totalUnderlying <= 0n || totalSupply <= 0n) {
    throw new Error("Failed to estimate uCRV shares");
  }
  const expectedShares = ((BigInt(cvxCrvAmount) * totalSupply) / totalUnderlying).toString();
  bundleResult.amountsOut = {
    ...bundleResult.amountsOut,
    [LLAMA_AIRFORCE.UCRV.toLowerCase()]: expectedShares,
    [LLAMA_AIRFORCE.UCRV_UNDERLYING.toLowerCase()]: cvxCrvAmount,
  };

  const steps: RouteStep[] = [];
  if (!inputIsCvxCrv) {
    steps.push({
      tokenSymbol: inputSymbol,
      action: "Swap",
      description: `${inputSymbol} for cvxCRV`,
      protocol: "Enso",
    });
  }
  steps.push(
    {
      tokenSymbol: "cvxCRV",
      action: "Deposit",
      description: "cvxCRV into uCRV",
      protocol: "Llama Airforce",
    },
    {
      tokenSymbol: "uCRV",
      action: "Receive",
      description: "vault shares",
      protocol: "Llama Airforce",
    },
  );

  return {
    ...bundleResult,
    routeInfo: {
      steps,
      tokens: inputIsCvxCrv ? ["cvxCRV", "uCRV"] : [inputSymbol, "cvxCRV", "uCRV"],
      protocols: inputIsCvxCrv ? ["Llama Airforce"] : ["Enso", "Llama Airforce"],
    },
  };
}

/**
 * Any token → Beefy vault (mooCvxCRV / mooCvxCVX).
 * Beefy deposit() pulls msg.sender's approved balance, so we route to the
 * underlying, approve the vault, then call deposit() from ENSO_SHORTCUTS.
 */
export async function fetchAnyToBeefyRoute(params: {
  fromAddress: string;
  inputToken: string;
  beefyVault: string;
  beefyVaultUnderlying: string;
  beefyVaultSymbol: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  const inputSymbol = getTokenSymbol(params.inputToken);
  const underlyingSymbol = getTokenSymbol(params.beefyVaultUnderlying);
  const inputIsUnderlying =
    params.inputToken.toLowerCase() === params.beefyVaultUnderlying.toLowerCase();

  const actions: EnsoBundleAction[] = [];
  let underlyingAmountRef: string | { useOutputOfCallAt: number } = params.amountIn;

  if (!inputIsUnderlying) {
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.inputToken,
        tokenOut: params.beefyVaultUnderlying,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      },
    });
    // Balance read — Beefy deposit() needs an approved balance amount
    actions.push({
      protocol: "enso",
      action: "balance",
      args: { token: params.beefyVaultUnderlying },
    });
    underlyingAmountRef = { useOutputOfCallAt: 1 };
  }

  // Approve underlying → Beefy vault
  actions.push({
    protocol: "erc20",
    action: "approve",
    args: {
      token: params.beefyVaultUnderlying,
      spender: params.beefyVault,
      amount: underlyingAmountRef,
    },
  });

  // Beefy deposit(amount) pulls msg.sender's approved tokens, shares go to msg.sender
  actions.push({
    protocol: "enso",
    action: "call",
    args: {
      address: params.beefyVault,
      method: "deposit",
      abi: "function deposit(uint256 _amount)",
      args: [underlyingAmountRef],
    },
  });

  // Read resulting Beefy share balance + transfer to user
  actions.push({
    protocol: "enso",
    action: "balance",
    args: { token: params.beefyVault },
  });
  const shareBalanceIdx = actions.length - 1;

  actions.push({
    protocol: "erc20",
    action: "transfer",
    args: {
      token: params.beefyVault,
      amount: { useOutputOfCallAt: shareBalanceIdx },
      receiver: params.fromAddress,
    },
  });

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: true,
  });

  // Estimate underlying amount (for non-underlying inputs we need the post-swap
  // cvxCRV/CVX amount, not USDC amountIn) then derive shares via pricePerFullShare.
  // A failed quote fails the zap quote: a wrong output becomes the intent guard's minimum.
  const underlyingAmount = inputIsUnderlying
    ? params.amountIn
    : (await fetchQuote({
        fromAddress: params.fromAddress,
        tokenIn: params.inputToken,
        tokenOut: params.beefyVaultUnderlying,
        amountIn: params.amountIn,
      })).amountOut;

  const ppsRes = await rpcWithFallback<{ result?: string }>({
    jsonrpc: "2.0",
    id: 0,
    method: "eth_call",
    params: [{ to: params.beefyVault, data: "0x77c7b8fc" }, "latest"], // getPricePerFullShare()
  });
  const ppsRaw = ppsRes.result;
  if (!ppsRaw || ppsRaw === "0x") {
    throw new Error("Failed to estimate Beefy vault shares");
  }
  const pps = BigInt(ppsRaw);
  if (pps <= 0n) {
    throw new Error("Failed to estimate Beefy vault shares");
  }
  const expectedShares = ((BigInt(underlyingAmount) * (10n ** 18n)) / pps).toString();
  bundleResult.amountsOut = {
    ...bundleResult.amountsOut,
    [params.beefyVault.toLowerCase()]: expectedShares,
    [params.beefyVaultUnderlying.toLowerCase()]: underlyingAmount,
  };

  const steps: RouteStep[] = [];
  if (!inputIsUnderlying) {
    steps.push({
      tokenSymbol: inputSymbol,
      action: "Swap",
      description: `${inputSymbol} for ${underlyingSymbol}`,
      protocol: "Enso",
    });
  }
  steps.push(
    {
      tokenSymbol: underlyingSymbol,
      action: "Deposit",
      description: `${underlyingSymbol} into ${params.beefyVaultSymbol}`,
      protocol: "Beefy",
    },
    {
      tokenSymbol: params.beefyVaultSymbol,
      action: "Receive",
      description: "vault shares",
      protocol: "Beefy",
    },
  );

  return {
    ...bundleResult,
    routeInfo: {
      steps,
      tokens: inputIsUnderlying
        ? [underlyingSymbol, params.beefyVaultSymbol]
        : [inputSymbol, underlyingSymbol, params.beefyVaultSymbol],
      protocols: inputIsUnderlying ? ["Beefy"] : ["Enso", "Beefy"],
    },
  };
}

/**
 * Generic token → yld vault composer used when the input or target underlying
 * is a non-routeable special asset.
 */
export async function fetchComposableZapInRoute(params: {
  fromAddress: string;
  inputToken: string;
  vaultAddress: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  // Raw bundle actions can't be submitted from the browser; build server-side via the intent.
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "illiquidToYldVault",
      fromAddress: params.fromAddress,
      inputToken: params.inputToken,
      vaultAddress: params.vaultAddress,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const { getVaultByAddress } = await import("@/config/vaults");
  const targetVault = getVaultByAddress(params.vaultAddress);
  if (!targetVault) {
    throw new Error(`Unknown target vault: ${params.vaultAddress}`);
  }

  const slippageBps = validateSlippage(params.slippage);
  const ctx: ConversionContext = {
    fromAddress: params.fromAddress,
    slippage: params.slippage,
    slippageBps,
    totalSlippageBps: getBufferedSlippageBps(slippageBps),
  };

  const { actions, state: initialState, steps } = await buildInitialConversionState({
    inputToken: params.inputToken,
    amountIn: params.amountIn,
    targetToken: targetVault.assetAddress,
    ctx,
  });
  const routeSteps = [...steps];
  const finalState = await convertStateToToken(actions, initialState, targetVault.assetAddress, ctx, routeSteps);

  actions.push({
    protocol: "erc4626",
    action: "deposit",
    args: {
      tokenIn: targetVault.assetAddress,
      tokenOut: params.vaultAddress,
      amountIn: finalState.amountRef,
      primaryAddress: params.vaultAddress,
    },
  });

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: true,
  });

  const expectedShares = await estimateExternalVaultShares({
    vaultAddress: params.vaultAddress,
    vaultInterface: "erc4626",
    underlyingAmount: finalState.expectedAmount,
  });

  bundleResult.amountsOut = {
    ...bundleResult.amountsOut,
    [params.vaultAddress.toLowerCase()]: expectedShares,
    [targetVault.assetAddress.toLowerCase()]: finalState.expectedAmount.toString(),
  };

  const targetUnderlyingSymbol = getTokenSymbol(targetVault.assetAddress);

  return {
    ...bundleResult,
    routeInfo: {
      steps: [
        ...routeSteps,
        createRouteStep({
          tokenAddress: targetVault.assetAddress,
          tokenSymbol: targetUnderlyingSymbol,
          amount: finalState.expectedAmount,
          action: "Deposit",
          description: `${targetUnderlyingSymbol} into ${targetVault.symbol}`,
          protocol: "yld",
        }),
        createRouteStep({
          tokenAddress: params.vaultAddress,
          tokenSymbol: targetVault.symbol,
          amount: expectedShares,
          action: "Receive",
          description: "vault shares",
          protocol: "yld",
        }),
      ],
      ...buildRouteMetadataFromSteps([
        ...routeSteps,
        createRouteStep({
          tokenAddress: targetVault.assetAddress,
          tokenSymbol: targetUnderlyingSymbol,
          amount: finalState.expectedAmount,
          action: "Deposit",
          description: `${targetUnderlyingSymbol} into ${targetVault.symbol}`,
          protocol: "yld",
        }),
        createRouteStep({
          tokenAddress: params.vaultAddress,
          tokenSymbol: targetVault.symbol,
          amount: expectedShares,
          action: "Receive",
          description: "vault shares",
          protocol: "yld",
        }),
      ]),
    },
  };
}

/**
 * Special input token (external vault / illiquid token) → illiquid token.
 */
export async function fetchSpecialTokenToIlliquidRoute(params: {
  fromAddress: string;
  inputToken: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "specialTokenToIlliquid",
      fromAddress: params.fromAddress,
      inputToken: params.inputToken,
      outputToken: params.outputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const { isExternalVaultToken, getExternalVaultConfig } = await import("@/config/vaults");
  const slippageBps = validateSlippage(params.slippage);
  const ctx: ConversionContext = {
    fromAddress: params.fromAddress,
    slippage: params.slippage,
    slippageBps,
    totalSlippageBps: getBufferedSlippageBps(slippageBps),
  };

  const { actions, state: initialState, steps } = await buildInitialConversionState({
    inputToken: params.inputToken,
    amountIn: params.amountIn,
    targetToken: params.outputToken,
    ctx,
  });
  const routeSteps = [...steps];
  const finalState = await convertStateToToken(actions, initialState, params.outputToken, ctx, routeSteps);

  actions.push({
    protocol: "erc20",
    action: "transfer",
    args: {
      token: params.outputToken,
      amount: finalState.amountRef,
      receiver: params.fromAddress,
    },
  });

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: true,
  });

  bundleResult.amountsOut = {
    ...bundleResult.amountsOut,
    [params.outputToken.toLowerCase()]: finalState.expectedAmount.toString(),
  };

  const outputSymbol = getTokenSymbol(params.outputToken);
  const inputExternalConfig = isExternalVaultToken(params.inputToken)
    ? getExternalVaultConfig(params.inputToken)
    : undefined;

  return {
    ...bundleResult,
    routeInfo: {
      steps: [
        ...routeSteps,
        createRouteStep({
          tokenAddress: params.outputToken,
          tokenSymbol: outputSymbol,
          amount: finalState.expectedAmount,
          action: "Receive",
          description: "tokens",
          protocol: routeSteps.length > 0 ? routeSteps[routeSteps.length - 1].protocol : (inputExternalConfig?.protocol ?? "Custom"),
        }),
      ],
      ...buildRouteMetadataFromSteps([
        ...routeSteps,
        createRouteStep({
          tokenAddress: params.outputToken,
          tokenSymbol: outputSymbol,
          amount: finalState.expectedAmount,
          action: "Receive",
          description: "tokens",
          protocol: routeSteps.length > 0 ? routeSteps[routeSteps.length - 1].protocol : (inputExternalConfig?.protocol ?? "Custom"),
        }),
      ]),
    },
  };
}

/**
 * Special input token (external vault / illiquid token) → external vault.
 */
export async function fetchSpecialTokenToExternalVaultRoute(params: {
  fromAddress: string;
  inputToken: string;
  outputVault: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "specialTokenToExternalVault",
      fromAddress: params.fromAddress,
      inputToken: params.inputToken,
      outputVault: params.outputVault,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const { getExternalVaultConfig } = await import("@/config/vaults");
  const outputConfig = getExternalVaultConfig(params.outputVault);
  if (!outputConfig) {
    throw new Error(`Unknown external vault: ${params.outputVault}`);
  }

  const slippageBps = validateSlippage(params.slippage);
  const ctx: ConversionContext = {
    fromAddress: params.fromAddress,
    slippage: params.slippage,
    slippageBps,
    totalSlippageBps: getBufferedSlippageBps(slippageBps),
  };

  const { actions, state: initialState, steps } = await buildInitialConversionState({
    inputToken: params.inputToken,
    amountIn: params.amountIn,
    targetToken: outputConfig.underlying,
    ctx,
  });
  const routeSteps = [...steps];
  const finalState = await convertStateToToken(actions, initialState, outputConfig.underlying, ctx, routeSteps);

  if (outputConfig.interface === "erc4626") {
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: outputConfig.underlying,
        tokenOut: outputConfig.address,
        amountIn: finalState.amountRef,
        primaryAddress: outputConfig.address,
      },
    });
  } else if (outputConfig.interface === "ucrv") {
    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: outputConfig.underlying,
          spender: outputConfig.address,
          amount: finalState.amountRef,
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: outputConfig.address,
          method: "deposit",
          abi: "function deposit(address _to, uint256 _amount) returns (uint256)",
          args: [params.fromAddress, finalState.amountRef],
        },
      },
    );
  } else {
    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: outputConfig.underlying,
          spender: outputConfig.address,
          amount: finalState.amountRef,
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: outputConfig.address,
          method: "deposit",
          abi: "function deposit(uint256 _amount)",
          args: [finalState.amountRef],
        },
      },
    );
    actions.push({
      protocol: "enso",
      action: "balance",
      args: { token: outputConfig.address },
    });
    const shareBalanceIdx = actions.length - 1;
    actions.push({
      protocol: "erc20",
      action: "transfer",
      args: {
        token: outputConfig.address,
        amount: { useOutputOfCallAt: shareBalanceIdx },
        receiver: params.fromAddress,
      },
    });
  }

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: true,
  });

  const expectedShares = await estimateExternalVaultShares({
    vaultAddress: outputConfig.address,
    vaultInterface: outputConfig.interface,
    underlyingAmount: finalState.expectedAmount,
  });

  bundleResult.amountsOut = {
    ...bundleResult.amountsOut,
    [outputConfig.address.toLowerCase()]: expectedShares,
    [outputConfig.underlying.toLowerCase()]: finalState.expectedAmount.toString(),
  };

  const underlyingSymbol = getTokenSymbol(outputConfig.underlying);

  return {
    ...bundleResult,
    routeInfo: {
      steps: [
        ...routeSteps,
        createRouteStep({
          tokenAddress: outputConfig.underlying,
          tokenSymbol: underlyingSymbol,
          amount: finalState.expectedAmount,
          action: "Deposit",
          description: `${underlyingSymbol} into ${outputConfig.symbol}`,
          protocol: outputConfig.protocol,
        }),
        createRouteStep({
          tokenAddress: outputConfig.address,
          tokenSymbol: outputConfig.symbol,
          amount: expectedShares,
          action: "Receive",
          description: "vault shares",
          protocol: outputConfig.protocol,
        }),
      ],
      ...buildRouteMetadataFromSteps([
        ...routeSteps,
        createRouteStep({
          tokenAddress: outputConfig.underlying,
          tokenSymbol: underlyingSymbol,
          amount: finalState.expectedAmount,
          action: "Deposit",
          description: `${underlyingSymbol} into ${outputConfig.symbol}`,
          protocol: outputConfig.protocol,
        }),
        createRouteStep({
          tokenAddress: outputConfig.address,
          tokenSymbol: outputConfig.symbol,
          amount: expectedShares,
          action: "Receive",
          description: "vault shares",
          protocol: outputConfig.protocol,
        }),
      ]),
    },
  };
}

/**
 * yld vault → illiquid token.
 */
export async function fetchYldVaultToIlliquidRoute(params: {
  fromAddress: string;
  sourceVault: string;
  sourceUnderlying: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "yldVaultToIlliquid",
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      outputToken: params.outputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const amountIn = params.amountIn;
  const expectedUnderlying = BigInt(await previewRedeem(params.sourceVault, amountIn));
  const slippageBps = validateSlippage(params.slippage);
  const ctx: ConversionContext = {
    fromAddress: params.fromAddress,
    slippage: params.slippage,
    slippageBps,
    totalSlippageBps: getBufferedSlippageBps(slippageBps),
  };

  const actions: EnsoBundleAction[] = [
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.sourceVault,
        tokenOut: params.sourceUnderlying,
        amountIn,
        primaryAddress: params.sourceVault,
      },
    },
  ];
  const initialState: ConversionState = {
    token: params.sourceUnderlying,
    amountRef: { useOutputOfCallAt: 0 },
    expectedAmount: expectedUnderlying,
  };
  const routeSteps: RouteStep[] = [
    createRouteStep({
      tokenAddress: params.sourceVault,
      tokenSymbol: getTokenSymbol(params.sourceVault),
      amount: amountIn,
      action: "Redeem",
      description: `${getTokenSymbol(params.sourceVault)} for ${getTokenSymbol(params.sourceUnderlying)}`,
      protocol: "yld",
    }),
  ];
  const finalState = await convertStateToToken(actions, initialState, params.outputToken, ctx, routeSteps);

  actions.push({
    protocol: "erc20",
    action: "transfer",
    args: {
      token: params.outputToken,
      amount: finalState.amountRef,
      receiver: params.fromAddress,
    },
  });

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: true,
  });

  bundleResult.amountsOut = {
    ...bundleResult.amountsOut,
    [params.sourceUnderlying.toLowerCase()]: expectedUnderlying.toString(),
    [params.outputToken.toLowerCase()]: finalState.expectedAmount.toString(),
  };

  const outputSymbol = getTokenSymbol(params.outputToken);
  const finalProtocol = routeSteps.length > 0 ? routeSteps[routeSteps.length - 1].protocol : "Custom";

  return {
    ...bundleResult,
    routeInfo: {
      steps: [
        ...routeSteps,
        createRouteStep({
          tokenAddress: params.outputToken,
          tokenSymbol: outputSymbol,
          amount: finalState.expectedAmount,
          action: "Receive",
          description: "tokens",
          protocol: finalProtocol,
        }),
      ],
      ...buildRouteMetadataFromSteps([
        ...routeSteps,
        createRouteStep({
          tokenAddress: params.outputToken,
          tokenSymbol: outputSymbol,
          amount: finalState.expectedAmount,
          action: "Receive",
          description: "tokens",
          protocol: finalProtocol,
        }),
      ]),
    },
  };
}

// ============================================================================
// YLD Vault → External Vault (universal-zap: case-2 extension)
// ============================================================================

/**
 * Yld vault → external vault (uCVX / aCVX / afCVX / uCRV / aCRV / mooCvxCRV
 * / mooCvxCVX / scrvUSD).
 *
 * Case-2's generic yld-to-token flow tries to Enso-route its CVX output to the
 * external vault directly, but Enso has no liquidity for those tokens, so it
 * falls back to "no route" / 99% price impact. This function builds the full
 * path inline instead:
 *
 *   1. Redeem the yld vault to its underlying (CVX / cvxCRV / pxCVX).
 *   2. Convert pxCVX → CVX (via lpxCVX Curve pool). For CVX / cvxCRV sources
 *      this step is skipped.
 *   3. If the target external vault's underlying differs from the intermediate,
 *      read the runtime intermediate balance and route it through Enso.
 *      For pxCVX targets (uCVX) we use the Curve hybrid mint/swap instead.
 *   4. Deposit into the target via the vault's specific interface (erc4626,
 *      uCRV's non-standard deposit, or Beefy's deposit+transfer pattern).
 *
 * All steps execute atomically in one Enso weiroll bundle.
 */
export async function fetchYldVaultToExternalVaultRoute(params: {
  fromAddress: string;
  sourceVault: string;
  sourceUnderlying: string;
  targetVault: string;
  targetUnderlying: string;
  targetInterface: "erc4626" | "ucrv" | "beefy";
  targetSymbol: string;
  targetProtocol: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "yldVaultToExternalVault",
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      targetVault: params.targetVault,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const { PIREX, LLAMA_AIRFORCE } = await import("@/config/vaults");
  const slippageBps = validateSlippage(params.slippage);
  const totalSlippageBps = getBufferedSlippageBps(slippageBps);
  const sourceUnderlyingLower = params.sourceUnderlying.toLowerCase();
  const targetUnderlyingLower = params.targetUnderlying.toLowerCase();
  const amountIn = params.amountIn;

  const sourceIsCvxCrv = sourceUnderlyingLower === TOKENS.CVXCRV.toLowerCase();
  const sourceIsPxCvx = sourceUnderlyingLower === TOKENS.PXCVX.toLowerCase();
  const sourceIsCvx = sourceUnderlyingLower === TOKENS.CVX.toLowerCase();

  if (!sourceIsCvx && !sourceIsCvxCrv && !sourceIsPxCvx) {
    throw new Error(`Unsupported yld vault underlying ${params.sourceUnderlying} for external-vault zap`);
  }

  // ── Step 1: Estimate intermediate amount (the token we'll have after the
  //    yld-vault redeem + any required unwrap to CVX/cvxCRV).
  // ──────────────────────────────────────────────────────────────────────
  const expectedUnderlying = await previewRedeem(params.sourceVault, amountIn);
  let intermediateToken: string;
  let estimatedIntermediate: bigint;
  // pxCVX source into a pxCVX-backed target (e.g. yspxCVX -> uCVX) deposits the redeemed pxCVX as is.
  const pxCvxPassThrough = sourceIsPxCvx && targetUnderlyingLower === TOKENS.PXCVX.toLowerCase();
  if (sourceIsCvx || sourceIsCvxCrv || pxCvxPassThrough) {
    // The redeem already yields a usable token at EnsoShortcuts; no unwrap step needed.
    intermediateToken = sourceIsCvx ? TOKENS.CVX : sourceIsCvxCrv ? TOKENS.CVXCRV : TOKENS.PXCVX;
    estimatedIntermediate = BigInt(expectedUnderlying);
  } else {
    // pxCVX → wrap to lpxCVX (1:1) → swap to CVX. The lpxCVX pool is a CryptoSwap
    // pool (uint256 indices), which getCurveGetDy's int128 get_dy cannot quote.
    intermediateToken = TOKENS.CVX;
    estimatedIntermediate = await getLpxCvxToCvxSwapRate(expectedUnderlying);
  }

  if (estimatedIntermediate === 0n) {
    throw new Error(`Failed to estimate ${sourceIsCvxCrv ? "cvxCRV" : "CVX"} output from ${params.sourceVault}`);
  }

  const actions: EnsoBundleAction[] = [];

  // ── Step 2: Redeem yld vault to its underlying (land at ENSO_SHORTCUTS).
  // ──────────────────────────────────────────────────────────────────────
  actions.push({
    protocol: "erc4626",
    action: "redeem",
    args: {
      tokenIn: params.sourceVault,
      tokenOut: params.sourceUnderlying,
      amountIn,
      primaryAddress: params.sourceVault,
    },
  });
  const redeemIdx = actions.length - 1;

  // ── Step 3: Convert underlying → intermediate token (CVX for pxCVX).
  // ──────────────────────────────────────────────────────────────────────
  if (sourceIsPxCvx && !pxCvxPassThrough) {
    const cvxMinDy = calculateMinDy(estimatedIntermediate, totalSlippageBps);
    // Wrap pxCVX → lpxCVX (1:1), then Curve swap → CVX.
    actions.push(
      { protocol: "erc20", action: "approve", args: { token: TOKENS.PXCVX, spender: PIREX.LPXCVX, amount: { useOutputOfCallAt: redeemIdx } } },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX,
          method: "wrap",
          abi: "function wrap(uint256 amount)",
          args: [{ useOutputOfCallAt: redeemIdx }],
        },
      },
      { protocol: "erc20", action: "approve", args: { token: PIREX.LPXCVX, spender: PIREX.LPXCVX_CVX_POOL, amount: { useOutputOfCallAt: redeemIdx } } },
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
            { useOutputOfCallAt: redeemIdx },
            cvxMinDy,
          ],
        },
      },
    );
  }

  // After step 3 the intermediate token (CVX or cvxCRV) sits at ENSO_SHORTCUTS.
  // Every later action reads its runtime balance, so expected amounts use the unbuffered
  // estimate; a buffered one under-reported the output and loosened the intent guard's minimum.

  // ── Step 4: Convert intermediate → target underlying if different.
  // ──────────────────────────────────────────────────────────────────────
  const sameUnderlying = intermediateToken.toLowerCase() === targetUnderlyingLower;
  const targetIsPxCvx = targetUnderlyingLower === TOKENS.PXCVX.toLowerCase();
  let totalExpectedTargetUnderlying = estimatedIntermediate;
  // Route steps the shared conversion engine records for the intermediate → pxCVX leg.
  const pxCvxConversionSteps: RouteStep[] = [];

  if (!sameUnderlying && targetIsPxCvx) {
    // CVX → pxCVX via the shared hybrid Curve swap + Pirex mint, on the runtime balance (a
    // fixed split sized from the buffered estimate would leave the buffer at EnsoShortcuts).
    // A cvxCRV intermediate is routed to CVX first by the shared conversion engine.
    const conversionCtx = { fromAddress: params.fromAddress, slippage: params.slippage, slippageBps, totalSlippageBps };
    const intermediateState = toBalanceState(actions, intermediateToken, estimatedIntermediate);
    const pxCvxState = intermediateToken.toLowerCase() === TOKENS.CVX.toLowerCase()
      ? await appendCvxToPxCvxConversion(actions, intermediateState, conversionCtx, pxCvxConversionSteps)
      : await convertStateToToken(actions, intermediateState, TOKENS.PXCVX, conversionCtx, pxCvxConversionSteps);
    totalExpectedTargetUnderlying = pxCvxState.expectedAmount;
  } else if (!sameUnderlying) {
    // Quote for display/preview only. Execution uses the runtime intermediate
    // balance through Enso's native dynamic route action.
    const dynamicQuote = await fetchDynamicInputEstimate({
      fromAddress: params.fromAddress,
      tokenIn: intermediateToken,
      tokenOut: params.targetUnderlying,
      amountIn: estimatedIntermediate.toString(),
      slippage: params.slippage ?? "100",
    });
    totalExpectedTargetUnderlying = BigInt(dynamicQuote.amountOut);
    actions.push({
      protocol: "enso",
      action: "balance",
      args: { token: intermediateToken },
    });
    const intermediateBalanceIdx = actions.length - 1;
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: intermediateToken,
        tokenOut: params.targetUnderlying,
        amountIn: { useOutputOfCallAt: intermediateBalanceIdx },
        slippage: params.slippage ?? "100",
      },
    });
    appendDynamicRouteFloor(actions, actions.length - 1, totalExpectedTargetUnderlying, params.slippage);
  }

  // ── Step 5: Read target-underlying balance at ENSO_SHORTCUTS.
  // ──────────────────────────────────────────────────────────────────────
  actions.push({
    protocol: "enso",
    action: "balance",
    args: { token: params.targetUnderlying },
  });
  const balanceIdx = actions.length - 1;

  // ── Step 6: Deposit into target external vault using its specific interface.
  // ──────────────────────────────────────────────────────────────────────
  if (params.targetInterface === "erc4626") {
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: params.targetUnderlying,
        tokenOut: params.targetVault,
        amountIn: { useOutputOfCallAt: balanceIdx },
        primaryAddress: params.targetVault,
      },
    });
  } else if (params.targetInterface === "ucrv") {
    actions.push(
      { protocol: "erc20", action: "approve", args: { token: params.targetUnderlying, spender: params.targetVault, amount: { useOutputOfCallAt: balanceIdx } } },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: params.targetVault,
          method: "deposit",
          abi: "function deposit(address _to, uint256 _amount) returns (uint256)",
          args: [params.fromAddress, { useOutputOfCallAt: balanceIdx }],
        },
      },
    );
  } else {
    // beefy — deposit(uint256) is void, so read share balance after and transfer.
    actions.push(
      { protocol: "erc20", action: "approve", args: { token: params.targetUnderlying, spender: params.targetVault, amount: { useOutputOfCallAt: balanceIdx } } },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: params.targetVault,
          method: "deposit",
          abi: "function deposit(uint256 _amount)",
          args: [{ useOutputOfCallAt: balanceIdx }],
        },
      },
    );
    actions.push({ protocol: "enso", action: "balance", args: { token: params.targetVault } });
    const shareBalanceIdx = actions.length - 1;
    actions.push({
      protocol: "erc20",
      action: "transfer",
      args: { token: params.targetVault, amount: { useOutputOfCallAt: shareBalanceIdx }, receiver: params.fromAddress },
    });
  }

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: true,
  });

  // ── Step 7: Populate amountsOut manually (skipQuote=true returns empty).
  // ──────────────────────────────────────────────────────────────────────
  let expectedShares = totalExpectedTargetUnderlying.toString();
  try {
    if (params.targetInterface === "erc4626") {
      const selector = "0xef8b30f7"; // previewDeposit(uint256)
      const data = selector + totalExpectedTargetUnderlying.toString(16).padStart(64, "0");
      const res = await rpcWithFallback<{ result?: string }>({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: params.targetVault, data }, "latest"],
      });
      if (res.result && res.result !== "0x") expectedShares = BigInt(res.result).toString();
    } else if (params.targetInterface === "beefy") {
      const res = await rpcWithFallback<{ result?: string }>({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: params.targetVault, data: "0x77c7b8fc" }, "latest"], // getPricePerFullShare
      });
      const pps = BigInt(res.result || "0");
      if (pps > 0n) {
        expectedShares = ((totalExpectedTargetUnderlying * BigInt(10 ** 18)) / pps).toString();
      }
    } else {
      // ucrv: shares = amount × totalSupply / totalUnderlying
      const [uRes, tsRes] = await Promise.all([
        rpcWithFallback<{ result?: string }>({ jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: params.targetVault, data: "0xc70920bc" }, "latest"] }),
        rpcWithFallback<{ result?: string }>({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: params.targetVault, data: "0x18160ddd" }, "latest"] }),
      ]);
      const totalUnderlying = BigInt(uRes.result || "0");
      const totalSupply = BigInt(tsRes.result || "0");
      if (totalUnderlying > 0n && totalSupply > 0n) {
        expectedShares = ((totalExpectedTargetUnderlying * totalSupply) / totalUnderlying).toString();
      }
    }
  } catch { /* keep estimate */ }

  bundleResult.amountsOut = {
    ...bundleResult.amountsOut,
    [params.targetVault.toLowerCase()]: expectedShares,
    [params.targetUnderlying.toLowerCase()]: totalExpectedTargetUnderlying.toString(),
    [intermediateToken.toLowerCase()]: estimatedIntermediate.toString(),
    [params.sourceUnderlying.toLowerCase()]: expectedUnderlying,
  };

  // ── Step 8: Build route steps.
  // ──────────────────────────────────────────────────────────────────────
  const sourceSymbol = getTokenSymbol(params.sourceVault);
  const sourceUnderlyingSymbol = getTokenSymbol(params.sourceUnderlying);
  const intermediateSymbol = getTokenSymbol(intermediateToken);
  const targetUnderlyingSymbol = getTokenSymbol(params.targetUnderlying);
  const steps: RouteStep[] = [
    { tokenSymbol: sourceSymbol, amount: formatRouteAmount(amountIn, params.sourceVault), action: "Redeem", description: `${sourceSymbol} for ${sourceUnderlyingSymbol}`, protocol: "yld" },
  ];

  if (sourceIsPxCvx) {
    // pxCVX → CVX swap step
    steps.push({ tokenSymbol: sourceUnderlyingSymbol, amount: formatRouteAmount(expectedUnderlying, params.sourceUnderlying), action: "Swap", description: `${sourceUnderlyingSymbol} → lpxCVX → CVX`, protocol: "Pirex" });
  }

  if (!sameUnderlying) {
    if (targetIsPxCvx) {
      // The engine's own steps name the real legs (e.g. cvxCRV → CVX, then CVX → pxCVX).
      steps.push(...pxCvxConversionSteps);
    } else {
      steps.push({ tokenSymbol: intermediateSymbol, amount: formatRouteAmount(estimatedIntermediate, intermediateToken), action: "Swap", description: `${intermediateSymbol} for ${targetUnderlyingSymbol}`, protocol: "Enso" });
    }
  }

  steps.push(
    { tokenSymbol: targetUnderlyingSymbol, amount: formatRouteAmount(totalExpectedTargetUnderlying, params.targetUnderlying), action: "Deposit", description: `${targetUnderlyingSymbol} into ${params.targetSymbol}`, protocol: params.targetProtocol },
    { tokenSymbol: params.targetSymbol, amount: formatRouteAmount(expectedShares, params.targetVault), action: "Receive", description: "vault shares", protocol: params.targetProtocol },
  );

  // Silence unused-var warning; LLAMA_AIRFORCE may be useful for future refinements.
  void LLAMA_AIRFORCE;

  return {
    ...bundleResult,
    routeInfo: {
      steps,
      tokens: [sourceSymbol, sourceUnderlyingSymbol, intermediateSymbol, targetUnderlyingSymbol, params.targetSymbol],
      protocols: ["yld", sourceIsPxCvx ? "Pirex" : "yld", "Enso", params.targetProtocol],
    },
  };
}
