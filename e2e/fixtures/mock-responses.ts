/**
 * Mock API responses for E2E tests
 * These match the structure of real Enso API responses
 */

// Mock Enso bundle response for zap in
export const mockZapInBundleResponse = {
  tx: {
    to: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
    data: "0x123456789...",
    value: "1000000000000000000", // 1 ETH
    from: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  },
  gas: "567239",
  amountOut: "1489846100000000000000", // ~1489 yscvgCVX
  route: [
    {
      action: "route",
      protocol: "enso",
      tokenIn: ["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
      tokenOut: ["0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B"],
      amountIn: ["1000000000000000000"],
      amountOut: ["1538757500000000000000"],
    },
    {
      action: "call",
      protocol: "curve",
      tokenIn: ["0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B"],
      tokenOut: ["0x2191DF768ad71140F9F3E96c1e4407A4aA31d082"],
      amountIn: ["1538757500000000000000"],
      amountOut: ["1543714500000000000000"],
    },
    {
      action: "deposit",
      protocol: "erc4626",
      tokenIn: ["0x2191DF768ad71140F9F3E96c1e4407A4aA31d082"],
      tokenOut: ["0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359"],
      amountIn: ["1543714500000000000000"],
      amountOut: ["1489846100000000000000"],
    },
  ],
};

// Mock Enso bundle response for zap out
export const mockZapOutBundleResponse = {
  tx: {
    to: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
    data: "0x987654321...",
    value: "0",
    from: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  },
  gas: "450000",
  amountOut: "950000000000000000", // ~0.95 ETH
  route: [
    {
      action: "redeem",
      protocol: "erc4626",
      tokenIn: ["0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359"],
      tokenOut: ["0x2191DF768ad71140F9F3E96c1e4407A4aA31d082"],
      amountIn: ["1000000000000000000000"],
      amountOut: ["1036200000000000000000"],
    },
    {
      action: "route",
      protocol: "enso",
      tokenIn: ["0x2191DF768ad71140F9F3E96c1e4407A4aA31d082"],
      tokenOut: ["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
      amountIn: ["1036200000000000000000"],
      amountOut: ["950000000000000000"],
    },
  ],
};

// Mock token prices response
export const mockPricesResponse = {
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": 3250.5,
  "0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b": 2.15, // CVX
  "0x2191df768ad71140f9f3e96c1e4407a4aa31d082": 2.05, // cvgCVX
  "0x8ed5ab1ba2b2e434361858cbd3ca9f374e8b0359": 2.12, // yscvgCVX
  "0x62b9c7356a2dc64a1969e19c23e4f579f9810aa7": 0.85, // cvxCRV
};

// Mock vaults API response
export const mockVaultsResponse = [
  {
    id: "ycvxcrv",
    name: "cvxCRV Compounder",
    symbol: "ycvxCRV",
    address: "0xCa960E6DF1150100586c51382f619efCCcF72706",
    assetAddress: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7",
    assetSymbol: "cvxCRV",
    assetDecimals: 18,
    decimals: 18,
    apy: 12.5,
    tvl: 1250000,
    pricePerShare: 1.0523,
    category: "curve",
  },
  {
    id: "yscvgcvx",
    name: "Staked cvgCVX Compounder",
    symbol: "yscvgCVX",
    address: "0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359",
    assetAddress: "0x2191DF768ad71140F9F3E96c1e4407A4aA31d082",
    assetSymbol: "cvgCVX",
    assetDecimals: 18,
    decimals: 18,
    apy: 32.06,
    tvl: 89600,
    pricePerShare: 1.0362,
    category: "convex",
  },
];

// Mock Enso tokens response
export const mockTokensResponse = [
  {
    address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    logoUri: "/tokens/eth.png",
  },
  {
    address: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B",
    symbol: "CVX",
    name: "Convex Finance",
    decimals: 18,
    logoUri: "/tokens/cvx.png",
  },
  {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    name: "USDC",
    decimals: 6,
    logoUri: "/tokens/usdc.png",
  },
];

// Mock route response for standard Enso route
export const mockRouteResponse = {
  tokenIn: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  tokenOut: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7",
  amountIn: "1000000000000000000",
  amountOut: "3850000000000000000000",
  gas: "350000",
  route: [
    {
      action: "swap",
      protocol: "enso",
      tokenIn: ["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
      tokenOut: ["0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7"],
      amountIn: ["1000000000000000000"],
      amountOut: ["3850000000000000000000"],
    },
  ],
};
