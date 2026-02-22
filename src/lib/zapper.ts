// LlamaLendZapperV2 contract integration
// Contract: https://etherscan.io/address/0x39F2a82b6CE1631128829c5Bb7449Cc7a40d2a47
// Enables leveraged Curve LlamaLend operations via Enso Router swaps

import { fetchRoute } from "@/lib/enso";

// LlamaLendZapper V1 contract address (mainnet, deprecated)
export const ZAPPER_ADDRESS = "0x18Fb52A4D65E03ebD25FbD2Fae60452c286eC5F1" as const;

// LlamaLendZapperV2 contract address (mainnet)
export const ZAPPER_V2_ADDRESS = "0x39F2a82b6CE1631128829c5Bb7449Cc7a40d2a47" as const;

// crvUSD token address
export const CRVUSD_ADDRESS = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E" as const;

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
 * The zapper holds tokens during callbacks, so fromAddress = ZAPPER_V2_ADDRESS.
 */
export async function fetchZapperSwapData(params: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage?: string;
}): Promise<{ swapData: string; expectedOut: string }> {
  const route = await fetchRoute({
    fromAddress: ZAPPER_V2_ADDRESS,
    receiver: ZAPPER_V2_ADDRESS,
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
 * The zapper holds tokens during callbacks, so fromAddress = ZAPPER_V2_ADDRESS for both.
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
