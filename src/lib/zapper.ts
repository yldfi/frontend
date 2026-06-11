// LlamaLendZapper contract integration
// Enables leveraged Curve LlamaLend operations via Enso Router swaps

import { fetchRoute, fetchBundle, ENSO_SHORTCUTS, ENSO_ROUTER_EXECUTOR, getCvgCvxSwapRate, getLpxCvxToCvxSwapRate } from "@/lib/enso";
import { calculateMinDy, getCurveGetDyFactory } from "@/lib/curve";
import { TOKENS, TANGENT, PIREX } from "@/config/vaults";
import { CRVUSD_ADDRESS } from "@/config/addresses";
import type { EnsoBundleAction } from "@/types/enso";
import { decodeFunctionData } from "viem";

// ABI for decoding routeSingle from Enso route API responses.
// routeSingle(Token tokenIn, bytes data) where Token = (uint8 tokenType, bytes data)
const ROUTE_SINGLE_ABI = [{
  name: "routeSingle",
  type: "function",
  inputs: [
    { name: "tokenIn", type: "tuple", components: [
      { name: "tokenType", type: "uint8" },
      { name: "data", type: "bytes" },
    ]},
    { name: "data", type: "bytes" },
  ],
  outputs: [{ name: "", type: "bytes" }],
}] as const;

/**
 * Extract inner swap data from an Enso route response.
 *
 * The Enso route API returns routeSingle(Token tokenIn, bytes innerData) calldata.
 * routeSingle pulls tokenIn from the user BEFORE executing innerData.
 * We extract innerData to use with routeMulti([], innerData) which skips the pull.
 */
export function extractInnerSwapData(routeTxData: string): `0x${string}` {
  const decoded = decodeFunctionData({
    abi: ROUTE_SINGLE_ABI,
    data: routeTxData as `0x${string}`,
  });
  if (!decoded.args) {
    throw new Error("Failed to decode routeSingle calldata — no args returned");
  }
  return decoded.args[1] as `0x${string}`;
}

// Current LlamaLendZapper address (overridable via env for fork testing)
export const ZAPPER_ADDRESS = (process.env.NEXT_PUBLIC_ZAPPER_ADDRESS ?? "0xED653FF2410A4686a0B69Fc4C0D1c0cccDFddb83") as `0x${string}`;

// LlamaLendZapper ABI (0xED653FF2410A4686a0B69Fc4C0D1c0cccDFddb83)
// Fetched from verified Etherscan source — functions only (no events/errors)
export const ZAPPER_ABI = [
  {
    name: "createLeveragedLoan",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "userCollateral", type: "uint256" },
      { name: "debt", type: "uint256" },
      { name: "N", type: "uint256" },
      { name: "minCollateralFromSwap", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "createLeveragedLoanFromToken",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "inputToken", type: "address" },
      { name: "inputAmount", type: "uint256" },
      { name: "debt", type: "uint256" },
      { name: "N", type: "uint256" },
      { name: "minCollateralFromInput", type: "uint256" },
      { name: "minCollateralFromDebt", type: "uint256" },
      { name: "inputSwapData", type: "bytes" },
      { name: "leverageSwapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "createLoanFromToken",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minCollateral", type: "uint256" },
      { name: "debt", type: "uint256" },
      { name: "N", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "createLoanAndConvert",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "collateral", type: "uint256" },
      { name: "debt", type: "uint256" },
      { name: "N", type: "uint256" },
      { name: "targetToken", type: "address" },
      { name: "minTargetOut", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "createLoanFromTokenAndConvert",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minCollateral", type: "uint256" },
      { name: "debt", type: "uint256" },
      { name: "N", type: "uint256" },
      { name: "targetToken", type: "address" },
      { name: "minTargetOut", type: "uint256" },
      { name: "inputSwapData", type: "bytes" },
      { name: "outputSwapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "leverageUp",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "additionalCollateral", type: "uint256" },
      { name: "additionalDebt", type: "uint256" },
      { name: "minCollateralFromSwap", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "leverageUpFromToken",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "inputToken", type: "address" },
      { name: "inputAmount", type: "uint256" },
      { name: "additionalDebt", type: "uint256" },
      { name: "minCollateralFromInput", type: "uint256" },
      { name: "minCollateralFromDebt", type: "uint256" },
      { name: "inputSwapData", type: "bytes" },
      { name: "leverageSwapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "addCollateralFromToken",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minCollateral", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "borrowMoreFromToken",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minCollateral", type: "uint256" },
      { name: "debt", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "borrowAndConvert",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "additionalCollateral", type: "uint256" },
      { name: "debt", type: "uint256" },
      { name: "targetToken", type: "address" },
      { name: "minTargetOut", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "removeCollateralAndConvert",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "collateralAmount", type: "uint256" },
      { name: "targetToken", type: "address" },
      { name: "minTargetOut", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "deleverage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "collateralToSell", type: "uint256" },
      { name: "minCrvUsdOut", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "deleverageAndWithdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "collateralToSell", type: "uint256" },
      { name: "minCrvUsdOut", type: "uint256" },
      { name: "withdrawAmount", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "deleverageAndWithdrawToToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "controller", type: "address" },
          { name: "collateralToSell", type: "uint256" },
          { name: "minCrvUsdOut", type: "uint256" },
          { name: "withdrawAmount", type: "uint256" },
          { name: "outputToken", type: "address" },
          { name: "minOutputFromSwap", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "deleverageSwapData", type: "bytes" },
      { name: "outputSwapData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "repayAndWithdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "repayAmount", type: "uint256" },
      { name: "withdrawAmount", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "repayAndConvert",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "repayAmount", type: "uint256" },
      { name: "withdrawAmount", type: "uint256" },
      { name: "targetToken", type: "address" },
      { name: "minTargetOut", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "repayFromTokenAndWithdraw",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minCrvusd", type: "uint256" },
      { name: "withdrawAmount", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "repayFromTokenAndConvert",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "controller", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "minCrvusd", type: "uint256" },
          { name: "withdrawAmount", type: "uint256" },
          { name: "targetToken", type: "address" },
          { name: "minTargetOut", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "inputSwapData", type: "bytes" },
      { name: "outputSwapData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "selfLiquidate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "minFromAMM", type: "uint256" },
      { name: "minFromSwap", type: "uint256" },
      { name: "percentage", type: "uint256" },
      { name: "sellAllCollateral", type: "bool" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "approveController",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    name: "approvedControllers",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// DeFi Saver deployed view contracts (mainnet)
// CurveUsdView: aggregated position + market data
export const DEFISAVER_CURVE_VIEW = "0x79fdec1d39f6282a92e5e087d10ba0b0cef89a84" as const;
// CurveUsdWithdraw: inherits LlamaLendHelper with userMaxWithdraw + getCollAmountsFromAMM
export const DEFISAVER_CURVE_HELPER = "0x54B8D984fc79B000D7B6F6E0f52CD054E965120f" as const;

export const CURVE_VIEW_ABI = [
  {
    name: "userData",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "loanExists", type: "bool" },
          { name: "collateralPrice", type: "uint256" },
          { name: "marketCollateralAmount", type: "uint256" },
          { name: "curveUsdCollateralAmount", type: "uint256" },
          { name: "debtAmount", type: "uint256" },
          { name: "N", type: "uint256" },
          { name: "priceLow", type: "uint256" },
          { name: "priceHigh", type: "uint256" },
          { name: "liquidationDiscount", type: "uint256" },
          { name: "health", type: "int256" },
          { name: "bandRange", type: "int256[2]" },
          { name: "usersBands", type: "uint256[][2]" },
        ],
      },
    ],
  },
] as const;

export const CURVE_HELPER_ABI = [
  {
    name: "userMaxWithdraw",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "controller", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getCollAmountsFromAMM",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "controller", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "crvUsdAmount", type: "uint256" },
      { name: "collAmount", type: "uint256" },
    ],
  },
] as const;

/**
 * Fetch swap data from Enso route for zapper operations.
 * The zapper holds tokens during callbacks, so fromAddress = ZAPPER_ADDRESS.
 */
export async function fetchZapperSwapData(params: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage?: string;
}): Promise<{ swapData: string; expectedOut: string }> {
  const route = await fetchRoute({
    fromAddress: ZAPPER_ADDRESS,
    receiver: ZAPPER_ADDRESS,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
    slippage: params.slippage ?? "100", // 1% default
  });

  return {
    swapData: route.tx.data,
    expectedOut: route.amountOut,
  };
}

/**
 * Fetch two swap routes for FromToken operations:
 *  1. inputSwapData: inputToken → collateral (pre-swap)
 *  2. leverageSwapData: crvUSD → collateral (callback loop)
 *
 * The zapper holds tokens during callbacks, so fromAddress = ZAPPER_ADDRESS for both.
 */
export async function fetchFromTokenSwapData(params: {
  inputToken: string;
  collateralToken: string;
  inputAmount: string;
  debtAmount: string;
  slippage?: string;
}): Promise<{
  inputSwapData: string;
  inputExpectedOut: string;
  leverageSwapData: string;
  leverageExpectedOut: string;
}> {
  const [inputRoute, leverageRoute] = await Promise.all([
    fetchZapperSwapData({
      tokenIn: params.inputToken,
      tokenOut: params.collateralToken,
      amountIn: params.inputAmount,
      slippage: params.slippage,
    }),
    fetchZapperSwapData({
      tokenIn: CRVUSD_ADDRESS,
      tokenOut: params.collateralToken,
      amountIn: params.debtAmount,
      slippage: params.slippage,
    }),
  ]);
  return {
    inputSwapData: inputRoute.swapData,
    inputExpectedOut: inputRoute.expectedOut,
    leverageSwapData: leverageRoute.swapData,
    leverageExpectedOut: leverageRoute.expectedOut,
  };
}

/**
 * Get deadline timestamp for zapper operations
 * @param minutes - Minutes from now (default 20)
 * @returns Unix timestamp as bigint
 */
export function getDeadline(minutes: number = 20): bigint {
  // On Anvil forks with time advances, wall-clock time can be behind block timestamps.
  // Use a generous deadline to avoid DeadlineExpired reverts during development.
  if (process.env.NEXT_PUBLIC_ANVIL_RPC) {
    return BigInt(Math.floor(Date.now() / 1000) + 7 * 86400); // 7 days
  }
  return BigInt(Math.floor(Date.now() / 1000) + minutes * 60);
}

/**
 * Build Enso bundle calldata for vault token -> target token conversions.
 *
 * For cvgCVX-underlying vaults (e.g. yscvgCVX):
 *   1. erc4626/redeem(vaultToken -> cvgCVX)
 *   2. erc20/approve(cvgCVX -> CVX1_CVGCVX_POOL)
 *   3. call(exchange cvgCVX -> CVX1) with min_dy slippage
 *   4. call(CVX1.withdraw -> CVX to ENSO_SHORTCUTS)
 *   5. call(routeMulti([], innerSwapData)) using pre-fetched route
 *
 * For standard vault tokens:
 *   1. erc4626/redeem(vaultToken -> underlying)
 *   2. route(underlying -> targetToken)
 *
 * The bundle API returns calldata starting with 0xb94c3609 (routeSingle)
 * which is compatible with the LlamaLendZapper contract's selector validation.
 *
 * @param params.vaultAddress - The vault token address (input token)
 * @param params.underlying - The underlying token of the vault
 * @param params.targetToken - The target collateral token for the loan
 * @param params.amountIn - Amount of vault tokens to convert (wei string)
 * @param params.estimatedUnderlying - Output from previewRedeem (wei string)
 * @param params.isCvgCvx - Whether the underlying is cvgCVX
 * @param params.estimatedCvx1 - Output from get_dy for cvgCVX path (wei string)
 * @param params.slippage - Slippage in basis points (default "100" = 1%)
 */
export async function buildVaultInputSwapBundle(params: {
  vaultAddress: string;
  underlying: string;
  targetToken: string;
  amountIn: string;
  estimatedUnderlying: string;
  isCvgCvx: boolean;
  estimatedCvx1?: string;
  slippage?: string;
}): Promise<{ swapData: string; expectedOut: string }> {
  const slippageBps = Number(params.slippage ?? "100");

  const actions: EnsoBundleAction[] = [];

  // Step 1: Redeem from vault to get underlying
  actions.push({
    protocol: "erc4626",
    action: "redeem",
    args: {
      tokenIn: params.vaultAddress,
      tokenOut: params.underlying,
      amountIn: params.amountIn,
      primaryAddress: params.vaultAddress,
    },
  });

  if (params.isCvgCvx) {
    // cvgCVX path: cvgCVX -> CVX1 (Curve pool) -> CVX (HybridZapper) -> route to target
    if (!params.estimatedCvx1) {
      throw new Error("estimatedCvx1 required for cvgCVX path");
    }
    const minDy = calculateMinDy(BigInt(params.estimatedCvx1), slippageBps);

    // Pre-fetch CVX -> targetToken route for inner swap data
    // fromAddress=ZAPPER_ADDRESS so Enso builds the route for the zapper context
    const cvxRoute = await fetchRoute({
      fromAddress: ZAPPER_ADDRESS,
      tokenIn: TOKENS.CVX,
      tokenOut: params.targetToken,
      amountIn: params.estimatedCvx1, // CVX1->CVX is 1:1
      slippage: params.slippage ?? "100",
    });
    const innerSwapData = extractInnerSwapData(cvxRoute.tx.data);

    // Action 1: approve cvgCVX -> Curve pool
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: TOKENS.CVGCVX,
        spender: TANGENT.CVX1_CVGCVX_POOL,
        amount: { useOutputOfCallAt: 0 },
      },
    });

    // Action 2: exchange cvgCVX -> CVX1
    const exchangeIdx = actions.length;
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: TANGENT.CVX1_CVGCVX_POOL.toLowerCase(),
        method: "exchange",
        abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
        args: [1, 0, { useOutputOfCallAt: 0 }, minDy.toString()],
      },
    });

    // Action 3: unwrap CVX1 -> CVX directly, sends CVX to ENSO_SHORTCUTS
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: TOKENS.CVX1.toLowerCase(),
        method: "withdraw",
        abi: "function withdraw(uint256 amount, address receiver)",
        args: [{ useOutputOfCallAt: exchangeIdx }, ENSO_SHORTCUTS],
      },
    });

    // Action 4: Recursive routeMulti — swap CVX (already in ENSO_SHORTCUTS) -> target token
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

    const bundle = await fetchBundle({
      fromAddress: ZAPPER_ADDRESS,
      actions,
      receiver: ZAPPER_ADDRESS,
      skipQuote: true, // CVX1.withdraw is void — Enso can't track output
    });

    return {
      swapData: bundle.tx.data,
      expectedOut: cvxRoute.amountOut,
    };
  } else if (params.underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase()) {
    // pxCVX path: pxCVX → lpxCVX (wrap 1:1) → CVX (Curve CryptoSwap) → routeMulti to target
    const estimatedLpxCvx = BigInt(params.estimatedUnderlying);
    const expectedCvx = await getLpxCvxToCvxSwapRate(estimatedLpxCvx.toString());
    if (expectedCvx === 0n) throw new Error("Failed to estimate lpxCVX→CVX swap output");
    const minDyCvx = calculateMinDy(expectedCvx, slippageBps);

    // Pre-fetch CVX → target route for innerSwapData
    const cvxRoute = await fetchRoute({
      fromAddress: ZAPPER_ADDRESS,
      tokenIn: TOKENS.CVX,
      tokenOut: params.targetToken,
      amountIn: expectedCvx.toString(),
      slippage: params.slippage ?? "100",
    });
    const innerSwapData = extractInnerSwapData(cvxRoute.tx.data);

    // Action 1: approve pxCVX → LPXCVX
    actions.push({ protocol: "erc20", action: "approve", args: { token: TOKENS.PXCVX, spender: PIREX.LPXCVX, amount: { useOutputOfCallAt: 0 } } });
    // Action 2: wrap pxCVX → lpxCVX (void, 1:1 ratio)
    actions.push({ protocol: "enso", action: "call", args: { address: PIREX.LPXCVX.toLowerCase(), method: "wrap", abi: "function wrap(uint256 amount)", args: [{ useOutputOfCallAt: 0 }] } });
    // Action 3: approve lpxCVX → Curve pool
    actions.push({ protocol: "erc20", action: "approve", args: { token: PIREX.LPXCVX, spender: PIREX.LPXCVX_CVX_POOL, amount: { useOutputOfCallAt: 0 } } });
    // Action 4: exchange lpxCVX → CVX (CryptoSwap uses uint256 indices)
    actions.push({ protocol: "enso", action: "call", args: { address: PIREX.LPXCVX_CVX_POOL.toLowerCase(), method: "exchange", abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) returns (uint256)", args: [String(PIREX.POOL_INDEX.LPXCVX), String(PIREX.POOL_INDEX.CVX), { useOutputOfCallAt: 0 }, minDyCvx.toString()] } });
    // Action 5: routeMulti — CVX already in ENSO_SHORTCUTS → target token
    actions.push({ protocol: "enso", action: "call", args: { address: ENSO_ROUTER_EXECUTOR.toLowerCase(), method: "routeMulti", abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)", args: [[], innerSwapData] } });

    const bundle = await fetchBundle({
      fromAddress: ZAPPER_ADDRESS,
      actions,
      receiver: ZAPPER_ADDRESS,
      skipQuote: true,
    });

    return {
      swapData: bundle.tx.data,
      expectedOut: cvxRoute.amountOut,
    };
  } else {
    // Standard vault path: redeem underlying -> route to target
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.underlying,
        tokenOut: params.targetToken,
        amountIn: { useOutputOfCallAt: 0 },
        slippage: slippageBps.toString(),
      },
    });

    const bundle = await fetchBundle({
      fromAddress: ZAPPER_ADDRESS,
      actions,
      receiver: ZAPPER_ADDRESS,
    });

    return {
      swapData: bundle.tx.data,
      expectedOut: Object.values(bundle.amountsOut ?? {})[0] ?? params.estimatedUnderlying,
    };
  }
}

/**
 * Build Enso bundle swapData for exotic token output direction (crvUSD -> exotic token).
 *
 * For cvgCVX: crvUSD -> CVX (Enso route) -> CVX1 (mint 1:1) -> cvgCVX (Curve pool) -> ZAPPER
 * For pxCVX: crvUSD -> CVX (Enso route) -> lpxCVX (Curve pool) -> pxCVX (unwrap) -> ZAPPER
 *
 * The swapData is a complete routeSingle-compatible calldata that the Zapper can call directly.
 * Output token is transferred to ZAPPER_ADDRESS so the Zapper can forward it to the user.
 */
export async function buildExoticOutputSwapData(params: {
  amountIn: string; // crvUSD amount in wei
  type: "cvgCvx" | "pxCvx";
  slippage: number; // basis points
}): Promise<{ swapData: string; expectedOut: string }> {
  // 1. Fetch route crvUSD -> CVX to get estimate + innerSwapData
  const cvxRoute = await fetchRoute({
    fromAddress: ZAPPER_ADDRESS,
    tokenIn: CRVUSD_ADDRESS,
    tokenOut: TOKENS.CVX,
    amountIn: params.amountIn,
    slippage: params.slippage.toString(),
  });
  const innerSwapData = extractInnerSwapData(cvxRoute.tx.data);

  let actions: EnsoBundleAction[];
  let expectedOut: string;

  if (params.type === "cvgCvx") {
    const conservativeCvx = calculateMinDy(BigInt(cvxRoute.amountOut), params.slippage);
    const expectedCvgCvx = await getCvgCvxSwapRate(conservativeCvx.toString());
    if (expectedCvgCvx === 0n) {
      throw new Error("Failed to estimate Curve CVX1→cvgCVX swap output");
    }
    const minDyCvgCvx = calculateMinDy(expectedCvgCvx, params.slippage);

    // cvgCVX path: crvUSD -> CVX -> CVX1 (mint 1:1) -> cvgCVX (Curve exchange) -> ZAPPER
    actions = [
      // 0: routeMulti -- swap crvUSD (already in ENSO_SHORTCUTS from Zapper's routeSingle pull) -> CVX
      {
        protocol: "enso", action: "call",
        args: { address: ENSO_ROUTER_EXECUTOR.toLowerCase(), method: "routeMulti", abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)", args: [[], innerSwapData] },
      },
      // 1: Get CVX balance at ENSO_SHORTCUTS
      {
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX.toLowerCase(), method: "balanceOf", abi: "function balanceOf(address account) returns (uint256)", args: [ENSO_SHORTCUTS] },
      },
      // 2: Approve CVX -> CVX1 wrapper for minting
      {
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [TOKENS.CVX1.toLowerCase(), { useOutputOfCallAt: 1 }] },
      },
      // 3: Mint CVX1 from CVX (1:1, void)
      {
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX1.toLowerCase(), method: "mint", abi: "function mint(address to, uint256 amount)", args: [ENSO_SHORTCUTS, { useOutputOfCallAt: 1 }] },
      },
      // 4: Approve CVX1 -> Curve CVX1/cvgCVX pool
      {
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX1.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [TANGENT.CVX1_CVGCVX_POOL.toLowerCase(), { useOutputOfCallAt: 1 }] },
      },
      // 5: Curve exchange CVX1 -> cvgCVX (stableswap, int128 indices: 0=CVX1, 1=cvgCVX)
      {
        protocol: "enso", action: "call",
        args: { address: TANGENT.CVX1_CVGCVX_POOL.toLowerCase(), method: "exchange", abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)", args: ["0", "1", { useOutputOfCallAt: 1 }, minDyCvgCvx.toString()] },
      },
      // 6: Transfer cvgCVX to ZAPPER_ADDRESS
      {
        protocol: "erc20", action: "transfer",
        args: { token: TOKENS.CVGCVX, receiver: ZAPPER_ADDRESS, amount: { useOutputOfCallAt: 5 } },
      },
    ];

    expectedOut = expectedCvgCvx.toString();
  } else {
    const conservativeCvx = calculateMinDy(BigInt(cvxRoute.amountOut), params.slippage);
    const expectedLpxCvx = await getCurveGetDyFactory(
      PIREX.LPXCVX_CVX_POOL,
      PIREX.POOL_INDEX.CVX,
      PIREX.POOL_INDEX.LPXCVX,
      conservativeCvx.toString(),
    );
    if (!expectedLpxCvx || expectedLpxCvx === 0n) {
      throw new Error("Failed to estimate Curve CVX→lpxCVX swap output");
    }
    const minDyLpxCvx = calculateMinDy(expectedLpxCvx, params.slippage);

    // pxCVX path: crvUSD -> CVX -> lpxCVX (Curve CryptoSwap) -> pxCVX (unwrap) -> ZAPPER
    actions = [
      // 0: routeMulti -- swap crvUSD -> CVX
      {
        protocol: "enso", action: "call",
        args: { address: ENSO_ROUTER_EXECUTOR.toLowerCase(), method: "routeMulti", abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)", args: [[], innerSwapData] },
      },
      // 1: Get CVX balance at ENSO_SHORTCUTS
      {
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX.toLowerCase(), method: "balanceOf", abi: "function balanceOf(address account) returns (uint256)", args: [ENSO_SHORTCUTS] },
      },
      // 2: Approve CVX -> Curve lpxCVX/CVX pool
      {
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [PIREX.LPXCVX_CVX_POOL.toLowerCase(), { useOutputOfCallAt: 1 }] },
      },
      // 3: Curve exchange CVX -> lpxCVX (CryptoSwap, uint256 indices)
      {
        protocol: "enso", action: "call",
        args: { address: PIREX.LPXCVX_CVX_POOL.toLowerCase(), method: "exchange", abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)", args: [String(PIREX.POOL_INDEX.CVX), String(PIREX.POOL_INDEX.LPXCVX), { useOutputOfCallAt: 1 }, minDyLpxCvx.toString()] },
      },
      // 4: Approve lpxCVX -> LPXCVX contract (for unwrap)
      {
        protocol: "enso", action: "call",
        args: { address: PIREX.LPXCVX.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [PIREX.LPXCVX.toLowerCase(), { useOutputOfCallAt: 3 }] },
      },
      // 5: Unwrap lpxCVX -> pxCVX (void, 1:1)
      {
        protocol: "enso", action: "call",
        args: { address: PIREX.LPXCVX.toLowerCase(), method: "unwrap", abi: "function unwrap(uint256 amount)", args: [{ useOutputOfCallAt: 3 }] },
      },
      // 6: Transfer pxCVX to ZAPPER_ADDRESS
      {
        protocol: "erc20", action: "transfer",
        args: { token: TOKENS.PXCVX, receiver: ZAPPER_ADDRESS, amount: { useOutputOfCallAt: 3 } },
      },
    ];

    expectedOut = expectedLpxCvx.toString();
  }

  // Build and return bundle
  const bundle = await fetchBundle({
    fromAddress: ZAPPER_ADDRESS,
    actions,
    receiver: ZAPPER_ADDRESS,
    skipQuote: true,
  });

  return {
    swapData: bundle.tx.data,
    expectedOut,
  };
}
