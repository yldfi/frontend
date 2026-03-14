"use client";

import { useState, useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { useRouter } from "next/navigation";
import { CustomConnectButton } from "@/components/CustomConnectButton";
import { ArrowUpRight, Github, BookOpen, Send, ChevronDown, ChevronUp, HeartPulse } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { cn, formatUsd } from "@/lib/utils";
import { PixelAnimation } from "@/components/PixelAnimation";
import { Logo } from "@/components/Logo";
import { useYearnVault, formatYearnVaultData } from "@/hooks/useYearnVault";
import { useMultipleVaultBalances } from "@/hooks/useVaultBalance";
import { useMultiplePricePerShare } from "@/hooks/usePricePerShare";
import { useVaultCache } from "@/hooks/useVaultCache";
import { useCvxCrvPrice } from "@/hooks/useCvxCrvPrice";
import { useCurveLendingPosition, formatHealth } from "@/hooks/useCurveLendingPosition";
import { VAULTS, VAULT_ADDRESSES, CURVE_CONTROLLERS } from "@/config/vaults";

// Build vault configs from centralized config
// In development, show all vaults including hidden ones
const isDev = process.env.NODE_ENV === "development";
const vaultConfigs = Object.values(VAULTS)
  .filter((vault) => isDev || !vault.hidden)
  .map((vault) => ({
    id: vault.id,
    name: vault.name,
    description: vault.description,
    token: vault.assetSymbol,
    chain: vault.chain,
    contractAddress: vault.address,
    badges: vault.badges,
    type: vault.type,
    fee: vault.fees.performance,
    feeBreakdown: vault.feeBreakdown,
    logo: vault.logoSmall,
    hasLending: vault.type === "vault" && vault.address in CURVE_CONTROLLERS,
  }));

type SortOption = "holdings" | "apy" | "tvl";

const SORT_STORAGE_KEY = "yldfi-vault-sort";
const HERO_COLLAPSED_KEY = "yldfi-hero-collapsed";

// Get initial sort value from localStorage (called once during component init)
function getInitialSortValue(): SortOption {
  if (typeof window === "undefined") return "holdings";
  try {
    const saved = localStorage.getItem(SORT_STORAGE_KEY);
    if (saved && ["holdings", "apy", "tvl"].includes(saved)) {
      return saved as SortOption;
    }
  } catch {
    // localStorage not available
  }
  return "holdings";
}

// Get initial hero collapsed state from localStorage
function getInitialHeroCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const saved = localStorage.getItem(HERO_COLLAPSED_KEY);
    return saved === "true";
  } catch {
    // localStorage not available
  }
  return false;
}

export function HomePageContent() {
  const { isConnected, address } = useAccount();
  const router = useRouter();
  const [sortBy, setSortBy] = useState<SortOption>(getInitialSortValue);
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const sortDropdownRef = useRef<HTMLDivElement>(null);
  const [heroCollapsed, setHeroCollapsed] = useState(getInitialHeroCollapsed);

  // Toggle hero collapsed state with persistence
  const toggleHeroCollapsed = () => {
    const newValue = !heroCollapsed;
    setHeroCollapsed(newValue);
    try {
      localStorage.setItem(HERO_COLLAPSED_KEY, String(newValue));
    } catch {
      // localStorage not available
    }
  };

  // Close sort dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (sortDropdownRef.current && !sortDropdownRef.current.contains(event.target as Node)) {
        setSortDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Save sort preference to localStorage when it changes
  const handleSortChange = (option: SortOption) => {
    setSortBy(option);
    setSortDropdownOpen(false);
    try {
      localStorage.setItem(SORT_STORAGE_KEY, option);
    } catch {
      // localStorage not available
    }
  };

  // Fetch cached vault data (fast, from edge)
  const { data: cacheData, isLoading: cacheLoading } = useVaultCache();

  // Fetch Yearn vault data (for APY from Kong API)
  const { data: ycvxcrvData, isLoading: ycvxcrvLoading } = useYearnVault(VAULT_ADDRESSES.YCVXCRV);
  const { data: yscvxcrvData } = useYearnVault(VAULT_ADDRESSES.YSCVXCRV);
  const { data: yscvgcvxData } = useYearnVault(VAULT_ADDRESSES.YSCVGCVX);
  const { data: yspxcvxData } = useYearnVault(VAULT_ADDRESSES.YSPXCVX);

  const ycvxcrvVault = formatYearnVaultData(ycvxcrvData?.vault, ycvxcrvData?.vaultStrategies);
  const yscvxcrvVault = formatYearnVaultData(yscvxcrvData?.vault, yscvxcrvData?.vaultStrategies);
  const yscvgcvxVault = formatYearnVaultData(yscvgcvxData?.vault, yscvgcvxData?.vaultStrategies);
  const yspxcvxVault = formatYearnVaultData(yspxcvxData?.vault, yspxcvxData?.vaultStrategies);

  // Use on-chain cvxCRV price (like vault detail page) to avoid $0 on cache miss
  const { price: cvxCrvPriceOnChain } = useCvxCrvPrice();
  // Fall back to cache only if on-chain price not available yet
  const cvxCrvPrice = cvxCrvPriceOnChain || cacheData?.cvxCrvPrice || 0;
  // cvgCVX and pxCVX still use cache (no on-chain oracle hooks yet)
  const cvgCvxPrice = cacheData?.cvgCvxPrice ?? 0;
  const pxCvxPrice = 0; // TODO: uncomment when yspxcvx is live — cacheData?.pxCvxPrice ?? 0

  // Fetch lending position for vaults with LlamaLend markets
  const { position: ycvxcrvLendingPosition } = useCurveLendingPosition(
    VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
    address
  );

  // Fetch price per share from on-chain
  const { prices: pricePerShareData } = useMultiplePricePerShare([
    VAULT_ADDRESSES.YCVXCRV,
    VAULT_ADDRESSES.YSCVXCRV,
    VAULT_ADDRESSES.YSCVGCVX,
    VAULT_ADDRESSES.YSPXCVX,
  ]);

  const ycvxcrvPricePerShare = pricePerShareData[0]?.pricePerShare ?? 1;
  const yscvxcrvPricePerShare = pricePerShareData[1]?.pricePerShare ?? 1;
  const yscvgcvxPricePerShare = pricePerShareData[2]?.pricePerShare ?? 1;
  const yspxcvxPricePerShare = pricePerShareData[3]?.pricePerShare ?? 1;

  // Fetch user vault balances
  const { balances } = useMultipleVaultBalances([
    {
      address: VAULT_ADDRESSES.YCVXCRV,
      pricePerShare: ycvxcrvPricePerShare,
      assetPriceUsd: cvxCrvPrice,
    },
    {
      address: VAULT_ADDRESSES.YSCVXCRV,
      pricePerShare: yscvxcrvPricePerShare,
      assetPriceUsd: cvxCrvPrice,
    },
    {
      address: VAULT_ADDRESSES.YSCVGCVX,
      pricePerShare: yscvgcvxPricePerShare,
      assetPriceUsd: cvgCvxPrice,
    },
    {
      address: VAULT_ADDRESSES.YSPXCVX,
      pricePerShare: yspxcvxPricePerShare,
      assetPriceUsd: pxCvxPrice,
    },
  ]);

  // Use cache for fast initial load, Yearn API for APY
  const isLoading = cacheLoading && ycvxcrvLoading;

  // Build vault list with live data
  // Kong returns net APY (after fees) for all vaults and strategies
  const ycvxcrvNetApy = ycvxcrvVault?.weeklyApy ?? 0;
  const yscvxcrvNetApy = yscvxcrvVault?.weeklyApy ?? 0;
  const yscvgcvxNetApy = yscvgcvxVault?.weeklyApy ?? 0;
  const yspxcvxNetApy = yspxcvxVault?.weeklyApy ?? 0;

  // Use cached TVL (fast) or fall back to Yearn API TVL
  const ycvxcrvTvl = cacheData?.ycvxcrv?.tvlUsd ?? ycvxcrvVault?.tvl ?? 0;
  const yscvxcrvTvl = cacheData?.yscvxcrv?.tvlUsd ?? yscvxcrvVault?.tvl ?? 0;
  const yscvgcvxTvl = cacheData?.yscvgcvx?.tvlUsd ?? 0;
  const yspxcvxTvl = yspxcvxVault?.tvl ?? 0; // TODO: uncomment when yspxcvx is live — cacheData?.yspxcvx?.tvlUsd ?? ...

  // Get TVL for each vault by ID
  const getTvlForVault = (id: string): number => {
    switch (id) {
      case "ycvxcrv": return ycvxcrvTvl;
      case "yscvxcrv": return yscvxcrvTvl;
      case "yscvgcvx": return yscvgcvxTvl;
      case "yspxcvx": return yspxcvxTvl;
      default: return 0;
    }
  };

  // Get APY for each vault by ID (all from Kong)
  const getApyForVault = (id: string): number => {
    switch (id) {
      case "ycvxcrv": return ycvxcrvNetApy;
      case "yscvxcrv": return yscvxcrvNetApy;
      case "yscvgcvx": return yscvgcvxNetApy;
      case "yspxcvx": return yspxcvxNetApy;
      default: return 0;
    }
  };

  // Create balance lookup by address for correct mapping when hidden vaults shown
  const balanceByAddress = {
    [VAULT_ADDRESSES.YCVXCRV.toLowerCase()]: balances[0],
    [VAULT_ADDRESSES.YSCVXCRV.toLowerCase()]: balances[1],
    [VAULT_ADDRESSES.YSCVGCVX.toLowerCase()]: balances[2],
    [VAULT_ADDRESSES.YSPXCVX.toLowerCase()]: balances[3],
  };

  // Lending position lookup by vault ID
  const lendingPositionByVaultId: Record<string, typeof ycvxcrvLendingPosition> = {
    ycvxcrv: ycvxcrvLendingPosition,
  };

  const vaultsUnsorted = vaultConfigs.map((config) => {
    const balance = balanceByAddress[config.contractAddress.toLowerCase()];
    return {
      ...config,
      tvl: getTvlForVault(config.id),
      apy: getApyForVault(config.id),
      holdings: balance?.formattedUsd ?? "$0",
      holdingsUsd: balance?.usdValue ?? 0,
      hasHoldings: (balance?.usdValue ?? 0) > 0,
      lendingPosition: lendingPositionByVaultId[config.id] ?? null,
    };
  });

  // Sort vaults based on selected option (descending - highest first)
  const vaults = [...vaultsUnsorted].sort((a, b) => {
    switch (sortBy) {
      case "apy":
        return b.apy - a.apy;
      case "tvl":
        return b.tvl - a.tvl;
      case "holdings":
        return b.holdingsUsd - a.holdingsUsd;
      default:
        return 0;
    }
  });

  // Total TVL across all vaults
  const totalTvl = yscvxcrvTvl + yscvgcvxTvl + yspxcvxTvl;
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

      <main style={{ paddingTop: "calc(4rem + var(--test-banner-height))" }}>
        {/* Hero + Stats collapsible section */}
        <div className="relative">
          {/* Hero - uses grid for collapse to preserve canvas dimensions */}
          <section
            className={cn(
              "border-b border-[var(--border)] relative overflow-hidden transition-all duration-500 ease-in-out grid",
              heroCollapsed ? "grid-rows-[0fr] border-b-0" : "grid-rows-[1fr]"
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="relative">
                <div className="absolute inset-0">
                  <PixelAnimation />
                </div>
                <div
                  className={cn(
                    "max-w-6xl mx-auto px-4 sm:px-6 relative z-10 py-24 md:py-32 transition-opacity duration-500",
                    heroCollapsed ? "opacity-0" : "opacity-100"
                  )}
                >
              <div className="max-w-3xl">
                <p className="mono text-sm text-[var(--muted-foreground)] mb-4 animate-fade-in">
                  [001] yld
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
              </div>
            </div>
          </section>

          {/* Stats - hidden when hero is collapsed */}
          <section
            className={cn(
              "border-b border-[var(--border)] transition-all duration-500 ease-in-out overflow-hidden",
              heroCollapsed ? "max-h-0 border-b-0 opacity-0" : "max-h-[200px] opacity-100"
            )}
          >
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
        </div>

        {/* Toggle button - separate element for proper positioning */}
        <div className={cn(
          "flex justify-center relative transition-all duration-500",
          heroCollapsed ? "-mt-[19px] mb-0 z-[60]" : "-mt-[19px] mb-0 z-20"
        )}>
          <button
            onClick={toggleHeroCollapsed}
            className="p-2 bg-[var(--muted)] border border-[var(--border)] rounded-full hover:bg-[var(--border)] hover:border-[var(--border-hover)] transition-all shadow-md"
            aria-label={heroCollapsed ? "Expand hero section" : "Collapse hero section"}
          >
            {heroCollapsed ? (
              <ChevronDown size={18} className="text-[var(--foreground)]" />
            ) : (
              <ChevronUp size={18} className="text-[var(--foreground)]" />
            )}
          </button>
        </div>

        {/* Vaults */}
        <section id="vaults" className="scroll-mt-16">
          <div className={cn(
            "max-w-6xl mx-auto px-4 sm:px-6 transition-all duration-500",
            heroCollapsed ? "py-6 md:py-8" : "py-16 md:py-24"
          )}>
            <div className="flex items-end justify-between mb-12">
              <div>
                <p className="mono text-sm text-[var(--muted-foreground)] mb-2">
                  [002] Active Vaults
                </p>
                <h2 className="text-2xl md:text-3xl font-medium tracking-tight">
                  Select a vault
                </h2>
              </div>
              {/* Sort dropdown */}
              <div ref={sortDropdownRef} className="relative">
                <button
                  onClick={() => setSortDropdownOpen(!sortDropdownOpen)}
                  className="flex items-center gap-2 px-3 py-2 text-sm border border-[var(--border)] rounded-md hover:bg-[var(--muted)] transition-colors"
                >
                  <span className="text-[var(--muted-foreground)]">Sort by:</span>
                  <span className="font-medium capitalize">{sortBy}</span>
                  <ChevronDown
                    size={16}
                    className={cn(
                      "text-[var(--muted-foreground)] transition-transform",
                      sortDropdownOpen && "rotate-180"
                    )}
                  />
                </button>
                {sortDropdownOpen && (
                  <div className="absolute top-full right-0 mt-2 bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg z-50 min-w-[140px] py-1">
                    {(["holdings", "apy", "tvl"] as const).map((option) => (
                      <button
                        key={option}
                        onClick={() => handleSortChange(option)}
                        className={cn(
                          "w-full px-4 py-2 text-left text-sm hover:bg-[var(--muted)] transition-colors capitalize",
                          sortBy === option && "bg-[var(--muted)] font-medium"
                        )}
                      >
                        {option === "apy" ? "APY" : option === "tvl" ? "TVL" : "Holdings"}
                      </button>
                    ))}
                  </div>
                )}
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
                          <button
                            key={badge}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); router.push(`/vaults/${vault.id}/lending`); }}
                            className="group/badge collateral-badge inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-[var(--muted)] text-white rounded whitespace-nowrap hover:text-[var(--foreground)] transition-colors max-w-full"
                          >
                            <Image src="/curve-logo.png" alt="Curve" width={12} height={12} className="rounded-full" />
                            {vault.lendingPosition?.hasLoan ? (
                              <>
                                <span>Loan</span>
                                <span className="mx-0.5">·</span>
                                <Image src="/tokens/crvusd.png" alt="crvUSD" width={12} height={12} className="rounded-full hidden lg:inline" />
                                <span className="mono">{Number(formatUnits(vault.lendingPosition.debt, 18)).toFixed(0)}<span className="hidden lg:inline"> crvUSD</span></span>
                                <span className="hidden lg:inline">/</span>
                                <Image src={vault.logo} alt={vault.name} width={12} height={12} className="rounded-full hidden lg:inline" />
                                <span className="mono hidden lg:inline">{Number(formatUnits(vault.lendingPosition.collateral, 18)).toFixed(0)} {vault.name}</span>
                                {(() => { const h = formatHealth(vault.lendingPosition.health); const hoverColor = h.status === "healthy" ? "group-hover/badge:text-green-500" : h.status === "warning" ? "group-hover/badge:text-yellow-500" : "group-hover/badge:text-red-400"; return <span className={`hidden lg:inline-flex items-center gap-0.5 ${h.color} ${hoverColor} transition-colors`}><HeartPulse size={10} /><span className="mono">{h.value.toFixed(0)}%</span></span>; })()}
                              </>
                            ) : (
                              <span>Borrow against {vault.name}</span>
                            )}
                            <ArrowUpRight size={10} />
                          </button>
                        ) : (
                          <span key={badge} className={`inline-flex items-center px-2 py-1 text-[11px] font-medium bg-[var(--muted)] text-white rounded border border-transparent whitespace-nowrap${badge === "Compounder" ? " hidden sm:inline-flex" : ""}`}>
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
                          {isLoading ? "..." : formatUsd(vault.tvl)}
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
                        <div className="flex items-center gap-2.5 mt-1">
                          {vault.badges?.map((badge) => (
                            badge === "Collateral (LlamaLend)" ? (
                              <button
                                key={badge}
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); router.push(`/vaults/${vault.id}/lending`); }}
                                className="group/badge collateral-badge inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium bg-[var(--muted)] text-white rounded whitespace-nowrap hover:text-[var(--foreground)] transition-colors max-w-full"
                              >
                                <Image src="/curve-logo.png" alt="Curve" width={10} height={10} className="rounded-full" />
                                {vault.lendingPosition?.hasLoan ? (
                                  <>
                                    <span>Loan</span>
                                    <span>·</span>
                                    <Image src="/tokens/crvusd.png" alt="crvUSD" width={10} height={10} className="rounded-full hidden lg:inline" />
                                    <span className="mono">{Number(formatUnits(vault.lendingPosition.debt, 18)).toFixed(0)}<span className="hidden lg:inline"> crvUSD</span></span>
                                    <span className="hidden lg:inline">/</span>
                                    <Image src={vault.logo} alt={vault.name} width={10} height={10} className="rounded-full hidden lg:inline" />
                                    <span className="mono hidden lg:inline">{Number(formatUnits(vault.lendingPosition.collateral, 18)).toFixed(0)} {vault.name}</span>
                                    {(() => { const h = formatHealth(vault.lendingPosition.health); const hoverColor = h.status === "healthy" ? "group-hover/badge:text-green-500" : h.status === "warning" ? "group-hover/badge:text-yellow-500" : "group-hover/badge:text-red-400"; return <span className={`hidden lg:inline-flex items-center gap-0.5 ${h.color} ${hoverColor} transition-colors`}><HeartPulse size={10} /><span className="mono">{h.value.toFixed(0)}%</span></span>; })()}
                                  </>
                                ) : (
                                  <span>Borrow against {vault.name}</span>
                                )}
                                <ArrowUpRight size={10} />
                              </button>
                            ) : (
                              <span key={badge} className={`inline-flex items-center px-1.5 py-0.5 text-xs font-medium bg-[var(--muted)] text-white rounded border border-transparent whitespace-nowrap${badge === "Compounder" ? " hidden sm:inline-flex" : ""}`}>
                                {badge}
                              </span>
                            )
                          ))}
                        </div>
                        <p className="text-sm text-[var(--muted-foreground)] mt-1.5">
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
                          {isLoading ? "..." : formatUsd(vault.tvl)}
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
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 md:py-24">
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
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            <div className="flex items-center gap-3">
              <Logo size={32} />
              <div>
                <p className="mono text-lg font-medium mb-1">
                  yld
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
                aria-label="Documentation"
              >
                <BookOpen size={18} aria-hidden="true" />
              </a>
              <a
                href="https://github.com/yldfi"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                aria-label="GitHub"
              >
                <Github size={18} aria-hidden="true" />
              </a>
              <a
                href="https://t.me/yld_fi"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                aria-label="Telegram"
              >
                <Send size={18} aria-hidden="true" />
              </a>
            </div>
          </div>

          <div className="mt-12 pt-6 border-t border-[var(--border)] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <p className="text-xs text-[var(--muted-foreground)]">
              &copy; {new Date().getFullYear()} yld. All rights reserved.
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
