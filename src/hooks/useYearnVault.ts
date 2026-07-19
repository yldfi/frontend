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

// Route through Next.js GET proxy so Cloudflare can cache at the edge —
// Kong's direct endpoint intermittently rejects browser CORS preflights with
// 403, and POST requests aren't cacheable by Cloudflare anyway.
async function fetchYearnVault(chainId: number, address: string): Promise<YearnVaultResponse["data"]> {
  const qs = new URLSearchParams({ chainId: String(chainId), address });
  const response = await fetch(`/api/kong/vault?${qs.toString()}`);

  if (!response.ok) {
    throw new Error("Failed to fetch Yearn vault data");
  }

  const result: YearnVaultResponse = await response.json();
  return result.data;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Strategies with no Yearn vault — not in Kong API, skip to avoid wasted requests
const KONG_EXCLUDED_VAULTS = new Set([
  "0xB246DB2A73EEE3ee026153660c74657C123f8E42".toLowerCase(), // yspxcvx — standalone strategy, no Yearn vault
  "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e".toLowerCase(), // yscvx — standalone strategy, no Yearn vault
]);

export function useYearnVault(address: string, chainId: number = 1) {
  const isQueryable = !!address
    && address !== ZERO_ADDRESS
    && !KONG_EXCLUDED_VAULTS.has(address.toLowerCase());

  return useQuery({
    queryKey: ["yearn-vault", chainId, address],
    queryFn: () => fetchYearnVault(chainId, address),
    ...QUERY_CONFIG.vaultData,
    enabled: isQueryable,
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
  weeklyApr: number;
  weeklyAprFormatted: string;
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
    // Kong returns APY as decimal (0.26 = 26%), multiply by 100 for display
    apy: (vault.apy?.close ?? 0) * 100,
    apyFormatted: `${((vault.apy?.close ?? 0) * 100).toFixed(2)}%`,
    grossApr: (vault.apy?.grossApr ?? 0) * 100,
    grossAprFormatted: `${((vault.apy?.grossApr ?? 0) * 100).toFixed(2)}%`,
    weeklyApy: (vault.apy?.weeklyNet ?? 0) * 100,
    weeklyApyFormatted: `${((vault.apy?.weeklyNet ?? 0) * 100).toFixed(2)}%`,
    weeklyApr: (() => {
      const perfFeeRate = (vault.fees?.performanceFee ?? 0) / 10000;
      return perfFeeRate < 1
        ? ((vault.apy?.weeklyNet ?? 0) / (1 - perfFeeRate)) * 100
        : 0;
    })(),
    weeklyAprFormatted: (() => {
      const perfFeeRate = (vault.fees?.performanceFee ?? 0) / 10000;
      const apr = perfFeeRate < 1
        ? ((vault.apy?.weeklyNet ?? 0) / (1 - perfFeeRate)) * 100
        : 0;
      return `${apr.toFixed(2)}%`;
    })(),
    monthlyApy: (vault.apy?.monthlyNet ?? 0) * 100,
    monthlyApyFormatted: `${((vault.apy?.monthlyNet ?? 0) * 100).toFixed(2)}%`,
    inceptionApy: (vault.apy?.inceptionNet ?? 0) * 100,
    inceptionApyFormatted: `${((vault.apy?.inceptionNet ?? 0) * 100).toFixed(2)}%`,
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
