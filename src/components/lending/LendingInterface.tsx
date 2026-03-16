"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
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
import { Check, X, ExternalLink, ArrowRight, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { CACHE_TIMES } from "@/config/query";
import { useYearnVault, formatYearnVaultData } from "@/hooks/useYearnVault";
import { LoadingDots } from "@/components/LoadingDots";
import { useSettings } from "@/hooks/useSettings";
import { trackLendingTabSwitch } from "@/lib/analytics";

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
    message?: string;
  };
} | null;

interface LendingPanelProps {
  vault: VaultConfig;
  userBalance: string; // Vault token balance in wei
  position: LendingPosition | null;
  positionLoading?: boolean;
  controllerAddress: `0x${string}`;
  onTransactionSuccess: () => void;
  onPreviewLiqPrices?: (upper: number | null, lower: number | null) => void;
  rewardApr?: number;
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

// LTV indicator with soft/hard liquidation thresholds
// Shows LTV value and soft/hard liquidation thresholds, all in muted grey
function LtvIndicator({ ltv }: { ltv: number; thresholds?: { soft: number; hard: number } | null; hideThresholds?: boolean }) {
  return (
    <div className="text-[9px] text-[var(--muted-foreground)] mt-0.5 whitespace-nowrap flex items-center justify-end gap-0.5">
      <span>{Number.isInteger(ltv) ? ltv.toFixed(0) : ltv.toFixed(1)}% LTV</span>
    </div>
  );
}

// Health bar: visual bar at top of panel, red→green
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
        {/* Ghost bar: shows current health at reduced opacity, same color as estimate */}
        {hasEstimate && currentPercent !== percent && (
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out"
            style={{
              width: `${currentPercent}%`,
              backgroundColor: color,
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
          style={{ color }}
        >
          {displayHealth > 999
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
  onPreviewLiqPrices,
  rewardApr,
}: LendingPanelProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { zappersEnabled } = useSettings();

  // Oracle price for accurate leverage display
  const [oraclePrice, setOraclePrice] = useState<bigint>(0n);
  const [ammAddress, setAmmAddress] = useState<`0x${string}` | null>(null);
  useEffect(() => {
    async function readOraclePrice() {
      if (!publicClient) return;
      try {
        const amm = await publicClient.readContract({
          address: controllerAddress,
          abi: [{ name: "amm", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const,
          functionName: "amm",
        });
        setAmmAddress(amm as `0x${string}`);
        const price = await publicClient.readContract({
          address: amm as `0x${string}`,
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

  // Liquidation LTV thresholds and AMM params from controller
  const [ltvThresholds, setLtvThresholds] = useState<{ soft: number; hard: number } | null>(null);
  const [ammParams, setAmmParams] = useState<{ A: number; loanDiscount: number } | null>(null);
  useEffect(() => {
    async function readDiscounts() {
      if (!publicClient) return;
      const discountAbi = [
        { name: "loan_discount", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
        { name: "liquidation_discount", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
        { name: "amm", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
      ] as const;
      try {
        const [loanDiscount, liqDiscount, ammAddr] = await Promise.all([
          publicClient.readContract({ address: controllerAddress, abi: discountAbi, functionName: "loan_discount" }),
          publicClient.readContract({ address: controllerAddress, abi: discountAbi, functionName: "liquidation_discount" }),
          publicClient.readContract({ address: controllerAddress, abi: discountAbi, functionName: "amm" }),
        ]);
        setLtvThresholds({
          soft: Math.round((1 - Number(loanDiscount) / 1e18) * 10000) / 100,
          hard: Math.round((1 - Number(liqDiscount) / 1e18) * 10000) / 100,
        });
        const A = await publicClient.readContract({
          address: ammAddr as `0x${string}`,
          abi: [{ name: "A", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }] as const,
          functionName: "A",
        });
        setAmmParams({ A: Number(A), loanDiscount: Number(loanDiscount) / 1e18 });
      } catch {
        setLtvThresholds(null);
      }
    }
    readDiscounts();
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

  const currentBorrowAPY = useMemo(() => {
    if (currentBorrowAPR == null) return null;
    return (Math.exp(currentBorrowAPR / 100) - 1) * 100;
  }, [currentBorrowAPR]);

  // Collateral APY from Yearn vault data
  const { data: yearnRaw } = useYearnVault(vault.address);
  const collateralAPY = useMemo(() => {
    const formatted = formatYearnVaultData(yearnRaw?.vault);
    return formatted?.weeklyApy ?? null;
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
    trackLendingTabSwitch(tab);
    try {
      localStorage.setItem("yldfi-lending-tab", tab);
    } catch {
      // localStorage unavailable
    }
  };

  // Child tab estimated health (all tabs now report via callback)
  // Debounce null (reset) values so health bar doesn't jump during animations
  const [childEstimatedHealth, setChildEstimatedHealth] = useState<number | null>(null);
  const handleEstimatedHealthChange = useCallback((health: number | null) => {
    setChildEstimatedHealth(health);
  }, []);

  // Child tab settling state (for health bar animation)
  const [childSettling, setChildSettling] = useState(false);
  const handleSettlingChange = useCallback((settling: boolean) => {
    setChildSettling(settling);
  }, []);

  // Child tab estimated leverage
  const [childEstimatedLeverage, setChildEstimatedLeverage] = useState<number | null>(null);
  const handleEstimatedLeverageChange = useCallback((lev: number | null) => {
    setChildEstimatedLeverage(lev);
  }, []);

  // Child tab bands (from NewLoanForm)
  const [childBands, setChildBands] = useState(10);
  const handleBandsChange = useCallback((b: number) => { setChildBands(b); }, []);

  // Child tab estimated debt delta (positive = borrowing more, negative = repaying)
  const [childDebtDelta, setChildDebtDelta] = useState<bigint | null>(null);
  const handleDebtDeltaChange = useCallback((delta: bigint | null) => {
    setChildDebtDelta(delta);
  }, []);

  // Child tab collateral amount (new loan form)
  const [childCollateralAmount, setChildCollateralAmount] = useState<bigint | null>(null);
  const handleCollateralAmountChange = useCallback((amount: bigint | null) => {
    setChildCollateralAmount(amount);
  }, []);

  // Fade in/out for position summary
  const [positionVisible, setPositionVisible] = useState(false);
  const [positionOpaque, setPositionOpaque] = useState(false);
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCollateralAmount = useRef<bigint>(0n);
  const lastDebtDelta = useRef<bigint>(0n);
  const lastLeverage = useRef<number>(1);
  const lastHealth = useRef<number | null>(null);
  if (childCollateralAmount !== null && childCollateralAmount > 0n) {
    lastCollateralAmount.current = childCollateralAmount;
  }
  if (childDebtDelta !== null && childDebtDelta > 0n) {
    lastDebtDelta.current = childDebtDelta;
  }
  if (childEstimatedLeverage !== null) {
    lastLeverage.current = childEstimatedLeverage;
  }
  if (childEstimatedHealth !== null) {
    lastHealth.current = childEstimatedHealth;
  }
  const displayCollateralAmount = childCollateralAmount ?? lastCollateralAmount.current;
  const displayDebtDelta = childDebtDelta ?? lastDebtDelta.current;
  const displayLeverage = childEstimatedLeverage ?? lastLeverage.current;
  const newPositionHealth = childEstimatedHealth ?? lastHealth.current;
  const hasCollateral = childCollateralAmount !== null && childCollateralAmount > 0n;
  useEffect(() => {
    if (positionTimer.current) { clearTimeout(positionTimer.current); positionTimer.current = null; }
    if (hasCollateral) {
      // Fade in: mount at opacity-0, then flip to opacity-1 next frame
      setPositionVisible(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setPositionOpaque(true)));
    } else if (positionVisible) {
      // Fade out: set opacity-0, then unmount after transition
      setPositionOpaque(false);
      positionTimer.current = setTimeout(() => {
        setPositionVisible(false);
        positionTimer.current = null;
      }, 300);
    }
  }, [hasCollateral]); // eslint-disable-line react-hooks/exhaustive-deps

  // Child tab collateral delta (existing position: positive = add, negative = remove)
  const [childCollateralDelta, setChildCollateralDelta] = useState<bigint | null>(null);
  const handleCollateralDeltaChange = useCallback((delta: bigint | null) => {
    setChildCollateralDelta(delta);
  }, []);

  // Transaction state from child tabs (for full-screen overlays)
  const [activeTxState, setActiveTxState] = useState<LendingTxState>(null);
  const handleTxStateChange = useCallback((state: LendingTxState) => {
    setActiveTxState(state);
    if (state?.status === "success") {
      // After loan creation, switch to "borrow" tab once position refetches
      if (state.action === "Create Loan") {
        setActiveTabState("borrow");
        try { localStorage.setItem("yldfi-lending-tab", "borrow"); } catch {}
      }
      setTimeout(() => setActiveTxState(null), 2000);
    }
    if (state?.status === "reverted") {
      setTimeout(() => setActiveTxState(null), 3000);
    }
  }, []);

  // Debug tx state (dev only)
  type DebugLendingTxState = "none" | "borrow-pending" | "borrow-success" | "borrow-reverted" | "repay-pending" | "repay-success" | "repay-reverted" | "collateral-pending" | "collateral-success" | "collateral-reverted" | "leverage-pending" | "leverage-success" | "leverage-reverted" | "newloan-pending" | "newloan-success" | "newloan-reverted";
  const [debugTxState, setDebugTxState] = useState<DebugLendingTxState>("none");
  const [debugMinimized, setDebugMinimized] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("yldfi-tx-preview-minimized") === "true"; } catch { return false; }
  });
  const toggleDebugMinimized = useCallback(() => {
    setDebugMinimized(prev => {
      const next = !prev;
      try { localStorage.setItem("yldfi-tx-preview-minimized", String(next)); } catch {}
      return next;
    });
  }, []);
  const [debugSoftLiq, setDebugSoftLiq] = useState(false);
  type DebugApprovalScenario = "none" | "ctrl-1of1" | "erc20-1of2" | "ctrl-2of2" | "approving";
  const [debugApproval, setDebugApproval] = useState<DebugApprovalScenario>("none");
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
        toSymbol: action === "borrow" ? vault.symbol : "crvUSD",
        toLogo: action === "borrow" ? vault.logo : "/tokens/crvusd.png",
      },
    };
  }, [debugTxState, vault]);
  const effectiveTxState = debugLendingTxState || activeTxState;

  // Debug approval scenarios
  const debugApprovalData = useMemo(() => {
    if (debugApproval === "none") return null;
    const mockAmount = 10n ** BigInt(vault.decimals) * 100n;
    const scenarios: Record<Exclude<DebugApprovalScenario, "none">, {
      type: "erc20" | "controller";
      tokenSymbol: string;
      amount?: bigint;
      progress: { step: number; total: number; steps: { label: string; description: string; done: boolean }[] };
      isApproving: boolean;
    }> = {
      "ctrl-1of1": {
        type: "controller", tokenSymbol: "Controller",
        progress: { step: 1, total: 1, steps: [
          { label: "yld Zapper", description: "Allow yld Zapper to manage position on LlamaLend controller", done: false },
        ]},
        isApproving: false,
      },
      "erc20-1of2": {
        type: "erc20", tokenSymbol: vault.symbol, amount: mockAmount,
        progress: { step: 1, total: 2, steps: [
          { label: vault.symbol, description: `Approve ${vault.symbol} for yld Zapper`, done: false },
          { label: "yld Zapper", description: "Allow yld Zapper to manage position on LlamaLend controller", done: false },
        ]},
        isApproving: false,
      },
      "ctrl-2of2": {
        type: "controller", tokenSymbol: "Controller",
        progress: { step: 2, total: 2, steps: [
          { label: vault.symbol, description: `Approve ${vault.symbol} for yld Zapper`, done: true },
          { label: "yld Zapper", description: "Allow yld Zapper to manage position on LlamaLend controller", done: false },
        ]},
        isApproving: false,
      },
      "approving": {
        type: "erc20", tokenSymbol: vault.symbol, amount: mockAmount,
        progress: { step: 1, total: 2, steps: [
          { label: vault.symbol, description: `Approve ${vault.symbol} for yld Zapper`, done: false },
          { label: "yld Zapper", description: "Allow yld Zapper to manage position on LlamaLend controller", done: false },
        ]},
        isApproving: true,
      },
    };
    return scenarios[debugApproval];
  }, [debugApproval, vault]);

  // Track which debug approval button was clicked (spinner only on that button)
  const [debugApprovingType, setDebugApprovingType] = useState<"exact" | "unlimited" | "single" | null>(null);
  useEffect(() => {
    if (!debugApprovalData?.isApproving) setDebugApprovingType(null);
  }, [debugApprovalData?.isApproving]);

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

  // Projected borrow APR/APY based on child tab's debt delta
  const projectedBorrowAPR = useMemo(() => {
    if (!marketRates || childDebtDelta === null || childDebtDelta === 0n) return null;
    const newDebt = marketRates.totalDebt + childDebtDelta;
    if (newDebt < 0n) return null;
    const newUtil = marketRates.totalAssets > 0n ? Number(newDebt) / Number(marketRates.totalAssets) : 0;
    return semilogBorrowAPR(newUtil, marketRates.minRate, marketRates.maxRate);
  }, [marketRates, childDebtDelta]);

  const projectedBorrowAPY = useMemo(() => {
    if (projectedBorrowAPR == null) return null;
    return (Math.exp(projectedBorrowAPR / 100) - 1) * 100;
  }, [projectedBorrowAPR]);


  // Compute preview liquidation prices from child tab deltas
  // Uses controller.calculate_debt_n1 to get band index, then AMM.p_oracle_up/down for price levels
  useEffect(() => {
    if (!onPreviewLiqPrices || !publicClient || !ammAddress) return;
    const notify = onPreviewLiqPrices;

    const CALC_ABI = [
      { name: "calculate_debt_n1", type: "function", stateMutability: "view",
        inputs: [{ name: "collateral", type: "uint256" }, { name: "debt", type: "uint256" }, { name: "N", type: "uint256" }],
        outputs: [{ name: "", type: "int256" }] },
    ] as const;
    const P_ABI = [
      { name: "p_oracle_up", type: "function", stateMutability: "view",
        inputs: [{ name: "n", type: "int256" }], outputs: [{ name: "", type: "uint256" }] },
      { name: "p_oracle_down", type: "function", stateMutability: "view",
        inputs: [{ name: "n", type: "int256" }], outputs: [{ name: "", type: "uint256" }] },
    ] as const;

    let cancelled = false;

    async function compute() {
      let totalCollateral: bigint;
      let totalDebt: bigint;
      let N: number;

      if (position?.hasLoan) {
        // Existing loan: apply deltas
        totalCollateral = position.collateral + (childCollateralDelta ?? 0n);
        totalDebt = position.debt + (childDebtDelta ?? 0n);
        N = position.N;

        // Only compute if there's an actual change
        if ((childDebtDelta === null || childDebtDelta === 0n) &&
            (childCollateralDelta === null || childCollateralDelta === 0n)) {
          if (!cancelled) notify(null, null);
          return;
        }
      } else {
        // New loan: use child amounts directly
        totalCollateral = childCollateralAmount ?? 0n;
        totalDebt = childDebtDelta ?? 0n;
        N = childBands;

        if (totalCollateral <= 0n || totalDebt <= 0n) {
          if (!cancelled) notify(null, null);
          return;
        }
      }

      if (totalCollateral <= 0n || totalDebt <= 0n) {
        if (!cancelled) notify(null, null);
        return;
      }

      try {
        const n1 = await publicClient!.readContract({
          address: controllerAddress,
          abi: CALC_ABI,
          functionName: "calculate_debt_n1",
          args: [totalCollateral, totalDebt, BigInt(N)],
        });

        const n2 = n1 + BigInt(N - 1);

        const [pUp, pDown] = await Promise.all([
          publicClient!.readContract({
            address: ammAddress!,
            abi: P_ABI,
            functionName: "p_oracle_up",
            args: [n1],
          }),
          publicClient!.readContract({
            address: ammAddress!,
            abi: P_ABI,
            functionName: "p_oracle_down",
            args: [n2],
          }),
        ]);

        if (!cancelled) {
          notify(
            Number(formatUnits(pUp, 18)),
            Number(formatUnits(pDown, 18)),
          );
        }
      } catch {
        if (!cancelled) notify(null, null);
      }
    }

    compute();
    return () => { cancelled = true; };
  }, [publicClient, controllerAddress, ammAddress, position, childDebtDelta, childCollateralDelta, childCollateralAmount, childBands, onPreviewLiqPrices]);

  // Clear child estimates when switching tabs
  useEffect(() => {
    setChildEstimatedHealth(null);
    setChildEstimatedLeverage(null);
    setChildDebtDelta(null);
    setChildCollateralDelta(null);
    setChildSettling(false);
  }, [activeTab]);

  const effectiveEstimatedHealth = childEstimatedHealth;

  // Position summary values
  const positionCollateral = useMemo(() => {
    if (!position?.hasLoan) return null;
    return Number(formatUnits(position.collateral, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 2 });
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

  // Estimated collateral after pending operation
  const estimatedCollateral = useMemo(() => {
    if (!position?.hasLoan || childCollateralDelta === null || childCollateralDelta === 0n) return null;
    const newColl = position.collateral + childCollateralDelta;
    if (newColl < 0n) return "0";
    return Number(formatUnits(newColl, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }, [position, childCollateralDelta, vault.decimals]);

  // Total collateral value in crvUSD: includes both vault token + stablecoin in AMM bands (soft-liquidation)
  const totalCollateralValue = useMemo(() => {
    if (!position?.hasLoan || oraclePrice === 0n) return 0;
    const vaultTokenValue = Number(formatUnits(position.collateral * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
    const stablecoinValue = Number(formatUnits(position.stablecoin, 18));
    return vaultTokenValue + stablecoinValue;
  }, [position, vault.decimals, oraclePrice]);

  const effectiveLeverage = useMemo(() => {
    if (!position?.hasLoan || totalCollateralValue <= 0) return null;
    const debt = Number(formatUnits(position.debt, 18));
    if (totalCollateralValue <= debt) return null;
    return (totalCollateralValue / (totalCollateralValue - debt)).toFixed(2);
  }, [position, totalCollateralValue]);

  // Max leverage for current bands setting based on A, loan_discount, and N
  const maxLeverage = useMemo(() => {
    if (!ammParams) return null;
    const { A, loanDiscount } = ammParams;
    const N = position?.hasLoan ? position.N : childBands;
    const ratio = (A - 1) / A;
    const sqrtBandRatio = Math.sqrt(A / (A - 1));
    let geoSum = 0;
    let term = 1;
    for (let i = 0; i < N; i++) {
      geoSum += term;
      term *= ratio;
    }
    const effectiveFactor = (1 - loanDiscount) * geoSum / (sqrtBandRatio * N);
    if (effectiveFactor >= 1) return null;
    return Math.round(1 / (1 - effectiveFactor) * 100) / 100;
  }, [ammParams, position, childBands]);

  // Net APY on equity: leverage * collateralAPY - (leverage - 1) * borrowAPY
  const currentNetAPY = useMemo(() => {
    if (collateralAPY == null || currentBorrowAPY == null || !effectiveLeverage) return null;
    const lev = parseFloat(effectiveLeverage);
    return lev * collateralAPY - (lev - 1) * currentBorrowAPY;
  }, [collateralAPY, currentBorrowAPY, effectiveLeverage]);

  const projectedNetAPY = useMemo(() => {
    if (collateralAPY == null) return null;
    const projBorrow = projectedBorrowAPY ?? currentBorrowAPY;
    if (projBorrow == null) return null;
    const projLev = childEstimatedLeverage ?? (effectiveLeverage ? parseFloat(effectiveLeverage) : null);
    if (projLev == null) return null;
    // Only show projected if something actually changed
    if (projectedBorrowAPY === null && childEstimatedLeverage === null) return null;
    return projLev * collateralAPY - (projLev - 1) * projBorrow;
  }, [collateralAPY, currentBorrowAPY, projectedBorrowAPY, effectiveLeverage, childEstimatedLeverage]);

  const hasLoan = position?.hasLoan ?? false;

  // Debug: override position with soft liquidation flag
  const effectivePosition = useMemo(() => {
    if (!debugSoftLiq || !position) return position;
    return { ...position, inSoftLiquidation: true };
  }, [position, debugSoftLiq]);

  // Reset off leverage tab when zappers are disabled (unless in soft-liq, where it becomes "liquidate")
  useEffect(() => {
    if (!zappersEnabled && activeTab === "leverage" && !effectivePosition?.inSoftLiquidation) {
      setActiveTab("borrow");
    }
  }, [zappersEnabled, activeTab, effectivePosition?.inSoftLiquidation]);

  // Reset to "borrow" tab when a loan is first created
  // Tracks hasLoan transitions: false→true triggers tab switch to "borrow"
  const prevHasLoan = useRef(hasLoan);
  useEffect(() => {
    if (hasLoan && !prevHasLoan.current) {
      setActiveTab("borrow");
    }
    // Safety net: if loan closed (true→false) while a pending overlay is showing,
    // the tab component unmounted before reporting success — auto-clear the overlay
    if (!hasLoan && prevHasLoan.current && activeTxState?.status === "pending") {
      setActiveTxState({ ...activeTxState, status: "success" });
      setTimeout(() => setActiveTxState(null), 2000);
    }
    prevHasLoan.current = hasLoan;
  }, [hasLoan, activeTxState]);

  // New loan source choice (Curve vs yld)
  const [loanSource, setLoanSourceState] = useState<"choice" | "yldfi">(() => {
    if (typeof window === "undefined") return "choice";
    try {
      const saved = sessionStorage.getItem("yldfi-loan-source");
      if (saved === "yldfi") return saved;
    } catch { /* sessionStorage unavailable */ }
    return "choice";
  });
  const setLoanSource = useCallback((v: "choice" | "yldfi") => {
    setLoanSourceState(v);
    try { sessionStorage.setItem("yldfi-loan-source", v); } catch { /* */ }
    // Reset child state when going back to choice screen
    if (v === "choice") {
      setChildCollateralAmount(null);
      setChildDebtDelta(null);
      setChildEstimatedLeverage(null);
      lastCollateralAmount.current = 0n;
      try {
        sessionStorage.removeItem(`yldfi-lending-newloan-amount-${vault.address}`);
        sessionStorage.removeItem(`yldfi-lending-newloan-debt-${vault.address}`);
        sessionStorage.removeItem(`yldfi-lending-newloan-token-${vault.address}`);
        sessionStorage.removeItem(`yldfi-lending-newloan-output-${vault.address}`);
      } catch { /* */ }
    }
  }, [vault.address]);

  // --- Loading: show skeleton while position data loads ---
  if (positionLoading) {
    return (
      <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl overflow-hidden p-4 flex-1 flex flex-col">
        <div className="flex items-center justify-center py-40 flex-1 text-sm text-[var(--muted-foreground)]">
          <LoadingDots />
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
            <LoadingDots />
          </div>
          <h3 className="text-lg font-medium mb-2">Awaiting Confirmation</h3>
          {effectiveTxState.details && (() => {
            const d = effectiveTxState.details!;
            if (d.message) {
              // Render message with inline token logos
              const isSameToken = d.fromSymbol === d.toSymbol;
              return (
                <div className="flex items-center flex-wrap justify-center gap-1 text-sm text-[var(--muted-foreground)] mb-3 px-4">
                  <span>Repaying</span>
                  <span className="mono">{d.toAmount}</span>
                  <img src={d.toLogo} alt={d.toSymbol} className="w-4 h-4 rounded-full" />
                  <span className="mono">{d.toSymbol}</span>
                  {!isSameToken && (
                    <>
                      <span>with</span>
                      <span className="mono">{d.fromAmount}</span>
                      <img src={d.fromLogo} alt={d.fromSymbol} className="w-4 h-4 rounded-full" />
                      <span className="mono">{d.fromSymbol}</span>
                    </>
                  )}
                </div>
              );
            }
            const isSameToken = d.fromSymbol === d.toSymbol && d.fromLogo === d.toLogo;
            return isSameToken ? (
              <p className="text-sm text-[var(--muted-foreground)] mb-3">
                {effectiveTxState.action} {d.fromAmount} {d.fromSymbol}
              </p>
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

  // DEBUG: Shared debug panel (rendered via portal to escape stacking contexts)
  const debugPanel = process.env.NODE_ENV === "development" && typeof document !== "undefined" && createPortal(
    <div
      data-debug-panel
      className={cn(
        "fixed z-[9999] border border-[var(--border)] rounded-lg p-3 shadow-2xl max-w-xs pointer-events-auto max-h-[80vh] overflow-y-auto",
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
        className="text-xs text-[var(--muted-foreground)] font-medium cursor-grab select-none flex items-center justify-between"
        onMouseDown={handleDragStart}
      >
        <span>⋮⋮ Lending TX Preview</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); toggleDebugMinimized(); }}
          onMouseDown={(e) => e.stopPropagation()}
          className="ml-2 px-1.5 py-0.5 rounded hover:bg-[var(--muted)] transition-colors text-[10px]"
        >
          {debugMinimized ? "+" : "−"}
        </button>
      </div>
      {!debugMinimized && <div className="space-y-2 mt-2">
        <button
          onClick={() => { setDebugTxState("none"); setDebugApproval("none"); setDebugSoftLiq(false); }}
          className={cn(
            "w-full px-2 py-1 text-xs rounded transition-colors",
            debugTxState === "none" && debugApproval === "none"
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
        {/* Approval scenarios */}
        <div className="flex gap-1 mt-1 pt-1 border-t border-[var(--border)]">
          <span className="text-[10px] text-[var(--muted-foreground)] w-16 flex items-center">Approve</span>
          {([
            { key: "ctrl-1of1" as const, label: "1/1" },
            { key: "erc20-1of2" as const, label: "1/2" },
            { key: "ctrl-2of2" as const, label: "2/2" },
            { key: "approving" as const, label: "Spin" },
          ]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => { setDebugApproval(key); setDebugTxState("none"); }}
              className={cn(
                "flex-1 px-2 py-1 text-xs rounded transition-colors",
                debugApproval === key
                  ? "bg-yellow-500 text-black"
                  : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Soft liquidation toggle */}
        <div className="flex gap-1 mt-1 pt-1 border-t border-[var(--border)]">
          <span className="text-[10px] text-[var(--muted-foreground)] w-16 flex items-center">Soft Liq</span>
          <button
            onClick={() => setDebugSoftLiq(!debugSoftLiq)}
            className={cn(
              "flex-1 px-2 py-1 text-xs rounded transition-colors",
              debugSoftLiq
                ? "bg-orange-500 text-black"
                : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            )}
          >
            {debugSoftLiq ? "On" : "Off"}
          </button>
        </div>
      </div>}
    </div>,
    document.body
  );

  // --- No Loan View: Choice screen or NewLoanForm ---
  if (!hasLoan) {
    // Choice screen: Curve Finance vs yld
    if (loanSource === "choice") {
      return (
        <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl p-6 space-y-4 flex-1 flex flex-col">
          <h3 className="text-lg font-medium text-center">Create New Loan</h3>
          <p className="text-sm text-[var(--muted-foreground)] text-center">
            Choose where to open your position
          </p>
          <div className="space-y-3">
            {/* Curve Finance — external link */}
            <button
              onClick={() =>
                window.open(
                  `https://www.curve.finance/lend/ethereum/markets/one-way-market-35/create`,
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
                  {zappersEnabled
                    ? "Deposit and borrow any token using Enso swaps. Optional leverage"
                    : "Deposit and borrow using the yld interface. Manage your collateral and debt positions"}
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
      <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl flex-1 flex flex-col">
        {/* Title + Back button — hidden during tx states */}
        {!effectiveTxState && (
          <div className="px-4 pt-3 pb-1 flex items-center gap-2">
            <button
              onClick={() => setLoanSource("choice")}
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors p-0.5 -ml-1"
              title="Back to options"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-medium">New Position</span>
          </div>
        )}

        {/* New Position Summary — mirrors the existing-position summary layout */}
        {!effectiveTxState && positionVisible && (<>
          <div className={cn("grid grid-cols-[2fr_2fr_3fr] gap-x-3 gap-y-0.5 px-4 pt-3 pb-2 transition-opacity duration-300", positionOpaque ? "opacity-100" : "opacity-0")}>
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
              Collateral
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
              Debt
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)] text-right">
              Leverage
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                {vault.logo && (
                  <Image src={vault.logo} alt="" width={14} height={14} className="rounded-full" />
                )}
                <span className="mono text-sm font-medium truncate">
                  {Number(formatUnits(displayCollateralAmount, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              </div>
              {oraclePrice > 0n && (
                <div className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
                  ${(Number(formatUnits(displayCollateralAmount * oraclePrice / (10n ** BigInt(vault.decimals)), 18))).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
              )}
              {collateralAPY != null && collateralAPY > 0 && (
                <div className="text-[10px] text-green-500 mt-0.5">
                  +{collateralAPY.toFixed(2)}% APY
                </div>
              )}
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <Image src="/tokens/crvusd.png" alt="" width={14} height={14} className="rounded-full" />
                <span className="mono text-sm font-medium truncate">
                  {displayDebtDelta > 0n
                    ? Number(formatUnits(displayDebtDelta, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })
                    : "0"}
                </span>
              </div>
              <div className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
                ${displayDebtDelta > 0n
                  ? Number(formatUnits(displayDebtDelta, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })
                  : "0.00"}
              </div>
              {(projectedBorrowAPY ?? currentBorrowAPY) != null && displayDebtDelta > 0n && (
                <div className="text-[10px] text-red-500 mt-0.5">
                  -{(projectedBorrowAPY ?? currentBorrowAPY!).toFixed(2)}% APY
                </div>
              )}
            </div>
            <div className="text-right">
              <div className="mono text-sm font-medium">
                {displayLeverage.toFixed(2)}x
                {maxLeverage && <span className="text-[var(--muted-foreground)] font-normal">{"\u2009/\u2009"}{maxLeverage.toFixed(2)}x</span>}
              </div>
              {oraclePrice > 0n && displayDebtDelta > 0n && (() => {
                const collValue = Number(formatUnits(displayCollateralAmount * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
                const debt = Number(formatUnits(displayDebtDelta, 18));
                const ltv = collValue > 0 ? (debt / collValue) * 100 : 0;
                return <LtvIndicator ltv={ltv} thresholds={ltvThresholds} />;
              })()}
              {collateralAPY != null && (projectedBorrowAPY ?? currentBorrowAPY) != null && displayDebtDelta > 0n && (() => {
                const lev = displayLeverage;
                const borrow = projectedBorrowAPY ?? currentBorrowAPY!;
                const net = lev * collateralAPY - (lev - 1) * borrow;
                return (
                  <div className={cn("text-[10px] mt-0.5", net >= 0 ? "text-green-500" : "text-red-500")}>
                    {net >= 0 ? "+" : ""}{net.toFixed(2)}% NET
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Health Bar */}
          <div className={cn("flex items-center gap-2 px-4 pb-2 h-6 transition-opacity duration-300", positionOpaque ? "opacity-100" : "opacity-0")}>
            <div className={cn("relative flex-1 h-2 rounded-full bg-[var(--muted)] overflow-hidden", childSettling && "animate-pulse")}>
              {newPositionHealth !== null && (
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out"
                  style={{
                    width: `${Math.min(Math.max(newPositionHealth, 0), 100)}%`,
                    backgroundColor: newPositionHealth < 5 ? "#ef4444" : newPositionHealth < 10 ? "#f97316" : newPositionHealth < 20 ? "#eab308" : newPositionHealth < 40 ? "#84cc16" : "#22c55e",
                  }}
                />
              )}
            </div>
            <span
              className="w-[4ch] text-sm font-medium mono leading-none select-none text-right shrink-0"
              style={{
                color: newPositionHealth === null
                  ? "var(--muted-foreground)"
                  : newPositionHealth < 5 ? "#ef4444" : newPositionHealth < 10 ? "#f97316" : newPositionHealth < 20 ? "#eab308" : newPositionHealth < 40 ? "#84cc16" : "#22c55e",
              }}
            >
              {childSettling && newPositionHealth !== null ? (
                newPositionHealth > 999
                  ? <span className="text-xl leading-none" style={{ position: "relative", top: "1px" }}>∞</span>
                  : `${Math.round(newPositionHealth)}%`
              ) : childSettling ? (
                <span className="inline-flex items-center justify-end w-full leading-none"><LoadingDots /></span>
              ) : newPositionHealth === null ? (
                <span className="block text-center text-xs">—</span>
              ) : newPositionHealth > 999 ? (
                <span className="text-xl leading-none" style={{ position: "relative", top: "1px" }}>∞</span>
              ) : (
                `${Math.round(newPositionHealth)}%`
              )}
            </span>
          </div>
        </>)}

        <div className={effectiveTxState || debugApprovalData ? "hidden" : "p-4 space-y-4"}>
          <NewLoanForm
            vault={vault}
            userBalance={userBalance}
            controllerAddress={controllerAddress}
            oraclePrice={oraclePrice}
            onTransactionSuccess={onTransactionSuccess}
            onEstimatedHealthChange={handleEstimatedHealthChange}
            onEstimatedLeverageChange={handleEstimatedLeverageChange}
            onDebtDeltaChange={handleDebtDeltaChange}
            onCollateralAmountChange={handleCollateralAmountChange}
            onSettlingChange={handleSettlingChange}
            onTxStateChange={handleTxStateChange}
            onBandsChange={handleBandsChange}
          />
        </div>

        {/* Debug Approval Preview */}
        {!effectiveTxState && debugApprovalData && (
          <div className="p-4 space-y-4">
            <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-3">
              <div className="text-sm font-medium">
                <span className="whitespace-nowrap">{debugApprovalData.progress.total > 1 ? "Approvals Required" : "Approval Required"} <a href={`https://etherscan.io/address/${controllerAddress}`} target="_blank" rel="noopener noreferrer" className="inline text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors font-normal"><ExternalLink size={12} className="!inline -mt-0.5" /></a></span>
              </div>
              {debugApprovalData.progress.total > 1 && (
                <div className="space-y-2">
                  {debugApprovalData.progress.steps.map((s, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <div className="mt-0.5">
                        {s.done ? (
                          <Check size={14} className="text-green-500 shrink-0" />
                        ) : i === debugApprovalData.progress.step - 1 ? (
                          <div className="w-3.5 h-3.5 rounded-full border-2 border-[var(--foreground)] shrink-0" />
                        ) : (
                          <div className="w-3.5 h-3.5 rounded-full border-2 border-[var(--foreground)]/30 shrink-0" />
                        )}
                      </div>
                      <div>
                        <div className={cn(
                          "text-sm",
                          s.done
                            ? "text-[var(--muted-foreground)] line-through"
                            : i === debugApprovalData.progress.step - 1
                              ? "text-[var(--foreground)] font-medium"
                              : "text-[var(--muted-foreground)]"
                        )}>
                          {s.label}
                        </div>
                        <div className={cn(
                          "text-xs",
                          i === debugApprovalData.progress.step - 1
                            ? "text-[var(--muted-foreground)]"
                            : "text-[var(--muted-foreground)]/60"
                        )}>
                          {s.description}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {debugApprovalData.type === "erc20" && debugApprovalData.amount ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => setDebugApprovingType("exact")}
                    disabled={debugApprovalData.isApproving}
                    className={cn(
                      "flex-[2] py-2.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm",
                      debugApprovalData.isApproving
                        ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                        : "border border-[var(--foreground)] text-[var(--foreground)] hover:bg-[var(--foreground)]/10"
                    )}
                  >
                    {debugApprovalData.isApproving && debugApprovingType === "exact" ? <>Approving<LoadingDots /></> : `${Number(formatUnits(debugApprovalData.amount, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${debugApprovalData.tokenSymbol}`}
                  </button>
                  <button
                    onClick={() => setDebugApprovingType("unlimited")}
                    disabled={debugApprovalData.isApproving}
                    className={cn(
                      "flex-1 py-2.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm",
                      debugApprovalData.isApproving
                        ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                        : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
                    )}
                  >
                    {debugApprovalData.isApproving && debugApprovingType === "unlimited" ? <>Approving<LoadingDots /></> : "Max"}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setDebugApprovingType("single")}
                  disabled={debugApprovalData.isApproving}
                  className={cn(
                    "w-full py-2.5 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
                    debugApprovalData.isApproving
                      ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                      : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
                  )}
                >
                  {debugApprovalData.isApproving
                    ? <>Approving<LoadingDots /></>
                    : `Approve (${debugApprovalData.progress.step}/${debugApprovalData.progress.total})`}
                </button>
              )}
            </div>
          </div>
        )}

        {txStateOverlay}
        {debugPanel}
      </div>
    );
  }

  // --- Has Loan View: Position summary + Health bar + Management tabs ---
  return (
    <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl flex-1 flex flex-col">
      {/* Title — hidden during tx states */}
      {!effectiveTxState && (
        <div className="px-4 pt-3 pb-1 flex items-center gap-2">
          <span className="text-sm font-medium">Position</span>
          {effectivePosition?.inSoftLiquidation && (
            effectivePosition.health <= 0 ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-500 font-medium">
                Liquidatable
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-500 font-medium">
                Soft Liquidation
              </span>
            )
          )}
        </div>
      )}

      {/* Position Summary — hidden during tx states */}
      {!effectiveTxState && (
        <div className={cn(
          "grid gap-x-3 gap-y-0.5 px-4 pt-3 pb-2",
          (effectiveLeverage || position?.hasLoan) ? "grid-cols-[5fr_4fr_4fr]" : "grid-cols-2"
        )}>
          <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
            Collateral
          </div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
            Debt
          </div>
          {(effectiveLeverage || position?.hasLoan) && (
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)] text-right">
              Leverage
            </div>
          )}
          <div>
            <div className="flex items-center gap-1.5">
              {vault.logo && (
                <Image src={vault.logo} alt="" width={14} height={14} className="rounded-full" />
              )}
              <span className="mono text-sm font-medium">
                {estimatedCollateral ?? positionCollateral}
              </span>
            </div>
            {position?.hasLoan && oraclePrice > 0n && (() => {
              const coll = childCollateralDelta !== null ? position.collateral + childCollateralDelta : position.collateral;
              const vaultTokenValue = coll * oraclePrice / (10n ** BigInt(vault.decimals));
              const totalValue = Number(formatUnits(vaultTokenValue + position.stablecoin, 18));
              return (
                <div className="text-[10px] text-[var(--muted-foreground)] mt-0.5 flex items-center gap-1">
                  <span>${totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  {position.stablecoin > 0n && (
                    <span className="flex items-center gap-0.5 whitespace-nowrap text-[var(--accent)]">
                      (<Image src="/tokens/crvusd.png" alt="" width={10} height={10} className="rounded-full inline" />
                      {Number(formatUnits(position.stablecoin, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })})
                    </span>
                  )}
                </div>
              );
            })()}
            {collateralAPY != null && (
              <div className="text-[10px] text-green-500 mt-0.5">
                +{(position?.collateral === 0n ? 0 : collateralAPY).toFixed(2)}% APY
              </div>
            )}
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <Image src="/tokens/crvusd.png" alt="" width={14} height={14} className="rounded-full" />
              <span className="mono text-sm font-medium truncate">
                {estimatedDebt ?? positionDebt}
              </span>
            </div>
            {position?.hasLoan && (
              <div className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
                ${Number(formatUnits(childDebtDelta !== null ? position.debt + childDebtDelta : position.debt, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
            )}
            {currentBorrowAPY != null && (
              <div className="text-[10px] text-red-500 mt-0.5">
                -{(projectedBorrowAPY ?? currentBorrowAPY).toFixed(2)}% APY
              </div>
            )}
          </div>
          {(effectiveLeverage || position?.hasLoan) && (
            <div className="text-right">
              {effectiveLeverage ? (
                <div className="mono text-sm font-medium">
                  {(() => {
                    const lev = childEstimatedLeverage ?? parseFloat(effectiveLeverage!);
                    const overMax = maxLeverage != null && lev > maxLeverage;
                    return (
                      <>
                        <span className={overMax ? "text-yellow-500" : ""}>
                          {childEstimatedLeverage !== null ? childEstimatedLeverage.toFixed(2) : effectiveLeverage}x
                        </span>
                        {maxLeverage && !overMax && <span className="text-[var(--muted-foreground)] font-normal">{"\u2009/\u2009"}{maxLeverage.toFixed(2)}x</span>}
                      </>
                    );
                  })()}
                </div>
              ) : (
                <div className="mono text-sm font-medium text-red-500">—</div>
              )}
              {position?.hasLoan && oraclePrice > 0n && (() => {
                // Use estimated leverage for LTV when available: LTV = 1 - 1/leverage
                if (childEstimatedLeverage !== null && childEstimatedLeverage > 1) {
                  const ltv = (1 - 1 / childEstimatedLeverage) * 100;
                  return <LtvIndicator ltv={ltv} thresholds={ltvThresholds} hideThresholds={position.inSoftLiquidation} />;
                }
                // Use estimated debt/collateral deltas when available
                const debt = childDebtDelta !== null
                  ? Number(formatUnits(position.debt + childDebtDelta, 18))
                  : Number(formatUnits(position.debt, 18));
                const coll = childCollateralDelta !== null
                  ? position.collateral + childCollateralDelta
                  : position.collateral;
                // Total collateral value: vault token + crvUSD in AMM bands
                const vaultTokenValue = Number(formatUnits(coll * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
                const collValue = vaultTokenValue + Number(formatUnits(position.stablecoin, 18));
                const ltv = collValue > 0 ? (debt / collValue) * 100 : 0;
                return <LtvIndicator ltv={ltv} thresholds={ltvThresholds} hideThresholds={position.inSoftLiquidation} />;
              })()}
              {(() => {
                const net = projectedNetAPY ?? currentNetAPY ?? (currentBorrowAPY != null ? -currentBorrowAPY : null);
                if (net == null) return null;
                return (
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className={cn("text-[10px]", net >= 0 ? "text-green-500" : "text-red-500")}>
                      {net >= 0 ? "+" : ""}{net.toFixed(2)}% NET
                    </span>
                    {vault.id === "ycvxcrv" && rewardApr != null && (
                      <span className="text-[10px] text-green-400">(+{rewardApr.toFixed(1)}% rewards)</span>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* Health Bar — below summary */}
      {!effectiveTxState && (position?.healthFull !== undefined || effectiveEstimatedHealth !== null) && (
        <div className="flex items-center gap-2 px-4 pb-2 h-6">
          <div className="relative flex-1 h-2 rounded-full bg-[var(--muted)] overflow-hidden">
            {(() => {
              const displayHealth = effectiveEstimatedHealth ?? position?.healthFull ?? 0;
              const barColor = displayHealth < 5 ? "#ef4444" : displayHealth < 10 ? "#f97316" : displayHealth < 20 ? "#eab308" : displayHealth < 40 ? "#84cc16" : "#22c55e";
              const isFlashing = effectiveEstimatedHealth !== null &&
                position?.healthFull !== undefined &&
                Math.round(effectiveEstimatedHealth) !== Math.round(position.healthFull) &&
                !(effectiveEstimatedHealth >= 100 && position.healthFull >= 100);
              const showGhost = position?.healthFull !== undefined && effectiveEstimatedHealth !== null && Math.round(effectiveEstimatedHealth) !== Math.round(position.healthFull);
              return (
                <>
                  {/* Ghost bar: current health at reduced opacity, same color as estimate */}
                  {showGhost && (
                    <div
                      className="absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out"
                      style={{
                        width: `${Math.min(Math.max(position!.healthFull, 0), 100)}%`,
                        backgroundColor: barColor,
                        opacity: 0.25,
                      }}
                    />
                  )}
                  {/* Main bar */}
                  <div
                    className="absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out"
                    style={{
                      width: `${Math.min(Math.max(displayHealth, 0), 100)}%`,
                      backgroundColor: barColor,
                      animation: isFlashing ? "health-pulse 1.2s ease-in-out infinite" : "none",
                    }}
                  />
                </>
              );
            })()}
          </div>
          {(() => {
            const displayHealth = effectiveEstimatedHealth ?? position?.healthFull ?? 0;
            const color = displayHealth < 5 ? "#ef4444" : displayHealth < 10 ? "#f97316" : displayHealth < 20 ? "#eab308" : displayHealth < 40 ? "#84cc16" : "#22c55e";
            return (
              <span className="text-sm font-medium mono leading-none select-none min-w-[2ch] text-right" style={{ color }}>
                {displayHealth > 999
                  ? <span className="text-xl leading-none" style={{ position: "relative", top: "1px" }}>∞</span>
                  : displayHealth > 0 && displayHealth < 1
                    ? `${displayHealth.toFixed(1)}%`
                    : `${Math.round(displayHealth)}%`}
              </span>
            );
          })()}
        </div>
      )}

      {/* Tabs — hidden during tx states */}
      {!effectiveTxState && (
        <div className="p-4 pb-0">
          <div className="flex border-b border-[var(--border)]">
            {(["borrow", "leverage", "repay", "collateral"] as const).filter((t) => t !== "leverage" || zappersEnabled || effectivePosition?.inSoftLiquidation).map((tab) => (
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
                {tab === "leverage" && effectivePosition?.inSoftLiquidation ? "liquidate" : tab}
                {activeTab === tab && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--foreground)]" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Form Content — hidden (not unmounted) during tx states so effects keep running */}
      <div className={effectiveTxState || debugApprovalData ? "hidden" : ""}>
          <div className="p-4 space-y-4">
            {activeTab === "collateral" && (
              <CollateralTab
                vault={vault}
                userBalance={userBalance}
                position={effectivePosition}
                controllerAddress={controllerAddress}
                onTransactionSuccess={onTransactionSuccess}
                onEstimatedHealthChange={handleEstimatedHealthChange}
                onCollateralDeltaChange={handleCollateralDeltaChange}
                onTxStateChange={handleTxStateChange}
                onSwitchTab={(t) => setActiveTab(t as Tab)}
              />
            )}
            {activeTab === "borrow" && (
              <BorrowTab
                vault={vault}
                position={effectivePosition}
                controllerAddress={controllerAddress}
                userBalance={userBalance}
                onTransactionSuccess={onTransactionSuccess}
                onEstimatedHealthChange={handleEstimatedHealthChange}
                onDebtDeltaChange={handleDebtDeltaChange}
                onCollateralDeltaChange={handleCollateralDeltaChange}
                onTxStateChange={handleTxStateChange}
                onSwitchTab={(t) => setActiveTab(t as Tab)}
              />
            )}
            {activeTab === "repay" && (
              <RepayTab
                vault={vault}
                position={effectivePosition}
                controllerAddress={controllerAddress}
                onTransactionSuccess={onTransactionSuccess}
                onEstimatedHealthChange={handleEstimatedHealthChange}
                onDebtDeltaChange={handleDebtDeltaChange}
                onCollateralDeltaChange={handleCollateralDeltaChange}
                onTxStateChange={handleTxStateChange}
                onSwitchTab={(t) => setActiveTab(t as Tab)}
              />
            )}
            {activeTab === "leverage" && (
              <LeverageTab
                vault={vault}
                userBalance={userBalance}
                position={effectivePosition}
                controllerAddress={controllerAddress}
                onTransactionSuccess={onTransactionSuccess}
                onEstimatedHealthChange={handleEstimatedHealthChange}
                onEstimatedLeverageChange={handleEstimatedLeverageChange}
                onDebtDeltaChange={handleDebtDeltaChange}
                onCollateralDeltaChange={handleCollateralDeltaChange}
                onTxStateChange={handleTxStateChange}
                onSwitchTab={(t) => setActiveTab(t as Tab)}
              />
            )}
          </div>
      </div>

      {/* Debug Approval Preview */}
      {!effectiveTxState && debugApprovalData && (
        <div className="p-4 space-y-4">
          <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-3">
            <div className="text-sm font-medium">
              <span className="whitespace-nowrap">{debugApprovalData.progress.total > 1 ? "Approvals Required" : "Approval Required"} <a href={`https://etherscan.io/address/${controllerAddress}`} target="_blank" rel="noopener noreferrer" className="inline text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors font-normal"><ExternalLink size={12} className="!inline -mt-0.5" /></a></span>
            </div>
            {debugApprovalData.progress.total > 1 && (
              <div className="space-y-2">
                {debugApprovalData.progress.steps.map((s, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <div className="mt-0.5">
                      {s.done ? (
                        <Check size={14} className="text-green-500 shrink-0" />
                      ) : i === debugApprovalData.progress.step - 1 ? (
                        <div className="w-3.5 h-3.5 rounded-full border-2 border-[var(--foreground)] shrink-0" />
                      ) : (
                        <div className="w-3.5 h-3.5 rounded-full border-2 border-[var(--foreground)]/30 shrink-0" />
                      )}
                    </div>
                    <div>
                      <div className={cn(
                        "text-sm",
                        s.done
                          ? "text-[var(--muted-foreground)] line-through"
                          : i === debugApprovalData.progress.step - 1
                            ? "text-[var(--foreground)] font-medium"
                            : "text-[var(--muted-foreground)]"
                      )}>
                        {s.label}
                      </div>
                      <div className={cn(
                        "text-xs",
                        i === debugApprovalData.progress.step - 1
                          ? "text-[var(--muted-foreground)]"
                          : "text-[var(--muted-foreground)]/60"
                      )}>
                        {s.description}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {debugApprovalData.type === "erc20" && debugApprovalData.amount ? (
              <div className="flex gap-2">
                <button
                  onClick={() => setDebugApprovingType("exact")}
                  disabled={debugApprovalData.isApproving}
                  className={cn(
                    "flex-[2] py-2.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm",
                    debugApprovalData.isApproving
                      ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                      : "border border-[var(--foreground)] text-[var(--foreground)] hover:bg-[var(--foreground)]/10"
                  )}
                >
                  {debugApprovalData.isApproving && debugApprovingType === "exact" ? <>Approving<LoadingDots /></> : `${Number(formatUnits(debugApprovalData.amount, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${debugApprovalData.tokenSymbol}`}
                </button>
                <button
                  onClick={() => setDebugApprovingType("unlimited")}
                  disabled={debugApprovalData.isApproving}
                  className={cn(
                    "flex-1 py-2.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm",
                    debugApprovalData.isApproving
                      ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                      : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
                  )}
                >
                  {debugApprovalData.isApproving && debugApprovingType === "unlimited" ? <>Approving<LoadingDots /></> : "Max"}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setDebugApprovingType("single")}
                disabled={debugApprovalData.isApproving}
                className={cn(
                  "w-full py-2.5 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
                  debugApprovalData.isApproving
                    ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                    : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
                )}
              >
                {debugApprovalData.isApproving
                  ? <>Approving<LoadingDots /></>
                  : `Approve (${debugApprovalData.progress.step}/${debugApprovalData.progress.total})`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Tx state overlay */}
      {txStateOverlay}

      {debugPanel}
    </div>
  );
}
