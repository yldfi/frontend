import { TOKENS, VAULT_ADDRESSES, getVaultByAddress } from "@/config/vaults";

export const PERMISSIONLESS_KEEPER = "0x52605BbF54845f520a3E94792d019f62407db2f8" as const;
export const COMMON_TRIGGER = "0xf8df17a35c88abb25e83c92f9d293b4368b9d52d" as const;
export const CVXCRV_WRAPPER = "0xaa0C3f5F7DFD688C6E646F66CD2a6B66ACdbE434" as const;
export const CVGCVX_STAKING = "0x2c1D293c50C6d1a4370ebb442A02c5956bbAb119" as const;

export type HarvestKind = "yscvx" | "yscvxcrv" | "yscvgcvx" | "yspxcvx";

export interface HarvestConfig {
  kind: HarvestKind;
  strategy: `0x${string}`;
  auctionToken?: `0x${string}`;
}

const HARVEST_CONFIGS: Record<string, HarvestConfig> = {
  [VAULT_ADDRESSES.YSCVX.toLowerCase()]: {
    kind: "yscvx",
    strategy: VAULT_ADDRESSES.YSCVX,
    auctionToken: TOKENS.CVXCRV,
  },
  [VAULT_ADDRESSES.YSCVXCRV.toLowerCase()]: {
    kind: "yscvxcrv",
    strategy: VAULT_ADDRESSES.YSCVXCRV,
    auctionToken: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
  },
  [VAULT_ADDRESSES.YSCVGCVX.toLowerCase()]: {
    kind: "yscvgcvx",
    strategy: VAULT_ADDRESSES.YSCVGCVX,
  },
  [VAULT_ADDRESSES.YSPXCVX.toLowerCase()]: {
    kind: "yspxcvx",
    strategy: VAULT_ADDRESSES.YSPXCVX,
  },
};

export function getHarvestConfig(vaultAddress: string): HarvestConfig | null {
  const vault = getVaultByAddress(vaultAddress);
  const strategy = vault?.underlyingStrategy ?? vault?.address;
  return strategy ? HARVEST_CONFIGS[strategy.toLowerCase()] ?? null : null;
}

