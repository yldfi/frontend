"use client";

import { useQuery } from "@tanstack/react-query";
import { formatUsd } from "@/lib/utils";
import { QUERY_CONFIG } from "@/config/query";

interface CurveLendingVault {
  id: string;
  name: string;
  address: string;
  controllerAddress: string;
  ammAddress: string;
  gaugeAddress: string;
  rates: {
    borrowApr: number;
    borrowApy: number;
    borrowApyPcent: number;
    lendApr: number;
    lendApy: number;
    lendApyPcent: number;
  };
  gaugeRewards: Array<{
    gaugeAddress: string;
    name: string;
    symbol: string;
    decimals: string;
    tokenAddress: string;
    apy: number | null;
  }>;
  assets: {
    borrowed: {
      symbol: string;
      decimals: number;
      address: string;
      usdPrice: number;
    };
    collateral: {
      symbol: string;
      decimals: number;
      address: string;
      usdPrice: number | null;
    };
  };
  vaultShares: {
    pricePerShare: number;
    totalShares: number;
  };
  totalSupplied: {
    total: number;
    usdTotal: number;
  };
  borrowed: {
    total: number;
    usdTotal: number;
  };
  availableToBorrow: {
    total: number;
    usdTotal: number;
  };
  lendingVaultUrls: {
    deposit: string;
    withdraw: string;
    borrow: string;
  };
  usdTotal: number;
  ammBalances: {
    ammBalanceBorrowed: number;
    ammBalanceBorrowedUsd: number;
    ammBalanceCollateral: number;
    ammBalanceCollateralUsd: number | null;
  };
  blockchainId: string;
  registryId: string;
}

interface CurveApiResponse {
  success: boolean;
  data: {
    lendingVaultData: CurveLendingVault[];
  };
}

// Map of yCVXCRV vault address to Curve lending market controller
const VAULT_TO_CURVE_CONTROLLER: Record<string, string> = {
  "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86": "0x24174143cCF438f0A1F6dCF93B468C127123A96E",
};

async function fetchCurveLendingData(): Promise<CurveLendingVault[]> {
  const response = await fetch("https://api.curve.finance/v1/getLendingVaults/all/ethereum");
  if (!response.ok) {
    throw new Error("Failed to fetch Curve lending data");
  }
  const data: CurveApiResponse = await response.json();
  return data.data.lendingVaultData;
}

export function useCurveLendingData() {
  return useQuery({
    queryKey: ["curve-lending-data"],
    queryFn: fetchCurveLendingData,
    ...QUERY_CONFIG.vaultData,
  });
}

export function useCurveLendingVault(vaultAddress: string) {
  const { data: allVaults, isLoading, error } = useCurveLendingData();

  const controllerAddress = VAULT_TO_CURVE_CONTROLLER[vaultAddress];
  const vault = allVaults?.find(v =>
    v.controllerAddress.toLowerCase() === controllerAddress?.toLowerCase()
  );

  return {
    vault,
    isLoading,
    error,
  };
}

// Derived data for display
export interface VaultDisplayData {
  // Lending APY for crvUSD lenders (what fee recipients earn)
  lendApy: number;
  lendApyFormatted: string;
  // Borrow APY (interest rate borrowers pay)
  borrowApy: number;
  borrowApyFormatted: string;
  // TVL in USD
  tvlUsd: number;
  tvlFormatted: string;
  // Utilization rate
  utilization: number;
  utilizationFormatted: string;
  // Available to borrow
  availableToBorrow: number;
  availableToBorrowFormatted: string;
  // Total borrowed
  totalBorrowed: number;
  totalBorrowedFormatted: string;
  // Collateral in AMM (liquidations)
  collateralInAmm: number;
  // Curve links
  depositUrl: string;
  withdrawUrl: string;
  borrowUrl: string;
}

export function formatCurveVaultData(vault: CurveLendingVault | undefined): VaultDisplayData | null {
  if (!vault) return null;

  const utilization = vault.totalSupplied.total > 0
    ? (vault.borrowed.total / vault.totalSupplied.total) * 100
    : 0;

  return {
    lendApy: vault.rates.lendApyPcent,
    lendApyFormatted: `${vault.rates.lendApyPcent.toFixed(2)}%`,
    borrowApy: vault.rates.borrowApyPcent,
    borrowApyFormatted: `${vault.rates.borrowApyPcent.toFixed(2)}%`,
    tvlUsd: vault.usdTotal,
    tvlFormatted: formatUsd(vault.usdTotal),
    utilization,
    utilizationFormatted: `${utilization.toFixed(1)}%`,
    availableToBorrow: vault.availableToBorrow.usdTotal,
    availableToBorrowFormatted: formatUsd(vault.availableToBorrow.usdTotal),
    totalBorrowed: vault.borrowed.usdTotal,
    totalBorrowedFormatted: formatUsd(vault.borrowed.usdTotal),
    collateralInAmm: vault.ammBalances.ammBalanceCollateral,
    depositUrl: vault.lendingVaultUrls.deposit,
    withdrawUrl: vault.lendingVaultUrls.withdraw,
    borrowUrl: vault.lendingVaultUrls.borrow,
  };
}
