// Enso API Types
// SDK types: https://github.com/EnsoBuild/sdk-ts
import type { BundleData, BundleAction as SdkBundleAction } from "@ensofinance/sdk";

// Re-export SDK types for convenience
export type { BundleData, SdkBundleAction as BundleAction };

// Extract Hop type from BundleData.route (SDK doesn't export it directly)
export type Hop = NonNullable<BundleData["route"]>[number];

// Simplified token type for UI display
// SDK's TokenData has more fields (project, protocolSlug, apy, tvl, etc.)
// and nullable name/symbol which complicates UI usage
export interface EnsoToken {
  address: string;
  chainId: number;
  name: string;     // Non-nullable for UI convenience (SDK has string | null)
  symbol: string;   // Non-nullable for UI convenience (SDK has string | null)
  decimals: number;
  logoURI?: string; // Single logo URL (SDK has logosUri: string[])
  type: "base" | "defi";
}

export interface EnsoTokensResponse {
  data: EnsoToken[];
  meta: {
    total: number;
    lastPage: number;
    currentPage: number;
    perPage: number;
  };
}

// Route response from Enso /v1/shortcuts/route endpoint
export interface EnsoRouteResponse {
  tx: {
    to: string;
    data: string;
    value: string;
  };
  gas: string;
  amountOut: string;
  priceImpact?: number;
  route: EnsoRouteStep[];
}

export interface EnsoRouteStep {
  action: string;
  protocol: string;
  tokenIn: string[];
  tokenOut: string[];
  amountIn: string[];
  amountOut: string[];
}

// Processed zap quote for UI
export interface ZapQuote {
  inputToken: EnsoToken;
  inputAmount: string;
  outputAmount: string;
  outputAmountFormatted: string;
  exchangeRate: number;
  // USD values for calculating real price impact
  inputUsdValue: number | null;
  outputUsdValue: number | null;
  // Calculated from USD values: ((inputUsd - outputUsd) / inputUsd) × 100
  // Positive = loss, Negative = gain
  priceImpact: number | null;
  gasEstimate: string;
  tx: EnsoRouteResponse["tx"];
  route: EnsoRouteStep[];
  // Route info for display (custom routes)
  routeInfo?: RouteInfo;
}

// Zap direction
export type ZapDirection = "in" | "out";

// Simplified bundle action type for our use cases
// SDK exports strict BundleAction union type (RouteAction | DepositAction | RedeemAction | ...)
// We use this simpler type for flexibility with custom actions
export interface EnsoBundleAction {
  protocol: string;
  action: string;
  args: {
    tokenIn?: string;
    tokenOut?: string;
    amountIn?: string | { useOutputOfCallAt: number };
    primaryAddress?: string;
    receiver?: string;
    [key: string]: unknown;
  };
}

// Simplified bundle response type
// SDK's BundleData has more fields (bundle, createdAt, feeAmount)
// We use this subset for our response handling
export interface EnsoBundleResponse {
  tx: {
    to: string;
    data: string;
    value: string;
    from: string;
  };
  gas: string;
  amountsOut: Record<string, string>;
  route?: Hop[];  // Route steps from SDK BundleData.route
  priceImpact?: number | null;
}

// Individual route step for detailed display
export interface RouteStep {
  tokenSymbol: string;      // Token symbol shown in the pill (output of this step)
  tokenAddress?: string;    // Address for icon lookup
  action: string;           // "Swap", "Mint", "Lock", "Stake", "Deposit", "Redeem", "Withdraw"
  description: string;      // Full description like "ETH for CVX" or "cvgCVX with CVX"
  protocol: string;         // Protocol name (e.g., "Enso", "Curve", "Convex", "Yearn")
  amount?: string;          // Optional: formatted amount for this step
  bonus?: number;           // Optional: bonus % for this step (e.g., +2.5% from Curve swap)
  bonusAmount?: string;     // Optional: bonus amount (e.g., "2.5" extra tokens vs 1:1 mint)
  bonusSymbol?: string;     // Optional: token symbol for bonus (e.g., "cvgCVX")
}

// Route info for display
export interface RouteInfo {
  steps: RouteStep[];       // Detailed steps for visual display
  // Legacy format (backward compat)
  tokens?: string[];        // Token symbols: ["ETH", "CVX", "cvgCVX", "yscvgCVX"]
  protocols?: string[];     // Protocols: ["Enso", "Curve", "Yearn"]
  // Hybrid route details (cvgCVX/pxCVX only)
  hybrid?: {
    swapAmount: string;     // Amount swapped via Curve (formatted)
    mintAmount: string;     // Amount minted 1:1 (formatted)
    swapBonus: number;      // Bonus % from swap (e.g., 2.5 = +2.5%)
    swapProtocol: string;   // "Curve"
    mintProtocol: string;   // "Convex" or "Pirex"
  };
}

// Extended bundle response with route info
export interface CustomBundleResponse extends EnsoBundleResponse {
  routeInfo: RouteInfo;
}
