"use client";

import { useQuery } from "@tanstack/react-query";
import { formatUsd } from "@/lib/utils";
import { QUERY_CONFIG } from "@/config/query";

interface YearnVaultAsset {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

interface YearnVaultDebt {
  strategy: string;
  currentDebt: string;
  currentDebtUsd: number;
  targetDebtRatio: number | null;
}

interface YearnVaultStrategy {
  chainId: number;
  address: string;
  name: string;
}

interface YearnVault {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  asset: YearnVaultAsset;
  accountant: string | null;
  pricePerShare: string;
  totalAssets: string;
  totalDebt: string;
  fees: {
    managementFee: number;
    performanceFee: number;
  } | null;
  tvl: {
    close: number;
  };
  apy: {
    close: number;
    grossApr: number;
    weeklyNet: number;
    monthlyNet: number;
    inceptionNet: number;
  };
  debts: YearnVaultDebt[];
}

interface YearnVaultResponse {
  data: {
    vault: YearnVault | null;
    vaultStrategies: YearnVaultStrategy[];
  };
}

const KONG_API_URL = "https://kong.yearn.farm/api/gql";

const VAULT_QUERY = `
query Query($chainId: Int, $address: String) {
  vault(chainId: $chainId, address: $address) {
    chainId
    address
    name
    symbol
    asset {
      address
      name
      symbol
      decimals
    }
    accountant
    pricePerShare
    totalAssets
    totalDebt
    fees {
      managementFee
      performanceFee
    }
    tvl {
      close
    }
    apy {
      close: net
      grossApr
      weeklyNet
      monthlyNet
      inceptionNet
    }
    debts {
      strategy
      currentDebt
      currentDebtUsd
      targetDebtRatio
    }
  }
  vaultStrategies(chainId: $chainId, vault: $address) {
    chainId
    address
    name
  }
}
`;

async function fetchYearnVault(chainId: number, address: string): Promise<YearnVaultResponse["data"]> {
  const response = await fetch(KONG_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: VAULT_QUERY,
      variables: { chainId, address },
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to fetch Yearn vault data");
  }

  const result: YearnVaultResponse = await response.json();
  return result.data;
}

export function useYearnVault(address: string, chainId: number = 1) {
  return useQuery({
    queryKey: ["yearn-vault", chainId, address],
    queryFn: () => fetchYearnVault(chainId, address),
    ...QUERY_CONFIG.vaultData,
    enabled: !!address,
  });
}

// Formatted display data
export interface YearnVaultDisplayData {
  name: string;
  symbol: string;
  asset: {
    symbol: string;
    name: string;
    address: string;
  };
  tvl: number;
  tvlFormatted: string;
  apy: number;
  apyFormatted: string;
  grossApr: number;
  grossAprFormatted: string;
  weeklyApy: number;
  weeklyApyFormatted: string;
  monthlyApy: number;
  monthlyApyFormatted: string;
  inceptionApy: number;
  inceptionApyFormatted: string;
  pricePerShare: number;
  pricePerShareFormatted: string;
  managementFee: number;
  managementFeeFormatted: string;
  performanceFee: number;
  performanceFeeFormatted: string;
  totalAssets: string;
  strategies: YearnVaultStrategy[];
}

// Calculate estimated strategy net APY from vault's net APY
// Vault net APY is after 15% vault fee + 5% strategy fee = 20% total
// Strategy net APY is after only 5% fee
export function calculateStrategyNetApy(vaultNetApy: number): number {
  // Vault takes 15% fee, strategy takes 5% fee
  // vaultNetApy = grossYield * (1 - 0.15) * (1 - 0.05) = grossYield * 0.85 * 0.95 = grossYield * 0.8075
  // Actually, vault fee is on top, so: vaultNet = strategyNet * (1 - 0.15)
  // Therefore: strategyNet = vaultNet / (1 - 0.15) = vaultNet / 0.85
  const strategyNetApy = vaultNetApy / 0.85;
  return strategyNetApy;
}

export function formatYearnVaultData(
  vault: YearnVault | null | undefined,
  strategies: YearnVaultStrategy[] = []
): YearnVaultDisplayData | null {
  if (!vault) return null;

  const decimals = vault.asset.decimals;
  const pricePerShare = Number(vault.pricePerShare) / Math.pow(10, decimals);

  return {
    name: vault.name,
    symbol: vault.symbol,
    asset: {
      symbol: vault.asset.symbol,
      name: vault.asset.name,
      address: vault.asset.address,
    },
    tvl: vault.tvl?.close ?? 0,
    tvlFormatted: formatUsd(vault.tvl?.close ?? 0),
    apy: vault.apy?.close ?? 0,
    apyFormatted: `${(vault.apy?.close ?? 0).toFixed(2)}%`,
    grossApr: vault.apy?.grossApr ?? 0,
    grossAprFormatted: `${(vault.apy?.grossApr ?? 0).toFixed(2)}%`,
    weeklyApy: vault.apy?.weeklyNet ?? 0,
    weeklyApyFormatted: `${(vault.apy?.weeklyNet ?? 0).toFixed(2)}%`,
    monthlyApy: vault.apy?.monthlyNet ?? 0,
    monthlyApyFormatted: `${(vault.apy?.monthlyNet ?? 0).toFixed(2)}%`,
    inceptionApy: vault.apy?.inceptionNet ?? 0,
    inceptionApyFormatted: `${(vault.apy?.inceptionNet ?? 0).toFixed(2)}%`,
    pricePerShare,
    pricePerShareFormatted: pricePerShare.toFixed(4),
    managementFee: vault.fees?.managementFee ?? 0,
    managementFeeFormatted: `${((vault.fees?.managementFee ?? 0) / 100).toFixed(2)}%`,
    performanceFee: vault.fees?.performanceFee ?? 0,
    performanceFeeFormatted: `${((vault.fees?.performanceFee ?? 0) / 100).toFixed(0)}%`,
    totalAssets: vault.totalAssets,
    strategies,
  };
}
