// Curve LlamaLend read-only view helpers (DeFi Saver deployed contracts).
// Used to read aggregated position/market data and max-withdraw amounts.

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
