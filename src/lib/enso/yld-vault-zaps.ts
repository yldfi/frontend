import type {
  CustomBundleResponse,
  EnsoBundleAction,
  EnsoBundleResponse,
  RouteInfo,
  RouteStep,
} from "@/types/enso";
import { TOKENS, VAULTS } from "@/config/vaults";
import {
  calculateMinDy,
  getEthToCvxEstimate,
  previewRedeem,
  validateSlippage,
} from "@/lib/curve";
import {
  fetchEnsoIntent,
  getYldVaultToVaultIntentName,
  isStandardYldVaultIntentVault,
} from "@/lib/enso-intents";
import { estimateRouteOutput, fetchBundle, rpcWithFallback } from "./api";
import {
  appendETHUnwrapIfNeeded,
  appendTerminalSlippageGuard,
  applySlippageBuffer,
  buildRouteMetadataFromSteps,
  createRouteStep,
  formatRouteDeltaAmount,
  getBufferedSlippageBps,
  intermediateApproveAction,
  pushCvxToPxCvxSwapActions,
  remainingCvxForMint,
  runtimeSplitOutput,
  type BundleAmountRef,
} from "./bundle-helpers";
import { CVXCRV_ADDRESS, ENSO_SHORTCUTS } from "./constants";
import {
  getLpxCvxToCvxSwapRate,
  getOptimalPxCvxSwapAmount,
  getPxCvxSwapRate,
} from "./pxcvx-pool";
import { getTokenSymbol } from "./tokens";
import { fetchYldVaultToExternalVaultRoute } from "./external-vault-routes";

/**
 * Create a Zap Out bundle (redeem from vault + swap to any token)
 * Used when user wants to exit vault directly to ETH, USDC, etc.
 */
export async function fetchZapOutRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
  underlyingToken?: string; // defaults to cvxCRV
}): Promise<EnsoBundleResponse> {
  if (typeof window !== "undefined" && isStandardYldVaultIntentVault(params.vaultAddress)) {
    return fetchEnsoIntent<EnsoBundleResponse>({
      intent: "yldVaultZapOut",
      fromAddress: params.fromAddress,
      vaultAddress: params.vaultAddress,
      outputToken: params.outputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const underlying = params.underlyingToken || CVXCRV_ADDRESS;
  const amountIn = params.amountIn;
  const outputIsUnderlying = underlying.toLowerCase() === params.outputToken.toLowerCase();
  const actions: EnsoBundleAction[] = [
    // Step 1: Redeem from vault to get underlying token (cvxCRV)
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.vaultAddress,
        tokenOut: underlying,
        amountIn,
        primaryAddress: params.vaultAddress,
      },
    },
  ];

  if (!outputIsUnderlying) {
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: underlying,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: 0 }, // Use output from redeem
        slippage: params.slippage ?? "100",
      },
    });
  }

  appendETHUnwrapIfNeeded(actions, params.outputToken);
  appendTerminalSlippageGuard(actions, params.slippage ?? "100");

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    skipQuote: false, // Standard zap doesn't depend on account state — need amountsOut
  });
}

/**
 * Create a Zap In bundle (swap any token + deposit to vault)
 * Used when user wants to enter vault from ETH, USDC, etc.
 */
export async function fetchZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  inputToken: string;
  amountIn: string;
  slippage?: string;
  underlyingToken?: string; // defaults to cvxCRV
}): Promise<EnsoBundleResponse> {
  if (typeof window !== "undefined" && isStandardYldVaultIntentVault(params.vaultAddress)) {
    return fetchEnsoIntent<EnsoBundleResponse>({
      intent: "yldVaultZapIn",
      fromAddress: params.fromAddress,
      vaultAddress: params.vaultAddress,
      inputToken: params.inputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const underlying = params.underlyingToken || CVXCRV_ADDRESS;
  const amountIn = params.amountIn;

  const inputIsUnderlying = params.inputToken.toLowerCase() === underlying.toLowerCase();
  const actions: EnsoBundleAction[] = [];

  if (!inputIsUnderlying) {
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.inputToken,
        tokenOut: underlying,
        amountIn,
        slippage: params.slippage ?? "100",
      },
    });
  }

  actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: underlying,
        tokenOut: params.vaultAddress,
        amountIn: inputIsUnderlying ? amountIn : { useOutputOfCallAt: 0 },
        primaryAddress: params.vaultAddress,
      },
    });

  appendTerminalSlippageGuard(actions, params.slippage ?? "100");

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    skipQuote: false, // Standard zap doesn't depend on account state — need amountsOut
  });
}

/**
 * Create a vault-to-vault zap bundle (redeem from source, deposit to target)
 * Handles vaults with different underlying tokens by adding a swap step
 */
export async function fetchVaultToVaultRoute(params: {
  fromAddress: string;
  sourceVault: string;
  targetVault: string;
  amountIn: string;
  sourceUnderlyingToken?: string; // Source vault's underlying - looked up from VAULTS if not provided
  targetUnderlyingToken?: string; // Target vault's underlying - looked up from VAULTS if not provided
  slippage?: string; // basis points, default "100" = 1%
}): Promise<EnsoBundleResponse> {
  // Block same-vault zaps (pointless)
  if (params.sourceVault.toLowerCase() === params.targetVault.toLowerCase()) {
    throw new Error("Cannot zap from a vault to itself");
  }

  if (typeof window !== "undefined") {
    const intent = getYldVaultToVaultIntentName({
      sourceVault: params.sourceVault,
      targetVault: params.targetVault,
    });
    if (!intent) {
      throw new Error("sourceVault and targetVault must be known YLD vaults");
    }
    return fetchEnsoIntent<EnsoBundleResponse>({
      intent,
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      targetVault: params.targetVault,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  // Look up underlying tokens from VAULTS config if not provided
  const sourceVaultConfig = Object.values(VAULTS).find(v => v.address.toLowerCase() === params.sourceVault.toLowerCase());
  const targetVaultConfig = Object.values(VAULTS).find(v => v.address.toLowerCase() === params.targetVault.toLowerCase());

  const sourceUnderlying = params.sourceUnderlyingToken ?? sourceVaultConfig?.assetAddress ?? TOKENS.CVXCRV;
  const targetUnderlying = params.targetUnderlyingToken ?? targetVaultConfig?.assetAddress ?? TOKENS.CVXCRV;
  const sourceVaultSymbol = sourceVaultConfig?.symbol ?? getTokenSymbol(params.sourceVault);
  const targetVaultSymbol = targetVaultConfig?.symbol ?? getTokenSymbol(params.targetVault);
  const sourceUnderlyingSymbol = getTokenSymbol(sourceUnderlying);
  const slippage = params.slippage ?? "100";
  const amountIn = params.amountIn;

  // Same-underlying vault-to-vault: simple redeem → deposit (no swap needed)
  const sameUnderlying = sourceUnderlying.toLowerCase() === targetUnderlying.toLowerCase();
  if (sameUnderlying) {
    const actions: EnsoBundleAction[] = [
      {
        protocol: "erc4626",
        action: "redeem",
        args: {
          tokenIn: params.sourceVault,
          tokenOut: sourceUnderlying,
          amountIn,
          primaryAddress: params.sourceVault,
        },
      },
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: sourceUnderlying,
          tokenOut: params.targetVault,
          amountIn: { useOutputOfCallAt: 0 },
          primaryAddress: params.targetVault,
        },
      },
    ];
    appendTerminalSlippageGuard(actions, slippage);

    const bundleResult = await fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      receiver: params.fromAddress,
      skipQuote: false, // Standard V2V doesn't depend on account state — need amountsOut
    });

    let redeemedUnderlyingAmount: string | undefined;
    try {
      redeemedUnderlyingAmount = await previewRedeem(params.sourceVault, amountIn);
    } catch {
      redeemedUnderlyingAmount = undefined;
    }

    const steps: RouteStep[] = [
      createRouteStep({
        tokenAddress: params.sourceVault,
        tokenSymbol: sourceVaultSymbol,
        amount: amountIn,
        action: "Redeem",
        description: `${sourceVaultSymbol} for ${sourceUnderlyingSymbol}`,
        protocol: "yld",
      }),
      createRouteStep({
        tokenAddress: sourceUnderlying,
        tokenSymbol: sourceUnderlyingSymbol,
        amount: redeemedUnderlyingAmount,
        action: "Deposit",
        description: `into ${targetVaultSymbol}`,
        protocol: "yld",
      }),
      createRouteStep({
        tokenAddress: params.targetVault,
        tokenSymbol: targetVaultSymbol,
        action: "Receive",
        description: `${targetVaultSymbol} shares`,
        protocol: "yld",
      }),
    ];

    return {
      ...bundleResult,
      routeInfo: {
        steps,
        ...buildRouteMetadataFromSteps(steps),
      },
    };
  }

  // Check if pxCVX is involved - requires custom routing via Pirex
  const targetIsPxCvx = targetUnderlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();
  const sourceIsPxCvx = sourceUnderlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();

  if (sourceIsPxCvx) {
    // Zapping FROM pxCVX vault: redeem → swap via lpxCVX → route/wrap → deposit
    return fetchPxCvxVaultToVaultRoute({
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      targetVault: params.targetVault,
      amountIn,
      targetUnderlyingToken: targetUnderlying,
      slippage,
    });
  }

  if (targetIsPxCvx) {
    // A single Enso route between the two share tokens has no real liquidity and fills
    // through dust (~100% loss on fork). Redeem, convert to pxCVX and deposit instead.
    return fetchYldVaultToExternalVaultRoute({
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      sourceUnderlying,
      targetVault: params.targetVault,
      targetUnderlying,
      targetInterface: "erc4626",
      targetSymbol: targetVaultSymbol,
      targetProtocol: "yld",
      amountIn,
      slippage,
    });
  }

  // Different underlyings: redeem → swap → deposit
  // Use Enso route action to swap between different underlying tokens
  const actions: EnsoBundleAction[] = [
    // Step 1: Redeem from source vault to get source underlying
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.sourceVault,
        tokenOut: sourceUnderlying,
        amountIn: params.amountIn,
        primaryAddress: params.sourceVault,
      },
    },
    // Step 2: Swap source underlying → target underlying via Enso router
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: sourceUnderlying,
        tokenOut: targetUnderlying,
        amountIn: { useOutputOfCallAt: 0 },
        slippage,
      },
    },
    // Step 3: Deposit target underlying into target vault
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: targetUnderlying,
        tokenOut: params.targetVault,
        amountIn: { useOutputOfCallAt: 1 },
        primaryAddress: params.targetVault,
      },
    },
  ];
  appendTerminalSlippageGuard(actions, slippage);

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    skipQuote: false, // Standard V2V doesn't depend on account state — need amountsOut
  });
  let redeemedUnderlyingAmount: string | undefined;
  let expectedTargetUnderlying =
    bundleResult.amountsOut[targetUnderlying.toLowerCase()] ??
    bundleResult.amountsOut[targetUnderlying];
  try {
    redeemedUnderlyingAmount = await previewRedeem(params.sourceVault, amountIn);
    expectedTargetUnderlying ??= await estimateRouteOutput(
      params.fromAddress,
      sourceUnderlying,
      targetUnderlying,
      redeemedUnderlyingAmount,
      slippage,
    );
  } catch {
    // Amounts are display-only metadata; never reject an executable bundle if
    // an optional preview endpoint is temporarily unavailable.
  }
  const targetShares =
    bundleResult.amountsOut[params.targetVault.toLowerCase()] ??
    bundleResult.amountsOut[params.targetVault];
  const steps: RouteStep[] = [
    createRouteStep({
      tokenAddress: params.sourceVault,
      tokenSymbol: sourceVaultSymbol,
      amount: amountIn,
      action: "Redeem",
      description: `${sourceVaultSymbol} for ${sourceUnderlyingSymbol}`,
      protocol: "yld",
    }),
    createRouteStep({
      tokenAddress: sourceUnderlying,
      tokenSymbol: sourceUnderlyingSymbol,
      amount: redeemedUnderlyingAmount,
      action: "Swap",
      description: `${sourceUnderlyingSymbol} for ${getTokenSymbol(targetUnderlying)}`,
      protocol: "Enso",
    }),
    createRouteStep({
      tokenAddress: targetUnderlying,
      amount: expectedTargetUnderlying,
      action: "Deposit",
      description: `into ${targetVaultSymbol}`,
      protocol: "yld",
    }),
    createRouteStep({
      tokenAddress: params.targetVault,
      tokenSymbol: targetVaultSymbol,
      amount: targetShares,
      action: "Receive",
      description: `${targetVaultSymbol} shares`,
      protocol: "yld",
    }),
  ];

  return {
    ...bundleResult,
    routeInfo: {
      steps,
      ...buildRouteMetadataFromSteps(steps),
    },
  };
}

/**
 * Custom bundle for zapping FROM a pxCVX vault to another vault
 * Route: pxCVX vault → pxCVX → wrap to lpxCVX → Curve swap → CVX → route → target underlying → target vault
 *
 * NOTE: We can't use lpxCVX.swap() because it returns nothing, making it impossible
 * to reference the output CVX amount in subsequent actions. Instead we break it down:
 * 1. Wrap pxCVX → lpxCVX (1:1 ratio)
 * 2. Swap lpxCVX → CVX on Curve directly (returns amount)
 */
async function fetchPxCvxVaultToVaultRoute(params: {
  fromAddress: string;
  sourceVault: string;
  targetVault: string;
  amountIn: string;
  targetUnderlyingToken: string;
  slippage: string;
}): Promise<EnsoBundleResponse> {
  const { PIREX } = await import("@/config/vaults");

  // Validate slippage parameter
  const slippageBps = validateSlippage(params.slippage);

  // Check if target is CVX - can skip the route step
  const targetIsCvx = params.targetUnderlyingToken.toLowerCase() === TOKENS.CVX.toLowerCase();

  // Calculate estimates upfront for concrete amounts
  // This helps Enso simulate the bundle correctly
  const estimatedPxCvx = await previewRedeem(params.sourceVault, params.amountIn);
  // lpxCVX wraps 1:1 from pxCVX
  const estimatedLpxCvx = estimatedPxCvx;
  // Estimate CVX output from Curve exchange (lpxCVX → CVX)
  const estimatedCvx = await getLpxCvxToCvxSwapRate(estimatedLpxCvx);
  // CRITICAL: Throw if estimation fails or returns zero - never use min_dy=0
  if (estimatedCvx === 0n) {
    throw new Error("Failed to estimate Curve lpxCVX→CVX swap output for slippage protection");
  }
  // Calculate min_dy for the lpxCVX → CVX swap with slippage protection
  const minDyCvx = calculateMinDy(estimatedCvx, slippageBps);

  // Note: Using concrete estimates to help Enso simulate the bundle correctly
  const actions: EnsoBundleAction[] = [
    // Action 0: Redeem from source vault to get pxCVX
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.sourceVault,
        tokenOut: TOKENS.PXCVX,
        amountIn: params.amountIn,
        primaryAddress: params.sourceVault,
      },
    },
    // Action 1: Approve pxCVX to lpxCVX contract for wrapping
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.PXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: 0 },
      },
    },
    // Action 2: Wrap pxCVX → lpxCVX (1:1 ratio, no return value but amount is same)
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
    // Action 3: Approve lpxCVX to Curve pool for swap
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: { useOutputOfCallAt: 0 }, // Same amount as pxCVX (1:1 wrap)
      },
    },
    // Action 4: Swap lpxCVX → CVX on Curve pool (RETURNS the CVX amount!)
    // exchange(i=1, j=0, dx, min_dy) where 1=lpxCVX, 0=CVX
    {
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX_CVX_POOL,
        method: "exchange",
        abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [
          String(PIREX.POOL_INDEX.LPXCVX), // i = 1 (lpxCVX)
          String(PIREX.POOL_INDEX.CVX), // j = 0 (CVX)
          { useOutputOfCallAt: 0 }, // dx = amount (same as pxCVX from redeem)
          minDyCvx, // min_dy with slippage protection
        ],
      },
    },
  ];

  if (targetIsCvx) {
    // Target is CVX - deposit directly into vault
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.targetVault,
        amountIn: { useOutputOfCallAt: 4 }, // Use Curve exchange output
        primaryAddress: params.targetVault,
      },
    });
  } else {
    // Need to route CVX → target underlying via Enso
    actions.push(
      // Action 5: Route CVX → target underlying via Enso
      {
        protocol: "enso",
        action: "route",
        args: {
          tokenIn: TOKENS.CVX,
          tokenOut: params.targetUnderlyingToken,
          amountIn: { useOutputOfCallAt: 4 }, // Use Curve exchange output
          slippage: params.slippage,
        },
      },
      // Action 6: Deposit target underlying into target vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: params.targetUnderlyingToken,
          tokenOut: params.targetVault,
          amountIn: { useOutputOfCallAt: 5 }, // Use route output
          primaryAddress: params.targetVault,
        },
      }
    );
  }

  appendTerminalSlippageGuard(actions, params.slippage);

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: false,
  });
  return bundleResult;
}

/**
 * Check if a token requires custom zap routing (not supported by standard Enso routes)
 */
export function requiresCustomZapRoute(tokenAddress: string): boolean {
  const addr = tokenAddress.toLowerCase();
  // pxCVX requires custom routing through Pirex/lpxCVX/Curve
  return addr === TOKENS.PXCVX.toLowerCase();
}

/**
 * Build route steps for pxCVX zap in
 */
interface PxCvxStepAmounts {
  inputAmount?: string;      // Input token amount (formatted)
  cvxAmount?: string;        // Total CVX amount after first swap (formatted)
  swapCvxAmount?: string;    // CVX amount going to swap (formatted, for hybrid)
  mintCvxAmount?: string;    // CVX amount going to mint (formatted, for hybrid)
  pxCvxAmount?: string;      // pxCVX amount after Curve swap (formatted)
  vaultSharesAmount?: string; // Vault shares received (formatted)
}

function buildPxCvxZapInSteps(
  inputSymbol: string,
  vaultSymbol: string,
  inputIsCvx: boolean,
  swapAmount: bigint,
  mintAmount: bigint,
  swapBonus: number,
  bonusAmount?: string,
  amounts?: PxCvxStepAmounts
): RouteStep[] {
  const steps: RouteStep[] = [];

  // Step 1: Route input to CVX (if not already CVX)
  if (!inputIsCvx && inputSymbol !== "pxCVX") {
    steps.push({
      tokenSymbol: inputSymbol,
      action: "Swap",
      description: `${inputSymbol} for CVX`,
      protocol: "Enso",
      amount: amounts?.inputAmount,
    });
  }

  // Step 2: Swap and/or Mint
  if (swapAmount > 0n && mintAmount > 0n) {
    // Hybrid: both swap and mint - show separate amounts
    steps.push({
      tokenSymbol: "CVX",
      action: "Swap",
      description: "CVX for pxCVX",
      protocol: "Curve",
      amount: amounts?.swapCvxAmount,
      bonus: swapBonus,
      bonusAmount,
      bonusSymbol: "pxCVX",
    });
    steps.push({
      tokenSymbol: "CVX",
      action: "Mint",
      description: "pxCVX with CVX",
      protocol: "Pirex",
      amount: amounts?.mintCvxAmount,
    });
  } else if (swapAmount > 0n) {
    // 100% swap
    steps.push({
      tokenSymbol: "CVX",
      action: "Swap",
      description: "CVX for pxCVX",
      protocol: "Curve",
      amount: amounts?.cvxAmount,
      bonus: swapBonus,
      bonusAmount,
      bonusSymbol: "pxCVX",
    });
  } else {
    // 100% mint
    steps.push({
      tokenSymbol: "CVX",
      action: "Mint",
      description: "pxCVX with CVX",
      protocol: "Pirex",
      amount: amounts?.cvxAmount,
    });
  }

  // Step 3: Deposit into vault
  steps.push({
    tokenSymbol: "pxCVX",
    action: "Deposit",
    description: `pxCVX into ${vaultSymbol}`,
    protocol: "yld",
    amount: amounts?.pxCvxAmount,
  });

  // Step 4: Receive vault shares
  steps.push({
    tokenSymbol: vaultSymbol,
    action: "Receive",
    description: "vault shares",
    protocol: "yld",
    amount: amounts?.vaultSharesAmount,
  });

  return steps;
}

/**
 * Create a custom Zap Out route for pxCVX via Pirex infrastructure
 * Route: vault (redeem) → pxCVX → lpxCVX.swap → CVX → output token
 * When outputToken=CVX: vault → pxCVX → CVX (skips final route)
 *
 * Uses lpxCVX.swap() which internally:
 * 1. Wraps pxCVX to lpxCVX
 * 2. Swaps lpxCVX → CVX via Curve pool
 * 3. Sends CVX directly to caller
 */
export async function fetchPxCvxZapOutRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<EnsoBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<EnsoBundleResponse>({
      intent: "pxCvxZapOut",
      fromAddress: params.fromAddress,
      vaultAddress: params.vaultAddress,
      outputToken: params.outputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const { PIREX } = await import("@/config/vaults");

  // Validate slippage parameter
  const slippageBps = validateSlippage(params.slippage);

  const amountIn = params.amountIn;

  // Check if output is already CVX - skip final route step
  const outputIsCvx = params.outputToken.toLowerCase() === TOKENS.CVX.toLowerCase();

  // Estimate pxCVX output from vault redeem using previewRedeem (throws on failure)
  const expectedPxCvxOutput = await previewRedeem(params.vaultAddress, amountIn);

  // Query Curve CryptoSwap pool get_dy to estimate CVX output from lpxCVX swap
  // Uses uint256 indices: lpxCVX (index 1) to CVX (index 0)
  // pxCVX wraps 1:1 to lpxCVX
  // The legs spend the runtime redeem output (useOutputOfCallAt: 0), so quote the unbuffered amount.
  const expectedCvxOutput = await getLpxCvxToCvxSwapRate(BigInt(expectedPxCvxOutput).toString());

  // CRITICAL: Throw if estimation fails or returns zero - never use min_dy=0
  if (expectedCvxOutput === 0n) {
    throw new Error("Failed to estimate Curve lpxCVX→CVX swap output for slippage protection");
  }

  // Calculate min_dy with slippage
  const minDy = calculateMinDy(expectedCvxOutput, slippageBps);

  // Build actions using wrap + exchange pattern (mirrors zap IN's exchange + unwrap)
  // NOTE: lpxCVX.swap() returns void, so we can't use useOutputOfCallAt with it
  // Use separate wrap + Curve exchange where exchange RETURNS uint256
  // wrap is 1:1 (pxCVX → lpxCVX), so lpxCVX amount equals pxCVX amount
  const actions: EnsoBundleAction[] = [
    // Action 0: Redeem from vault to get pxCVX
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.vaultAddress,
        tokenOut: TOKENS.PXCVX,
        amountIn,
        primaryAddress: params.vaultAddress,
      },
    },
    // Action 1: Approve pxCVX to lpxCVX contract for wrapping
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.PXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: 0 },
      },
    },
    // Action 2: Wrap pxCVX → lpxCVX (1:1 ratio)
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
    // Action 3: Approve lpxCVX to Curve pool (same amount as pxCVX due to 1:1 wrap)
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: { useOutputOfCallAt: 0 }, // Same as pxCVX (1:1 wrap)
      },
    },
    // Action 4: Exchange lpxCVX → CVX on Curve pool (RETURNS uint256!)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX_CVX_POOL,
        method: "exchange",
        abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
        args: [
          String(PIREX.POOL_INDEX.LPXCVX), // i = 1 (lpxCVX)
          String(PIREX.POOL_INDEX.CVX), // j = 0 (CVX)
          { useOutputOfCallAt: 0 }, // dx = same as pxCVX (1:1 wrap)
          minDy, // min_dy with slippage
        ],
      },
    },
  ];

  if (!outputIsCvx) {
    // Output is not CVX - need final route step using Curve exchange output
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: 4 }, // Use Curve exchange output (returns uint256)
        slippage: params.slippage ?? "100",
      },
    });

    // For ETH output: route to WETH + unwrap (avoids weiroll slippage check failure)
    appendETHUnwrapIfNeeded(actions, params.outputToken);
  } else {
    // The raw Curve exchange pays EnsoShortcuts; deliver the CVX explicitly.
    actions.push({
      protocol: "erc20",
      action: "transfer",
      args: { token: TOKENS.CVX, amount: { useOutputOfCallAt: 4 }, receiver: params.fromAddress },
    });
  }

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
  // Enso cannot track a raw call's output, so the intent guard needs the CVX amount from us.
  const cvxKey = TOKENS.CVX.toLowerCase();
  if (outputIsCvx && !bundleResult.amountsOut[cvxKey]) {
    bundleResult.amountsOut = { ...bundleResult.amountsOut, [cvxKey]: expectedCvxOutput.toString() };
  }
  return bundleResult;
}

/**
 * Create a custom Zap In route for pxCVX via Pirex infrastructure
 * Route: input token → CVX → (hybrid swap/mint) → pxCVX → vault
 *
 * Hybrid strategy:
 * - If Curve pool rate > 1:1: swap CVX → pxCVX through lpxCVX.swap()
 * - If rate < 1:1: deposit CVX to Pirex for 1:1 pxCVX
 * - Optimal: split between swap and mint at peg point
 *
 * NOTE: lpxCVX.swap() and PirexCVX.deposit() don't return values, so we
 * read the produced pxCVX balance before the vault deposit.
 */
export async function fetchPxCvxZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  inputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "pxCvxZapIn",
      fromAddress: params.fromAddress,
      vaultAddress: params.vaultAddress,
      inputToken: params.inputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const { PIREX } = await import("@/config/vaults");
  const vaultSymbol = getTokenSymbol(params.vaultAddress);
  const inputSymbol = getTokenSymbol(params.inputToken);

  // Direct-deposit fast path: input is already the vault's underlying (pxCVX).
  // Skip the CVX→pxCVX detour that would otherwise waste 2–3% on routing.
  const inputIsPxCvx = params.inputToken.toLowerCase() === PIREX.PXCVX.toLowerCase();
  if (inputIsPxCvx) {
    const actions: EnsoBundleAction[] = [
      {
        protocol: "erc20",
        action: "approve",
        args: { token: PIREX.PXCVX, spender: params.vaultAddress, amount: params.amountIn },
      },
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: PIREX.PXCVX,
          tokenOut: params.vaultAddress,
          amountIn: params.amountIn,
          primaryAddress: params.vaultAddress,
        },
      },
    ];
    appendTerminalSlippageGuard(actions, params.slippage ?? "100");

    const bundleResult = await fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "router",
    });

    // previewDeposit fallback for vaults Enso can't simulate (e.g. yspxCVX).
    let expectedShares = bundleResult.amountsOut[params.vaultAddress.toLowerCase()]
      || bundleResult.amountsOut[params.vaultAddress];
    if (!expectedShares || BigInt(expectedShares) === 0n) {
      try {
        const previewDepositSelector = "0xef8b30f7";
        const previewData = previewDepositSelector + BigInt(params.amountIn).toString(16).padStart(64, "0");
        const previewResult = await rpcWithFallback<{ result?: string }>({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: params.vaultAddress, data: previewData }, "latest"],
        });
        if (previewResult.result && previewResult.result !== "0x") {
          expectedShares = BigInt(previewResult.result).toString();
        }
      } catch {
        // leave as-is
      }
      if (expectedShares) {
        bundleResult.amountsOut = {
          ...bundleResult.amountsOut,
          [params.vaultAddress.toLowerCase()]: expectedShares,
        };
      }
    }

    return {
      ...bundleResult,
      routeInfo: {
        steps: [
          { tokenSymbol: "pxCVX", action: "Deposit", description: `pxCVX into ${vaultSymbol}`, protocol: "yld" },
          { tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" },
        ],
        tokens: ["pxCVX", vaultSymbol],
        protocols: ["yld"],
      },
    };
  }

  // Check if input is already CVX
  const inputIsCvx = params.inputToken.toLowerCase() === TOKENS.CVX.toLowerCase();

  // Step 1: If not CVX, route input → CVX first
  // We need to estimate the CVX amount we'll get
  let estimatedCvxAmount = params.amountIn;

  if (!inputIsCvx) {
    // Estimate CVX output for optimal split calculation
    const inputIsEth = params.inputToken.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    if (inputIsEth) {
      // Use on-chain Curve pool pricing (RPC call, not Enso API)
      // This avoids Enso rate limits while getting accurate real-time price
      estimatedCvxAmount = await getEthToCvxEstimate(params.amountIn);
    } else {
      // For other tokens, we need a route call
      estimatedCvxAmount = await estimateRouteOutput(
        params.fromAddress,
        params.inputToken,
        TOKENS.CVX,
        params.amountIn,
        params.slippage,
      );
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
  }

  // Step 2: Apply slippage buffer to CVX estimate for non-CVX inputs
  // This ensures we don't try to use more CVX than we actually receive after routing slippage
  const slippageBps = validateSlippage(params.slippage);
  const totalSlippageBps = getBufferedSlippageBps(slippageBps);
  const cvxAmountForSplit = inputIsCvx
    ? estimatedCvxAmount
    : applySlippageBuffer(BigInt(estimatedCvxAmount), slippageBps);

  // Step 3: Calculate optimal swap vs mint split using conservative CVX amount
  const { swapAmount, mintAmount } = await getOptimalPxCvxSwapAmount(cvxAmountForSplit);

  // Step 4: Calculate expected pxCVX output for each path
  // - Swap path: CVX → pxCVX through lpxCVX.swap()
  // - Mint path: CVX → pxCVX (1:1 via Pirex)
  let expectedSwapPxCvx = 0n;
  let swapMinDy = "0";
  if (swapAmount > 0n) {
    const swapOutput = await getPxCvxSwapRate(swapAmount.toString());
    // CRITICAL: Throw if estimation fails or returns zero - never use min_dy=0
    if (!swapOutput || swapOutput === 0n) {
      throw new Error("Failed to estimate Curve CVX→lpxCVX swap output for slippage protection");
    }
    expectedSwapPxCvx = swapOutput;
    swapMinDy = calculateMinDy(swapOutput, totalSlippageBps);
  }
  const expectedMintPxCvx = mintAmount; // 1:1 ratio
  const totalExpectedPxCvx = await runtimeSplitOutput({
    runtimeCvx: inputIsCvx ? BigInt(params.amountIn) : BigInt(estimatedCvxAmount),
    swapAmount,
    mintAmount: expectedMintPxCvx,
    expectedSwapOut: expectedSwapPxCvx,
    quoteSwap: getPxCvxSwapRate,
  });

  // Build actions based on strategy
  const actions: EnsoBundleAction[] = [];
  let actionIndex = 0;

  // Action 0 (if needed): Route input → CVX
  if (!inputIsCvx) {
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.inputToken,
        tokenOut: TOKENS.CVX,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      },
    });
    actionIndex++;
  }

  if (swapAmount > 0n && mintAmount > 0n) {
    // Hybrid strategy: split CVX between swap and mint
    const fixedIntermediateSplit = !inputIsCvx;

    pushCvxToPxCvxSwapActions(
      actions,
      PIREX,
      swapAmount.toString(),
      swapMinDy,
      fixedIntermediateSplit,
    );
    actionIndex += 2;

    // A runtime CVX amount was split from a buffered estimate: mint whatever the swap left.
    const mintInput: BundleAmountRef = fixedIntermediateSplit ? remainingCvxForMint(actions) : mintAmount.toString();
    if (fixedIntermediateSplit) actionIndex++;

    actions.push(intermediateApproveAction(
      TOKENS.CVX,
      PIREX.PIREX_CVX,
      mintInput,
      fixedIntermediateSplit,
    ));
    actionIndex++;

    // Action: Deposit CVX to Pirex → pxCVX (mint to the bundle execution context)
    // deposit(uint256 assets, address receiver, bool shouldCompound, address developer)
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.PIREX_CVX,
        method: "deposit",
        abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
        args: [
          mintInput,
          ENSO_SHORTCUTS,
          false, // shouldCompound — must be a real boolean: Enso encodes the string "false" as true
          "0x0000000000000000000000000000000000000000", // developer
        ],
      },
    });
    actionIndex++;

  } else if (swapAmount > 0n) {
    // Swap-only strategy: rate > 1:1 for full amount
    const swapCvxInput: BundleAmountRef = inputIsCvx
      ? params.amountIn
      : { useOutputOfCallAt: actionIndex - 1 };

    pushCvxToPxCvxSwapActions(actions, PIREX, swapCvxInput, swapMinDy, false);
    actionIndex += 2;

  } else {
    // Mint-only strategy: rate < 1:1, deposit to Pirex for 1:1

    // Action: Approve CVX to Pirex
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.PIREX_CVX,
        amount: inputIsCvx ? params.amountIn : { useOutputOfCallAt: actionIndex - 1 },
      },
    });
    actionIndex++;

    // Action: Deposit CVX to Pirex → pxCVX (mint to the bundle execution context)
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.PIREX_CVX,
        method: "deposit",
        abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
        args: [
          inputIsCvx ? params.amountIn : { useOutputOfCallAt: actionIndex - 2 },
          ENSO_SHORTCUTS,
          false, // shouldCompound — must be a real boolean: Enso encodes the string "false" as true
          "0x0000000000000000000000000000000000000000",
        ],
      },
    });
    actionIndex++;
  }

  // Action: Get actual pxCVX balance in router to avoid pre-funding
  // lpxCVX.swap() and PirexCVX.deposit() don't return values, so we read balance.
  actions.push({
    protocol: "enso",
    action: "balance",
    args: {
      token: PIREX.PXCVX,
    },
  });
  const pxCvxBalanceIdx = actionIndex++;

  // Final action: Deposit pxCVX into vault
  // Use erc4626 action so amountsOut tracks the vault shares
  // NOTE: erc4626 handles approval internally, no manual approve needed
  actions.push({
    protocol: "erc4626",
    action: "deposit",
    args: {
      tokenIn: PIREX.PXCVX,
      tokenOut: params.vaultAddress,
      amountIn: { useOutputOfCallAt: pxCvxBalanceIdx },
      primaryAddress: params.vaultAddress,
    },
  });
  appendTerminalSlippageGuard(actions, params.slippage ?? "100");

  // Fetch bundle result
  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });

  // Get expected vault shares from erc4626 action's amountsOut. Some vaults
  // (e.g. yspxCVX, which is a Yearn V3 BaseStrategy that Enso can't simulate
  // end-to-end) return empty amountsOut, so fall back to previewDeposit.
  let expectedSharesPxCvx = bundleResult.amountsOut[params.vaultAddress.toLowerCase()]
    || bundleResult.amountsOut[params.vaultAddress];
  if (!expectedSharesPxCvx || BigInt(expectedSharesPxCvx) === 0n) {
    try {
      const previewDepositSelector = "0xef8b30f7"; // previewDeposit(uint256)
      const previewData = previewDepositSelector + totalExpectedPxCvx.toString(16).padStart(64, "0");
      const previewResult = await rpcWithFallback<{ result?: string }>({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: params.vaultAddress, data: previewData }, "latest"],
      });
      if (previewResult.result && previewResult.result !== "0x") {
        expectedSharesPxCvx = BigInt(previewResult.result).toString();
      }
    } catch {
      // leave as-is
    }
    if (expectedSharesPxCvx) {
      bundleResult.amountsOut = {
        ...bundleResult.amountsOut,
        [params.vaultAddress.toLowerCase()]: expectedSharesPxCvx,
      };
    }
  }

  // Build routeInfo for the display
  const tokenPath = inputIsCvx
    ? ["CVX", "pxCVX", vaultSymbol]
    : [inputSymbol, "CVX", "pxCVX", vaultSymbol];

  // Calculate swap bonus if swap was used
  let swapBonus = 0;
  let bonusAmount: string | undefined;
  if (swapAmount > 0n && expectedSwapPxCvx > 0n) {
    // lpxCVX.swap() uses the Curve CVX/lpxCVX rate and delivers pxCVX 1:1
    // with the lpxCVX output, so bonus is pxCVX output / CVX input.
    swapBonus = (Number(expectedSwapPxCvx) / Number(swapAmount) - 1) * 100;
    // Bonus amount = pxCVX received - CVX input (what you gain vs 1:1 mint)
    bonusAmount = formatRouteDeltaAmount(expectedSwapPxCvx, swapAmount, TOKENS.PXCVX);
  }

  // Determine protocols based on strategy
  let protocols: string[];
  if (swapAmount > 0n && mintAmount > 0n) {
    protocols = inputIsCvx ? ["Curve", "Pirex", "yld"] : ["Enso", "Curve", "Pirex", "yld"];
  } else if (swapAmount > 0n) {
    protocols = inputIsCvx ? ["Curve", "yld"] : ["Enso", "Curve", "yld"];
  } else {
    protocols = inputIsCvx ? ["Pirex", "yld"] : ["Enso", "Pirex", "yld"];
  }

  // Format amounts for display
  const formatWei = (wei: string | bigint) => (Number(wei) / 1e18).toFixed(4);
  const stepAmounts: PxCvxStepAmounts = {
    inputAmount: formatWei(params.amountIn),
    cvxAmount: formatWei(inputIsCvx ? params.amountIn : cvxAmountForSplit),
    swapCvxAmount: swapAmount > 0n ? formatWei(swapAmount) : undefined,
    mintCvxAmount: mintAmount > 0n ? formatWei(mintAmount) : undefined,
    pxCvxAmount: formatWei(totalExpectedPxCvx),
    vaultSharesAmount: expectedSharesPxCvx ? formatWei(expectedSharesPxCvx) : undefined,
  };

  const routeInfo: RouteInfo = {
    steps: buildPxCvxZapInSteps(inputSymbol, vaultSymbol, inputIsCvx, swapAmount, mintAmount, swapBonus, bonusAmount, stepAmounts),
    tokens: tokenPath,
    protocols,
    hybrid: {
      swapAmount: swapAmount.toString(),
      mintAmount: mintAmount.toString(),
      swapBonus,
      swapProtocol: "Curve",
      mintProtocol: "Pirex",
    },
  };

  return { ...bundleResult, routeInfo };
}
