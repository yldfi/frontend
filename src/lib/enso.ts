// Enso API Service
// Docs: https://docs.enso.build
// Using official Enso SDK: https://github.com/EnsoBuild/sdk-ts

import { EnsoClient } from "@ensofinance/sdk";
import type { EnsoToken, EnsoTokensResponse, EnsoRouteResponse, EnsoBundleAction, EnsoBundleResponse, RouteInfo, RouteStep, CustomBundleResponse } from "@/types/enso";
import { TOKENS, VAULTS, VAULT_ADDRESSES, CURVE_SAVINGS, isYldfiVault as checkIsYldfiVault } from "@/config/vaults";
import { getAllRpcUrls } from "@/config/rpc";
import { formatTokenAmount } from "@/lib/utils";

// Import Curve helpers from dedicated module
import {
  getCurveGetDy,
  getCurveGetDyFactory,
  getEthToCvxEstimate,
  getStableSwapParams,
  estimateCryptoSwapOffchain,
  previewRedeem,
  // Optimized helpers (batch + off-chain math)
  batchRedeemAndEstimateSwap,
  // StableSwap math
  findPegPoint as findPegPointOffchain,
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

// cvxCRV token address - exported for backwards compatibility
export const CVXCRV_ADDRESS = TOKENS.CVXCRV;

// Enso router contract addresses
// Old EnsoShortcutRouter
export const ENSO_ROUTER = "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E";
// Enso Router Executor — the CORRECT spender for user token approvals.
// Enso's own /wallet/approve endpoint returns this address as the spender.
// The Router pulls tokens via safeTransferFrom(msg.sender, enso, amount) in tokensIn.
export const ENSO_ROUTER_EXECUTOR = "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf";
// EnsoShortcuts contract — shared singleton execution context.
// This is msg.sender when Enso calls external contracts via the "call" action.
// Used as a DESTINATION for tokens during bundle execution (e.g., mint/unwrap to here).
//
// !! SECURITY: NEVER ask users to approve ENSO_SHORTCUTS as a token spender !!
// ENSO_SHORTCUTS is a shared contract — anyone can submit weiroll commands through
// the Router that execute in ENSO_SHORTCUTS' context. If a user approves
// ENSO_SHORTCUTS, their tokens can be drained via crafted routeMulti commands.
// For user approvals, use ENSO_ROUTER_EXECUTOR (the Router) instead.
// For complex flows needing mid-bundle token pulls, use the LlamaLendZapper contract.
export const ENSO_SHORTCUTS = "0x4Fe93ebC4Ce6Ae4f81601cC7Ce7139023919E003";
const HYBRID_EXTRA_BUFFER_BPS = Number(process.env.ENSO_HYBRID_EXTRA_BUFFER_BPS ?? "200");

// yld referral code for Enso attribution
export const ENSO_REFERRAL_CODE = "yldfi";

import { WETH_ADDRESS, CRVUSD_ADDRESS, CURVE_CVX_ETH_POOL, YVUSDC1_ADDRESS } from "@/config/addresses";

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

const CRV_ADDRESS = "0xD533a949740bb3306d119CC777fa900bA034cd52";
const CURVE_TRICRV_POOL = "0x4eBdF703948ddCEA3B11f675B4D1Fba9d2414A14";
const CURVE_CRV_CVXCRV_POOL = "0x9D0464996170c6B9e75eED71c68B99dDEDf279e8";
const CURVE_ROUTER = "0x99a58482BD75cbab83b27EC03CA68fF489b5788f";

// Custom tokens not in Uniswap list (Convex ecosystem + yld vaults)
export const CUSTOM_TOKENS: EnsoToken[] = [
  {
    address: ETH_ADDRESS,
    chainId: 1,
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
    logoURI: "https://assets.coingecko.com/coins/images/279/thumb/ethereum.png",
    type: "base",
  },
  {
    address: WETH_ADDRESS,
    chainId: 1,
    name: "Wrapped Ether",
    symbol: "WETH",
    decimals: 18,
    logoURI: "https://assets.coingecko.com/coins/images/2518/thumb/weth.png",
    type: "base",
  },
  {
    address: CVXCRV_ADDRESS,
    chainId: 1,
    name: "Convex CRV",
    symbol: "cvxCRV",
    decimals: 18,
    logoURI: "https://assets.coingecko.com/coins/images/15586/thumb/convex-crv.png",
    type: "base",
  },
  {
    address: CRVUSD_ADDRESS,
    chainId: 1,
    name: "crvUSD",
    symbol: "crvUSD",
    decimals: 18,
    logoURI: "https://assets.coingecko.com/coins/images/30118/thumb/crvusd.jpeg",
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

/**
 * Build hybrid "CVX → cvgCVX → deposit into target vault" actions.
 * Enso's aggregator has no liquid CVX → cvgCVX route, so we replicate the
 * fetchCvgCvxZapInRoute hybrid split (Curve swap + Convex 1:1 mint) here,
 * using literal amounts so the bundle can be skip-quoted.
 *
 * Returns the full action list — caller just appends. A balance read + erc4626
 * deposit is included so the final step picks up whatever cvgCVX was produced
 * across both the swap and mint portions.
 */
async function buildCvxToCvgCvxDepositActions(params: {
  expectedCvxAmount: bigint;
  targetVault: string;
  slippageBps: number;
}): Promise<{ actions: EnsoBundleAction[]; expectedCvgCvx: bigint }> {
  const { TANGENT } = await import("@/config/vaults");
  const totalSlippageBps = getBufferedSlippageBps(params.slippageBps);
  const cvxForSplit = applySlippageBuffer(params.expectedCvxAmount, params.slippageBps);
  const { swapAmount, mintAmount } = await getOptimalSwapAmount(cvxForSplit);

  const actions: EnsoBundleAction[] = [];
  let expectedSwapCvgCvx = 0n;

  if (swapAmount > 0n) {
    const expectedSwapOut = await getCurveGetDy(
      TANGENT.CVX1_CVGCVX_POOL,
      0,
      1,
      swapAmount.toString(),
    );
    expectedSwapCvgCvx = expectedSwapOut ?? 0n;
    const minSwapDy = expectedSwapOut
      ? calculateMinDy(expectedSwapOut, totalSlippageBps)
      : "0";
    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: swapAmount.toString() },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "mint",
          abi: "function mint(address to, uint256 amount)",
          args: [ENSO_SHORTCUTS, swapAmount.toString()],
        },
      },
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX1,
          spender: TANGENT.CVX1_CVGCVX_POOL,
          amount: swapAmount.toString(),
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVX1_CVGCVX_POOL,
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          args: [0, 1, swapAmount.toString(), minSwapDy],
        },
      },
    );
  }

  if (mintAmount > 0n) {
    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX,
          spender: TANGENT.CVGCVX_CONTRACT,
          amount: mintAmount.toString(),
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVGCVX_CONTRACT,
          method: "mint",
          abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
          args: [ENSO_SHORTCUTS, mintAmount.toString(), true],
        },
      },
    );
  }

  // Balance + deposit — use relative index (caller appends to its own array,
  // so useOutputOfCallAt points to the balance action's absolute position)
  const balanceIndexWithin = actions.length;
  actions.push({
    protocol: "enso",
    action: "balance",
    args: { token: TOKENS.CVGCVX },
  });
  // IMPORTANT: caller must append these returned actions as the TAIL of its
  // bundle so the absolute index of the balance read equals startIdx +
  // balanceIndexWithin. We encode this as a sentinel relative ref that the
  // caller re-bases below.
  actions.push({
    protocol: "erc4626",
    action: "deposit",
    args: {
      tokenIn: TOKENS.CVGCVX,
      tokenOut: params.targetVault,
      amountIn: { useOutputOfCallAt: balanceIndexWithin }, // re-base in caller
      primaryAddress: params.targetVault,
    },
  });

  return { actions, expectedCvgCvx: expectedSwapCvgCvx + mintAmount };
}

/**
 * Re-base the useOutputOfCallAt ref inside cvgCVX-hybrid actions so their
 * balance-read reference matches the absolute position in the caller's bundle.
 */
function rebaseCvgCvxHybridRef(actions: EnsoBundleAction[], baseIdx: number): void {
  const depositAction = actions[actions.length - 1];
  const args = depositAction.args as { amountIn?: { useOutputOfCallAt: number } };
  if (args.amountIn && typeof args.amountIn === "object" && "useOutputOfCallAt" in args.amountIn) {
    args.amountIn = { useOutputOfCallAt: baseIdx + args.amountIn.useOutputOfCallAt };
  }
}

type BundleAmountRef = string | { useOutputOfCallAt: number };

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
const isCvgCvxAddress = (token: string) => token.toLowerCase() === TOKENS.CVGCVX.toLowerCase();

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

function createRouteStep(step: RouteTraceStep): RouteStep {
  return {
    tokenSymbol: step.tokenSymbol ?? getTokenSymbol(step.tokenAddress),
    tokenAddress: step.tokenAddress,
    amount: step.amount === undefined ? undefined : formatRouteAmount(step.amount, step.tokenAddress),
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

async function estimateRouteOutputOrFallback(
  fromAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  slippage?: string,
): Promise<bigint> {
  try {
    return BigInt(await estimateRouteOutput(fromAddress, tokenIn, tokenOut, amountIn, slippage));
  } catch {
    return BigInt(amountIn);
  }
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
  const { swapAmount, mintAmount } = await getOptimalPxCvxSwapAmount(conservativeCvxAmount);

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

  if (swapAmount > 0n) {
    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX,
          spender: PIREX.LPXCVX_CVX_POOL,
          amount: swapAmount.toString(),
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
            String(PIREX.POOL_INDEX.CVX),
            String(PIREX.POOL_INDEX.LPXCVX),
            swapAmount.toString(),
            swapMinDy,
          ],
        },
      },
    );
    const swapIdx = actions.length - 1;

    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: PIREX.LPXCVX,
          spender: PIREX.LPXCVX,
          amount: { useOutputOfCallAt: swapIdx },
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX,
          method: "unwrap",
          abi: "function unwrap(uint256 amount)",
          args: [{ useOutputOfCallAt: swapIdx }],
        },
      },
    );
  }

  if (mintAmount > 0n) {
    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX,
          spender: PIREX.PIREX_CVX,
          amount: mintAmount.toString(),
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.PIREX_CVX,
          method: "deposit",
          abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
          args: [
            mintAmount.toString(),
            ENSO_SHORTCUTS,
            "false",
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

  return toBalanceState(
    actions,
    PIREX.PXCVX,
    expectedSwapPxCvx + mintAmount,
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
  const { swapAmount, mintAmount } = await getOptimalPxCvxSwapAmount(conservativeCvxAmount);

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

  if (swapAmount > 0n) {
    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX,
          spender: PIREX.LPXCVX_CVX_POOL,
          amount: swapAmount.toString(),
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
            String(PIREX.POOL_INDEX.CVX),
            String(PIREX.POOL_INDEX.LPXCVX),
            swapAmount.toString(),
            swapMinDy,
          ],
        },
      },
    );
  }

  if (mintAmount > 0n) {
    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX,
          spender: PIREX.PIREX_CVX,
          amount: mintAmount.toString(),
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.PIREX_CVX,
          method: "deposit",
          abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
          args: [
            mintAmount.toString(),
            ENSO_SHORTCUTS,
            "false",
            ZERO_ADDRESS,
          ],
        },
      },
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: PIREX.PXCVX,
          spender: PIREX.LPXCVX,
          amount: mintAmount.toString(),
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX,
          method: "wrap",
          abi: "function wrap(uint256 amount)",
          args: [mintAmount.toString()],
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

  return toBalanceState(
    actions,
    PIREX.LPXCVX,
    expectedSwapLpxCvx + mintAmount,
  );
}

async function appendCvxToCvgCvxConversion(
  actions: EnsoBundleAction[],
  state: ConversionState,
  ctx: ConversionContext,
  routeSteps: RouteStep[],
): Promise<ConversionState> {
  const { TANGENT } = await import("@/config/vaults");
  const conservativeCvxAmount = applySlippageBuffer(state.expectedAmount, ctx.slippageBps);
  const { swapAmount, mintAmount } = await getOptimalSwapAmount(conservativeCvxAmount);

  let expectedSwapCvgCvx = 0n;
  let swapMinDy = "0";
  if (swapAmount > 0n) {
    const swapOutput = await getCvgCvxSwapRate(swapAmount.toString());
    if (!swapOutput || swapOutput === 0n) {
      throw new Error("Failed to estimate Curve CVX1→cvgCVX swap output");
    }
    expectedSwapCvgCvx = swapOutput;
    swapMinDy = calculateMinDy(swapOutput, ctx.totalSlippageBps);
  }

  if (swapAmount > 0n) {
    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX,
          spender: TOKENS.CVX1,
          amount: swapAmount.toString(),
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "mint",
          abi: "function mint(address to, uint256 amount)",
          args: [ENSO_SHORTCUTS, swapAmount.toString()],
        },
      },
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX1,
          spender: TANGENT.CVX1_CVGCVX_POOL,
          amount: swapAmount.toString(),
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVX1_CVGCVX_POOL,
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          args: [0, 1, swapAmount.toString(), swapMinDy],
        },
      },
    );
  }

  if (mintAmount > 0n) {
    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX,
          spender: TANGENT.CVGCVX_CONTRACT,
          amount: mintAmount.toString(),
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVGCVX_CONTRACT,
          method: "mint",
          abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
          args: [ENSO_SHORTCUTS, mintAmount.toString(), true],
        },
      },
    );
  }

  let swapBonus = 0;
  let bonusAmount: string | undefined;
  if (swapAmount > 0n && expectedSwapCvgCvx > swapAmount) {
    swapBonus = (Number(expectedSwapCvgCvx) / Number(swapAmount) - 1) * 100;
    bonusAmount = formatRouteAmount(expectedSwapCvgCvx - swapAmount, TOKENS.CVGCVX);
  }

  if (swapAmount > 0n && mintAmount > 0n) {
    routeSteps.push(
      createRouteStep({
        tokenAddress: TOKENS.CVX,
        amount: swapAmount,
        action: "Swap",
        description: "CVX for cvgCVX via CVX1/Curve",
        protocol: "Curve",
        bonus: swapBonus,
        bonusAmount,
        bonusSymbol: "cvgCVX",
      }),
      createRouteStep({
        tokenAddress: TOKENS.CVX,
        amount: mintAmount,
        action: "Mint",
        description: "cvgCVX with CVX (1:1)",
        protocol: "Convex",
      }),
    );
  } else if (swapAmount > 0n) {
    routeSteps.push(createRouteStep({
      tokenAddress: TOKENS.CVX,
      amount: state.expectedAmount,
      action: "Swap",
      description: "CVX for cvgCVX via CVX1/Curve",
      protocol: "Curve",
      bonus: swapBonus,
      bonusAmount,
      bonusSymbol: "cvgCVX",
    }));
  } else {
    routeSteps.push(createRouteStep({
      tokenAddress: TOKENS.CVX,
      amount: state.expectedAmount,
      action: "Mint",
      description: "cvgCVX with CVX (1:1)",
      protocol: "Convex",
    }));
  }

  return toBalanceState(
    actions,
    TOKENS.CVGCVX,
    expectedSwapCvgCvx + mintAmount,
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
    const conservativePxCvx = applySlippageBuffer(state.expectedAmount, ctx.slippageBps);
    const expectedCvx = await getLpxCvxToCvxSwapRate(conservativePxCvx);
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
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: PIREX.LPXCVX,
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
    const conservativeLpxCvx = applySlippageBuffer(state.expectedAmount, ctx.slippageBps);
    const expectedCvx = await getLpxCvxToCvxSwapRate(conservativeLpxCvx);
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

  if (isCvgCvxAddress(state.token)) {
    const { TANGENT } = await import("@/config/vaults");
    const conservativeCvgCvx = applySlippageBuffer(state.expectedAmount, ctx.slippageBps);
    const expectedCvx1 = await getCvgCvxReverseSwapRate(conservativeCvgCvx);
    if (!expectedCvx1 || expectedCvx1 === 0n) {
      throw new Error("Failed to estimate Curve cvgCVX→CVX1 swap output");
    }
    const minDy = calculateMinDy(expectedCvx1, ctx.totalSlippageBps);

    actions.push(
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVGCVX,
          spender: TANGENT.CVX1_CVGCVX_POOL,
          amount: state.amountRef,
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVX1_CVGCVX_POOL,
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          args: [1, 0, state.amountRef, minDy],
        },
      },
    );
    const exchangeIdx = actions.length - 1;

    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "withdraw",
        abi: "function withdraw(uint256 amount, address to)",
        args: [{ useOutputOfCallAt: exchangeIdx }, ENSO_SHORTCUTS],
      },
    });

    routeSteps.push(createRouteStep({
      tokenAddress: TOKENS.CVGCVX,
      amount: state.expectedAmount,
      action: "Swap",
      description: "cvgCVX for CVX via CVX1/Curve",
      protocol: "LiquidBoost",
    }));

    return {
      token: TOKENS.CVX,
      amountRef: { useOutputOfCallAt: exchangeIdx },
      expectedAmount: expectedCvx1,
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
      return {
        token: TOKENS.PXCVX,
        amountRef: state.amountRef,
        expectedAmount: state.expectedAmount,
      };
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

      return {
        token: TOKENS.LPXCVX,
        amountRef: state.amountRef,
        expectedAmount: state.expectedAmount,
      };
    }
    const cvxState =
      state.token.toLowerCase() === TOKENS.CVX.toLowerCase()
        ? state
        : await appendConversionToCvx(actions, state, ctx, routeSteps);
    return appendCvxToLpxCvxConversion(actions, cvxState, ctx, routeSteps);
  }

  if (isCvgCvxAddress(targetToken)) {
    const cvxState =
      state.token.toLowerCase() === TOKENS.CVX.toLowerCase()
        ? state
        : await appendConversionToCvx(actions, state, ctx, routeSteps);
    return appendCvxToCvgCvxConversion(actions, cvxState, ctx, routeSteps);
  }

  if (isPxCvxAddress(state.token) || isLpxCvxAddress(state.token) || isCvgCvxAddress(state.token)) {
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
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: config.address,
        method: "withdraw",
        abi: "function withdraw(address _to, uint256 _shares) returns (uint256)",
        args: [ENSO_SHORTCUTS, params.amountIn],
      },
    });

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
      {
        protocol: "enso",
        action: "call",
        args: {
          address: config.address,
          method: "withdraw",
          abi: "function withdraw(uint256 _shares)",
          args: [params.amountIn],
        },
      },
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
  [TOKENS.CVX.toLowerCase()]: "CVX",
  [TOKENS.CVXCRV.toLowerCase()]: "cvxCRV",
  [TOKENS.CVX1.toLowerCase()]: "CVX1",
  [TOKENS.CVGCVX.toLowerCase()]: "cvgCVX",
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
      .map((t) => ({
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
    .map((t) => ({
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
    return balances.map((b) => ({
      token: b.token,
      amount: String(b.amount),
      chainId: CHAIN_ID,
      decimals: b.decimals,
      price: Number(b.price),
      name: b.name,
      symbol: b.symbol,
      logoUri: b.logoUri,
    }));
  }

  const balances = await enqueueEnsoCall(() => ensoClient.getBalances({
    chainId: CHAIN_ID,
    eoaAddress: walletAddress as `0x${string}`,
    useEoa: true,
  }));

  return balances.map((b) => ({
    token: b.token,
    amount: String(b.amount),
    chainId: CHAIN_ID,
    decimals: b.decimals,
    price: Number(b.price),
    name: b.name,
    symbol: b.symbol,
    logoUri: b.logoUri,
  }));
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

export async function fetchTokenPrices(addresses: string[]): Promise<EnsoTokenPrice[]> {
  if (addresses.length === 0) return [];

  if (typeof window !== "undefined") {
    const res = await fetch("/api/enso/prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses }),
    });
    if (!res.ok) throw new Error(`Enso prices proxy error: ${res.status}`);
    const priceData = await res.json() as Array<{ chainId: number; address: string; price: unknown; decimals: number; symbol?: string }>;
    return priceData.map((p) => ({
      chainId: p.chainId,
      address: p.address,
      price: Number(p.price),
      decimals: p.decimals,
      symbol: p.symbol,
      name: undefined,
    }));
  }

  const priceData = await enqueueEnsoCall(() => ensoClient.getMultiplePriceData({
    chainId: CHAIN_ID,
    addresses: addresses as `0x${string}`[],
  }));

  return priceData.map((p) => ({
    chainId: p.chainId,
    address: p.address,
    price: Number(p.price),
    decimals: p.decimals,
    symbol: p.symbol,
    name: undefined,
  }));
}

/**
 * Fetch token prices bypassing the rate-limited queue.
 * Use only in contexts where queue contention would cause timeouts (e.g., simulation API).
 */
export async function fetchTokenPricesDirect(addresses: string[]): Promise<EnsoTokenPrice[]> {
  if (addresses.length === 0) return [];
  const priceData = await ensoClient.getMultiplePriceData({
    chainId: CHAIN_ID,
    addresses: addresses as `0x${string}`[],
  });
  return priceData.map((p) => ({
    chainId: p.chainId,
    address: p.address,
    price: Number(p.price),
    decimals: p.decimals,
    symbol: p.symbol,
    name: undefined,
  }));
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
      data: tokenData.data.map((t) => ({
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
    data: tokenData.data.map((t) => ({
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
export async function fetchRoute(params: {
  fromAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage?: string; // basis points, e.g., "100" = 1%
  receiver?: string;
}): Promise<EnsoRouteResponse> {
  console.log("[Enso Route] Request:", {
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
    slippage: params.slippage ?? "100",
  });

  // Client-side: proxy through our API route to keep API key server-side
  if (typeof window !== "undefined") {
    const res = await fetch("/api/enso/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromAddress: params.fromAddress,
        tokenIn: [params.tokenIn],
        tokenOut: [params.tokenOut],
        amountIn: [params.amountIn],
        slippage: params.slippage ?? "100",
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
    slippage: params.slippage ?? "100",
    routingStrategy: "router",
    referralCode: ENSO_REFERRAL_CODE,
    receiver: params.receiver as `0x${string}` | undefined,
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
    priceImpact: routeData.priceImpact != null ? Number(routeData.priceImpact) : undefined,
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
  slippage?: string
): Promise<string> {
  // If tokens are same, return input
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    return amountIn;
  }

  const result = await fetchRoute({
    fromAddress,
    tokenIn,
    tokenOut,
    amountIn,
    slippage,
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

const isDevEnv = (): boolean => process.env.NODE_ENV !== "production";

const getErc20TotalSupply = async (token: string): Promise<bigint> => {
  const selector = "0x18160ddd"; // totalSupply()
  const rpcAuth = getRpcAuth();
  const rpcUrls = getRpcUrls();

  for (const rpcUrl of rpcUrls) {
    try {
      const result = await fetch(rpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(rpcAuth ? { Authorization: rpcAuth.startsWith("Basic ") ? rpcAuth : `Basic ${rpcAuth}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: token, data: selector }, "latest"],
        }),
      });
      if (!result || !result.ok) continue;
      const response = await result.json() as { result?: string };
      if (!response.result || response.result === "0x") continue;
      return BigInt(response.result);
    } catch {
      continue;
    }
  }
  // All RPCs failed - return 0n to skip clamping
  return 0n;
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
        headers: {
          "Content-Type": "application/json",
          ...(rpcAuth ? { Authorization: rpcAuth.startsWith("Basic ") ? rpcAuth : `Basic ${rpcAuth}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response || !response.ok) {
        lastError = new Error(`RPC ${rpcUrl} returned ${response?.status}`);
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

/** Dev-only: clamp amountIn to token/vault totalSupply to prevent simulation errors */
const clampAmountIn = async (token: string, amountIn: string): Promise<string> => {
  if (!isDevEnv()) {
    return amountIn;
  }
  if (token.toLowerCase() === ETH_ADDRESS.toLowerCase()) {
    return amountIn;
  }
  const totalSupply = await getErc20TotalSupply(token);
  const requested = BigInt(amountIn);
  if (totalSupply === 0n) {
    return amountIn;
  }
  return requested > totalSupply ? totalSupply.toString() : amountIn;
};


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
 * Client-side: proxied through /api/enso/bundle (API key stays server-side).
 * Server-side: calls SDK directly.
 *
 * @param routingStrategy - "router" for standard routing via Enso executor,
 *                          "delegate" for delegateCalls from user's context
 *                          (required for custom call actions like CVX1.mint)
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

  // Client-side: proxy through our API route to keep API key server-side
  if (typeof window !== "undefined") {
    const res = await fetch("/api/enso/bundle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromAddress: params.fromAddress,
        actions: params.actions,
        receiver: params.receiver,
        routingStrategy: params.routingStrategy ?? "router",
        skipQuote: params.skipQuote ?? isDev,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      if (isDev) console.error("[Enso Bundle] Proxy error:", err);
      throw new Error(err.error || `Enso bundle proxy error: ${res.status}`);
    }
    const result = await res.json() as EnsoBundleResponse;
    if (isDev) {
      console.log("[Enso Bundle] Response (via proxy):", {
        to: result.tx.to,
        gas: result.gas,
      });
    }
    return result;
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
      params.actions as unknown as Parameters<typeof ensoClient.getBundleData>[1]
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
    route: bundleData.route,
    priceImpact: bundleData.priceImpact,
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
  const underlying = params.underlyingToken || CVXCRV_ADDRESS;
  const amountIn = await clampAmountIn(params.vaultAddress, params.amountIn);

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
    // Step 2: Swap underlying (cvxCRV) to output token
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: underlying,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: 0 }, // Use output from redeem
        slippage: params.slippage ?? "100",
      },
    },
  ];

  // For ETH output: route to WETH + unwrap (avoids weiroll slippage check failure)
  appendETHUnwrapIfNeeded(actions, params.outputToken);

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
  const underlying = params.underlyingToken || CVXCRV_ADDRESS;
  const amountIn = await clampAmountIn(params.inputToken, params.amountIn);

  const actions: EnsoBundleAction[] = [
    // Step 1: Swap input token to underlying (cvxCRV)
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.inputToken,
        tokenOut: underlying,
        amountIn,
        slippage: params.slippage ?? "100",
      },
    },
    // Step 2: Deposit underlying (cvxCRV) into vault
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: underlying,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 0 }, // Use output from swap
        primaryAddress: params.vaultAddress,
      },
    },
  ];

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
 * Special handling for cvgCVX which requires custom routing through Tangent
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

  // Look up underlying tokens from VAULTS config if not provided
  const sourceVaultConfig = Object.values(VAULTS).find(v => v.address.toLowerCase() === params.sourceVault.toLowerCase());
  const targetVaultConfig = Object.values(VAULTS).find(v => v.address.toLowerCase() === params.targetVault.toLowerCase());

  const sourceUnderlying = params.sourceUnderlyingToken ?? sourceVaultConfig?.assetAddress ?? TOKENS.CVXCRV;
  const targetUnderlying = params.targetUnderlyingToken ?? targetVaultConfig?.assetAddress ?? TOKENS.CVXCRV;
  const sourceVaultSymbol = sourceVaultConfig?.symbol ?? getTokenSymbol(params.sourceVault);
  const targetVaultSymbol = targetVaultConfig?.symbol ?? getTokenSymbol(params.targetVault);
  const sourceUnderlyingSymbol = getTokenSymbol(sourceUnderlying);
  const slippage = params.slippage ?? "100";
  const amountIn = await clampAmountIn(params.sourceVault, params.amountIn);

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

  // Check if cvgCVX is involved - requires custom routing via Tangent
  const targetIsCvgCvx = targetUnderlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
  const sourceIsCvgCvx = sourceUnderlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();

  // Check if pxCVX is involved - requires custom routing via Pirex
  const targetIsPxCvx = targetUnderlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();
  const sourceIsPxCvx = sourceUnderlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();

  // NOTE: Check pxCVX source BEFORE cvgCVX target because pxCVX needs special handling
  // that can't be done by fetchVaultToCvgCvxVaultRoute (Enso can't route pxCVX → CVX)
  if (sourceIsPxCvx) {
    // Zapping FROM pxCVX vault: redeem → swap via lpxCVX → route/wrap → deposit
    // This handles both standard targets AND cvgCVX targets (via CVX1 wrap + Curve)
    return fetchPxCvxVaultToVaultRoute({
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      targetVault: params.targetVault,
      amountIn,
      targetUnderlyingToken: targetUnderlying,
      slippage,
    });
  }

  if (targetIsCvgCvx) {
    // Zapping TO cvgCVX vault: redeem → route to CVX → wrap → swap → deposit
    return fetchVaultToCvgCvxVaultRoute({
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      targetVault: params.targetVault,
      amountIn,
      sourceUnderlyingToken: sourceUnderlying,
      slippage,
    });
  }

  if (sourceIsCvgCvx) {
    // Zapping FROM cvgCVX vault: redeem → swap → unwrap → route → deposit
    return fetchCvgCvxVaultToVaultRoute({
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      targetVault: params.targetVault,
      amountIn,
      targetUnderlyingToken: targetUnderlying,
      slippage,
    });
  }

  if (targetIsPxCvx) {
    // Zapping TO pxCVX vault: redeem source → route to CVX → hybrid swap/mint → deposit
    // Note: We use the SOURCE UNDERLYING token, not the vault token
    return fetchVaultToPxCvxVaultRoute({
      fromAddress: params.fromAddress,
      sourceVault: params.sourceVault,
      targetVault: params.targetVault,
      amountIn,
      sourceUnderlyingToken: sourceUnderlying,
      slippage,
    });
  }

  // Different underlyings (non-cvgCVX): redeem → swap → deposit
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

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    skipQuote: false, // Standard V2V doesn't depend on account state — need amountsOut
  });
}

/**
 * Custom bundle for zapping TO a cvgCVX vault from another vault
 * Route: source vault → source underlying → CVX → CVX1 → cvgCVX → target vault
 * Uses same pattern as fetchCvgCvxZapInRoute with delegate routing
 */
async function fetchVaultToCvgCvxVaultRoute(params: {
  fromAddress: string;
  sourceVault: string;
  targetVault: string;
  amountIn: string;
  sourceUnderlyingToken: string;
  slippage: string;
}): Promise<CustomBundleResponse> {
  const { TANGENT } = await import("@/config/vaults");

  // Validate slippage parameter
  const slippageBps = validateSlippage(params.slippage);

  // Get symbols for route info
  const sourceVaultSymbol = getTokenSymbol(params.sourceVault);
  const targetVaultSymbol = getTokenSymbol(params.targetVault);
  const sourceUnderlyingSymbol = getTokenSymbol(params.sourceUnderlyingToken);

  // Estimate underlying amount from vault redeem
  const estimatedUnderlying = await previewRedeem(params.sourceVault, params.amountIn);

  // Estimate CVX amount from route (throws on failure)
  const estimatedCvx = await estimateRouteOutput(
    params.fromAddress,
    params.sourceUnderlyingToken,
    TOKENS.CVX,
    estimatedUnderlying,
    params.slippage
  );

  // Apply slippage buffer to CVX estimate for fixed-amount actions
  // This ensures we don't try to spend more CVX than we received after slippage
  const conservativeCvx = BigInt(applySlippageBuffer(BigInt(estimatedCvx), slippageBps));

  // CVX wraps 1:1 to CVX1
  // Conservative estimate for min_dy (with slippage buffer)
  const conservativeCvgCvx = await getCurveGetDy(
    TANGENT.CVX1_CVGCVX_POOL,
    0, // CVX1 index
    1, // cvgCVX index
    conservativeCvx.toString()
  );

  // CRITICAL: Throw if estimation fails or returns zero - never use min_dy=0
  if (conservativeCvgCvx === null || conservativeCvgCvx === 0n) {
    throw new Error("Failed to estimate Curve CVX1→cvgCVX swap output for slippage protection");
  }

  // Un-buffered estimate for display (more accurate price impact)
  const displayCvgCvx = await getCurveGetDy(
    TANGENT.CVX1_CVGCVX_POOL,
    0, 1,
    estimatedCvx
  );
  const expectedCvgCvx = displayCvgCvx ?? conservativeCvgCvx;

  // Calculate swap bonus using un-buffered estimates for display accuracy
  const swapBonus = (Number(expectedCvgCvx) / Number(BigInt(estimatedCvx)) - 1) * 100;

  // Calculate bonus amount in tokens (cvgCVX received - CVX input)
  // Positive = extra tokens from swap, Negative = fewer tokens than 1:1 mint
  const bonusAmountWei = expectedCvgCvx - BigInt(estimatedCvx);
  const bonusAmountFormatted = (Number(bonusAmountWei) / 1e18).toFixed(4);

  // Calculate min_dy with slippage tolerance (use conservative estimate for safety)
  const minDyCvgCvx = calculateMinDy(conservativeCvgCvx, slippageBps);

  // Note: Using concrete estimates for amounts to help Enso simulate the bundle correctly
  const actions: EnsoBundleAction[] = [
    // Action 0: Redeem from source vault to get source underlying
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.sourceVault,
        tokenOut: params.sourceUnderlyingToken,
        amountIn: params.amountIn,
        primaryAddress: params.sourceVault,
      },
    },
    // Action 1: Route source underlying → CVX via Enso
    // Use dynamic output chaining so Enso doesn't expect user to pre-fund intermediate tokens
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.sourceUnderlyingToken,
        tokenOut: TOKENS.CVX,
        amountIn: { useOutputOfCallAt: 0 },
        slippage: params.slippage,
      },
    },
    // Action 2: Approve CVX → CVX1 wrapper
    // Use dynamic output from route action to approve exact amount received
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: { useOutputOfCallAt: 1 } },
    },
    // Action 3: Wrap CVX → CVX1 (mint to ENSO_SHORTCUTS, not ENSO_ROUTER_EXECUTOR)
    // CVX1 must go to ENSO_SHORTCUTS because Curve.exchange does transferFrom(msg.sender, ...)
    // and the Shortcuts contract is the one executing the Curve call
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "mint",
        abi: "function mint(address to, uint256 amount)",
        args: [ENSO_SHORTCUTS, { useOutputOfCallAt: 1 }],
      },
    },
    // Action 4: Approve CVX1 → Curve pool
    // CVX1 mint is 1:1, so amount equals route output
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX1, spender: TANGENT.CVX1_CVGCVX_POOL, amount: { useOutputOfCallAt: 1 } },
    },
    // Action 5: Swap CVX1 → cvgCVX via Curve pool
    // Use dynamic CVX1 amount (same as CVX from route, since mint is 1:1)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [0, 1, { useOutputOfCallAt: 1 }, minDyCvgCvx], // dx from route, min_dy with slippage
      },
    },
    // Action 6: Approve cvgCVX → vault
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVGCVX, spender: params.targetVault, amount: { useOutputOfCallAt: 5 } },
    },
    // Action 7: Deposit cvgCVX → target vault
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: TOKENS.CVGCVX,
        tokenOut: params.targetVault,
        amountIn: { useOutputOfCallAt: 5 },
        primaryAddress: params.targetVault,
      },
    },
  ];

  // Use skipQuote to bypass Enso's simulation which fails with complex output chaining.
  // The bundle uses useOutputOfCallAt across 8 actions, which Enso's simulator can't handle.
  const bundle = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: true,
  });

  // Manually calculate amountsOut since skipQuote returns null
  // Use previewDeposit to convert estimated cvgCVX → vault shares
  let expectedShares: string = expectedCvgCvx.toString();
  try {
    const previewDepositSelector = "0xef8b30f7"; // previewDeposit(uint256)
    const previewData = previewDepositSelector + expectedCvgCvx.toString(16).padStart(64, "0");
    const previewResult = await rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: params.targetVault, data: previewData }, "latest"],
    });
    if (previewResult.result && previewResult.result !== "0x") {
      expectedShares = BigInt(previewResult.result).toString();
    }
  } catch {
    // Fall back to cvgCVX amount if previewDeposit fails
  }

  bundle.amountsOut = {
    [params.targetVault.toLowerCase()]: expectedShares,
    [TOKENS.CVGCVX.toLowerCase()]: expectedCvgCvx.toString(),
  };

  // Format amounts for route display
  const formatWei = (wei: string | bigint) => (Number(wei) / 1e18).toFixed(4);

  // Build route info showing the actual path with per-step amounts
  const routeInfo: RouteInfo = {
    steps: [
      { tokenSymbol: sourceVaultSymbol, action: "Redeem", description: `${sourceVaultSymbol} for ${sourceUnderlyingSymbol}`, protocol: "yld", amount: formatWei(params.amountIn) },
      { tokenSymbol: sourceUnderlyingSymbol, action: "Swap", description: `${sourceUnderlyingSymbol} for CVX`, protocol: "Enso", amount: formatWei(estimatedUnderlying) },
      { tokenSymbol: "CVX", action: "Swap", description: "CVX → CVX1 → cvgCVX", protocol: "LiquidBoost", amount: formatWei(estimatedCvx), bonus: swapBonus, bonusAmount: bonusAmountFormatted, bonusSymbol: "cvgCVX" },
      { tokenSymbol: "cvgCVX", action: "Deposit", description: `cvgCVX into ${targetVaultSymbol} vault`, protocol: "yld", amount: formatWei(expectedCvgCvx) },
      { tokenSymbol: targetVaultSymbol, action: "Receive", description: "vault shares", protocol: "yld", amount: formatWei(expectedShares) },
    ],
    tokens: [sourceVaultSymbol, sourceUnderlyingSymbol, "CVX", "cvgCVX", targetVaultSymbol],
    protocols: ["yld", "Enso", "Curve", "yld"],
    // 100% swap (no mint) - show swap bonus
    hybrid: {
      swapAmount: conservativeCvx.toString(),
      mintAmount: "0",
      swapBonus,
      swapProtocol: "Curve",
      mintProtocol: "Convex",
    },
  };

  return { ...bundle, routeInfo };
}

/**
 * Custom bundle for zapping FROM a cvgCVX vault to another vault
 * Route: source vault → cvgCVX → CVX1 → CVX → target underlying → target vault
 *
 * Note: This function estimates the CVX amount for the route action because
 * KyberSwap routes cannot be quoted with dynamic amounts (useOutputOfCallAt).
 * The estimation uses Curve pool's get_dy and applies conservative slippage.
 */
async function fetchCvgCvxVaultToVaultRoute(params: {
  fromAddress: string;
  sourceVault: string;
  targetVault: string;
  amountIn: string;
  targetUnderlyingToken: string;
  slippage: string;
}): Promise<EnsoBundleResponse> {
  const { TANGENT, PIREX } = await import("@/config/vaults");

  // Validate slippage parameter
  const slippageBps = validateSlippage(params.slippage);

  // Check if target is pxCVX - needs special routing via Curve swap + unwrap
  const targetIsPxCvx = params.targetUnderlyingToken.toLowerCase() === TOKENS.PXCVX.toLowerCase();

  // OPTIMIZED: Batch previewRedeem + pool params in single RPC call
  // Uses off-chain StableSwap math for getDy calculation
  // Apply slippage buffer dynamically based on user's slippage setting
  const bufferMultiplier = 1 - slippageBps / 10000;
  const { redeemAmount: _cvgCvxAmount, swapOutput: estimatedCvx1, rawSwapOutput: rawEstimatedCvx1 } = await batchRedeemAndEstimateSwap(
    params.sourceVault,
    params.amountIn,
    TANGENT.CVX1_CVGCVX_POOL,
    1, // cvgCVX index (input)
    0, // CVX1 index (output)
    bufferMultiplier // Conservative buffer based on user's slippage setting
  );

  // CRITICAL: Throw if estimation fails or returns zero - never use min_dy=0
  if (estimatedCvx1 === 0n) {
    throw new Error("Failed to estimate Curve cvgCVX→CVX1 swap output for slippage protection");
  }

  // Calculate min_dy with slippage tolerance
  const minDyCvx1 = calculateMinDy(estimatedCvx1, slippageBps);
  const conservativeCvxStr = applySlippageBuffer(estimatedCvx1, slippageBps);

  // Build common actions for cvgCVX → CVX conversion
  const actions: EnsoBundleAction[] = [
    // Action 0: Redeem from source vault to get cvgCVX
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.sourceVault,
        tokenOut: TOKENS.CVGCVX,
        amountIn: params.amountIn,
        primaryAddress: params.sourceVault,
      },
    },
    // Action 1: Approve cvgCVX → Curve pool
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVGCVX, spender: TANGENT.CVX1_CVGCVX_POOL, amount: { useOutputOfCallAt: 0 } },
    },
    // Action 2: Swap cvgCVX → CVX1 via Curve pool (index 1 → 0)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [1, 0, { useOutputOfCallAt: 0 }, minDyCvx1], // min_dy with slippage protection
      },
    },
  ];

  if (targetIsPxCvx) {
    // Target is pxCVX - needs custom routing: CVX1 → CVX → lpxCVX → pxCVX
    // CVX1 unwraps 1:1 to CVX, so use CVX1 amount for subsequent operations

    // Apply slippage buffer to CVX estimate for fixed-amount actions
    // The Curve swap (Action 2) may receive less than estimatedCvx1 due to slippage,
    // so we use a conservative amount to avoid trying to spend more than we received
    const conservativeCvxStr = applySlippageBuffer(estimatedCvx1, slippageBps);

    // Estimate lpxCVX output from CVX → lpxCVX Curve swap (using conservative CVX amount)
    // Use factory-style helper since lpxCVX/CVX pool uses uint256 indices
    const estimatedLpxCvx = await getCurveGetDyFactory(
      PIREX.LPXCVX_CVX_POOL,
      0, // CVX index
      1, // lpxCVX index
      conservativeCvxStr
    );

    if (estimatedLpxCvx === null || estimatedLpxCvx === 0n) {
      throw new Error("Failed to estimate Curve CVX→lpxCVX swap output for slippage protection");
    }

    const estimatedLpxCvxStr = estimatedLpxCvx.toString();
    // pxCVX wraps 1:1 from lpxCVX (variable kept for documentation)
    const _estimatedPxCvxStr = estimatedLpxCvxStr;
    // Calculate min_dy for the CVX → lpxCVX swap with slippage protection
    const minDyLpxCvx = calculateMinDy(estimatedLpxCvx, slippageBps);

    // Use useOutputOfCallAt for dynamic output chaining
    // Action 2 (Curve cvgCVX→CVX1) output can be referenced by multiple subsequent actions:
    //   - Action 3: withdraw CVX1 → CVX (uses the amount)
    //   - Action 4: approve CVX (uses the amount for allowance)
    //   - Action 5: exchange CVX → lpxCVX (uses the amount as swap input)
    // Action 5 (Curve CVX→lpxCVX) returns lpxCVX amount - referenced by Actions 6-8:
    //   - Action 6: approve (sets allowance for the lpxCVX amount)
    //   - Action 7: unwrap lpxCVX → pxCVX (transfers the lpxCVX)
    //   - Action 8: deposit pxCVX into vault (uses Action 5's output, lpxCVX:pxCVX is 1:1)
    actions.push(
      // Action 3: Unwrap CVX1 → CVX (send to ENSO_SHORTCUTS)
      // Use output from Action 2 (Curve exchange returns CVX1 amount)
      // IMPORTANT: CVX must go to ENSO_SHORTCUTS (not ENSO_ROUTER_EXECUTOR) because
      // Action 5's Curve.exchange does transferFrom(msg.sender, ...) and ENSO_SHORTCUTS
      // is the caller/executor for Curve calls.
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "withdraw",
          abi: "function withdraw(uint256 amount, address to)",
          args: [{ useOutputOfCallAt: 2 }, ENSO_SHORTCUTS],
        },
      },
      // Action 4: Approve CVX → Curve lpxCVX pool
      // Use dynamic output from Action 2 (CVX1 unwraps 1:1 to CVX)
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX,
          spender: PIREX.LPXCVX_CVX_POOL,
          amount: { useOutputOfCallAt: 2 },
        },
      },
      // Action 5: Swap CVX → lpxCVX via Curve (RETURNS uint256)
      // Use dynamic output from Action 2 - the actual CVX1/CVX amount received
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX_CVX_POOL,
          method: "exchange",
          abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
          args: [
            String(PIREX.POOL_INDEX.CVX), // i = 0 (CVX)
            String(PIREX.POOL_INDEX.LPXCVX), // j = 1 (lpxCVX)
            { useOutputOfCallAt: 2 }, // dx = CVX amount from Action 2 output
            minDyLpxCvx, // min_dy with slippage protection
          ],
        },
      },
      // Action 6: Approve lpxCVX for unwrap
      // Use output from Action 5 (Curve exchange returns lpxCVX amount)
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: PIREX.LPXCVX,
          spender: PIREX.LPXCVX,
          amount: { useOutputOfCallAt: 5 },
        },
      },
      // Action 7: Unwrap lpxCVX → pxCVX
      {
        protocol: "enso",
        action: "call",
        args: {
          address: PIREX.LPXCVX,
          method: "unwrap",
          abi: "function unwrap(uint256 amount)",
          args: [{ useOutputOfCallAt: 5 }],
        },
      },
      // Action 8: Deposit pxCVX into target vault
      // lpxCVX unwraps 1:1 to pxCVX, so use Action 5's output
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: TOKENS.PXCVX,
          tokenOut: params.targetVault,
          amountIn: { useOutputOfCallAt: 5 },
          primaryAddress: params.targetVault,
        },
      }
    );

    return fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "router",
      skipQuote: process.env.ENSO_SKIP_ROUTE_QUOTE === "true",
    });
  }

  // Standard path: CVX → target underlying
  actions.push(
    // Action 3: Unwrap CVX1 → CVX (send to shortcuts for downstream calls)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "withdraw",
        abi: "function withdraw(uint256 amount, address to)",
        args: [{ useOutputOfCallAt: 2 }, ENSO_SHORTCUTS],
      },
    }
  );

  const targetIsCvxCrv = params.targetUnderlyingToken.toLowerCase() === TOKENS.CVXCRV.toLowerCase();

  // Track expected cvxCRV output for amountsOut (set inside targetIsCvxCrv block)
  let expectedCvxCrvOutput: bigint | null = null;

  if (targetIsCvxCrv) {
    // Estimate chain for min_dy safety values (conservative, with slippage buffers)
    const expectedWeth = await estimateCryptoSwapOffchain(
      CURVE_CVX_ETH_POOL,
      1, // CVX index
      0, // WETH index
      conservativeCvxStr
    );

    if (expectedWeth === null || expectedWeth === 0n) {
      throw new Error("Failed to estimate CVX→WETH output from Curve cvxETH pool");
    }

    const _minDyWeth = calculateMinDy(expectedWeth, slippageBps);
    const conservativeWethStr = applySlippageBuffer(expectedWeth, slippageBps);

    const expectedCrv = await getCurveGetDyFactory(
      CURVE_TRICRV_POOL,
      1, // WETH index
      2, // CRV index
      conservativeWethStr
    );

    if (expectedCrv === null || expectedCrv === 0n) {
      throw new Error("Failed to estimate WETH→CRV output from Curve TriCRV pool");
    }

    const _minDyCrv = calculateMinDy(expectedCrv, slippageBps);
    const conservativeCrvStr = applySlippageBuffer(expectedCrv, slippageBps);

    const expectedCvxCrv = await getCurveGetDy(
      CURVE_CRV_CVXCRV_POOL,
      0, // CRV index
      1, // cvxCRV index
      conservativeCrvStr
    );

    if (expectedCvxCrv === null || expectedCvxCrv === 0n) {
      throw new Error("Failed to estimate CRV→cvxCRV output from Curve cvxCRV pool");
    }

    // Separate un-buffered estimate chain for display (accurate price impact)
    // Uses rawEstimatedCvx1 — no conservative buffer applied at any step
    const displayWeth = await estimateCryptoSwapOffchain(CURVE_CVX_ETH_POOL, 1, 0, rawEstimatedCvx1);
    const displayCrv = displayWeth > 0n ? await getCurveGetDyFactory(CURVE_TRICRV_POOL, 1, 2, displayWeth.toString()) : null;
    const displayCvxCrv = displayCrv ? await getCurveGetDy(CURVE_CRV_CVXCRV_POOL, 0, 1, displayCrv.toString()) : null;

    // Use un-buffered estimate for display, fall back to conservative if unavailable
    expectedCvxCrvOutput = displayCvxCrv ?? expectedCvxCrv;

    const minDyCvxCrv = calculateMinDy(expectedCvxCrv, slippageBps);

    const curveRoute = [
      TOKENS.CVX,
      CURVE_CVX_ETH_POOL,
      WETH_ADDRESS,
      CURVE_TRICRV_POOL,
      CRV_ADDRESS,
      CURVE_CRV_CVXCRV_POOL,
      TOKENS.CVXCRV,
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
    ];

    const swapParams = [
      [1, 0, 3], // CVX -> WETH (crypto pool)
      [1, 2, 3], // WETH -> CRV (TriCRV crypto pool)
      [0, 1, 1], // CRV -> cvxCRV (stableswap)
      [0, 0, 0],
    ];

    actions.push(
      // Action 4: Approve CVX → Curve router
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX,
          spender: CURVE_ROUTER,
          amount: { useOutputOfCallAt: 2 },
        },
      },
      // Action 5: Swap CVX → cvxCRV via Curve router (cvxeth -> crv/eth -> cvxcrv)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: CURVE_ROUTER,
          method: "exchange_multiple",
          abi: "function exchange_multiple(address[9] _route, uint256[3][4] _swap_params, uint256 _amount, uint256 _expected, address[4] _pools, address _receiver) payable returns (uint256)",
          args: [
            curveRoute,
            swapParams,
            { useOutputOfCallAt: 2 },
            minDyCvxCrv,
            [
              "0x0000000000000000000000000000000000000000",
              "0x0000000000000000000000000000000000000000",
              "0x0000000000000000000000000000000000000000",
              "0x0000000000000000000000000000000000000000",
            ],
            ENSO_SHORTCUTS,
          ],
        },
      },
      // Action 6: Deposit target underlying into target vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: params.targetUnderlyingToken,
          tokenOut: params.targetVault,
          amountIn: { useOutputOfCallAt: 5 },
          primaryAddress: params.targetVault,
        },
      }
    );
  } else {
    // CVX1.withdraw() is void — can't chain output via useOutputOfCallAt.
    // Use concrete amount for route action. Enso's simulation (no skipQuote) executes
    // the full bundle, so CVX at ENSO_SHORTCUTS from withdraw step is visible to the route.
    actions.push(
      // Action 4: Route CVX → target underlying via Enso (concrete amount)
      {
        protocol: "enso",
        action: "route",
        args: {
          tokenIn: TOKENS.CVX,
          tokenOut: params.targetUnderlyingToken,
          amountIn: conservativeCvxStr,
          slippage: params.slippage,
        },
      },
      // Action 5: Deposit target underlying into target vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: params.targetUnderlyingToken,
          tokenOut: params.targetVault,
          amountIn: { useOutputOfCallAt: 4 },
          primaryAddress: params.targetVault,
        },
      }
    );
  }

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    // Curve router calls can fail Enso simulation; skipQuote avoids simulation-based rejection
    ...(targetIsCvxCrv ? { skipQuote: true } : {}),
  });

  // When targetIsCvxCrv, we calculate our own expected values using previewDeposit
  // Enso's amountsOut may be empty (skipQuote:true) or inaccurate, so we override
  if (targetIsCvxCrv && expectedCvxCrvOutput) {
    // Calculate expected vault shares using previewDeposit on the target vault
    // cvxCRV amount → vault shares (not 1:1 due to assetsPerShare > 1)
    let expectedShares: string = expectedCvxCrvOutput.toString();
    try {
      const previewDepositSelector = "0xef8b30f7"; // previewDeposit(uint256)
      const previewData = previewDepositSelector + expectedCvxCrvOutput.toString(16).padStart(64, "0");
      const previewResult = await rpcWithFallback<{ result?: string }>({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: params.targetVault, data: previewData }, "latest"],
      });
      if (previewResult.result && previewResult.result !== "0x") {
        expectedShares = BigInt(previewResult.result).toString();
      }
    } catch {
      // Fall back to cvxCRV amount if previewDeposit fails (shouldn't happen)
    }

    bundleResult.amountsOut = {
      [params.targetVault.toLowerCase()]: expectedShares,
      [TOKENS.CVXCRV.toLowerCase()]: expectedCvxCrvOutput.toString(),
    };
  }

  return bundleResult;
}

/**
 * Custom bundle for zapping TO a pxCVX vault from another vault
 * Route: source vault → source underlying → route to CVX → hybrid swap/mint → pxCVX → deposit
 *
 * Uses the hybrid pxCVX approach:
 * - If Curve pool rate > 1:1: swap CVX → lpxCVX → unwrap → pxCVX
 * - If rate < 1:1: deposit CVX to Pirex for 1:1 pxCVX
 * - Optimal: split between swap and mint at peg point
 */
async function fetchVaultToPxCvxVaultRoute(params: {
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
  let expectedSwapPxCvx = 0n;
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
    expectedSwapPxCvx = swapOutput;
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

  const totalExpectedPxCvx = expectedSwapPxCvx + mintAmount;

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

  if (swapAmount > 0n && mintAmount > 0n) {
    // Hybrid: swap portion via Curve, mint portion via Pirex
    // NOTE: We use literal amounts for the hybrid split, not useOutputOfCallAt
    // because we need to split the CVX between two paths

    // Approve CVX to Curve pool for swap portion
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: swapAmount.toString(),
      },
    });
    actionIndex++;

    // Swap CVX → lpxCVX via Curve (with slippage protection)
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX_CVX_POOL,
        method: "exchange",
        abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
        args: [String(PIREX.POOL_INDEX.CVX), String(PIREX.POOL_INDEX.LPXCVX), swapAmount.toString(), swapMinDy],
      },
    });
    const swapIdx = actionIndex++;

    // Approve lpxCVX for unwrap
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: swapIdx },
      },
    });
    actionIndex++;

    // Unwrap lpxCVX → pxCVX
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "unwrap",
        abi: "function unwrap(uint256 amount)",
        args: [{ useOutputOfCallAt: swapIdx }],
      },
    });
    actionIndex++;

    // Approve CVX to Pirex for mint portion
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.PIREX_CVX,
        amount: mintAmount.toString(),
      },
    });
    actionIndex++;

    // Deposit CVX to Pirex → pxCVX
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.PIREX_CVX,
        method: "deposit",
        abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
        args: [mintAmount.toString(), params.fromAddress, "false", "0x0000000000000000000000000000000000000000"],
      },
    });
    actionIndex++;

  } else if (swapAmount > 0n) {
    // Swap-only path (all CVX goes through Curve swap)
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: { useOutputOfCallAt: cvxSourceIdx },
      },
    });
    actionIndex++;

    // Swap CVX → lpxCVX via Curve with calculated min_dy for MEV protection
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX_CVX_POOL,
        method: "exchange",
        abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
        args: [String(PIREX.POOL_INDEX.CVX), String(PIREX.POOL_INDEX.LPXCVX), { useOutputOfCallAt: cvxSourceIdx }, fullSwapMinDy],
      },
    });
    const swapIdx = actionIndex++;

    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: swapIdx },
      },
    });
    actionIndex++;

    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "unwrap",
        abi: "function unwrap(uint256 amount)",
        args: [{ useOutputOfCallAt: swapIdx }],
      },
    });
    actionIndex++;

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
        args: [{ useOutputOfCallAt: cvxSourceIdx }, params.fromAddress, "false", "0x0000000000000000000000000000000000000000"],
      },
    });
    actionIndex++;
  }

  // Final: Deposit pxCVX into target vault
  // Use erc4626 action so amountsOut tracks the vault shares
  actions.push({
    protocol: "erc4626",
    action: "deposit",
    args: {
      tokenIn: PIREX.PXCVX,
      tokenOut: params.targetVault,
      amountIn: totalExpectedPxCvx.toString(),
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

  // Check if target is cvgCVX - needs custom routing via CVX1/Curve
  const targetIsCvgCvx = params.targetUnderlyingToken.toLowerCase() === TOKENS.CVGCVX.toLowerCase();

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
  } else if (targetIsCvgCvx) {
    // Target is cvgCVX - needs custom routing via CVX1 wrap + Curve swap
    const { TANGENT } = await import("@/config/vaults");

    // Apply slippage buffer to CVX estimate for fixed-amount actions
    // The Curve swap (Action 4) may receive less than estimatedCvx due to slippage,
    // so we use a conservative amount to avoid trying to spend more than we received
    const conservativeCvxStr = applySlippageBuffer(estimatedCvx, slippageBps);

    // Estimate cvgCVX output for the deposit action (using conservative CVX amount)
    const estimatedCvgCvx = await getCvgCvxSwapRate(conservativeCvxStr);
    // Apply slippage buffer to cvgCVX estimate for the deposit action
    const conservativeCvgCvxStr = applySlippageBuffer(estimatedCvgCvx, slippageBps);
    // Calculate min_dy for the CVX1 → cvgCVX swap with slippage protection
    const minDyCvgCvx = calculateMinDy(estimatedCvgCvx, slippageBps);

    actions.push(
      // Action 5: Approve CVX → CVX1 wrapper
      // Use slippage-buffered estimate to account for slippage from Action 4
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX,
          spender: TOKENS.CVX1,
          amount: conservativeCvxStr, // CVX from Curve exchange (slippage-buffered)
        },
      },
      // Action 6: Mint CVX → CVX1 (mint to ENSO_SHORTCUTS for Curve call)
      // CVX1 must go to ENSO_SHORTCUTS because Curve.exchange does transferFrom(msg.sender, ...)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "mint",
          abi: "function mint(address to, uint256 amount)",
          args: [ENSO_SHORTCUTS, conservativeCvxStr],
        },
      },
      // Action 7: Approve CVX1 → Curve pool (use CVX amount since mint is 1:1)
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVX1,
          spender: TANGENT.CVX1_CVGCVX_POOL,
          amount: conservativeCvxStr, // Use CVX amount (1:1 with CVX1, slippage-buffered)
        },
      },
      // Action 8: Swap CVX1 → cvgCVX on Curve pool
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVX1_CVGCVX_POOL,
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          args: [
            "0", // i = 0 (CVX1)
            "1", // j = 1 (cvgCVX)
            conservativeCvxStr, // dx = CVX1 amount (same as CVX, 1:1 mint, slippage-buffered)
            minDyCvgCvx, // min_dy with slippage protection
          ],
        },
      },
      // Action 9: Deposit cvgCVX into target vault
      // Use slippage-buffered estimate to account for slippage from Action 8
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: TOKENS.CVGCVX,
          tokenOut: params.targetVault,
          amountIn: conservativeCvgCvxStr, // Use estimated Curve exchange output (slippage-buffered)
          primaryAddress: params.targetVault,
        },
      }
    );
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

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
}

/**
 * Check if a token requires custom zap routing (not supported by standard Enso routes)
 */
export function requiresCustomZapRoute(tokenAddress: string): boolean {
  const addr = tokenAddress.toLowerCase();
  // cvgCVX requires custom routing through Tangent/CVX1/Curve
  // pxCVX requires custom routing through Pirex/lpxCVX/Curve
  return addr === TOKENS.CVGCVX.toLowerCase() || addr === TOKENS.PXCVX.toLowerCase();
}

/**
 * Get the Curve pool swap rate for CVX1 → cvgCVX
 * Returns the amount of cvgCVX you'd get for a given amount of CVX1
 */
export async function getCvgCvxSwapRate(amountIn: string): Promise<bigint> {
  const { TANGENT } = await import("@/config/vaults");

  // Use centralized getCurveGetDy to avoid duplicate implementations
  // Note: Keep using direct RPC call here for backward compatibility with tests
  // Main optimization is in fetchCvgCvxVaultToVaultRoute which uses batchRedeemAndEstimateSwap
  const result = await getCurveGetDy(TANGENT.CVX1_CVGCVX_POOL, 0, 1, amountIn);
  return result ?? 0n;
}

/**
 * Get reverse swap rate: cvgCVX → CVX (via Curve CVX1/cvgCVX pool)
 * Used for BorrowTab reverse quotes when user wants to borrow into a cvgCVX vault
 */
export async function getCvgCvxReverseSwapRate(amountIn: string): Promise<bigint> {
  const { TANGENT } = await import("@/config/vaults");
  const result = await getCurveGetDy(TANGENT.CVX1_CVGCVX_POOL, 1, 0, amountIn);
  return result ?? 0n;
}

/**
 * Get Curve pool balances for CVX1/cvgCVX
 */
export async function getCvgCvxPoolBalances(): Promise<{ cvx1Balance: bigint; cvgCvxBalance: bigint }> {
  const { TANGENT } = await import("@/config/vaults");

  // Batch both balance calls to single RPC request
  const batch = [
    { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: TANGENT.CVX1_CVGCVX_POOL, data: "0x4903b0d10000000000000000000000000000000000000000000000000000000000000000" }, "latest"] },
    { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: TANGENT.CVX1_CVGCVX_POOL, data: "0x4903b0d10000000000000000000000000000000000000000000000000000000000000001" }, "latest"] },
  ];

  const results = await rpcWithFallback<Array<{ id: number; result?: string }>>(batch);
  results.sort((a, b) => a.id - b.id);

  return {
    cvx1Balance: BigInt(results[0].result || "0"),
    cvgCvxBalance: BigInt(results[1].result || "0"),
  };
}

/**
 * Find the maximum amount of CVX1 that can be swapped for cvgCVX
 * while maintaining a rate >= 1:1 (getting at least 1 cvgCVX per CVX1)
 *
 * Uses off-chain StableSwap math for fast computation (~500ms with 2 RPC calls)
 * vs ~14s with 16 RPC calls for on-chain binary search
 *
 * Hybrid approach (per Codex recommendation):
 * 1. Calculate peg point off-chain using StableSwap math
 * 2. Verify with on-chain get_dy call
 * 3. If verification fails, reduce by 1% for safety margin
 */
export async function findMaxSwapBeforePeg(): Promise<bigint> {
  const { TANGENT } = await import("@/config/vaults");

  // RPC call 1: Get all pool parameters
  const { balances, Ann, fee, offpegFeeMultiplier } = await getStableSwapParams(TANGENT.CVX1_CVGCVX_POOL);

  // Find peg point using off-chain math (local computation, ~0ms)
  let pegPoint = findPegPointOffchain(balances, Ann, fee, offpegFeeMultiplier);

  if (pegPoint === 0n) {
    return 0n;
  }

  // RPC call 2: Verify with on-chain get_dy
  try {
    const dy = await getCvgCvxSwapRate(pegPoint.toString());

    if (dy < pegPoint) {
      // Off-chain was slightly optimistic, reduce by 1% for safety
      pegPoint = (pegPoint * 99n) / 100n;
    }
  } catch {
    // If verification fails, reduce by 2% as extra safety margin
    pegPoint = (pegPoint * 98n) / 100n;
  }

  return pegPoint;
}

/**
 * Calculate optimal swap amount for hybrid swap/mint strategy
 * Returns the max amount that can be swapped while still getting >= 1:1 rate
 *
 * Uses off-chain StableSwap math with on-chain verification (~500ms, 2 RPC calls)
 * vs ~14s with 16 RPC calls for pure on-chain binary search
 */
export async function getOptimalSwapAmount(totalCvxAmount: string): Promise<{ swapAmount: bigint; mintAmount: bigint }> {
  const totalAmount = BigInt(totalCvxAmount);

  if (totalAmount === 0n) {
    return { swapAmount: 0n, mintAmount: 0n };
  }

  try {
    // Find max amount that can be swapped at >= 1:1 rate
    const maxSwapBeforePeg = await findMaxSwapBeforePeg();

    if (maxSwapBeforePeg === 0n) {
      // No swap bonus available - mint everything
      return { swapAmount: 0n, mintAmount: totalAmount };
    }

    if (maxSwapBeforePeg >= totalAmount) {
      // Can swap everything with bonus
      return { swapAmount: totalAmount, mintAmount: 0n };
    }

    // Hybrid strategy: swap up to max, mint the rest
    return {
      swapAmount: maxSwapBeforePeg,
      mintAmount: totalAmount - maxSwapBeforePeg
    };
  } catch {
    // Default to mint if we can't determine
    return { swapAmount: 0n, mintAmount: totalAmount };
  }
}

/**
 * Determine optimal route for CVX → cvgCVX
 * Returns "swap" if Curve pool gives better rate, "mint" if 1:1 mint is better
 */
export async function getOptimalCvgCvxRoute(cvxAmount: string): Promise<"swap" | "mint"> {
  try {
    // Get swap output from Curve pool (CVX1 is 1:1 with CVX, so use cvxAmount directly)
    const swapOutput = await getCvgCvxSwapRate(cvxAmount);
    const cvxAmountBigInt = BigInt(cvxAmount);

    // If swap gives more cvgCVX than mint (1:1), use swap
    // Otherwise use mint
    return swapOutput > cvxAmountBigInt ? "swap" : "mint";
  } catch {
    // Default to mint if we can't determine
    return "mint";
  }
}

/**
 * Build route steps for cvgCVX zap in
 */
interface CvgCvxStepAmounts {
  inputAmount?: string;      // Input token amount (formatted)
  cvxAmount?: string;        // Total CVX amount after first swap (formatted)
  swapCvxAmount?: string;    // CVX amount going to swap (formatted, for hybrid)
  mintCvxAmount?: string;    // CVX amount going to mint (formatted, for hybrid)
  cvgCvxAmount?: string;     // cvgCVX amount after Curve swap (formatted)
  vaultSharesAmount?: string; // Vault shares received (formatted)
}

function buildCvgCvxZapInSteps(
  inputSymbol: string,
  vaultSymbol: string,
  inputIsCvx: boolean,
  swapAmount: bigint,
  mintAmount: bigint,
  swapBonus: number,
  bonusAmount?: string,
  amounts?: CvgCvxStepAmounts
): RouteStep[] {
  const steps: RouteStep[] = [];

  // Step 1: Route input to CVX (if not already CVX)
  if (!inputIsCvx && inputSymbol !== "cvgCVX") {
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
      description: "CVX → CVX1 → cvgCVX",
      protocol: "LiquidBoost",
      amount: amounts?.swapCvxAmount,
      bonus: swapBonus,
      bonusAmount,
      bonusSymbol: "cvgCVX",
    });
    steps.push({
      tokenSymbol: "CVX",
      action: "Mint",
      description: "CVX → CVX1 → cvgCVX",
      protocol: "LiquidBoost",
      amount: amounts?.mintCvxAmount,
    });
  } else if (swapAmount > 0n) {
    // 100% swap
    steps.push({
      tokenSymbol: "CVX",
      action: "Swap",
      description: "CVX → CVX1 → cvgCVX",
      protocol: "LiquidBoost",
      amount: amounts?.cvxAmount,
      bonus: swapBonus,
      bonusAmount,
      bonusSymbol: "cvgCVX",
    });
  } else {
    // 100% mint
    steps.push({
      tokenSymbol: "CVX",
      action: "Mint",
      description: "CVX → CVX1 → cvgCVX",
      protocol: "LiquidBoost",
      amount: amounts?.cvxAmount,
    });
  }

  // Step 3: Deposit into vault
  steps.push({
    tokenSymbol: "cvgCVX",
    action: "Deposit",
    description: `cvgCVX into ${vaultSymbol}`,
    protocol: "yld",
    amount: amounts?.cvgCvxAmount,
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
 * Create a custom Zap In route for cvgCVX via Tangent infrastructure
 * Uses hybrid swap/mint strategy for optimal cvgCVX acquisition:
 *
 * - When Curve pool rate > 1.0: Swap through pool to get bonus cvgCVX
 * - When Curve pool rate < 1.0: Direct mint at 1:1 (avoids slippage loss)
 * - Hybrid: Binary search finds optimal split between swap and mint
 *
 * Uses delegate routing strategy because:
 * - CVX1.mint has no return value, so standard router can't track token flow
 * - Delegate executes via delegateCalls from user's context, keeping tokens with user
 */
export async function fetchCvgCvxZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  inputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  const { TANGENT } = await import("@/config/vaults");
  const slippageBps = parseInt(params.slippage ?? "100", 10);
  const vaultSymbol = getTokenSymbol(params.vaultAddress);
  const inputSymbol = getTokenSymbol(params.inputToken);

  // Check if input is already cvgCVX (vault's underlying) - just deposit directly
  const inputIsCvgCvx = params.inputToken.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
  if (inputIsCvgCvx) {
    // Direct deposit - no routing needed
    const actions: EnsoBundleAction[] = [
      // Action 0: Approve cvgCVX → vault
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: params.amountIn },
      },
      // Action 1: Deposit cvgCVX → vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: TOKENS.CVGCVX,
          tokenOut: params.vaultAddress,
          amountIn: params.amountIn,
          primaryAddress: params.vaultAddress,
        },
      },
    ];

    const bundle = await fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "router",
    });

    return {
      ...bundle,
      routeInfo: {
        steps: [
          { tokenSymbol: "cvgCVX", action: "Deposit", description: "cvgCVX into vault", protocol: "yld" },
          { tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" },
        ],
        tokens: ["cvgCVX", vaultSymbol],
        protocols: ["yld"],
      },
    };
  }

  // Check if input is already CVX - skip initial route step
  const inputIsCvx = params.inputToken.toLowerCase() === TOKENS.CVX.toLowerCase();
  const inputIsEth = params.inputToken.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const useRouteForEth = process.env.ENSO_ROUTE_ETH === "true";
  const skipRouteQuote = process.env.ENSO_SKIP_ROUTE_QUOTE === "true";

  // Step 1: Estimate CVX amount for optimal split calculation
  // For ETH: use cached rate or fallback estimate (avoids extra API call)
  // For CVX: use amount directly
  // For other tokens: still need route call (but could extend cache)
  let expectedCvxOutput: string;
  if (inputIsCvx) {
    // Input is already CVX, use amount directly
    expectedCvxOutput = params.amountIn;
  } else if (inputIsEth) {
    if (useRouteForEth) {
      const routeQuote = await fetchRoute({
        fromAddress: params.fromAddress,
        tokenIn: params.inputToken,
        tokenOut: TOKENS.CVX,
        amountIn: params.amountIn,
        slippage: params.slippage,
      });
      expectedCvxOutput = routeQuote.amountOut;
    } else {
      // Use on-chain Curve pool pricing (RPC call, not Enso API)
      // This avoids Enso rate limits while getting accurate real-time price
      expectedCvxOutput = await getEthToCvxEstimate(params.amountIn);
    }
  } else if (!skipRouteQuote) {
    // For other tokens, we still need a route call
    // TODO: Could extend caching for common pairs
    const routeQuote = await fetchRoute({
      fromAddress: params.fromAddress,
      tokenIn: params.inputToken,
      tokenOut: TOKENS.CVX,
      amountIn: params.amountIn,
      slippage: params.slippage,
    });
    expectedCvxOutput = routeQuote.amountOut;

  } else {
    // Skip Enso route quote (avoids rate limits); use mint-only with unknown output amount.
    expectedCvxOutput = "0";
  }

  if (!inputIsCvx && !inputIsEth && skipRouteQuote) {
    const tokenPath = [inputSymbol, "CVX", "cvgCVX", vaultSymbol];
    const bundle = await buildMintOnlyBundle(params, TANGENT, expectedCvxOutput, slippageBps, inputIsCvx);
    const routeInfo: RouteInfo = {
      steps: buildCvgCvxZapInSteps(inputSymbol, vaultSymbol, inputIsCvx, 0n, 0n, 0),
      tokens: tokenPath,
      protocols: ["Enso", "Convex", "yld"],
      hybrid: {
        swapAmount: "0",
        mintAmount: "0",
        swapBonus: 0,
        swapProtocol: "Curve",
        mintProtocol: "Convex",
      },
    };
    return { ...bundle, routeInfo };
  }

  // Step 2: Apply slippage buffer to CVX estimate for non-CVX inputs
  // This ensures we don't try to use more CVX than we actually receive after routing slippage
  // For non-CVX inputs, we apply DOUBLE the user's slippage as a safety buffer because:
  // 1. Our estimate (Curve pool) might differ from Enso's actual route
  // 2. The route itself has slippage
  // 3. State can change between quote and execution
  // Better to leave some CVX dust in router than to have tx revert
  const routingBufferBps = inputIsCvx ? slippageBps : slippageBps * 2;
  const cvxAmountForSplit = inputIsCvx
    ? expectedCvxOutput
    : applySlippageBuffer(BigInt(expectedCvxOutput), routingBufferBps);

  // Step 3: Calculate optimal split between swap and mint using conservative CVX amount
  const { swapAmount, mintAmount } = await getOptimalSwapAmount(cvxAmountForSplit);

  // Build token path - skip CVX if input is already CVX
  const tokenPath = inputIsCvx
    ? ["CVX", "cvgCVX", vaultSymbol]
    : [inputSymbol, "CVX", "cvgCVX", vaultSymbol];

  // Step 3: Build bundle based on optimal strategy
  // Note: Hybrid bundles (swap + mint split) only work with CVX input because Enso's shortcut
  // builder can't handle splitting route output into two paths. For non-CVX inputs that would
  // trigger hybrid, we fall back to mint-only (safe 1:1).
  let bundle: EnsoBundleResponse;
  let swapBonus = 0;
  let actualSwapAmount = swapAmount;
  let actualMintAmount = mintAmount;

  let bonusAmount: string | undefined;
  let expectedCvgCvxOutput = "0";

  const isDev = process.env.NODE_ENV === "development";

  if (mintAmount === 0n) {
    // 100% swap through Curve pool (pool is above peg, get bonus)
    if (isDev) {
      console.log("[cvgCVX Zap] Using SWAP-ONLY path", {
        inputIsCvx,
        cvxAmountForSplit,
        slippageBps,
      });
    }
    bundle = await buildSwapOnlyBundle(params, TANGENT, cvxAmountForSplit, slippageBps, inputIsCvx);

    // Calculate swap bonus and bonus amount using conservative CVX amount
    const swapOutput = await getCvgCvxSwapRate(cvxAmountForSplit);
    if (swapOutput) {
      expectedCvgCvxOutput = swapOutput.toString();
      swapBonus = (Number(swapOutput) / Number(cvxAmountForSplit) - 1) * 100;
      // Bonus amount = cvgCVX received - CVX input (what you gain vs 1:1 mint)
      const bonusAmountWei = BigInt(swapOutput) - BigInt(cvxAmountForSplit);
      bonusAmount = (Number(bonusAmountWei) / 1e18).toFixed(4);
    }
  } else if (swapAmount === 0n) {
    // 100% direct mint (pool is below peg, mint at 1:1)
    if (isDev) {
      console.log("[cvgCVX Zap] Using MINT-ONLY path", {
        inputIsCvx,
        cvxAmountForSplit,
        slippageBps,
      });
    }
    bundle = await buildMintOnlyBundle(params, TANGENT, cvxAmountForSplit, slippageBps, inputIsCvx);
    swapBonus = 0;
    expectedCvgCvxOutput = cvxAmountForSplit; // 1:1 mint
    // No bonus for mint-only
  } else {
    // Hybrid path: split input between swap and mint paths
    // CVX input: uses literal amounts (no route needed) - true hybrid works
    // ETH input: use direct Curve call (bypasses Enso route validation) - true hybrid works
    // Other tokens: fall back to dominant single path (Enso validates combined route inputs)

    if (inputIsCvx) {
      // CVX input: true hybrid works with literal amounts
      if (isDev) {
        console.log("[cvgCVX Zap] Using HYBRID path (CVX input)", {
          swapAmount: swapAmount.toString(),
          mintAmount: mintAmount.toString(),
          slippageBps,
        });
      }
      bundle = await buildHybridBundle(params, TANGENT, swapAmount, mintAmount, slippageBps, inputIsCvx);
    } else if (inputIsEth) {
      // ETH input: TRUE HYBRID using fee action split!
      // Uses fee action to split CVX between swap and mint paths
      if (isDev) {
        console.log("[cvgCVX Zap] Using TRUE HYBRID path (ETH input with fee action split)", {
          swapAmount: swapAmount.toString(),
          mintAmount: mintAmount.toString(),
          slippageBps,
        });
      }

      const TANGENT_WITH_ETH = {
        ...TANGENT,
        CVX_ETH_POOL: CURVE_CVX_ETH_POOL,
      };

      bundle = await buildEthHybridBundle(
        { fromAddress: params.fromAddress, vaultAddress: params.vaultAddress, amountIn: params.amountIn, slippage: params.slippage },
        TANGENT_WITH_ETH,
        swapAmount,
        mintAmount,
        slippageBps,
        cvxAmountForSplit
      );

      // Calculate expected cvgCVX output for route info
      const swapOutput = await getCvgCvxSwapRate(swapAmount.toString());
      expectedCvgCvxOutput = ((swapOutput ?? swapAmount) + mintAmount).toString();

      // Swap bonus is proportional to swap portion
      if (swapOutput && swapAmount > 0n) {
        const totalAmount = swapAmount + mintAmount;
        const swapBonusAmount = swapOutput - swapAmount;
        swapBonus = Number(swapBonusAmount) / Number(totalAmount) * 100;
        bonusAmount = (Number(swapBonusAmount) / 1e18).toFixed(4);
      }
    } else {
      // Other non-CVX inputs (USDC, etc.): fall back to dominant single path
      // Hybrid doesn't work because:
      // - Enso's shortcut builder validates combined route inputs for split amounts
      // - CVX1.mint has no return value, so Enso can't chain CVX1
      //   operations and tries to pre-fund CVX1 from user (which fails)
      const totalAmount = swapAmount + mintAmount;
      if (swapAmount > mintAmount) {
        // Swap is larger - use swap-only (get bonus from Curve pool)
        if (isDev) {
          console.log("[cvgCVX Zap] Non-CVX hybrid fallback: using SWAP-ONLY", {
            reason: "CVX1.mint has no return value - Enso pre-funds CVX1 from user",
            inputToken: params.inputToken.slice(0, 10),
            swapPct: (Number(swapAmount) / Number(totalAmount) * 100).toFixed(1),
            mintPct: (Number(mintAmount) / Number(totalAmount) * 100).toFixed(1),
          });
        }
        bundle = await buildSwapOnlyBundle(params, TANGENT, cvxAmountForSplit, slippageBps, inputIsCvx);

        // Update actual amounts to reflect swap-only path
        actualSwapAmount = BigInt(cvxAmountForSplit);
        actualMintAmount = 0n;

        // Calculate swap bonus
        const swapOutput = await getCvgCvxSwapRate(cvxAmountForSplit);
        if (swapOutput) {
          expectedCvgCvxOutput = swapOutput.toString();
          swapBonus = (Number(swapOutput) / Number(cvxAmountForSplit) - 1) * 100;
          const bonusAmountWei = BigInt(swapOutput) - BigInt(cvxAmountForSplit);
          bonusAmount = (Number(bonusAmountWei) / 1e18).toFixed(4);
        }
      } else {
        // Mint is larger - use mint-only (safe 1:1 rate)
        if (isDev) {
          console.log("[cvgCVX Zap] Non-CVX hybrid fallback: using MINT-ONLY", {
            reason: "CVX1.mint has no return value - Enso pre-funds CVX1 from user",
            inputToken: params.inputToken.slice(0, 10),
            swapPct: (Number(swapAmount) / Number(totalAmount) * 100).toFixed(1),
            mintPct: (Number(mintAmount) / Number(totalAmount) * 100).toFixed(1),
          });
        }
        bundle = await buildMintOnlyBundle(params, TANGENT, cvxAmountForSplit, slippageBps, inputIsCvx);

        // Update actual amounts to reflect mint-only path
        actualSwapAmount = 0n;
        actualMintAmount = BigInt(cvxAmountForSplit);
        swapBonus = 0;
        expectedCvgCvxOutput = cvxAmountForSplit; // 1:1 mint
      }
    }

    // Calculate swap bonus for hybrid paths (CVX input only - non-CVX uses dominant single path)
    if (inputIsCvx) {
      const conservativeSwapAmount = BigInt(applySlippageBuffer(swapAmount, slippageBps));
      const swapOutput = await getCvgCvxSwapRate(conservativeSwapAmount.toString());
      if (swapOutput) {
        swapBonus = (Number(swapOutput) / Number(conservativeSwapAmount) - 1) * 100;
        // Bonus amount = cvgCVX received from swap - CVX swapped (gain on swap portion)
        const bonusAmountWei = BigInt(swapOutput) - conservativeSwapAmount;
        bonusAmount = (Number(bonusAmountWei) / 1e18).toFixed(4);
        // Total cvgCVX = swap output + mint amount (1:1)
        expectedCvgCvxOutput = (BigInt(swapOutput) + mintAmount).toString();
      } else {
        expectedCvgCvxOutput = (swapAmount + mintAmount).toString();
      }
    }
  }

  // Calculate expected vault shares using previewDeposit
  // (raw call doesn't track outputs, so we calculate manually)
  let expectedShares: string | undefined;
  try {
    const previewDepositSelector = "0xef8b30f7"; // previewDeposit(uint256)
    const previewData = previewDepositSelector + BigInt(expectedCvgCvxOutput).toString(16).padStart(64, "0");
    const previewResult = await rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: params.vaultAddress, data: previewData }, "latest"],
    });
    if (previewResult.result && previewResult.result !== "0x") {
      expectedShares = BigInt(previewResult.result).toString();
      bundle.amountsOut = {
        ...bundle.amountsOut,
        [params.vaultAddress.toLowerCase()]: expectedShares,
      };
    }
  } catch {
    // Ignore preview errors - amountsOut will just be empty
  }

  // Format amounts for display
  const formatWei = (wei: string | bigint) => (Number(wei) / 1e18).toFixed(4);
  const stepAmounts: CvgCvxStepAmounts = {
    inputAmount: formatWei(params.amountIn),
    cvxAmount: formatWei(expectedCvxOutput),
    swapCvxAmount: actualSwapAmount > 0n ? formatWei(actualSwapAmount) : undefined,
    mintCvxAmount: actualMintAmount > 0n ? formatWei(actualMintAmount) : undefined,
    cvgCvxAmount: formatWei(expectedCvgCvxOutput),
    vaultSharesAmount: expectedShares ? formatWei(expectedShares) : undefined,
  };

  // Build route info with steps (use actual amounts after fallback logic)
  const routeInfo: RouteInfo = {
    steps: buildCvgCvxZapInSteps(inputSymbol, vaultSymbol, inputIsCvx, actualSwapAmount, actualMintAmount, swapBonus, bonusAmount, stepAmounts),
    tokens: tokenPath,
    protocols: inputIsCvx
      ? (actualMintAmount === 0n ? ["Curve", "yld"] : actualSwapAmount === 0n ? ["Convex", "yld"] : ["Curve", "Convex", "yld"])
      : (actualMintAmount === 0n ? ["Enso", "Curve", "yld"] : actualSwapAmount === 0n ? ["Enso", "Convex", "yld"] : ["Enso", "Curve", "Convex", "yld"]),
    hybrid: {
      swapAmount: actualSwapAmount.toString(),
      mintAmount: actualMintAmount.toString(),
      swapBonus,
      swapProtocol: "Curve",
      mintProtocol: "Convex",
    },
  };

  return { ...bundle, routeInfo };
}

/**
 * Build bundle for 100% swap path (Curve pool is above peg)
 * Route: input → CVX → CVX1 → cvgCVX (swap) → vault
 * When inputIsCvx=true: CVX → CVX1 → cvgCVX (swap) → vault (skips initial route)
 */
async function buildSwapOnlyBundle(
  params: { fromAddress: string; vaultAddress: string; inputToken: string; amountIn: string; slippage?: string },
  TANGENT: { CVX1_CVGCVX_POOL: string; CVGCVX_CONTRACT: string },
  expectedCvxOutput: string,
  slippageBps: number,
  inputIsCvx: boolean
): Promise<EnsoBundleResponse> {
  // Query Curve pool get_dy for expected output
  const expectedCvgCvxOutput = await getCurveGetDy(
    TANGENT.CVX1_CVGCVX_POOL,
    0, 1, expectedCvxOutput
  );
  const minDy = expectedCvgCvxOutput
    ? calculateMinDy(expectedCvgCvxOutput, slippageBps)
    : "0";

  if (inputIsCvx) {
    // Input is already CVX - no Enso route quote needed, use direct CVX1/Curve path
    const actions: EnsoBundleAction[] = [
      // Action 0: Approve CVX → CVX1
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: params.amountIn },
      },
      // Action 1: Wrap CVX → CVX1 (mint to ENSO_SHORTCUTS for Curve call)
      // CVX1 must go to ENSO_SHORTCUTS because Curve.exchange does transferFrom(msg.sender, ...)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "mint",
          abi: "function mint(address to, uint256 amount)",
          args: [ENSO_SHORTCUTS, params.amountIn],
        },
      },
      // Action 2: Read CVX1 balance in ENSO_SHORTCUTS (mint has no return value)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "balanceOf",
          abi: "function balanceOf(address account) view returns (uint256)",
          args: [ENSO_SHORTCUTS],
        },
      },
      // Action 3: Approve CVX1 → Curve pool (use balance output)
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVX1, spender: TANGENT.CVX1_CVGCVX_POOL, amount: { useOutputOfCallAt: 2 } },
      },
      // Action 4: Swap CVX1 → cvgCVX via Curve (use balance output)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVX1_CVGCVX_POOL,
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          args: [0, 1, { useOutputOfCallAt: 2 }, minDy],
        },
      },
      // Action 5: Approve cvgCVX → vault
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: { useOutputOfCallAt: 4 } },
      },
      // Action 6: Deposit cvgCVX → vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: TOKENS.CVGCVX,
          tokenOut: params.vaultAddress,
          amountIn: { useOutputOfCallAt: 4 },
          primaryAddress: params.vaultAddress,
        },
      },
    ];

    return fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "router",
      skipQuote: process.env.ENSO_SKIP_ROUTE_QUOTE === "true",
    });
  }

  // Standard path: route input → CVX first
  //
  // CRITICAL: Use useOutputOfCallAt:0 for ALL CVX/CVX1 operations to prevent Enso
  // from trying to pre-fund tokens from the user. Literal amounts cause simulation
  // failures because Enso validates token balances.
  //
  // Key insights:
  // 1. The route action outputs the CVX amount, which we reference with useOutputOfCallAt:0
  // 2. CVX → CVX1 is 1:1, so we can use the same output reference for CVX1 amounts
  // 3. CVX1 must be minted to ENSO_SHORTCUTS (not ENSO_ROUTER_EXECUTOR) because the
  //    Curve exchange is executed BY the Shortcuts contract, and Curve.exchange does
  //    transferFrom(msg.sender, ...) to pull CVX1 from the caller
  //
  // For the final vault deposit, we use { useOutputOfCallAt: 4 } to chain from
  // the Curve exchange output (which does return a value).
  const actions: EnsoBundleAction[] = [
    // Action 0: Swap input → CVX (produces CVX output)
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.inputToken,
        tokenOut: TOKENS.CVX,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      },
    },
    // Action 1: Approve CVX → CVX1 (use route output reference)
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: { useOutputOfCallAt: 0 } },
    },
    // Action 2: Wrap CVX → CVX1 (mint to EnsoShortcuts for Curve call)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "mint",
        abi: "function mint(address to, uint256 amount)",
        args: [ENSO_SHORTCUTS, { useOutputOfCallAt: 0 }],
      },
    },
    // Action 3: Approve CVX1 → Curve pool (CVX1 is 1:1 with CVX, use same ref)
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX1, spender: TANGENT.CVX1_CVGCVX_POOL, amount: { useOutputOfCallAt: 0 } },
    },
    // Action 4: Swap CVX1 → cvgCVX via Curve (use same ref, minDy for slippage protection)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [0, 1, { useOutputOfCallAt: 0 }, minDy],
      },
    },
    // Action 5: Approve cvgCVX → vault (chain from Curve exchange output)
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: { useOutputOfCallAt: 4 } },
    },
    // Action 6: Deposit cvgCVX → vault (chain from Curve exchange output)
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: TOKENS.CVGCVX,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 4 },
        primaryAddress: params.vaultAddress,
      },
    },
  ];

  // Use skipQuote to bypass Enso's simulation which fails with complex output chaining.
  // The bundle uses useOutputOfCallAt to chain outputs, which Enso's simulator can't handle.
  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: true,
  });

  // Manually provide expected amountsOut since skipQuote returns null
  const expectedOutput = expectedCvgCvxOutput?.toString() ?? expectedCvxOutput;
  bundleResult.amountsOut = {
    [params.vaultAddress.toLowerCase()]: expectedOutput,
    [TOKENS.CVGCVX.toLowerCase()]: expectedOutput,
  };

  return bundleResult;
}

/**
 * Build bundle for 100% mint path (Curve pool is below peg)
 * Route: input → CVX → cvgCVX (direct mint 1:1) → vault
 * When inputIsCvx=true: CVX → cvgCVX (direct mint 1:1) → vault (skips initial route)
 */
async function buildMintOnlyBundle(
  params: { fromAddress: string; vaultAddress: string; inputToken: string; amountIn: string; slippage?: string },
  TANGENT: { CVX1_CVGCVX_POOL: string; CVGCVX_CONTRACT: string },
  expectedCvxOutput: string,
  _slippageBps: number,
  inputIsCvx: boolean
): Promise<EnsoBundleResponse> {
  // For mint path, we get 1:1 cvgCVX from CVX
  // The mint function returns the actual minted amount, which we use for deposit
  // Slippage is handled by the initial input → CVX route (if not CVX input)

  if (inputIsCvx) {
    // Input is already CVX - skip the route step, use literal amounts
    const actions: EnsoBundleAction[] = [
      // Action 0: Approve CVX → cvgCVX contract
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVX, spender: TANGENT.CVGCVX_CONTRACT, amount: params.amountIn },
      },
      // Action 1: Mint cvgCVX from CVX (1:1, isLock=true for no fees, mint to router)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVGCVX_CONTRACT,
          method: "mint",
          abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
          args: [ENSO_ROUTER_EXECUTOR, params.amountIn, true],
        },
      },
      // Action 2: Approve cvgCVX → vault
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: { useOutputOfCallAt: 1 } },
      },
      // Action 3: Deposit cvgCVX → vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: TOKENS.CVGCVX,
          tokenOut: params.vaultAddress,
          amountIn: { useOutputOfCallAt: 1 },
          primaryAddress: params.vaultAddress,
        },
      },
    ];

    return fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "router",
      skipQuote: process.env.ENSO_SKIP_ROUTE_QUOTE === "true",
    });
  }

  // Standard path: route input → CVX first
  //
  // CRITICAL: Use useOutputOfCallAt:0 for CVX operations to prevent Enso
  // from trying to pre-fund tokens from the user.
  // The cvgCVX.mint function returns uint256, so we can chain from it for deposit.
  const actions: EnsoBundleAction[] = [
    // Action 0: Swap input → CVX (produces CVX output)
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.inputToken,
        tokenOut: TOKENS.CVX,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      },
    },
    // Action 1: Approve CVX → cvgCVX contract (use route output reference)
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TANGENT.CVGCVX_CONTRACT, amount: { useOutputOfCallAt: 0 } },
    },
    // Action 2: Mint cvgCVX from CVX (use route output, mint returns 1:1)
    // Mint to ENSO_SHORTCUTS so the subsequent deposit (executed by shortcuts) has balance.
    // mint(address to, uint256 amount, bool isLock) returns (uint256)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVGCVX_CONTRACT,
        method: "mint",
        abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
        args: [ENSO_SHORTCUTS, { useOutputOfCallAt: 0 }, true],
      },
    },
    // Action 3: Approve cvgCVX → vault (chain from mint output)
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: { useOutputOfCallAt: 2 } },
    },
    // Action 4: Deposit cvgCVX → vault (chain from mint output)
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: TOKENS.CVGCVX,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 2 },
        primaryAddress: params.vaultAddress,
      },
    },
  ];

  // Use skipQuote to bypass Enso's simulation which fails with output chaining
  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: true,
  });

  // Manually provide expected amountsOut (1:1 mint from CVX)
  bundleResult.amountsOut = {
    [params.vaultAddress.toLowerCase()]: expectedCvxOutput,
    [TOKENS.CVGCVX.toLowerCase()]: expectedCvxOutput,
  };

  return bundleResult;
}

/**
 * Build bundle for hybrid path (swap some, mint the rest)
 *
 * Strategy: Split at the INPUT level, not after CVX routing.
 * This avoids Enso's simulator issue where literal amounts derived from a prior action's
 * output fail validation.
 *
 * For inputIsCvx=true:
 *   CVX → [split: CVX1→swap + direct mint] → cvgCVX → vault
 *   Uses literal amounts since we know exactly how much CVX we have.
 *
 * For inputIsCvx=false:
 *   Route swapInput → CVX → CVX1 → swap → cvgCVX → vault (deposit 1)
 *   Route mintInput → CVX → mint → cvgCVX → vault (deposit 2)
 *   All downstream amounts use useOutputOfCallAt references.
 */
async function buildHybridBundle(
  params: { fromAddress: string; vaultAddress: string; inputToken: string; amountIn: string; slippage?: string },
  TANGENT: { CVX1_CVGCVX_POOL: string; CVGCVX_CONTRACT: string },
  swapAmount: bigint,
  mintAmount: bigint,
  slippageBps: number,
  inputIsCvx: boolean
): Promise<EnsoBundleResponse> {
  const totalSlippageBps = getBufferedSlippageBps(slippageBps);
  // Calculate min_dy for swap path (using exact swap amount)
  const expectedSwapOutput = await getCurveGetDy(
    TANGENT.CVX1_CVGCVX_POOL,
    0, 1, swapAmount.toString()
  );
  const minSwapDy = expectedSwapOutput
    ? calculateMinDy(expectedSwapOutput, totalSlippageBps)
    : "0";

  if (inputIsCvx) {
    // Input is already CVX - use literal amounts directly (no route to split)
    // Total expected cvgCVX = swap output + mint amount (1:1)
    const totalExpectedCvgCvx = (expectedSwapOutput ?? swapAmount) + mintAmount;

    // NOTE: CVX input hybrid bundles require skipQuote: true because Enso's
    // simulator only pulls tokens for the FIRST action that consumes each token type.
    // Since we need CVX for both swap path (CVX → CVX1) and mint path (CVX → cvgCVX),
    // the simulator fails with "ERC20: transfer amount exceeds balance".
    // We've exhaustively tested alternatives (transferfrom, split, wrap-all-then-unwrap,
    // balance action, delegate routing) - all fail. skipQuote is the only working solution.

    const actions: EnsoBundleAction[] = [
      // === SWAP PATH ===

      // Action 0: Approve swapAmount CVX → CVX1
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: swapAmount.toString() },
      },
      // Action 1: Wrap swapAmount CVX → CVX1 (mint to ENSO_SHORTCUTS for Curve call)
      // CVX1 must go to ENSO_SHORTCUTS because Curve.exchange does transferFrom(msg.sender, ...)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "mint",
          abi: "function mint(address to, uint256 amount)",
          args: [ENSO_SHORTCUTS, swapAmount.toString()],
        },
      },
      // Action 2: Approve CVX1 → Curve pool
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVX1, spender: TANGENT.CVX1_CVGCVX_POOL, amount: swapAmount.toString() },
      },
      // Action 3: Swap CVX1 → cvgCVX via Curve
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVX1_CVGCVX_POOL,
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          args: [0, 1, swapAmount.toString(), minSwapDy],
        },
      },

      // === MINT PATH ===

      // Action 4: Approve mintAmount CVX → cvgCVX contract
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVX, spender: TANGENT.CVGCVX_CONTRACT, amount: mintAmount.toString() },
      },
      // Action 5: Mint cvgCVX from CVX (1:1, isLock=true, mint to router)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVGCVX_CONTRACT,
          method: "mint",
          abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
          args: [ENSO_ROUTER_EXECUTOR, mintAmount.toString(), true],
        },
      },

      // === DEPOSIT ALL cvgCVX TO VAULT ===

      // Action 6: Approve all cvgCVX → vault
      {
        protocol: "erc20",
        action: "approve",
        args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: totalExpectedCvgCvx.toString() },
      },
      // Action 7: Deposit all cvgCVX → vault
      {
        protocol: "erc4626",
        action: "deposit",
        args: {
          tokenIn: TOKENS.CVGCVX,
          tokenOut: params.vaultAddress,
          amountIn: totalExpectedCvgCvx.toString(),
          primaryAddress: params.vaultAddress,
        },
      },
    ];

    // Use skipQuote to bypass Enso simulation (which fails for multi-consumption CVX bundles)
    //
    // NOTE: We intentionally do NOT self-simulate CVX hybrid bundles because:
    // 1. The bundle uses multiple intermediate tokens (CVX → CVX1 → cvgCVX via Curve)
    // 2. CVX1 uses non-standard storage slots (51 for balances, 52 for approvals)
    // 3. State overrides for multiple tokens in a complex bundle execution context
    //    don't work reliably with eth_call - the Curve exchange fails even with
    //    correct slot overrides due to internal state tracking differences.
    // 4. skipQuote=true has been verified to work correctly on-chain.
    const bundleResult = await fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "router",
      skipQuote: true,
    });

    // Manually provide expected amountsOut since skipQuote returns null
    bundleResult.amountsOut = {
      [params.vaultAddress.toLowerCase()]: totalExpectedCvgCvx.toString(),
      [TOKENS.CVGCVX.toLowerCase()]: totalExpectedCvgCvx.toString(),
    };

    return bundleResult;
  }

  // Non-CVX hybrid bundles are not supported due to Enso's shortcut builder
  // validating combined route inputs. The caller should fall back to swap-only
  // or mint-only paths for non-CVX inputs.
  throw new Error("Hybrid bundle is only supported for CVX inputs");
}

/**
 * Build TRUE HYBRID bundle for ETH → cvgCVX using fee action split
 *
 * Uses the Enso "fee" action to split CVX between swap and mint paths.
 * The fee action takes a percentage and sends it to a receiver, returning
 * the remainder as its output.
 *
 * Flow:
 * 1. Route ETH → CVX (via Enso's DEX aggregator for best price)
 * 2. Fee action splits CVX: feeBps% to router (mint path), rest returned (swap path)
 * 3. Swap path: CVX → CVX1 → cvgCVX (Curve swap, above peg)
 * 4. Mint path: CVX → cvgCVX (1:1 direct mint)
 * 5. Combine all cvgCVX and deposit to vault
 *
 * Key insights:
 * - Fee action output is the REMAINDER after fee (swap path portion)
 * - Balance action gets the fee'd portion (mint path) from router
 * - CVX1.mint() has no return value - use fee output ref for CVX1 amounts
 * - All useOutputOfCallAt references chain properly with skipQuote
 */
async function buildEthHybridBundle(
  params: { fromAddress: string; vaultAddress: string; amountIn: string; slippage?: string },
  TANGENT: { CVX1_CVGCVX_POOL: string; CVGCVX_CONTRACT: string; CVX_ETH_POOL: string },
  swapAmount: bigint,
  mintAmount: bigint,
  slippageBps: number,
  _expectedCvxOutput: string // Kept for API consistency; function calculates its own estimates
): Promise<EnsoBundleResponse> {
  // Calculate fee basis points to split CVX (fee = mint portion, remainder = swap portion)
  // feeBps = (mintAmount / totalCVX) * 10000
  const totalCvx = swapAmount + mintAmount;
  const feeBps = totalCvx > 0n
    ? Number((mintAmount * 10000n) / totalCvx)
    : 5000; // Default 50/50 if no split calculated

  // Calculate expected outputs for slippage protection
  const expectedSwapCvgCvx = await getCurveGetDy(
    TANGENT.CVX1_CVGCVX_POOL,
    0, 1, swapAmount.toString()
  );
  const minSwapDy = expectedSwapCvgCvx
    ? calculateMinDy(expectedSwapCvgCvx, slippageBps)
    : "0";

  // Total expected cvgCVX = swap output + mint output (1:1)
  const totalExpectedCvgCvx = (expectedSwapCvgCvx ?? swapAmount) + mintAmount;

  const actions: EnsoBundleAction[] = [
    // === STEP 1: Route ETH → CVX ===
    // Action 0: Route (output: total CVX amount)
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: ETH_ADDRESS,
        tokenOut: TOKENS.CVX,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      },
    },

    // === STEP 2: Split CVX using fee action ===
    // Action 1: Fee takes mintAmount% to router, returns swapAmount% as output
    {
      protocol: "enso",
      action: "fee",
      args: {
        token: TOKENS.CVX,
        bps: feeBps,
        receiver: ENSO_ROUTER_EXECUTOR, // Mint path CVX stays here
        amount: { useOutputOfCallAt: 0 },
      },
    },

    // === SWAP PATH (uses fee output = swap portion) ===
    // Action 2: Approve CVX → CVX1
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: { useOutputOfCallAt: 1 } },
    },
    // Action 3: Mint CVX → CVX1 (mint to ENSO_SHORTCUTS for Curve call)
    // Note: CVX1.mint() has no return value
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "mint",
        abi: "function mint(address to, uint256 amount)",
        args: [ENSO_SHORTCUTS, { useOutputOfCallAt: 1 }],
      },
    },
    // Action 4: Approve CVX1 → Curve pool (CVX1 is 1:1 with CVX)
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX1, spender: TANGENT.CVX1_CVGCVX_POOL, amount: { useOutputOfCallAt: 1 } },
    },
    // Action 5: Swap CVX1 → cvgCVX via Curve
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [0, 1, { useOutputOfCallAt: 1 }, minSwapDy],
      },
    },

    // === MINT PATH (uses balance of remaining CVX on router) ===
    // Action 6: Get CVX balance (the fee'd portion for mint path)
    {
      protocol: "enso",
      action: "balance",
      args: { token: TOKENS.CVX },
    },
    // Action 7: Approve CVX → cvgCVX contract
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TANGENT.CVGCVX_CONTRACT, amount: { useOutputOfCallAt: 6 } },
    },
    // Action 8: Mint CVX → cvgCVX (1:1, isLock=true for no fees)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVGCVX_CONTRACT,
        method: "mint",
        abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
        args: [ENSO_ROUTER_EXECUTOR, { useOutputOfCallAt: 6 }, true],
      },
    },

    // === DEPOSIT ALL cvgCVX TO VAULT ===
    // Action 9: Get total cvgCVX balance (from both paths)
    {
      protocol: "enso",
      action: "balance",
      args: { token: TOKENS.CVGCVX },
    },
    // Action 10: Approve cvgCVX → vault
    {
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVGCVX, spender: params.vaultAddress, amount: { useOutputOfCallAt: 9 } },
    },
    // Action 11: Deposit cvgCVX → vault
    {
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: TOKENS.CVGCVX,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 9 },
        primaryAddress: params.vaultAddress,
      },
    },
  ];

  // Use router strategy with skipQuote to bypass simulation
  // (skipQuote is required for fee action and complex output chaining)
  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: true,
  });

  // Manually provide expected amountsOut since skipQuote returns null
  bundleResult.amountsOut = {
    [params.vaultAddress.toLowerCase()]: totalExpectedCvgCvx.toString(),
    [TOKENS.CVGCVX.toLowerCase()]: totalExpectedCvgCvx.toString(),
  };

  return bundleResult;
}

/**
 * Create a custom Zap Out route for cvgCVX via Tangent infrastructure
 * Route: vault (redeem) → cvgCVX → CVX1 (Curve swap) → CVX (unwrap) → output token
 * When outputToken=CVX: vault → cvgCVX → CVX1 → CVX (skips final route)
 *
 * Uses delegate routing strategy because:
 * - CVX1.withdraw has no return value, so standard router can't track token flow
 * - Delegate executes via delegateCalls from user's context, keeping tokens with user
 *
 * Action sequence with indices:
 *   0: redeem (vault → cvgCVX)
 *   1: approve (cvgCVX → Curve pool)
 *   2: call (Curve exchange cvgCVX → CVX1) ← returns CVX1 amount
 *   3: call (CVX1.withdraw → CVX)
 *   4: route (CVX → output token) [skipped if output is CVX]
 */
export async function fetchCvgCvxZapOutRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<EnsoBundleResponse> {
  const { TANGENT } = await import("@/config/vaults");
  const slippageBps = parseInt(params.slippage ?? "100", 10);
  const amountIn = await clampAmountIn(params.vaultAddress, params.amountIn);

  // Check if output is already CVX - skip final route step
  const outputIsCvx = params.outputToken.toLowerCase() === TOKENS.CVX.toLowerCase();
  const outputIsEth = params.outputToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
  console.log("[cvgCVX ZapOut] outputToken:", params.outputToken, "ETH_ADDRESS:", ETH_ADDRESS, "outputIsEth:", outputIsEth);

  // Step 1: Estimate cvgCVX output from vault redeem
  // For ERC4626, redeem returns assets = shares * pricePerShare
  // Query convertToAssets to get expected output
  const convertToAssetsSelector = "0x07a2d13a"; // convertToAssets(uint256)
  const convertData = convertToAssetsSelector +
    BigInt(amountIn).toString(16).padStart(64, "0");

  let expectedCvgCvxOutput: string;
  try {
    const result = await rpcWithFallback<{ result?: string }>({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: params.vaultAddress, data: convertData }, "latest"],
    });
    expectedCvgCvxOutput = result.result && result.result !== "0x"
      ? BigInt(result.result).toString()
      : amountIn; // Fallback to 1:1
  } catch {
    expectedCvgCvxOutput = amountIn; // Fallback to 1:1
  }

  // Step 2: Query Curve pool get_dy to estimate CVX1 output
  // get_dy(1, 0, cvgcvx_amount) - cvgCVX (index 1) to CVX1 (index 0)
  const expectedCvx1Output = await getCurveGetDy(
    TANGENT.CVX1_CVGCVX_POOL,
    1, // cvgCVX index
    0, // CVX1 index
    expectedCvgCvxOutput
  );

  // Step 3: Calculate min_dy with slippage (fallback to 0 if get_dy fails)
  const minDy = expectedCvx1Output
    ? calculateMinDy(expectedCvx1Output, slippageBps)
    : "0";

  if (outputIsCvx) {
    // Output is CVX - skip the final route step
    const actions: EnsoBundleAction[] = [
      // Action 0: Redeem from vault to get cvgCVX
      {
        protocol: "erc4626",
        action: "redeem",
        args: {
          tokenIn: params.vaultAddress,
          tokenOut: TOKENS.CVGCVX,
          amountIn,
          primaryAddress: params.vaultAddress,
        },
      },
      // Action 1: Approve cvgCVX to Curve pool for exchange
      {
        protocol: "erc20",
        action: "approve",
        args: {
          token: TOKENS.CVGCVX,
          spender: TANGENT.CVX1_CVGCVX_POOL,
          amount: { useOutputOfCallAt: 0 },
        },
      },
      // Action 2: Exchange cvgCVX → CVX1 via Curve pool
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVX1_CVGCVX_POOL,
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          args: [
            "1", // i = 1 (cvgCVX)
            "0", // j = 0 (CVX1)
            { useOutputOfCallAt: 0 },
            minDy,
          ],
        },
      },
      // Action 3: Unwrap CVX1 → CVX (final output)
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1,
          method: "withdraw",
          abi: "function withdraw(uint256 amount, address to)",
          args: [{ useOutputOfCallAt: 2 }, params.fromAddress],
        },
      },
    ];

    const bundleResult = await fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "router",
      skipQuote: process.env.ENSO_SKIP_ROUTE_QUOTE === "true",
    });

    // Enso can't track CVX1.withdraw output (void function), so populate
    // amountsOut ourselves from the Curve get_dy estimate (CVX1 → CVX is 1:1).
    const cvxKey = TOKENS.CVX.toLowerCase();
    if (expectedCvx1Output && !bundleResult.amountsOut[cvxKey]) {
      bundleResult.amountsOut = {
        ...bundleResult.amountsOut,
        [cvxKey]: expectedCvx1Output.toString(),
      };
    }

    return bundleResult;
  }

  // Standard path: route CVX → output token (works for ETH, USDC, etc.)
  const actions: EnsoBundleAction[] = [
    // Action 0: Redeem from vault to get cvgCVX
    {
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: params.vaultAddress,
        tokenOut: TOKENS.CVGCVX,
        amountIn,
        primaryAddress: params.vaultAddress,
      },
    },
    // Action 1: Approve cvgCVX to Curve pool for exchange
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVGCVX,
        spender: TANGENT.CVX1_CVGCVX_POOL,
        amount: { useOutputOfCallAt: 0 },
      },
    },
    // Action 2: Exchange cvgCVX → CVX1 via Curve pool
    // exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)
    // i=1 (cvgCVX), j=0 (CVX1) - opposite direction from zap in
    // min_dy calculated from get_dy with slippage protection
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [1, 0, { useOutputOfCallAt: 0 }, minDy],
      },
    },
  ];

  // CVX1.withdraw() is void — can't chain output to route action.
  // Use routeMulti([], innerSwapData) pattern: pre-fetch a standalone CVX→output route,
  // extract its weiroll data, then execute it with CVX already in ENSO_SHORTCUTS.
  // Security: CVX is TRANSFERRED to ENSO_SHORTCUTS (not approved), consumed atomically
  // in the same tx via routeMulti. No persistent approvals for ENSO_SHORTCUTS.
  if (!expectedCvx1Output) {
    throw new Error("Cannot estimate CVX1 output for cvgCVX zap out");
  }

  // Pre-fetch standalone route for CVX → output token
  // routeMulti sends output to fromAddress (user), so route directly to final token
  // (no WETH unwrap needed — Enso handles ETH output natively in standalone routes)
  const { extractInnerSwapData } = await import("@/lib/zapper");
  const standaloneRoute = await fetchRoute({
    fromAddress: params.fromAddress,
    tokenIn: TOKENS.CVX,
    tokenOut: params.outputToken,
    amountIn: expectedCvx1Output.toString(),
    slippage: params.slippage ?? "100",
  });
  const innerSwapData = extractInnerSwapData(standaloneRoute.tx.data);

  actions.push(
    // Action 3: Unwrap CVX1 → CVX via CVX1.withdraw (void, sends CVX to ENSO_SHORTCUTS)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "withdraw",
        abi: "function withdraw(uint256 amount, address to)",
        args: [{ useOutputOfCallAt: 2 }, ENSO_SHORTCUTS],
      },
    },
    // Action 4: Execute pre-built swap via routeMulti (CVX already in ENSO_SHORTCUTS)
    // Output goes to params.fromAddress (user) — verified by routeMulti output behavior
    {
      protocol: "enso",
      action: "call",
      args: {
        address: ENSO_ROUTER_EXECUTOR.toLowerCase(),
        method: "routeMulti",
        abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)",
        args: [[], innerSwapData],
      },
    },
  );

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    // Skip quote to avoid simulation failure (intermediate tokens not in user wallet)
    // Route planning still works because we provide a concrete amount
    skipQuote: true,
  });

  // Manually calculate expected output since skipQuote may not return the final output token
  // Use expectedCvx1Output (CVX1 → CVX is 1:1) or fall back to expectedCvgCvxOutput
  const estimatedCvxAmount = expectedCvx1Output?.toString() ?? expectedCvgCvxOutput;
  const outputTokenKey = params.outputToken.toLowerCase();
  const hasOutputAmount = bundleResult.amountsOut[outputTokenKey] || bundleResult.amountsOut[ETH_ADDRESS.toLowerCase()];

  if (estimatedCvxAmount && !hasOutputAmount) {
    try {
      // For ETH output: use Curve CVX/ETH pool estimate (fast, no API call)
      if (outputTokenKey === ETH_ADDRESS.toLowerCase() || outputTokenKey === WETH_ADDRESS.toLowerCase()) {
        const expectedEthOutput = await estimateCryptoSwapOffchain(
          CURVE_CVX_ETH_POOL,
          1, // CVX index
          0, // WETH index (ETH)
          estimatedCvxAmount
        );
        if (expectedEthOutput) {
          bundleResult.amountsOut = {
            [outputTokenKey]: expectedEthOutput.toString(),
            [ETH_ADDRESS.toLowerCase()]: expectedEthOutput.toString(),
          };
        }
      } else {
        // For other tokens (USDC, etc.): query Enso route for CVX → output token
        // This gives us proper output amount with correct decimals
        const routeQuote = await fetchRoute({
          fromAddress: params.fromAddress,
          tokenIn: TOKENS.CVX,
          tokenOut: params.outputToken,
          amountIn: estimatedCvxAmount,
          slippage: params.slippage ?? "100",
        });
        if (routeQuote.amountOut) {
          bundleResult.amountsOut = {
            [outputTokenKey]: routeQuote.amountOut,
          };
        }
      }
    } catch (err) {
      console.error("[Enso cvgCVX ZapOut] estimate error:", err);
      // Fallback: no estimate available
    }
  }

  return bundleResult;
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
  const { PIREX } = await import("@/config/vaults");

  // Validate slippage parameter
  const slippageBps = validateSlippage(params.slippage);

  const amountIn = await clampAmountIn(params.vaultAddress, params.amountIn);

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
  }

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
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
 * - If Curve pool rate > 1:1: swap CVX → lpxCVX → unwrap → pxCVX
 * - If rate < 1:1: deposit CVX to Pirex for 1:1 pxCVX
 * - Optimal: split between swap and mint at peg point
 *
 * NOTE: lpxCVX.unwrap() and PirexCVX.deposit() don't return values,
 * so we calculate expected pxCVX amounts upfront for the vault deposit.
 */
export async function fetchPxCvxZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  inputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
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
      try {
        const routeEstimate = await fetchRoute({
          fromAddress: params.fromAddress,
          tokenIn: params.inputToken,
          tokenOut: TOKENS.CVX,
          amountIn: params.amountIn,
          slippage: params.slippage ?? "100",
        });
        estimatedCvxAmount = routeEstimate.amountOut || params.amountIn;

        // Rate limit: Enso API allows 1 request/second
        // Wait before the next API call (fetchBundle)
        await new Promise(resolve => setTimeout(resolve, 1100));
      } catch {
        // Fallback: assume 1:1 for estimation
        estimatedCvxAmount = params.amountIn;
      }
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
  // - Swap path: CVX → lpxCVX (via Curve) → pxCVX (1:1 unwrap)
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
  const totalExpectedPxCvx = expectedSwapPxCvx + expectedMintPxCvx;

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

    // Action: Approve CVX to Curve pool for swap portion
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: swapAmount.toString(),
      },
    });
    actionIndex++;

    // Action: Swap CVX → lpxCVX via Curve pool
    // exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy)
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX_CVX_POOL,
        method: "exchange",
        abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
        args: [
          String(PIREX.POOL_INDEX.CVX), // i = 0 (CVX)
          String(PIREX.POOL_INDEX.LPXCVX), // j = 1 (lpxCVX)
          swapAmount.toString(), // dx
          swapMinDy, // min_dy with slippage protection
        ],
      },
    });
    const swapIdx = actionIndex++;

    // Action: Approve lpxCVX to itself for unwrap
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: swapIdx },
      },
    });
    actionIndex++;

    // Action: Unwrap lpxCVX → pxCVX
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "unwrap",
        abi: "function unwrap(uint256 amount)",
        args: [{ useOutputOfCallAt: swapIdx }],
      },
    });
    actionIndex++;

    // Action: Approve CVX to Pirex for mint portion
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.PIREX_CVX,
        amount: mintAmount.toString(),
      },
    });
    actionIndex++;

    // Action: Deposit CVX to Pirex → pxCVX (mint to router for subsequent vault deposit)
    // deposit(uint256 assets, address receiver, bool shouldCompound, address developer)
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.PIREX_CVX,
        method: "deposit",
        abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
        args: [
          mintAmount.toString(),
          ENSO_ROUTER_EXECUTOR, // Send to router so it can deposit into vault
          "false", // shouldCompound (boolean as string for Enso API)
          "0x0000000000000000000000000000000000000000", // developer
        ],
      },
    });
    actionIndex++;

  } else if (swapAmount > 0n) {
    // Swap-only strategy: rate > 1:1 for full amount

    // Action: Approve CVX to Curve pool
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: inputIsCvx ? params.amountIn : { useOutputOfCallAt: actionIndex - 1 },
      },
    });
    actionIndex++;

    // Action: Swap CVX → lpxCVX via Curve pool
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
          inputIsCvx ? params.amountIn : { useOutputOfCallAt: actionIndex - 2 },
          swapMinDy, // Use calculated min_dy for MEV protection
        ],
      },
    });
    const swapIdx = actionIndex++;

    // Action: Approve lpxCVX for unwrap
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: swapIdx },
      },
    });
    actionIndex++;

    // Action: Unwrap lpxCVX → pxCVX
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "unwrap",
        abi: "function unwrap(uint256 amount)",
        args: [{ useOutputOfCallAt: swapIdx }],
      },
    });
    actionIndex++;

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

    // Action: Deposit CVX to Pirex → pxCVX (mint to router for subsequent vault deposit)
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.PIREX_CVX,
        method: "deposit",
        abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
        args: [
          inputIsCvx ? params.amountIn : { useOutputOfCallAt: actionIndex - 2 },
          ENSO_ROUTER_EXECUTOR, // Send to router so it can deposit into vault
          "false", // shouldCompound (boolean as string for Enso API)
          "0x0000000000000000000000000000000000000000",
        ],
      },
    });
    actionIndex++;
  }

  // Action: Get actual pxCVX balance in router to avoid pre-funding
  // lpxCVX.unwrap() and PirexCVX.deposit() don't return values, so we read balance.
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
    // For pxCVX swap: CVX → lpxCVX (via Curve), lpxCVX unwraps 1:1 to pxCVX
    // So bonus is lpxCVX output / CVX input
    swapBonus = (Number(expectedSwapPxCvx) / Number(swapAmount) - 1) * 100;
    // Bonus amount = pxCVX received - CVX input (what you gain vs 1:1 mint)
    const bonusAmountWei = expectedSwapPxCvx - swapAmount;
    bonusAmount = (Number(bonusAmountWei) / 1e18).toFixed(4);
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
    cvxAmount: formatWei(estimatedCvxAmount),
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
    {
      protocol: "enso",
      action: "call",
      args: {
        address: LLAMA_AIRFORCE.UCRV,
        method: "withdraw",
        abi: "function withdraw(address _to, uint256 _shares) returns (uint256)",
        args: [
          ENSO_SHORTCUTS, // cvxCRV goes to Enso Shortcuts for downstream actions
          params.amountIn,
        ],
      },
    },
  ];

  const targetIsCvgCvx = targetUnderlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
  let expectedCvgCvxTotal = 0n;
  let expectedIntermediateCvx = 0n;
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
  } else if (targetIsCvgCvx) {
    // cvxCRV → CVX (Enso) → cvgCVX hybrid (Curve + Convex) → deposit
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: LLAMA_AIRFORCE.UCRV_UNDERLYING,
        tokenOut: TOKENS.CVX,
        amountIn: { useOutputOfCallAt: 0 },
        slippage: params.slippage ?? "100",
      },
    });
    let cvxEstimate: bigint;
    try {
      const rq = await fetchRoute({
        fromAddress: params.fromAddress,
        tokenIn: LLAMA_AIRFORCE.UCRV_UNDERLYING,
        tokenOut: TOKENS.CVX,
        amountIn: expectedCvxCrvOutput,
        slippage: params.slippage ?? "100",
      });
      cvxEstimate = BigInt(rq.amountOut);
    } catch {
      cvxEstimate = BigInt(expectedCvxCrvOutput);
    }
    expectedIntermediateCvx = cvxEstimate;
    const { actions: cvgCvxActions, expectedCvgCvx } = await buildCvxToCvgCvxDepositActions({
      expectedCvxAmount: cvxEstimate,
      targetVault: params.vaultAddress,
      slippageBps,
    });
    const baseIdx = actions.length;
    actions.push(...cvgCvxActions);
    rebaseCvgCvxHybridRef(actions, baseIdx);
    expectedCvgCvxTotal = expectedCvgCvx;
  } else {
    expectedTargetUnderlyingOutput = await estimateRouteOutputOrFallback(
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
    skipQuote: targetIsCvgCvx,
  });

  if (targetIsCvgCvx && expectedCvgCvxTotal > 0n) {
    let expectedShares = expectedCvgCvxTotal.toString();
    try {
      const selector = "0xef8b30f7"; // previewDeposit(uint256)
      const data = selector + expectedCvgCvxTotal.toString(16).padStart(64, "0");
      const res = await rpcWithFallback<{ result?: string }>({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: params.vaultAddress, data }, "latest"],
      });
      if (res.result && res.result !== "0x") {
        expectedShares = BigInt(res.result).toString();
      }
    } catch { /* fall back */ }
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [params.vaultAddress.toLowerCase()]: expectedShares,
      [TOKENS.CVGCVX.toLowerCase()]: expectedCvgCvxTotal.toString(),
    };
  }

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
  } else if (targetIsCvgCvx) {
    const cvgCvxFmt = formatRouteAmount(expectedCvgCvxTotal, TOKENS.CVGCVX);
    steps.push({ tokenSymbol: "cvxCRV", amount: conservativeCvxCrv, action: "Swap", description: "cvxCRV for CVX", protocol: "Enso" });
    steps.push({ tokenSymbol: "CVX", amount: formatRouteAmount(expectedIntermediateCvx, TOKENS.CVX), action: "Swap + Mint", description: "CVX to cvgCVX — Curve pool + Convex mint", protocol: "Curve+Convex" });
    steps.push({ tokenSymbol: "cvgCVX", amount: cvgCvxFmt, action: "Deposit", description: `cvgCVX into ${vaultSymbol}`, protocol: "yld" });
  } else {
    steps.push({ tokenSymbol: "cvxCRV", amount: conservativeCvxCrv, action: "Swap", description: `cvxCRV for ${targetUnderlyingSymbol}`, protocol: "Enso" });
    steps.push({ tokenSymbol: targetUnderlyingSymbol, amount: formatRouteAmount(expectedTargetUnderlyingOutput, targetUnderlying), action: "Deposit", description: `${targetUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
  }

  steps.push({ tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" });

  const routeInfo: RouteInfo = {
    steps,
    tokens: targetIsCvxCrv
      ? ["uCRV", "cvxCRV", vaultSymbol]
      : targetIsCvgCvx
      ? ["uCRV", "cvxCRV", "CVX", "cvgCVX", vaultSymbol]
      : ["uCRV", "cvxCRV", targetUnderlyingSymbol, vaultSymbol],
    protocols: targetIsCvxCrv
      ? ["Llama Airforce", "yld"]
      : targetIsCvgCvx
      ? ["Llama Airforce", "Enso", "Curve+Convex", "yld"]
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

  // Populated when the target underlying is cvgCVX, so we can set amountsOut
  // after fetchBundle (skipQuote=true returns no output estimate).
  let expectedCvgCvxTotal = 0n;
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

    // Branch on target underlying — CVX has no liquid Enso route to cvgCVX or
    // pxCVX so we have to mint/wrap directly. cvxCRV/crvUSD/others go via Enso.
    const targetIsCvx = targetUnderlying.toLowerCase() === TOKENS.CVX.toLowerCase();
    const targetIsCvgCvx = targetUnderlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();

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
    } else if (targetIsCvgCvx) {
      // CVX → cvgCVX hybrid (Curve swap + Convex 1:1 mint). Enso can't route
      // CVX to cvgCVX directly. Uses literal amounts with skipQuote=true.
      const { actions: cvgCvxActions, expectedCvgCvx: cvgCvxTotal } =
        await buildCvxToCvgCvxDepositActions({
          expectedCvxAmount: expectedCvxOutput,
          targetVault: params.vaultAddress,
          slippageBps,
        });
      const baseIdx = actions.length;
      actions.push(...cvgCvxActions);
      rebaseCvgCvxHybridRef(actions, baseIdx);
      // Stash expected output for amountsOut population below
      expectedCvgCvxTotal = cvgCvxTotal;
    } else {
      expectedTargetUnderlyingOutput = await estimateRouteOutputOrFallback(
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

  const needsSkipQuote =
    targetUnderlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: needsSkipQuote,
  });

  // skipQuote returns no amountsOut — compute expected vault shares via
  // previewDeposit so the UI has a number to display.
  if (needsSkipQuote && expectedCvgCvxTotal > 0n) {
    let expectedShares = expectedCvgCvxTotal.toString();
    try {
      const previewDepositSelector = "0xef8b30f7"; // previewDeposit(uint256)
      const previewData =
        previewDepositSelector + expectedCvgCvxTotal.toString(16).padStart(64, "0");
      const previewResult = await rpcWithFallback<{ result?: string }>({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: params.vaultAddress, data: previewData }, "latest"],
      });
      if (previewResult.result && previewResult.result !== "0x") {
        expectedShares = BigInt(previewResult.result).toString();
      }
    } catch {
      // fall back to raw cvgCVX amount
    }
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [params.vaultAddress.toLowerCase()]: expectedShares,
      [TOKENS.CVGCVX.toLowerCase()]: expectedCvgCvxTotal.toString(),
    };
  }

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
    const targetIsCvgCvx = targetUnderlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
    if (targetIsCvx) {
      steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Deposit", description: `CVX into ${vaultSymbol}`, protocol: "yld" });
    } else if (targetIsCvgCvx) {
      const cvgCvxAmountFmt = (Number(expectedCvgCvxTotal) / 1e18).toFixed(4);
      steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Swap + Mint", description: "CVX to cvgCVX — Curve pool + Convex mint", protocol: "Curve+Convex" });
      steps.push({ tokenSymbol: "cvgCVX", amount: cvgCvxAmountFmt, action: "Deposit", description: `cvgCVX into ${vaultSymbol}`, protocol: "yld" });
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
    const targetIsCvgCvx = targetUnderlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
    if (targetIsCvx) {
      tokens = ["uCVX", "pxCVX", "CVX", vaultSymbol];
      protocols = ["Llama Airforce", "Curve", "yld"];
    } else if (targetIsCvgCvx) {
      tokens = ["uCVX", "pxCVX", "CVX", "cvgCVX", vaultSymbol];
      protocols = ["Llama Airforce", "Curve", "Convex", "yld"];
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

  const targetIsCvgCvx = targetUnderlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
  const externalIsCvx =
    params.externalVaultUnderlying.toLowerCase() === TOKENS.CVX.toLowerCase();
  let expectedCvgCvxTotal = 0n;
  let expectedIntermediateCvx = 0n;
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
  } else if (targetIsCvgCvx) {
    // Target = cvgCVX; Enso has no CVX→cvgCVX route. If external underlying
    // is CVX we go straight to hybrid; otherwise route to CVX first.
    let cvxInputAmountRef: string | { useOutputOfCallAt: number };
    let cvxEstimate: bigint;
    if (externalIsCvx) {
      cvxInputAmountRef = { useOutputOfCallAt: 0 };
      cvxEstimate = BigInt(expectedUnderlyingOutput);
    } else {
      // Route external underlying → CVX via Enso (cvxCRV handled here)
      actions.push({
        protocol: "enso",
        action: "route",
        args: {
          tokenIn: params.externalVaultUnderlying,
          tokenOut: TOKENS.CVX,
          amountIn: { useOutputOfCallAt: 0 },
          slippage: params.slippage ?? "100",
        },
      });
      cvxInputAmountRef = { useOutputOfCallAt: 1 };
      // Rough estimate: assume Enso gives market price — use previewed underlying
      try {
        const routeQuote = await fetchRoute({
          fromAddress: params.fromAddress,
          tokenIn: params.externalVaultUnderlying,
          tokenOut: TOKENS.CVX,
          amountIn: expectedUnderlyingOutput,
          slippage: params.slippage ?? "100",
        });
        cvxEstimate = BigInt(routeQuote.amountOut);
      } catch {
        cvxEstimate = BigInt(expectedUnderlyingOutput);
      }
    }
    expectedIntermediateCvx = cvxEstimate;
    // Unused amountRef suppressed — hybrid helper uses literal amounts
    void cvxInputAmountRef;
    const { actions: cvgCvxActions, expectedCvgCvx } = await buildCvxToCvgCvxDepositActions({
      expectedCvxAmount: cvxEstimate,
      targetVault: params.vaultAddress,
      slippageBps,
    });
    const baseIdx = actions.length;
    actions.push(...cvgCvxActions);
    rebaseCvgCvxHybridRef(actions, baseIdx);
    expectedCvgCvxTotal = expectedCvgCvx;
  } else {
    expectedTargetUnderlyingOutput = await estimateRouteOutputOrFallback(
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
    skipQuote: targetIsCvgCvx,
  });

  if (targetIsCvgCvx && expectedCvgCvxTotal > 0n) {
    let expectedShares = expectedCvgCvxTotal.toString();
    try {
      const selector = "0xef8b30f7"; // previewDeposit(uint256)
      const data = selector + expectedCvgCvxTotal.toString(16).padStart(64, "0");
      const res = await rpcWithFallback<{ result?: string }>({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: params.vaultAddress, data }, "latest"],
      });
      if (res.result && res.result !== "0x") {
        expectedShares = BigInt(res.result).toString();
      }
    } catch { /* fall back */ }
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [params.vaultAddress.toLowerCase()]: expectedShares,
      [TOKENS.CVGCVX.toLowerCase()]: expectedCvgCvxTotal.toString(),
    };
  }

  // Build routeInfo
  const externalUnderlyingSymbol = getTokenSymbol(params.externalVaultUnderlying);
  const targetUnderlyingSymbol = getTokenSymbol(targetUnderlying);
  const externalUnderlyingFmt = (Number(expectedUnderlyingOutput) / 1e18).toFixed(4);
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
  } else if (targetIsCvgCvx) {
    const cvgCvxFmt = formatRouteAmount(expectedCvgCvxTotal, TOKENS.CVGCVX);
    if (!externalIsCvx) {
      steps.push({ tokenSymbol: externalUnderlyingSymbol, amount: externalUnderlyingFmt, action: "Swap", description: `${externalUnderlyingSymbol} for CVX`, protocol: "Enso" });
    }
    steps.push({ tokenSymbol: "CVX", amount: formatRouteAmount(expectedIntermediateCvx, TOKENS.CVX), action: "Swap + Mint", description: "CVX to cvgCVX — Curve pool + Convex mint", protocol: "Curve+Convex" });
    steps.push({ tokenSymbol: "cvgCVX", amount: cvgCvxFmt, action: "Deposit", description: `cvgCVX into ${vaultSymbol}`, protocol: "yld" });
  } else {
    steps.push({ tokenSymbol: externalUnderlyingSymbol, amount: externalUnderlyingFmt, action: "Swap", description: `${externalUnderlyingSymbol} for ${targetUnderlyingSymbol}`, protocol: "Enso" });
    steps.push({ tokenSymbol: targetUnderlyingSymbol, amount: formatRouteAmount(expectedTargetUnderlyingOutput, targetUnderlying), action: "Deposit", description: `${targetUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
  }

  steps.push({ tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" });

  const routeInfo: RouteInfo = {
    steps,
    tokens: sameUnderlying
      ? [params.externalVaultSymbol, externalUnderlyingSymbol, vaultSymbol]
      : targetIsCvgCvx
      ? externalIsCvx
        ? [params.externalVaultSymbol, "CVX", "cvgCVX", vaultSymbol]
        : [params.externalVaultSymbol, externalUnderlyingSymbol, "CVX", "cvgCVX", vaultSymbol]
      : [params.externalVaultSymbol, externalUnderlyingSymbol, targetUnderlyingSymbol, vaultSymbol],
    protocols: sameUnderlying
      ? [params.externalVaultProtocol, "yld"]
      : targetIsCvgCvx
      ? externalIsCvx
        ? [params.externalVaultProtocol, "Curve+Convex", "yld"]
        : [params.externalVaultProtocol, "Enso", "Curve+Convex", "yld"]
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
    {
      protocol: "enso",
      action: "call",
      args: {
        address: params.beefyVaultAddress,
        method: "withdraw",
        abi: "function withdraw(uint256 _shares)",
        args: [params.amountIn],
      },
    },
    // Action 1: Get balance of underlying (withdraw doesn't return amount)
    {
      protocol: "enso",
      action: "balance",
      args: {
        token: params.beefyVaultUnderlying,
      },
    },
  ];

  const targetIsCvgCvx = targetUnderlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
  const beefyIsCvx = params.beefyVaultUnderlying.toLowerCase() === TOKENS.CVX.toLowerCase();
  let expectedCvgCvxTotal = 0n;
  let expectedIntermediateCvx = 0n;
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
  } else if (targetIsCvgCvx) {
    // cvgCVX has no Enso route — route to CVX first (if needed), then hybrid
    let cvxEstimate: bigint;
    if (!beefyIsCvx) {
      actions.push({
        protocol: "enso",
        action: "route",
        args: {
          tokenIn: params.beefyVaultUnderlying,
          tokenOut: TOKENS.CVX,
          amountIn: { useOutputOfCallAt: 1 },
          slippage: params.slippage ?? "100",
        },
      });
      try {
        const rq = await fetchRoute({
          fromAddress: params.fromAddress,
          tokenIn: params.beefyVaultUnderlying,
          tokenOut: TOKENS.CVX,
          amountIn: expectedUnderlyingOutput,
          slippage: params.slippage ?? "100",
        });
        cvxEstimate = BigInt(rq.amountOut);
      } catch {
        cvxEstimate = BigInt(expectedUnderlyingOutput);
      }
    } else {
      cvxEstimate = BigInt(expectedUnderlyingOutput);
    }
    expectedIntermediateCvx = cvxEstimate;
    const { actions: cvgCvxActions, expectedCvgCvx } = await buildCvxToCvgCvxDepositActions({
      expectedCvxAmount: cvxEstimate,
      targetVault: params.vaultAddress,
      slippageBps,
    });
    const baseIdx = actions.length;
    actions.push(...cvgCvxActions);
    rebaseCvgCvxHybridRef(actions, baseIdx);
    expectedCvgCvxTotal = expectedCvgCvx;
  } else {
    expectedTargetUnderlyingOutput = await estimateRouteOutputOrFallback(
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
    skipQuote: targetIsCvgCvx,
  });

  if (targetIsCvgCvx && expectedCvgCvxTotal > 0n) {
    let expectedShares = expectedCvgCvxTotal.toString();
    try {
      const selector = "0xef8b30f7"; // previewDeposit(uint256)
      const data = selector + expectedCvgCvxTotal.toString(16).padStart(64, "0");
      const res = await rpcWithFallback<{ result?: string }>({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: params.vaultAddress, data }, "latest"],
      });
      if (res.result && res.result !== "0x") {
        expectedShares = BigInt(res.result).toString();
      }
    } catch { /* fall back */ }
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [params.vaultAddress.toLowerCase()]: expectedShares,
      [TOKENS.CVGCVX.toLowerCase()]: expectedCvgCvxTotal.toString(),
    };
  }

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
  } else if (targetIsCvgCvx) {
    const cvgCvxFmt = formatRouteAmount(expectedCvgCvxTotal, TOKENS.CVGCVX);
    if (!beefyIsCvx) {
      steps.push({ tokenSymbol: beefyUnderlyingSymbol, amount: conservativeUnderlying, action: "Swap", description: `${beefyUnderlyingSymbol} for CVX`, protocol: "Enso" });
    }
    steps.push({ tokenSymbol: "CVX", amount: formatRouteAmount(expectedIntermediateCvx, TOKENS.CVX), action: "Swap + Mint", description: "CVX to cvgCVX — Curve pool + Convex mint", protocol: "Curve+Convex" });
    steps.push({ tokenSymbol: "cvgCVX", amount: cvgCvxFmt, action: "Deposit", description: `cvgCVX into ${vaultSymbol}`, protocol: "yld" });
  } else {
    steps.push({ tokenSymbol: beefyUnderlyingSymbol, amount: conservativeUnderlying, action: "Swap", description: `${beefyUnderlyingSymbol} for ${targetUnderlyingSymbol}`, protocol: "Enso" });
    steps.push({ tokenSymbol: targetUnderlyingSymbol, amount: formatRouteAmount(expectedTargetUnderlyingOutput, targetUnderlying), action: "Deposit", description: `${targetUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
  }

  steps.push({ tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" });

  const routeInfo: RouteInfo = {
    steps,
    tokens: sameUnderlying
      ? [params.beefyVaultSymbol, beefyUnderlyingSymbol, vaultSymbol]
      : targetIsCvgCvx
      ? beefyIsCvx
        ? [params.beefyVaultSymbol, "CVX", "cvgCVX", vaultSymbol]
        : [params.beefyVaultSymbol, beefyUnderlyingSymbol, "CVX", "cvgCVX", vaultSymbol]
      : [params.beefyVaultSymbol, beefyUnderlyingSymbol, targetUnderlyingSymbol, vaultSymbol],
    protocols: sameUnderlying
      ? ["Beefy", "yld"]
      : targetIsCvgCvx
      ? beefyIsCvx
        ? ["Beefy", "Curve+Convex", "yld"]
        : ["Beefy", "Enso", "Curve+Convex", "yld"]
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
  let expectedCvgCvxTotal = 0n;

  const actions: EnsoBundleAction[] = [];

  if (targetIsPxCvx) {
    // lpxCVX → pxCVX (unwrap 1:1) → deposit to yspxCVX
    // Action 0: Unwrap lpxCVX → pxCVX
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "unwrap",
        abi: "function unwrap(uint256 amount) returns (uint256)",
        args: [params.amountIn],
      },
    });
    // Action 1: Deposit pxCVX → yspxCVX
    actions.push({
      protocol: "erc4626",
      action: "deposit",
      args: {
        tokenIn: PIREX_PXCVX,
        tokenOut: params.vaultAddress,
        amountIn: { useOutputOfCallAt: 0 },
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

  const targetIsCvgCvx = targetUnderlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();

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
  } else if (targetIsCvgCvx) {
    const { actions: cvgCvxDepositActions, expectedCvgCvx } = await buildCvxToCvgCvxDepositActions({
      expectedCvxAmount: expectedCvxOutput,
      targetVault: params.vaultAddress,
      slippageBps,
    });
    expectedCvgCvxTotal = expectedCvgCvx;
    const baseIdx = actions.length;
    actions.push(...cvgCvxDepositActions);
    rebaseCvgCvxHybridRef(actions, baseIdx);
  } else {
    expectedTargetUnderlyingOutput = await estimateRouteOutputOrFallback(
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
    skipQuote: targetIsCvgCvx, // hybrid bundles need skipQuote
  });

  if (targetIsCvgCvx && expectedCvgCvxTotal > 0n) {
    let expectedShares = expectedCvgCvxTotal.toString();
    try {
      const selector = "0xef8b30f7"; // previewDeposit(uint256)
      const data =
        selector + expectedCvgCvxTotal.toString(16).padStart(64, "0");
      const res = await rpcWithFallback<{ result?: string }>({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: params.vaultAddress, data }, "latest"],
      });
      if (res.result && res.result !== "0x") {
        expectedShares = BigInt(res.result).toString();
      }
    } catch {
      // fall back to raw cvgCVX amount
    }
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [params.vaultAddress.toLowerCase()]: expectedShares,
      [TOKENS.CVGCVX.toLowerCase()]: expectedCvgCvxTotal.toString(),
    };
  }

  // Build routeInfo
  const targetUnderlyingSymbol = getTokenSymbol(targetUnderlying);
  const steps: RouteStep[] = [
    { tokenSymbol: "lpxCVX", amount: formatRouteAmount(params.amountIn, TOKENS.LPXCVX), action: "Swap", description: "lpxCVX for CVX", protocol: "Curve" },
  ];

  if (targetIsCvx) {
    steps.push({ tokenSymbol: "CVX", amount: formatRouteAmount(expectedCvxOutput, TOKENS.CVX), action: "Deposit", description: `CVX into ${vaultSymbol}`, protocol: "yld" });
  } else if (targetIsCvgCvx) {
    steps.push({ tokenSymbol: "CVX", amount: formatRouteAmount(expectedCvxOutput, TOKENS.CVX), action: "Swap + Mint", description: "CVX to cvgCVX — Curve pool + Convex mint", protocol: "Curve+Convex" });
    steps.push({ tokenSymbol: "cvgCVX", amount: expectedCvgCvxTotal > 0n ? formatRouteAmount(expectedCvgCvxTotal, TOKENS.CVGCVX) : undefined, action: "Deposit", description: `cvgCVX into ${vaultSymbol}`, protocol: "yld" });
  } else {
    steps.push({ tokenSymbol: "CVX", amount: formatRouteAmount(expectedCvxOutput, TOKENS.CVX), action: "Swap", description: `CVX for ${targetUnderlyingSymbol}`, protocol: "Enso" });
    steps.push({ tokenSymbol: targetUnderlyingSymbol, amount: formatRouteAmount(expectedTargetUnderlyingOutput, targetUnderlying), action: "Deposit", description: `${targetUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
  }

  steps.push({ tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" });

  const routeInfo: RouteInfo = {
    steps,
    tokens: targetIsCvx
      ? ["lpxCVX", "CVX", vaultSymbol]
      : targetIsCvgCvx
      ? ["lpxCVX", "CVX", "cvgCVX", vaultSymbol]
      : ["lpxCVX", "CVX", targetUnderlyingSymbol, vaultSymbol],
    protocols: targetIsCvx
      ? ["Curve", "yld"]
      : targetIsCvgCvx
      ? ["Curve", "Convex", "yld"]
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
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: params.amountIn, // Same amount (1:1 wrap)
      },
    },
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
  const targetIsCvgCvx = targetUnderlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
  let expectedCvgCvxTotal = 0n;

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
  } else if (targetIsCvgCvx) {
    // CVX → cvgCVX hybrid (Curve + Convex). No liquid Enso route.
    const { actions: cvgCvxActions, expectedCvgCvx } = await buildCvxToCvgCvxDepositActions({
      expectedCvxAmount: expectedCvxOutput,
      targetVault: params.vaultAddress,
      slippageBps,
    });
    const baseIdx = actions.length;
    actions.push(...cvgCvxActions);
    rebaseCvgCvxHybridRef(actions, baseIdx);
    expectedCvgCvxTotal = expectedCvgCvx;
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
    skipQuote: targetIsCvgCvx,
  });

  if (targetIsCvgCvx && expectedCvgCvxTotal > 0n) {
    let expectedShares = expectedCvgCvxTotal.toString();
    try {
      const selector = "0xef8b30f7"; // previewDeposit(uint256)
      const data =
        selector + expectedCvgCvxTotal.toString(16).padStart(64, "0");
      const res = await rpcWithFallback<{ result?: string }>({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: params.vaultAddress, data }, "latest"],
      });
      if (res.result && res.result !== "0x") {
        expectedShares = BigInt(res.result).toString();
      }
    } catch {
      // fall back to raw cvgCVX amount
    }
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [params.vaultAddress.toLowerCase()]: expectedShares,
      [TOKENS.CVGCVX.toLowerCase()]: expectedCvgCvxTotal.toString(),
    };
  }

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
  } else if (targetIsCvgCvx) {
    const cvgCvxFmt = (Number(expectedCvgCvxTotal) / 1e18).toFixed(4);
    steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Swap + Mint", description: "CVX to cvgCVX — Curve pool + Convex mint", protocol: "Curve+Convex" });
    steps.push({ tokenSymbol: "cvgCVX", amount: cvgCvxFmt, action: "Deposit", description: `cvgCVX into ${vaultSymbol}`, protocol: "yld" });
  } else {
    steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Swap", description: `CVX for ${targetUnderlyingSymbol}`, protocol: "Enso" });
    steps.push({ tokenSymbol: targetUnderlyingSymbol, action: "Deposit", description: `${targetUnderlyingSymbol} into ${vaultSymbol}`, protocol: "yld" });
  }

  steps.push({ tokenSymbol: vaultSymbol, action: "Receive", description: "vault shares", protocol: "yld" });

  const routeInfo: RouteInfo = {
    steps,
    tokens: targetIsCvx
      ? ["pxCVX", "lpxCVX", "CVX", vaultSymbol]
      : targetIsCvgCvx
      ? ["pxCVX", "lpxCVX", "CVX", "cvgCVX", vaultSymbol]
      : ["pxCVX", "lpxCVX", "CVX", targetUnderlyingSymbol, vaultSymbol],
    protocols: targetIsCvx
      ? ["Pirex", "Curve", "yld"]
      : targetIsCvgCvx
      ? ["Pirex", "Curve", "Convex", "yld"]
      : ["Pirex", "Curve", "Enso", "yld"],
  };

  return { ...bundleResult, routeInfo };
}

// ============================================================================
// Any Token → pxCVX / cvgCVX (delivered to user, universal-zap targets)
// ============================================================================
//
// Same hybrid swap/mint optimization as the corresponding vault zap-in routes,
// but the final step transfers the accumulated underlying to the user instead
// of depositing into a yld vault.

/**
 * Zap any input token to pxCVX delivered to the user.
 * Hybrid split: Curve lpxCVX pool swap (if > 1:1) + Pirex 1:1 mint.
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
  const { PIREX } = await import("@/config/vaults");
  const inputSymbol = getTokenSymbol(params.inputToken);
  const inputIsCvx = params.inputToken.toLowerCase() === TOKENS.CVX.toLowerCase();
  const inputIsEth = params.inputToken.toLowerCase() === ETH_ADDRESS.toLowerCase();

  // Estimate CVX amount we'll have mid-bundle
  let estimatedCvxAmount = params.amountIn;
  if (!inputIsCvx) {
    if (inputIsEth) {
      estimatedCvxAmount = await getEthToCvxEstimate(params.amountIn);
    } else {
      try {
        const routeEstimate = await fetchRoute({
          fromAddress: params.fromAddress,
          tokenIn: params.inputToken,
          tokenOut: TOKENS.CVX,
          amountIn: params.amountIn,
          slippage: params.slippage ?? "100",
        });
        estimatedCvxAmount = routeEstimate.amountOut || params.amountIn;
        await new Promise((resolve) => setTimeout(resolve, 1100)); // Enso rate limit
      } catch {
        estimatedCvxAmount = params.amountIn;
      }
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
  const totalExpectedPxCvx = expectedSwapPxCvx + expectedMintPxCvx;

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

  if (swapAmount > 0n) {
    // Curve swap: CVX → lpxCVX → unwrap → pxCVX (lands at ENSO_SHORTCUTS)
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: inputIsCvx ? swapAmount.toString() : { useOutputOfCallAt: actionIndex - 1 },
      },
    });
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
          swapAmount.toString(),
          swapMinDy,
        ],
      },
    });
    const swapIdx = actionIndex++;

    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.LPXCVX,
        spender: PIREX.LPXCVX,
        amount: { useOutputOfCallAt: swapIdx },
      },
    });
    actionIndex++;

    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: PIREX.LPXCVX,
        method: "unwrap",
        abi: "function unwrap(uint256 amount)",
        args: [{ useOutputOfCallAt: swapIdx }],
      },
    });
    actionIndex++;
  }

  if (mintAmount > 0n) {
    // Pirex mint: CVX → pxCVX 1:1, sent to ENSO_SHORTCUTS so it aggregates with swap portion
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.PIREX_CVX,
        amount: mintAmount.toString(),
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
          mintAmount.toString(),
          ENSO_SHORTCUTS,
          "false",
          "0x0000000000000000000000000000000000000000",
        ],
      },
    });
    actionIndex++;
  }

  // Read total pxCVX balance at ENSO_SHORTCUTS (both paths land here)
  actions.push({
    protocol: "enso",
    action: "balance",
    args: { token: PIREX.PXCVX },
  });
  const pxCvxBalanceIdx = actionIndex++;

  if (params.depositIntoVault) {
    // Deposit pxCVX into a pxCVX-underlying ERC4626 external vault (e.g. uCVX)
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
    // Transfer pxCVX to user
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
    skipQuote: true, // multi-token bundles can't be quote-simulated
  });

  // skipQuote=true returns no amountsOut — populate with our estimate so the
  // UI can display the expected output.
  if (params.depositIntoVault) {
    // Estimate vault shares from pxCVX amount via previewDeposit
    let expectedShares = totalExpectedPxCvx.toString();
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
    } catch { /* fall back */ }
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [params.depositIntoVault.toLowerCase()]: expectedShares,
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
  if (swapAmount > 0n && expectedSwapPxCvx > 0n) {
    swapBonus = (Number(expectedSwapPxCvx) / Number(swapAmount) - 1) * 100;
    bonusAmount = (Number(expectedSwapPxCvx - swapAmount) / 1e18).toFixed(4);
  }

  const cvxAmountFmt = (Number(estimatedCvxAmount) / 1e18).toFixed(4);
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
      description: "CVX for pxCVX",
      protocol: "Curve",
      bonus: swapBonus,
      bonusAmount,
      bonusSymbol: "pxCVX",
    });
    steps.push({
      tokenSymbol: "CVX",
      amount: mintCvxFmt,
      action: "Mint",
      description: "pxCVX with CVX (1:1)",
      protocol: "Pirex",
    });
  } else if (swapAmount > 0n) {
    steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Swap", description: "CVX for pxCVX", protocol: "Curve", bonus: swapBonus, bonusAmount, bonusSymbol: "pxCVX" });
  } else {
    steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Mint", description: "pxCVX with CVX (1:1)", protocol: "Pirex" });
  }
  if (params.depositIntoVault) {
    const outVaultSymbol = getTokenSymbol(params.depositIntoVault);
    const pxCvxTotalFmt = (Number(totalExpectedPxCvx) / 1e18).toFixed(4);
    steps.push({ tokenSymbol: "pxCVX", amount: pxCvxTotalFmt, action: "Deposit", description: `pxCVX into ${outVaultSymbol}`, protocol: "Llama Airforce" });
    steps.push({ tokenSymbol: outVaultSymbol, action: "Receive", description: "vault shares", protocol: "Llama Airforce" });
  } else {
    steps.push({ tokenSymbol: "pxCVX", action: "Receive", description: "tokens", protocol: "Pirex" });
  }

  const protocols = inputIsCvx
    ? swapAmount > 0n && mintAmount > 0n
      ? ["Curve", "Pirex"]
      : swapAmount > 0n
        ? ["Curve", "Pirex"]
        : ["Pirex"]
    : swapAmount > 0n && mintAmount > 0n
      ? ["Enso", "Curve", "Pirex"]
      : swapAmount > 0n
        ? ["Enso", "Curve", "Pirex"]
        : ["Enso", "Pirex"];

  const routeInfo: RouteInfo = {
    steps,
    tokens: inputIsCvx ? ["CVX", "pxCVX"] : [inputSymbol, "CVX", "pxCVX"],
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
 * Zap any input token to cvgCVX delivered to the user.
 * Hybrid split: Curve CVX1/cvgCVX pool swap (if > 1:1) + Convex 1:1 mint.
 */
export async function fetchAnyToCvgCvxRoute(params: {
  fromAddress: string;
  inputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  const { TANGENT } = await import("@/config/vaults");
  const inputSymbol = getTokenSymbol(params.inputToken);
  const inputIsCvx = params.inputToken.toLowerCase() === TOKENS.CVX.toLowerCase();
  const inputIsEth = params.inputToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const slippageBps = validateSlippage(params.slippage);
  const totalSlippageBps = getBufferedSlippageBps(slippageBps);

  // Estimate CVX output for split calculation
  let expectedCvxOutput: string;
  if (inputIsCvx) {
    expectedCvxOutput = params.amountIn;
  } else if (inputIsEth) {
    expectedCvxOutput = await getEthToCvxEstimate(params.amountIn);
  } else {
    try {
      const routeEstimate = await fetchRoute({
        fromAddress: params.fromAddress,
        tokenIn: params.inputToken,
        tokenOut: TOKENS.CVX,
        amountIn: params.amountIn,
        slippage: params.slippage ?? "100",
      });
      expectedCvxOutput = routeEstimate.amountOut || params.amountIn;
      await new Promise((resolve) => setTimeout(resolve, 1100));
    } catch {
      expectedCvxOutput = params.amountIn;
    }
  }

  // Buffered CVX amount for split (account for route slippage)
  const routingBufferBps = inputIsCvx ? slippageBps : slippageBps * 2;
  const cvxAmountForSplit = inputIsCvx
    ? expectedCvxOutput
    : applySlippageBuffer(BigInt(expectedCvxOutput), routingBufferBps);

  const { swapAmount, mintAmount } = await getOptimalSwapAmount(cvxAmountForSplit);

  // Estimate swap output via Curve (CVX1 → cvgCVX, direction 0 → 1)
  let expectedSwapCvgCvx = 0n;
  let swapMinDy = "0";
  if (swapAmount > 0n) {
    const swapOutput = await getCvgCvxSwapRate(swapAmount.toString());
    if (!swapOutput || swapOutput === 0n) {
      throw new Error("Failed to estimate Curve CVX1→cvgCVX swap output");
    }
    expectedSwapCvgCvx = swapOutput;
    swapMinDy = calculateMinDy(swapOutput, totalSlippageBps);
  }
  const totalExpectedCvgCvx = expectedSwapCvgCvx + mintAmount; // mint = 1:1

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

  if (swapAmount > 0n) {
    // Swap path: CVX → CVX1 (1:1 wrap) → Curve exchange → cvgCVX (lands at ENSO_SHORTCUTS)
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: { token: TOKENS.CVX, spender: TOKENS.CVX1, amount: swapAmount.toString() },
    });
    actionIndex++;

    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "mint",
        abi: "function mint(address to, uint256 amount)",
        args: [ENSO_SHORTCUTS, swapAmount.toString()],
      },
    });
    actionIndex++;

    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX1,
        spender: TANGENT.CVX1_CVGCVX_POOL,
        amount: swapAmount.toString(),
      },
    });
    actionIndex++;

    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [0, 1, swapAmount.toString(), swapMinDy],
      },
    });
    actionIndex++;
  }

  if (mintAmount > 0n) {
    // Mint path: CVX → cvgCVX 1:1 via Convex mint (sent to ENSO_SHORTCUTS for aggregation)
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: TANGENT.CVGCVX_CONTRACT,
        amount: mintAmount.toString(),
      },
    });
    actionIndex++;

    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVGCVX_CONTRACT,
        method: "mint",
        abi: "function mint(address to, uint256 amount, bool isLock) returns (uint256)",
        args: [ENSO_SHORTCUTS, mintAmount.toString(), true],
      },
    });
    actionIndex++;
  }

  actions.push({
    protocol: "enso",
    action: "balance",
    args: { token: TOKENS.CVGCVX },
  });
  const cvgCvxBalanceIdx = actionIndex++;

  actions.push({
    protocol: "erc20",
    action: "transfer",
    args: {
      token: TOKENS.CVGCVX,
      amount: { useOutputOfCallAt: cvgCvxBalanceIdx },
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
    [TOKENS.CVGCVX.toLowerCase()]: totalExpectedCvgCvx.toString(),
  };

  let swapBonus = 0;
  let bonusAmount: string | undefined;
  if (swapAmount > 0n && expectedSwapCvgCvx > 0n) {
    swapBonus = (Number(expectedSwapCvgCvx) / Number(swapAmount) - 1) * 100;
    bonusAmount = (Number(expectedSwapCvgCvx - swapAmount) / 1e18).toFixed(4);
  }

  const cvxAmountFmt = (Number(expectedCvxOutput) / 1e18).toFixed(4);
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
      description: "CVX for cvgCVX via CVX1/Curve",
      protocol: "Curve",
      bonus: swapBonus,
      bonusAmount,
      bonusSymbol: "cvgCVX",
    });
    steps.push({
      tokenSymbol: "CVX",
      amount: mintCvxFmt,
      action: "Mint",
      description: "cvgCVX with CVX (1:1)",
      protocol: "Convex",
    });
  } else if (swapAmount > 0n) {
    steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Swap", description: "CVX for cvgCVX via CVX1/Curve", protocol: "Curve", bonus: swapBonus, bonusAmount, bonusSymbol: "cvgCVX" });
  } else {
    steps.push({ tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Mint", description: "cvgCVX with CVX (1:1)", protocol: "Convex" });
  }
  steps.push({ tokenSymbol: "cvgCVX", action: "Receive", description: "tokens", protocol: "Convex" });

  const protocols = inputIsCvx
    ? swapAmount > 0n && mintAmount > 0n
      ? ["Curve", "Convex"]
      : swapAmount > 0n
        ? ["Curve"]
        : ["Convex"]
    : swapAmount > 0n && mintAmount > 0n
      ? ["Enso", "Curve", "Convex"]
      : swapAmount > 0n
        ? ["Enso", "Curve"]
        : ["Enso", "Convex"];

  const routeInfo: RouteInfo = {
    steps,
    tokens: inputIsCvx ? ["CVX", "cvgCVX"] : [inputSymbol, "CVX", "cvgCVX"],
    protocols,
    hybrid: {
      swapAmount: swapAmount.toString(),
      mintAmount: mintAmount.toString(),
      swapBonus,
      swapProtocol: "Curve",
      mintProtocol: "Convex",
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
      try {
        const routeEstimate = await fetchRoute({
          fromAddress: params.fromAddress,
          tokenIn: params.inputToken,
          tokenOut: TOKENS.CVX,
          amountIn: params.amountIn,
          slippage: params.slippage ?? "100",
        });
        estimatedCvxAmount = routeEstimate.amountOut || params.amountIn;
        await new Promise((resolve) => setTimeout(resolve, 1100));
      } catch {
        estimatedCvxAmount = params.amountIn;
      }
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
  const totalExpectedLpxCvx = expectedSwapLpxCvx + expectedMintLpxCvx;

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

  if (swapAmount > 0n) {
    // Curve swap path: CVX → lpxCVX (lands at ENSO_SHORTCUTS)
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.LPXCVX_CVX_POOL,
        amount: swapAmount.toString(),
      },
    });
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
          swapAmount.toString(),
          swapMinDy,
        ],
      },
    });
    actionIndex++;
  }

  if (mintAmount > 0n) {
    // Pirex mint + wrap path: CVX → pxCVX (1:1) → wrap → lpxCVX (1:1)
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVX,
        spender: PIREX.PIREX_CVX,
        amount: mintAmount.toString(),
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
          mintAmount.toString(),
          ENSO_SHORTCUTS,
          "false",
          "0x0000000000000000000000000000000000000000",
        ],
      },
    });
    actionIndex++;

    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: PIREX.PXCVX,
        spender: PIREX.LPXCVX,
        amount: mintAmount.toString(),
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
        args: [mintAmount.toString()],
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
  if (swapAmount > 0n && expectedSwapLpxCvx > 0n) {
    swapBonus = (Number(expectedSwapLpxCvx) / Number(swapAmount) - 1) * 100;
    bonusAmount = (Number(expectedSwapLpxCvx - swapAmount) / 1e18).toFixed(4);
  }

  const cvxAmountFmt = (Number(estimatedCvxAmount) / 1e18).toFixed(4);
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
// pxCVX / cvgCVX / lpxCVX → Any Token (universal-zap inputs)
// ============================================================================
//
// These handle the reverse of the output routes above: user holds an illiquid
// token (pxCVX / cvgCVX / lpxCVX) and wants a regular token. Enso's aggregator
// has no liquid route for these so we manually route through the Curve pools.

/** lpxCVX → any token, single Curve hop then Enso route CVX → target. */
export async function fetchAnyFromLpxCvxRoute(params: {
  fromAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  const { PIREX } = await import("@/config/vaults");
  const outputSymbol = getTokenSymbol(params.outputToken);
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
    // Enso route CVX → output (uses Curve exchange output as input)
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: 1 },
        slippage: params.slippage ?? "100",
      },
    },
  ];

  appendETHUnwrapIfNeeded(actions, params.outputToken);

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
  ];

  return {
    ...bundleResult,
    routeInfo: {
      steps,
      tokens: ["lpxCVX", "CVX", outputSymbol],
      protocols: ["Curve", "Enso"],
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
  const { PIREX } = await import("@/config/vaults");
  const outputSymbol = getTokenSymbol(params.outputToken);
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
    // Approve lpxCVX → Curve pool
    {
      protocol: "erc20",
      action: "approve",
      args: { token: PIREX.LPXCVX, spender: PIREX.LPXCVX_CVX_POOL, amount: params.amountIn },
    },
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
    // Enso route CVX → output
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: 3 },
        slippage: params.slippage ?? "100",
      },
    },
  ];

  appendETHUnwrapIfNeeded(actions, params.outputToken);

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
  ];

  return {
    ...bundleResult,
    routeInfo: {
      steps,
      tokens: ["pxCVX", "lpxCVX", "CVX", outputSymbol],
      protocols: ["Pirex", "Curve", "Enso"],
    },
  };
}

/** cvgCVX → any token: Curve swap to CVX1, unwrap to CVX, then Enso route. */
export async function fetchAnyFromCvgCvxRoute(params: {
  fromAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<CustomBundleResponse> {
  const { TANGENT } = await import("@/config/vaults");
  const outputSymbol = getTokenSymbol(params.outputToken);
  const slippageBps = validateSlippage(params.slippage);

  // Estimate CVX1 output from Curve swap (cvgCVX index 1 → CVX1 index 0)
  const expectedCvx1 = await getCurveGetDy(
    TANGENT.CVX1_CVGCVX_POOL,
    1, // cvgCVX
    0, // CVX1
    params.amountIn,
  );
  if (!expectedCvx1) {
    throw new Error("Failed to estimate Curve cvgCVX→CVX1 swap output");
  }
  const swapMinDy = calculateMinDy(expectedCvx1, slippageBps);

  // CVX1.withdraw is void — reference the Curve exchange output amount (CVX1
  // unwraps 1:1 to CVX) for the subsequent route step.
  const actions: EnsoBundleAction[] = [
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVGCVX,
        spender: TANGENT.CVX1_CVGCVX_POOL,
        amount: params.amountIn,
      },
    },
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL,
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [1, 0, params.amountIn, swapMinDy],
      },
    },
    // Unwrap CVX1 → CVX into ENSO_SHORTCUTS (void)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "withdraw",
        abi: "function withdraw(uint256 amount, address to)",
        args: [{ useOutputOfCallAt: 1 }, ENSO_SHORTCUTS],
      },
    },
    // Enso route CVX → output (CVX1 unwrap is 1:1, so use Curve exchange output)
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: 1 },
        slippage: params.slippage ?? "100",
      },
    },
  ];

  appendETHUnwrapIfNeeded(actions, params.outputToken);

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: true,
  });

  const steps: RouteStep[] = [
    {
      tokenSymbol: "cvgCVX",
      action: "Swap",
      description: "cvgCVX for CVX1 via Curve pool",
      protocol: "Curve",
    },
    {
      tokenSymbol: "CVX1",
      action: "Unwrap",
      description: "CVX1 to CVX (1:1)",
      protocol: "Convex",
    },
    {
      tokenSymbol: "CVX",
      amount: (Number(expectedCvx1) / 1e18).toFixed(4),
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
  ];

  return {
    ...bundleResult,
    routeInfo: {
      steps,
      tokens: ["cvgCVX", "CVX1", "CVX", outputSymbol],
      protocols: ["Curve", "Convex", "Enso"],
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
  const { PIREX, LLAMA_AIRFORCE } = await import("@/config/vaults");
  const outputSymbol = getTokenSymbol(params.outputToken);
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
    // 5: Enso route CVX → output token
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: TOKENS.CVX,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: 4 },
        slippage: params.slippage ?? "100",
      },
    },
  ];

  appendETHUnwrapIfNeeded(actions, params.outputToken);

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: true,
  });

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
  const externalSymbol = getTokenSymbol(params.externalVault);
  const underlyingSymbol = getTokenSymbol(params.externalVaultUnderlying);
  const outputSymbol = getTokenSymbol(params.outputToken);
  const protocolLabel = params.protocolLabel ?? "ERC4626";

  const sameAsOutput =
    params.externalVaultUnderlying.toLowerCase() === params.outputToken.toLowerCase();

  const expectedUnderlying = await previewRedeem(params.externalVault, params.amountIn);

  const actions: EnsoBundleAction[] = [
    // Redeem external vault → underlying
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

  if (!sameAsOutput) {
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.externalVaultUnderlying,
        tokenOut: params.outputToken,
        amountIn: { useOutputOfCallAt: 0 },
        slippage: params.slippage ?? "100",
      },
    });
  }

  appendETHUnwrapIfNeeded(actions, params.outputToken);

  const bundleResult = await fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    receiver: params.fromAddress,
    routingStrategy: "router",
    skipQuote: false,
  });

  const underlyingFmt = (Number(expectedUnderlying) / 1e18).toFixed(4);
  const steps: RouteStep[] = [
    { tokenSymbol: externalSymbol, action: "Exit", description: `${externalSymbol} for ${underlyingSymbol}`, protocol: protocolLabel },
  ];
  if (!sameAsOutput) {
    steps.push({ tokenSymbol: underlyingSymbol, amount: underlyingFmt, action: "Swap", description: `${underlyingSymbol} for ${outputSymbol}`, protocol: "Enso" });
    steps.push({ tokenSymbol: outputSymbol, action: "Receive", description: "tokens", protocol: "Enso" });
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
      protocols: sameAsOutput ? [protocolLabel] : [protocolLabel, "Enso"],
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
  const { LLAMA_AIRFORCE } = await import("@/config/vaults");
  const outputSymbol = getTokenSymbol(params.outputToken);

  const expectedCvxCrv = await previewUCrvWithdraw(params.amountIn);
  const sameAsOutput =
    LLAMA_AIRFORCE.UCRV_UNDERLYING.toLowerCase() === params.outputToken.toLowerCase();

  const actions: EnsoBundleAction[] = [
    // uCRV.withdraw(_to=ENSO_SHORTCUTS, _shares) — cvxCRV delivered to shortcuts
    {
      protocol: "enso",
      action: "call",
      args: {
        address: LLAMA_AIRFORCE.UCRV,
        method: "withdraw",
        abi: "function withdraw(address _to, uint256 _shares) returns (uint256)",
        args: [ENSO_SHORTCUTS, params.amountIn],
      },
    },
  ];

  // Estimate output in USD-of-output via a standalone route quote. We embed
  // its inner weiroll bytes via routeMulti so Enso's shortcut builder doesn't
  // need to validate a dynamic-amount route mid-bundle.
  let expectedOutput = "0";
  if (!sameAsOutput) {
    const { extractInnerSwapData } = await import("@/lib/zapper");
    const standaloneRoute = await fetchRoute({
      fromAddress: params.fromAddress,
      tokenIn: LLAMA_AIRFORCE.UCRV_UNDERLYING,
      tokenOut: params.outputToken,
      amountIn: expectedCvxCrv,
      slippage: params.slippage ?? "100",
    });
    expectedOutput = standaloneRoute.amountOut;
    const innerSwapData = extractInnerSwapData(standaloneRoute.tx.data);
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: ENSO_ROUTER_EXECUTOR.toLowerCase(),
        method: "routeMulti",
        abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)",
        args: [[], innerSwapData],
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

  // skipQuote returns no amountsOut — populate manually
  if (!sameAsOutput && expectedOutput !== "0") {
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [params.outputToken.toLowerCase()]: expectedOutput,
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
  const outputSymbol = getTokenSymbol(params.outputToken);
  const underlyingSymbol = getTokenSymbol(params.beefyVaultUnderlying);
  const expectedUnderlying = await previewBeefyWithdraw(params.beefyVault, params.amountIn);
  const sameAsOutput =
    params.beefyVaultUnderlying.toLowerCase() === params.outputToken.toLowerCase();

  const actions: EnsoBundleAction[] = [
    // Beefy withdraw(shares) — burns shares, sends underlying to msg.sender
    // (ENSO_SHORTCUTS). The call is void, so Enso can't quote a route whose
    // amountIn references its output — embed a pre-built inner swap instead.
    {
      protocol: "enso",
      action: "call",
      args: {
        address: params.beefyVault,
        method: "withdraw",
        abi: "function withdraw(uint256 _shares)",
        args: [params.amountIn],
      },
    },
  ];

  let expectedOutput = "0";
  if (!sameAsOutput) {
    const { extractInnerSwapData } = await import("@/lib/zapper");
    const standaloneRoute = await fetchRoute({
      fromAddress: params.fromAddress,
      tokenIn: params.beefyVaultUnderlying,
      tokenOut: params.outputToken,
      amountIn: expectedUnderlying,
      slippage: params.slippage ?? "100",
    });
    expectedOutput = standaloneRoute.amountOut;
    const innerSwapData = extractInnerSwapData(standaloneRoute.tx.data);
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: ENSO_ROUTER_EXECUTOR.toLowerCase(),
        method: "routeMulti",
        abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)",
        args: [[], innerSwapData],
      },
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
  if (!sameAsOutput && expectedOutput !== "0") {
    bundleResult.amountsOut = {
      ...bundleResult.amountsOut,
      [params.outputToken.toLowerCase()]: expectedOutput,
    };
  }

  const underlyingFmt = (Number(expectedUnderlying) / 1e18).toFixed(4);
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
      ? (Number(underlyingAmountRaw) / 1e18).toFixed(4)
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
 * `deposit(uint256 _amount, address _to)`. Route input → cvxCRV, approve,
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
      abi: "function deposit(uint256 _amount, address _to) returns (uint256)",
      args: [amountRef, params.fromAddress],
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
      const routeQuote = await fetchRoute({
        fromAddress: params.fromAddress,
        tokenIn: params.inputToken,
        tokenOut: LLAMA_AIRFORCE.UCRV_UNDERLYING,
        amountIn: params.amountIn,
        slippage: params.slippage,
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
      const routeQuote = await fetchRoute({
        fromAddress: params.fromAddress,
        tokenIn: params.inputToken,
        tokenOut: params.beefyVaultUnderlying,
        amountIn: params.amountIn,
        slippage: params.slippage,
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
  const { getVaultByAddress, isExternalVaultToken, getExternalVaultConfig } = await import("@/config/vaults");
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

  const inputSymbol = getTokenSymbol(params.inputToken);
  const targetUnderlyingSymbol = getTokenSymbol(targetVault.assetAddress);
  const inputExternalConfig = isExternalVaultToken(params.inputToken)
    ? getExternalVaultConfig(params.inputToken)
    : undefined;

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

  const inputSymbol = getTokenSymbol(params.inputToken);
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
  const { getExternalVaultConfig, isExternalVaultToken } = await import("@/config/vaults");
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
          abi: "function deposit(uint256 _amount, address _to) returns (uint256)",
          args: [finalState.amountRef, params.fromAddress],
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

  const inputSymbol = getTokenSymbol(params.inputToken);
  const inputExternalConfig = isExternalVaultToken(params.inputToken)
    ? getExternalVaultConfig(params.inputToken)
    : undefined;
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
  const amountIn = await clampAmountIn(params.sourceVault, params.amountIn);
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
 *   1. Redeem the yld vault to its underlying (cvxCRV / cvgCVX / pxCVX).
 *   2. Convert cvgCVX → CVX (via CVX1 Curve pool) or pxCVX → CVX (via lpxCVX
 *      Curve pool). For cvxCRV sources this step is skipped.
 *   3. If the target external vault's underlying differs from the intermediate,
 *      route through Enso using the routeMulti([], innerSwapData) pattern.
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
  const { PIREX, LLAMA_AIRFORCE, TANGENT } = await import("@/config/vaults");
  const slippageBps = validateSlippage(params.slippage);
  const totalSlippageBps = getBufferedSlippageBps(slippageBps);
  const sourceUnderlyingLower = params.sourceUnderlying.toLowerCase();
  const targetUnderlyingLower = params.targetUnderlying.toLowerCase();
  const amountIn = await clampAmountIn(params.sourceVault, params.amountIn);

  const sourceIsCvxCrv = sourceUnderlyingLower === TOKENS.CVXCRV.toLowerCase();
  const sourceIsCvgCvx = sourceUnderlyingLower === TOKENS.CVGCVX.toLowerCase();
  const sourceIsPxCvx = sourceUnderlyingLower === TOKENS.PXCVX.toLowerCase();

  if (!sourceIsCvxCrv && !sourceIsCvgCvx && !sourceIsPxCvx) {
    throw new Error(`Unsupported yld vault underlying ${params.sourceUnderlying} for external-vault zap`);
  }

  // ── Step 1: Estimate intermediate amount (the token we'll have after the
  //    yld-vault redeem + any required unwrap to CVX/cvxCRV).
  // ──────────────────────────────────────────────────────────────────────
  const expectedUnderlying = await previewRedeem(params.sourceVault, amountIn);
  let intermediateToken: string;
  let estimatedIntermediate: bigint;
  if (sourceIsCvxCrv) {
    intermediateToken = TOKENS.CVXCRV;
    estimatedIntermediate = BigInt(expectedUnderlying);
  } else if (sourceIsCvgCvx) {
    intermediateToken = TOKENS.CVX;
    const cvx1Out = await getCurveGetDy(TANGENT.CVX1_CVGCVX_POOL, 1, 0, expectedUnderlying);
    estimatedIntermediate = cvx1Out ?? 0n;
  } else {
    // pxCVX → wrap to lpxCVX (1:1) → swap to CVX
    intermediateToken = TOKENS.CVX;
    const cvxOut = await getCurveGetDy(
      PIREX.LPXCVX_CVX_POOL,
      PIREX.POOL_INDEX.LPXCVX,
      PIREX.POOL_INDEX.CVX,
      expectedUnderlying,
    );
    estimatedIntermediate = cvxOut ?? 0n;
  }

  if (estimatedIntermediate === 0n) {
    throw new Error(`Failed to estimate ${sourceIsCvxCrv ? "cvxCRV" : "CVX"} output from ${params.sourceVault}`);
  }

  // Apply user slippage buffer so min_dy / expected amounts are safe.
  const intermediateForSplit = BigInt(applySlippageBuffer(estimatedIntermediate, slippageBps));

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

  // ── Step 3: Convert underlying → intermediate token (CVX for cvgCVX/pxCVX).
  // ──────────────────────────────────────────────────────────────────────
  if (sourceIsCvgCvx) {
    const cvx1MinDy = calculateMinDy(estimatedIntermediate, totalSlippageBps);
    actions.push(
      { protocol: "erc20", action: "approve", args: { token: TOKENS.CVGCVX, spender: TANGENT.CVX1_CVGCVX_POOL, amount: { useOutputOfCallAt: redeemIdx } } },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVX1_CVGCVX_POOL,
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          args: [1, 0, { useOutputOfCallAt: redeemIdx }, cvx1MinDy],
        },
      },
    );
    const exchangeIdx = actions.length - 1;
    // CVX1.withdraw is void — burns CVX1, sends CVX to `to`. Send to ENSO_SHORTCUTS.
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1,
        method: "withdraw",
        abi: "function withdraw(uint256 amount, address to)",
        args: [{ useOutputOfCallAt: exchangeIdx }, ENSO_SHORTCUTS],
      },
    });
  } else if (sourceIsPxCvx) {
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
  // Its balance = intermediateForSplit (conservative estimate).

  // ── Step 4: Convert intermediate → target underlying if different.
  // ──────────────────────────────────────────────────────────────────────
  const sameUnderlying = intermediateToken.toLowerCase() === targetUnderlyingLower;
  const targetIsPxCvx = targetUnderlyingLower === TOKENS.PXCVX.toLowerCase();
  let totalExpectedTargetUnderlying = intermediateForSplit;

  if (!sameUnderlying && targetIsPxCvx) {
    // CVX → pxCVX via hybrid Curve swap + Pirex mint.
    if (intermediateToken.toLowerCase() !== TOKENS.CVX.toLowerCase()) {
      throw new Error("pxCVX target requires CVX intermediate");
    }
    const { swapAmount, mintAmount } = await getOptimalPxCvxSwapAmount(intermediateForSplit.toString());
    let expectedSwapPxCvx = 0n;
    let swapMinDy = "0";
    if (swapAmount > 0n) {
      const swapOut = await getPxCvxSwapRate(swapAmount.toString());
      if (!swapOut || swapOut === 0n) throw new Error("CVX→lpxCVX estimate failed");
      expectedSwapPxCvx = swapOut;
      swapMinDy = calculateMinDy(swapOut, totalSlippageBps);
    }
    totalExpectedTargetUnderlying = expectedSwapPxCvx + mintAmount;

    if (swapAmount > 0n) {
      actions.push(
        { protocol: "erc20", action: "approve", args: { token: TOKENS.CVX, spender: PIREX.LPXCVX_CVX_POOL, amount: swapAmount.toString() } },
        {
          protocol: "enso",
          action: "call",
          args: {
            address: PIREX.LPXCVX_CVX_POOL,
            method: "exchange",
            abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)",
            args: [String(PIREX.POOL_INDEX.CVX), String(PIREX.POOL_INDEX.LPXCVX), swapAmount.toString(), swapMinDy],
          },
        },
      );
      const swapIdx = actions.length - 1;
      actions.push(
        { protocol: "erc20", action: "approve", args: { token: PIREX.LPXCVX, spender: PIREX.LPXCVX, amount: { useOutputOfCallAt: swapIdx } } },
        {
          protocol: "enso",
          action: "call",
          args: {
            address: PIREX.LPXCVX,
            method: "unwrap",
            abi: "function unwrap(uint256 amount)",
            args: [{ useOutputOfCallAt: swapIdx }],
          },
        },
      );
    }
    if (mintAmount > 0n) {
      actions.push(
        { protocol: "erc20", action: "approve", args: { token: TOKENS.CVX, spender: PIREX.PIREX_CVX, amount: mintAmount.toString() } },
        {
          protocol: "enso",
          action: "call",
          args: {
            address: PIREX.PIREX_CVX,
            method: "deposit",
            abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
            args: [mintAmount.toString(), ENSO_SHORTCUTS, "false", "0x0000000000000000000000000000000000000000"],
          },
        },
      );
    }
  } else if (!sameUnderlying) {
    // Generic Enso routeMulti — intermediate is CVX or cvxCRV, target is some
    // other token (crvUSD, cvxCRV, CVX, etc.).
    const { extractInnerSwapData } = await import("@/lib/zapper");
    const standaloneRoute = await fetchRoute({
      fromAddress: params.fromAddress,
      tokenIn: intermediateToken,
      tokenOut: params.targetUnderlying,
      amountIn: intermediateForSplit.toString(),
      slippage: params.slippage ?? "100",
    });
    totalExpectedTargetUnderlying = BigInt(standaloneRoute.amountOut);
    const innerSwapData = extractInnerSwapData(standaloneRoute.tx.data);
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: ENSO_ROUTER_EXECUTOR.toLowerCase(),
        method: "routeMulti",
        abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)",
        args: [[], innerSwapData],
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
          abi: "function deposit(uint256 _amount, address _to) returns (uint256)",
          args: [{ useOutputOfCallAt: balanceIdx }, params.fromAddress],
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
    [intermediateToken.toLowerCase()]: intermediateForSplit.toString(),
    [params.sourceUnderlying.toLowerCase()]: expectedUnderlying,
  };

  // ── Step 8: Build route steps.
  // ──────────────────────────────────────────────────────────────────────
  const sourceSymbol = getTokenSymbol(params.sourceVault);
  const sourceUnderlyingSymbol = getTokenSymbol(params.sourceUnderlying);
  const intermediateSymbol = getTokenSymbol(intermediateToken);
  const targetUnderlyingSymbol = getTokenSymbol(params.targetUnderlying);
  const fmt = (x: bigint | string) => (Number(x) / 1e18).toFixed(4);

  const steps: RouteStep[] = [
    { tokenSymbol: sourceSymbol, amount: fmt(amountIn), action: "Redeem", description: `${sourceSymbol} for ${sourceUnderlyingSymbol}`, protocol: "yld" },
  ];

  if (!sourceIsCvxCrv) {
    // cvgCVX or pxCVX → CVX swap step
    const protocol = sourceIsCvgCvx ? "LiquidBoost" : "Pirex";
    const desc = sourceIsCvgCvx ? `${sourceUnderlyingSymbol} → CVX1 → CVX` : `${sourceUnderlyingSymbol} → lpxCVX → CVX`;
    steps.push({ tokenSymbol: sourceUnderlyingSymbol, amount: fmt(expectedUnderlying), action: "Swap", description: desc, protocol });
  }

  if (!sameUnderlying) {
    if (targetIsPxCvx) {
      steps.push({ tokenSymbol: "CVX", amount: fmt(intermediateForSplit), action: "Swap", description: "CVX for pxCVX (hybrid)", protocol: "Curve/Pirex" });
    } else {
      steps.push({ tokenSymbol: intermediateSymbol, amount: fmt(intermediateForSplit), action: "Swap", description: `${intermediateSymbol} for ${targetUnderlyingSymbol}`, protocol: "Enso" });
    }
  }

  steps.push(
    { tokenSymbol: targetUnderlyingSymbol, amount: fmt(totalExpectedTargetUnderlying), action: "Deposit", description: `${targetUnderlyingSymbol} into ${params.targetSymbol}`, protocol: params.targetProtocol },
    { tokenSymbol: params.targetSymbol, amount: fmt(expectedShares), action: "Receive", description: "vault shares", protocol: params.targetProtocol },
  );

  // Silence unused-var warning; LLAMA_AIRFORCE may be useful for future refinements.
  void LLAMA_AIRFORCE;

  return {
    ...bundleResult,
    routeInfo: {
      steps,
      tokens: [sourceSymbol, sourceUnderlyingSymbol, intermediateSymbol, targetUnderlyingSymbol, params.targetSymbol],
      protocols: ["yld", sourceIsCvgCvx ? "LiquidBoost" : sourceIsPxCvx ? "Pirex" : "yld", "Enso", params.targetProtocol],
    },
  };
}
