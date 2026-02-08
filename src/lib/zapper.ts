// LlamaLendZapper contract integration
// Contract: https://etherscan.io/address/0x18Fb52A4D65E03ebD25FbD2Fae60452c286eC5F1
// Enables leveraged Curve LlamaLend operations via Enso Router swaps

import { fetchRoute } from "@/lib/enso";

// LlamaLendZapper contract address (mainnet)
export const ZAPPER_ADDRESS = "0x18Fb52A4D65E03ebD25FbD2Fae60452c286eC5F1" as const;

// crvUSD token address
export const CRVUSD_ADDRESS = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E" as const;

// LlamaLendZapper ABI - write functions + view functions
export const ZAPPER_ABI = [
  // === Write Functions ===
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
    name: "selfLiquidate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "minFromAMM", type: "uint256" },
      { name: "minFromSwap", type: "uint256" },
      { name: "percentage", type: "uint256" },
      { name: "swapData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  // === View Functions ===
  {
    name: "getPosition",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "controller", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "debt", type: "uint256" },
      { name: "collateral", type: "uint256" },
      { name: "health", type: "int256" },
      { name: "prices", type: "uint256[2]" },
    ],
  },
  {
    name: "maxLeveragedBorrow",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "controller", type: "address" },
      { name: "userCollateral", type: "uint256" },
      { name: "leverageCollateral", type: "uint256" },
      { name: "N", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
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
 * Get deadline timestamp for zapper operations
 * @param minutes - Minutes from now (default 20)
 * @returns Unix timestamp as bigint
 */
export function getDeadline(minutes: number = 20): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + minutes * 60);
}
