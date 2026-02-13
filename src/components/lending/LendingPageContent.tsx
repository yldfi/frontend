"use client";

import { useEffect } from "react";
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
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <header className="fixed left-0 right-0 z-50 border-b border-[var(--border)] backdrop-blur-lg bg-[var(--background)]/80" style={{ top: "var(--test-banner-height)" }}>
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
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
          <div className="max-w-6xl mx-auto px-6 py-4">
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

        <div className="max-w-6xl mx-auto px-6 py-12">
          <div className="grid lg:grid-cols-5 gap-12">
            {/* Left column - Chart + Position + Info */}
            <div className="lg:col-span-3 space-y-8">
              {/* Header */}
              <div>
                <div className="flex items-center gap-3 mb-4">
                  {vault.logo && (
                    <Image
                      src={vault.logo}
                      alt={vault.name}
                      width={40}
                      height={40}
                      className="rounded-full translate-y-[1px]"
                    />
                  )}
                  <div>
                    <h1 className="text-3xl md:text-4xl font-medium tracking-tight leading-none">
                      {vault.name}
                    </h1>
                    <span className="text-sm text-[var(--muted-foreground)]">
                      Curve LlamaLend
                    </span>
                  </div>
                </div>
                <p className="text-[var(--muted-foreground)] max-w-xl leading-relaxed text-sm">
                  Borrow crvUSD against {vault.symbol} collateral. Use leverage to amplify your position.
                </p>
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

              {/* Price Chart */}
              <div>
                <PriceChart
                  symbol={vault.assetSymbol}
                  currentPrice={
                    position?.liquidationPriceUpper
                      ? Number(formatUnits(position.liquidationPriceUpper, 18)) * 1.2
                      : undefined
                  }
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
                  showLiquidationBands={!!position?.hasLoan}
                  height={280}
                />
              </div>

              {/* Market Info */}
              <div>
                <h3 className="text-sm font-medium text-[var(--muted-foreground)] mb-3">Market Info</h3>
                <div className="p-4 rounded-lg bg-[var(--muted)]/30 border border-[var(--border)] space-y-3 text-sm">
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
                      className="mono text-[var(--accent)] hover:underline inline-flex items-center gap-1"
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
                        className="text-[var(--accent)] hover:underline inline-flex items-center gap-1"
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
            <div className="lg:col-span-2">
              <div className="sticky top-28">
                <LendingInterface
                  vault={vault}
                  userBalance={String(balance ?? 0n)}
                  position={position}
                  positionLoading={positionLoading && !position}
                  controllerAddress={controllerAddress}
                  onTransactionSuccess={() => refetchPosition()}
                />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

