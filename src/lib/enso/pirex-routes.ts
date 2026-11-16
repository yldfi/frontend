import type {
  CustomBundleResponse,
  EnsoBundleAction,
  RouteInfo,
  RouteStep,
} from "@/types/enso";
import { WETH_ADDRESS } from "@/config/addresses";
import { getVaultByAddress, PIREX, TOKENS } from "@/config/vaults";
import {
  calculateMinDy,
  getEthToCvxEstimate,
  validateSlippage,
} from "@/lib/curve";
import { fetchEnsoIntent } from "@/lib/enso-intents";
import {
  estimateRouteOutput,
  fetchBundle,
  fetchDynamicInputEstimate,
  rpcWithFallback,
} from "./api";
import {
  appendDynamicRouteFloor,
  appendETHUnwrapIfNeeded,
  applySlippageBuffer,
  estimateRequiredRouteOutput,
  formatRouteAmount,
  formatRouteDeltaAmount,
  getBufferedSlippageBps,
  intermediateApproveAction,
  pushCvxToPxCvxSwapActions,
  rawApproveCallAction,
  rawCallConsumingInput,
  remainingCvxForMint,
  runtimeSplitOutput,
  type BundleAmountRef,
} from "./bundle-helpers";
import { ENSO_SHORTCUTS, ETH_ADDRESS, isNativeETH } from "./constants";
import {
  getLpxCvxToCvxSwapRate,
  getOptimalPxCvxSwapAmount,
  getPxCvxSwapRate,
} from "./pxcvx-pool";
import { PIREX_PXCVX, getTokenSymbol } from "./tokens";

// ============================================================================
// Pirex Token Zap Functions (pxCVX, lpxCVX)
// ============================================================================


/**
 * Zap from lpxCVX into any yld vault
 *
 * Routes:
 * - lpxCVX → yspxCVX: unwrap to pxCVX → deposit
 * - lpxCVX → other vaults: swap to CVX (Curve) → route to target underlying → deposit
 */
export async function fetchLpxCvxZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  // Raw bundle actions can't be submitted from the browser; build server-side via the intent.
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "illiquidToYldVault",
      fromAddress: params.fromAddress,
      inputToken: TOKENS.LPXCVX,
      vaultAddress: params.vaultAddress,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const slippageBps = validateSlippage(params.slippage);

  // Get target vault's underlying token
  const targetVault = getVaultByAddress(params.vaultAddress);
  if (!targetVault) {
    throw new Error(`Unknown target vault: ${params.vaultAddress}`);
  }
  const targetUnderlying = targetVault.assetAddress;
  const vaultSymbol = targetVault.symbol;

  // Check if target is yspxCVX (accepts pxCVX)
  const targetIsPxCvx = targetUnderlying.toLowerCase() === PIREX_PXCVX.toLowerCase();
  let expectedTargetUnderlyingOutput = 0n;

  const actions: EnsoBundleAction[] = [];

  if (targetIsPxCvx) {
    // lpxCVX → pxCVX (unwrap 1:1) → deposit to yspxCVX
    // Action 0: Unwrap lpxCVX → pxCVX
    // unwrap() returns nothing; read the produced pxCVX instead.
    actions.push(rawCallConsumingInput(params.amountIn, TOKENS.LPXCVX, {
      address: PIREX.LPXCVX,
      method: "unwrap",
      abi: "function unwrap(uint256 amount)",
      args: [params.amountIn],
    }));
    actions.push({ protocol: "enso", action: "balance", args: { token: PIREX_PXCVX } });
    // Action 2: Deposit pxCVX → yspxCVX
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: PIREX_PXCVX,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 1 },
        primaryAddress: params.vaultAddress,
      },
    });

    const bundleResult = await fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "router",
    });

    const routeInfo: RouteInfo = {
      steps: [
        { tokenSymbol: "lpxCVX", amount: formatRouteAmount(params.amountIn, TOKENS.LPXCVX), action: "Unwrap", description: "lpxCVX for pxCVX", protocol: "Pirex" },
        { tokenSymbol: "pxCVX", amount: formatRouteAmount(params.amountIn, TOKENS.PXCVX), action: "Deposit", description: `pxCVX into ${vaultSymbol}`, protocol: "yld" },
        { tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" },
      ],
      tokens: ["lpxCVX", "pxCVX", vaultSymbol],
      protocols: ["Pirex", "yld"],
    };

    return { ...bundleResult, routeInfo };
  }

  // lpxCVX → CVX (Curve swap) → route to target underlying → deposit
  // Estimate CVX output from lpxCVX → CVX swap
  const expectedCvxOutput = await getLpxCvxToCvxSwapRate(params.amountIn);
  if (expectedCvxOutput === 0n) {
    throw new Error("Failed to estimate Curve lpxCVX→CVX swap output");
  }
  const minDy = calculateMinDy(expectedCvxOutput, slippageBps);

  // Action 0: Approve lpxCVX to Curve pool
  actions.push({
    protocol: "erc20",
    action: "approve",
    args: {
      token: PIREX.LPXCVX,
      spender: PIREX.LPXCVX_CVX_POOL,
      amount: params.amountIn,
    },
  });

  // Action 1: Exchange lpxCVX → CVX on Curve pool
  actions.push({
    protocol: "enso",
    action: "call",
    args: {
      address: PIREX.LPXCVX_CVX_POOL,
      method: "exchange",
      abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
      args: [
        String(PIREX.POOL_INDEX.LPXCVX), // i = 1 (lpxCVX)
        String(PIREX.POOL_INDEX.CVX), // j = 0 (CVX)
        params.amountIn,
        minDy,
      ],
    },
  });

  // Check if target accepts CVX directly
  const targetIsCvx = targetUnderlying.toLowerCase() === TOKENS.CVX.toLowerCase();

  if (targetIsCvx) {
    // Direct deposit CVX
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 1 },
        primaryAddress: params.vaultAddress,
      },
    });
  } else {
    expectedTargetUnderlyingOutput = await estimateRequiredRouteOutput(
      params.fromAddress,
      TOKENS.CVX,
      targetUnderlying,
      expectedCvxOutput.toString(),
      params.slippage ?? "100",
    );
    // Route CVX → target underlying via Enso
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: targetUnderlying,
        amountIn: { useOutputOfCallAt: 1 },
        slippage: params.slippage ?? "100",
      },
    });
    // Then deposit to vault
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: targetUnderlying,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 2 },
        primaryAddress: params.vaultAddress,
      },
    });
  }

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: false,
  });

  // Build routeInfo
  const targetUnderlyingSymbol = getTokenSymbol(targetUnderlying);
  const steps: RouteStep[] = [
    { tokenSymbol: "lpxCVX", amount: formatRouteAmount(params.amountIn, TOKENS.LPXCVX), action: "Swap", description: "lpxCVX for CVX", protocol: "Curve" },
  ];

  if (targetIsCvx) {
    steps.push({ tokenSymbol: "CVX", amount: formatRouteAmount(expectedCvxOutput, TOKENS.CVX), action: "Deposit", description: `CVX into ${vaultSymbol}`, protocol: "yld" });
  } else {
    steps.push({ tokenSymbol: "CVX", amount: formatRouteAmount(expectedCvxOutput, TOKENS.CVX), action: "Swap", description: `CVX for ${targetUnderlyingSymbol}`, protocol: "Enso" });
    steps.push({ tokenSymbol: targetUnderlyingSymbol, amount: formatRouteAmount(expectedTargetUnderlyingOutput, targetUnderlying), action: "Deposit", description: `${targetUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
  }

  steps.push({ tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" });

  const routeInfo: RouteInfo = {
    steps,
    tokens: targetIsCvx
      ? ["lpxCVX", "CVX", vaultSymbol]
      : ["lpxCVX", "CVX", targetUnderlyingSymbol, vaultSymbol],
    protocols: targetIsCvx
      ? ["Curve", "yld"]
      : ["Curve", "Enso", "yld"],
  };

  return { ...bundleResult, routeInfo };
}

/**
 * Zap from pxCVX into any yld vault (except yspxCVX where it's the underlying)
 *
 * Route: pxCVX → wrap to lpxCVX → swap to CVX (Curve) → route to target underlying → deposit
 *
 * Note: This should NOT be called for yspxCVX - users should use the Deposit tab instead
 */
export async function fetchPxCvxTokenZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  // Raw bundle actions can't be submitted from the browser; build server-side via the intent.
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "illiquidToYldVault",
      fromAddress: params.fromAddress,
      inputToken: TOKENS.PXCVX,
      vaultAddress: params.vaultAddress,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const slippageBps = validateSlippage(params.slippage);

  // Get target vault's underlying token
  const targetVault = getVaultByAddress(params.vaultAddress);
  if (!targetVault) {
    throw new Error(`Unknown target vault: ${params.vaultAddress}`);
  }
  const targetUnderlying = targetVault.assetAddress;
  const vaultSymbol = targetVault.symbol;

  // Should not be called for yspxCVX - pxCVX is the underlying
  if (targetUnderlying.toLowerCase() === PIREX_PXCVX.toLowerCase()) {
    throw new Error("pxCVX is the underlying for this vault - use Deposit tab instead");
  }

  // pxCVX → lpxCVX (wrap 1:1) → CVX (Curve swap) → route to target underlying → deposit
  // Estimate CVX output from lpxCVX → CVX swap (pxCVX wraps 1:1 to lpxCVX)
  const expectedCvxOutput = await getLpxCvxToCvxSwapRate(params.amountIn);
  if (expectedCvxOutput === 0n) {
    throw new Error("Failed to estimate Curve lpxCVX→CVX swap output");
  }
  const minDy = calculateMinDy(expectedCvxOutput, slippageBps);

  const actions: EnsoBundleAction[] = [
    // Action 0: Approve pxCVX to lpxCVX contract for wrapping
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX_PXCVX,
        spender: PIREX.LPXCVX,
        amount: params.amountIn,
      },
    },
    // Action 1: Wrap pxCVX → lpxCVX (1:1 ratio)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "wrap",
        abi: "function wrap(uint256 amount)",
        args: [params.amountIn],
      },
    },
    // Action 2: Approve lpxCVX to Curve pool
    // Raw call: a fixed erc20 approval of the wrapped lpxCVX would make Enso pull it from the wallet
    rawApproveCallAction(PIREX.LPXCVX, PIREX.LPXCVX_CVX_POOL, params.amountIn),
    // Action 3: Exchange lpxCVX → CVX on Curve pool
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
          params.amountIn, // Same amount (1:1 wrap)
          minDy,
        ],
      },
    },
  ];

  const targetIsCvx = targetUnderlying.toLowerCase() === TOKENS.CVX.toLowerCase();

  if (targetIsCvx) {
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 3 },
        primaryAddress: params.vaultAddress,
      },
    });
  } else {
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: targetUnderlying,
        amountIn: { useOutputOfCallAt: 3 },
        slippage: params.slippage ?? "100",
      },
    });
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: targetUnderlying,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 4 },
        primaryAddress: params.vaultAddress,
      },
    });
  }

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: false,
  });

  // Build routeInfo
  const targetUnderlyingSymbol = getTokenSymbol(targetUnderlying);
  const pxCvxInFmt = (Number(params.amountIn) / 1e18).toFixed(4);
  const cvxAmountFmt = (Number(expectedCvxOutput) / 1e18).toFixed(4);
  const steps: RouteStep[] = [
    { tokenSymbol: "pxCVX", amount: pxCvxInFmt, action: "Wrap", description: "pxCVX to lpxCVX", protocol: "Pirex" },
    { tokenSymbol: "lpxCVX", amount: pxCvxInFmt, action: "Swap", description: "lpxCVX for CVX", protocol: "Curve" },
  ];

  if (targetIsCvx) {
    steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Deposit", description: `CVX into ${vaultSymbol}`, protocol: "yld" });
  } else {
    steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Swap", description: `CVX for ${targetUnderlyingSymbol}`, protocol: "Enso" });
    steps.push({ tokenSymbol: targetUnderlyingSymbol, action: "Deposit", description: `${targetUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
  }

  steps.push({ tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" });

  const routeInfo: RouteInfo = {
    steps,
    tokens: targetIsCvx
      ? ["pxCVX", "lpxCVX", "CVX", vaultSymbol]
      : ["pxCVX", "lpxCVX", "CVX", targetUnderlyingSymbol, vaultSymbol],
    protocols: targetIsCvx
      ? ["Pirex", "Curve", "yld"]
      : ["Pirex", "Curve", "Enso", "yld"],
  };

  return { ...bundleResult, routeInfo };
}

// ============================================================================
// Any Token → pxCVX / lpxCVX (delivered to user, universal-zap targets)
// ============================================================================
//
// Same hybrid swap/mint optimization as the corresponding vault zap-in routes,
// but the final step transfers the accumulated underlying to the user instead
// of depositing into a yld vault.

/**
 * Zap any input token to pxCVX delivered to the user.
 * Hybrid split: lpxCVX.swap() Curve leg (if > 1:1) + Pirex 1:1 mint.
 */
export async function fetchAnyToPxCvxRoute(params: {
  fromAddress: string;
  inputToken: string;
  amountIn: string;
  slippage?: string;
  // If provided, the final step is an erc4626/deposit into this vault instead
  // of a transfer to the user. Used to chain into pxCVX-underlying ERC4626
  // external vaults (e.g. uCVX) in a single bundle.
  depositIntoVault?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined" && !params.depositIntoVault) {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "anyToIlliquid",
      fromAddress: params.fromAddress,
      inputToken: params.inputToken,
      outputToken: TOKENS.PXCVX,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const inputSymbol = getTokenSymbol(params.inputToken);
  const inputIsCvx = params.inputToken.toLowerCase() === TOKENS.CVX.toLowerCase();
  const inputIsEth = params.inputToken.toLowerCase() === ETH_ADDRESS.toLowerCase();

  let estimatedCvxAmount = params.amountIn;
  if (!inputIsCvx) {
    if (inputIsEth) {
      estimatedCvxAmount = await getEthToCvxEstimate(params.amountIn);
    } else {
      estimatedCvxAmount = await estimateRouteOutput(
        params.fromAddress,
        params.inputToken,
        TOKENS.CVX,
        params.amountIn,
        params.slippage,
      );
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }

  const slippageBps = validateSlippage(params.slippage);
  const totalSlippageBps = getBufferedSlippageBps(slippageBps);
  const cvxAmountForSplit = inputIsCvx
    ? estimatedCvxAmount
    : applySlippageBuffer(BigInt(estimatedCvxAmount), slippageBps);

  const { swapAmount, mintAmount } = await getOptimalPxCvxSwapAmount(cvxAmountForSplit);

  let expectedSwapPxCvx = 0n;
  let swapMinDy = "0";
  if (swapAmount > 0n) {
    const swapOutput = await getPxCvxSwapRate(swapAmount.toString());
    if (!swapOutput || swapOutput === 0n) {
      throw new Error("Failed to estimate Curve CVX→lpxCVX swap output");
    }
    expectedSwapPxCvx = swapOutput;
    swapMinDy = calculateMinDy(swapOutput, totalSlippageBps);
  }
  const expectedMintPxCvx = mintAmount;
  const totalExpectedPxCvx = await runtimeSplitOutput({
    runtimeCvx: inputIsCvx ? BigInt(params.amountIn) : BigInt(estimatedCvxAmount),
    swapAmount,
    mintAmount: expectedMintPxCvx,
    expectedSwapOut: expectedSwapPxCvx,
    quoteSwap: getPxCvxSwapRate,
  });

  const actions: EnsoBundleAction[] = [];
  let actionIndex = 0;

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
          false,
          "0x0000000000000000000000000000000000000000",
        ],
      },
    });
    actionIndex++;
  } else if (swapAmount > 0n) {
    const swapCvxInput: BundleAmountRef = inputIsCvx
      ? params.amountIn
      : { useOutputOfCallAt: actionIndex - 1 };
    pushCvxToPxCvxSwapActions(actions, PIREX, swapCvxInput, swapMinDy, false);
    actionIndex += 2;
  } else {
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
          false,
          "0x0000000000000000000000000000000000000000",
        ],
      },
    });
    actionIndex++;
  }

  actions.push({
    protocol: "enso",
    action: "balance",
    args: { token: PIREX.PXCVX },
  });
  const pxCvxBalanceIdx = actionIndex++;

  if (params.depositIntoVault) {
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: PIREX.PXCVX,
        tokenOut: params.depositIntoVault,
        amountIn: { useOutputOfCallAt: pxCvxBalanceIdx },
        primaryAddress: params.depositIntoVault,
      },
    });
  } else {
    actions.push({
      protocol: "erc20",
      action: "transfer",
      args: {
        token: PIREX.PXCVX,
        amount: { useOutputOfCallAt: pxCvxBalanceIdx },
        receiver: params.fromAddress,
      },
    });
  }

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });

  if (params.depositIntoVault) {
    let expectedShares = bundleResult.amountsOut[params.depositIntoVault.toLowerCase()]
      || bundleResult.amountsOut[params.depositIntoVault];
    if (!expectedShares || BigInt(expectedShares) === 0n) {
      try {
        const selector = "0xef8b30f7"; // previewDeposit(uint256)
        const data = selector + totalExpectedPxCvx.toString(16).padStart(64, "0");
        const res = await rpcWithFallback<{ result?: string }>({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: params.depositIntoVault, data }, "latest"],
        });
        if (res.result && res.result !== "0x") {
          expectedShares = BigInt(res.result).toString();
        }
      } catch {
        // leave as-is
      }
      if (expectedShares) {
        bundleResult.amountsOut = {
          ...bundleResult.amountsOut,
          [params.depositIntoVault.toLowerCase()]: expectedShares,
        };
      }
    }
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [PIREX.PXCVX.toLowerCase()]: totalExpectedPxCvx.toString(),
    };
  } else {
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [PIREX.PXCVX.toLowerCase()]: totalExpectedPxCvx.toString(),
    };
  }

  // Bonus % from swap path
  let swapBonus = 0;
  let bonusAmount: string | undefined;
  const displayedCvxAmount = inputIsCvx ? BigInt(params.amountIn) : BigInt(cvxAmountForSplit);
  const displayedSwapInput = swapAmount > 0n && mintAmount === 0n
    ? displayedCvxAmount
    : swapAmount;
  if (swapAmount > 0n && expectedSwapPxCvx > 0n) {
    swapBonus = (Number(expectedSwapPxCvx) / Number(displayedSwapInput) - 1) * 100;
    bonusAmount = formatRouteDeltaAmount(expectedSwapPxCvx, displayedSwapInput, TOKENS.PXCVX);
  }

  const steps: RouteStep[] = [];
  if (!inputIsCvx) {
    steps.push({ tokenSymbol: inputSymbol, action: "Swap", description: "for CVX", protocol: "Enso" });
  }
  if (swapAmount > 0n && mintAmount > 0n) {
    steps.push({
      tokenSymbol: "CVX",
      amount: (Number(swapAmount) / 1e18).toFixed(4),
      action: "Swap",
      description: "CVX for pxCVX",
      protocol: "Curve",
      bonus: swapBonus,
      bonusAmount,
      bonusSymbol: "pxCVX",
    });
    steps.push({
      tokenSymbol: "CVX",
      amount: (Number(mintAmount) / 1e18).toFixed(4),
      action: "Mint",
      description: "pxCVX with CVX (1:1)",
      protocol: "Pirex",
    });
  } else if (swapAmount > 0n) {
    steps.push({
      tokenSymbol: "CVX",
      amount: formatRouteAmount(displayedCvxAmount, TOKENS.CVX),
      action: "Swap",
      description: "CVX for pxCVX",
      protocol: "Curve",
      bonus: swapBonus,
      bonusAmount,
      bonusSymbol: "pxCVX",
    });
  } else {
    steps.push({
      tokenSymbol: "CVX",
      amount: formatRouteAmount(displayedCvxAmount, TOKENS.CVX),
      action: "Mint",
      description: "pxCVX with CVX (1:1)",
      protocol: "Pirex",
    });
  }

  const outVaultSymbol = params.depositIntoVault ? getTokenSymbol(params.depositIntoVault) : undefined;
  if (params.depositIntoVault) {
    const pxCvxTotalFmt = (Number(totalExpectedPxCvx) / 1e18).toFixed(4);
    steps.push({
      tokenSymbol: "pxCVX",
      amount: pxCvxTotalFmt,
      action: "Deposit",
      description: `pxCVX into ${outVaultSymbol}`,
      protocol: "Llama Airforce",
    });
    steps.push({
      tokenSymbol: outVaultSymbol!,
      action: "Receive",
      description: "vault shares",
      protocol: "Llama Airforce",
    });
  } else {
    steps.push({ tokenSymbol: "pxCVX", action: "Receive", description: "tokens", protocol: "Pirex" });
  }

  const tokens = params.depositIntoVault
    ? inputIsCvx
      ? ["CVX", "pxCVX", outVaultSymbol!]
      : [inputSymbol, "CVX", "pxCVX", outVaultSymbol!]
    : inputIsCvx
      ? ["CVX", "pxCVX"]
      : [inputSymbol, "CVX", "pxCVX"];

  const protocols = [
    ...(inputIsCvx ? [] : ["Enso"]),
    ...(swapAmount > 0n ? ["Curve", "Pirex"] : ["Pirex"]),
    ...(params.depositIntoVault ? ["Llama Airforce"] : []),
  ];

  const routeInfo: RouteInfo = {
    steps,
    tokens,
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

/**
 * Zap any input token to lpxCVX delivered to the user.
 * Hybrid: Curve CVX/lpxCVX pool swap (if > 1:1) + Pirex 1:1 mint (CVX → pxCVX → wrap to lpxCVX).
 * Uses the same optimizer as pxCVX since the mint path is CVX → pxCVX (1:1) → lpxCVX (1:1).
 */
export async function fetchAnyToLpxCvxRoute(params: {
  fromAddress: string;
  inputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "anyToIlliquid",
      fromAddress: params.fromAddress,
      inputToken: params.inputToken,
      outputToken: TOKENS.LPXCVX,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const inputSymbol = getTokenSymbol(params.inputToken);
  const inputIsCvx = params.inputToken.toLowerCase() === TOKENS.CVX.toLowerCase();
  const inputIsEth = params.inputToken.toLowerCase() === ETH_ADDRESS.toLowerCase();

  // Estimate CVX we'll receive mid-bundle
  let estimatedCvxAmount = params.amountIn;
  if (!inputIsCvx) {
    if (inputIsEth) {
      estimatedCvxAmount = await getEthToCvxEstimate(params.amountIn);
    } else {
      estimatedCvxAmount = await estimateRouteOutput(
        params.fromAddress,
        params.inputToken,
        TOKENS.CVX,
        params.amountIn,
        params.slippage,
      );
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }

  const slippageBps = validateSlippage(params.slippage);
  const totalSlippageBps = getBufferedSlippageBps(slippageBps);
  const cvxAmountForSplit = inputIsCvx
    ? estimatedCvxAmount
    : applySlippageBuffer(BigInt(estimatedCvxAmount), slippageBps);

  const { swapAmount, mintAmount } = await getOptimalPxCvxSwapAmount(cvxAmountForSplit);

  let expectedSwapLpxCvx = 0n;
  let swapMinDy = "0";
  if (swapAmount > 0n) {
    const swapOutput = await getPxCvxSwapRate(swapAmount.toString());
    if (!swapOutput || swapOutput === 0n) {
      throw new Error("Failed to estimate Curve CVX→lpxCVX swap output");
    }
    expectedSwapLpxCvx = swapOutput;
    swapMinDy = calculateMinDy(swapOutput, totalSlippageBps);
  }
  // Mint path: CVX → pxCVX (1:1) → wrap → lpxCVX (1:1)
  const expectedMintLpxCvx = mintAmount;
  const totalExpectedLpxCvx = await runtimeSplitOutput({
    runtimeCvx: inputIsCvx ? BigInt(params.amountIn) : BigInt(estimatedCvxAmount),
    swapAmount,
    mintAmount: expectedMintLpxCvx,
    expectedSwapOut: expectedSwapLpxCvx,
    quoteSwap: getPxCvxSwapRate,
  });

  const actions: EnsoBundleAction[] = [];
  let actionIndex = 0;

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
  const usesFixedDynamicSplit = !inputIsCvx && swapAmount > 0n && mintAmount > 0n;
  const cvxRouteRef: BundleAmountRef = { useOutputOfCallAt: 0 };
  const swapCvxInput: BundleAmountRef =
    !inputIsCvx && !usesFixedDynamicSplit ? cvxRouteRef : swapAmount.toString();
  const mintCvxInput: BundleAmountRef =
    !inputIsCvx && !usesFixedDynamicSplit ? cvxRouteRef : mintAmount.toString();

  if (swapAmount > 0n) {
    // Curve swap path: CVX → lpxCVX (lands at ENSO_SHORTCUTS)
    actions.push(intermediateApproveAction(
      TOKENS.CVX,
      PIREX.LPXCVX_CVX_POOL,
      swapCvxInput,
      usesFixedDynamicSplit,
    ));
    actionIndex++;

    actions.push({
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
    });
    actionIndex++;
  }

  if (mintAmount > 0n) {
    const mintInput = usesFixedDynamicSplit ? remainingCvxForMint(actions) : mintCvxInput;
    if (usesFixedDynamicSplit) actionIndex++;
    // Pirex mint + wrap path: CVX → pxCVX (1:1) → wrap → lpxCVX (1:1)
    actions.push(intermediateApproveAction(
      TOKENS.CVX,
      PIREX.PIREX_CVX,
      mintInput,
      usesFixedDynamicSplit,
    ));
    actionIndex++;

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
          false,
          "0x0000000000000000000000000000000000000000",
        ],
      },
    });
    actionIndex++;

    actions.push({
      protocol: "enso",
      action: "balance",
      args: { token: PIREX.PXCVX },
    });
    const pxCvxBalanceIdx = actionIndex++;

    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.PXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: pxCvxBalanceIdx },
      },
    });
    actionIndex++;

    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "wrap",
        abi: "function wrap(uint256 amount)",
        args: [{ useOutputOfCallAt: pxCvxBalanceIdx }],
      },
    });
    actionIndex++;
  }

  actions.push({
    protocol: "enso",
    action: "balance",
    args: { token: PIREX.LPXCVX },
  });
  const lpxCvxBalanceIdx = actionIndex++;

  actions.push({
    protocol: "erc20",
    action: "transfer",
    args: {
      token: PIREX.LPXCVX,
      amount: { useOutputOfCallAt: lpxCvxBalanceIdx },
      receiver: params.fromAddress,
    },
  });

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: true,
  });

  bundleResult.amountsOut = {
    ...bundleResult.amountsOut,
    [PIREX.LPXCVX.toLowerCase()]: totalExpectedLpxCvx.toString(),
  };

  let swapBonus = 0;
  let bonusAmount: string | undefined;
  const displayedCvxAmount = inputIsCvx ? BigInt(params.amountIn) : BigInt(cvxAmountForSplit);
  const displayedSwapInput = swapAmount > 0n && mintAmount === 0n
    ? displayedCvxAmount
    : swapAmount;
  if (swapAmount > 0n && expectedSwapLpxCvx > 0n) {
    swapBonus = (Number(expectedSwapLpxCvx) / Number(displayedSwapInput) - 1) * 100;
    bonusAmount = formatRouteDeltaAmount(expectedSwapLpxCvx, displayedSwapInput, TOKENS.LPXCVX);
  }

  const cvxAmountFmt = formatRouteAmount(displayedCvxAmount, TOKENS.CVX);
  const swapCvxFmt = (Number(swapAmount) / 1e18).toFixed(4);
  const mintCvxFmt = (Number(mintAmount) / 1e18).toFixed(4);
  const steps: RouteStep[] = [];
  if (!inputIsCvx) {
    steps.push({ tokenSymbol: inputSymbol, action: "Swap", description: "for CVX", protocol: "Enso" });
  }
  if (swapAmount > 0n && mintAmount > 0n) {
    steps.push({
      tokenSymbol: "CVX",
      amount: swapCvxFmt,
      action: "Swap",
      description: "CVX for lpxCVX via Curve pool",
      protocol: "Curve",
      bonus: swapBonus,
      bonusAmount,
      bonusSymbol: "lpxCVX",
    });
    steps.push({
      tokenSymbol: "CVX",
      amount: mintCvxFmt,
      action: "Mint",
      description: "pxCVX with CVX (1:1), then wrap",
      protocol: "Pirex",
    });
  } else if (swapAmount > 0n) {
    steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Swap", description: "CVX for lpxCVX via Curve pool", protocol: "Curve", bonus: swapBonus, bonusAmount, bonusSymbol: "lpxCVX" });
  } else {
    steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Mint", description: "pxCVX with CVX (1:1), then wrap", protocol: "Pirex" });
  }
  steps.push({ tokenSymbol: "lpxCVX", action: "Receive", description: "tokens", protocol: "Pirex" });

  const protocols = inputIsCvx
    ? swapAmount > 0n && mintAmount > 0n
      ? ["Curve", "Pirex"]
      : swapAmount > 0n
        ? ["Curve"]
        : ["Pirex"]
    : swapAmount > 0n && mintAmount > 0n
      ? ["Enso", "Curve", "Pirex"]
      : swapAmount > 0n
        ? ["Enso", "Curve"]
        : ["Enso", "Pirex"];

  const routeInfo: RouteInfo = {
    steps,
    tokens: inputIsCvx ? ["CVX", "lpxCVX"] : [inputSymbol, "CVX", "lpxCVX"],
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

// ============================================================================
// pxCVX / lpxCVX → Any Token (universal-zap inputs)
// ============================================================================
//
// These handle the reverse of the output routes above: user holds an illiquid
// token (pxCVX / lpxCVX) and wants a regular token. Enso's aggregator
// has no liquid route for these so we manually route through the Curve pools.

/** lpxCVX → any token, single Curve hop then Enso route CVX → target. */
export async function fetchAnyFromLpxCvxRoute(params: {
  fromAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "illiquidToAny",
      fromAddress: params.fromAddress,
      inputToken: TOKENS.LPXCVX,
      outputToken: params.outputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const outputSymbol = getTokenSymbol(params.outputToken);
  const outputIsCvx = params.outputToken.toLowerCase() === TOKENS.CVX.toLowerCase();
  const slippageBps = validateSlippage(params.slippage);
  const totalSlippageBps = getBufferedSlippageBps(slippageBps);

  // Estimate CVX out from Curve swap, then final output via Enso route quote
  const expectedCvx = await getLpxCvxToCvxSwapRate(params.amountIn);
  if (!expectedCvx || expectedCvx === 0n) {
    throw new Error("Failed to estimate Curve lpxCVX→CVX swap output");
  }
  const swapMinDy = calculateMinDy(expectedCvx, totalSlippageBps);

  const actions: EnsoBundleAction[] = [
    // Approve lpxCVX → Curve pool
    {
      protocol: "erc20",
      action: "approve",
      args: { token: PIREX.LPXCVX, spender: PIREX.LPXCVX_CVX_POOL, amount: params.amountIn },
    },
    // Curve exchange lpxCVX (i=1) → CVX (j=0) — output lands at ENSO_SHORTCUTS
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
          params.amountIn,
          swapMinDy,
        ],
      },
    },
  ];

  let cvxLegEstimate = "0";
  if (outputIsCvx) {
    actions.push({
      protocol: "erc20",
      action: "transfer",
      args: {
        token: TOKENS.CVX,
        amount: { useOutputOfCallAt: 1 },
        receiver: params.fromAddress,
      },
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
        amountIn: { useOutputOfCallAt: 1 },
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

  const steps: RouteStep[] = [
    {
      tokenSymbol: "lpxCVX",
      action: "Swap",
      description: "lpxCVX for CVX via Curve pool",
      protocol: "Curve",
    },
  ];
  if (outputIsCvx) {
    steps.push({
      tokenSymbol: "CVX",
      amount: (Number(expectedCvx) / 1e18).toFixed(4),
      action: "Receive",
      description: "tokens",
      protocol: "Curve",
    });
  } else {
    steps.push(
      {
        tokenSymbol: "CVX",
        amount: (Number(expectedCvx) / 1e18).toFixed(4),
        action: "Swap",
        description: `CVX for ${outputSymbol}`,
        protocol: "Enso",
      },
      {
        tokenSymbol: outputSymbol,
        action: "Receive",
        description: "tokens",
        protocol: "Enso",
      },
    );
  }

  return {
    ...bundleResult,
    amountsOut: {
      ...bundleResult.amountsOut,
      ...(outputIsCvx ? { [TOKENS.CVX.toLowerCase()]: expectedCvx.toString() } : {}),
      // The CVX leg was already quoted above (WETH for ETH outputs); reuse it.
      ...(isNativeETH(params.outputToken) && !bundleResult.amountsOut?.[ETH_ADDRESS.toLowerCase()] && cvxLegEstimate !== "0"
        ? { [ETH_ADDRESS.toLowerCase()]: String(cvxLegEstimate) }
        : {}),
    },
    routeInfo: {
      steps,
      tokens: outputIsCvx ? ["lpxCVX", "CVX"] : ["lpxCVX", "CVX", outputSymbol],
      protocols: outputIsCvx ? ["Curve"] : ["Curve", "Enso"],
    },
  };
}

/** pxCVX → any token: wrap to lpxCVX, then Curve swap to CVX, then Enso route. */
export async function fetchAnyFromPxCvxRoute(params: {
  fromAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "illiquidToAny",
      fromAddress: params.fromAddress,
      inputToken: TOKENS.PXCVX,
      outputToken: params.outputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const outputSymbol = getTokenSymbol(params.outputToken);
  const outputIsCvx = params.outputToken.toLowerCase() === TOKENS.CVX.toLowerCase();
  const slippageBps = validateSlippage(params.slippage);
  const totalSlippageBps = getBufferedSlippageBps(slippageBps);

  // pxCVX wraps 1:1 to lpxCVX, then Curve swap to CVX
  const expectedCvx = await getLpxCvxToCvxSwapRate(params.amountIn);
  if (!expectedCvx || expectedCvx === 0n) {
    throw new Error("Failed to estimate Curve lpxCVX→CVX swap output");
  }
  const swapMinDy = calculateMinDy(expectedCvx, totalSlippageBps);

  const actions: EnsoBundleAction[] = [
    // Approve pxCVX → lpxCVX contract (for wrap)
    {
      protocol: "erc20",
      action: "approve",
      args: { token: PIREX.PXCVX, spender: PIREX.LPXCVX, amount: params.amountIn },
    },
    // Wrap pxCVX → lpxCVX (1:1)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "wrap",
        abi: "function wrap(uint256 amount)",
        args: [params.amountIn],
      },
    },
    // Approve lpxCVX → Curve pool. Raw call: a fixed erc20 approval of the wrapped lpxCVX
    // would make Enso pull it from the wallet as a second input.
    rawApproveCallAction(PIREX.LPXCVX, PIREX.LPXCVX_CVX_POOL, params.amountIn),
    // Curve exchange lpxCVX → CVX
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
          params.amountIn,
          swapMinDy,
        ],
      },
    },
  ];

  let cvxLegEstimate = "0";
  if (outputIsCvx) {
    actions.push({
      protocol: "erc20",
      action: "transfer",
      args: {
        token: TOKENS.CVX,
        amount: { useOutputOfCallAt: 3 },
        receiver: params.fromAddress,
      },
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
        amountIn: { useOutputOfCallAt: 3 },
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

  const steps: RouteStep[] = [
    {
      tokenSymbol: "pxCVX",
      action: "Wrap",
      description: "pxCVX to lpxCVX (1:1)",
      protocol: "Pirex",
    },
    {
      tokenSymbol: "lpxCVX",
      action: "Swap",
      description: "lpxCVX for CVX via Curve pool",
      protocol: "Curve",
    },
  ];
  if (outputIsCvx) {
    steps.push({
      tokenSymbol: "CVX",
      amount: (Number(expectedCvx) / 1e18).toFixed(4),
      action: "Receive",
      description: "tokens",
      protocol: "Curve",
    });
  } else {
    steps.push(
      {
        tokenSymbol: "CVX",
        amount: (Number(expectedCvx) / 1e18).toFixed(4),
        action: "Swap",
        description: `CVX for ${outputSymbol}`,
        protocol: "Enso",
      },
      {
        tokenSymbol: outputSymbol,
        action: "Receive",
        description: "tokens",
        protocol: "Enso",
      },
    );
  }

  return {
    ...bundleResult,
    amountsOut: {
      ...bundleResult.amountsOut,
      ...(outputIsCvx ? { [TOKENS.CVX.toLowerCase()]: expectedCvx.toString() } : {}),
      // The CVX leg was already quoted above (WETH for ETH outputs); reuse it.
      ...(isNativeETH(params.outputToken) && !bundleResult.amountsOut?.[ETH_ADDRESS.toLowerCase()] && cvxLegEstimate !== "0"
        ? { [ETH_ADDRESS.toLowerCase()]: String(cvxLegEstimate) }
        : {}),
    },
    routeInfo: {
      steps,
      tokens: outputIsCvx ? ["pxCVX", "lpxCVX", "CVX"] : ["pxCVX", "lpxCVX", "CVX", outputSymbol],
      protocols: outputIsCvx ? ["Pirex", "Curve"] : ["Pirex", "Curve", "Enso"],
    },
  };
}
