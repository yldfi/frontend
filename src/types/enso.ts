// Enso API Types

// Token data from Enso /v1/tokens endpoint
export interface EnsoToken {
  address: string;
  chainId: number;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
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
}

// Zap direction
export type ZapDirection = "in" | "out";

// Bundle action for combining multiple DeFi operations
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

// Bundle response from Enso /v1/shortcuts/bundle endpoint
export interface EnsoBundleResponse {
  tx: {
    to: string;
    data: string;
    value: string;
    from: string;
  };
  gas: string;
  amountsOut: Record<string, string>;
  priceImpact?: number | null;
}
