"use client";

import { useAccount } from "wagmi";
import { CustomConnectButton } from "@/components/CustomConnectButton";
import { ArrowUpRight, Github, BookOpen, Send } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { PixelAnimation } from "@/components/PixelAnimation";
import { Logo } from "@/components/Logo";
import { useYearnVault, formatYearnVaultData, calculateStrategyNetApy } from "@/hooks/useYearnVault";
import { useMultipleVaultBalances } from "@/hooks/useVaultBalance";
import { useMultiplePricePerShare } from "@/hooks/usePricePerShare";
import { useVaultCache } from "@/hooks/useVaultCache";

// Contract addresses
const YCVXCRV_ADDRESS = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86";
const YSCVXCRV_ADDRESS = "0xCa960E6DF1150100586c51382f619efCCcF72706";

const vaultConfigs = [
  {
    id: "ycvxcrv",
    name: "ycvxCRV",
    description: "Auto-compounding cvxCRV staking rewards via Convex. Use as collateral on Curve LlamaLend to borrow crvUSD.",
    token: "cvxCRV",
    chain: "Ethereum",
    contractAddress: YCVXCRV_ADDRESS,
    badges: ["cvxCRV", "Compounder", "Collateral (LlamaLend)"],
    type: "vault" as const,
    fee: 20,
    feeBreakdown: "15% to LlamaLend lenders + 5% strategy",
    logo: "/ycvxcrv-64.png",
  },
  {
    id: "yscvxcrv",
    name: "yscvxCRV",
    description: "Auto-compounding cvxCRV staking rewards via Convex. Lower 5% fee but no collateral support.",
    token: "cvxCRV",
    chain: "Ethereum",
    contractAddress: YSCVXCRV_ADDRESS,
    badges: ["cvxCRV", "Compounder"],
    type: "strategy" as const,
    fee: 5,
    feeBreakdown: "5% strategy",
    logo: "/yscvxcrv-64.png",
  },
];

function formatNumber(num: number): string {
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

export function HomePageContent() {
  const { isConnected } = useAccount();

  // Fetch cached vault data (fast, from edge)
  const { data: cacheData, isLoading: cacheLoading } = useVaultCache();

  // Fetch Yearn vault data (for APY from Kong API)
  const { data: ycvxcrvData, isLoading: ycvxcrvLoading } = useYearnVault(YCVXCRV_ADDRESS);
  const { data: yscvxcrvData } = useYearnVault(YSCVXCRV_ADDRESS);

  const ycvxcrvVault = formatYearnVaultData(ycvxcrvData?.vault, ycvxcrvData?.vaultStrategies);
  const yscvxcrvVault = formatYearnVaultData(yscvxcrvData?.vault, yscvxcrvData?.vaultStrategies);

  // Use cached cvxCRV price (falls back to 0 if cache not ready)
  const cvxCrvPrice = cacheData?.cvxCrvPrice ?? 0;

  // Fetch price per share from on-chain
  const { prices: pricePerShareData } = useMultiplePricePerShare([
    YCVXCRV_ADDRESS as `0x${string}`,
    YSCVXCRV_ADDRESS as `0x${string}`,
  ]);

  const ycvxcrvPricePerShare = pricePerShareData[0]?.pricePerShare ?? 1;
  const yscvxcrvPricePerShare = pricePerShareData[1]?.pricePerShare ?? 1;

  // Fetch user vault balances
  const { balances } = useMultipleVaultBalances([
    {
      address: YCVXCRV_ADDRESS as `0x${string}`,
      pricePerShare: ycvxcrvPricePerShare,
      assetPriceUsd: cvxCrvPrice,
    },
    {
      address: YSCVXCRV_ADDRESS as `0x${string}`,
      pricePerShare: yscvxcrvPricePerShare,
      assetPriceUsd: cvxCrvPrice,
    },
  ]);

  // Use cache for fast initial load, Yearn API for APY
  const isLoading = cacheLoading && ycvxcrvLoading;

  // Build vault list with live data
  // yCVXCRV vault: uses net APY from Kong (after 15% vault fee)
  // yscvxCRV strategy: calculate net APY by removing the 15% vault fee (strategy only has 5% fee already included)
  const vaultNetApy = ycvxcrvVault?.apy ?? 0;
  const strategyNetApy = calculateStrategyNetApy(vaultNetApy); // Remove vault's 15% fee

  // Use cached TVL (fast) or fall back to Yearn API TVL
  const ycvxcrvTvl = cacheData?.ycvxcrv?.tvlUsd ?? ycvxcrvVault?.tvl ?? 0;
  const yscvxcrvTvl = cacheData?.yscvxcrv?.tvlUsd ?? yscvxcrvVault?.tvl ?? 0;

  const vaults = vaultConfigs.map((config, index) => ({
    ...config,
    tvl: config.id === "ycvxcrv" ? ycvxcrvTvl : yscvxcrvTvl,
    apy: config.id === "ycvxcrv"
      ? vaultNetApy                // Vault: net APY after 15% vault fee
      : strategyNetApy,            // Strategy: net APY without vault fee (only 5% strategy fee)
    holdings: balances[index]?.formattedUsd ?? "$0",
    hasHoldings: (balances[index]?.usdValue ?? 0) > 0,
  }));

  // Total TVL - use strategy TVL since vault deposits flow into strategy
  const totalTvl = yscvxcrvTvl;
  const totalTvlFormatted = totalTvl >= 1_000_000
    ? `$${(totalTvl / 1_000_000).toFixed(2)}M`
    : totalTvl >= 1_000
    ? `$${(totalTvl / 1_000).toFixed(1)}K`
    : `$${totalTvl.toFixed(2)}`;

  // Calculate average APY
  const avgApy = vaults.length > 0
    ? vaults.reduce((sum, v) => sum + v.apy, 0) / vaults.length
    : 0;

  // Stats with live data
  const stats = [
    { label: "Total Value Locked", value: isLoading ? "..." : totalTvlFormatted },
    { label: "Vaults", value: vaultConfigs.length.toString() },
    { label: "Avg APY", value: isLoading ? "..." : `${avgApy.toFixed(1)}%` },
  ];

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-[var(--border)] backdrop-blur-lg bg-[var(--background)]/80">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Logo size={28} />
            <span className="mono text-lg font-medium tracking-tight">
              yld<span className="text-[var(--muted-foreground)]">_</span>fi
            </span>
          </Link>

          
          <CustomConnectButton />
        </div>
      </header>

      <main className="pt-16">
        {/* Hero */}
        <section className="border-b border-[var(--border)] relative overflow-hidden">
          <div className="absolute inset-0">
            <PixelAnimation />
          </div>
          <div className="max-w-6xl mx-auto px-6 py-24 md:py-32 relative z-10">
            <div className="max-w-3xl">
              <p className="mono text-sm text-[var(--muted-foreground)] mb-4 animate-fade-in">
                [001] yld_fi
              </p>
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-medium tracking-tight leading-[1.1] mb-6 animate-fade-in-up opacity-0 delay-100">
                Deposit
                <br />
                Compound
                <br />
                <span className="text-[var(--muted-foreground)]">Earn</span>
              </h1>
              <p className="text-lg text-[var(--muted-foreground)] max-w-xl mb-8 animate-fade-in-up opacity-0 delay-200">
                Deposit into ERC-4626 vaults built on Yearn V3 architecture.
                Auto-compounding strategies that optimize your returns.
              </p>
              <div className="flex items-center gap-4 animate-fade-in-up opacity-0 delay-300">
                <a
                  href="#vaults"
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-[var(--foreground)] text-[var(--background)] text-sm font-medium rounded-md hover:opacity-90 transition-opacity"
                >
                  View Vaults
                </a>
                <a
                  href="https://yldfi.gitbook.io/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-5 py-2.5 border border-[var(--border)] text-sm font-medium rounded-md hover:bg-[var(--muted)] transition-colors"
                >
                  Read Docs <ArrowUpRight size={14} />
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Stats */}
        <section className="border-b border-[var(--border)]">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="grid grid-cols-3 divide-x divide-[var(--border)]">
              {stats.map((stat, i) => (
                <div
                  key={stat.label}
                  className="py-6 sm:py-8 md:py-12 px-2 sm:px-4 first:pl-0 last:pr-0 animate-fade-in-up opacity-0"
                  style={{ animationDelay: `${i * 100}ms` }}
                >
                  <p className="mono text-lg sm:text-2xl md:text-3xl font-medium mb-1">
                    {stat.value}
                  </p>
                  <p className="text-xs sm:text-sm text-[var(--muted-foreground)]">
                    {stat.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Vaults */}
        <section id="vaults" className="scroll-mt-16">
          <div className="max-w-6xl mx-auto px-6 py-16 md:py-24">
            <div className="flex items-end justify-between mb-12">
              <div>
                <p className="mono text-sm text-[var(--muted-foreground)] mb-2">
                  [002] Active Vaults
                </p>
                <h2 className="text-2xl md:text-3xl font-medium tracking-tight">
                  Select a vault
                </h2>
              </div>
            </div>

            <div className="space-y-4">
              {vaults.map((vault, i) => (
                <Link
                  key={vault.id}
                  href={`/vaults/${vault.id}`}
                  className={cn(
                    "group block border border-[var(--border)] rounded-lg p-4 md:p-6 transition-all hover:border-[var(--border-hover)] hover:bg-[var(--muted)]/50 animate-fade-in-up opacity-0",
                  )}
                  style={{ animationDelay: `${i * 100}ms` }}
                >
                  {/* Mobile Layout */}
                  <div className="md:hidden">
                    <div className="flex items-center gap-3 mb-2">
                      <Image
                        src={vault.logo}
                        alt={vault.name}
                        width={40}
                        height={40}
                        className="rounded-full"
                      />
                      <h3 className="text-xl font-semibold group-hover:text-[var(--accent)] transition-colors">
                        {vault.name}
                      </h3>
                    </div>
                    <p className="text-sm text-[var(--muted-foreground)] mb-3 leading-relaxed">
                      {vault.description}
                    </p>
                    <div className="flex items-center gap-2.5 mb-4">
                      {vault.badges?.map((badge) => (
                        badge === "Collateral (LlamaLend)" ? (
                          <span key={badge} className="collateral-badge inline-flex items-center px-2 py-1 text-[11px] font-medium bg-[var(--muted)] text-[var(--muted-foreground)] rounded whitespace-nowrap">
                            <Image src="/curve-logo.png" alt="Curve" width={12} height={12} className="mr-1" />
                            Collateral
                          </span>
                        ) : (
                          <span key={badge} className="inline-flex items-center px-2 py-1 text-[11px] font-medium bg-[var(--muted)] text-[var(--muted-foreground)] rounded border border-transparent whitespace-nowrap">
                            {badge}
                          </span>
                        )
                      ))}
                    </div>
                    <div className="grid grid-cols-3 gap-2 pt-3 border-t border-[var(--border)]">
                      <div className="text-center">
                        <p className="mono text-base font-medium text-[var(--success)]">
                          {isLoading ? "..." : `${vault.apy.toFixed(2)}%`}
                        </p>
                        <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">APY</p>
                      </div>
                      <div className="text-center">
                        <p className="mono text-base font-medium">
                          {isLoading ? "..." : formatNumber(vault.tvl)}
                        </p>
                        <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">TVL</p>
                      </div>
                      <div className="text-center">
                        <p className={cn(
                          "mono text-base font-medium",
                          vault.hasHoldings && "text-[var(--accent)]"
                        )}>
                          {isConnected ? vault.holdings : "—"}
                        </p>
                        <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">Holdings</p>
                      </div>
                    </div>
                  </div>

                  {/* Desktop Layout */}
                  <div className="hidden md:flex md:items-center justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <Image
                        src={vault.logo}
                        alt={vault.name}
                        width={40}
                        height={40}
                        className="rounded-full mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <h3 className="text-lg font-medium group-hover:text-[var(--accent)] transition-colors">
                          {vault.name}
                        </h3>
                        <div className="flex items-center gap-2 mt-1">
                          {vault.badges?.map((badge) => (
                            badge === "Collateral (LlamaLend)" ? (
                              <span key={badge} className="collateral-badge inline-flex items-center px-1.5 py-0.5 text-xs font-medium bg-[var(--muted)] text-[var(--muted-foreground)] rounded whitespace-nowrap">
                                <Image src="/curve-logo.png" alt="Curve" width={10} height={10} className="mr-1" />
                                Collateral
                              </span>
                            ) : (
                              <span key={badge} className="inline-flex items-center px-1.5 py-0.5 text-xs font-medium bg-[var(--muted)] text-[var(--muted-foreground)] rounded border border-transparent whitespace-nowrap">
                                {badge}
                              </span>
                            )
                          ))}
                        </div>
                        <p className="text-sm text-[var(--muted-foreground)] max-w-md mt-1.5">
                          {vault.description}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-6">
                      <div className="text-right w-16">
                        <p className="mono text-lg font-medium text-[var(--success)]">
                          {isLoading ? "..." : `${vault.apy.toFixed(2)}%`}
                        </p>
                        <p className="text-xs text-[var(--muted-foreground)]">APY</p>
                      </div>
                      <div className="text-right w-20">
                        <p className="mono text-lg font-medium">
                          {isLoading ? "..." : formatNumber(vault.tvl)}
                        </p>
                        <p className="text-xs text-[var(--muted-foreground)]">TVL</p>
                      </div>
                      <div className="text-right w-20">
                        <p className={cn(
                          "mono text-lg font-medium",
                          vault.hasHoldings && "text-[var(--accent)]"
                        )}>
                          {isConnected ? vault.holdings : "—"}
                        </p>
                        <p className="text-xs text-[var(--muted-foreground)]">Holdings</p>
                      </div>
                      <div className="w-5">
                        <ArrowUpRight
                          size={20}
                          className="text-[var(--muted-foreground)] group-hover:text-[var(--foreground)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all"
                        />
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-[var(--border)]">
          <div className="max-w-6xl mx-auto px-6 py-16 md:py-24">
            <div className="mb-12">
              <p className="mono text-sm text-[var(--muted-foreground)] mb-2">
                [003] Architecture
              </p>
              <h2 className="text-2xl md:text-3xl font-medium tracking-tight">
                How it works
              </h2>
            </div>

            <div className="grid md:grid-cols-3 gap-8 md:gap-12">
              {[
                {
                  step: "01",
                  title: "Deposit",
                  description:
                    "Connect your wallet and deposit tokens into any vault. Receive yield-bearing vault shares in return.",
                },
                {
                  step: "02",
                  title: "Compound",
                  description:
                    "Strategies automatically harvest and reinvest rewards. No manual claiming or gas fees required.",
                },
                {
                  step: "03",
                  title: "Withdraw",
                  description:
                    "Redeem your vault shares anytime. Receive your original deposit plus accumulated yield.",
                },
              ].map((item, i) => (
                <div
                  key={item.step}
                  className="animate-fade-in-up opacity-0"
                  style={{ animationDelay: `${i * 100}ms` }}
                >
                  <p className="mono text-sm text-[var(--muted-foreground)] mb-3">
                    {item.step}
                  </p>
                  <h3 className="text-lg font-medium mb-2">{item.title}</h3>
                  <p className="text-sm text-[var(--muted-foreground)] leading-relaxed">
                    {item.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-[var(--border)]">
        <div className="max-w-6xl mx-auto px-6 py-12">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            <div className="flex items-center gap-3">
              <Logo size={32} />
              <div>
                <p className="mono text-lg font-medium mb-1">
                  yld<span className="text-[var(--muted-foreground)]">_</span>fi
                </p>
                <p className="text-sm text-[var(--muted-foreground)]">
                  Automated yield optimization
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <a
                href="https://yldfi.gitbook.io/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                title="Documentation"
              >
                <BookOpen size={18} />
              </a>
              <a
                href="https://github.com/yldfi"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                title="GitHub"
              >
                <Github size={18} />
              </a>
              <a
                href="https://t.me/yld_fi"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                title="Telegram"
              >
                <Send size={18} />
              </a>
            </div>
          </div>

          <div className="mt-12 pt-6 border-t border-[var(--border)] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <p className="text-xs text-[var(--muted-foreground)]">
              &copy; {new Date().getFullYear()} YLD.fi. All rights reserved.
            </p>
            <div className="flex items-center gap-4">
              <a
                href="/terms"
                className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              >
                Terms of Service
              </a>
              <a
                href="/privacy"
                className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              >
                Privacy Policy
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
