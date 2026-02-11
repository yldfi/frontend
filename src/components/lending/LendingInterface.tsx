"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import { formatUnits } from "viem";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";
import type { VaultConfig } from "@/config/vaults";
import type { LendingPosition } from "@/hooks/useCurveLendingPosition";
import { LeverageTab } from "./LeverageTab";
import { RepayTab } from "./RepayTab";
import { BorrowTab } from "./BorrowTab";
import { CollateralTab } from "./CollateralTab";
import { NewLoanForm } from "./NewLoanForm";
import { Loader2, Check, X, ExternalLink, ArrowRight, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { CACHE_TIMES } from "@/config/query";
import { useYearnVault, formatYearnVaultData } from "@/hooks/useYearnVault";

export type LendingTxState = {
  status: "pending" | "success" | "reverted";
  action: string;
  hash: string;
  details?: {
    fromAmount: string;
    fromSymbol: string;
    fromLogo: string;
    toAmount: string;
    toSymbol: string;
    toLogo: string;
  };
} | null;

interface LendingPanelProps {
  vault: VaultConfig;
  userBalance: string; // Vault token balance in wei
  position: LendingPosition | null;
  positionLoading?: boolean;
  controllerAddress: `0x${string}`;
  onTransactionSuccess: () => void;
}

type Tab = "collateral" | "borrow" | "repay" | "leverage";

// Market rate data for semilog model
interface MarketRates {
  minRate: number; // APR %
  maxRate: number; // APR %
  totalDebt: bigint;
  totalAssets: bigint;
  utilization: number; // 0-1
}

const SECONDS_PER_YEAR = 365.25 * 86400;

// Semilog interest rate model: rate = minRate * (maxRate / minRate) ^ utilization
function semilogBorrowAPR(utilization: number, minRate: number, maxRate: number): number {
  if (minRate <= 0 || maxRate <= 0 || utilization < 0) return 0;
  const util = Math.min(utilization, 1);
  return minRate * Math.pow(maxRate / minRate, util);
}

// Health bar: visual bar at top of panel, red→green, ∞ at right end
function HealthBar({
  currentHealth,
  estimatedHealth,
  alwaysShow,
  title = "Position",
  titlePrefix,
}: {
  currentHealth?: number;
  estimatedHealth: number | null;
  alwaysShow?: boolean;
  title?: string;
  titlePrefix?: React.ReactNode;
}) {
  const isFlashing = estimatedHealth !== null &&
    (currentHealth === undefined || Math.round(estimatedHealth) !== Math.round(currentHealth)) &&
    !(estimatedHealth >= 100 && (currentHealth === undefined || currentHealth >= 100));

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

  if (currentHealth === undefined && estimatedHealth === null && !alwaysShow) return null;

  const isEmpty = currentHealth === undefined && estimatedHealth === null;

  return (
    <div>
      <div className="px-4 pt-3 pb-1 flex items-center gap-2">
        {titlePrefix}
        <span className="text-sm font-medium">{title}</span>
      </div>
      <div className="flex items-center gap-2 px-4 pb-1 h-8">
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
      {!isEmpty && (
        <span
          className="text-sm font-medium mono leading-none select-none min-w-[2ch] text-right"
          style={{ color: displayHealth >= 100 ? "var(--muted-foreground)" : color }}
        >
          {displayHealth >= 100
            ? <span className="text-xl leading-none" style={{ position: "relative", top: "1px" }}>∞</span>
            : `${Math.round(displayHealth)}%`}
        </span>
      )}
      </div>
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

  // Market rate data for semilog borrow APR model
  const rateAbi = [
    { name: "factory", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
    { name: "monetary_policy", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
    { name: "total_debt", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
    { name: "min_rate", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
    { name: "max_rate", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
    { name: "totalAssets", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  ] as const;

  const { data: marketRates } = useQuery({
    queryKey: ["curveMarketRates", controllerAddress],
    queryFn: async (): Promise<MarketRates> => {
      const pc = publicClient!;
      // Get vault and monetary policy addresses from controller
      const [vaultAddr, policyAddr, totalDebt] = await Promise.all([
        pc.readContract({ address: controllerAddress, abi: rateAbi, functionName: "factory" }),
        pc.readContract({ address: controllerAddress, abi: rateAbi, functionName: "monetary_policy" }),
        pc.readContract({ address: controllerAddress, abi: rateAbi, functionName: "total_debt" }),
      ]);
      // Read min/max rates from monetary policy and totalAssets from vault
      const [minRateRaw, maxRateRaw, totalAssets] = await Promise.all([
        pc.readContract({ address: policyAddr, abi: rateAbi, functionName: "min_rate" }),
        pc.readContract({ address: policyAddr, abi: rateAbi, functionName: "max_rate" }),
        pc.readContract({ address: vaultAddr, abi: rateAbi, functionName: "totalAssets" }),
      ]);
      const minRate = Number(minRateRaw) * SECONDS_PER_YEAR / 1e18 * 100;
      const maxRate = Number(maxRateRaw) * SECONDS_PER_YEAR / 1e18 * 100;
      const utilization = totalAssets > 0n ? Number(totalDebt) / Number(totalAssets) : 0;
      return { minRate, maxRate, totalDebt, totalAssets, utilization };
    },
    enabled: !!publicClient,
    ...CACHE_TIMES.SEMI_REALTIME,
  });

  const currentBorrowAPR = useMemo(() => {
    if (!marketRates) return null;
    return semilogBorrowAPR(marketRates.utilization, marketRates.minRate, marketRates.maxRate);
  }, [marketRates]);

  // Collateral APR from Yearn vault data
  const { data: yearnRaw } = useYearnVault(vault.address);
  const collateralAPR = useMemo(() => {
    const formatted = formatYearnVaultData(yearnRaw?.vault);
    return formatted?.grossApr ?? null;
  }, [yearnRaw]);

  // Active tab with localStorage persistence
  const [activeTab, setActiveTabState] = useState<Tab>(() => {
    if (typeof window === "undefined") return "borrow";
    try {
      const saved = localStorage.getItem("yldfi-lending-tab");
      if (saved === "collateral" || saved === "borrow" || saved === "repay" || saved === "leverage") return saved;
    } catch {
      // localStorage unavailable
    }
    return "borrow";
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

  // Child tab estimated debt delta (positive = borrowing more, negative = repaying)
  const [childDebtDelta, setChildDebtDelta] = useState<bigint | null>(null);
  const handleDebtDeltaChange = useCallback((delta: bigint | null) => {
    setChildDebtDelta(delta);
  }, []);

  // Transaction state from child tabs (for full-screen overlays)
  const [activeTxState, setActiveTxState] = useState<LendingTxState>(null);
  const handleTxStateChange = useCallback((state: LendingTxState) => {
    setActiveTxState(state);
    if (state?.status === "success") {
      setTimeout(() => setActiveTxState(null), 2000);
    }
    if (state?.status === "reverted") {
      setTimeout(() => setActiveTxState(null), 3000);
    }
  }, []);

  // Debug tx state (dev only)
  type DebugLendingTxState = "none" | "borrow-pending" | "borrow-success" | "borrow-reverted" | "repay-pending" | "repay-success" | "repay-reverted" | "collateral-pending" | "collateral-success" | "collateral-reverted" | "leverage-pending" | "leverage-success" | "leverage-reverted" | "newloan-pending" | "newloan-success" | "newloan-reverted";
  const [debugTxState, setDebugTxState] = useState<DebugLendingTxState>("none");
  const debugHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const debugLendingTxState: LendingTxState = useMemo(() => {
    if (debugTxState === "none") return null;
    const [action, status] = debugTxState.split("-") as [string, string];
    const actionMap: Record<string, string> = {
      borrow: "Borrow", repay: "Repay", collateral: "Add Collateral",
      leverage: "Leverage Up", newloan: "Create Loan",
    };
    return {
      status: status as "pending" | "success" | "reverted",
      action: actionMap[action],
      hash: debugHash,
      details: {
        fromAmount: action === "borrow" ? "1,250.00" : action === "repay" ? "500.00" : "10.5",
        fromSymbol: action === "borrow" ? "crvUSD" : action === "repay" ? "crvUSD" : vault.symbol,
        fromLogo: action === "borrow" || action === "repay" ? "/tokens/crvusd.png" : vault.logo,
        toAmount: action === "borrow" ? "10.5" : action === "repay" ? "500.00" : "1,250.00",
        toSymbol: action === "borrow" ? vault.symbol : action === "repay" ? "crvUSD debt" : "crvUSD",
        toLogo: action === "borrow" ? vault.logo : "/tokens/crvusd.png",
      },
    };
  }, [debugTxState, vault]);
  const effectiveTxState = debugLendingTxState || activeTxState;

  // DEBUG: Draggable panel position (persisted to localStorage)
  const [debugPanelPos, setDebugPanelPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const saved = localStorage.getItem("yldfi-lending-debug-panel-pos");
      if (saved) return JSON.parse(saved);
    } catch { /* localStorage unavailable */ }
    return null;
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const panel = (e.target as HTMLElement).closest("[data-debug-panel]") as HTMLElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setIsDragging(true);
  }, []);

  const handleDrag = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    setDebugPanelPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y });
  }, [isDragging]);

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);
    if (debugPanelPos) {
      try { localStorage.setItem("yldfi-lending-debug-panel-pos", JSON.stringify(debugPanelPos)); } catch { /* */ }
    }
  }, [isDragging, debugPanelPos]);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleDrag);
      window.addEventListener("mouseup", handleDragEnd);
      return () => {
        window.removeEventListener("mousemove", handleDrag);
        window.removeEventListener("mouseup", handleDragEnd);
      };
    }
  }, [isDragging, handleDrag, handleDragEnd]);

  // Projected borrow APR based on child tab's debt delta
  const projectedBorrowAPR = useMemo(() => {
    if (!marketRates || childDebtDelta === null || childDebtDelta === 0n) return null;
    const newDebt = marketRates.totalDebt + childDebtDelta;
    if (newDebt < 0n) return null;
    const newUtil = marketRates.totalAssets > 0n ? Number(newDebt) / Number(marketRates.totalAssets) : 0;
    return semilogBorrowAPR(newUtil, marketRates.minRate, marketRates.maxRate);
  }, [marketRates, childDebtDelta]);

  // Clear child estimates when switching tabs
  useEffect(() => {
    setChildEstimatedHealth(null);
    setChildEstimatedLeverage(null);
    setChildDebtDelta(null);
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

  // Estimated debt after pending operation
  const estimatedDebt = useMemo(() => {
    if (!position?.hasLoan || childDebtDelta === null || childDebtDelta === 0n) return null;
    const newDebt = position.debt + childDebtDelta;
    if (newDebt < 0n) return "0";
    return Number(formatUnits(newDebt, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }, [position, childDebtDelta]);

  const effectiveLeverage = useMemo(() => {
    if (!position?.hasLoan || position.collateral === 0n || oraclePrice === 0n) return null;
    // collateralValue in crvUSD = collateral * oraclePrice / 10^decimals
    const collValue = Number(formatUnits(position.collateral * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
    const debt = Number(formatUnits(position.debt, 18));
    if (collValue <= 0 || collValue <= debt) return null;
    return (collValue / (collValue - debt)).toFixed(2);
  }, [position, vault.decimals, oraclePrice]);

  // Net APR on equity: leverage * collateralAPR - (leverage - 1) * borrowAPR
  const currentNetAPR = useMemo(() => {
    if (collateralAPR == null || currentBorrowAPR == null || !effectiveLeverage) return null;
    const lev = parseFloat(effectiveLeverage);
    return lev * collateralAPR - (lev - 1) * currentBorrowAPR;
  }, [collateralAPR, currentBorrowAPR, effectiveLeverage]);

  const projectedNetAPR = useMemo(() => {
    if (collateralAPR == null) return null;
    const projBorrow = projectedBorrowAPR ?? currentBorrowAPR;
    if (projBorrow == null) return null;
    const projLev = childEstimatedLeverage ?? (effectiveLeverage ? parseFloat(effectiveLeverage) : null);
    if (projLev == null) return null;
    // Only show projected if something actually changed
    if (projectedBorrowAPR === null && childEstimatedLeverage === null) return null;
    return projLev * collateralAPR - (projLev - 1) * projBorrow;
  }, [collateralAPR, currentBorrowAPR, projectedBorrowAPR, effectiveLeverage, childEstimatedLeverage]);

  // Any projected value differs from current — drives synced pulse animation
  const isEstimating =
    (projectedBorrowAPR !== null && currentBorrowAPR !== null && projectedBorrowAPR.toFixed(2) !== currentBorrowAPR.toFixed(2)) ||
    (childEstimatedLeverage !== null && effectiveLeverage !== null && childEstimatedLeverage.toFixed(2) !== effectiveLeverage) ||
    (projectedNetAPR !== null && currentNetAPR !== null && projectedNetAPR.toFixed(2) !== currentNetAPR.toFixed(2));

  const hasLoan = position?.hasLoan ?? false;

  // New loan source choice (Curve vs yld)
  const [loanSource, setLoanSourceState] = useState<"choice" | "yldfi">(() => {
    if (typeof window === "undefined") return "choice";
    try {
      const saved = localStorage.getItem("yldfi-loan-source");
      if (saved === "yldfi") return saved;
    } catch { /* localStorage unavailable */ }
    return "choice";
  });
  const setLoanSource = useCallback((v: "choice" | "yldfi") => {
    setLoanSourceState(v);
    try { localStorage.setItem("yldfi-loan-source", v); } catch { /* */ }
  }, []);

  // --- Loading: show skeleton while position data loads ---
  if (positionLoading) {
    return (
      <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl overflow-hidden p-4">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 text-[var(--muted-foreground)] animate-spin" />
        </div>
      </div>
    );
  }

  // --- Tx State Overlay (shared between has-loan and no-loan views) ---
  const txStateOverlay = effectiveTxState && (
    <div className="p-4">
      {effectiveTxState.status === "pending" && (
        <div className="flex flex-col items-center justify-center py-12 text-center animate-in fade-in duration-300">
          <div className="w-16 h-16 rounded-full bg-[var(--muted)] flex items-center justify-center mb-4">
            <Loader2 className="w-8 h-8 text-[var(--accent)] animate-spin" />
          </div>
          <h3 className="text-lg font-medium mb-2">Awaiting Confirmation</h3>
          {effectiveTxState.details && (() => {
            const d = effectiveTxState.details!;
            const isSameToken = d.fromSymbol === d.toSymbol && d.fromLogo === d.toLogo;
            return isSameToken ? (
              <div className="flex items-center gap-2 mb-3 px-4 py-2 bg-[var(--muted)] rounded-lg">
                <img src={d.fromLogo} alt={d.fromSymbol} className="w-5 h-5 rounded-full" />
                <span className="mono text-sm">{d.fromAmount} {d.fromSymbol}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 mb-3 px-4 py-2 bg-[var(--muted)] rounded-lg">
                <img src={d.fromLogo} alt={d.fromSymbol} className="w-5 h-5 rounded-full" />
                <span className="mono text-sm">{d.fromAmount} {d.fromSymbol}</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--muted-foreground)]">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
                <img src={d.toLogo} alt={d.toSymbol} className="w-5 h-5 rounded-full" />
                <span className="mono text-sm">{d.toAmount} {d.toSymbol}</span>
              </div>
            );
          })()}
          <p className="text-sm text-[var(--muted-foreground)] max-w-xs mb-4">
            Your {effectiveTxState.action.toLowerCase()} transaction is being confirmed on-chain.
          </p>
          <a
            href={`https://etherscan.io/tx/${effectiveTxState.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--foreground)] hover:text-[var(--accent)] transition-colors mono"
          >
            View on Etherscan
            <ExternalLink size={14} />
          </a>
        </div>
      )}
      {effectiveTxState.status === "success" && (
        <div className="flex flex-col items-center justify-center py-16 text-center animate-in fade-in zoom-in-95 duration-300">
          <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mb-4">
            <Check className="w-8 h-8 text-green-500" />
          </div>
          <h3 className="text-lg font-medium mb-2 text-green-500">
            {effectiveTxState.action} Successful
          </h3>
          <p className="text-sm text-[var(--muted-foreground)] max-w-xs mb-4">
            Your transaction has been confirmed.
          </p>
          <a
            href={`https://etherscan.io/tx/${effectiveTxState.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--foreground)] hover:text-[var(--accent)] transition-colors mono"
          >
            View on Etherscan
            <ExternalLink size={14} />
          </a>
        </div>
      )}
      {effectiveTxState.status === "reverted" && (
        <div className="flex flex-col items-center justify-center py-16 text-center animate-in fade-in zoom-in-95 duration-300">
          <div className="w-16 h-16 rounded-full bg-[var(--destructive)]/20 flex items-center justify-center mb-4">
            <X className="w-8 h-8 text-[var(--destructive)]" />
          </div>
          <h3 className="text-lg font-medium mb-2 text-[var(--destructive)]">
            {effectiveTxState.action} Failed
          </h3>
          <p className="text-sm text-[var(--muted-foreground)] max-w-xs mb-4">
            Transaction reverted on-chain.
          </p>
          <a
            href={`https://etherscan.io/tx/${effectiveTxState.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--foreground)] hover:text-[var(--accent)] transition-colors mono"
          >
            View on Etherscan
            <ExternalLink size={14} />
          </a>
        </div>
      )}
    </div>
  );

  // Debug panel rows config
  const debugRows: { label: string; prefix: string }[] = [
    { label: "Borrow", prefix: "borrow" },
    { label: "Repay", prefix: "repay" },
    { label: "Collateral", prefix: "collateral" },
    { label: "Leverage", prefix: "leverage" },
    { label: "New Loan", prefix: "newloan" },
  ];

  // --- No Loan View: Choice screen or NewLoanForm ---
  if (!hasLoan) {
    // Choice screen: Curve Finance vs yld
    if (loanSource === "choice") {
      return (
        <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl p-6 space-y-4">
          <h3 className="text-lg font-medium text-center">Create New Loan</h3>
          <p className="text-sm text-[var(--muted-foreground)] text-center">
            Choose where to open your position
          </p>
          <div className="space-y-3">
            {/* Curve Finance — external link */}
            <button
              onClick={() =>
                window.open(
                  `https://lend.curve.fi/ethereum/markets/${controllerAddress}/create`,
                  "_blank"
                )
              }
              className="w-full p-4 rounded-lg border border-[var(--border)] hover:border-[var(--accent)] transition-colors text-left flex items-center gap-4 group"
            >
              <Image src="/curve-logo.png" alt="Curve" width={32} height={32} className="rounded-full shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">Curve Finance</div>
                <div className="text-xs text-[var(--muted-foreground)]">
                  Open a standard loan on Curve&apos;s native lending interface
                </div>
              </div>
              <ExternalLink size={16} className="text-[var(--muted-foreground)] group-hover:text-[var(--accent)] transition-colors shrink-0" />
            </button>
            {/* yld — shows NewLoanForm */}
            <button
              onClick={() => setLoanSource("yldfi")}
              className="w-full p-4 rounded-lg border border-[var(--border)] hover:border-[var(--accent)] transition-colors text-left flex items-center gap-4 group"
            >
              <Image src="/logo.svg" alt="yld" width={32} height={32} className="rounded-full shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">yld</div>
                <div className="text-xs text-[var(--muted-foreground)]">
                  Deposit and borrow any token using Enso swaps. Optional leverage.
                </div>
              </div>
              <ArrowRight size={16} className="text-[var(--muted-foreground)] group-hover:text-[var(--accent)] transition-colors shrink-0" />
            </button>
          </div>
        </div>
      );
    }

    // yld NewLoanForm view with back button
    return (
      <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl">
        {/* Health Bar */}
        <div className="overflow-hidden rounded-t-xl">
          <HealthBar
            currentHealth={undefined}
            estimatedHealth={effectiveEstimatedHealth}
            alwaysShow
            title="New Position"
            titlePrefix={
              <button
                onClick={() => setLoanSource("choice")}
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors p-0.5 -ml-1"
                title="Back to options"
              >
                <ChevronLeft size={16} />
              </button>
            }
          />
        </div>

        <div className={effectiveTxState ? "hidden" : "p-4 space-y-4"}>
          <NewLoanForm
            vault={vault}
            userBalance={userBalance}
            controllerAddress={controllerAddress}
            onTransactionSuccess={onTransactionSuccess}
            onEstimatedHealthChange={handleEstimatedHealthChange}
            onTxStateChange={handleTxStateChange}
          />
        </div>

        {txStateOverlay}

        {/* DEBUG: Lending Tx State Preview Panel */}
        {process.env.NODE_ENV === "development" && (
          <div
            data-debug-panel
            className={cn(
              "fixed z-[9999] border border-[var(--border)] rounded-lg p-3 shadow-2xl max-w-xs pointer-events-auto",
              isDragging && "cursor-grabbing"
            )}
            style={{
              background: "#09090b",
              ...(debugPanelPos ? {
                left: debugPanelPos.x,
                top: debugPanelPos.y,
                bottom: "auto",
                right: "auto",
              } : {
                bottom: 16,
                right: 16,
              }),
            }}
          >
            <div
              className="text-xs text-[var(--muted-foreground)] mb-2 font-medium cursor-grab select-none"
              onMouseDown={handleDragStart}
            >
              ⋮⋮ Lending TX Preview
            </div>
            <div className="space-y-2">
              <button
                onClick={() => setDebugTxState("none")}
                className={cn(
                  "w-full px-2 py-1 text-xs rounded transition-colors",
                  debugTxState === "none"
                    ? "bg-[var(--foreground)] text-[var(--background)]"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Reset All
              </button>
              {debugRows.map(({ label, prefix }) => (
                <div key={prefix} className="flex gap-1">
                  <span className="text-[10px] text-[var(--muted-foreground)] w-16 flex items-center">{label}</span>
                  <button
                    onClick={() => setDebugTxState(`${prefix}-pending` as DebugLendingTxState)}
                    className={cn(
                      "flex-1 px-2 py-1 text-xs rounded transition-colors",
                      debugTxState === `${prefix}-pending`
                        ? "bg-[var(--accent)] text-[var(--background)]"
                        : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    )}
                  >
                    Pending
                  </button>
                  <button
                    onClick={() => setDebugTxState(`${prefix}-success` as DebugLendingTxState)}
                    className={cn(
                      "flex-1 px-2 py-1 text-xs rounded transition-colors",
                      debugTxState === `${prefix}-success`
                        ? "bg-green-500 text-white"
                        : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    )}
                  >
                    Success
                  </button>
                  <button
                    onClick={() => setDebugTxState(`${prefix}-reverted` as DebugLendingTxState)}
                    className={cn(
                      "flex-1 px-2 py-1 text-xs rounded transition-colors",
                      debugTxState === `${prefix}-reverted`
                        ? "bg-red-500 text-white"
                        : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    )}
                  >
                    Reverted
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // --- Has Loan View: Position summary + Health bar + Management tabs ---
  return (
    <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl">
      {/* Health Bar — always visible */}
      <div className="overflow-hidden rounded-t-xl">
        <HealthBar
          currentHealth={position?.healthFull}
          estimatedHealth={effectiveEstimatedHealth}
        />
      </div>

      {/* Position Summary — hidden during tx states */}
      {!effectiveTxState && (
        <div className={cn(
          "grid gap-x-3 gap-y-0.5 px-4 pt-3 pb-2",
          effectiveLeverage ? "grid-cols-3" : "grid-cols-2",
          isEstimating && "estimating"
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
          <div>
            <div className="flex items-center gap-1.5">
              {vault.logo && (
                <Image src={vault.logo} alt="" width={14} height={14} className="rounded-full" />
              )}
              <span className="mono text-sm font-medium truncate">{positionCollateral}</span>
            </div>
            {collateralAPR != null && collateralAPR > 0 && (
              <div className="text-[10px] text-green-500 mt-0.5">
                +{collateralAPR.toFixed(2)}% APR
              </div>
            )}
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <Image src="/tokens/crvusd.png" alt="" width={14} height={14} className="rounded-full" />
              <span
                className="mono text-sm font-medium truncate"
                style={{ opacity: estimatedDebt !== null && estimatedDebt !== positionDebt ? "var(--estimate-pulse)" : undefined }}
              >
                {estimatedDebt ?? positionDebt}
              </span>
            </div>
            {currentBorrowAPR != null && (
              <div
                className="text-[10px] text-red-500 mt-0.5"
                style={{ opacity: projectedBorrowAPR !== null && projectedBorrowAPR.toFixed(2) !== currentBorrowAPR.toFixed(2) ? "var(--estimate-pulse)" : undefined }}
              >
                -{(projectedBorrowAPR ?? currentBorrowAPR).toFixed(2)}% APR
              </div>
            )}
          </div>
          {effectiveLeverage && (
            <div className="text-right">
              <div
                className="mono text-sm font-medium"
                style={{ opacity: childEstimatedLeverage !== null && childEstimatedLeverage.toFixed(2) !== effectiveLeverage ? "var(--estimate-pulse)" : undefined }}
              >
                {childEstimatedLeverage !== null ? childEstimatedLeverage.toFixed(2) : effectiveLeverage}x
              </div>
              {currentNetAPR != null && (
                <div
                  className={cn(
                    "text-[10px] mt-0.5",
                    (projectedNetAPR ?? currentNetAPR) >= 0 ? "text-green-500" : "text-red-500"
                  )}
                  style={{ opacity: projectedNetAPR !== null && projectedNetAPR.toFixed(2) !== currentNetAPR.toFixed(2) ? "var(--estimate-pulse)" : undefined }}
                >
                  {(projectedNetAPR ?? currentNetAPR) >= 0 ? "+" : ""}{(projectedNetAPR ?? currentNetAPR).toFixed(2)}% NET
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tabs — hidden during tx states */}
      {!effectiveTxState && (
        <div className="p-4 pb-0">
          <div className="flex border-b border-[var(--border)]">
            {(["borrow", "leverage", "repay", "collateral"] as const).map((tab) => (
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
      )}

      {/* Form Content — hidden during tx states */}
      {!effectiveTxState && (
        <div className="p-4 space-y-4">
          {activeTab === "collateral" && (
            <CollateralTab
              vault={vault}
              userBalance={userBalance}
              position={position}
              controllerAddress={controllerAddress}
              onTransactionSuccess={onTransactionSuccess}
              onEstimatedHealthChange={handleEstimatedHealthChange}
              onTxStateChange={handleTxStateChange}
            />
          )}
          {activeTab === "borrow" && (
            <BorrowTab
              vault={vault}
              position={position}
              controllerAddress={controllerAddress}
              onTransactionSuccess={onTransactionSuccess}
              onEstimatedHealthChange={handleEstimatedHealthChange}
              onDebtDeltaChange={handleDebtDeltaChange}
              onTxStateChange={handleTxStateChange}
            />
          )}
          {activeTab === "repay" && (
            <RepayTab
              vault={vault}
              position={position}
              controllerAddress={controllerAddress}
              onTransactionSuccess={onTransactionSuccess}
              onEstimatedHealthChange={handleEstimatedHealthChange}
              onDebtDeltaChange={handleDebtDeltaChange}
              onTxStateChange={handleTxStateChange}
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
              onDebtDeltaChange={handleDebtDeltaChange}
              onTxStateChange={handleTxStateChange}
            />
          )}
        </div>
      )}

      {/* Tx state overlay */}
      {txStateOverlay}

      {/* DEBUG: Lending Tx State Preview Panel */}
      {process.env.NODE_ENV === "development" && (
        <div
          data-debug-panel
          className={cn(
            "fixed z-[9999] border border-[var(--border)] rounded-lg p-3 shadow-2xl max-w-xs pointer-events-auto",
            isDragging && "cursor-grabbing"
          )}
          style={{
            background: "#09090b",
            ...(debugPanelPos ? {
              left: debugPanelPos.x,
              top: debugPanelPos.y,
              bottom: "auto",
              right: "auto",
            } : {
              bottom: 16,
              right: 16,
            }),
          }}
        >
          <div
            className="text-xs text-[var(--muted-foreground)] mb-2 font-medium cursor-grab select-none"
            onMouseDown={handleDragStart}
          >
            ⋮⋮ Lending TX Preview
          </div>
          <div className="space-y-2">
            <button
              onClick={() => setDebugTxState("none")}
              className={cn(
                "w-full px-2 py-1 text-xs rounded transition-colors",
                debugTxState === "none"
                  ? "bg-[var(--foreground)] text-[var(--background)]"
                  : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              )}
            >
              Reset All
            </button>
            {debugRows.map(({ label, prefix }) => (
              <div key={prefix} className="flex gap-1">
                <span className="text-[10px] text-[var(--muted-foreground)] w-16 flex items-center">{label}</span>
                <button
                  onClick={() => setDebugTxState(`${prefix}-pending` as DebugLendingTxState)}
                  className={cn(
                    "flex-1 px-2 py-1 text-xs rounded transition-colors",
                    debugTxState === `${prefix}-pending`
                      ? "bg-[var(--accent)] text-[var(--background)]"
                      : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  )}
                >
                  Pending
                </button>
                <button
                  onClick={() => setDebugTxState(`${prefix}-success` as DebugLendingTxState)}
                  className={cn(
                    "flex-1 px-2 py-1 text-xs rounded transition-colors",
                    debugTxState === `${prefix}-success`
                      ? "bg-green-500 text-white"
                      : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  )}
                >
                  Success
                </button>
                <button
                  onClick={() => setDebugTxState(`${prefix}-reverted` as DebugLendingTxState)}
                  className={cn(
                    "flex-1 px-2 py-1 text-xs rounded transition-colors",
                    debugTxState === `${prefix}-reverted`
                      ? "bg-red-500 text-white"
                      : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  )}
                >
                  Reverted
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
