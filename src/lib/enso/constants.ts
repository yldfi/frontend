import type { Hex } from "viem";
import {
  ENSO_ROUTER_V1 as ENSO_ROUTER_V1_ADDRESS,
  ENSO_ROUTER_V2 as ENSO_ROUTER_V2_ADDRESS,
  ENSO_SHORTCUTS as ENSO_SHORTCUTS_ADDRESS,
} from "@/lib/enso-addresses";
import { TOKENS, VAULT_ADDRESSES, isYldfiVault as checkIsYldfiVault } from "@/config/vaults";

// ETH placeholder address used by Enso
export const ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export const LEGACY_MORPHO_ADDRESS = "0x9994E35Db50125E0DF82e4c2dde62496CE330999";
export const MORPHO_TOKEN_ADDRESS = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";
export const MORPHO_WRAPPER_ADDRESS = "0x9D03bb2092270648d7480049d0E58d2FcF0E5123";
export const MORPHO_BUNDLER3_ADDRESS = "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245";
export const MORPHO_GENERAL_ADAPTER1_ADDRESS = "0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0";

export const ZERO_BYTES32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

// cvxCRV token address - exported for backwards compatibility
export const CVXCRV_ADDRESS = TOKENS.CVXCRV;

// Enso router contract addresses.
// Router V1: legacy EnsoShortcutRouter.
export const ENSO_ROUTER_V1 = ENSO_ROUTER_V1_ADDRESS;
// Router V2: current EnsoRouter and the correct spender for user token approvals.
// Enso's /wallet/approve endpoint returns this address as the spender for router strategy.
// The Router pulls tokens via safeTransferFrom(msg.sender, shortcuts, amount) in tokensIn.
export const ENSO_ROUTER_V2 = ENSO_ROUTER_V2_ADDRESS;
// Backwards-compatible aliases. Prefer ENSO_ROUTER_V1 / ENSO_ROUTER_V2 in new code.
export const ENSO_ROUTER = ENSO_ROUTER_V1;
export const ENSO_ROUTER_EXECUTOR = ENSO_ROUTER_V2;
// EnsoShortcuts contract — shared singleton execution context.
// This is msg.sender when Enso calls external contracts via the "call" action.
// Used as a DESTINATION for tokens during bundle execution (e.g., mint/unwrap to here).
//
// !! SECURITY: NEVER ask users to approve ENSO_SHORTCUTS as a token spender !!
// ENSO_SHORTCUTS is a shared contract — anyone can submit weiroll commands through
// the Router that execute in ENSO_SHORTCUTS' context. If a user approves
// ENSO_SHORTCUTS, their tokens can be drained via crafted routeMulti commands.
// For user approvals, use ENSO_ROUTER_V2 (the Router) instead.
export const ENSO_SHORTCUTS = ENSO_SHORTCUTS_ADDRESS;
export const HYBRID_EXTRA_BUFFER_BPS = Number(process.env.ENSO_HYBRID_EXTRA_BUFFER_BPS ?? "200");

// yld referral code for Enso attribution
export const ENSO_REFERRAL_CODE = "yldfi";

/**
 * Check if a token address is native ETH (the 0xeee...eee sentinel).
 * When ETH is the output of an Enso bundle route action, the weiroll VM's
 * slippage check fails because ETH is sent to the user before the check
 * reads the balance at EnsoShortcuts (which is 0). The fix is to route to
 * WETH instead and append a `wrapped-native/redeem` action to unwrap.
 */
export const isNativeETH = (token: string) =>
  token.toLowerCase() === ETH_ADDRESS.toLowerCase();

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// yld vault addresses (for vault-to-vault routing)
// Re-export with backwards-compatible naming (ycvxCRV vs YCVXCRV)
export const YLDFI_VAULT_ADDRESSES = {
  ycvxCRV: VAULT_ADDRESSES.YCVXCRV,
  yscvxCRV: VAULT_ADDRESSES.YSCVXCRV,
} as const;

/**
 * Check if an address is a yld vault
 * Uses centralized config from src/config/vaults.ts
 */
export const isYldfiVault = checkIsYldfiVault;
