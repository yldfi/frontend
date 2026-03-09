/**
 * Shared Ethereum addresses used across multiple modules.
 *
 * Only addresses referenced in 2+ unrelated files belong here.
 * Domain-specific addresses stay in their own modules:
 *   - Vault configs → config/vaults.ts
 *   - Enso infra   → lib/enso.ts
 *   - Zapper       → lib/zapper.ts
 */

// ── Tokens ──────────────────────────────────────────────────────────
export const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
export const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
export const CRVUSD_ADDRESS = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E" as const;

// ── External Vaults ─────────────────────────────────────────────────
export const YVUSDC1_ADDRESS = "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204" as const; // Yearn V3 yvUSDC-1

// ── Oracles ─────────────────────────────────────────────────────────
export const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as const;

// ── Curve pools ─────────────────────────────────────────────────────
export const CURVE_CVX_ETH_POOL = "0xB576491F1E6e5E62f1d8F26062Ee822B40B0E0d4" as const;
