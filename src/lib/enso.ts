// Enso API Service
// Docs: https://docs.enso.build
// Using official Enso SDK: https://github.com/EnsoBuild/sdk-ts

import { redactRpcUrl } from "@/lib/rpc-redact";
import { fetchPricesInBatches } from "@/lib/enso-price-batches";
import { EnsoClient } from "@ensofinance/sdk";
import { encodeFunctionData, parseAbi } from "viem";
import type { Hex } from "viem";
import type { EnsoToken, EnsoTokensResponse, EnsoQuoteResponse, EnsoRouteResponse, EnsoBundleAction, EnsoBundleResponse, RouteInfo, RouteStep, CustomBundleResponse, LegacyMorphoPermitCall, LegacyMorphoPermitRequest } from "@/types/enso";
import {
  ENSO_ROUTER_V1 as ENSO_ROUTER_V1_ADDRESS,
  ENSO_ROUTER_V2 as ENSO_ROUTER_V2_ADDRESS,
  ENSO_SHORTCUTS as ENSO_SHORTCUTS_ADDRESS,
} from "@/lib/enso-addresses";
import { LLAMA_AIRFORCE as STATIC_LLAMA_AIRFORCE, TOKENS, VAULTS, VAULT_ADDRESSES, CURVE_SAVINGS, isYldfiVault as checkIsYldfiVault } from "@/config/vaults";
import { RPC_TIMEOUT_MS, getAllRpcUrls } from "@/config/rpc";
import {
  fetchEnsoIntent,
  getYldVaultToVaultIntentName,
  isStandardYldVaultIntentVault,
  shouldUsePlainTokenSwapIntent,
} from "@/lib/enso-intents";
import { formatTokenAmount } from "@/lib/utils";
import {
  assertProtectedEnsoBundleActions,
  assertSafeSlippageBps,
} from "@/lib/enso-swap-protection";

// Import Curve helpers from dedicated module
import {
  getCurveGetDy,
  getCurveGetDyFactory,
  getEthToCvxEstimate,
  previewRedeem,
  calculateMinDy,
  validateSlippage,
  // CryptoSwap helpers + math
  cryptoswap,
  getCryptoSwapParams,
} from "@/lib/curve";
import type { TwocryptoParams } from "@yldfi/curve-amm-math";

const CHAIN_ID = 1; // Ethereum mainnet

// Initialize Enso SDK client
const ensoClient = new EnsoClient({
  apiKey: process.env.ENSO_API_KEY || "",
});

// Rate limit disabled - testing shows Enso API handles rapid requests fine
// Keep env var override in case we need to throttle in the future
const ENSO_RATE_LIMIT_MS = Number(process.env.ENSO_RATE_LIMIT_MS ?? "0");
const ENSO_MAX_RETRIES = Number(process.env.ENSO_MAX_RETRIES ?? "4");
let lastEnsoCallAt = 0;
let ensoQueue: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isEnsoRateLimit = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const err = error as { statusCode?: number; response?: { status?: number }; message?: string };
  if (err.statusCode === 429 || err.response?.status === 429) return true;
  if (typeof err.message === "string" && err.message.includes("429")) return true;
  return false;
};

const enqueueEnsoCall = async <T>(fn: () => Promise<T>): Promise<T> => {
  const run = async (): Promise<T> => {
    const now = Date.now();
    if (ENSO_RATE_LIMIT_MS > 0) {
      const waitMs = lastEnsoCallAt + ENSO_RATE_LIMIT_MS - now;
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
    lastEnsoCallAt = Date.now();

    for (let attempt = 0; attempt <= ENSO_MAX_RETRIES; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        if (!isEnsoRateLimit(error) || attempt === ENSO_MAX_RETRIES) {
          throw error;
        }
        const backoffBase = ENSO_RATE_LIMIT_MS > 0 ? ENSO_RATE_LIMIT_MS : 1000;
        const backoffMs = backoffBase * (attempt + 1);
        await sleep(backoffMs);
      }
    }
    throw new Error("Enso request failed after retries");
  };

  const resultPromise = ensoQueue.then(run, run);
  ensoQueue = resultPromise.then(() => undefined, () => undefined);
  return resultPromise;
};

// ETH placeholder address used by Enso
export const ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export const LEGACY_MORPHO_ADDRESS = "0x9994E35Db50125E0DF82e4c2dde62496CE330999";
export const MORPHO_TOKEN_ADDRESS = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";
export const MORPHO_WRAPPER_ADDRESS = "0x9D03bb2092270648d7480049d0E58d2FcF0E5123";
export const MORPHO_BUNDLER3_ADDRESS = "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245";
export const MORPHO_GENERAL_ADAPTER1_ADDRESS = "0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0";

const TOKEN_DISPLAY_OVERRIDES: Record<string, { name: string; symbol: string }> = {
  [LEGACY_MORPHO_ADDRESS.toLowerCase()]: {
    name: "Legacy Morpho Token",
    symbol: "Legacy MORPHO",
  },
  [MORPHO_TOKEN_ADDRESS.toLowerCase()]: {
    name: "Morpho",
    symbol: "MORPHO",
  },
};

export function getTokenDisplayOverride(address: string | undefined): { name: string; symbol: string } | undefined {
  return address ? TOKEN_DISPLAY_OVERRIDES[address.toLowerCase()] : undefined;
}

export function applyTokenDisplayOverride<T extends { address: string; name?: string; symbol?: string }>(token: T): T {
  const override = getTokenDisplayOverride(token.address);
  return override ? { ...token, ...override } : token;
}

export const isLegacyMorphoToken = (token: string) =>
  token.toLowerCase() === LEGACY_MORPHO_ADDRESS.toLowerCase();

const ZERO_BYTES32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

const MORPHO_BUNDLER_ABI = parseAbi([
  "function multicall((address to, bytes data, uint256 value, bool skipRevert, bytes32 callbackHash)[] bundle) payable",
]);
const LEGACY_MORPHO_PERMIT_ABI = parseAbi([
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);
const MORPHO_ADAPTER_ABI = parseAbi([
  "function erc20TransferFrom(address token, address receiver, uint256 amount)",
  "function morphoWrapperDepositFor(address receiver, uint256 amount)",
]);
const ENSO_ROUTER_V2_ABI = parseAbi([
  "function routeMulti((uint8 tokenType, bytes data)[] tokensIn, bytes data) payable returns (bytes)",
]);

type MorphoBundlerCall = {
  to: `0x${string}`;
  data: Hex;
  value: bigint;
  skipRevert: boolean;
  callbackHash: Hex;
};

function toLegacyMorphoPermitCall(call: MorphoBundlerCall): LegacyMorphoPermitCall {
  return {
    to: call.to,
    data: call.data,
    value: call.value.toString(),
    skipRevert: call.skipRevert,
    callbackHash: call.callbackHash,
  };
}

function fromLegacyMorphoPermitCall(call: LegacyMorphoPermitCall): MorphoBundlerCall {
  return {
    to: call.to as `0x${string}`,
    data: call.data as Hex,
    value: BigInt(call.value),
    skipRevert: call.skipRevert,
    callbackHash: call.callbackHash as Hex,
  };
}

function morphoBundlerCall(to: string, data: Hex): MorphoBundlerCall {
  return {
    to: to as `0x${string}`,
    data,
    value: 0n,
    skipRevert: false,
    callbackHash: ZERO_BYTES32,
  };
}

function createLegacyMorphoPermitRequest(params: {
  amount: string;
  receiver: string;
  innerEnsoData?: Hex;
}): LegacyMorphoPermitRequest {
  const amount = BigInt(params.amount);
  const calls: MorphoBundlerCall[] = [
    morphoBundlerCall(
      MORPHO_GENERAL_ADAPTER1_ADDRESS,
      encodeFunctionData({
        abi: MORPHO_ADAPTER_ABI,
        functionName: "erc20TransferFrom",
        args: [
          LEGACY_MORPHO_ADDRESS as `0x${string}`,
          MORPHO_GENERAL_ADAPTER1_ADDRESS as `0x${string}`,
          amount,
        ],
      }),
    ),
    morphoBundlerCall(
      MORPHO_GENERAL_ADAPTER1_ADDRESS,
      encodeFunctionData({
        abi: MORPHO_ADAPTER_ABI,
        functionName: "morphoWrapperDepositFor",
        args: [params.receiver as `0x${string}`, amount],
      }),
    ),
  ];

  if (params.innerEnsoData) {
    calls.push(
      morphoBundlerCall(
        ENSO_ROUTER_V2,
        encodeFunctionData({
          abi: ENSO_ROUTER_V2_ABI,
          functionName: "routeMulti",
          args: [[], params.innerEnsoData],
        }),
      ),
    );
  }

  return {
    token: LEGACY_MORPHO_ADDRESS,
    spender: MORPHO_GENERAL_ADAPTER1_ADDRESS,
    amount: params.amount,
    postPermitCalls: calls.map(toLegacyMorphoPermitCall),
  };
}

export function buildLegacyMorphoPermitTransaction(params: {
  permit: LegacyMorphoPermitRequest;
  owner: string;
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}): { to: string; data: string; value: string } {
  const permitCall = morphoBundlerCall(
    params.permit.token,
    encodeFunctionData({
      abi: LEGACY_MORPHO_PERMIT_ABI,
      functionName: "permit",
      args: [
        params.owner as `0x${string}`,
        params.permit.spender as `0x${string}`,
        BigInt(params.permit.amount),
        params.deadline,
        params.v,
        params.r,
        params.s,
      ],
    }),
  );

  const calls = [
    permitCall,
    ...params.permit.postPermitCalls.map(fromLegacyMorphoPermitCall),
  ];

  return {
    to: MORPHO_BUNDLER3_ADDRESS,
    data: encodeFunctionData({
      abi: MORPHO_BUNDLER_ABI,
      functionName: "multicall",
      args: [calls],
    }),
    value: "0",
  };
}

// cvxCRV token address - exported for backwards compatibility
export const CVXCRV_ADDRESS = TOKENS.CVXCRV;

// Enso router contract addresses.
// Router V1: legacy EnsoShortcutRouter.
export const ENSO_ROUTER_V1 = ENSO_ROUTER_V1_ADDRESS;
// Router V2: current EnsoRouter and the correct spender for user token approvals.
// Enso's /wallet/approve endpoint returns this address as the spender for router strategy.
// The Router pulls tokens via safeTransferFrom(msg.sender, shortcuts, amount) in tokensIn.
export const ENSO_ROUTER_V2 = ENSO_ROUTER_V2_ADDRESS;
// Backwards-compatible aliases. Prefer ENSO_ROUTER_V1 / ENSO_ROUTER_V2 in new code.
export const ENSO_ROUTER = ENSO_ROUTER_V1;
export const ENSO_ROUTER_EXECUTOR = ENSO_ROUTER_V2;
// EnsoShortcuts contract — shared singleton execution context.
// This is msg.sender when Enso calls external contracts via the "call" action.
// Used as a DESTINATION for tokens during bundle execution (e.g., mint/unwrap to here).
//
// !! SECURITY: NEVER ask users to approve ENSO_SHORTCUTS as a token spender !!
// ENSO_SHORTCUTS is a shared contract — anyone can submit weiroll commands through
// the Router that execute in ENSO_SHORTCUTS' context. If a user approves
// ENSO_SHORTCUTS, their tokens can be drained via crafted routeMulti commands.
// For user approvals, use ENSO_ROUTER_V2 (the Router) instead.
export const ENSO_SHORTCUTS = ENSO_SHORTCUTS_ADDRESS;
const HYBRID_EXTRA_BUFFER_BPS = Number(process.env.ENSO_HYBRID_EXTRA_BUFFER_BPS ?? "200");

// yld referral code for Enso attribution
export const ENSO_REFERRAL_CODE = "yldfi";

import { WETH_ADDRESS, USDC_ADDRESS, CRVUSD_ADDRESS, CURVE_CVX_ETH_POOL, YVUSDC1_ADDRESS } from "@/config/addresses";

/**
 * Check if a token address is native ETH (the 0xeee...eee sentinel).
 * When ETH is the output of an Enso bundle route action, the weiroll VM's
 * slippage check fails because ETH is sent to the user before the check
 * reads the balance at EnsoShortcuts (which is 0). The fix is to route to
 * WETH instead and append a `wrapped-native/redeem` action to unwrap.
 */
const isNativeETH = (token: string) =>
  token.toLowerCase() === ETH_ADDRESS.toLowerCase();

/**
 * If the last route action targets ETH, rewrite it to target WETH and
 * append a wrapped-native/redeem action to unwrap WETH → ETH.
 * This avoids the weiroll slippage check failure for native ETH output.
 */
/**
 * skipQuote bundles that end CVX → WETH → unwrap report no native-ETH output, so the intent guard
 * rejects them. Estimate the WETH leg the bundle actually executes for display / the minimum.
 */
async function ethOutputEstimate(params: {
  outputToken: string;
  amountsOut: Record<string, string> | undefined;
  fromAddress: string;
  cvxAmount: bigint;
  slippage?: string;
}): Promise<Record<string, string>> {
  if (!isNativeETH(params.outputToken) || params.amountsOut?.[ETH_ADDRESS.toLowerCase()]) return {};
  const quote = await fetchDynamicInputEstimate({
    fromAddress: params.fromAddress,
    tokenIn: TOKENS.CVX,
    tokenOut: WETH_ADDRESS,
    amountIn: params.cvxAmount.toString(),
    slippage: params.slippage ?? "100",
  });
  return { [ETH_ADDRESS.toLowerCase()]: String(quote.amountOut) };
}

function appendETHUnwrapIfNeeded(actions: EnsoBundleAction[], outputToken: string): EnsoBundleAction[] {
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
function appendTerminalSlippageGuard(
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

const CURVE_USDC_CRVUSD_POOL = "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E";
const CURVE_TRICRV_POOL = "0x4eBdF703948ddCEA3B11f675B4D1Fba9d2414A14";
const CURVE_ROUTER = "0x99a58482BD75cbab83b27EC03CA68fF489b5788f";
// Only aggregators verified inside Enso's native bundle `route` action with a
// dynamic useOutputOfCallAt amount belong here. Standalone route calldata is
// always quote-amount-specific and must never be replayed with routeMulti for a
// runtime-produced balance, even when its provider is listed here.
const DYNAMIC_INPUT_SAFE_ENSO_AGGREGATORS = new Set(["grapher", "openocean"]);

interface DynamicInputAggregatorPolicy {
  availableSafeAggregators: string[];
  ignoreAggregators: string[];
}

async function getDynamicInputAggregatorPolicy(): Promise<DynamicInputAggregatorPolicy> {
  const aggregators = await enqueueEnsoCall(() => ensoClient.getAggregators(CHAIN_ID));
  if (aggregators.length === 0) {
    throw new Error("Enso returned no aggregator policy for a dynamic-input route");
  }

  return {
    availableSafeAggregators: aggregators.filter((aggregator) =>
      DYNAMIC_INPUT_SAFE_ENSO_AGGREGATORS.has(aggregator.toLowerCase())
    ),
    ignoreAggregators: aggregators.filter(
      (aggregator) => !DYNAMIC_INPUT_SAFE_ENSO_AGGREGATORS.has(aggregator.toLowerCase())
    ),
  };
}

// Custom tokens not in Uniswap list (Convex ecosystem + yld vaults)
export const CUSTOM_TOKENS: EnsoToken[] = [
  {
    address: ETH_ADDRESS,
    chainId: 1,
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
    logoURI: "/tokens/eth.png",
    type: "base",
  },
  {
    address: WETH_ADDRESS,
    chainId: 1,
    name: "Wrapped Ether",
    symbol: "WETH",
    decimals: 18,
    logoURI: "/tokens/weth.png",
    type: "base",
  },
  {
    address: CVXCRV_ADDRESS,
    chainId: 1,
    name: "Convex CRV",
    symbol: "cvxCRV",
    decimals: 18,
    logoURI: "/tokens/cvxcrv.png",
    type: "base",
  },
  {
    address: CRVUSD_ADDRESS,
    chainId: 1,
    name: "crvUSD",
    symbol: "crvUSD",
    decimals: 18,
    logoURI: "/tokens/crvusd.png",
    type: "base",
  },
  // Curve Savings vault (scrvUSD) - deeply integrated partner token
  {
    address: CURVE_SAVINGS.SCRVUSD,
    chainId: 1,
    name: "Savings crvUSD",
    symbol: "scrvUSD",
    decimals: 18,
    logoURI: "/tokens/scrvusd.png",
    type: "defi",
  },
  // Llama Airforce (Union) vault tokens - external vaults users can zap FROM
  {
    address: "0x8659Fc767cad6005de79AF65dAfE4249C57927AF",
    chainId: 1,
    name: "Union Pirex",
    symbol: "uCVX",
    decimals: 18,
    logoURI: "/tokens/llama-airforce.png",
    type: "defi",
  },
  {
    address: "0xde2bEF0A01845257b4aEf2A2EAa48f6EAeAfa8B7",
    chainId: 1,
    name: "Unionized Convex CRV",
    symbol: "uCRV",
    decimals: 18,
    logoURI: "/tokens/llama-airforce.png",
    type: "defi",
  },
  // Concentrator (Aladdin) vault tokens - external vaults users can zap FROM
  {
    address: "0xb0903Ab70a7467eE5756074b31ac88aEBb8fB777",
    chainId: 1,
    name: "Aladdin CVX",
    symbol: "aCVX",
    decimals: 18,
    logoURI: "/tokens/aladdin-cvx.png",
    type: "defi",
  },
  {
    address: "0x2b95A1Dcc3D405535f9ed33c219ab38E8d7e0884",
    chainId: 1,
    name: "Aladdin cvxCRV",
    symbol: "aCRV",
    decimals: 18,
    logoURI: "/tokens/aladdin-crv.png",
    type: "defi",
  },
  // Beefy Finance vault tokens - external vaults users can zap FROM
  {
    address: "0x4115150523599D1F6C6Fa27F5A4C27D578Fd8ce5",
    chainId: 1,
    name: "Moo Convex CRV",
    symbol: "mooCvxCRV",
    decimals: 18,
    logoURI: "/tokens/beefy.png",
    type: "defi",
  },
  {
    address: "0xf12DD69a5ab0cfbf41758052D871B881DC0fC8e0",
    chainId: 1,
    name: "Moo Convex CVX",
    symbol: "mooCvxCVX",
    decimals: 18,
    logoURI: "/tokens/beefy.png",
    type: "defi",
  },
  // Asymmetry Finance vault token - ERC4626 vault for CVX (3% withdrawal fee)
  {
    address: "0x8668a15b7b023Dc77B372a740FCb8939E15257Cf",
    chainId: 1,
    name: "Asymmetry Finance afCVX",
    symbol: "afCVX",
    decimals: 18,
    logoURI: "/tokens/afcvx.png",
    type: "defi",
  },
  // Pirex tokens - pxCVX and lpxCVX (lpxCVX wraps pxCVX for Curve liquidity)
  {
    address: "0xBCe0Cf87F513102F22232436CCa2ca49e815C3aC",
    chainId: 1,
    name: "Pirex CVX",
    symbol: "pxCVX",
    decimals: 18,
    logoURI: "/tokens/pxcvx.png",
    type: "defi",
  },
  {
    address: "0x389fB29230D02e67eB963C1F5A00f2b16f95BEb7",
    chainId: 1,
    name: "Liquid Pirex CVX",
    symbol: "lpxCVX",
    decimals: 18,
    logoURI: "/tokens/pxcvx.png",
    type: "defi",
  },
  // Yearn V3 vault tokens
  {
    address: YVUSDC1_ADDRESS,
    chainId: 1,
    name: "USDC-1 yVault",
    symbol: "yvUSDC-1",
    decimals: 6,
    logoURI: "/tokens/yearn-v3.svg",
    type: "defi",
  },
  // yld vault tokens - from centralized config
  ...Object.values(VAULTS).map((vault) => ({
    address: vault.address,
    chainId: 1,
    name: `yld ${vault.name}`,
    symbol: vault.symbol,
    decimals: vault.decimals,
    logoURI: vault.logo,
    type: "defi" as const,
  })),
];

export function getCustomTokenMetadata(address: string | undefined): EnsoToken | undefined {
  if (!address) return undefined;
  const lower = address.toLowerCase();
  return CUSTOM_TOKENS.find((token) => token.address.toLowerCase() === lower);
}

export function applyKnownTokenMetadata<T extends EnsoToken>(token: T): T {
  const customToken = getCustomTokenMetadata(token.address);
  const normalized = customToken ? { ...token, ...customToken } : token;
  return applyTokenDisplayOverride(normalized) as T;
}

// Popular token addresses for sorting priority
export const POPULAR_TOKENS = [
  ETH_ADDRESS, // ETH
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
  "0x6B175474E89094C44da98B954EeDcDecB5BE4dBf", // DAI
  WETH_ADDRESS, // WETH
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
  "0xD533a949740bb3306d119CC777fa900bA034cd52", // CRV
  "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B", // CVX
  CVXCRV_ADDRESS, // cvxCRV
  CRVUSD_ADDRESS, // crvUSD
  // Llama Airforce (Union) vault tokens
  "0x8659Fc767cad6005de79AF65dAfE4249C57927AF", // uCVX
  "0xde2bEF0A01845257b4aEf2A2EAa48f6EAeAfa8B7", // uCRV
  // Concentrator (Aladdin) vault tokens
  "0xb0903Ab70a7467eE5756074b31ac88aEBb8fB777", // aCVX
  "0x2b95A1Dcc3D405535f9ed33c219ab38E8d7e0884", // aCRV
  // Beefy Finance vault tokens
  "0x4115150523599D1F6C6Fa27F5A4C27D578Fd8ce5", // mooCvxCRV
  "0xf12DD69a5ab0cfbf41758052D871B881DC0fC8e0", // mooCvxCVX
  // Asymmetry Finance vault token
  "0x8668a15b7b023Dc77B372a740FCb8939E15257Cf", // afCVX
  // Pirex tokens
  "0xBCe0Cf87F513102F22232436CCa2ca49e815C3aC", // pxCVX
  "0x389fB29230D02e67eB963C1F5A00f2b16f95BEb7", // lpxCVX
  ...Object.values(VAULT_ADDRESSES), // yld vaults
];

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
function applySlippageBuffer(estimatedAmount: bigint, slippageBps: number): string {
  // Apply same formula as calculateMinDy: amount * (10000 - slippage) / 10000
  const conservativeAmount = (estimatedAmount * BigInt(10000 - slippageBps)) / BigInt(10000);
  return conservativeAmount.toString();
}

function getBufferedSlippageBps(slippageBps: number): number {
  return Math.min(10000, slippageBps + HYBRID_EXTRA_BUFFER_BPS);
}

type BundleAmountRef = string | { useOutputOfCallAt: number };

function isDynamicAmountRef(amount: BundleAmountRef): amount is { useOutputOfCallAt: number } {
  return typeof amount === "object" && amount !== null && "useOutputOfCallAt" in amount;
}

function erc20ApproveAction(token: string, spender: string, amount: BundleAmountRef): EnsoBundleAction {
  return {
    protocol: "erc20",
    action: "approve",
    args: { token, spender, amount },
  };
}

function rawApproveCallAction(token: string, spender: string, amount: BundleAmountRef): EnsoBundleAction {
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
function rawCallConsumingInput(
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

function intermediateApproveAction(
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
async function runtimeSplitOutput(p: {
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

function remainingCvxForMint(actions: EnsoBundleAction[]): BundleAmountRef {
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

function pushCvxToPxCvxSwapActions(
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

interface ConversionState {
  token: string;
  amountRef: BundleAmountRef;
  expectedAmount: bigint;
}

interface ConversionContext {
  fromAddress: string;
  slippage?: string;
  slippageBps: number;
  totalSlippageBps: number;
}

type RouteTraceStep = Omit<RouteStep, "amount" | "tokenSymbol"> & {
  tokenAddress: string;
  tokenSymbol?: string;
  amount?: bigint | string;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const isPxCvxAddress = (token: string) => token.toLowerCase() === TOKENS.PXCVX.toLowerCase();
const isLpxCvxAddress = (token: string) => token.toLowerCase() === TOKENS.LPXCVX.toLowerCase();

const COMMON_TOKEN_DECIMALS: Record<string, number> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 6, // USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7": 6, // USDT
  "0x6b175474e89094c44da98b954eedcdecb5be4dbf": 18, // DAI
  [WETH_ADDRESS.toLowerCase()]: 18,
  "0xd533a949740bb3306d119cc777fa900ba034cd52": 18, // CRV
};

function getTokenDecimals(address: string): number {
  const lower = address.toLowerCase();

  const customToken = CUSTOM_TOKENS.find((token) => token.address.toLowerCase() === lower);
  if (customToken) return customToken.decimals;

  const vault = Object.values(VAULTS).find((item) => item.address.toLowerCase() === lower);
  if (vault) return vault.decimals;

  if (COMMON_TOKEN_DECIMALS[lower] !== undefined) return COMMON_TOKEN_DECIMALS[lower];

  return 18;
}

function formatRouteAmount(amount: bigint | string, tokenAddress: string): string {
  const rawAmount = typeof amount === "bigint" ? amount : BigInt(amount);
  return formatTokenAmount(rawAmount, getTokenDecimals(tokenAddress), 4);
}

function formatRouteDeltaAmount(
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

function createRouteStep(step: RouteTraceStep): RouteStep {
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

function buildRouteMetadataFromSteps(steps: RouteStep[]): Pick<RouteInfo, "tokens" | "protocols"> {
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

async function estimateRequiredRouteOutput(
  fromAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  slippage?: string,
): Promise<bigint> {
  return BigInt(await estimateRouteOutput(fromAddress, tokenIn, tokenOut, amountIn, slippage));
}

function toBalanceState(
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

async function appendCvxToPxCvxConversion(
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

async function appendBestExactUsdcToCvxConversion(
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

async function convertStateToToken(
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

async function buildInitialConversionState(params: {
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

async function estimateExternalVaultShares(params: {
  vaultAddress: string;
  vaultInterface: "erc4626" | "ucrv" | "beefy";
  underlyingAmount: bigint;
}): Promise<string> {
  if (params.underlyingAmount === 0n) return "0";

  try {
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
      return params.underlyingAmount.toString();
    }

    if (params.vaultInterface === "beefy") {
      const res = await rpcWithFallback<{ result?: string }>({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: params.vaultAddress, data: "0x77c7b8fc" }, "latest"],
      });
      const pps = BigInt(res.result || "0");
      if (pps > 0n) {
        return ((params.underlyingAmount * (10n ** 18n)) / pps).toString();
      }
      return params.underlyingAmount.toString();
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
    const totalUnderlying = BigInt(totalUnderlyingRes.result || "0");
    const totalSupply = BigInt(totalSupplyRes.result || "0");
    if (totalUnderlying > 0n && totalSupply > 0n) {
      return ((params.underlyingAmount * totalSupply) / totalUnderlying).toString();
    }
  } catch {
    // fall through to raw amount
  }

  return params.underlyingAmount.toString();
}

// Additional token symbols for route display
const TOKEN_SYMBOLS: Record<string, string> = {
  [ETH_ADDRESS.toLowerCase()]: "ETH",
  [LEGACY_MORPHO_ADDRESS.toLowerCase()]: "Legacy MORPHO",
  [MORPHO_TOKEN_ADDRESS.toLowerCase()]: "MORPHO",
  [TOKENS.CVX.toLowerCase()]: "CVX",
  [TOKENS.CVXCRV.toLowerCase()]: "cvxCRV",
  [TOKENS.PXCVX.toLowerCase()]: "pxCVX",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
  "0x6b175474e89094c44da98b954eedcdecb5be4dbf": "DAI",
  [WETH_ADDRESS.toLowerCase()]: "WETH",
  "0xd533a949740bb3306d119cc777fa900ba034cd52": "CRV",
  // Llama Airforce (Union) vault tokens
  "0x8659fc767cad6005de79af65dafe4249c57927af": "uCVX",
  "0xde2bef0a01845257b4aef2a2eaa48f6eaeafa8b7": "uCRV",
  // Concentrator (Aladdin) vault tokens
  "0xb0903ab70a7467ee5756074b31ac88aebb8fb777": "aCVX",
  "0x2b95a1dcc3d405535f9ed33c219ab38e8d7e0884": "aCRV",
  // Beefy Finance vault tokens
  "0x4115150523599d1f6c6fa27f5a4c27d578fd8ce5": "mooCvxCRV",
  "0xf12dd69a5ab0cfbf41758052d871b881dc0fc8e0": "mooCvxCVX",
  // Asymmetry Finance vault token
  "0x8668a15b7b023dc77b372a740fcb8939e15257cf": "afCVX",
  // Pirex tokens
  "0x389fb29230d02e67eb963c1f5a00f2b16f95beb7": "lpxCVX",
};

/**
 * Get token symbol by address
 * Looks up in CUSTOM_TOKENS, TOKEN_SYMBOLS, and VAULTS
 */
export function getTokenSymbol(address: string): string {
  const lower = address.toLowerCase();

  // Check custom tokens first
  const customToken = CUSTOM_TOKENS.find(t => t.address.toLowerCase() === lower);
  if (customToken) return customToken.symbol;

  // Check additional symbols
  if (TOKEN_SYMBOLS[lower]) return TOKEN_SYMBOLS[lower];

  // Check vaults
  const vault = Object.values(VAULTS).find(v => v.address.toLowerCase() === lower);
  if (vault) return vault.symbol;

  // Fallback to shortened address
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Fetch token list from Enso API with metadata.
 * Client-side: proxied through /api/enso/tokens.
 * Server-side: calls SDK directly.
 */
export async function fetchEnsoTokenList(): Promise<EnsoToken[]> {
  if (typeof window !== "undefined") {
    const res = await fetch("/api/enso/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "base", includeMetadata: true }),
    });
    if (!res.ok) throw new Error(`Enso tokens proxy error: ${res.status}`);
    const tokenData = await res.json() as { data: Array<{ address: string; chainId: number; name?: string; symbol?: string; decimals: number; logosUri?: string[]; type?: EnsoToken["type"] }> };
    return tokenData.data
      .filter((t) => t.address && t.symbol)
      .map((t) => applyTokenDisplayOverride({
        address: t.address,
        chainId: t.chainId,
        name: t.name || t.symbol || "Unknown",
        symbol: t.symbol || "???",
        decimals: t.decimals,
        logoURI: t.logosUri?.[0],
        type: t.type ?? ("base" as const),
      }));
  }

  const tokenData = await enqueueEnsoCall(() => ensoClient.getTokenData({
    chainId: CHAIN_ID,
    type: "base",
    includeMetadata: true,
  }));

  return tokenData.data
    .filter((t) => t.address && t.symbol)
    .map((t) => applyTokenDisplayOverride({
      address: t.address,
      chainId: t.chainId,
      name: t.name || t.symbol || "Unknown",
      symbol: t.symbol || "???",
      decimals: t.decimals,
      logoURI: t.logosUri?.[0],
      type: t.type,
    }));
}

/**
 * Fetch wallet balances from Enso API
 * Returns token balances with prices for a given wallet address
 */
export interface EnsoWalletBalance {
  token: string;
  amount: string;
  chainId: number;
  decimals: number;
  price: number;
  name?: string;
  symbol?: string;
  logoUri?: string;
}

export async function fetchWalletBalances(walletAddress: string): Promise<EnsoWalletBalance[]> {
  if (typeof window !== "undefined") {
    const res = await fetch("/api/enso/balances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eoaAddress: walletAddress }),
    });
    if (!res.ok) throw new Error(`Enso balances proxy error: ${res.status}`);
    const balances = await res.json() as Array<{ token: string; amount: unknown; decimals: number; price: unknown; name?: string; symbol?: string; logoUri?: string }>;
    return balances.map((b) => {
      const override = getTokenDisplayOverride(b.token);
      return {
        token: b.token,
        amount: String(b.amount),
        chainId: CHAIN_ID,
        decimals: b.decimals,
        price: Number(b.price),
        name: override?.name ?? b.name,
        symbol: override?.symbol ?? b.symbol,
        logoUri: b.logoUri,
      };
    });
  }

  const balances = await enqueueEnsoCall(() => ensoClient.getBalances({
    chainId: CHAIN_ID,
    eoaAddress: walletAddress as `0x${string}`,
    useEoa: true,
  }));

  return balances.map((b) => {
    const override = getTokenDisplayOverride(b.token);
    return {
      token: b.token,
      amount: String(b.amount),
      chainId: CHAIN_ID,
      decimals: b.decimals,
      price: Number(b.price),
      // viem returns nullable strings for these fields; normalize null → undefined
      // to match the EnsoWalletBalance shape.
      name: override?.name ?? b.name ?? undefined,
      symbol: override?.symbol ?? b.symbol ?? undefined,
      logoUri: b.logoUri ?? undefined,
    };
  });
}

/**
 * Fetch batch token prices from Enso API
 */
export interface EnsoTokenPrice {
  chainId: number;
  address: string;
  price: number;
  decimals: number;
  symbol?: string;
  name?: string;
}

const tokenPricesInFlight = new Map<string, Promise<EnsoTokenPrice[]>>();

function tokenPricesRequestKey(addresses: readonly string[]): string {
  return [...new Set(addresses.map((address) => address.toLowerCase()))].sort().join(",");
}

export async function fetchTokenPrices(addresses: string[]): Promise<EnsoTokenPrice[]> {
  if (addresses.length === 0) return [];

  const key = tokenPricesRequestKey(addresses);
  const existing = tokenPricesInFlight.get(key);
  if (existing) return existing;

  const pending = fetchTokenPricesUncached(addresses).finally(() => {
    tokenPricesInFlight.delete(key);
  });
  tokenPricesInFlight.set(key, pending);
  return pending;
}

async function fetchTokenPricesUncached(addresses: string[]): Promise<EnsoTokenPrice[]> {
  if (typeof window !== "undefined") {
    const res = await fetch("/api/enso/prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses }),
    });
    if (!res.ok) throw new Error(`Enso prices proxy error: ${res.status}`);
    const priceData = await res.json() as Array<{ chainId: number; address: string; price: unknown; decimals: number; symbol?: string }>;
    return priceData.map((p) => {
      const override = getTokenDisplayOverride(p.address);
      return {
        chainId: p.chainId,
        address: p.address,
        price: Number(p.price),
        decimals: p.decimals,
        symbol: override?.symbol ?? p.symbol,
        name: override?.name,
      };
    });
  }

  const priceData = await fetchPricesInBatches(addresses, (batch) => enqueueEnsoCall(() => ensoClient.getMultiplePriceData({
    chainId: CHAIN_ID,
    addresses: batch as `0x${string}`[],
  })));

  return priceData.map((p) => {
    const override = getTokenDisplayOverride(p.address);
    return {
      chainId: p.chainId,
      address: p.address,
      price: Number(p.price),
      decimals: p.decimals,
      symbol: override?.symbol ?? p.symbol,
      name: override?.name,
    };
  });
}

/**
 * Fetch token prices bypassing the rate-limited queue.
 * Use only in contexts where queue contention would cause timeouts (e.g., simulation API).
 */
export async function fetchTokenPricesDirect(addresses: string[]): Promise<EnsoTokenPrice[]> {
  if (addresses.length === 0) return [];
  const priceData = await fetchPricesInBatches(addresses, (batch) => ensoClient.getMultiplePriceData({
    chainId: CHAIN_ID,
    addresses: batch as `0x${string}`[],
  }));
  return priceData.map((p) => {
    const override = getTokenDisplayOverride(p.address);
    return {
      chainId: p.chainId,
      address: p.address,
      price: Number(p.price),
      decimals: p.decimals,
      symbol: override?.symbol ?? p.symbol,
      name: override?.name,
    };
  });
}

/**
 * Fetch available tokens from Enso API using SDK
 */
export async function fetchTokens(params?: {
  chainId?: number;
  type?: "base" | "defi";
  page?: number;
}): Promise<EnsoTokensResponse> {
  if (typeof window !== "undefined") {
    const res = await fetch("/api/enso/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: params?.chainId ?? CHAIN_ID,
        type: params?.type,
        page: params?.page,
      }),
    });
    if (!res.ok) throw new Error(`Enso tokens proxy error: ${res.status}`);
    const tokenData = await res.json() as { data: Array<{ address: string; chainId: number; name?: string; symbol?: string; decimals: number; logosUri?: string[]; type?: EnsoToken["type"] }>; meta: EnsoTokensResponse["meta"] };
    return {
      data: tokenData.data.map((t) => applyTokenDisplayOverride({
        address: t.address,
        chainId: t.chainId,
        name: t.name ?? "",
        symbol: t.symbol ?? "",
        decimals: t.decimals,
        logoURI: t.logosUri?.[0],
        type: t.type ?? ("base" as const),
      })),
      meta: tokenData.meta,
    };
  }

  const tokenData = await enqueueEnsoCall(() => ensoClient.getTokenData({
    chainId: params?.chainId ?? CHAIN_ID,
    type: params?.type,
    page: params?.page,
  }));

  return {
    data: tokenData.data.map((t) => applyTokenDisplayOverride({
      address: t.address,
      chainId: t.chainId,
      name: t.name ?? "",
      symbol: t.symbol ?? "",
      decimals: t.decimals,
      logoURI: t.logosUri?.[0],
      type: t.type,
    })),
    meta: {
      total: tokenData.meta.total,
      lastPage: tokenData.meta.lastPage,
      currentPage: tokenData.meta.currentPage,
      perPage: tokenData.meta.perPage,
    },
  };
}

/**
 * Fetch optimal route/quote from Enso API.
 * Client-side: proxied through /api/enso/route (API key stays server-side).
 * Server-side: calls SDK directly.
 */
export interface EnsoRouteRequest {
  fromAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage?: string; // basis points, e.g., "100" = 1%
  receiver?: string;
  ignoreAggregators?: string[];
}

export async function fetchRoute(params: EnsoRouteRequest): Promise<EnsoRouteResponse> {
  const slippage = params.slippage ?? "100";
  assertSafeSlippageBps(slippage);

  console.log("[Enso Route] Request:", {
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
    slippage,
  });

  // Client-side: proxy low-risk user-owned swaps through the named intent route.
  if (typeof window !== "undefined" && shouldUsePlainTokenSwapIntent(params)) {
    const result = await fetchEnsoIntent<EnsoRouteResponse>({
      intent: "plainTokenSwap",
      fromAddress: params.fromAddress,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      slippage,
      receiver: params.receiver ?? params.fromAddress,
    });
    console.log("[Enso Route] Response (via intent):", {
      amountOut: result.amountOut,
      gas: result.gas,
      priceImpact: result.priceImpact,
    });
    return result;
  }

  // Client-side fallback for internal route builders that intentionally use an
  // app receiver such as an Enso shortcut context.
  if (typeof window !== "undefined") {
    const res = await fetch("/api/enso/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromAddress: params.fromAddress,
        tokenIn: [params.tokenIn],
        tokenOut: [params.tokenOut],
        amountIn: [params.amountIn],
        slippage,
        receiver: params.receiver,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error || `Enso route proxy error: ${res.status}`);
    }
    const result = await res.json() as EnsoRouteResponse;
    console.log("[Enso Route] Response (via proxy):", {
      amountOut: result.amountOut,
      gas: result.gas,
      priceImpact: result.priceImpact,
    });
    return result;
  }

  // Server-side: use SDK directly
  const routeData = await enqueueEnsoCall(() => ensoClient.getRouteData({
    chainId: CHAIN_ID,
    fromAddress: params.fromAddress as `0x${string}`,
    tokenIn: [params.tokenIn as `0x${string}`],
    tokenOut: [params.tokenOut as `0x${string}`],
    amountIn: [params.amountIn],
    slippage,
    routingStrategy: "router",
    referralCode: ENSO_REFERRAL_CODE,
    receiver: params.receiver as `0x${string}` | undefined,
    ignoreAggregators: params.ignoreAggregators,
  }));

  console.log("[Enso Route] Response:", {
    amountOut: String(routeData.amountOut),
    gas: String(routeData.gas),
    priceImpact: routeData.priceImpact,
    route: routeData.route.map((hop) => `${hop.action} via ${hop.protocol}`),
  });

  return {
    tx: {
      to: routeData.tx.to,
      data: routeData.tx.data,
      value: String(routeData.tx.value),
    },
    gas: String(routeData.gas),
    amountOut: String(routeData.amountOut),
    minAmountOut: routeData.minAmountOut == null
      ? undefined
      : String(Array.isArray(routeData.minAmountOut) ? routeData.minAmountOut[0] : routeData.minAmountOut),
    priceImpact: routeData.priceImpact != null ? Number(routeData.priceImpact) : null,
    route: routeData.route.map((hop) => ({
      action: hop.action,
      protocol: hop.protocol,
      tokenIn: hop.tokenIn as string[],
      tokenOut: hop.tokenOut as string[],
      amountIn: [],
      amountOut: [],
    })),
  };
}

export interface EnsoQuoteRequest {
  fromAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  ignoreAggregators?: string[];
}

/**
 * Output estimate from Enso's quoter (/shortcuts/quote). Use this wherever only the amount
 * (and route hops) are needed: it builds no calldata, costs about half a /route call in Enso
 * credits (~16 vs ~29-42 measured on 2026-10-13) and has its own rate limit. Falls back to
 * /route if the quoter fails, so an outage there degrades cost, not quotes.
 * Client-side: proxied through /api/enso/quote. Server-side: calls the SDK directly.
 */
export async function fetchQuote(params: EnsoQuoteRequest): Promise<EnsoQuoteResponse> {
  try {
    if (typeof window !== "undefined") {
      const res = await fetch("/api/enso/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAddress: params.fromAddress,
          tokenIn: [params.tokenIn],
          tokenOut: [params.tokenOut],
          amountIn: [params.amountIn],
          ignoreAggregators: params.ignoreAggregators,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
        throw new Error(err.error || `Enso quote proxy error: ${res.status}`);
      }
      return await res.json() as EnsoQuoteResponse;
    }

    const quoteData = await enqueueEnsoCall(() => ensoClient.getQuoteData({
      chainId: CHAIN_ID,
      fromAddress: params.fromAddress as `0x${string}`,
      routingStrategy: "router",
      tokenIn: [params.tokenIn as `0x${string}`],
      tokenOut: [params.tokenOut as `0x${string}`],
      amountIn: [params.amountIn],
      ignoreAggregators: params.ignoreAggregators,
    }));
    if (quoteData?.amountOut == null) throw new Error("Enso quote returned no amountOut");
    return {
      amountOut: String(quoteData.amountOut),
      priceImpact: quoteData.priceImpact != null ? Number(quoteData.priceImpact) : null,
      route: (quoteData.route ?? []).map((hop) => ({
        action: hop.action,
        protocol: hop.protocol,
        tokenIn: hop.tokenIn as string[],
        tokenOut: hop.tokenOut as string[],
      })),
    };
  } catch (error) {
    console.warn("[Enso Quote] quoter failed, falling back to /route:", error instanceof Error ? error.message : error);
    const route = await fetchRoute(params);
    return { amountOut: route.amountOut, priceImpact: route.priceImpact, route: route.route };
  }
}

/**
 * Estimate the output of a runtime-produced balance. This standalone quote is
 * deliberately unrestricted because its amount-specific calldata is never
 * executed. The executable native bundle route receives the dynamic-safe
 * aggregator policy in fetchBundle.
 */
export async function fetchDynamicInputEstimate(
  params: Omit<EnsoRouteRequest, "ignoreAggregators">,
): Promise<EnsoQuoteResponse> {
  return fetchQuote({
    fromAddress: params.fromAddress,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
  });
}

/**
 * Estimate output from an Enso route (for min_dy calculations)
 * Uses the route API to get accurate output estimate
 * @param fromAddress - Wallet address
 * @param tokenIn - Input token address
 * @param tokenOut - Output token address
 * @param amountIn - Input amount (wei string)
 * @param slippage - Slippage in basis points (optional)
 * @returns Expected output amount as string
 * @throws Error if estimation fails (never returns fallback value)
 */
async function estimateRouteOutput(
  fromAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  // Kept for call-site compatibility: a quote's amountOut is the expected output, not
  // slippage-adjusted, so the quoter takes no slippage.
  _slippage?: string
): Promise<string> {
  // If tokens are same, return input
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    return amountIn;
  }

  const result = await fetchQuote({
    fromAddress,
    tokenIn,
    tokenOut,
    amountIn,
  });

  if (!result.amountOut) {
    throw new Error(`Failed to estimate route output for ${tokenIn} → ${tokenOut}`);
  }

  return result.amountOut;
}

const getRpcUrls = (): string[] => {
  if (typeof process !== "undefined" && process.env?.DEBUG_RPC_URL) {
    return [process.env.DEBUG_RPC_URL, ...getAllRpcUrls()];
  }
  return getAllRpcUrls();
};

const getRpcAuth = (): string | undefined => {
  if (typeof process !== "undefined" && process.env?.DEBUG_RPC_AUTH) {
    return process.env.DEBUG_RPC_AUTH;
  }
  return undefined;
};

/**
 * Make a JSON-RPC request with RPC URL fallback. Tries each available
 * RPC URL until one returns a successful response.
 * Works for both single calls and batch calls.
 */
async function rpcWithFallback<T = unknown>(body: unknown): Promise<T> {
  const rpcUrls = getRpcUrls();
  const rpcAuth = getRpcAuth();
  let lastError: Error | undefined;

  for (const rpcUrl of rpcUrls) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          ...(rpcAuth ? { Authorization: rpcAuth.startsWith("Basic ") ? rpcAuth : `Basic ${rpcAuth}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response || !response.ok) {
        lastError = new Error(`RPC ${redactRpcUrl(rpcUrl)} returned ${response?.status}`);
        continue;
      }
      return (await response.json()) as T;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }
  }
  throw lastError ?? new Error("All RPC URLs failed");
}

/**
 * Sort tokens with popular tokens first
 */
export function sortTokensByPopularity(tokens: EnsoToken[]): EnsoToken[] {
  return [...tokens].sort((a, b) => {
    const aIndex = POPULAR_TOKENS.findIndex(
      (addr) => addr.toLowerCase() === a.address.toLowerCase()
    );
    const bIndex = POPULAR_TOKENS.findIndex(
      (addr) => addr.toLowerCase() === b.address.toLowerCase()
    );

    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    return 0;
  });
}

/**
 * Filter tokens by search query
 */
export function filterTokens(tokens: EnsoToken[], query: string): EnsoToken[] {
  if (!query) return tokens;

  const lowerQuery = query.toLowerCase();
  return tokens.filter(
    (token) =>
      token.symbol.toLowerCase().includes(lowerQuery) ||
      token.name.toLowerCase().includes(lowerQuery) ||
      token.address.toLowerCase() === lowerQuery
  );
}

// yld vault addresses (for vault-to-vault routing)
// Re-export with backwards-compatible naming (ycvxCRV vs YCVXCRV)
export const YLDFI_VAULT_ADDRESSES = {
  ycvxCRV: VAULT_ADDRESSES.YCVXCRV,
  yscvxCRV: VAULT_ADDRESSES.YSCVXCRV,
} as const;

/**
 * Check if an address is a yld vault
 * Uses centralized config from src/config/vaults.ts
 */
export const isYldfiVault = checkIsYldfiVault;

/**
 * Bundle multiple DeFi actions into a single transaction.
 * Server-side only: public clients must use named /api/enso/intent recipes.
 *
 * @param routingStrategy - "router" for standard routing via Enso executor,
 *                          "delegate" for delegateCalls from user's context
 *                          (required for custom call actions without return values)
 */
export async function fetchBundle(params: {
  fromAddress: string;
  actions: EnsoBundleAction[];
  receiver?: string;
  routingStrategy?: "router" | "delegate";
  skipQuote?: boolean;
}): Promise<EnsoBundleResponse> {
  const isDev = process.env.NODE_ENV === "development";

  // Log actions being sent (dev only)
  if (isDev) {
    console.log("[Enso Bundle] Actions:", JSON.stringify(params.actions, null, 2));
  }

  if (typeof window !== "undefined") {
    throw new Error(
      "Raw Enso bundle actions cannot be submitted from the browser; use a server-owned Enso intent"
    );
  }

  assertProtectedEnsoBundleActions(params.actions);

  const dynamicRouteActions = params.actions.filter((action) =>
    action.protocol === "enso" &&
    action.action === "route" &&
    typeof action.args.amountIn === "object" &&
    action.args.amountIn !== null &&
    "useOutputOfCallAt" in action.args.amountIn &&
    !Array.isArray(action.args.ignoreAggregators)
  );
  let actions = params.actions;
  if (dynamicRouteActions.length > 0) {
    const { ignoreAggregators } = await getDynamicInputAggregatorPolicy();
    actions = params.actions.map((action) => {
      const hasDynamicInput =
        action.protocol === "enso" &&
        action.action === "route" &&
        typeof action.args.amountIn === "object" &&
        action.args.amountIn !== null &&
        "useOutputOfCallAt" in action.args.amountIn;
      if (!hasDynamicInput || Array.isArray(action.args.ignoreAggregators)) {
        return action;
      }
      return {
        ...action,
        args: {
          ...action.args,
          ignoreAggregators,
        },
      };
    });
  }

  // Server-side: use SDK directly
  let bundleData: Awaited<ReturnType<typeof ensoClient.getBundleData>>;
  try {
    bundleData = await enqueueEnsoCall(() => ensoClient.getBundleData(
      {
        chainId: CHAIN_ID,
        fromAddress: params.fromAddress as `0x${string}`,
        routingStrategy: params.routingStrategy ?? "router",
        referralCode: ENSO_REFERRAL_CODE,
        receiver: params.receiver as `0x${string}` | undefined,
        skipQuote: params.skipQuote ?? isDev,
      },
      actions as unknown as Parameters<typeof ensoClient.getBundleData>[1]
    ));
  } catch (error: unknown) {
    if (isDev) {
      const errData = (error as { response?: { data?: unknown } })?.response?.data;
      console.error("[Enso Bundle] Error:", errData ?? error);
    }
    throw error;
  }

  if (isDev) {
    console.log("[Enso Bundle] Response:", {
      to: bundleData.tx.to,
      from: bundleData.tx.from,
      value: String(bundleData.tx.value),
      dataLength: bundleData.tx.data.length,
      gas: bundleData.gas,
      amountsOut: bundleData.amountsOut,
      amountsIn: (bundleData as Record<string, unknown>).amountsIn ?? "(not returned)",
      route: bundleData.route,
    });
  }

  return {
    tx: {
      to: bundleData.tx.to,
      data: bundleData.tx.data,
      value: String(bundleData.tx.value),
      from: bundleData.tx.from ?? params.fromAddress,
    },
    gas: String(bundleData.gas ?? "0"),
    amountsOut: bundleData.amountsOut
      ? Object.fromEntries(
          Object.entries(bundleData.amountsOut).map(([k, v]) => [k, String(v)])
        )
      : {},
    minAmountsOut: bundleData.minAmountsOut
      ? Object.fromEntries(
          Object.entries(bundleData.minAmountsOut).map(([k, v]) => [k, String(v)])
        )
      : undefined,
    route: bundleData.route,
    priceImpact: bundleData.priceImpact,
  };
}

/**
 * Legacy MORPHO is not transferable through normal swap routes. Wrap it 1:1
 * into the current MORPHO token, then execute a pre-built Enso route with
 * routeMulti so the wrapped tokens already held by ENSO_SHORTCUTS are consumed
 * atomically. This avoids requiring any new yld contracts.
 */
export async function fetchLegacyMorphoWrapRoute(params: {
  fromAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<EnsoBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<EnsoBundleResponse>({
      intent: "legacyMorphoWrap",
      fromAddress: params.fromAddress,
      outputToken: params.outputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const outputToken = params.outputToken;
  const outputLower = outputToken.toLowerCase();
  const wrapOnly = outputLower === MORPHO_TOKEN_ADDRESS.toLowerCase();
  const wrapReceiver = wrapOnly ? params.fromAddress : ENSO_SHORTCUTS;
  const amountIn = params.amountIn;
  let expectedOut = amountIn;
  let routePriceImpact: number | null | undefined = null;
  let gasFallback = 150000n;
  let innerEnsoData: Hex | undefined;
  const steps: RouteStep[] = [
    createRouteStep({
      tokenAddress: LEGACY_MORPHO_ADDRESS,
      amount: amountIn,
      action: "Wrap",
      description: "Legacy MORPHO to MORPHO (1:1)",
      protocol: "Morpho",
    }),
  ];

  if (!wrapOnly) {
    const { extractInnerSwapData } = await import("@/lib/enso-route-decode");
    const standaloneRoute = await fetchRoute({
      fromAddress: params.fromAddress,
      tokenIn: MORPHO_TOKEN_ADDRESS,
      tokenOut: outputToken,
      amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
    innerEnsoData = extractInnerSwapData(standaloneRoute.tx.data) as Hex;
    expectedOut = standaloneRoute.amountOut;
    routePriceImpact = standaloneRoute.priceImpact;
    gasFallback = BigInt(standaloneRoute.gas || "0") + 160000n;

    steps.push(createRouteStep({
      tokenAddress: MORPHO_TOKEN_ADDRESS,
      amount: amountIn,
      action: "Swap",
      description: `MORPHO for ${getTokenSymbol(outputToken)}`,
      protocol: "Enso",
      slippage: routePriceImpact != null ? routePriceImpact / 100 : undefined,
    }));
  }

  steps.push(createRouteStep({
    tokenAddress: outputToken,
    amount: expectedOut,
    action: "Receive",
    description: "tokens",
    protocol: wrapOnly ? "Morpho" : "Enso",
  }));

  return {
    tx: {
      to: MORPHO_BUNDLER3_ADDRESS,
      data: "0x",
      value: "0",
      from: params.fromAddress,
    },
    gas: gasFallback.toString(),
    amountsOut: {
      [outputLower]: expectedOut,
      ...(isNativeETH(outputToken) ? { [ETH_ADDRESS.toLowerCase()]: expectedOut } : {}),
    },
    priceImpact: routePriceImpact ?? null,
    routeInfo: { steps },
    legacyMorphoPermit: createLegacyMorphoPermitRequest({
      amount: amountIn,
      receiver: wrapReceiver,
      innerEnsoData,
    }),
  };
}

/**
 * Legacy MORPHO → yld vault zap-in.
 *
 * The legacy token cannot be routed directly by Enso. We wrap it into current
 * MORPHO inside ENSO_SHORTCUTS, execute a pre-built MORPHO → vault-underlying
 * route with routeMulti so the wrapped MORPHO is consumed atomically, then
 * deposit the received underlying into the target ERC4626 vault.
 */
export async function fetchLegacyMorphoZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  amountIn: string;
  slippage?: string;
  underlyingToken?: string;
}): Promise<EnsoBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<EnsoBundleResponse>({
      intent: "legacyMorphoZapIn",
      fromAddress: params.fromAddress,
      vaultAddress: params.vaultAddress,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const underlying = params.underlyingToken || CVXCRV_ADDRESS;
  const amountIn = params.amountIn;
  const vaultConfig = Object.values(VAULTS).find(
    (vault) => vault.address.toLowerCase() === params.vaultAddress.toLowerCase(),
  );
  const vaultSymbol = vaultConfig?.symbol ?? getTokenSymbol(params.vaultAddress);
  const underlyingSymbol = getTokenSymbol(underlying);

  const { extractInnerSwapData } = await import("@/lib/enso-route-decode");
  const standaloneRoute = await fetchRoute({
    fromAddress: params.fromAddress,
    tokenIn: MORPHO_TOKEN_ADDRESS,
    tokenOut: underlying,
    amountIn,
    slippage: params.slippage ?? "100",
    receiver: ENSO_SHORTCUTS,
  });
  const expectedUnderlying = BigInt(standaloneRoute.amountOut);
  const innerZapBundle = await fetchZapInRoute({
    fromAddress: params.fromAddress,
    vaultAddress: params.vaultAddress,
    inputToken: MORPHO_TOKEN_ADDRESS,
    amountIn,
    slippage: params.slippage ?? "100",
    underlyingToken: underlying,
  });
  const innerZapData = extractInnerSwapData(innerZapBundle.tx.data) as Hex;

  let expectedShares = expectedUnderlying.toString();
  try {
    expectedShares = await estimateExternalVaultShares({
      vaultAddress: params.vaultAddress,
      vaultInterface: "erc4626",
      underlyingAmount: expectedUnderlying,
    });
  } catch {
    // Fall back to underlying amount so the UI still has a conservative value.
  }

  const innerGas = innerZapBundle.gas && innerZapBundle.gas !== "0" ? innerZapBundle.gas : standaloneRoute.gas;
  const gasFallback = BigInt(innerGas || "0") + 160000n;
  const steps: RouteStep[] = [
    createRouteStep({
      tokenAddress: LEGACY_MORPHO_ADDRESS,
      amount: amountIn,
      action: "Wrap",
      description: "Legacy MORPHO to MORPHO (1:1)",
      protocol: "Morpho",
    }),
    createRouteStep({
      tokenAddress: MORPHO_TOKEN_ADDRESS,
      amount: amountIn,
      action: "Swap",
      description: `MORPHO for ${underlyingSymbol}`,
      protocol: "Enso",
      slippage: standaloneRoute.priceImpact != null ? standaloneRoute.priceImpact / 100 : undefined,
    }),
    createRouteStep({
      tokenAddress: underlying,
      tokenSymbol: underlyingSymbol,
      amount: expectedUnderlying,
      action: "Deposit",
      description: `into ${vaultSymbol}`,
      protocol: "yld",
    }),
    createRouteStep({
      tokenAddress: params.vaultAddress,
      tokenSymbol: vaultSymbol,
      amount: expectedShares,
      action: "Receive",
      description: `${vaultSymbol} shares`,
      protocol: "yld",
    }),
  ];

  return {
    tx: {
      to: MORPHO_BUNDLER3_ADDRESS,
      data: "0x",
      value: "0",
      from: params.fromAddress,
    },
    gas: gasFallback.toString(),
    amountsOut: {
      ...innerZapBundle.amountsOut,
      [underlying.toLowerCase()]: expectedUnderlying.toString(),
      [params.vaultAddress.toLowerCase()]: expectedShares,
    },
    priceImpact: standaloneRoute.priceImpact ?? innerZapBundle.priceImpact ?? null,
    routeInfo: {
      steps,
      ...buildRouteMetadataFromSteps(steps),
    },
    legacyMorphoPermit: createLegacyMorphoPermitRequest({
      amount: amountIn,
      receiver: ENSO_SHORTCUTS,
      innerEnsoData: innerZapData,
    }),
  };
}

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
 * Custom bundle for zapping TO a pxCVX vault from another vault
 * Route: source vault → source underlying → route to CVX → hybrid swap/mint → pxCVX → deposit
 *
 * Uses the hybrid pxCVX approach:
 * - If Curve pool rate > 1:1: swap CVX → pxCVX through lpxCVX.swap()
 * - If rate < 1:1: deposit CVX to Pirex for 1:1 pxCVX
 * - Optimal: split between swap and mint at peg point
 */
async function _fetchVaultToPxCvxVaultRoute(params: {
  fromAddress: string;
  sourceVault: string;
  targetVault: string;
  amountIn: string;
  sourceUnderlyingToken: string;
  slippage: string;
}): Promise<EnsoBundleResponse> {
  const { PIREX } = await import("@/config/vaults");

  // Validate slippage parameter
  const slippageBps = validateSlippage(params.slippage);

  // Step 1: Check if source underlying is already CVX
  const sourceIsCvx = params.sourceUnderlyingToken.toLowerCase() === TOKENS.CVX.toLowerCase();

  // Step 2: Estimate underlying amount from vault redeem using previewRedeem
  const estimatedUnderlyingAmount = await previewRedeem(params.sourceVault, params.amountIn);

  // Step 3: Estimate how much CVX we'll have after routing
  let estimatedCvxAmount: string;

  if (sourceIsCvx) {
    estimatedCvxAmount = estimatedUnderlyingAmount;
  } else {
    // Estimate CVX from route (throws on failure)
    estimatedCvxAmount = await estimateRouteOutput(
      params.fromAddress,
      params.sourceUnderlyingToken,
      TOKENS.CVX,
      estimatedUnderlyingAmount,
      params.slippage
    );
  }

  // Step 3: Apply slippage buffer to CVX amount before splitting
  // This ensures we don't try to use more CVX than we actually received after slippage
  const conservativeCvxAmount = applySlippageBuffer(BigInt(estimatedCvxAmount), slippageBps);

  // Step 4: Calculate optimal swap vs mint split for pxCVX using conservative amount
  const { swapAmount, mintAmount } = await getOptimalPxCvxSwapAmount(conservativeCvxAmount);

  // Step 5: Calculate expected pxCVX output and min_dy for slippage protection
  // For hybrid path: use swapAmount
  // For swap-only path: use full estimatedCvxAmount
  let swapMinDy = "0";
  let fullSwapMinDy = "0"; // For swap-only path

  if (swapAmount > 0n) {
    // Apply slippage buffer using user's slippage setting for consistency
    const conservativeSwapAmount = BigInt(applySlippageBuffer(swapAmount, slippageBps));
    const swapOutput = await getPxCvxSwapRate(conservativeSwapAmount.toString());
    // CRITICAL: Throw if estimation fails or returns zero - never use min_dy=0
    if (!swapOutput || swapOutput === 0n) {
      throw new Error("Failed to estimate Curve CVX→lpxCVX swap output for slippage protection");
    }
    swapMinDy = calculateMinDy(swapOutput, slippageBps);
  }

  // For swap-only path, calculate min_dy for full CVX amount
  if (mintAmount === 0n && swapAmount > 0n) {
    // Use already-buffered conservative CVX amount (no need to apply 1% buffer again)
    const fullSwapOutput = await getPxCvxSwapRate(conservativeCvxAmount);
    // CRITICAL: Throw if estimation fails or returns zero
    if (!fullSwapOutput || fullSwapOutput === 0n) {
      throw new Error("Failed to estimate Curve CVX→lpxCVX swap output for slippage protection");
    }
    fullSwapMinDy = calculateMinDy(fullSwapOutput, slippageBps);
  }

  // Build actions
  const actions: EnsoBundleAction[] = [];
  let actionIndex = 0;

  // Action 0: Redeem from source vault to get source underlying
  actions.push({
    protocol: "erc4626",
    action: "redeem",
    args: {
      tokenIn: params.sourceVault,
      tokenOut: params.sourceUnderlyingToken,
      amountIn: params.amountIn,
      primaryAddress: params.sourceVault,
    },
  });
  const redeemIdx = actionIndex++;

  if (!sourceIsCvx) {
    // Action: Route source underlying → CVX
    // Use dynamic output chaining so Enso doesn't expect user to pre-fund intermediate tokens
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.sourceUnderlyingToken,
        tokenOut: TOKENS.CVX,
        amountIn: { useOutputOfCallAt: redeemIdx },
        slippage: params.slippage,
      },
    });
    actionIndex++;
  }

  // Now we have CVX - apply hybrid pxCVX logic
  // Reference the CVX source (either redeem or route output)
  const cvxSourceIdx = sourceIsCvx ? redeemIdx : actionIndex - 1;
  const usesFixedDynamicSplit = swapAmount > 0n && mintAmount > 0n;

  if (swapAmount > 0n && mintAmount > 0n) {
    // Hybrid: swap portion via Curve, mint portion via Pirex
    // NOTE: We use literal amounts for the hybrid split, not useOutputOfCallAt
    // because we need to split the CVX between two paths

    pushCvxToPxCvxSwapActions(
      actions,
      PIREX,
      swapAmount.toString(),
      swapMinDy,
      usesFixedDynamicSplit,
    );
    actionIndex += 2;

    actions.push(intermediateApproveAction(
      TOKENS.CVX,
      PIREX.PIREX_CVX,
      mintAmount.toString(),
      usesFixedDynamicSplit,
    ));
    actionIndex++;

    // Deposit CVX to Pirex → pxCVX
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.PIREX_CVX,
        method: "deposit",
        abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
        args: [mintAmount.toString(), ENSO_SHORTCUTS, false, "0x0000000000000000000000000000000000000000"],
      },
    });
    actionIndex++;

  } else if (swapAmount > 0n) {
    // Swap-only path (all CVX goes through Curve swap)
    pushCvxToPxCvxSwapActions(
      actions,
      PIREX,
      { useOutputOfCallAt: cvxSourceIdx },
      fullSwapMinDy,
      false,
    );
    actionIndex += 2;

  } else {
    // Mint-only path
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.PIREX_CVX,
        amount: { useOutputOfCallAt: cvxSourceIdx },
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
        args: [{ useOutputOfCallAt: cvxSourceIdx }, ENSO_SHORTCUTS, false, "0x0000000000000000000000000000000000000000"],
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

  actions.push({
    protocol: "erc4626",
    action: "deposit",
    args: {
      tokenIn: PIREX.PXCVX,
      tokenOut: params.targetVault,
      amountIn: { useOutputOfCallAt: pxCvxBalanceIdx },
      primaryAddress: params.targetVault,
    },
  });

  // Use "router" strategy because the enso.route action inside bundles
  // doesn't work well with "delegate" when combined with other actions
  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
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

  // Apply slippage buffer using user's slippage setting for consistency
  const conservativePxCvxAmount = BigInt(applySlippageBuffer(BigInt(expectedPxCvxOutput), slippageBps));

  // Query Curve CryptoSwap pool get_dy to estimate CVX output from lpxCVX swap
  // Uses uint256 indices: lpxCVX (index 1) to CVX (index 0)
  // pxCVX wraps 1:1 to lpxCVX
  const expectedCvxOutput = await getLpxCvxToCvxSwapRate(conservativePxCvxAmount.toString());

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

// ============================================================================
// pxCVX Pool Helper Functions (CryptoSwap pool - uses uint256 indices)
// ============================================================================

/**
 * Get the Curve CryptoSwap pool swap rate for CVX → lpxCVX
 * Returns the amount of lpxCVX you'd get for a given amount of CVX
 *
 * Uses off-chain math with cached pool parameters for reliability.
 * Falls back to on-chain RPC call if off-chain calculation fails.
 */
export async function getPxCvxSwapRate(amountIn: string): Promise<bigint> {
  const { PIREX } = await import("@/config/vaults");

  try {
    // Use cached pool params + off-chain math (more reliable, no RPC rate limits)
    const params = await getCryptoSwapParams(PIREX.LPXCVX_CVX_POOL);
    return cryptoswap.getDy(params, 0, 1, BigInt(amountIn)); // CVX (0) → lpxCVX (1)
  } catch {
    // Fallback to on-chain RPC call
    const selector = "0x556d6e9f"; // get_dy(uint256,uint256,uint256)
    const i = "0".padStart(64, "0"); // CVX index
    const j = "1".padStart(64, "0"); // lpxCVX index
    const dx = BigInt(amountIn).toString(16).padStart(64, "0");

    const result = await rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: PIREX.LPXCVX_CVX_POOL, data: selector + i + j + dx }, "latest"],
    });
    return BigInt(result.result || "0");
  }
}

/**
 * Get expected CVX output for lpxCVX → CVX swap on Curve CryptoSwap pool
 * This is the reverse direction of getPxCvxSwapRate (for zap out)
 *
 * Uses off-chain math with cached pool parameters for reliability.
 * Falls back to on-chain RPC call if off-chain calculation fails.
 */
export async function getLpxCvxToCvxSwapRate(amountIn: string): Promise<bigint> {
  const { PIREX } = await import("@/config/vaults");

  try {
    // Use cached pool params + off-chain math (more reliable, no RPC rate limits)
    const params = await getCryptoSwapParams(PIREX.LPXCVX_CVX_POOL);
    return cryptoswap.getDy(params, 1, 0, BigInt(amountIn)); // lpxCVX (1) → CVX (0)
  } catch {
    // Fallback to on-chain RPC call
    const selector = "0x556d6e9f"; // get_dy(uint256,uint256,uint256)
    const i = "1".padStart(64, "0"); // lpxCVX index
    const j = "0".padStart(64, "0"); // CVX index
    const dx = BigInt(amountIn).toString(16).padStart(64, "0");

    const result = await rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: PIREX.LPXCVX_CVX_POOL, data: selector + i + j + dx }, "latest"],
    });
    return BigInt(result.result || "0");
  }
}

/**
 * Get Curve pool balances for lpxCVX/CVX
 * coin[0] = CVX, coin[1] = lpxCVX
 */
export async function getPxCvxPoolBalances(): Promise<{ cvxBalance: bigint; lpxCvxBalance: bigint }> {
  const { PIREX } = await import("@/config/vaults");

  // balances(uint256) selector: 0x4903b0d1
  const batch = [
    { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: PIREX.LPXCVX_CVX_POOL, data: "0x4903b0d10000000000000000000000000000000000000000000000000000000000000000" }, "latest"] },
    { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: PIREX.LPXCVX_CVX_POOL, data: "0x4903b0d10000000000000000000000000000000000000000000000000000000000000001" }, "latest"] },
  ];

  const results = await rpcWithFallback<Array<{ id: number; result?: string }>>(batch);
  results.sort((a, b) => a.id - b.id);

  return {
    cvxBalance: BigInt(results[0].result || "0"),
    lpxCvxBalance: BigInt(results[1].result || "0"),
  };
}

// ============================================================================
// CryptoSwap Off-Chain Math (for pxCVX pool)
// Uses @yldfi/curve-amm-math via @/lib/curve for calculations
// ============================================================================

// Use cryptoswap functions from npm package via curve lib
export function cryptoSwapGetDy(
  params: TwocryptoParams,
  i: number,
  j: number,
  dx: bigint
): bigint {
  return cryptoswap.getDy(params, i, j, dx);
}

/**
 * Find peg point using off-chain CryptoSwap math (binary search)
 * Returns the maximum amount where swap output >= input (rate >= 1:1)
 * Wrapper for backwards compatibility (i=0, j=1)
 */
export function findPegPointOffchainCryptoSwap(params: TwocryptoParams): bigint {
  return cryptoswap.findPegPoint(params, 0, 1);
}

/**
 * Calculate optimal swap amount for pxCVX hybrid swap/mint strategy
 * Uses off-chain CryptoSwap math for efficiency (1 batched RPC call + verification)
 *
 * If swap rate (CVX → lpxCVX) > 1:1, swap gives bonus pxCVX
 * If swap rate < 1:1, mint directly via Pirex at 1:1
 */
export async function getOptimalPxCvxSwapAmount(totalCvxAmount: string): Promise<{ swapAmount: bigint; mintAmount: bigint }> {
  const totalAmount = BigInt(totalCvxAmount);

  if (totalAmount === 0n) {
    return { swapAmount: 0n, mintAmount: 0n };
  }

  try {
    const { PIREX } = await import("@/config/vaults");

    // RPC call 1: Get all pool parameters in single batch (with caching)
    const params = await getCryptoSwapParams(PIREX.LPXCVX_CVX_POOL);

    // Check swap rate for total amount using off-chain math
    const dyForTotal = cryptoSwapGetDy(params, 0, 1, totalAmount);

    // If swapping everything gives >= 1:1, swap it all
    if (dyForTotal >= totalAmount) {
      return { swapAmount: totalAmount, mintAmount: 0n };
    }

    // Rate is < 1:1, find peg point using off-chain binary search
    let pegPoint = findPegPointOffchainCryptoSwap(params);

    if (pegPoint === 0n) {
      // No swap bonus available - mint everything
      return { swapAmount: 0n, mintAmount: totalAmount };
    }

    // RPC call 2: Verify peg point with on-chain get_dy
    try {
      const onChainDy = await getPxCvxSwapRate(pegPoint.toString());

      if (onChainDy < pegPoint) {
        // Off-chain was slightly optimistic, reduce by 1% for safety
        pegPoint = (pegPoint * 99n) / 100n;
      }
    } catch {
      // If verification fails, reduce by 2% as extra safety margin
      pegPoint = (pegPoint * 98n) / 100n;
    }

    // Cap at total amount
    const swapAmount = pegPoint > totalAmount ? totalAmount : pegPoint;

    return {
      swapAmount,
      mintAmount: totalAmount - swapAmount,
    };
  } catch (error) {
    console.error("Error calculating optimal pxCVX swap amount:", error);
    // On error, mint everything (safe fallback)
    return { swapAmount: 0n, mintAmount: totalAmount };
  }
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

  const totalUnderlying = BigInt(results[0].result || "0");
  const totalSupply = BigInt(results[1].result || "1"); // Avoid division by zero

  if (totalSupply === 0n) return "0";

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
    steps.push({ tokenSymbol: "cvxCRV", amount: conservativeCvxCrv, action: "Deposit", description: `cvxCRV into ${vaultSymbol}`, protocol: "yld" });
  } else {
    steps.push({ tokenSymbol: "cvxCRV", amount: conservativeCvxCrv, action: "Swap", description: `cvxCRV for ${targetUnderlyingSymbol}`, protocol: "Enso" });
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
  const conservativePxCvx = applySlippageBuffer(BigInt(expectedPxCvxOutput), slippageBps);

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
    const expectedCvxOutput = await getLpxCvxToCvxSwapRate(conservativePxCvx);
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
  const pricePerFullShare = BigInt(result.result || "1000000000000000000"); // Default 1:1

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
    steps.push({ tokenSymbol: beefyUnderlyingSymbol, amount: conservativeUnderlying, action: "Deposit", description: `${beefyUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
  } else {
    steps.push({ tokenSymbol: beefyUnderlyingSymbol, amount: conservativeUnderlying, action: "Swap", description: `${beefyUnderlyingSymbol} for ${targetUnderlyingSymbol}`, protocol: "Enso" });
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

// ============================================================================
// Pirex Token Zap Functions (pxCVX, lpxCVX)
// ============================================================================

// Pirex token addresses
const PIREX_PXCVX = "0xBCe0Cf87F513102F22232436CCa2ca49e815C3aC";
const PIREX_LPXCVX = "0x389fB29230D02e67eB963C1F5A00f2b16f95BEb7";

/**
 * Check if token is pxCVX
 */
export function isPxCvxToken(address: string): boolean {
  return address.toLowerCase() === PIREX_PXCVX.toLowerCase();
}

/**
 * Check if token is lpxCVX
 */
export function isLpxCvxToken(address: string): boolean {
  return address.toLowerCase() === PIREX_LPXCVX.toLowerCase();
}

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

  const { PIREX, getVaultByAddress } = await import("@/config/vaults");
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

  const { PIREX, getVaultByAddress } = await import("@/config/vaults");
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

  const { PIREX } = await import("@/config/vaults");
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

  const { PIREX } = await import("@/config/vaults");
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

  const { PIREX } = await import("@/config/vaults");
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
    appendETHUnwrapIfNeeded(actions, params.outputToken);
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
      ...(await ethOutputEstimate({ outputToken: params.outputToken, amountsOut: bundleResult.amountsOut, fromAddress: params.fromAddress, cvxAmount: expectedCvx, slippage: params.slippage })),
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

  const { PIREX } = await import("@/config/vaults");
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
    appendETHUnwrapIfNeeded(actions, params.outputToken);
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
      ...(await ethOutputEstimate({ outputToken: params.outputToken, amountsOut: bundleResult.amountsOut, fromAddress: params.fromAddress, cvxAmount: expectedCvx, slippage: params.slippage })),
    },
    routeInfo: {
      steps,
      tokens: outputIsCvx ? ["pxCVX", "lpxCVX", "CVX"] : ["pxCVX", "lpxCVX", "CVX", outputSymbol],
      protocols: outputIsCvx ? ["Pirex", "Curve"] : ["Pirex", "Curve", "Enso"],
    },
  };
}

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
  const conservativePxCvx = applySlippageBuffer(BigInt(expectedPxCvx), slippageBps);
  // Curve lpxCVX → CVX
  const expectedCvx = await getLpxCvxToCvxSwapRate(conservativePxCvx);
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
  if (outputIsCvx) {
    actions.push({
      protocol: "erc20",
      action: "transfer",
      args: { token: TOKENS.CVX, amount: { useOutputOfCallAt: 4 }, receiver: params.fromAddress },
    });
  } else {
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
    appendETHUnwrapIfNeeded(actions, params.outputToken);
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
      ...(await ethOutputEstimate({ outputToken: params.outputToken, amountsOut: bundleResult.amountsOut, fromAddress: params.fromAddress, cvxAmount: expectedCvx, slippage: params.slippage })),
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
    appendETHUnwrapIfNeeded(actions, params.outputToken);
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
  let cvxCrvAmount = params.amountIn;
  if (!inputIsCvxCrv) {
    try {
      const routeQuote = await fetchQuote({
        fromAddress: params.fromAddress,
        tokenIn: params.inputToken,
        tokenOut: LLAMA_AIRFORCE.UCRV_UNDERLYING,
        amountIn: params.amountIn,
      });
      cvxCrvAmount = routeQuote.amountOut;
    } catch {
      // leave as amountIn — shares estimate will be off but bundle executes OK
    }
  }

  let expectedShares = cvxCrvAmount;
  try {
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
    const totalUnderlying = BigInt(totalUnderlyingRes.result || "0");
    const totalSupply = BigInt(totalSupplyRes.result || "0");
    if (totalUnderlying > 0n && totalSupply > 0n) {
      expectedShares = ((BigInt(cvxCrvAmount) * totalSupply) / totalUnderlying).toString();
    }
  } catch {
    // fall back to cvxCrvAmount
  }
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
  let underlyingAmount = params.amountIn;
  if (!inputIsUnderlying) {
    try {
      const routeQuote = await fetchQuote({
        fromAddress: params.fromAddress,
        tokenIn: params.inputToken,
        tokenOut: params.beefyVaultUnderlying,
        amountIn: params.amountIn,
      });
      underlyingAmount = routeQuote.amountOut;
    } catch {
      // fall back to amountIn — shares estimate will be off but bundle still
      // executes correctly since deposit uses on-chain balance reference.
    }
  }

  let expectedShares = underlyingAmount;
  try {
    const ppsRes = await rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0",
      id: 0,
      method: "eth_call",
      params: [{ to: params.beefyVault, data: "0x77c7b8fc" }, "latest"], // getPricePerFullShare()
    });
    const pps = BigInt(ppsRes.result || "0");
    if (pps > 0n) {
      expectedShares = ((BigInt(underlyingAmount) * BigInt(10 ** 18)) / pps).toString();
    }
  } catch {
    // fall back to underlyingAmount
  }
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
