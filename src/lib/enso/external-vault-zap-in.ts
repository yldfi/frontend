// This module is part of an import cycle with the other two of
// conversions.ts, external-vault-zap-in.ts and external-vault-routes.ts.
// Keep it free of top-level initialisers (const/let/class that read an
// import): only imports and function declarations are safe here.
import type {
  CustomBundleResponse,
  EnsoBundleAction,
  RouteInfo,
  RouteStep,
} from "@/types/enso";
import { TOKENS } from "@/config/vaults";
import {
  calculateMinDy,
  previewRedeem,
  validateSlippage,
} from "@/lib/curve";
import { fetchEnsoIntent } from "@/lib/enso-intents";
import { fetchBundle, rpcWithFallback } from "./api";
import {
  applySlippageBuffer,
  createRouteStep,
  estimateRequiredRouteOutput,
  formatRouteAmount,
  rawCallConsumingInput,
} from "./bundle-helpers";
import { CVXCRV_ADDRESS, ENSO_SHORTCUTS } from "./constants";
import { getLpxCvxToCvxSwapRate } from "./pxcvx-pool";
import { getTokenSymbol } from "./tokens";
import { fetchComposableZapInRoute } from "./external-vault-routes";

// ============================================================================
// Llama Airforce (Union) External Vault Zap Functions
// ============================================================================

/**
 * Preview uCRV withdraw - estimates cvxCRV output for given shares
 * uCRV uses a non-standard interface (not ERC4626)
 * Formula: shares * totalUnderlying / totalSupply
 */
export async function previewUCrvWithdraw(shares: string): Promise<string> {
  const { LLAMA_AIRFORCE } = await import("@/config/vaults");

  // Batch RPC calls: totalUnderlying() and totalSupply()
  const batch = [
    { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: LLAMA_AIRFORCE.UCRV, data: "0xc70920bc" }, "latest"] }, // totalUnderlying()
    { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: LLAMA_AIRFORCE.UCRV, data: "0x18160ddd" }, "latest"] }, // totalSupply()
  ];

  const results = await rpcWithFallback<Array<{ id: number; result?: string }>>(batch);
  results.sort((a, b) => a.id - b.id);

  const totalUnderlyingRaw = results[0]?.result;
  const totalSupplyRaw = results[1]?.result;
  if (!totalUnderlyingRaw || totalUnderlyingRaw === "0x" || !totalSupplyRaw || totalSupplyRaw === "0x") {
    throw new Error("Failed to preview uCRV withdraw");
  }
  const totalUnderlying = BigInt(totalUnderlyingRaw);
  const totalSupply = BigInt(totalSupplyRaw);

  if (totalSupply === 0n) {
    throw new Error("Failed to preview uCRV withdraw");
  }

  // shares * totalUnderlying / totalSupply
  const cvxCrvOutput = (BigInt(shares) * totalUnderlying) / totalSupply;
  return cvxCrvOutput.toString();
}

/**
 * Zap from uCRV (Llama Airforce) into any yld vault
 *
 * Route: uCRV → withdraw → cvxCRV → route to target underlying → deposit
 *
 * CRITICAL: uCRV uses non-standard withdraw(_to, _shares) signature!
 * - NOT ERC4626 redeem(shares, receiver, owner)
 * - Tokens go to ENSO_SHORTCUTS (msg.sender when Enso calls external contracts)
 */
export async function fetchUCrvZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  const { LLAMA_AIRFORCE, getVaultByAddress } = await import("@/config/vaults");
  const slippageBps = validateSlippage(params.slippage);

  // Get target vault's underlying token
  const targetVault = getVaultByAddress(params.vaultAddress);
  if (!targetVault) {
    throw new Error(`Unknown target vault: ${params.vaultAddress}`);
  }
  const targetUnderlying = targetVault.assetAddress;
  if (targetUnderlying.toLowerCase() === TOKENS.PXCVX.toLowerCase()) {
    const { LLAMA_AIRFORCE } = await import("@/config/vaults");
    return fetchComposableZapInRoute({
      fromAddress: params.fromAddress,
      inputToken: LLAMA_AIRFORCE.UCRV,
      vaultAddress: params.vaultAddress,
      amountIn: params.amountIn,
      slippage: params.slippage,
    });
  }
  const vaultSymbol = targetVault.symbol;

  // Estimate cvxCRV output from uCRV withdraw
  const expectedCvxCrvOutput = await previewUCrvWithdraw(params.amountIn);
  const conservativeCvxCrv = applySlippageBuffer(BigInt(expectedCvxCrvOutput), slippageBps);

  // Check if target vault accepts cvxCRV directly
  const targetIsCvxCrv = targetUnderlying.toLowerCase() === LLAMA_AIRFORCE.UCRV_UNDERLYING.toLowerCase();

  const actions: EnsoBundleAction[] = [
    // Action 0: Withdraw uCRV → cvxCRV using custom call (non-ERC4626)
    rawCallConsumingInput(params.amountIn, LLAMA_AIRFORCE.UCRV, {
      address: LLAMA_AIRFORCE.UCRV,
      method: "withdraw",
      abi: "function withdraw(address _to, uint256 _shares) returns (uint256)",
      args: [
        ENSO_SHORTCUTS, // cvxCRV goes to Enso Shortcuts for downstream actions
        params.amountIn,
      ],
    }),
  ];

  let expectedTargetUnderlyingOutput = 0n;

  if (targetIsCvxCrv) {
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: LLAMA_AIRFORCE.UCRV_UNDERLYING,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 0 },
        primaryAddress: params.vaultAddress,
      },
    });
  } else {
    expectedTargetUnderlyingOutput = await estimateRequiredRouteOutput(
      params.fromAddress,
      LLAMA_AIRFORCE.UCRV_UNDERLYING,
      targetUnderlying,
      expectedCvxCrvOutput,
      params.slippage ?? "100",
    );
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: LLAMA_AIRFORCE.UCRV_UNDERLYING,
        tokenOut: targetUnderlying,
        amountIn: { useOutputOfCallAt: 0 },
        slippage: params.slippage ?? "100",
      },
    });
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: targetUnderlying,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 1 },
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
    createRouteStep({
      tokenAddress: LLAMA_AIRFORCE.UCRV,
      tokenSymbol: "uCRV",
      amount: params.amountIn,
      action: "Exit",
      description: "uCRV for cvxCRV",
      protocol: "Llama Airforce",
    }),
  ];

  if (targetIsCvxCrv) {
    steps.push({ tokenSymbol: "cvxCRV", amount: formatRouteAmount(conservativeCvxCrv, CVXCRV_ADDRESS), rawAmount: conservativeCvxCrv, action: "Deposit", description: `cvxCRV into ${vaultSymbol}`, protocol: "yld" });
  } else {
    steps.push({ tokenSymbol: "cvxCRV", amount: formatRouteAmount(conservativeCvxCrv, CVXCRV_ADDRESS), rawAmount: conservativeCvxCrv, action: "Swap", description: `cvxCRV for ${targetUnderlyingSymbol}`, protocol: "Enso" });
    steps.push({ tokenSymbol: targetUnderlyingSymbol, amount: formatRouteAmount(expectedTargetUnderlyingOutput, targetUnderlying), action: "Deposit", description: `${targetUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
  }

  steps.push({ tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" });

  const routeInfo: RouteInfo = {
    steps,
    tokens: targetIsCvxCrv
      ? ["uCRV", "cvxCRV", vaultSymbol]
      : ["uCRV", "cvxCRV", targetUnderlyingSymbol, vaultSymbol],
    protocols: targetIsCvxCrv
      ? ["Llama Airforce", "yld"]
      : ["Llama Airforce", "Enso", "yld"],
  };

  return { ...bundleResult, routeInfo };
}

/**
 * Zap from uCVX (Llama Airforce) into any yld vault
 *
 * Route: uCVX → redeem → pxCVX → route to target underlying → deposit
 *
 * uCVX is a standard ERC4626 vault for pxCVX
 */
export async function fetchUCvxZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  const { LLAMA_AIRFORCE, getVaultByAddress } = await import("@/config/vaults");
  const slippageBps = validateSlippage(params.slippage);

  // Get target vault's underlying token
  const targetVault = getVaultByAddress(params.vaultAddress);
  if (!targetVault) {
    throw new Error(`Unknown target vault: ${params.vaultAddress}`);
  }
  const targetUnderlying = targetVault.assetAddress;
  const vaultSymbol = targetVault.symbol;

  // Estimate pxCVX output from uCVX redeem using standard previewRedeem
  const expectedPxCvxOutput = await previewRedeem(LLAMA_AIRFORCE.UCVX, params.amountIn);

  // Check if target vault accepts pxCVX directly (yspxCVX)
  const targetIsPxCvx = targetUnderlying.toLowerCase() === LLAMA_AIRFORCE.UCVX_UNDERLYING.toLowerCase();

  // Intermediate CVX amount for route display (populated in the non-pxCvx branch)
  let intermediateCvxAmount = 0n;
  let expectedTargetUnderlyingOutput = 0n;

  const actions: EnsoBundleAction[] = [
    // Action 0: Redeem uCVX → pxCVX using standard ERC4626
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: LLAMA_AIRFORCE.UCVX,
        tokenOut: LLAMA_AIRFORCE.UCVX_UNDERLYING, // pxCVX
        amountIn: params.amountIn,
        primaryAddress: LLAMA_AIRFORCE.UCVX,
      },
    },
  ];

  if (targetIsPxCvx) {
    // Direct deposit - target accepts pxCVX
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: LLAMA_AIRFORCE.UCVX_UNDERLYING,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 0 },
        primaryAddress: params.vaultAddress,
      },
    });
  } else {
    // pxCVX has no direct DEX liquidity - need to route via CVX
    // pxCVX → lpxCVX (1:1 wrap) → CVX (Curve) → target underlying

    // Use the existing pxCVX out routing infrastructure
    // First, we need to exit pxCVX to CVX, then route CVX to target underlying
    const { PIREX } = await import("@/config/vaults");

    // Calculate expected CVX output from lpxCVX → CVX swap
    // The legs spend the runtime redeem output (useOutputOfCallAt: 0), so quote the unbuffered amount.
    const expectedCvxOutput = await getLpxCvxToCvxSwapRate(BigInt(expectedPxCvxOutput).toString());
    if (expectedCvxOutput === 0n) {
      throw new Error("Failed to estimate Curve lpxCVX→CVX swap output");
    }
    intermediateCvxAmount = expectedCvxOutput;
    const minDy = calculateMinDy(expectedCvxOutput, slippageBps);

    // Action 1: Approve pxCVX to lpxCVX contract for wrapping
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: LLAMA_AIRFORCE.UCVX_UNDERLYING, // pxCVX
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: 0 },
      },
    });

    // Action 2: Wrap pxCVX → lpxCVX (1:1 ratio)
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "wrap",
        abi: "function wrap(uint256 amount)",
        args: [{ useOutputOfCallAt: 0 }],
      },
    });

    // Action 3: Approve lpxCVX to Curve pool
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: { useOutputOfCallAt: 0 }, // Same as pxCVX (1:1 wrap)
      },
    });

    // Action 4: Exchange lpxCVX → CVX on Curve pool
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
          { useOutputOfCallAt: 0 }, // dx = same as pxCVX (1:1 wrap)
          minDy, // min_dy with slippage
        ],
      },
    });

    // Branch on target underlying — CVX deposits directly; cvxCRV/crvUSD/others go via Enso.
    const targetIsCvx = targetUnderlying.toLowerCase() === TOKENS.CVX.toLowerCase();

    if (targetIsCvx) {
      // Direct deposit CVX
      actions.push({
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: TOKENS.CVX,
          tokenOut: params.vaultAddress,
          amountIn: { useOutputOfCallAt: 4 },
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
      // Route CVX → target underlying via Enso (works for cvxCRV, crvUSD, etc.)
      actions.push({
        protocol: "enso",
        action: "route",
        args: {
          tokenIn: TOKENS.CVX,
          tokenOut: targetUnderlying,
          amountIn: { useOutputOfCallAt: 4 },
          slippage: params.slippage ?? "100",
        },
      });
      actions.push({
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: targetUnderlying,
          tokenOut: params.vaultAddress,
          amountIn: { useOutputOfCallAt: 5 },
          primaryAddress: params.vaultAddress,
        },
      });
    }
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
    createRouteStep({
      tokenAddress: LLAMA_AIRFORCE.UCVX,
      tokenSymbol: "uCVX",
      amount: params.amountIn,
      action: "Exit",
      description: "uCVX for pxCVX",
      protocol: "Llama Airforce",
    }),
  ];

  // Intermediate amounts for display
  const pxCvxAmountFmt = (Number(expectedPxCvxOutput) / 1e18).toFixed(4);
  const cvxAmountFmt =
    intermediateCvxAmount > 0n
      ? (Number(intermediateCvxAmount) / 1e18).toFixed(4)
      : undefined;

  if (targetIsPxCvx) {
    steps.push({ tokenSymbol: "pxCVX", amount: pxCvxAmountFmt, action: "Deposit", description: `pxCVX into ${vaultSymbol}`, protocol: "yld" });
  } else {
    steps.push({ tokenSymbol: "pxCVX", amount: pxCvxAmountFmt, action: "Swap", description: "pxCVX for CVX", protocol: "Curve" });

    const targetIsCvx = targetUnderlying.toLowerCase() === TOKENS.CVX.toLowerCase();
    if (targetIsCvx) {
      steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Deposit", description: `CVX into ${vaultSymbol}`, protocol: "yld" });
    } else {
      steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Swap", description: `CVX for ${targetUnderlyingSymbol}`, protocol: "Enso" });
      steps.push({ tokenSymbol: targetUnderlyingSymbol, amount: formatRouteAmount(expectedTargetUnderlyingOutput, targetUnderlying), action: "Deposit", description: `${targetUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
    }
  }

  steps.push({ tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" });

  // Build token path based on actual route
  let tokens: string[];
  let protocols: string[];
  if (targetIsPxCvx) {
    tokens = ["uCVX", "pxCVX", vaultSymbol];
    protocols = ["Llama Airforce", "yld"];
  } else {
    const targetIsCvx = targetUnderlying.toLowerCase() === TOKENS.CVX.toLowerCase();
    if (targetIsCvx) {
      tokens = ["uCVX", "pxCVX", "CVX", vaultSymbol];
      protocols = ["Llama Airforce", "Curve", "yld"];
    } else {
      tokens = ["uCVX", "pxCVX", "CVX", targetUnderlyingSymbol, vaultSymbol];
      protocols = ["Llama Airforce", "Curve", "Enso", "yld"];
    }
  }

  const routeInfo: RouteInfo = { steps, tokens, protocols };

  return { ...bundleResult, routeInfo };
}

/**
 * Preview Beefy vault withdraw - estimates underlying output for given shares
 * Beefy vaults use getPricePerFullShare() to calculate conversion
 * Formula: shares * pricePerFullShare / 1e18
 */
export async function previewBeefyWithdraw(vaultAddress: string, shares: string): Promise<string> {
  // pricePerFullShare() selector: 0x77c7b8fc
  const result = await rpcWithFallback<{ result?: string }>({
    jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to: vaultAddress, data: "0x77c7b8fc" }, "latest"],
  });
  const pricePerFullShareRaw = result.result;
  if (!pricePerFullShareRaw || pricePerFullShareRaw === "0x") {
    throw new Error("Failed to preview Beefy withdraw");
  }
  const pricePerFullShare = BigInt(pricePerFullShareRaw);
  if (pricePerFullShare === 0n) {
    throw new Error("Failed to preview Beefy withdraw");
  }

  // shares * pricePerFullShare / 1e18
  const underlyingOutput = (BigInt(shares) * pricePerFullShare) / BigInt(1e18);
  return underlyingOutput.toString();
}

/**
 * Generic zap from external ERC4626 vault into any yld vault
 * Works for: aCVX, aCRV (Concentrator)
 *
 * Route: externalVault → redeem → underlying → route to target underlying → deposit
 */
export async function fetchErc4626ExternalVaultZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  externalVaultAddress: string;
  externalVaultUnderlying: string;
  externalVaultSymbol: string;
  externalVaultProtocol: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  const { getVaultByAddress } = await import("@/config/vaults");
  const slippageBps = validateSlippage(params.slippage);

  // Get target vault's underlying token
  const targetVault = getVaultByAddress(params.vaultAddress);
  if (!targetVault) {
    throw new Error(`Unknown target vault: ${params.vaultAddress}`);
  }
  const targetUnderlying = targetVault.assetAddress;
  if (targetUnderlying.toLowerCase() === TOKENS.PXCVX.toLowerCase()) {
    return fetchComposableZapInRoute({
      fromAddress: params.fromAddress,
      inputToken: params.externalVaultAddress,
      vaultAddress: params.vaultAddress,
      amountIn: params.amountIn,
      slippage: params.slippage,
    });
  }
  const vaultSymbol = targetVault.symbol;

  // Estimate underlying output from ERC4626 redeem
  const expectedUnderlyingOutput = await previewRedeem(params.externalVaultAddress, params.amountIn);
  void slippageBps; // retained for future slippage-aware hops

  // Check if target vault accepts the same underlying directly
  const sameUnderlying = targetUnderlying.toLowerCase() === params.externalVaultUnderlying.toLowerCase();

  const actions: EnsoBundleAction[] = [
    // Action 0: Redeem external vault → underlying using standard ERC4626
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.externalVaultAddress,
        tokenOut: params.externalVaultUnderlying,
        amountIn: params.amountIn,
        primaryAddress: params.externalVaultAddress,
      },
    },
  ];

  let expectedTargetUnderlyingOutput = 0n;

  if (sameUnderlying) {
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: params.externalVaultUnderlying,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 0 },
        primaryAddress: params.vaultAddress,
      },
    });
  } else {
    expectedTargetUnderlyingOutput = await estimateRequiredRouteOutput(
      params.fromAddress,
      params.externalVaultUnderlying,
      targetUnderlying,
      expectedUnderlyingOutput,
      params.slippage ?? "100",
    );
    // Route underlying → target underlying via Enso
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.externalVaultUnderlying,
        tokenOut: targetUnderlying,
        amountIn: { useOutputOfCallAt: 0 },
        slippage: params.slippage ?? "100",
      },
    });
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: targetUnderlying,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 1 },
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
  const externalUnderlyingSymbol = getTokenSymbol(params.externalVaultUnderlying);
  const targetUnderlyingSymbol = getTokenSymbol(targetUnderlying);
  const externalUnderlyingFmt = formatRouteAmount(expectedUnderlyingOutput, params.externalVaultUnderlying);
  const steps: RouteStep[] = [
    createRouteStep({
      tokenAddress: params.externalVaultAddress,
      tokenSymbol: params.externalVaultSymbol,
      amount: params.amountIn,
      action: "Exit",
      description: `${params.externalVaultSymbol} for ${externalUnderlyingSymbol}`,
      protocol: params.externalVaultProtocol,
    }),
  ];

  if (sameUnderlying) {
    steps.push({ tokenSymbol: externalUnderlyingSymbol, amount: externalUnderlyingFmt, action: "Deposit", description: `${externalUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
  } else {
    steps.push({ tokenSymbol: externalUnderlyingSymbol, amount: externalUnderlyingFmt, action: "Swap", description: `${externalUnderlyingSymbol} for ${targetUnderlyingSymbol}`, protocol: "Enso" });
    steps.push({ tokenSymbol: targetUnderlyingSymbol, amount: formatRouteAmount(expectedTargetUnderlyingOutput, targetUnderlying), action: "Deposit", description: `${targetUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
  }

  steps.push({ tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" });

  const routeInfo: RouteInfo = {
    steps,
    tokens: sameUnderlying
      ? [params.externalVaultSymbol, externalUnderlyingSymbol, vaultSymbol]
      : [params.externalVaultSymbol, externalUnderlyingSymbol, targetUnderlyingSymbol, vaultSymbol],
    protocols: sameUnderlying
      ? [params.externalVaultProtocol, "yld"]
      : [params.externalVaultProtocol, "Enso", "yld"],
  };

  return { ...bundleResult, routeInfo };
}

/**
 * Generic zap from Beefy vault into any yld vault
 * Works for: mooCvxCRV, mooCvxCVX
 *
 * Route: beefyVault → withdraw → underlying → route to target underlying → deposit
 *
 * CRITICAL: Beefy uses withdraw(shares) which returns to msg.sender (ENSO_SHORTCUTS)
 */
export async function fetchBeefyZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  beefyVaultAddress: string;
  beefyVaultUnderlying: string;
  beefyVaultSymbol: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  const { getVaultByAddress } = await import("@/config/vaults");
  const slippageBps = validateSlippage(params.slippage);

  // Get target vault's underlying token
  const targetVault = getVaultByAddress(params.vaultAddress);
  if (!targetVault) {
    throw new Error(`Unknown target vault: ${params.vaultAddress}`);
  }
  const targetUnderlying = targetVault.assetAddress;
  if (targetUnderlying.toLowerCase() === TOKENS.PXCVX.toLowerCase()) {
    return fetchComposableZapInRoute({
      fromAddress: params.fromAddress,
      inputToken: params.beefyVaultAddress,
      vaultAddress: params.vaultAddress,
      amountIn: params.amountIn,
      slippage: params.slippage,
    });
  }
  const vaultSymbol = targetVault.symbol;

  // Estimate underlying output from Beefy withdraw
  const expectedUnderlyingOutput = await previewBeefyWithdraw(params.beefyVaultAddress, params.amountIn);
  const conservativeUnderlying = applySlippageBuffer(BigInt(expectedUnderlyingOutput), slippageBps);

  // Check if target vault accepts the same underlying directly
  const sameUnderlying = targetUnderlying.toLowerCase() === params.beefyVaultUnderlying.toLowerCase();

  const actions: EnsoBundleAction[] = [
    // Action 0: Withdraw Beefy vault → underlying using custom call
    rawCallConsumingInput(params.amountIn, params.beefyVaultAddress, {
      address: params.beefyVaultAddress,
      method: "withdraw",
      abi: "function withdraw(uint256 _shares)",
      args: [params.amountIn],
    }),
    // Action 1: Get balance of underlying (withdraw doesn't return amount)
    {
      protocol: "enso",
      action: "balance",
      args: {
        token: params.beefyVaultUnderlying,
      },
    },
  ];

  let expectedTargetUnderlyingOutput = 0n;

  if (sameUnderlying) {
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: params.beefyVaultUnderlying,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 1 },
        primaryAddress: params.vaultAddress,
      },
    });
  } else {
    expectedTargetUnderlyingOutput = await estimateRequiredRouteOutput(
      params.fromAddress,
      params.beefyVaultUnderlying,
      targetUnderlying,
      expectedUnderlyingOutput,
      params.slippage ?? "100",
    );
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.beefyVaultUnderlying,
        tokenOut: targetUnderlying,
        amountIn: { useOutputOfCallAt: 1 },
        slippage: params.slippage ?? "100",
      },
    });
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
  const beefyUnderlyingSymbol = getTokenSymbol(params.beefyVaultUnderlying);
  const targetUnderlyingSymbol = getTokenSymbol(targetUnderlying);
  const steps: RouteStep[] = [
    createRouteStep({
      tokenAddress: params.beefyVaultAddress,
      tokenSymbol: params.beefyVaultSymbol,
      amount: params.amountIn,
      action: "Exit",
      description: `${params.beefyVaultSymbol} for ${beefyUnderlyingSymbol}`,
      protocol: "Beefy",
    }),
  ];

  if (sameUnderlying) {
    steps.push({ tokenSymbol: beefyUnderlyingSymbol, amount: formatRouteAmount(conservativeUnderlying, params.beefyVaultUnderlying), rawAmount: conservativeUnderlying, action: "Deposit", description: `${beefyUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
  } else {
    steps.push({ tokenSymbol: beefyUnderlyingSymbol, amount: formatRouteAmount(conservativeUnderlying, params.beefyVaultUnderlying), rawAmount: conservativeUnderlying, action: "Swap", description: `${beefyUnderlyingSymbol} for ${targetUnderlyingSymbol}`, protocol: "Enso" });
    steps.push({ tokenSymbol: targetUnderlyingSymbol, amount: formatRouteAmount(expectedTargetUnderlyingOutput, targetUnderlying), action: "Deposit", description: `${targetUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
  }

  steps.push({ tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" });

  const routeInfo: RouteInfo = {
    steps,
    tokens: sameUnderlying
      ? [params.beefyVaultSymbol, beefyUnderlyingSymbol, vaultSymbol]
      : [params.beefyVaultSymbol, beefyUnderlyingSymbol, targetUnderlyingSymbol, vaultSymbol],
    protocols: sameUnderlying
      ? ["Beefy", "yld"]
      : ["Beefy", "Enso", "yld"],
  };

  return { ...bundleResult, routeInfo };
}

/**
 * Master function to zap from any external vault into any yld vault
 * Dispatches to the appropriate routing function based on external vault type
 */
export async function fetchExternalVaultZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  externalVaultAddress: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<CustomBundleResponse>({
      intent: "externalVaultZapInToYld",
      fromAddress: params.fromAddress,
      externalVaultAddress: params.externalVaultAddress,
      vaultAddress: params.vaultAddress,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const { getExternalVaultConfig, LLAMA_AIRFORCE } = await import("@/config/vaults");

  const config = getExternalVaultConfig(params.externalVaultAddress);
  if (!config) {
    throw new Error(`Unknown external vault: ${params.externalVaultAddress}`);
  }

  // Dispatch to appropriate routing function based on interface type
  switch (config.interface) {
    case "ucrv":
      // Llama Airforce uCRV - special withdraw(_to, _shares) interface
      return fetchUCrvZapInRoute({
        fromAddress: params.fromAddress,
        vaultAddress: params.vaultAddress,
        amountIn: params.amountIn,
        slippage: params.slippage,
      });

    case "beefy":
      // Beefy vaults - withdraw(shares) interface
      return fetchBeefyZapInRoute({
        fromAddress: params.fromAddress,
        vaultAddress: params.vaultAddress,
        beefyVaultAddress: config.address,
        beefyVaultUnderlying: config.underlying,
        beefyVaultSymbol: config.symbol,
        amountIn: params.amountIn,
        slippage: params.slippage,
      });

    case "erc4626":
    default:
      // Check if it's uCVX (special pxCVX routing needed)
      if (config.address.toLowerCase() === LLAMA_AIRFORCE.UCVX.toLowerCase()) {
        return fetchUCvxZapInRoute({
          fromAddress: params.fromAddress,
          vaultAddress: params.vaultAddress,
          amountIn: params.amountIn,
          slippage: params.slippage,
        });
      }

      // Standard ERC4626 external vaults (aCVX, aCRV)
      return fetchErc4626ExternalVaultZapInRoute({
        fromAddress: params.fromAddress,
        vaultAddress: params.vaultAddress,
        externalVaultAddress: config.address,
        externalVaultUnderlying: config.underlying,
        externalVaultSymbol: config.symbol,
        externalVaultProtocol: config.protocol,
        amountIn: params.amountIn,
        slippage: params.slippage,
      });
  }
}
