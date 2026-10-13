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

// Token prices keyed by lowercase address. /api/enso/prices answers with the requested subset in
// the Enso SDK's getMultiplePriceData shape (see enso-proxy mocks in api-mocks.ts).
export const mockTokenPrices: Record<string, { symbol: string; decimals: number; price: number }> = {
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": { symbol: "ETH", decimals: 18, price: 2450 },
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18, price: 2450 },
  "0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b": { symbol: "CVX", decimals: 18, price: 2.015 },
  "0x2191df768ad71140f9f3e96c1e4407a4aa31d082": { symbol: "cvgCVX", decimals: 18, price: 1.5 },
  "0x62b9c7356a2dc64a1969e19c23e4f579f9810aa7": { symbol: "cvxCRV", decimals: 18, price: 0.1417 },
  "0xbce0cf87f513102f22232436cca2ca49e815c3ac": { symbol: "pxCVX", decimals: 18, price: 1.8775 },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6, price: 1 },
};

// /api/vaults: the cache worker's payload (snapshot of production, 2026-10-13).
export const mockVaultsResponse = {
  "ycvxcrv": {
    "address": "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86",
    "totalAssets": "1637894916770316051176",
    "pricePerShare": "1995506641007196168",
    "tvl": 1637.894917,
    "pps": 1.995507,
    "tvlUsd": 232.539501,
    "apy": 0
  },
  "yscvxcrv": {
    "address": "0xCa960E6DF1150100586c51382f619efCCcF72706",
    "totalAssets": "145631955315203042776603",
    "pricePerShare": "1130608313488681672",
    "tvl": 145631.955315,
    "pps": 1.130608,
    "tvlUsd": 20676.04105,
    "apy": 9.220867
  },
  "ycvgcvx": {
    "address": "0x0849b046292293f78dF3002F8461f8A7e2eC2b82",
    "totalAssets": "47202843283564594936937",
    "pricePerShare": "1175961228149476052",
    "tvl": 47202.843284,
    "pps": 1.175961,
    "tvlUsd": 69467.8107,
    "apy": null
  },
  "yscvgcvx": {
    "address": "0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359",
    "totalAssets": "47463792047238039411412",
    "pricePerShare": "1184658919985428900",
    "tvl": 47463.792047,
    "pps": 1.184659,
    "tvlUsd": 69851.845657,
    "apy": 15.52011
  },
  "yscvx": {
    "address": "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e",
    "totalAssets": "4717893846936776322024",
    "pricePerShare": "1000774944278806504",
    "tvl": 4717.893847,
    "pps": 1.000775,
    "tvlUsd": 9507.850029,
    "apy": 5.401902
  },
  "yspxcvx": {
    "address": "0xB246DB2A73EEE3ee026153660c74657C123f8E42",
    "totalAssets": "17832251851533502448",
    "pricePerShare": "1000000000000000000",
    "tvl": 17.832252,
    "pps": 1,
    "tvlUsd": 33.480152,
    "apy": null
  },
  "cvxCrvPrice": 0.141746,
  "cvgCvxPrice": 1.500342,
  "cvxPrice": 2.015274,
  "pxCvxPrice": 1.877506,
  "lastUpdated": "2026-10-13T00:00:00.000Z"
};

// /api/enso/tokens: the Enso SDK getTokenData shape ({ data, meta }).
export const mockTokensResponse = {
  data: [
    { address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", chainId: 1, symbol: "ETH", name: "Ethereum", decimals: 18, logosUri: ["/tokens/eth.png"], type: "base" },
    { address: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B", chainId: 1, symbol: "CVX", name: "Convex Finance", decimals: 18, logosUri: ["/tokens/cvx.png"], type: "base" },
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chainId: 1, symbol: "USDC", name: "USDC", decimals: 6, logosUri: ["/tokens/usdc.png"], type: "base" },
  ],
  meta: { total: 3, lastPage: 1, currentPage: 1, perPage: 1000, prev: null, next: null },
};

// /api/history: { data: { timeseries } }, the same shape as Kong's history endpoints.
export const mockHistoryResponse = {
  data: {
    timeseries: Array.from({ length: 8 }, (_, i) => ({
      time: String(1759276800 + i * 86400), // daily from 2025-10-01
      value: 1 + i * 0.001,
    })),
  },
};

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
