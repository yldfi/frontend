// LlamaLendZapperV3 contract integration
// Contract: https://etherscan.io/address/0x7097aF57f5A1C14a8f28F7d624e8A464A006e08e
// Enables leveraged Curve LlamaLend operations via Enso Router swaps

import { fetchRoute, fetchBundle, ENSO_SHORTCUTS, ENSO_ROUTER_EXECUTOR, CVX_HYBRID_ZAPPER, getLpxCvxToCvxSwapRate, computeHybridZapParams } from "@/lib/enso";
import { calculateMinDy } from "@/lib/curve";
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
function extractInnerSwapData(routeTxData: string): `0x${string}` {
  const decoded = decodeFunctionData({
    abi: ROUTE_SINGLE_ABI,
    data: routeTxData as `0x${string}`,
  });
  if (!decoded.args) {
    throw new Error("Failed to decode routeSingle calldata — no args returned");
  }
  return decoded.args[1] as `0x${string}`;
}

// Re-export for backwards compatibility (prefer importing from @/config/addresses directly)
export { CRVUSD_ADDRESS };

// LlamaLendZapper V1 contract address (mainnet, deprecated)
export const ZAPPER_ADDRESS = "0x18Fb52A4D65E03ebD25FbD2Fae60452c286eC5F1" as const;

// LlamaLendZapperV3 contract address (mainnet, overridable via env for fork testing)
export const ZAPPER_V3_ADDRESS = (process.env.NEXT_PUBLIC_ZAPPER_V3_ADDRESS ?? "0x7097aF57f5A1C14a8f28F7d624e8A464A006e08e") as `0x${string}`;

// LlamaLendZapperV2 ABI - write functions only (views via DeFi Saver's CurveUsdView/CurveUsdWithdraw)
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
    name: "deleverage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "collateralToSell", type: "uint256" },
      { name: "minCrvusdFromSwap", type: "uint256" },
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
    name: "approvedControllers",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "controller", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  // ZapperV2 — FromToken/ToToken operations
  {
    name: "createLeveragedLoanFromToken",
    type: "function",
    stateMutability: "nonpayable",
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
    name: "leverageUpFromToken",
    type: "function",
    stateMutability: "nonpayable",
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
    name: "deleverageAndWithdrawToToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "collateralToSell", type: "uint256" },
      { name: "minCrvUsdOut", type: "uint256" },
      { name: "withdrawAmount", type: "uint256" },
      { name: "outputToken", type: "address" },
      { name: "minOutputFromSwap", type: "uint256" },
      { name: "deleverageSwapData", type: "bytes" },
      { name: "outputSwapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  // ZapperV3 — Borrow + convert/deposit operations
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
    name: "borrowAndDeposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "additionalCollateral", type: "uint256" },
      { name: "debt", type: "uint256" },
      { name: "vault", type: "address" },
      { name: "minVaultShares", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  // ZapperV3 — Remove collateral + convert
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
  // ZapperV3 — Repay + withdraw flows
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
    stateMutability: "nonpayable",
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
    stateMutability: "nonpayable",
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
  // ZapperV4 — Borrow + swap collateral
  {
    name: "borrowMoreFromToken",
    type: "function",
    stateMutability: "nonpayable",
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

// Controller approve ABI - approve(address, bool) NOT ERC20 approve(address, uint256)
export const CONTROLLER_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    name: "approval",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * Fetch swap data from Enso route for zapper operations.
 * The zapper holds tokens during callbacks, so fromAddress = ZAPPER_V3_ADDRESS.
 */
export async function fetchZapperSwapData(params: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage?: string;
}): Promise<{ swapData: string; expectedOut: string }> {
  const route = await fetchRoute({
    fromAddress: ZAPPER_V3_ADDRESS,
    receiver: ZAPPER_V3_ADDRESS,
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
 * The zapper holds tokens during callbacks, so fromAddress = ZAPPER_V3_ADDRESS for both.
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
 *   4. erc20/transfer(CVX1 -> CVX_HYBRID_ZAPPER)
 *   5. call(unwrapCvx1ToCvx -> ENSO_SHORTCUTS)
 *   6. call(routeMulti([], innerSwapData)) using pre-fetched route
 *
 * For standard vault tokens:
 *   1. erc4626/redeem(vaultToken -> underlying)
 *   2. route(underlying -> targetToken)
 *
 * The bundle API returns calldata starting with 0xb94c3609 (routeSingle)
 * which is compatible with the ZapperV2 contract's selector validation.
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
    // fromAddress=ZAPPER_V3_ADDRESS so Enso builds the route for the zapper context
    const cvxRoute = await fetchRoute({
      fromAddress: ZAPPER_V3_ADDRESS,
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

    // Action 3: transfer CVX1 to HybridZapper
    actions.push({
      protocol: "erc20",
      action: "transfer",
      args: {
        token: TOKENS.CVX1,
        receiver: CVX_HYBRID_ZAPPER,
        amount: { useOutputOfCallAt: exchangeIdx },
      },
    });

    // Action 4: unwrap CVX1 -> CVX via HybridZapper, send to ENSO_SHORTCUTS
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: CVX_HYBRID_ZAPPER,
        method: "unwrapCvx1ToCvx",
        abi: "function unwrapCvx1ToCvx(uint256 amount, address receiver) returns (uint256)",
        args: [{ useOutputOfCallAt: exchangeIdx }, ENSO_SHORTCUTS],
      },
    });

    // Action 5: Recursive routeMulti — swap CVX (already in ENSO_SHORTCUTS) -> target token
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
      fromAddress: ZAPPER_V3_ADDRESS,
      actions,
      receiver: ZAPPER_V3_ADDRESS,
      skipQuote: true, // HybridZapper calls can't be simulated by Enso
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
      fromAddress: ZAPPER_V3_ADDRESS,
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
      fromAddress: ZAPPER_V3_ADDRESS,
      actions,
      receiver: ZAPPER_V3_ADDRESS,
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
      fromAddress: ZAPPER_V3_ADDRESS,
      actions,
      receiver: ZAPPER_V3_ADDRESS,
    });

    return {
      swapData: bundle.tx.data,
      expectedOut: Object.values(bundle.amountsOut ?? {})[0] ?? params.estimatedUnderlying,
    };
  }
}

/**
 * Build Enso bundle swapData for exotic vault output direction (crvUSD → exotic underlying).
 *
 * Used by V3/V4 Zapper's borrowAndDeposit: the Zapper calls routeSingle(swapData) to convert
 * crvUSD → underlying, then deposits into the vault. For exotic tokens (cvgCVX, pxCVX),
 * the path is: crvUSD → CVX (via Enso route) → HybridZapper → underlying.
 *
 * The swapData is a complete routeSingle-compatible calldata that the Zapper can call directly.
 * HybridZapper sends the underlying to ZAPPER_V3_ADDRESS so the Zapper can deposit it.
 */
export async function buildExoticOutputSwapData(params: {
  amountIn: string; // crvUSD amount in wei
  type: "cvgCvx" | "pxCvx";
  slippage: number; // basis points
}): Promise<{ swapData: string; expectedOut: string }> {
  // 1. Fetch route crvUSD → CVX to get estimate + innerSwapData
  const cvxRoute = await fetchRoute({
    fromAddress: ZAPPER_V3_ADDRESS,
    tokenIn: CRVUSD_ADDRESS,
    tokenOut: TOKENS.CVX,
    amountIn: params.amountIn,
    slippage: params.slippage.toString(),
  });
  const innerSwapData = extractInnerSwapData(cvxRoute.tx.data);

  // 2. Get HybridZapper optimal swap/mint split params
  const zapParams = await computeHybridZapParams(cvxRoute.amountOut, params.type, params.slippage);

  const method = params.type === "cvgCvx" ? "zapCvxToCvgCvxWithParams" : "zapCvxToPxCvxWithParams";
  const abi = params.type === "cvgCvx"
    ? "function zapCvxToCvgCvxWithParams(uint256 amountIn, uint256 swapAmount, uint256 minDy, uint256 minTotalOut, address receiver, uint256 deadline) returns (uint256)"
    : "function zapCvxToPxCvxWithParams(uint256 amountIn, uint256 swapAmount, uint256 minDy, uint256 minTotalOut, address receiver, uint256 deadline) returns (uint256)";

  // 3. Build bundle: routeMulti(crvUSD→CVX), balanceOf, approve, HybridZapper zap
  const actions: EnsoBundleAction[] = [
    // 0: routeMulti — swap crvUSD (already in ENSO_SHORTCUTS from Zapper's routeSingle pull) → CVX
    {
      protocol: "enso", action: "call",
      args: { address: ENSO_ROUTER_EXECUTOR.toLowerCase(), method: "routeMulti", abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)", args: [[], innerSwapData] },
    },
    // 1: Get CVX balance in ENSO_SHORTCUTS
    {
      protocol: "enso", action: "call",
      args: { address: TOKENS.CVX.toLowerCase(), method: "balanceOf", abi: "function balanceOf(address account) returns (uint256)", args: [ENSO_SHORTCUTS] },
    },
    // 2: Approve CVX → HybridZapper
    {
      protocol: "enso", action: "call",
      args: { address: TOKENS.CVX.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [CVX_HYBRID_ZAPPER!, { useOutputOfCallAt: 1 }] },
    },
    // 3: HybridZapper zap — receiver = ZAPPER so it can deposit into vault
    {
      protocol: "enso", action: "call",
      args: {
        address: CVX_HYBRID_ZAPPER!,
        method,
        abi,
        args: [{ useOutputOfCallAt: 1 }, zapParams.swapAmount.toString(), zapParams.minSwapDy, zapParams.minTotalOut, ZAPPER_V3_ADDRESS, "0"],
      },
    },
  ];

  // 4. Build and return bundle
  const bundle = await fetchBundle({
    fromAddress: ZAPPER_V3_ADDRESS,
    actions,
    receiver: ZAPPER_V3_ADDRESS,
    skipQuote: true, // HybridZapper calls can't be simulated by Enso
  });

  return {
    swapData: bundle.tx.data,
    expectedOut: zapParams.minTotalOut, // conservative estimate (slippage already applied)
  };
}
