import { TOKENS, VAULT_ADDRESSES, getVaultByAddress } from "@/config/vaults";

export const PERMISSIONLESS_KEEPER = "0x52605BbF54845f520a3E94792d019f62407db2f8" as const;
export const COMMON_REPORT_TRIGGER = "0xA045D4dAeA28BA7Bfe234c96eAa03daFae85A147" as const;
export const COMMON_TRIGGER = "0xf8df17a35c88abb25e83c92f9d293b4368b9d52d" as const;
export const CVGCVX_STRATEGY_TRIGGER = "0x142130D1931e4929642BfC46442AeEd6ca560196" as const;
export const CVXCRV_WRAPPER = "0xaa0C3f5F7DFD688C6E646F66CD2a6B66ACdbE434" as const;
export const CVGCVX_STAKING = "0x2c1D293c50C6d1a4370ebb442A02c5956bbAb119" as const;

export type HarvestKind = "yscvx" | "yscvxcrv" | "yscvgcvx" | "yspxcvx";

export interface HarvestConfig {
  kind: HarvestKind;
  strategy: `0x${string}`;
  trigger: {
    address: `0x${string}`;
    functionName: "strategyReportTrigger" | "reportTrigger";
  };
  auctionToken?: `0x${string}`;
  auctionOutputToken?: `0x${string}`;
  rewardThreshold?: {
    functionName: "minAmountToSell" | "tokenMinAmountToSell";
    token: `0x${string}`;
  };
}

const PERMISSIONLESS_COMMON_TRIGGER = {
  address: COMMON_TRIGGER,
  functionName: "strategyReportTrigger",
} as const;

const HARVEST_CONFIGS: Record<string, HarvestConfig> = {
  [VAULT_ADDRESSES.YSCVX.toLowerCase()]: {
    kind: "yscvx",
    strategy: VAULT_ADDRESSES.YSCVX,
    trigger: PERMISSIONLESS_COMMON_TRIGGER,
    auctionToken: TOKENS.CVXCRV,
    auctionOutputToken: TOKENS.CVX,
    rewardThreshold: { functionName: "minAmountToSell", token: TOKENS.CVXCRV },
  },
  [VAULT_ADDRESSES.YSCVXCRV.toLowerCase()]: {
    kind: "yscvxcrv",
    strategy: VAULT_ADDRESSES.YSCVXCRV,
    trigger: PERMISSIONLESS_COMMON_TRIGGER,
    auctionToken: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
    auctionOutputToken: TOKENS.CVXCRV,
    rewardThreshold: {
      functionName: "tokenMinAmountToSell",
      token: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
    },
  },
  [VAULT_ADDRESSES.YSCVGCVX.toLowerCase()]: {
    kind: "yscvgcvx",
    strategy: VAULT_ADDRESSES.YSCVGCVX,
    trigger: {
      address: CVGCVX_STRATEGY_TRIGGER,
      functionName: "reportTrigger",
    },
  },
  [VAULT_ADDRESSES.YSPXCVX.toLowerCase()]: {
    kind: "yspxcvx",
    strategy: VAULT_ADDRESSES.YSPXCVX,
    trigger: PERMISSIONLESS_COMMON_TRIGGER,
    auctionOutputToken: TOKENS.PXCVX,
  },
};

export function getHarvestConfig(vaultAddress: string): HarvestConfig | null {
  const vault = getVaultByAddress(vaultAddress);
  const strategy = vault?.underlyingStrategy ?? vault?.address;
  return strategy ? HARVEST_CONFIGS[strategy.toLowerCase()] ?? null : null;
}
