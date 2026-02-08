"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader2, Check, AlertTriangle, TrendingUp, TrendingDown } from "lucide-react";
import { useAccount, usePublicClient, useGasPrice, useBlockNumber } from "wagmi";
import { SimulationModal } from "@/components/SimulationModal";
import { toast } from "sonner";
import { formatUnits, parseUnits } from "viem";
import type { VaultConfig } from "@/config/vaults";
import { CURVE_CONTROLLERS } from "@/config/vaults";
import type { LendingPosition } from "@/hooks/useCurveLendingPosition";
import { useZapperActions } from "@/hooks/useZapperActions";
import { ZAPPER_ABI, CRVUSD_ADDRESS } from "@/lib/zapper";
import { MaxButton } from "@/components/MaxButton";
import { SlippageModal } from "@/components/SlippageModal";
import { cn } from "@/lib/utils";
import { sanitizeAmount } from "@/lib/sanitize";

// Controller ABI for health calculator + max_borrowable (2-arg & 3-arg overloads) + amm
const CONTROLLER_ABI = [
  {
    name: "health_calculator",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "d_collateral", type: "int256" },
      { name: "d_debt", type: "int256" },
      { name: "full", type: "bool" },
      { name: "N", type: "uint256" },
    ],
    outputs: [{ name: "", type: "int256" }],
  },
  {
    name: "max_borrowable",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "collateral", type: "uint256" },
      { name: "N", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "max_borrowable",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "collateral", type: "uint256" },
      { name: "N", type: "uint256" },
      { name: "current_debt", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "amm",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const AMM_ABI = [
  {
    name: "price_oracle",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Combined MAX button with hover options: MAX ALL (above) + Reset (below)
function LeverageMaxButton({
  onMax,
  onMaxAll,
  onReset,
}: {
  onMax: () => void;
  onMaxAll?: () => void; // undefined = hide MAX ALL
  onReset?: () => void;  // undefined = hide reset
}) {
  const [isHovered, setIsHovered] = useState(false);
  const hideTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleMouseEnter = useCallback(() => {
    if (hideTimeout.current) clearTimeout(hideTimeout.current);
    setIsHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    hideTimeout.current = setTimeout(() => setIsHovered(false), 150);
  }, []);

  const btnClass = "relative shrink-0 w-[36px] px-1 py-0.5 text-[10px] font-medium bg-[var(--background)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded transition-colors cursor-pointer flex items-center justify-center";

  return (
    <div className="relative">
      {/* Backdrop */}
      <div
        className={cn(
          "absolute right-0 rounded-md bg-[var(--background)]/40 transition-opacity duration-200 z-0 pointer-events-none -left-1 -right-1 -bottom-[26px]",
          onMaxAll ? "-top-[26px]" : "-top-1",
          isHovered ? "opacity-100" : "opacity-0"
        )}
      />

      {/* YOLO - above */}
      {onMaxAll && (
        <div
          className={cn(
            "absolute bottom-full right-0 pb-0.5 transition-[opacity,transform] duration-200 ease-out z-10",
            isHovered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1 pointer-events-none"
          )}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onMaxAll(); setIsHovered(false); }}
            className={cn(btnClass, "text-[var(--accent)]/70 hover:text-[var(--accent)]")}
          >
            <span className="text-[9px]">YOLO</span>
          </button>
        </div>
      )}

      {/* Main MAX button */}
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onMax}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className={cn(btnClass, "relative z-10")}
      >
        MAX
      </button>

      {/* Reset - below (always visible on hover, disabled when nothing to reset) */}
      <div
        className={cn(
          "absolute top-full right-0 pt-0.5 transition-[opacity,transform] duration-200 ease-out z-10",
          isHovered ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1 pointer-events-none"
        )}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <button
          type="button"
          tabIndex={-1}
          disabled={!onReset}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onReset?.(); setIsHovered(false); }}
          className={cn(btnClass, !onReset && "opacity-30 !cursor-default hover:text-[var(--muted-foreground)]")}
          title="Reset leverage and collateral"
        >
          <span className="text-[8px]">RESET</span>
        </button>
      </div>
    </div>
  );
}

interface LeverageTabProps {
  vault: VaultConfig;
  userBalance: string;
  position: LendingPosition | null;
  controllerAddress: `0x${string}`;
  onTransactionSuccess: () => void;
  onEstimatedHealthChange?: (health: number | null) => void;
  onEstimatedLeverageChange?: (leverage: number | null) => void;
}

type LeverageMode = "leverageUp" | "deleverage" | "selfLiquidate";

export function LeverageTab({
  vault,
  userBalance,
  position,
  controllerAddress,
  onTransactionSuccess,
  onEstimatedHealthChange,
  onEstimatedLeverageChange,
}: LeverageTabProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  // Determine mode based on position state
  const mode: LeverageMode = useMemo(() => {
    if (position?.health !== undefined && (position.health <= 0 || position.inSoftLiquidation)) return "selfLiquidate";
    return "leverageUp"; // Default, user can switch
  }, [position]);

  // Sub-tab for positions with loan (leverageUp / deleverage)
  const [subTab, setSubTab] = useState<"leverageUp" | "deleverage">("leverageUp");
  const activeMode = mode === "selfLiquidate" ? mode : subTab;

  // Form state
  const [collateralAmount, setCollateralAmountRaw] = useState("");
  const setCollateralAmount = useCallback((v: string) => setCollateralAmountRaw(sanitizeAmount(v)), []);
  const [leverage, setLeverage] = useState(2.0);
  const [leverageInput, setLeverageInput] = useState(leverage.toFixed(2));
  const leverageInputFocused = useRef(false);
  const leverageDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pendingYolo, setPendingYolo] = useState(false);
  const [calcMaxSeq, setCalcMaxSeq] = useState(0);
  const yoloWaitSeq = useRef(0);
  const [deleveragePercent, setDeleveragePercent] = useState(0);
  const [selfLiqPercent, setSelfLiqPercent] = useState(100);

  // Slippage (basis points) - persisted to localStorage
  const [slippage, setSlippage] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("yldfi-slippage") || "50";
    }
    return "50";
  });
  const [showSlippageModal, setShowSlippageModal] = useState(false);

  // Simulation toggle from settings
  const [showSimulationPreview, setShowSimulationPreview] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("yldfi-show-simulation") === "true";
    }
    return false;
  });

  // Simulation preview
  const [showSimulationModal, setShowSimulationModal] = useState(false);
  const simulationBlock = useRef<bigint>(0n);
  const [ethPrice, setEthPrice] = useState<number | null>(null);

  // Block number + gas price for cached simulation re-open
  const { data: currentBlock } = useBlockNumber({ watch: true });
  const { data: gasPrice } = useGasPrice({ query: { refetchInterval: 12_000 } });

  const updateSlippage = useCallback((value: string) => {
    setSlippage(value);
    if (typeof window !== "undefined") {
      localStorage.setItem("yldfi-slippage", value);
    }
  }, []);

  // Calculated values
  const [maxBorrowable, setMaxBorrowable] = useState<bigint>(0n); // max total debt for totalCollateral
  const [maxBorrowableLoaded, setMaxBorrowableLoaded] = useState(false);
  const [oraclePrice, setOraclePrice] = useState<bigint>(0n); // collateral price in crvUSD (1e18)
  const [estimatedHealth, setEstimatedHealth] = useState<number | null>(null);
  const [swapQuote, setSwapQuote] = useState<{ expectedOut: string } | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);

  // Zapper actions
  const {
    createLeveragedLoan,
    leverageUp: leverageUpAction,
    deleverage: deleverageAction,
    selfLiquidate: selfLiquidateAction,
    pendingApproval,
    approvalProgress,
    approve,
    isApproving,
    isApprovalSuccess,
    executeAfterApproval,
    status,
    txHash,
    error,
    simulationResult,
    reset,
    executeAfterPreview,
  } = useZapperActions();

  // Collateral token is the vault address
  const collateralToken = vault.address as `0x${string}`;

  // Parse user balance
  const formattedBalance = useMemo(() => {
    const value = Number(formatUnits(BigInt(userBalance), vault.decimals));
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }, [userBalance, vault.decimals]);

  const userBalanceBn = useMemo(() => BigInt(userBalance), [userBalance]);

  // Number of bands from existing position
  const positionBands = position?.hasLoan ? position.n2 - position.n1 + 1 : 10;

  // Total collateral (existing position + additional input)
  const totalCollateral = useMemo(() => {
    const existing = position?.hasLoan ? position.collateral : 0n;
    try {
      const additional = collateralAmount ? parseUnits(collateralAmount, vault.decimals) : 0n;
      return existing + additional;
    } catch {
      return existing;
    }
  }, [position, collateralAmount, vault.decimals]);

  // Existing debt
  const existingDebt = position?.hasLoan ? position.debt : 0n;

  // Calculate max borrowable + oracle price
  // For existing positions, use 3-arg max_borrowable(collateral, N, current_debt)
  // which adds current_debt back to pool balance for the liquidity cap calculation
  useEffect(() => {
    let stale = false;
    async function calcMax() {
      if (!publicClient) {
        setMaxBorrowable(0n);
        setOraclePrice(0n);
        setMaxBorrowableLoaded(true);
        setCalcMaxSeq(s => s + 1);
        return;
      }
      try {
        // Read AMM address + oracle price
        const ammAddress = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "amm",
        });
        if (stale) return;
        const price = await publicClient.readContract({
          address: ammAddress as `0x${string}`,
          abi: AMM_ABI,
          functionName: "price_oracle",
        });
        if (stale) return;
        setOraclePrice(price);

        let max = 0n;
        if (totalCollateral > 0n) {
          if (existingDebt > 0n) {
            max = await publicClient.readContract({
              address: controllerAddress,
              abi: CONTROLLER_ABI,
              functionName: "max_borrowable",
              args: [totalCollateral, BigInt(positionBands), existingDebt],
            });
          } else {
            max = await publicClient.readContract({
              address: controllerAddress,
              abi: CONTROLLER_ABI,
              functionName: "max_borrowable",
              args: [totalCollateral, BigInt(positionBands)],
            });
          }
        }
        if (stale) return;
        setMaxBorrowable(max);
      } catch {
        if (stale) return;
        setMaxBorrowable(0n);
      }
      setMaxBorrowableLoaded(true);
      setCalcMaxSeq(s => s + 1);
    }
    calcMax();
    return () => { stale = true; };
  }, [publicClient, controllerAddress, totalCollateral, positionBands, existingDebt]);

  // Max additional borrow
  // For existing positions: maxBorrowable = max total debt (from 3-arg call with current_debt),
  // so additional = maxBorrowable - existingDebt
  // For new positions: maxBorrowable = max total debt (same as additional since no existing debt)
  const maxAdditionalBorrow = useMemo(() => {
    if (existingDebt > 0n) {
      const additional = maxBorrowable > existingDebt ? maxBorrowable - existingDebt : 0n;
      return additional;
    }
    return maxBorrowable;
  }, [existingDebt, maxBorrowable]);

  // Max leverage: account for leverage loop (borrow D → swap to D/price collateral → add)
  // newLeverage = (collValue + D) / (collValue - existingDebt)
  const maxLeverage = useMemo(() => {
    if (oraclePrice === 0n || totalCollateral === 0n) return 5;
    const collValue = Number(formatUnits(totalCollateral * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
    const debt = Number(formatUnits(existingDebt, 18));
    const maxD = Number(formatUnits(maxAdditionalBorrow, 18));
    const equity = collValue - debt;
    if (equity <= 0) return 1.1;
    const maxLev = (collValue + maxD) / equity;
    return Math.min(Math.max(maxLev, 1.1), 10);
  }, [totalCollateral, oraclePrice, vault.decimals, existingDebt, maxAdditionalBorrow]);

  // Current effective leverage (existing position only, for display)
  const currentLeverage = useMemo(() => {
    if (oraclePrice === 0n || !position?.hasLoan || position.collateral === 0n) return 1;
    const collValue = Number(formatUnits(position.collateral * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
    const debt = Number(formatUnits(position.debt, 18));
    if (collValue <= debt) return 1;
    return collValue / (collValue - debt);
  }, [position, oraclePrice, vault.decimals]);

  // Base leverage after adding collateral but zero additional debt
  // This is the slider minimum — you can't target less leverage than what you'd have
  // after depositing the additional collateral with no new borrowing
  const baseLeverage = useMemo(() => {
    if (oraclePrice === 0n || totalCollateral === 0n) return 1;
    const collValue = Number(formatUnits(totalCollateral * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
    const debt = Number(formatUnits(existingDebt, 18));
    if (collValue <= debt) return 1;
    return collValue / (collValue - debt);
  }, [totalCollateral, oraclePrice, vault.decimals, existingDebt]);

  // Clamp leverage to valid range when maxLeverage/baseLeverage changes
  const sliderMin = Math.max(Math.floor(baseLeverage * 100), 110);
  useEffect(() => {
    if (pendingYolo) return; // skip clamping while YOLO is pending
    if (leverage > maxLeverage) setLeverage(Math.max(baseLeverage, 1.1));
    if (leverage < baseLeverage && baseLeverage > 1) setLeverage(baseLeverage);
  }, [maxLeverage, baseLeverage, pendingYolo]); // eslint-disable-line react-hooks/exhaustive-deps

  // YOLO: snap leverage to max once calcMax completes for updated collateral
  useEffect(() => {
    if (!pendingYolo) return;
    if (calcMaxSeq > yoloWaitSeq.current) {
      if (maxBorrowable > 0n) {
        setLeverage(maxLeverage);
        setLeverageInput(maxLeverage.toFixed(2));
      }
      setPendingYolo(false);
    }
  }, [pendingYolo, calcMaxSeq, maxBorrowable, maxLeverage]);  

  // Sync text input when leverage changes from slider/clamp (not while user is typing)
  useEffect(() => {
    if (!leverageInputFocused.current) {
      setLeverageInput(leverage.toFixed(2));
    }
  }, [leverage]);

  // Calculate additional debt from leverage slider
  // newLeverage = (collValue + D) / (collValue - existingDebt) → D = newLev * equity - collValue
  const debtAmount = useMemo(() => {
    if (oraclePrice === 0n || totalCollateral === 0n) return 0n;
    const collValue = Number(formatUnits(totalCollateral * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
    const debt = Number(formatUnits(existingDebt, 18));
    const equity = collValue - debt;
    if (equity <= 0) return 0n;
    const additionalD = leverage * equity - collValue;
    if (additionalD <= 0) return 0n;
    // Cap at maxAdditionalBorrow
    const maxD = Number(formatUnits(maxAdditionalBorrow, 18));
    const capped = Math.min(additionalD, maxD);
    try {
      return parseUnits(capped.toFixed(6), 18);
    } catch {
      return 0n;
    }
  }, [leverage, oraclePrice, totalCollateral, vault.decimals, existingDebt, maxAdditionalBorrow]);

  // Calculate collateral to sell for deleverage
  const collateralToSell = useMemo(() => {
    if (!position?.hasLoan || deleveragePercent === 0) return 0n;
    return position.collateral * BigInt(deleveragePercent) / 100n;
  }, [position, deleveragePercent]);

  // Estimate health for new positions
  useEffect(() => {
    async function calcHealth() {
      if (!publicClient || !address) {
        setEstimatedHealth(null);
        return;
      }

      try {
        let dCollateral = 0n;
        let dDebt = 0n;

        if (activeMode === "leverageUp") {
          dCollateral = collateralAmount ? parseUnits(collateralAmount, vault.decimals) : 0n;
          dDebt = debtAmount;
        } else if (activeMode === "deleverage" && collateralToSell > 0n) {
          dCollateral = -collateralToSell;
          // Estimate debt reduction from swap
          dDebt = 0n; // Will be negative after swap, but hard to estimate precisely
        }

        if (dCollateral === 0n && dDebt === 0n) {
          setEstimatedHealth(null);
          return;
        }

        const health = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "health_calculator",
          args: [
            address,
            BigInt(dCollateral),
            BigInt(dDebt),
            true, // full health including price bands
            0n, // 0 = use existing bands for active loans
          ],
        });

        setEstimatedHealth(Number(health) / 1e16);
      } catch {
        setEstimatedHealth(null);
      }
    }

    const timer = setTimeout(calcHealth, 300); // Debounce
    return () => clearTimeout(timer);
  }, [publicClient, address, controllerAddress, activeMode, collateralAmount, debtAmount, vault.decimals, collateralToSell]);

  // Report estimated health to parent
  useEffect(() => {
    onEstimatedHealthChange?.(estimatedHealth);
  }, [estimatedHealth, onEstimatedHealthChange]);

  // Report estimated leverage to parent
  useEffect(() => {
    if (activeMode === "leverageUp" && debtAmount > 0n) {
      // leverage state IS the target leverage
      onEstimatedLeverageChange?.(leverage);
    } else if (activeMode === "deleverage" && collateralToSell > 0n && oraclePrice > 0n && position?.hasLoan) {
      // After selling collateral: remaining collateral, debt reduced by swap proceeds (approximate)
      const remainingColl = position.collateral - collateralToSell;
      const collValue = Number(formatUnits(remainingColl * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
      const debt = Number(formatUnits(position.debt, 18));
      // Deleverage swaps collateral to crvUSD to repay — approximate: debt reduced proportionally
      const sellValue = Number(formatUnits(collateralToSell * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
      const remainingDebt = Math.max(debt - sellValue, 0);
      if (collValue > remainingDebt && collValue > 0) {
        onEstimatedLeverageChange?.(collValue / (collValue - remainingDebt));
      } else {
        onEstimatedLeverageChange?.(null);
      }
    } else {
      onEstimatedLeverageChange?.(null);
    }
  }, [activeMode, leverage, debtAmount, collateralToSell, oraclePrice, position, vault.decimals, onEstimatedLeverageChange]);

  // Handle transaction success
  useEffect(() => {
    if (status === "success") {
      onTransactionSuccess();
    }
  }, [status, onTransactionSuccess]);

  // Handle approval success -> continue execution
  useEffect(() => {
    if (isApprovalSuccess && status === "approving") {
      executeAfterApproval();
    }
  }, [isApprovalSuccess, status, executeAfterApproval]);

  const handleSubmit = async () => {
    if (!address || !controllerAddress) return;

    const preview = showSimulationPreview;

    const openModalIfPreview = (result: unknown) => {
      if (result && preview) {
        simulationBlock.current = currentBlock ?? 0n;
        setShowSimulationModal(true);
        if (publicClient) {
          publicClient.readContract({
            address: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as `0x${string}`,
            abi: [{
              name: "latestRoundData",
              type: "function",
              stateMutability: "view",
              inputs: [],
              outputs: [
                { name: "roundId", type: "uint80" },
                { name: "answer", type: "int256" },
                { name: "startedAt", type: "uint256" },
                { name: "updatedAt", type: "uint256" },
                { name: "answeredInRound", type: "uint80" },
              ],
            }],
            functionName: "latestRoundData",
          }).then(data => {
            setEthPrice(Number(data[1] as bigint) / 1e8);
          }).catch(() => {});
        }
      }
    };

    try {
      if (activeMode === "leverageUp") {
        const additionalCollateral = collateralAmount ? parseUnits(collateralAmount, vault.decimals) : 0n;
        const result = await leverageUpAction(
          controllerAddress,
          additionalCollateral,
          debtAmount,
          collateralToken,
          Number(slippage),
          preview
        );
        openModalIfPreview(result);
      } else if (activeMode === "deleverage") {
        const result = await deleverageAction(
          controllerAddress,
          collateralToSell,
          collateralToken,
          Number(slippage),
          preview
        );
        openModalIfPreview(result);
      } else if (activeMode === "selfLiquidate") {
        const result = await selfLiquidateAction(
          controllerAddress,
          BigInt(selfLiqPercent) * 10n ** 16n, // percentage in 1e18 scale
          collateralToken,
          Number(slippage),
          preview
        );
        openModalIfPreview(result);
      }
    } catch (err) {
      console.error("Leverage action failed:", err);
    }
  };

  const handleExecute = async () => {
    try {
      await executeAfterPreview();
    } catch (err) {
      console.error("Leverage execution failed:", err);
    }
  };

  const isProcessing = status !== "idle" && status !== "success" && status !== "error" && status !== "needsApproval";

  const getButtonText = () => {
    if (status === "building") return "Building transaction...";
    if (status === "simulating") return "Simulating...";
    if (status === "executing") return "Confirm in wallet...";
    if (status === "waitingTx") return "Waiting for confirmation...";
    if (status === "success") return "Done!";
    if (status === "error") return "Try Again";

    if (activeMode === "leverageUp") return "Leverage Up";
    if (activeMode === "deleverage") {
      return deleveragePercent === 100 ? "Close Position" : "Deleverage";
    }
    if (activeMode === "selfLiquidate") return "Self Liquidate";
    return "Submit";
  };

  const isFormValid = () => {
    if (activeMode === "leverageUp") return debtAmount > 0n;
    if (activeMode === "deleverage") return collateralToSell > 0n;
    if (activeMode === "selfLiquidate") return selfLiqPercent > 0;
    return false;
  };

  return (
    <div className="space-y-4">
      {/* Has position: Leverage Up / Deleverage */}
      {mode !== "selfLiquidate" && (
        <>
          {/* Sub-tabs */}
          <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--muted)] border border-[var(--border)]">
            <button
              onClick={() => { setSubTab("leverageUp"); reset(); setCollateralAmount(""); setLeverage(baseLeverage); setDeleveragePercent(0); setPendingYolo(false); setEstimatedHealth(null); }}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium transition-all",
                activeMode === "leverageUp"
                  ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              )}
            >
              <TrendingUp size={14} />
              Leverage Up
            </button>
            <button
              onClick={() => { setSubTab("deleverage"); reset(); setCollateralAmount(""); setLeverage(baseLeverage); setDeleveragePercent(0); setPendingYolo(false); setEstimatedHealth(null); }}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium transition-all",
                activeMode === "deleverage"
                  ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              )}
            >
              <TrendingDown size={14} />
              Deleverage
            </button>
          </div>

          {/* Leverage Up */}
          {activeMode === "leverageUp" && (
            <>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm text-[var(--muted-foreground)]">
                    Additional Collateral (optional)
                  </label>
                  <span className="text-xs text-[var(--muted-foreground)]">
                    Max: {formattedBalance}
                  </span>
                </div>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:border-[var(--foreground)]">
                  <input
                    type="text"
                    value={collateralAmount}
                    onChange={(e) => setCollateralAmount(e.target.value)}
                    placeholder="0.0"
                    className="flex-1 min-w-0 bg-transparent mono text-base outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
                  />
                  <span className="mono text-sm font-medium shrink-0">
                    {vault.symbol}
                  </span>
                  <MaxButton
                    balance={formatUnits(userBalanceBn, vault.decimals)}
                    onSelect={setCollateralAmount}
                  />
                </div>
              </div>

              {/* Pool liquidity warning */}
              {maxAdditionalBorrow === 0n && totalCollateral > 0n && !pendingYolo && maxBorrowableLoaded && (
                <div className="p-3 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/30 text-sm text-[var(--accent)]">
                  No crvUSD available to borrow. The lending pool is fully utilized.
                </div>
              )}

              {/* Low liquidity: can borrow but not enough to increase leverage */}
              {maxAdditionalBorrow > 0n && Math.floor(maxLeverage * 100) <= sliderMin && !pendingYolo && maxBorrowableLoaded && (
                <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] text-sm text-[var(--muted-foreground)]">
                  Pool liquidity is limited ({Number(formatUnits(maxAdditionalBorrow, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })} crvUSD available).
                  {collateralAmount ? " Reduce additional collateral for a wider leverage range." : ""}
                </div>
              )}

              {/* Leverage target slider */}
              {(pendingYolo || (maxAdditionalBorrow > 0n && Math.floor(maxLeverage * 100) > sliderMin)) && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-[var(--muted-foreground)]">
                      Target Leverage
                    </label>
                    <div className="flex items-center gap-1 px-1.5 py-1 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:border-[var(--foreground)]">
                      <input
                        type="text"
                        value={leverageInput}
                        onChange={(e) => {
                          setLeverageInput(e.target.value);
                          clearTimeout(leverageDebounce.current);
                          leverageDebounce.current = setTimeout(() => {
                            const v = parseFloat(e.target.value);
                            if (!isNaN(v)) {
                              const clamped = Math.min(Math.max(v, baseLeverage), maxLeverage);
                              setLeverage(clamped);
                              setLeverageInput(clamped.toFixed(2));
                            }
                          }, 500);
                        }}
                        onFocus={() => { leverageInputFocused.current = true; }}
                        onBlur={() => {
                          leverageInputFocused.current = false;
                          const v = parseFloat(leverageInput);
                          if (!isNaN(v)) {
                            const clamped = Math.min(Math.max(v, baseLeverage), maxLeverage);
                            setLeverage(clamped);
                            setLeverageInput(clamped.toFixed(2));
                          } else {
                            setLeverageInput(leverage.toFixed(2));
                          }
                        }}
                        className="w-[3rem] bg-transparent text-right mono text-sm outline-none"
                      />
                      <span className="text-sm text-[var(--muted-foreground)] pointer-events-none">x</span>
                      <LeverageMaxButton
                        onMax={() => {
                          setLeverage(maxLeverage);
                          setLeverageInput(maxLeverage.toFixed(2));
                        }}
                        onMaxAll={userBalanceBn > 0n ? () => {
                          setCollateralAmount(formatUnits(userBalanceBn, vault.decimals));
                          yoloWaitSeq.current = calcMaxSeq;
                          setPendingYolo(true);
                        } : undefined}
                        onReset={Math.round(leverage * 100) !== sliderMin || collateralAmount !== "" ? () => {
                          setLeverage(baseLeverage);
                          setLeverageInput(baseLeverage.toFixed(2));
                          setCollateralAmount("");
                        } : undefined}
                      />
                    </div>
                  </div>
                  <input
                    type="range"
                    min={sliderMin}
                    max={Math.floor(maxLeverage * 100)}
                    value={Math.floor(leverage * 100)}
                    onChange={(e) => setLeverage(Number(e.target.value) / 100)}
                    className="w-full"
                  />
                </div>
              )}

              {debtAmount > 0n && Number(formatUnits(debtAmount, 18)) >= 0.1 && (
                <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] text-sm">
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Additional Borrow</span>
                    <span className="mono">
                      {Number(formatUnits(debtAmount, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD
                    </span>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Deleverage */}
          {activeMode === "deleverage" && (
            <>
              <div>
                <label className="text-sm text-[var(--muted-foreground)] mb-2 block">
                  Collateral to Sell
                </label>
                <div className="flex gap-2 mb-3">
                  {[25, 50, 75, 100].map((pct) => (
                    <button
                      key={pct}
                      onClick={() => setDeleveragePercent(pct)}
                      className={cn(
                        "flex-1 py-2 rounded-lg text-sm font-medium transition-all",
                        deleveragePercent === pct
                          ? "bg-[var(--foreground)] text-[var(--background)]"
                          : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                      )}
                    >
                      {pct === 100 ? "Close" : `${pct}%`}
                    </button>
                  ))}
                </div>

                {collateralToSell > 0n && (
                  <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Selling</span>
                      <span className="mono">
                        {Number(formatUnits(collateralToSell, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {vault.symbol}
                      </span>
                    </div>
                    {deleveragePercent === 100 && (
                      <div className="text-xs text-[var(--accent)]">
                        Sells all collateral, repays debt, returns remainder
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* Self Liquidate */}
      {activeMode === "selfLiquidate" && (
        <>
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-500 text-sm flex items-center gap-2">
            <AlertTriangle size={16} />
            <div>
              <div className="font-medium">Position Underwater</div>
              <div className="text-xs mt-0.5">Self-liquidation sells collateral to repay as much debt as possible</div>
            </div>
          </div>

          <div>
            <label className="text-sm text-[var(--muted-foreground)] mb-2 block">
              Liquidation Amount
            </label>
            <div className="flex gap-2">
              {[25, 50, 75, 100].map((pct) => (
                <button
                  key={pct}
                  onClick={() => setSelfLiqPercent(pct)}
                  className={cn(
                    "flex-1 py-2 rounded-lg text-sm font-medium transition-all",
                    selfLiqPercent === pct
                      ? "bg-red-500 text-white"
                      : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  )}
                >
                  {pct}%
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Approval Flow */}
      {pendingApproval && status === "needsApproval" && (
        <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-3">
          <div className="text-sm font-medium">Approvals Required</div>
          {approvalProgress && (
            <div className="space-y-2">
              {approvalProgress.steps.map((s, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="mt-0.5">
                    {s.done ? (
                      <Check size={14} className="text-green-500 shrink-0" />
                    ) : i === approvalProgress.step - 1 ? (
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
                        : i === approvalProgress.step - 1
                          ? "text-[var(--foreground)] font-medium"
                          : "text-[var(--muted-foreground)]"
                    )}>
                      {s.label}
                    </div>
                    <div className={cn(
                      "text-xs",
                      i === approvalProgress.step - 1
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
          {pendingApproval.type === "erc20" && pendingApproval.amount ? (
            <div className="flex gap-2">
              <button
                onClick={() => approve(true)}
                disabled={isApproving}
                className={cn(
                  "flex-1 py-2.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm",
                  isApproving
                    ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                    : "border border-[var(--foreground)] text-[var(--foreground)] hover:bg-[var(--foreground)]/10"
                )}
              >
                {isApproving && <Loader2 className="w-4 h-4 animate-spin" />}
                {isApproving ? "Approving..." : `Exact (${Number(formatUnits(pendingApproval.amount, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 2 })})`}
              </button>
              <button
                onClick={() => approve(false)}
                disabled={isApproving}
                className={cn(
                  "flex-1 py-2.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm",
                  isApproving
                    ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                    : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
                )}
              >
                {isApproving && <Loader2 className="w-4 h-4 animate-spin" />}
                {isApproving ? "Approving..." : "Unlimited"}
              </button>
            </div>
          ) : (
            <button
              onClick={() => approve()}
              disabled={isApproving}
              className={cn(
                "w-full py-2.5 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
                isApproving
                  ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                  : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
              )}
            >
              {isApproving && <Loader2 className="w-4 h-4 animate-spin" />}
              {isApproving
                ? "Approving..."
                : pendingApproval.type === "controller"
                  ? `Approve Lending Access${approvalProgress ? ` (${approvalProgress.step}/${approvalProgress.total})` : ""}`
                  : `Approve ${pendingApproval.tokenSymbol}${approvalProgress ? ` (${approvalProgress.step}/${approvalProgress.total})` : ""}`}
            </button>
          )}
        </div>
      )}

      {/* Error Display */}
      {error && status === "error" && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-500 text-sm">
          {error}
        </div>
      )}

      {/* Success Display */}
      {status === "success" && txHash && (
        <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-500 text-sm flex items-center gap-2">
          <Check size={16} />
          Transaction successful!
          <a
            href={`https://etherscan.io/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            View
          </a>
        </div>
      )}

      {/* Simulation Modal */}
      {showSimulationModal && simulationResult && (
        <SimulationModal
          isOpen={showSimulationModal}
          onClose={() => {
            setShowSimulationModal(false);
            toast("Transaction cancelled", { id: "leverage-cancelled", duration: 3000 });
          }}
          onConfirm={() => {
            setShowSimulationModal(false);
            handleExecute();
          }}
          simulationResult={simulationResult}
          gasPrice={gasPrice}
          ethPrice={ethPrice}
          confirmText="Confirm & Execute"
        />
      )}

      {/* Slippage Settings */}
      <div className="flex items-center justify-end">
        <button
          onClick={() => setShowSlippageModal(true)}
          className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors p-1"
          title="Settings"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="4" y1="6" x2="20" y2="6" />
            <circle cx="8" cy="6" r="2" />
            <line x1="4" y1="18" x2="20" y2="18" />
            <circle cx="16" cy="18" r="2" />
          </svg>
        </button>
      </div>

      {/* Action Button */}
      {status !== "needsApproval" && (
        <button
          onClick={() => {
            if (status === "error" || status === "success") {
              reset();
            } else if (simulationResult && !showSimulationModal && currentBlock === simulationBlock.current) {
              // Re-open cached simulation modal if same block
              setShowSimulationModal(true);
            } else {
              handleSubmit();
            }
          }}
          disabled={isProcessing || (!isFormValid() && status === "idle")}
          className={cn(
            "w-full py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
            isProcessing || (!isFormValid() && status === "idle")
              ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
              : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
          )}
        >
          {isProcessing && <Loader2 className="w-4 h-4 animate-spin" />}
          {getButtonText()}
        </button>
      )}

      {/* Connect wallet prompt */}
      {!address && (
        <div className="text-center text-sm text-[var(--muted-foreground)] py-4">
          Connect your wallet to use leverage
        </div>
      )}

      <SlippageModal
        open={showSlippageModal}
        onClose={() => {
          setShowSlippageModal(false);
          try {
            setShowSimulationPreview(localStorage.getItem("yldfi-show-simulation") === "true");
          } catch { /* ignore */ }
        }}
        slippage={slippage}
        onSlippageChange={updateSlippage}
      />
    </div>
  );
}
