import { TOKENS, type VaultConfig } from "@/config/vaults";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

type VaultBalanceConfig = Pick<VaultConfig, "address" | "assetAddress">;

export function getVaultFormBalanceAddresses(vault: VaultBalanceConfig | undefined): {
  depositTokenAddress: `0x${string}`;
  withdrawTokenAddress: `0x${string}`;
} {
  return {
    depositTokenAddress: vault?.assetAddress ?? TOKENS.CVXCRV,
    withdrawTokenAddress: vault?.address ?? ZERO_ADDRESS,
  };
}
