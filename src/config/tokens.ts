import { CRVUSD_ADDRESS } from "@/config/addresses";
import { CURVE_SAVINGS } from "@/config/vaults";
import type { EnsoToken } from "@/types/enso";

// crvUSD default token for TokenSelector
export const CRVUSD_TOKEN: EnsoToken = {
  address: CRVUSD_ADDRESS,
  chainId: 1,
  name: "Curve.Fi USD Stablecoin",
  symbol: "crvUSD",
  decimals: 18,
  logoURI: "/tokens/crvusd.png",
  type: "base",
};

// scrvUSD (Savings crvUSD) - ERC4626 vault for crvUSD
export const SCRVUSD_TOKEN: EnsoToken = {
  address: CURVE_SAVINGS.SCRVUSD,
  chainId: 1,
  name: "Savings crvUSD",
  symbol: "scrvUSD",
  decimals: 18,
  logoURI: "/tokens/scrvusd.png",
  type: "defi",
};
