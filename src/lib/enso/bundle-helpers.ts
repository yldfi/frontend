import type {
  EnsoBundleAction,
  RouteInfo,
  RouteStep,
} from "@/types/enso";
import { WETH_ADDRESS } from "@/config/addresses";
import { TOKENS } from "@/config/vaults";
import { formatTokenAmount } from "@/lib/utils";
import { assertSafeSlippageBps } from "@/lib/enso-swap-protection";
import { estimateRouteOutput } from "./api";
import {
  ETH_ADDRESS,
  HYBRID_EXTRA_BUFFER_BPS,
  isNativeETH,
} from "./constants";
import { getTokenDecimals, getTokenSymbol } from "./tokens";

/**
 * If the last route action targets ETH, rewrite it to target WETH and
 * append a wrapped-native/redeem action to unwrap WETH → ETH.
 * This avoids the weiroll slippage check failure for native ETH output.
 */
export function appendETHUnwrapIfNeeded(actions: EnsoBundleAction[], outputToken: string): EnsoBundleAction[] {
  if (!isNativeETH(outputToken)) return actions;

  // Find the last route action and change tokenOut to WETH
  const lastRouteIdx = actions.length - 1;
  const lastAction = actions[lastRouteIdx];
  if (lastAction.protocol === "enso" && lastAction.action === "route") {
    actions[lastRouteIdx] = {
      ...lastAction,
      args: {
        ...lastAction.args,
        tokenOut: WETH_ADDRESS.toLowerCase(),
      },
    };
  }

  // Append wrapped-native/redeem to unwrap WETH → ETH
  actions.push({
    protocol: "wrapped-native",
    action: "redeem",
    args: {
      tokenIn: WETH_ADDRESS.toLowerCase(),
      tokenOut: ETH_ADDRESS,
      amountIn: { useOutputOfCallAt: lastRouteIdx },
      primaryAddress: WETH_ADDRESS.toLowerCase(),
    },
  });

  return actions;
}

/** Protect the complete zap output, not only an intermediate market swap. */
export function appendTerminalSlippageGuard(
  actions: EnsoBundleAction[],
  slippageBps: string,
  outputIndex = actions.length - 1,
): void {
  assertSafeSlippageBps(slippageBps, "terminal slippage");
  if (outputIndex < 0 || outputIndex >= actions.length) {
    throw new Error("Cannot protect an invalid terminal action output");
  }
  actions.push({
    protocol: "enso",
    action: "slippage",
    args: {
      amountOut: { useOutputOfCallAt: outputIndex },
      bps: slippageBps,
    },
  });
}

/**
 * skipQuote bundles never quote their dynamic-input `route` leg, which Enso
 * restricts to grapher/openocean (fetchBundle's ignoreAggregators). The leg's
 * own minimum is derived from that restricted quote, so a bad restricted route
 * (5 Nov 2026: ~38% below market) would execute short while the UI showed the
 * unrestricted standalone estimate. Add an absolute floor from that estimate.
 * Tolerance is max(5%, slippage + 1%): the restricted route normally prices a
 * little worse (~1.5% on uCRV -> USDC on 10 Nov), so a tight floor would revert
 * healthy zaps. Below the floor the tx reverts (gas only) instead of filling.
 */
export function appendDynamicRouteFloor(
  actions: EnsoBundleAction[],
  routeIndex: number,
  standaloneEstimate: bigint | string,
  slippage?: string,
): void {
  const route = actions[routeIndex];
  if (!route || route.protocol !== "enso" || route.action !== "route") {
    throw new Error("appendDynamicRouteFloor: routeIndex must point at an Enso route action");
  }
  const estimate = BigInt(standaloneEstimate);
  if (estimate <= 0n) return;
  const slippageBps = Number(slippage ?? "100");
  const toleranceBps = BigInt(
    Math.min(9000, Math.max(500, (Number.isFinite(slippageBps) ? slippageBps : 100) + 100)),
  );
  const floor = (estimate * (10000n - toleranceBps)) / 10000n;
  if (floor <= 0n) return;
  // Insert directly after the route so a trailing ETH unwrap stays the final
  // (delivery) action. Splicing shifts later actions, so refuse if any of them
  // references an index past the route.
  const later = actions.slice(routeIndex + 1);
  const refs = [...JSON.stringify(later).matchAll(/"useOutputOfCallAt":(\d+)/g)].map((m) => Number(m[1]));
  if (refs.some((ref) => ref > routeIndex)) {
    throw new Error("appendDynamicRouteFloor: actions after the route reference later outputs");
  }
  actions.splice(routeIndex + 1, 0, {
    protocol: "enso",
    action: "minamountout",
    args: {
      amountOut: { useOutputOfCallAt: routeIndex },
      minAmountOut: floor.toString(),
    },
  });
}

export const CURVE_USDC_CRVUSD_POOL = "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E";
export const CURVE_TRICRV_POOL = "0x4eBdF703948ddCEA3B11f675B4D1Fba9d2414A14";
export const CURVE_ROUTER = "0x99a58482BD75cbab83b27EC03CA68fF489b5788f";
/**
 * Calculate conservative input amount after slippage has been applied to previous step.
 * When chaining bundle actions with fixed amounts (instead of useOutputOfCallAt),
 * we need to account for the fact that the previous step may have received less
 * than estimated due to slippage. This function reduces the estimated amount
 * by the slippage percentage to avoid trying to spend more than we have.
 *
 * @param estimatedAmount - The estimated amount from the previous step
 * @param slippageBps - Slippage in basis points (100 = 1%)
 * @returns Conservative amount as string that's safe to use after slippage
 */
export function applySlippageBuffer(estimatedAmount: bigint, slippageBps: number): string {
  // Apply same formula as calculateMinDy: amount * (10000 - slippage) / 10000
  const conservativeAmount = (estimatedAmount * BigInt(10000 - slippageBps)) / BigInt(10000);
  return conservativeAmount.toString();
}

export function getBufferedSlippageBps(slippageBps: number): number {
  return Math.min(10000, slippageBps + HYBRID_EXTRA_BUFFER_BPS);
}

export type BundleAmountRef = string | { useOutputOfCallAt: number };

export function isDynamicAmountRef(amount: BundleAmountRef): amount is { useOutputOfCallAt: number } {
  return typeof amount === "object" && amount !== null && "useOutputOfCallAt" in amount;
}

function erc20ApproveAction(token: string, spender: string, amount: BundleAmountRef): EnsoBundleAction {
  return {
    protocol: "erc20",
    action: "approve",
    args: { token, spender, amount },
  };
}

export function rawApproveCallAction(token: string, spender: string, amount: BundleAmountRef): EnsoBundleAction {
  return {
    protocol: "enso",
    action: "call",
    args: {
      address: token,
      method: "approve",
      abi: "function approve(address spender, uint256 amount) returns (bool)",
      args: [spender, amount],
    },
  };
}

/**
 * A raw call that is the first thing to consume the wallet's input (unwrap, a non-ERC4626 vault
 * withdraw). Router-mode Enso only pulls tokens it can attribute to an action, and a bare call
 * declares none, so a fixed amount is declared via the call's tokenIn/amountIn (documented call
 * params). Runtime amounts were produced earlier in the bundle and need no declaration.
 */
export function rawCallConsumingInput(
  amount: BundleAmountRef,
  inputToken: string,
  call: { address: string; method: string; abi: string; args: unknown[] },
): EnsoBundleAction {
  return {
    protocol: "enso",
    action: "call",
    args: isDynamicAmountRef(amount) ? call : { ...call, tokenIn: inputToken, amountIn: amount },
  };
}

export function intermediateApproveAction(
  token: string,
  spender: string,
  amount: BundleAmountRef,
  forceRawCall: boolean,
): EnsoBundleAction {
  return forceRawCall
    ? rawApproveCallAction(token, spender, amount)
    : erc20ApproveAction(token, spender, amount);
}

/**
 * When a runtime CVX amount is split between a swap and a mint, the split is sized from a
 * slippage-buffered estimate. Mint whatever CVX the swap leg left (read at runtime) instead of
 * the fixed estimate, so the buffer doesn't stay behind at the shared EnsoShortcuts contract.
 */
/**
 * Expected output of a CVX swap/mint split for the CVX the bundle actually spends. Splits are
 * sized from a slippage-buffered estimate, but runtime legs spend the whole balance (a fixed swap
 * leg plus the remaining balance for the mint). The intent guard derives the on-chain minimum
 * from this, so reporting the buffered figure set it ~2x slippage below the real output.
 */
export async function runtimeSplitOutput(p: {
  runtimeCvx: bigint;
  swapAmount: bigint;
  mintAmount: bigint;
  expectedSwapOut: bigint;
  quoteSwap: (amount: string) => Promise<bigint | null>;
}): Promise<bigint> {
  const { runtimeCvx, swapAmount, mintAmount, expectedSwapOut } = p;
  if (swapAmount > 0n && mintAmount > 0n) {
    return expectedSwapOut + (runtimeCvx > swapAmount ? runtimeCvx - swapAmount : 0n);
  }
  if (swapAmount > 0n) return (await p.quoteSwap(runtimeCvx.toString())) || expectedSwapOut;
  return runtimeCvx;
}

export function remainingCvxForMint(actions: EnsoBundleAction[]): BundleAmountRef {
  actions.push({ protocol: "enso", action: "balance", args: { token: TOKENS.CVX } });
  return { useOutputOfCallAt: actions.length - 1 };
}

type PirexLpxSwapConfig = {
  readonly LPXCVX: string;
  readonly TOKEN_ENUM: { readonly CVX: number };
  readonly POOL_INDEX: { readonly CVX: number; readonly LPXCVX: number };
};

function lpxCvxSwapCallAction(
  pirex: PirexLpxSwapConfig,
  amount: BundleAmountRef,
  minReceived: string,
): EnsoBundleAction {
  return {
    protocol: "enso",
    action: "call",
    args: {
      address: pirex.LPXCVX,
      method: "swap",
      abi: "function swap(uint8 source, uint256 amount, uint256 minReceived, uint256 fromIndex, uint256 toIndex)",
      args: [
        String(pirex.TOKEN_ENUM.CVX),
        amount,
        minReceived,
        String(pirex.POOL_INDEX.CVX),
        String(pirex.POOL_INDEX.LPXCVX),
      ],
    },
  };
}

export function pushCvxToPxCvxSwapActions(
  actions: EnsoBundleAction[],
  pirex: PirexLpxSwapConfig,
  amount: BundleAmountRef,
  minReceived: string,
  forceRawApprove: boolean,
): void {
  actions.push(
    intermediateApproveAction(TOKENS.CVX, pirex.LPXCVX, amount, forceRawApprove),
    lpxCvxSwapCallAction(pirex, amount, minReceived),
  );
}

type RouteTraceStep = Omit<RouteStep, "amount" | "tokenSymbol"> & {
  tokenAddress: string;
  tokenSymbol?: string;
  amount?: bigint | string;
};



export function formatRouteAmount(amount: bigint | string, tokenAddress: string): string {
  const rawAmount = typeof amount === "bigint" ? amount : BigInt(amount);
  return formatTokenAmount(rawAmount, getTokenDecimals(tokenAddress), 4);
}

export function formatRouteDeltaAmount(
  amountOut: bigint | string,
  amountIn: bigint | string,
  tokenAddress: string,
): string {
  const rawAmountOut = typeof amountOut === "bigint" ? amountOut : BigInt(amountOut);
  const rawAmountIn = typeof amountIn === "bigint" ? amountIn : BigInt(amountIn);
  const delta = rawAmountOut >= rawAmountIn
    ? rawAmountOut - rawAmountIn
    : rawAmountIn - rawAmountOut;
  return formatRouteAmount(delta, tokenAddress);
}

export function createRouteStep(step: RouteTraceStep): RouteStep {
  const rawAmount =
    step.amount === undefined
      ? undefined
      : typeof step.amount === "bigint"
        ? step.amount.toString()
        : step.amount;
  return {
    tokenSymbol: step.tokenSymbol ?? getTokenSymbol(step.tokenAddress),
    tokenAddress: step.tokenAddress,
    amount: step.amount === undefined ? undefined : formatRouteAmount(step.amount, step.tokenAddress),
    rawAmount,
    action: step.action,
    description: step.description,
    protocol: step.protocol,
    bonus: step.bonus,
    bonusAmount: step.bonusAmount,
    bonusSymbol: step.bonusSymbol,
    slippage: step.slippage,
  };
}

export function buildRouteMetadataFromSteps(steps: RouteStep[]): Pick<RouteInfo, "tokens" | "protocols"> {
  const seenTokens = new Set<string>();
  const seenProtocols = new Set<string>();
  const tokens: string[] = [];
  const protocols: string[] = [];

  for (const step of steps) {
    const tokenKey = step.tokenSymbol.toLowerCase();
    if (!seenTokens.has(tokenKey)) {
      seenTokens.add(tokenKey);
      tokens.push(step.tokenSymbol);
    }

    const protocolKey = step.protocol.toLowerCase();
    if (!seenProtocols.has(protocolKey)) {
      seenProtocols.add(protocolKey);
      protocols.push(step.protocol);
    }
  }

  return { tokens, protocols };
}

export async function estimateRequiredRouteOutput(
  fromAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  slippage?: string,
): Promise<bigint> {
  return BigInt(await estimateRouteOutput(fromAddress, tokenIn, tokenOut, amountIn, slippage));
}
