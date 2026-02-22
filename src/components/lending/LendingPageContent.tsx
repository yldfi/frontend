"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ChevronRight, AlertTriangle, ExternalLink } from "lucide-react";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { getVault } from "@/config/vaults";
import { CURVE_CONTROLLERS } from "@/config/vaults";
import { useVaultBalance } from "@/hooks/useVaultBalance";
import { useCurveLendingPosition } from "@/hooks/useCurveLendingPosition";
import { useOraclePriceHistory, useMarketBands } from "@/hooks/useOraclePriceHistory";
import { useR2PriceHistory } from "@/hooks/useR2PriceHistory";
import { useVolumeProfile, type VolumeProfilePeriod } from "@/hooks/useVolumeProfile";
import { useCurveMarketRates } from "@/hooks/useCurveMarketRates";
import { LendingInterface } from "./LendingInterface";
import { PriceChart } from "./PriceChart";
import { Logo } from "@/components/Logo";
import { CustomConnectButton } from "@/components/CustomConnectButton";

export function LendingPageContent({ vaultId }: { vaultId: string }) {
  const router = useRouter();
  const { address } = useAccount();
  const vault = getVault(vaultId);
  const { balance } = useVaultBalance(vault?.address as `0x${string}`);

  const controllerAddress = vault?.address
    ? (CURVE_CONTROLLERS[vault.address as keyof typeof CURVE_CONTROLLERS] as `0x${string}` | undefined)
    : undefined;

  const { position, isLoading: positionLoading, refetch: refetchPosition } = useCurveLendingPosition(
    vault?.address as `0x${string}`,
    address
  );

  // Oracle price history + band data for the chart
  const { data: oracleHistory } = useOraclePriceHistory(controllerAddress);
  const { data: bandsData } = useMarketBands(controllerAddress);

  // R2 price history (full historical data) — falls back to oracleHistory
  const { data: r2History } = useR2PriceHistory();
  const { data: volumeProfile } = useVolumeProfile();
  const marketStats = useCurveMarketRates(controllerAddress);
  const [vpPeriod, setVpPeriod] = useState<VolumeProfilePeriod>("all");

  // Preview liquidation prices from LendingInterface child tab inputs
  const [previewLiqPrices, setPreviewLiqPrices] = useState<{ upper: number; lower: number } | null>(null);
  const handlePreviewLiqPrices = useCallback((upper: number | null, lower: number | null) => {
    if (upper !== null && lower !== null) {
      setPreviewLiqPrices({ upper, lower });
    } else {
      setPreviewLiqPrices(null);
    }
  }, []);

  const shouldRedirect = !vault || !controllerAddress;

  useEffect(() => {
    if (shouldRedirect) {
      router.push("/");
    }
  }, [shouldRedirect, router]);

  if (shouldRedirect) {
    return null;
  }

  return (
    <div className="min-h-screen bg-[var(--background)] overflow-x-hidden">
      {/* Header */}
      <header className="fixed left-0 right-0 z-50 border-b border-[var(--border)] backdrop-blur-lg bg-[var(--background)]/80" style={{ top: "var(--test-banner-height)" }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Logo size={28} />
            <span className="mono text-lg font-medium tracking-tight leading-none">
              yld
            </span>
          </Link>
          <CustomConnectButton />
        </div>
      </header>

      <main style={{ paddingTop: "calc(4rem + var(--test-banner-height))", overflowX: "clip" }}>
        {/* Breadcrumb navigation */}
        <div className="border-b border-[var(--border)]">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
            <nav className="flex items-center gap-2 text-sm">
              <Link
                href="/"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              >
                yld
              </Link>
              <ChevronRight size={14} className="text-[var(--muted-foreground)]" />
              <Link
                href={`/vaults/${vaultId}`}
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              >
                {vault.symbol}
              </Link>
              <ChevronRight size={14} className="text-[var(--muted-foreground)]" />
              <span className="text-[var(--foreground)]">Lending</span>
            </nav>
          </div>
        </div>

        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
          <div className="grid lg:grid-cols-5 gap-8 lg:gap-12">
            {/* Left column - Chart + Position + Info */}
            <div className="lg:col-span-3 space-y-8 min-w-0">
              {/* Price Chart */}
              <div>
                <PriceChart
                  vaultName={vault.name}
                  vaultLogo={vault.logo}
                  symbol={vault.assetSymbol}
                  priceData={r2History?.ycvxcrvData ?? oracleHistory?.data}
                  priceSymbol={vault.symbol}
                  altPriceData={r2History?.cvxcrvData}
                  altSymbol={vault.assetSymbol}
                  currentOraclePrice={oracleHistory?.currentOraclePrice}
                  liquidationPriceUpper={
                    position?.hasLoan
                      ? Number(formatUnits(position.liquidationPriceUpper, 18))
                      : undefined
                  }
                  liquidationPriceLower={
                    position?.hasLoan
                      ? Number(formatUnits(position.liquidationPriceLower, 18))
                      : undefined
                  }
                  bands={bandsData?.bands}
                  activeBand={bandsData?.activeBand}
                  showLiquidationZone={!!position?.hasLoan}
                  previewLiqUpper={previewLiqPrices?.upper}
                  previewLiqLower={previewLiqPrices?.lower}
                  height={320}
                  pricePerShareData={r2History?.pricePerShareData}
                  volumeProfileBins={volumeProfile?.timeframes?.[vpPeriod]?.bins}
                  volumeProfilePoc={volumeProfile?.timeframes?.[vpPeriod]?.poc}
                  volumeProfileVah={volumeProfile?.timeframes?.[vpPeriod]?.vah}
                  volumeProfileVal={volumeProfile?.timeframes?.[vpPeriod]?.val}
                  volumeProfilePeriod={vpPeriod}
                  onVolumeProfilePeriodChange={setVpPeriod}
                />
              </div>

              {/* Soft-liquidation warning */}
              {position?.inSoftLiquidation && (
                <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 flex items-center gap-2 text-yellow-500 text-sm">
                  <AlertTriangle size={16} />
                  <div>
                    <div className="font-medium">Position in soft-liquidation</div>
                    <div className="text-xs mt-0.5">
                      Your collateral is being gradually converted to crvUSD. Repay debt to improve health.
                    </div>
                  </div>
                </div>
              )}

              {/* Market Info */}
              <div className="p-4 rounded-lg bg-[var(--muted)]/30 border border-[var(--border)] space-y-3 text-sm">
                <p className="text-[var(--muted-foreground)] leading-relaxed">
                  Borrow crvUSD against {vault.symbol} collateral. Use leverage to amplify your position.
                </p>
                <div className="pt-1 border-t border-[var(--border)] space-y-3">
                  {marketStats && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-[var(--muted-foreground)]">Total Supplied</span>
                        <span className="mono">{marketStats.totalSupplied} crvUSD</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--muted-foreground)]">Total Borrowed</span>
                        <span className="mono">{marketStats.totalBorrowed} crvUSD</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--muted-foreground)]">Available Liquidity</span>
                        <span className="mono">{marketStats.availableLiquidity} crvUSD</span>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Collateral Token</span>
                    <span className="mono">{vault.symbol}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Borrow Token</span>
                    <span className="mono">crvUSD</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Controller</span>
                    <a
                      href={`https://etherscan.io/address/${controllerAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono text-[var(--foreground)] hover:text-[var(--accent)] transition-colors inline-flex items-center gap-1"
                    >
                      {controllerAddress.slice(0, 6)}...{controllerAddress.slice(-4)}
                      <ExternalLink size={10} />
                    </a>
                  </div>
                  {vault.links?.curve && (
                    <div className="pt-2 border-t border-[var(--border)]">
                      <a
                        href={vault.links.curve}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--foreground)] hover:text-[var(--accent)] transition-colors inline-flex items-center gap-1"
                      >
                        View on Curve.finance
                        <ExternalLink size={12} />
                      </a>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Right column - Lending Panel */}
            <div className="lg:col-span-2 lg:self-start">
              <div>
                <LendingInterface
                  vault={vault}
                  userBalance={String(balance ?? 0n)}
                  position={position}
                  positionLoading={positionLoading && !position}
                  controllerAddress={controllerAddress}
                  onTransactionSuccess={() => refetchPosition()}
                  onPreviewLiqPrices={handlePreviewLiqPrices}
                />
              </div>
            </div>
          </div>
        </div >
      </main >
    </div >
  );
}

