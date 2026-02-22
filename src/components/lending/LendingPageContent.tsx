"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ChevronRight, AlertTriangle, ExternalLink, Info, Activity, Coins, TrendingUp } from "lucide-react";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { getVault, CURVE_CONTROLLERS, CURVE_SAVINGS } from "@/config/vaults";
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
import { useClearOnNavigation } from "@/hooks/useClearOnNavigation";

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

  // Measure chart bottom relative to grid so right panel aligns
  const gridRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [panelMinH, setPanelMinH] = useState(0);
  useEffect(() => {
    if (!chartRef.current || !gridRef.current) return;
    const measure = () => {
      if (!chartRef.current || !gridRef.current) return;
      const gridTop = gridRef.current.getBoundingClientRect().top;
      const chartBottom = chartRef.current.getBoundingClientRect().bottom;
      setPanelMinH(Math.round(chartBottom - gridTop));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(chartRef.current);
    measure();
    return () => ro.disconnect();
  }, []);

  // Preview liquidation prices from LendingInterface child tab inputs
  const [previewLiqPrices, setPreviewLiqPrices] = useState<{ upper: number; lower: number } | null>(null);
  const handlePreviewLiqPrices = useCallback((upper: number | null, lower: number | null) => {
    if (upper !== null && lower !== null) {
      setPreviewLiqPrices({ upper, lower });
    } else {
      setPreviewLiqPrices(null);
    }
  }, []);

  // Clear lending form amounts on navigation (preserve on refresh)
  const vaultAddr = vault?.address ?? "";
  useClearOnNavigation([
    `yldfi-lending-collateral-${vaultAddr}`,
    `yldfi-lending-borrow-collateral-${vaultAddr}`,
    `yldfi-lending-borrow-amount-${vaultAddr}`,
    `yldfi-lending-repay-${vaultAddr}`,
    `yldfi-lending-leverage-${vaultAddr}`,
    `yldfi-lending-newloan-amount-${vaultAddr}`,
    `yldfi-lending-newloan-debt-${vaultAddr}`,
    "yldfi-lending-tab",
  ], "yldfi-lending-is-refresh");

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
                yld Vaults
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

        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          <div ref={gridRef} className="grid lg:grid-cols-5 gap-8 lg:gap-12">
            {/* Left column - Chart + Position + Info */}
            <div className="lg:col-span-3 space-y-8 min-w-0 overflow-hidden">
              {/* Section Header */}
              <div>
                <p className="mono text-sm text-[var(--muted-foreground)] mb-2">
                  [004] Lending
                </p>
                <div className="flex items-center gap-3">
                  {vault.logo && (
                    <Image
                      src={vault.logo}
                      alt={vault.name}
                      width={40}
                      height={40}
                      className="rounded-full translate-y-[1px]"
                    />
                  )}
                  <h2 className="text-3xl md:text-4xl font-medium tracking-tight">
                    {vault.name} <span className="text-[var(--muted-foreground)]">LlamaLend</span>
                  </h2>
                </div>
              </div>

              {/* Price Chart */}
              <div ref={chartRef}>
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
              <div className="p-5 rounded-xl bg-gradient-to-br from-[var(--muted)]/50 to-transparent border border-[var(--border)] shadow-sm relative overflow-hidden">
                {/* Decorative background element */}
                <div className="absolute top-0 right-0 w-32 h-32 bg-[var(--accent)]/5 rounded-full blur-3xl -mr-10 -mt-10 pointer-events-none"></div>

                <div className="relative z-10 space-y-5">
                  <div className="flex items-start gap-3">
                    <div className="mt-1 bg-[var(--background)] p-1.5 rounded-md border border-[var(--border)] text-[var(--muted-foreground)]">
                      <Info size={16} />
                    </div>
                    <div>
                      <h3 className="text-base font-medium text-[var(--foreground)]">Market Overview</h3>
                      <p className="text-sm text-[var(--muted-foreground)] leading-relaxed mt-1">
                        Borrow crvUSD against {vault.symbol} collateral. Use leverage to amplify your position.
                      </p>
                    </div>
                  </div>

                  {marketStats && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                      <div className="bg-[var(--background)]/80 backdrop-blur-sm border border-[var(--border)] rounded-lg p-3 flex flex-col justify-between group hover:border-[var(--muted-foreground)]/30 transition-colors">
                        <div className="flex items-center gap-2 mb-2 text-[var(--muted-foreground)]">
                          <Coins size={14} />
                          <span className="text-xs font-medium uppercase tracking-wider">Total Supplied</span>
                        </div>
                        <div className="mono text-[var(--foreground)] text-lg font-medium">{marketStats.totalSupplied}</div>
                        <div className="text-[10px] text-[var(--muted-foreground)] mt-1">crvUSD</div>
                      </div>

                      <div className="bg-[var(--background)]/80 backdrop-blur-sm border border-[var(--border)] rounded-lg p-3 flex flex-col justify-between group hover:border-[var(--muted-foreground)]/30 transition-colors">
                        <div className="flex items-center gap-2 mb-2 text-[var(--muted-foreground)]">
                          <TrendingUp size={14} />
                          <span className="text-xs font-medium uppercase tracking-wider">Total Borrowed</span>
                        </div>
                        <div className="mono text-[var(--foreground)] text-lg font-medium">{marketStats.totalBorrowed}</div>
                        <div className="text-[10px] text-[var(--muted-foreground)] mt-1">crvUSD</div>
                      </div>

                      <div className="bg-[var(--background)]/80 backdrop-blur-sm border border-[var(--border)] rounded-lg p-3 flex flex-col justify-between group hover:border-[var(--muted-foreground)]/30 transition-colors">
                        <div className="flex items-center gap-2 mb-2 text-[var(--muted-foreground)]">
                          <Activity size={14} />
                          <span className="text-xs font-medium uppercase tracking-wider">Available Liquidity</span>
                        </div>
                        <div className="mono text-[var(--success)] text-lg font-medium">{marketStats.availableLiquidity}</div>
                        <div className="text-[10px] text-[var(--muted-foreground)] mt-1">crvUSD</div>
                      </div>
                    </div>
                  )}

                  <div className="pt-4 border-t border-[var(--border)] grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <div className="space-y-3">
                      <div className="flex justify-between items-center bg-[var(--background)]/50 px-3 py-2 rounded-md border border-[var(--border)]/50">
                        <span className="text-[var(--muted-foreground)] text-xs font-medium uppercase tracking-wider">Collateral</span>
                        <a
                          href={`https://etherscan.io/address/${vault.assetAddress}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 hover:text-[var(--accent)] transition-colors group"
                        >
                          {vault.logo && <Image src={vault.logo} alt={vault.symbol} width={16} height={16} className="rounded-full" />}
                          <span className="mono font-medium">{vault.symbol}</span>
                          <ExternalLink size={10} className="opacity-50 group-hover:opacity-100 transition-opacity" />
                        </a>
                      </div>
                      <div className="flex justify-between items-center bg-[var(--background)]/50 px-3 py-2 rounded-md border border-[var(--border)]/50">
                        <span className="text-[var(--muted-foreground)] text-xs font-medium uppercase tracking-wider">Borrow</span>
                        <a
                          href={`https://etherscan.io/address/${CURVE_SAVINGS.SCRVUSD_UNDERLYING}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 hover:text-[var(--accent)] transition-colors group"
                        >
                          <Image src="/tokens/crvusd.png" alt="crvUSD" width={16} height={16} className="rounded-full" />
                          <span className="mono font-medium">crvUSD</span>
                          <ExternalLink size={10} className="opacity-50 group-hover:opacity-100 transition-opacity" />
                        </a>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex justify-between items-center bg-[var(--background)]/50 px-3 py-2 rounded-md border border-[var(--border)]/50">
                        <span className="text-[var(--muted-foreground)] text-xs font-medium uppercase tracking-wider">Controller</span>
                        <a
                          href={`https://etherscan.io/address/${controllerAddress}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mono text-[var(--foreground)] hover:text-[var(--accent)] transition-colors inline-flex items-center gap-1 group"
                        >
                          <span>{controllerAddress.slice(0, 6)}...{controllerAddress.slice(-4)}</span>
                          <ExternalLink size={10} className="opacity-50 group-hover:opacity-100 transition-opacity" />
                        </a>
                      </div>
                      {vault.links?.curve && (
                        <div className="flex justify-between items-center bg-[var(--background)]/50 px-3 py-2 rounded-md border border-[var(--border)]/50">
                          <span className="text-[var(--muted-foreground)] text-xs font-medium uppercase tracking-wider">Platform</span>
                          <a
                            href={vault.links.curve}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 hover:text-[var(--accent)] transition-colors group"
                          >
                            <Image src="/curve-logo.png" alt="Curve" width={16} height={16} className="rounded-full" />
                            <span className="font-medium">Curve.finance</span>
                            <ExternalLink size={10} className="opacity-50 group-hover:opacity-100 transition-opacity" />
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right column - Lending Panel */}
            <div className="lg:col-span-2 lg:self-start flex flex-col" style={panelMinH ? { minHeight: panelMinH } : undefined}>
              <div className="flex-1 flex flex-col">
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

