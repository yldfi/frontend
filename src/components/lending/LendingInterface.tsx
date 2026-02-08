"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import { formatUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import type { VaultConfig } from "@/config/vaults";
import type { LendingPosition } from "@/hooks/useCurveLendingPosition";
import { useInversePosition } from "@/hooks/useInversePosition";
import { LeverageTab } from "./LeverageTab";
import { RepayTab } from "./RepayTab";
import { BorrowTab } from "./BorrowTab";
import { CollateralTab } from "./CollateralTab";
import { NewLoanTab } from "./NewLoanTab";
import { MigrateSection } from "./MigrateSection";
import { cn } from "@/lib/utils";

interface LendingPanelProps {
  vault: VaultConfig;
  userBalance: string; // Vault token balance in wei
  position: LendingPosition | null;
  positionLoading?: boolean;
  controllerAddress: `0x${string}`;
  onTransactionSuccess: () => void;
}

type Tab = "collateral" | "borrow" | "repay" | "leverage";

// Health bar: visual bar at top of panel, red→green, ∞ at right end
function HealthBar({
  currentHealth,
  estimatedHealth,
}: {
  currentHealth?: number;
  estimatedHealth: number | null;
}) {
  const isFlashing = estimatedHealth !== null &&
    (currentHealth === undefined || Math.round(estimatedHealth) !== Math.round(currentHealth));

  const getColor = (h: number): string => {
    if (h <= 0) return "#ef4444";
    if (h < 5) return "#ef4444";
    if (h < 10) return "#f97316";
    if (h < 20) return "#eab308";
    if (h < 40) return "#84cc16";
    return "#22c55e";
  };

  const displayHealth = estimatedHealth ?? currentHealth ?? 0;
  const percent = Math.min(Math.max(displayHealth, 0), 100);
  const color = getColor(displayHealth);

  const currentPercent = currentHealth !== undefined
    ? Math.min(Math.max(currentHealth, 0), 100)
    : 0;
  const currentColor = currentHealth !== undefined ? getColor(currentHealth) : color;
  const hasEstimate = estimatedHealth !== null && currentHealth !== undefined;

  if (currentHealth === undefined && estimatedHealth === null) return null;

  return (
    <div className="flex items-center gap-2 px-4 pt-3 pb-1">
      <div className="relative flex-1 h-2 rounded-full bg-[var(--muted)] overflow-hidden">
        {/* Ghost bar: shows current health at reduced opacity when estimate differs */}
        {hasEstimate && currentPercent !== percent && (
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out"
            style={{
              width: `${currentPercent}%`,
              backgroundColor: currentColor,
              opacity: 0.25,
            }}
          />
        )}
        {/* Main bar: shows estimated (or current if no estimate) */}
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out"
          style={{
            width: `${percent}%`,
            backgroundColor: color,
            animation: isFlashing
              ? "health-pulse 1.2s ease-in-out infinite"
              : "none",
          }}
        />
      </div>
      <span
        className="text-sm font-medium mono leading-none select-none min-w-[2ch] text-right"
        style={{ color: displayHealth >= 100 ? "var(--muted-foreground)" : color }}
      >
        {displayHealth >= 100
          ? <span className="text-xl leading-none" style={{ position: "relative", top: "2px" }}>∞</span>
          : `${Math.round(displayHealth)}%`}
      </span>
    </div>
  );
}

export function LendingInterface({
  vault,
  userBalance,
  position,
  positionLoading,
  controllerAddress,
  onTransactionSuccess,
}: LendingPanelProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  // Oracle price for accurate leverage display
  const [oraclePrice, setOraclePrice] = useState<bigint>(0n);
  useEffect(() => {
    async function readOraclePrice() {
      if (!publicClient) return;
      try {
        const ammAddress = await publicClient.readContract({
          address: controllerAddress,
          abi: [{ name: "amm", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const,
          functionName: "amm",
        });
        const price = await publicClient.readContract({
          address: ammAddress as `0x${string}`,
          abi: [{ name: "price_oracle", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }] as const,
          functionName: "price_oracle",
        });
        setOraclePrice(price);
      } catch {
        setOraclePrice(0n);
      }
    }
    readOraclePrice();
  }, [publicClient, controllerAddress]);

  // Inverse Finance position (for migration banner)
  const inversePosition = useInversePosition(address);

  // Active tab with localStorage persistence
  const [activeTab, setActiveTabState] = useState<Tab>(() => {
    if (typeof window === "undefined") return "collateral";
    try {
      const saved = localStorage.getItem("yldfi-lending-tab");
      if (saved === "collateral" || saved === "borrow" || saved === "repay" || saved === "leverage") return saved;
    } catch {
      // localStorage unavailable
    }
    return "collateral";
  });
  const setActiveTab = (tab: Tab) => {
    setActiveTabState(tab);
    try {
      localStorage.setItem("yldfi-lending-tab", tab);
    } catch {
      // localStorage unavailable
    }
  };

  // Child tab estimated health (all tabs now report via callback)
  const [childEstimatedHealth, setChildEstimatedHealth] = useState<number | null>(null);
  const handleEstimatedHealthChange = useCallback((health: number | null) => {
    setChildEstimatedHealth(health);
  }, []);

  // Child tab estimated leverage
  const [childEstimatedLeverage, setChildEstimatedLeverage] = useState<number | null>(null);
  const handleEstimatedLeverageChange = useCallback((lev: number | null) => {
    setChildEstimatedLeverage(lev);
  }, []);

  // Clear child estimates when switching tabs
  useEffect(() => {
    setChildEstimatedHealth(null);
    setChildEstimatedLeverage(null);
  }, [activeTab]);

  const effectiveEstimatedHealth = childEstimatedHealth;

  // Position summary values
  const positionCollateral = useMemo(() => {
    if (!position?.hasLoan) return null;
    return Number(formatUnits(position.collateral, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });
  }, [position, vault.decimals]);

  const positionDebt = useMemo(() => {
    if (!position?.hasLoan) return null;
    return Number(formatUnits(position.debt, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }, [position]);

  const effectiveLeverage = useMemo(() => {
    if (!position?.hasLoan || position.collateral === 0n || oraclePrice === 0n) return null;
    // collateralValue in crvUSD = collateral * oraclePrice / 10^decimals
    const collValue = Number(formatUnits(position.collateral * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
    const debt = Number(formatUnits(position.debt, 18));
    if (collValue <= 0 || collValue <= debt) return null;
    return (collValue / (collValue - debt)).toFixed(2);
  }, [position, vault.decimals, oraclePrice]);

  const hasLoan = position?.hasLoan ?? false;

  // --- Loading: show skeleton while position data loads ---
  if (positionLoading) {
    return (
      <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl overflow-hidden p-4">
        <div className="flex items-center justify-center py-12 text-[var(--muted-foreground)] text-sm">
          Loading position…
        </div>
      </div>
    );
  }

  // --- No Loan View: NewLoanTab + optional MigrateSection ---
  if (!hasLoan) {
    return (
      <div className="space-y-4">
        <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl overflow-hidden">
          {/* Health Bar (shows estimated health from NewLoanTab) */}
          <HealthBar
            currentHealth={undefined}
            estimatedHealth={effectiveEstimatedHealth}
          />

          <div className="p-4 space-y-4">
            <NewLoanTab
              vault={vault}
              userBalance={userBalance}
              controllerAddress={controllerAddress}
              onTransactionSuccess={onTransactionSuccess}
              onEstimatedHealthChange={handleEstimatedHealthChange}
            />
          </div>
        </div>

        {/* Migration banner (only when Inverse position detected) */}
        {inversePosition?.hasPosition && (
          <MigrateSection
            inversePosition={inversePosition}
            onMigrationComplete={onTransactionSuccess}
          />
        )}
      </div>
    );
  }

  // --- Has Loan View: Position summary + Health bar + Management tabs ---
  return (
    <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl overflow-hidden">
      {/* Position Summary */}
      <div className={cn(
        "grid gap-x-3 gap-y-0.5 px-4 pt-3 pb-2",
        effectiveLeverage ? "grid-cols-3" : "grid-cols-2"
      )}>
        <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
          Collateral
        </div>
        <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
          Debt
        </div>
        {effectiveLeverage && (
          <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)] text-right">
            Leverage
          </div>
        )}
        <div className="flex items-center gap-1.5">
          {vault.logo && (
            <Image src={vault.logo} alt="" width={14} height={14} className="rounded-full" />
          )}
          <span className="mono text-sm font-medium truncate">{positionCollateral}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Image src="/tokens/crvusd.png" alt="" width={14} height={14} className="rounded-full" />
          <span className="mono text-sm font-medium truncate">{positionDebt}</span>
        </div>
        {effectiveLeverage && (
          <div
            className="mono text-sm font-medium text-right"
            style={{
              animation: childEstimatedLeverage !== null && childEstimatedLeverage.toFixed(2) !== effectiveLeverage
                ? "health-pulse 1.2s ease-in-out infinite"
                : "none",
            }}
          >
            {childEstimatedLeverage !== null ? childEstimatedLeverage.toFixed(2) : effectiveLeverage}x
          </div>
        )}
      </div>

      {/* Health Bar */}
      <HealthBar
        currentHealth={position?.healthFull}
        estimatedHealth={effectiveEstimatedHealth}
      />

      {/* Tabs */}
      <div className="p-4 pb-0">
        <div className="flex border-b border-[var(--border)]">
          {(["collateral", "borrow", "repay", "leverage"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "flex-1 pb-3 text-sm font-medium transition-all capitalize relative",
                activeTab === tab
                  ? "text-[var(--foreground)]"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              )}
            >
              {tab}
              {activeTab === tab && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--foreground)]" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Form Content */}
      <div className="p-4 space-y-4">
        {activeTab === "collateral" && (
          <CollateralTab
            vault={vault}
            userBalance={userBalance}
            position={position}
            controllerAddress={controllerAddress}
            onTransactionSuccess={onTransactionSuccess}
            onEstimatedHealthChange={handleEstimatedHealthChange}
          />
        )}
        {activeTab === "borrow" && (
          <BorrowTab
            vault={vault}
            position={position}
            controllerAddress={controllerAddress}
            onTransactionSuccess={onTransactionSuccess}
            onEstimatedHealthChange={handleEstimatedHealthChange}
          />
        )}
        {activeTab === "repay" && (
          <RepayTab
            vault={vault}
            position={position}
            controllerAddress={controllerAddress}
            onTransactionSuccess={onTransactionSuccess}
            onEstimatedHealthChange={handleEstimatedHealthChange}
          />
        )}
        {activeTab === "leverage" && (
          <LeverageTab
            vault={vault}
            userBalance={userBalance}
            position={position}
            controllerAddress={controllerAddress}
            onTransactionSuccess={onTransactionSuccess}
            onEstimatedHealthChange={handleEstimatedHealthChange}
            onEstimatedLeverageChange={handleEstimatedLeverageChange}
          />
        )}
      </div>
    </div>
  );
}
