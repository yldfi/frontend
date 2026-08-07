/**
 * Canonical ERC20 storage slots used when overriding contract state in
 * simulations (e.g. Tenderly storage overrides in /api/simulate).
 *
 * The allowance mapping base slot varies per token implementation:
 *   - Standard OpenZeppelin ERC20 → slot 1 (balances @ 0, allowances @ 1)
 *   - Vyper ERC20 (e.g. many Curve tokens) → allowance at slot 4
 *   - Proxies / upgradeable / custom contracts (USDC, WETH, etc.) → elsewhere
 *
 * These values are verified against on-chain state — see the zap integration
 * tests (src/__tests__/integration/enso-zap.integration.test.ts) which key
 * balance/allowance overrides off the same per-token slot layout.
 */

import { USDC_ADDRESS, WETH_ADDRESS } from "@/config/addresses";
import { TOKENS } from "@/config/vaults";

// CRV is referenced only by its literal address here (it lives in lib/enso).
const CRV_ADDRESS = "0xD533a949740bb3306d119CC777fa900bA034cd52";

export const TOKEN_ALLOWANCE_SLOTS: Record<string, number> = {
  // Standard OpenZeppelin ERC20 (balances @ 0, allowances @ 1)
  [CRV_ADDRESS.toLowerCase()]: 1, // CRV
  [TOKENS.CVX.toLowerCase()]: 1, // CVX
  [TOKENS.CVXCRV.toLowerCase()]: 1, // cvxCRV
  [TOKENS.STKCVXCRV.toLowerCase()]: 1, // stkcvxCRV
  [TOKENS.PXCVX.toLowerCase()]: 1, // pxCVX
  // ERC20Upgradeable (OpenZeppelin) — allowance after Initializable's 50-slot gap
  [TOKENS.CVX1.toLowerCase()]: 52,
  [TOKENS.CVGCVX.toLowerCase()]: 52, // cvgCVX
  // WETH — custom implementation
  [WETH_ADDRESS.toLowerCase()]: 4,
  // USDC — FiatTokenV2 proxy
  [USDC_ADDRESS.toLowerCase()]: 10,
};

/** Default base slot for the ERC20 allowance mapping (OpenZeppelin). */
export const DEFAULT_ALLOWANCE_SLOT = 1;

/**
 * Return the storage base slot for a token's allowance mapping, defaulting to
 * the standard OpenZeppelin slot (1). Tokens with a non-standard layout that
 * aren't listed will default to slot 1 — which, if wrong, makes any override a
 * safe no-op rather than a corrupting write.
 */
export function getERC20AllowanceSlot(address: string): number {
  return TOKEN_ALLOWANCE_SLOTS[address.toLowerCase()] ?? DEFAULT_ALLOWANCE_SLOT;
}
