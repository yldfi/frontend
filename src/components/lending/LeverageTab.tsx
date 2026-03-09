"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AlertTriangle, TrendingUp, TrendingDown, Route as RouteIcon, RouteOff } from "lucide-react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { useAccount, usePublicClient, useGasPrice, useBlockNumber, useBalance } from "wagmi";
import { SimulationModal } from "@/components/SimulationModal";
import { toast } from "sonner";
import { isUserRejection } from "@/lib/analytics";
import { formatUnits, parseUnits } from "viem";
import type { VaultConfig } from "@/config/vaults";
import { CURVE_CONTROLLERS, TOKENS, TANGENT } from "@/config/vaults";
import { getVaultInfo } from "@/lib/curve-lending";
import type { LendingPosition } from "@/hooks/useCurveLendingPosition";
import { useZapperActions } from "@/hooks/useZapperActions";
import { CRVUSD_ADDRESS, CHAINLINK_ETH_USD } from "@/config/addresses";
import { ZAPPER_ABI, ZAPPER_ADDRESS } from "@/lib/zapper";
import { TokenSelector } from "@/components/TokenSelector";
import { ETH_ADDRESS, fetchRoute } from "@/lib/enso";
import { getMaxEthAmount } from "@/lib/eth-gas";
import type { EnsoToken, RouteInfo } from "@/types/enso";
import { RouteDisplay } from "@/components/RouteDisplay";
import { MaxButton } from "@/components/MaxButton";
import { SlippageModal } from "@/components/SlippageModal";
import { cn } from "@/lib/utils";
import { LoadingDots } from "@/components/LoadingDots";
import { sanitizeAmount } from "@/lib/sanitize";
import { useSettings } from "@/hooks/useSettings";
import { CONTROLLER_ABI, AMM_ABI, ERC4626_ABI, CURVE_GET_DY_ABI } from "@/lib/abis";

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

// Deleverage MIN button with hover options: CLOSE (above) + RESET (below)
function DeleverageMinButton({
  onMin,
  onClose,
  onReset,
}: {
  onMin: () => void;
  onClose: () => void;
  onReset?: () => void;
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
          "absolute right-0 rounded-md bg-[var(--background)]/40 transition-opacity duration-200 z-0 pointer-events-none -left-1 -right-1 -top-[26px] -bottom-[26px]",
          isHovered ? "opacity-100" : "opacity-0"
        )}
      />

      {/* CLOSE - above */}
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
          onClick={() => { onClose(); setIsHovered(false); }}
          className={cn(btnClass, "text-red-400/70 hover:text-red-400")}
        >
          <span className="text-[8px]">CLOSE</span>
        </button>
      </div>

      {/* Main MIN button */}
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onMin}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className={cn(btnClass, "relative z-10")}
      >
        MIN
      </button>

      {/* RESET - below */}
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
          title="Reset to current leverage"
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
  onDebtDeltaChange?: (delta: bigint | null) => void;
  onCollateralDeltaChange?: (delta: bigint | null) => void;
  onTxStateChange?: (state: { status: "pending" | "success" | "reverted"; action: string; hash: string; details?: { fromAmount: string; fromSymbol: string; fromLogo: string; toAmount: string; toSymbol: string; toLogo: string } } | null) => void;
  onSwitchTab?: (tab: string) => void;
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
  onDebtDeltaChange,
  onCollateralDeltaChange,
  onTxStateChange,
  onSwitchTab,
}: LeverageTabProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  // Underwater confirmation for self-liquidation (user must acknowledge paying gap with no collateral returned)
  const [underwaterConfirmed, setUnderwaterConfirmed] = useState(false);
  const isUnderwater = position?.health !== undefined && position.health <= 0 && position.collateral === 0n;
  // When collateral is fully converted (0), partial liquidation_extended reverts — only full close works
  const forceFullLiquidation = position?.collateral === 0n;

  // Determine mode based on position state
  // selfLiquidate when health ≤ 0 OR in soft-liquidation (direct self-liquidation works at any health)
  const mode: LeverageMode = useMemo(() => {
    if (position?.health !== undefined && position.health <= 0) return "selfLiquidate";
    if (position?.inSoftLiquidation) return "selfLiquidate";
    return "leverageUp"; // Default, user can switch
  }, [position]);

  // Sub-tab for positions with loan (leverageUp / deleverage)
  const [subTab, setSubTab] = useState<"leverageUp" | "deleverage">("leverageUp");
  const activeMode = mode === "selfLiquidate" ? mode : subTab;

  // Form state — persisted across refresh
  const leverageStorageKey = `yldfi-lending-leverage-${vault.address}`;
  const [collateralAmount, setCollateralAmountRaw] = useState(() => {
    if (typeof window === "undefined") return "";
    try { return sanitizeAmount(sessionStorage.getItem(leverageStorageKey) ?? ""); } catch { return ""; }
  });
  const setCollateralAmount = useCallback((v: string) => {
    const sanitized = sanitizeAmount(v);
    setCollateralAmountRaw(sanitized);
    // Only invalidate when value actually changes totalCollateral (non-zero input)
    // Setting "0" doesn't change totalCollateral, so calcMax won't re-run to restore the flag
    if (sanitized && Number(sanitized) > 0) {
      setMaxBorrowableLoaded(false); // force clamp to wait for fresh calcMax
    }
    try {
      if (sanitized) sessionStorage.setItem(leverageStorageKey, sanitized);
      else sessionStorage.removeItem(leverageStorageKey);
    } catch { /* */ }
  }, [leverageStorageKey]);
  const [leverage, setLeverage] = useState(2.0);
  const [leverageInput, setLeverageInput] = useState(leverage.toFixed(2));
  const leverageInputFocused = useRef(false);
  const leverageDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leverageFollowsBase = useRef(true); // true = leverage tracks baseLeverage; false = user explicitly set it
  const leverageAnimRef = useRef<number | null>(null);
  const [pendingYolo, setPendingYolo] = useState(false);
  const [calcMaxSeq, setCalcMaxSeq] = useState(0);
  const yoloWaitSeq = useRef(0);
  const [forceCalcMax, setForceCalcMax] = useState(0);

  // Smooth leverage animation (YOLO ramp up, RESET ramp down)
  const cancelLeverageAnim = useCallback(() => {
    if (leverageAnimRef.current !== null) {
      cancelAnimationFrame(leverageAnimRef.current);
      leverageAnimRef.current = null;
    }
  }, []);
  const animateLeverage = useCallback((from: number, to: number, duration: number, onComplete?: () => void) => {
    cancelLeverageAnim();
    const startTime = performance.now();
    function tick(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
      const value = from + (to - from) * eased;
      setLeverage(value);
      setLeverageInput(value.toFixed(2));
      if (progress < 1) {
        leverageAnimRef.current = requestAnimationFrame(tick);
      } else {
        leverageAnimRef.current = null;
        onComplete?.();
      }
    }
    leverageAnimRef.current = requestAnimationFrame(tick);
  }, [cancelLeverageAnim]);
  useEffect(() => () => cancelLeverageAnim(), [cancelLeverageAnim]);

  // Deleverage state: target leverage slider + optional withdrawal
  const [deleverageTarget, setDeleverageTarget] = useState(1.0);
  const [deleverageInput, setDeleverageInput] = useState("1.00");
  const deleverageInitialized = useRef(false);
  const deleverageInputFocused = useRef(false);
  const deleverageAnimRef = useRef<number | null>(null);
  const cancelDeleverageAnim = useCallback(() => {
    if (deleverageAnimRef.current !== null) {
      cancelAnimationFrame(deleverageAnimRef.current);
      deleverageAnimRef.current = null;
    }
  }, []);
  const animateDeleverage = useCallback((from: number, to: number, duration: number) => {
    cancelDeleverageAnim();
    const startTime = performance.now();
    function tick(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
      const value = from + (to - from) * eased;
      setDeleverageTarget(value);
      setDeleverageInput(value.toFixed(2));
      if (progress < 1) {
        deleverageAnimRef.current = requestAnimationFrame(tick);
      } else {
        deleverageAnimRef.current = null;
      }
    }
    deleverageAnimRef.current = requestAnimationFrame(tick);
  }, [cancelDeleverageAnim]);
  useEffect(() => () => cancelDeleverageAnim(), [cancelDeleverageAnim]);
  const deleverageDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [withdrawAmount, setWithdrawAmountRaw] = useState("");
  const setWithdrawAmount = useCallback((v: string) => setWithdrawAmountRaw(sanitizeAmount(v)), []);
  const isV2Available = true;
  // Output token for withdrawal — defaults to vault token (collateral)
  const [withdrawToken, setWithdrawToken] = useState<EnsoToken | null>(null); // null = vault token
  const isWithdrawToOtherToken = withdrawToken !== null && withdrawToken.address.toLowerCase() !== vault.address.toLowerCase();
  const withdrawTokenDecimals = isWithdrawToOtherToken ? (withdrawToken.decimals ?? 18) : vault.decimals;

  // Swap rate for withdraw token: how many ycvxCRV per 1 withdraw token (for input conversion)
  // e.g., if 1 ETH = 10000 ycvxCRV, withdrawRate = 10000
  const [withdrawRate, setWithdrawRate] = useState<number>(0);
  useEffect(() => {
    if (!isWithdrawToOtherToken || !address) {
      setWithdrawRate(0);
      return;
    }
    // Immediately clear stale rate from previous token so Max/MAX don't show wrong values
    setWithdrawRate(0);
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        // Quote: 1 unit of withdraw token → how much ycvxCRV
        const oneUnit = parseUnits("1", withdrawTokenDecimals);
        const route = await fetchRoute({
          fromAddress: address,
          tokenIn: withdrawToken!.address,
          tokenOut: vault.address,
          amountIn: oneUnit.toString(),
          slippage: "500",
        });
        if (!stale) {
          setWithdrawRate(Number(formatUnits(BigInt(route.amountOut), vault.decimals)));
        }
      } catch {
        if (!stale) setWithdrawRate(0);
      }
    }, 300);
    return () => { stale = true; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWithdrawToOtherToken, withdrawToken?.address, vault.address, address, withdrawTokenDecimals, vault.decimals]);

  const [selfLiqPercent, setSelfLiqPercentRaw] = useState(100);
  // Force 100% when collateral fully converted (partial reverts on-chain)
  const effectiveSelfLiqPercent = forceFullLiquidation ? 100 : selfLiqPercent;
  const setSelfLiqPercent = useCallback((v: number) => {
    if (!forceFullLiquidation) setSelfLiqPercentRaw(v);
  }, [forceFullLiquidation]);
  const [canDirectLiquidate, setCanDirectLiquidate] = useState(false);

  const {
    slippage, updateSlippage, showSlippageModal, setShowSlippageModal,
    showSimulationPreview, setShowSimulationPreview, refreshSimulationPreview,
    showSimulationModal, setShowSimulationModal,
    showRoute, toggleRoute,
  } = useSettings();
  const simulationBlock = useRef<bigint>(0n);
  const [ethPrice, setEthPrice] = useState<number | null>(null);

  // Block number + gas price for cached simulation re-open
  const { data: currentBlock } = useBlockNumber({ watch: true });
  const { data: gasPrice } = useGasPrice({ query: { refetchInterval: 12_000 } });


  // Calculated values
  const [maxBorrowable, setMaxBorrowable] = useState<bigint>(0n); // max total debt for totalCollateral
  const [maxBorrowableLoaded, setMaxBorrowableLoaded] = useState(false);
  const [controllerCrvUsdBalance, setControllerCrvUsdBalance] = useState<bigint | null>(null);
  const [oraclePrice, setOraclePrice] = useState<bigint>(0n); // collateral price in crvUSD (1e18)
  const [estimatedHealth, setEstimatedHealth] = useState<number | null>(null);
  const [swapQuote, setSwapQuote] = useState<{ expectedOut: string } | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);

  // Zapper actions
  const {
    createLeveragedLoan,
    createLeveragedLoanFromToken: createLeveragedLoanFromTokenAction,
    leverageUp: leverageUpAction,
    leverageUpFromToken: leverageUpFromTokenAction,
    deleverage: deleverageAction,
    deleverageAndWithdraw: deleverageAndWithdrawAction,
    deleverageAndWithdrawToToken: deleverageAndWithdrawToTokenAction,
    selfLiquidate: _selfLiquidateAction, // unused — kept for zapper API compat
    directLiquidate: directLiquidateAction,
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
    clearError,
    executeAfterPreview,
  } = useZapperActions();

  // Preserve last approval data so content stays in DOM during close animation
  const lastApprovalRef = useRef(pendingApproval);
  if (pendingApproval) lastApprovalRef.current = pendingApproval;
  const showApprovalCard = !!(pendingApproval && (status === "needsApproval" || status === "approving"));

  // Collateral token is the vault address
  const collateralToken = vault.address as `0x${string}`;

  // Parse user balance (bigint) — needed before token selector
  const userBalanceBn = useMemo(() => BigInt(userBalance), [userBalance]);

  // Token selector for leverage up (non-collateral tokens)
  const vaultToken: EnsoToken = useMemo(() => ({
    address: vault.address,
    chainId: 1,
    name: vault.name,
    symbol: vault.symbol,
    decimals: vault.decimals,
    logoURI: vault.logoSmall,
    type: "defi" as const,
  }), [vault]);

  const [selectedToken, setSelectedToken] = useState<EnsoToken>(vaultToken);
  const isCollateralToken = selectedToken.address.toLowerCase() === vault.address.toLowerCase();

  // Detect if selected input token is a vault token (e.g. yscvgCVX) that needs special routing
  const inputVaultInfo = useMemo(
    () => (isCollateralToken ? null : getVaultInfo(selectedToken.address)),
    [selectedToken.address, isCollateralToken]
  );

  // Balance for non-collateral token
  const isEth = selectedToken.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const { data: altTokenBalance, refetch: refetchBalance } = useBalance({
    address,
    token: isEth ? undefined : (selectedToken.address as `0x${string}`),
    query: { enabled: !!address && !isCollateralToken },
  });
  const effectiveBalance = isCollateralToken ? userBalanceBn : (altTokenBalance?.value ?? 0n);
  const effectiveDecimals = isCollateralToken ? vault.decimals : (altTokenBalance?.decimals ?? 18);
  const effectiveFormattedBalance = useMemo(() => {
    const value = Number(formatUnits(effectiveBalance, effectiveDecimals));
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }, [effectiveBalance, effectiveDecimals]);

  // Parse user balance
  const formattedBalance = useMemo(() => {
    const value = Number(formatUnits(BigInt(userBalance), vault.decimals));
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }, [userBalance, vault.decimals]);

  // Number of bands from existing position
  const positionBands = position?.hasLoan ? position.N : 10;

  // Estimate collateral output for non-collateral token input (swap quote)
  // Route directly to collateral token (vault token, e.g. ycvxCRV)
  const [estimatedCollateralFromSwap, setEstimatedCollateralFromSwap] = useState<bigint>(0n);
  const [swapRouteInfo, setSwapRouteInfo] = useState<RouteInfo | undefined>();
  const [swapQuoteLoading, setSwapQuoteLoading] = useState(false);
  useEffect(() => {
    if (isCollateralToken || !collateralAmount || Number(collateralAmount) <= 0 || !address) {
      setEstimatedCollateralFromSwap(0n);
      setSwapRouteInfo(undefined);
      setSwapQuoteLoading(false);
      return;
    }
    let stale = false;
    setMaxBorrowableLoaded(false); // hide stale "at max leverage" while quote fetches
    setSwapQuoteLoading(true);
    const timer = setTimeout(async () => {
      try {
        const inputAmount = parseUnits(collateralAmount, effectiveDecimals);

        let collateralOut: bigint;
        let routeSteps: RouteInfo["steps"];

        if (inputVaultInfo && publicClient) {
          // Vault token input: estimate via previewRedeem + intermediate swaps
          const isCvgCvxUnderlying = inputVaultInfo.underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();

          if (isCvgCvxUnderlying) {
            // cvgCVX path: previewRedeem → get_dy (cvgCVX→CVX1) → fetchRoute(CVX→collateral)
            const estimatedUnderlying = await publicClient.readContract({
              address: inputVaultInfo.address as `0x${string}`,
              abi: ERC4626_ABI,
              functionName: "previewRedeem",
              args: [inputAmount],
            }) as bigint;
            if (stale) return;

            const estimatedCvx1 = await publicClient.readContract({
              address: TANGENT.CVX1_CVGCVX_POOL as `0x${string}`,
              abi: CURVE_GET_DY_ABI,
              functionName: "get_dy",
              args: [1n, 0n, estimatedUnderlying],
            }) as bigint;
            if (stale) return;

            // CVX1→CVX is 1:1, route CVX → collateral token
            const route = await fetchRoute({
              fromAddress: address,
              tokenIn: TOKENS.CVX,
              tokenOut: vault.address,
              amountIn: estimatedCvx1.toString(),
              slippage: "300",
            });
            if (stale) return;
            collateralOut = BigInt(route.amountOut);
            routeSteps = [
              { tokenSymbol: selectedToken.symbol, action: "Redeem", description: `for cvgCVX`, protocol: "ERC4626 Vault" },
              { tokenSymbol: "cvgCVX", action: "Swap", description: `via CVX1 to CVX`, protocol: "Curve + HybridZapper" },
              { tokenSymbol: "CVX", action: "Swap", description: `for ${vault.symbol}`, protocol: "Enso Router" },
              { tokenSymbol: vault.symbol, action: "Deposit as Collateral", protocol: "Curve LlamaLend", amount: Number(formatUnits(collateralOut, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }) },
            ];
          } else {
            // Standard vault: previewRedeem → fetchRoute(underlying → collateral)
            const estimatedUnderlying = await publicClient.readContract({
              address: inputVaultInfo.address as `0x${string}`,
              abi: ERC4626_ABI,
              functionName: "previewRedeem",
              args: [inputAmount],
            }) as bigint;
            if (stale) return;

            const route = await fetchRoute({
              fromAddress: address,
              tokenIn: inputVaultInfo.underlying,
              tokenOut: vault.address,
              amountIn: estimatedUnderlying.toString(),
              slippage: "300",
            });
            if (stale) return;
            collateralOut = BigInt(route.amountOut);
            routeSteps = [
              { tokenSymbol: selectedToken.symbol, action: "Redeem", description: `for ${inputVaultInfo.underlyingSymbol}`, protocol: "ERC4626 Vault" },
              { tokenSymbol: inputVaultInfo.underlyingSymbol, action: "Swap", description: `for ${vault.symbol}`, protocol: "Enso Router" },
              { tokenSymbol: vault.symbol, action: "Deposit as Collateral", protocol: "Curve LlamaLend", amount: Number(formatUnits(collateralOut, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }) },
            ];
          }
        } else {
          // Standard token: direct route to collateral
          const route = await fetchRoute({
            fromAddress: address,
            tokenIn: selectedToken.address,
            tokenOut: vault.address,
            amountIn: inputAmount.toString(),
            slippage: "300", // 3% for estimation only
          });
          collateralOut = BigInt(route.amountOut);
          routeSteps = [
            { tokenSymbol: selectedToken.symbol, action: "Swap", description: `for ${vault.symbol}`, protocol: "Enso Router" },
            { tokenSymbol: vault.symbol, action: "Deposit as Collateral", protocol: "Curve LlamaLend", amount: Number(formatUnits(collateralOut, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }) },
          ];
        }

        if (!stale) {
          setEstimatedCollateralFromSwap(collateralOut);
          setSwapRouteInfo({ steps: routeSteps });
        }
      } catch (err) {
        console.error("[SwapEstimate] Failed:", err);
        if (!stale) {
          setEstimatedCollateralFromSwap(0n);
          setSwapRouteInfo(undefined);
        }
      } finally {
        if (!stale) setSwapQuoteLoading(false);
      }
    }, 500); // debounce
    return () => { stale = true; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCollateralToken, collateralAmount, effectiveDecimals, selectedToken.address, vault.address, address, inputVaultInfo]);

  // Total collateral (existing position + additional input)
  // For non-collateral tokens, use swap quote estimate
  const totalCollateral = useMemo(() => {
    const existing = position?.hasLoan ? position.collateral : 0n;
    if (!isCollateralToken) return existing + estimatedCollateralFromSwap;
    try {
      const additional = collateralAmount ? parseUnits(collateralAmount, vault.decimals) : 0n;
      return existing + additional;
    } catch {
      return existing;
    }
  }, [position, collateralAmount, vault.decimals, isCollateralToken, estimatedCollateralFromSwap]);

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
        // Read controller's crvUSD balance (for liquidity constraint detection)
        try {
          const bal = await publicClient.readContract({
            address: CRVUSD_ADDRESS as `0x${string}`,
            abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const,
            functionName: "balanceOf",
            args: [controllerAddress],
          });
          if (!stale) setControllerCrvUsdBalance(bal);
        } catch { /* non-critical */ }

        // Apply 0.2% safety margin (matches Curve lending-js SDK: * 998 / 1000)
        // Controller's max_borrowable already has 0.01% on-chain buffer;
        // this SDK-level buffer prevents "Debt too high" at max leverage
        // due to swap slippage between quote time and execution.
        setMaxBorrowable(max > 0n ? max * 998n / 1000n : 0n);
      } catch {
        if (stale) return;
        setMaxBorrowable(0n);
      }
      setMaxBorrowableLoaded(true);
      setCalcMaxSeq(s => s + 1);
    }
    calcMax();
    return () => { stale = true; };
  }, [publicClient, controllerAddress, totalCollateral, positionBands, existingDebt, forceCalcMax]);

  // True when pool liquidity caps borrowing (maxBorrowable ≈ controller balance)
  const isLiquidityConstrained = useMemo(() => {
    if (!controllerCrvUsdBalance || maxBorrowable === 0n) return false;
    const threshold = controllerCrvUsdBalance * 105n / 100n;
    return maxBorrowable <= threshold;
  }, [controllerCrvUsdBalance, maxBorrowable]);

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
  // The loop effect: borrowed crvUSD swaps to more collateral, raising max_borrowable further.
  // If LTV ratio r = maxBorrowable/collValue, then loop-adjusted maxD = singleStepMaxD / (1 - r).
  // newLeverage = (collValue + loopMaxD) / equity
  const maxLeverage = useMemo(() => {
    if (oraclePrice === 0n || totalCollateral === 0n) return 5;
    const collValue = Number(formatUnits(totalCollateral * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
    const debt = Number(formatUnits(existingDebt, 18));
    const singleStepMaxD = Number(formatUnits(maxAdditionalBorrow, 18));
    const equity = collValue - debt;
    if (equity <= 0) return 1.1;
    // Leverage loop adjustment (matches curve-lending-js geometric series):
    // r = LTV ratio, loopMaxD = singleStepMaxD / (1 - r), then 0.2% safety margin
    const r = collValue > 0 ? Number(formatUnits(maxBorrowable, 18)) / collValue : 0;
    let loopMaxD = r < 0.99 ? singleStepMaxD / (1 - r) * 0.998 : singleStepMaxD;
    // Cap by actual pool liquidity — Zapper's borrow_more_extended does a single
    // borrow, so the controller must have enough crvUSD to transfer in one shot.
    // No extra margin here — maxBorrowable already has 0.2% safety margin.
    if (controllerCrvUsdBalance != null) {
      const poolCap = Number(formatUnits(controllerCrvUsdBalance, 18));
      loopMaxD = Math.min(loopMaxD, poolCap);
    }
    const maxLev = (collValue + loopMaxD) / equity;
    return Math.min(Math.max(maxLev, 1.1), 10);
  }, [totalCollateral, oraclePrice, vault.decimals, existingDebt, maxAdditionalBorrow, maxBorrowable, controllerCrvUsdBalance]);

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

  // Stable maxLeverage for slider rendering — only updates when calcMax has fresh data
  // AND no animation is running. Prevents visual flash from stale maxBorrowable and
  // prevents slider max from dropping mid-animation (which clamps the thumb to min).
  // Exception: during YOLO animations, DON'T freeze — let the range narrow in real-time
  // so the thumb stays at 100% (animated value above new max gets clamped to right end).
  const isAnimating = leverageAnimRef.current !== null;
  const shouldFreezeMax = isAnimating && !pendingYolo;
  const stableMaxLevRef = useRef(maxLeverage);
  if (maxBorrowableLoaded && !shouldFreezeMax) stableMaxLevRef.current = maxLeverage;
  const renderMaxLeverage = (maxBorrowableLoaded && !shouldFreezeMax) ? maxLeverage : stableMaxLevRef.current;

  // Effective leverage: when tracking baseLeverage, use it directly (no stale state flash)
  // When user has explicitly set leverage, use the leverage state
  const effectiveLeverage = useMemo(() => {
    return leverageFollowsBase.current ? baseLeverage : leverage;
  }, [baseLeverage, leverage]);

  // Clamp leverage to valid range when maxLeverage/baseLeverage changes
  const sliderMin = Math.max(Math.floor(baseLeverage * 100), 110);

  // Preserve slider visibility during stale data transitions and animations
  const sliderVisibleRef = useRef(false);
  const sliderCondition = maxAdditionalBorrow > 0n && renderMaxLeverage > baseLeverage + 0.005;
  // Show slider greyed out while loading quote/calcMax when user has entered an amount
  const hasInput = collateralAmount !== "" && Number(collateralAmount) > 0;
  const sliderLoading = !maxBorrowableLoaded && hasInput && !pendingYolo;
  const showSlider = pendingYolo || isAnimating || sliderLoading || (maxBorrowableLoaded ? sliderCondition : sliderVisibleRef.current);
  if (maxBorrowableLoaded && !isAnimating) sliderVisibleRef.current = sliderCondition;

  useEffect(() => {
    if (pendingYolo || !maxBorrowableLoaded || leverageAnimRef.current !== null) return; // skip while YOLO pending, calcMax in-flight, or animating
    if (leverageFollowsBase.current) {
      // Keep leverage state synced with baseLeverage (for when user later interacts with slider)
      if (Math.abs(leverage - baseLeverage) > 0.001) setLeverage(baseLeverage);
      return;
    }
    if (leverage > maxLeverage) setLeverage(Math.max(baseLeverage, 1.1));
    if (leverage < baseLeverage && baseLeverage > 1) setLeverage(baseLeverage);
  }, [maxLeverage, baseLeverage, pendingYolo, maxBorrowableLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // YOLO: re-target animation once calcMax completes with real maxLeverage
  // Animation already started in click handler with stale estimate — this adjusts the target.
  // pendingYolo stays true until re-target completes (keeps renderMaxLeverage unfrozen).
  useEffect(() => {
    if (!pendingYolo) return;
    if (calcMaxSeq > yoloWaitSeq.current && maxBorrowableLoaded) {
      if (maxBorrowable > 0n) {
        leverageFollowsBase.current = false;
        // Re-target from current animated position to real maxLeverage
        animateLeverage(leverage, maxLeverage, 200, () => {
          setPendingYolo(false);
        });
      } else {
        cancelLeverageAnim();
        setPendingYolo(false);
      }
    }
  }, [pendingYolo, calcMaxSeq, maxBorrowable, maxBorrowableLoaded, maxLeverage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync text input when effective leverage changes from slider/clamp/base tracking (not while user is typing)
  useEffect(() => {
    if (!leverageInputFocused.current) {
      setLeverageInput(effectiveLeverage.toFixed(2));
    }
  }, [effectiveLeverage]);

  // Initialize deleverage target to current leverage on mount (when refreshing on deleverage tab)
  useEffect(() => {
    if (deleverageInitialized.current) return;
    if (activeMode === "deleverage" && currentLeverage > 1) {
      deleverageInitialized.current = true;
      setDeleverageTarget(currentLeverage);
      setDeleverageInput(currentLeverage.toFixed(2));
    }
  }, [activeMode, currentLeverage]);

  // Sync deleverage input when target changes from slider (not while user is typing)
  useEffect(() => {
    if (!deleverageInputFocused.current) {
      setDeleverageInput(deleverageTarget.toFixed(2));
    }
  }, [deleverageTarget]);

  // Calculate additional debt from leverage slider
  // newLeverage = (collValue + D) / (collValue - existingDebt) → D = newLev * equity - collValue
  // Cap uses loop-adjusted max: the Zapper swaps borrowed crvUSD to collateral on-chain,
  // so the controller sees higher collateral when checking health.
  const debtAmount = useMemo(() => {
    if (oraclePrice === 0n || totalCollateral === 0n) return 0n;
    const collValue = Number(formatUnits(totalCollateral * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
    const debt = Number(formatUnits(existingDebt, 18));
    const equity = collValue - debt;
    if (equity <= 0) return 0n;
    const additionalD = effectiveLeverage * equity - collValue;
    if (additionalD <= 0) return 0n;
    // Loop-adjusted cap: singleStepMax / (1 - LTV_ratio), with 0.2% safety margin
    const singleStepMaxD = Number(formatUnits(maxAdditionalBorrow, 18));
    const r = collValue > 0 ? Number(formatUnits(maxBorrowable, 18)) / collValue : 0;
    let loopMaxD = r < 0.99 ? singleStepMaxD / (1 - r) * 0.998 : singleStepMaxD;
    // Cap by actual pool liquidity — Zapper does a single borrow_more_extended,
    // so controller must have enough crvUSD to transfer in one shot.
    // No extra margin — maxBorrowable already has 0.2% safety margin.
    if (controllerCrvUsdBalance != null) {
      const poolCap = Number(formatUnits(controllerCrvUsdBalance, 18));
      loopMaxD = Math.min(loopMaxD, poolCap);
    }
    const capped = Math.min(additionalD, loopMaxD);
    try {
      let result = parseUnits(capped.toFixed(6), 18);
      // toFixed(6) can round up past the actual controller balance — clamp to avoid revert
      if (controllerCrvUsdBalance != null && result > controllerCrvUsdBalance) {
        result = controllerCrvUsdBalance;
      }
      return result;
    } catch {
      return 0n;
    }
  }, [effectiveLeverage, oraclePrice, totalCollateral, vault.decimals, existingDebt, maxAdditionalBorrow, maxBorrowable, controllerCrvUsdBalance]);

  // Parse withdrawal amount (convert from withdraw token units to ycvxCRV)
  const withdrawAmountBn = useMemo(() => {
    if (!withdrawAmount) return 0n;
    try {
      if (isWithdrawToOtherToken) {
        // Rate not yet loaded — don't guess, return 0 to avoid stale health bar flicker
        if (withdrawRate <= 0) return 0n;
        // Convert: input amount (in withdraw token) × rate = ycvxCRV amount
        const inputVal = Number(withdrawAmount);
        if (isNaN(inputVal) || inputVal <= 0) return 0n;
        const ycvxcrvAmount = inputVal * withdrawRate;
        return parseUnits(ycvxcrvAmount.toFixed(vault.decimals > 8 ? 8 : vault.decimals), vault.decimals);
      }
      return parseUnits(withdrawAmount, vault.decimals);
    } catch { return 0n; }
  }, [withdrawAmount, vault.decimals, isWithdrawToOtherToken, withdrawRate]);

  // Calculate collateral to sell for target deleverage
  // S = (C - W_val) - L * (C - W_val - D)
  const deleverageCollateralToSell = useMemo(() => {
    if (!position?.hasLoan || oraclePrice === 0n) return 0n;
    const C = Number(formatUnits(position.collateral * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
    const D = Number(formatUnits(position.debt, 18));
    // W_val: crvUSD value of collateral being withdrawn (withdrawAmountBn is already in ycvxCRV)
    const W_val = withdrawAmountBn > 0n ? Number(formatUnits(withdrawAmountBn * oraclePrice / (10n ** BigInt(vault.decimals)), 18)) : 0;
    const L = deleverageTarget;
    const sellValue = (C - W_val) - L * (C - W_val - D);
    if (sellValue <= 0) return 0n;
    // Convert crvUSD value to token amount
    const tokenAmount = sellValue / Number(formatUnits(oraclePrice, 18));
    const decimals = vault.decimals > 6 ? 6 : vault.decimals;
    try { return parseUnits(tokenAmount.toFixed(decimals), vault.decimals); } catch { return 0n; }
  }, [position, oraclePrice, vault, deleverageTarget, withdrawAmountBn]);

  // Debt repaid (approximate)
  const debtToRepay = useMemo(() => {
    if (oraclePrice === 0n || deleverageCollateralToSell === 0n) return 0n;
    return deleverageCollateralToSell * oraclePrice / (10n ** BigInt(vault.decimals));
  }, [deleverageCollateralToSell, oraclePrice, vault.decimals]);

  // Close position: sell ALL collateral to fully repay debt.
  // Controller closes loan when stablecoins from swap >= debt (repay_extended).
  // Only trigger when user explicitly targets 1.0x (CLOSE button or slider at minimum).
  const isClosePosition = deleverageTarget <= 1.001;

  // Projected max withdrawable after deleverage
  // DeFi Saver's userMaxWithdraw = collateral - controller.min_collateral(debt, N)
  // So min_collateral_current = collateral - maxWithdrawable (already fetched on-chain)
  // Since min_collateral is linear in debt, scale for remaining debt after deleverage:
  //   minColl_projected = minColl_current × remainingDebt / currentDebt
  //   projectedMaxWithdrawable = remainingCollateral - minColl_projected
  const projectedMaxWithdrawable = useMemo(() => {
    if (!position?.hasLoan) return 0n;
    if (deleverageCollateralToSell === 0n) return position.maxWithdrawable;

    const remainingCollateral = position.collateral > deleverageCollateralToSell
      ? position.collateral - deleverageCollateralToSell : 0n;
    const remainingDebt = position.debt > debtToRepay
      ? position.debt - debtToRepay : 0n;

    if (remainingDebt === 0n) return remainingCollateral;
    if (position.debt === 0n) return 0n;

    // Derive min_collateral from DeFi Saver's on-chain result, then scale linearly
    const minCollCurrent = position.collateral - position.maxWithdrawable;
    const minCollProjected = minCollCurrent * remainingDebt / position.debt;
    return remainingCollateral > minCollProjected ? remainingCollateral - minCollProjected : 0n;
  }, [position, deleverageCollateralToSell, debtToRepay]);

  // Stable max withdrawable for MaxButton display — computed with W_val=0 to break the
  // circular dependency: withdrawAmountBn → deleverageCollateralToSell → projectedMax → MAX → withdrawAmount
  const stableMaxWithdrawable = useMemo(() => {
    if (!position?.hasLoan || oraclePrice === 0n) return 0n;

    // Compute deleverageCollateralToSell with W_val = 0
    const C = Number(formatUnits(position.collateral * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
    const D = Number(formatUnits(position.debt, 18));
    const L = deleverageTarget;
    const baseSellValue = C - L * (C - D); // S = C(1-L) + LD
    if (baseSellValue <= 0) return position.maxWithdrawable;

    const P = Number(formatUnits(oraclePrice, 18));
    const baseSellTokens = baseSellValue / P;
    const decimals = vault.decimals > 6 ? 6 : vault.decimals;
    let baseSellBn: bigint;
    try { baseSellBn = parseUnits(baseSellTokens.toFixed(decimals), vault.decimals); } catch { return 0n; }

    const baseDebtRepaid = baseSellBn * oraclePrice / (10n ** BigInt(vault.decimals));

    const remainingCollateral = position.collateral > baseSellBn
      ? position.collateral - baseSellBn : 0n;
    const remainingDebt = position.debt > baseDebtRepaid
      ? position.debt - baseDebtRepaid : 0n;

    if (remainingDebt === 0n) return remainingCollateral;
    if (position.debt === 0n) return 0n;

    const minCollCurrent = position.collateral - position.maxWithdrawable;
    const minCollProjected = minCollCurrent * remainingDebt / position.debt;
    return remainingCollateral > minCollProjected ? remainingCollateral - minCollProjected : 0n;
  }, [position, oraclePrice, vault, deleverageTarget]);

  // Route info for deleverage (static, computed from state)
  const deleverageRouteInfo = useMemo((): RouteInfo | undefined => {
    if (activeMode !== "deleverage" || (deleverageCollateralToSell === 0n && withdrawAmountBn === 0n)) return undefined;
    const steps: RouteInfo["steps"] = [];
    if (deleverageCollateralToSell > 0n) {
      steps.push({
        tokenSymbol: vault.symbol,
        action: "Sell",
        description: "for crvUSD",
        protocol: "Enso Router",
        amount: Number(formatUnits(deleverageCollateralToSell, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }),
      });
      steps.push({
        tokenSymbol: "crvUSD",
        action: "Repay",
        description: "debt",
        protocol: "Curve LlamaLend",
        amount: Number(formatUnits(debtToRepay, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }),
      });
    }
    if (withdrawAmountBn > 0n) {
      const withdrawSymbol = isWithdrawToOtherToken ? withdrawToken!.symbol : vault.symbol;
      steps.push({
        tokenSymbol: withdrawSymbol,
        action: "Withdraw",
        description: isWithdrawToOtherToken ? `${vault.symbol} → ${withdrawSymbol} to wallet` : `${vault.symbol} to wallet`,
        protocol: isWithdrawToOtherToken ? "Enso Router" : "Curve LlamaLend",
        amount: isWithdrawToOtherToken && withdrawAmount
          ? `${Number(withdrawAmount).toLocaleString(undefined, { maximumFractionDigits: 4 })}`
          : Number(formatUnits(withdrawAmountBn, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }),
      });
    }
    return { steps };
  }, [activeMode, deleverageCollateralToSell, withdrawAmountBn, vault, debtToRepay, isWithdrawToOtherToken, withdrawToken]);

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
          const inputCollateral = collateralAmount ? parseUnits(collateralAmount, isCollateralToken ? vault.decimals : effectiveDecimals) : 0n;
          // Don't estimate health if user doesn't have enough balance
          if (inputCollateral > 0n && inputCollateral > effectiveBalance) {
            setEstimatedHealth(null);
            return;
          }
          // For non-collateral tokens, user's input gets swapped to collateral first
          const userAdditional = isCollateralToken
            ? (collateralAmount ? parseUnits(collateralAmount, vault.decimals) : 0n)
            : estimatedCollateralFromSwap;
          // Estimate collateral from the leverage swap: borrowed crvUSD → collateral token
          // collateralFromSwap ≈ debtAmount * 10^collDecimals / oraclePrice
          const collateralFromSwap = oraclePrice > 0n
            ? debtAmount * (10n ** BigInt(vault.decimals)) / oraclePrice
            : 0n;
          dCollateral = userAdditional + collateralFromSwap;
          dDebt = debtAmount;
        } else if (activeMode === "deleverage" && (deleverageCollateralToSell > 0n || withdrawAmountBn > 0n)) {
          dCollateral = -(deleverageCollateralToSell + withdrawAmountBn);
          dDebt = -debtToRepay;
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
  }, [publicClient, address, controllerAddress, activeMode, collateralAmount, debtAmount, vault.decimals, deleverageCollateralToSell, withdrawAmountBn, debtToRepay, effectiveBalance, effectiveDecimals, isCollateralToken, estimatedCollateralFromSwap, oraclePrice]);

  // Report estimated health to parent
  useEffect(() => {
    onEstimatedHealthChange?.(estimatedHealth);
  }, [estimatedHealth, onEstimatedHealthChange]);

  // Report debt delta to parent
  useEffect(() => {
    if (activeMode === "leverageUp" && debtAmount > 0n) {
      onDebtDeltaChange?.(debtAmount);
    } else if (activeMode === "deleverage" && debtToRepay > 0n) {
      onDebtDeltaChange?.(-debtToRepay);
    } else {
      onDebtDeltaChange?.(null);
    }
  }, [activeMode, debtAmount, debtToRepay, onDebtDeltaChange]);

  // Report collateral delta to parent
  useEffect(() => {
    if (activeMode === "leverageUp" && debtAmount > 0n) {
      // For non-collateral tokens, user's input gets swapped to collateral first
      const userAdditional = isCollateralToken
        ? (collateralAmount ? parseUnits(collateralAmount, vault.decimals) : 0n)
        : estimatedCollateralFromSwap;
      const collateralFromSwap = oraclePrice > 0n
        ? debtAmount * (10n ** BigInt(vault.decimals)) / oraclePrice
        : 0n;
      onCollateralDeltaChange?.(userAdditional + collateralFromSwap);
    } else if (activeMode === "deleverage" && (deleverageCollateralToSell > 0n || withdrawAmountBn > 0n)) {
      onCollateralDeltaChange?.(-(deleverageCollateralToSell + withdrawAmountBn));
    } else {
      onCollateralDeltaChange?.(null);
    }
  }, [activeMode, debtAmount, collateralAmount, vault.decimals, oraclePrice, isCollateralToken, estimatedCollateralFromSwap, deleverageCollateralToSell, withdrawAmountBn, onCollateralDeltaChange]);

  // Report estimated leverage to parent
  useEffect(() => {
    if (activeMode === "leverageUp" && debtAmount > 0n) {
      onEstimatedLeverageChange?.(effectiveLeverage);
    } else if (activeMode === "deleverage" && (deleverageCollateralToSell > 0n || withdrawAmountBn > 0n) && oraclePrice > 0n && position?.hasLoan) {
      const remainingColl = position.collateral - deleverageCollateralToSell - withdrawAmountBn;
      const collValue = Number(formatUnits(remainingColl * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
      const remainingDebt = Math.max(Number(formatUnits(position.debt - debtToRepay, 18)), 0);
      if (collValue > remainingDebt && collValue > 0) {
        onEstimatedLeverageChange?.(collValue / (collValue - remainingDebt));
      } else {
        onEstimatedLeverageChange?.(null);
      }
    } else {
      onEstimatedLeverageChange?.(null);
    }
  }, [activeMode, effectiveLeverage, debtAmount, deleverageCollateralToSell, withdrawAmountBn, debtToRepay, oraclePrice, position, vault.decimals, onEstimatedLeverageChange]);

  // Report tx state to parent for full-screen overlay
  useEffect(() => {
    if ((status === "waitingTx" || status === "success" || status === "reverted") && txHash) {
      const action = activeMode === "leverageUp" ? "Leverage Up" : activeMode === "deleverage" ? "Deleverage" : "Self Liquidate";
      let details: { fromAmount: string; fromSymbol: string; fromLogo: string; toAmount: string; toSymbol: string; toLogo: string } | undefined;
      if (activeMode === "leverageUp" && debtAmount > 0n) {
        // Leverage up: show collateral added (or existing) + new debt at Nx leverage
        details = {
          fromAmount: collateralAmount && Number(collateralAmount) > 0 ? collateralAmount : `${effectiveLeverage.toFixed(1)}x`,
          fromSymbol: collateralAmount && Number(collateralAmount) > 0 ? vault.symbol : "Leverage",
          fromLogo: vault.logo,
          toAmount: Number(formatUnits(debtAmount, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }),
          toSymbol: "crvUSD",
          toLogo: "/tokens/crvusd.png",
        };
      } else if (activeMode === "deleverage" && (deleverageCollateralToSell > 0n || withdrawAmountBn > 0n)) {
        const withdrawSymbol = isWithdrawToOtherToken ? withdrawToken.symbol : vault.symbol;
        const fromDesc = withdrawAmountBn > 0n
          ? `${Number(formatUnits(deleverageCollateralToSell, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} sold + ${Number(formatUnits(withdrawAmountBn, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} → ${withdrawSymbol}`
          : Number(formatUnits(deleverageCollateralToSell, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });
        details = {
          fromAmount: fromDesc,
          fromSymbol: vault.symbol,
          fromLogo: vault.logo,
          toAmount: debtToRepay > 0n ? Number(formatUnits(debtToRepay, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "~",
          toSymbol: "crvUSD repaid",
          toLogo: "/tokens/crvusd.png",
        };
      } else if (activeMode === "selfLiquidate") {
        details = {
          fromAmount: `${effectiveSelfLiqPercent}%`,
          fromSymbol: "Position",
          fromLogo: vault.logo,
          toAmount: "crvUSD",
          toSymbol: "recovered",
          toLogo: "/tokens/crvusd.png",
        };
      }
      const mapped = status === "waitingTx" ? "pending" : status;
      onTxStateChange?.({ status: mapped as "pending" | "success" | "reverted", action, hash: txHash, details });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- withdrawToken is only read inside deleverage branch; isWithdrawToOtherToken derived from it
  }, [status, txHash, activeMode, onTxStateChange, collateralAmount, debtAmount, deleverageCollateralToSell, withdrawAmountBn, debtToRepay, oraclePrice, effectiveSelfLiqPercent, vault, effectiveLeverage, withdrawToken]);

  // Check crvUSD gap for direct self-liquidation
  // tokens_to_liquidate with account=user → msg.sender=user → health_limit=0, f_remove=frac
  const [crvUsdGap, setCrvUsdGap] = useState(0n);
  const [userCrvUsdBalance, setUserCrvUsdBalance] = useState(0n);
  useEffect(() => {
    if (mode !== "selfLiquidate" || !publicClient || !address) {
      setCanDirectLiquidate(false);
      setCrvUsdGap(0n);
      return;
    }
    let stale = false;
    async function check() {
      try {
        const frac = BigInt(effectiveSelfLiqPercent) * 10n ** 16n;
        const [tokensNeeded, crvUsdBal] = await Promise.all([
          publicClient!.readContract({
            address: controllerAddress,
            abi: CONTROLLER_ABI,
            functionName: "tokens_to_liquidate",
            args: [address!, frac],
            account: address!, // msg.sender = user → health_limit=0, no discount
          }),
          publicClient!.readContract({
            address: CRVUSD_ADDRESS as `0x${string}`,
            abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const,
            functionName: "balanceOf",
            args: [address!],
          }),
        ]);
        if (stale) return;
        setCrvUsdGap(tokensNeeded as bigint);
        setUserCrvUsdBalance(crvUsdBal as bigint);
        // Can always direct-liquidate if user has enough crvUSD (or gap is 0)
        setCanDirectLiquidate((tokensNeeded as bigint) <= (crvUsdBal as bigint));
      } catch {
        if (!stale) {
          setCanDirectLiquidate(false);
          setCrvUsdGap(0n);
        }
      }
    }
    check();
    return () => { stale = true; };
  }, [mode, publicClient, address, controllerAddress, effectiveSelfLiqPercent]);

  // Handle transaction success — clear all inputs and reset to idle
  useEffect(() => {
    if (status === "success") {
      setCollateralAmountRaw("");
      setWithdrawAmount("");
      leverageFollowsBase.current = true;
      try { sessionStorage.removeItem(leverageStorageKey); } catch { /* */ }
      onTransactionSuccess();
      refetchBalance();
      reset();
    }
  }, [status, onTransactionSuccess, reset, refetchBalance, leverageStorageKey]);

  // Toast error messages to user
  useEffect(() => {
    if ((status === "error" || status === "reverted") && error) {
      if (isUserRejection(error)) {
        toast("Transaction cancelled", { id: "leverage-cancelled", duration: 3000 });
        clearError();
      } else {
        toast.error(error);
        reset();
      }
    }
  }, [status, error, reset, clearError]);

  // Handle approval success -> continue execution
  useEffect(() => {
    if (isApprovalSuccess && status === "approving") {
      executeAfterApproval();
    }
  }, [isApprovalSuccess, status, executeAfterApproval]);

  // Reset stale approval state when user changes inputs
  useEffect(() => {
    if (status === "needsApproval") {
      reset();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collateralAmount, leverage, selectedToken.address]);

  const handleSubmit = async () => {
    if (!address || !controllerAddress) return;

    const preview = showSimulationPreview;

    const openModalIfPreview = (result: unknown): boolean => {
      if (preview && result) {
        simulationBlock.current = currentBlock ?? 0n;
        setShowSimulationModal(true);
        if (publicClient) {
          publicClient.readContract({
            address: CHAINLINK_ETH_USD,
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
        // Modal opened — bail from handleSubmit
        return true;
      }
      // No simulation data (e.g. Anvil/test network) — fall through to execute directly
      return false;
    };

    try {
      if (activeMode === "leverageUp") {
        if (isCollateralToken) {
          // Existing Zapper path — loop leverage with collateral token
          const additionalCollateral = collateralAmount ? parseUnits(collateralAmount, vault.decimals) : 0n;
          if (preview) {
            const result = await leverageUpAction(controllerAddress, additionalCollateral, debtAmount, collateralToken, Number(slippage), true);
            if (openModalIfPreview(result)) return;
          }
          await leverageUpAction(controllerAddress, collateralAmount ? parseUnits(collateralAmount, vault.decimals) : 0n, debtAmount, collateralToken, Number(slippage), false);
        } else if (position?.hasLoan) {
          // ZapperV2 path — leverage up existing position from any token
          const inputAmount = collateralAmount ? parseUnits(collateralAmount, effectiveDecimals) : 0n;
          if (preview) {
            const result = await leverageUpFromTokenAction(controllerAddress, selectedToken.address as `0x${string}`, inputAmount, debtAmount, collateralToken, selectedToken.symbol, Number(slippage), true, effectiveDecimals);
            if (openModalIfPreview(result)) return;
          }
          await leverageUpFromTokenAction(controllerAddress, selectedToken.address as `0x${string}`, collateralAmount ? parseUnits(collateralAmount, effectiveDecimals) : 0n, debtAmount, collateralToken, selectedToken.symbol, Number(slippage), false, effectiveDecimals);
        } else {
          // ZapperV2 path — create new leveraged loan from any token
          const inputAmount = collateralAmount ? parseUnits(collateralAmount, effectiveDecimals) : 0n;
          if (preview) {
            const result = await createLeveragedLoanFromTokenAction(controllerAddress, selectedToken.address as `0x${string}`, inputAmount, debtAmount, positionBands, collateralToken, selectedToken.symbol, Number(slippage), true, effectiveDecimals);
            if (openModalIfPreview(result)) return;
          }
          await createLeveragedLoanFromTokenAction(controllerAddress, selectedToken.address as `0x${string}`, collateralAmount ? parseUnits(collateralAmount, effectiveDecimals) : 0n, debtAmount, positionBands, collateralToken, selectedToken.symbol, Number(slippage), false, effectiveDecimals);
        }
      } else if (activeMode === "deleverage") {
        if (isClosePosition) {
          // Close: sell all collateral via V1 deleverage
          if (preview) {
            const result = await deleverageAction(controllerAddress, position?.collateral ?? 0n, collateralToken, Number(slippage), true);
            if (openModalIfPreview(result)) return;
          }
          await deleverageAction(controllerAddress, position?.collateral ?? 0n, collateralToken, Number(slippage), false);
        } else if (withdrawAmountBn > 0n && isV2Available) {
          if (isWithdrawToOtherToken) {
            // Deleverage + withdraw as different token via V2
            if (preview) {
              const result = await deleverageAndWithdrawToTokenAction(controllerAddress, deleverageCollateralToSell, withdrawAmountBn, collateralToken, withdrawToken.address as `0x${string}`, withdrawToken.symbol, vault.symbol, Number(slippage), true);
              if (openModalIfPreview(result)) return;
            }
            await deleverageAndWithdrawToTokenAction(controllerAddress, deleverageCollateralToSell, withdrawAmountBn, collateralToken, withdrawToken.address as `0x${string}`, withdrawToken.symbol, vault.symbol, Number(slippage), false);
          } else {
            // Deleverage + withdraw as collateral via V2
            if (preview) {
              const result = await deleverageAndWithdrawAction(controllerAddress, deleverageCollateralToSell, withdrawAmountBn, collateralToken, Number(slippage), true);
              if (openModalIfPreview(result)) return;
            }
            await deleverageAndWithdrawAction(controllerAddress, deleverageCollateralToSell, withdrawAmountBn, collateralToken, Number(slippage), false);
          }
        } else {
          // Pure deleverage via V1
          if (preview) {
            const result = await deleverageAction(controllerAddress, deleverageCollateralToSell, collateralToken, Number(slippage), true);
            if (openModalIfPreview(result)) return;
          }
          await deleverageAction(controllerAddress, deleverageCollateralToSell, collateralToken, Number(slippage), false);
        }
      } else if (activeMode === "selfLiquidate") {
        // Direct self-liquidation only: user calls controller.liquidate directly
        // No health check, no liquidation fee (msg.sender == user)
        const percentage = BigInt(effectiveSelfLiqPercent) * 10n ** 16n;
        if (preview) {
          const result = await directLiquidateAction(controllerAddress, percentage, true, crvUsdGap);
          if (openModalIfPreview(result)) return;
        }
        await directLiquidateAction(controllerAddress, percentage, false, crvUsdGap);
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

  const isProcessing = status !== "idle" && status !== "success" && status !== "error" && status !== "reverted" && status !== "needsApproval";

  const quoteLoading = (activeMode === "leverageUp" && !isCollateralToken && swapQuoteLoading)
    || (activeMode === "deleverage" && isWithdrawToOtherToken && withdrawRate === 0 && withdrawAmount !== "");

  const getButtonText = () => {
    if (status === "building") return <>Building transaction<LoadingDots /></>;
    if (status === "simulating") return <>Simulating<LoadingDots /></>;
    if (status === "executing") return <>Confirm in wallet<LoadingDots /></>;
    if (status === "waitingTx") return <>Waiting for confirmation<LoadingDots /></>;
    if (quoteLoading && status === "idle") return <>Getting quote<LoadingDots /></>;
    if (activeMode === "leverageUp") return isCollateralToken ? "Leverage Up" : "Swap & Leverage Up";
    if (activeMode === "deleverage") {
      if (isClosePosition) return "Close Position";
      if (withdrawAmountBn > 0n && isWithdrawToOtherToken) return `Deleverage & Withdraw ${withdrawToken.symbol}`;
      if (withdrawAmountBn > 0n) return "Deleverage & Withdraw";
      return "Deleverage";
    }
    if (activeMode === "selfLiquidate") {
      if (!canDirectLiquidate && effectiveSelfLiqPercent > 0) return "Insufficient crvUSD";
      if (effectiveSelfLiqPercent === 100) return "Close Position";
      return `Self Liquidate ${effectiveSelfLiqPercent}%`;
    }
    return "Submit";
  };

  const isFormValid = () => {
    if (activeMode === "leverageUp") {
      // Must have debt AND user must have actually increased leverage or added collateral
      return debtAmount > 0n && (effectiveLeverage > baseLeverage + 0.005 || collateralAmount !== "");
    }
    if (activeMode === "deleverage") return position?.hasLoan === true && position.collateral > 0n && (deleverageCollateralToSell > 0n || withdrawAmountBn > 0n);
    if (activeMode === "selfLiquidate") {
      if (isUnderwater && !underwaterConfirmed) return false;
      return effectiveSelfLiqPercent > 0 && canDirectLiquidate;
    }
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
              onClick={() => { cancelLeverageAnim(); setSubTab("leverageUp"); reset(); setCollateralAmount(""); leverageFollowsBase.current = true; setLeverage(baseLeverage); setWithdrawAmount(""); setPendingYolo(false); setEstimatedHealth(null); setSelectedToken(vaultToken); }}
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
              onClick={() => { cancelLeverageAnim(); setSubTab("deleverage"); reset(); setCollateralAmount(""); leverageFollowsBase.current = true; setLeverage(baseLeverage); setWithdrawAmount(""); setWithdrawToken(null); setDeleverageTarget(currentLeverage); setDeleverageInput(currentLeverage.toFixed(2)); setPendingYolo(false); setEstimatedHealth(null); setSelectedToken(vaultToken); }}
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
                    Additional {isCollateralToken ? "Collateral" : "Input"} (optional)
                  </label>
                  <span className="text-xs text-[var(--muted-foreground)]">
                    Max: {isCollateralToken ? formattedBalance : effectiveFormattedBalance}
                  </span>
                </div>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
                  <input
                    type="text"
                    value={collateralAmount}
                    onChange={(e) => setCollateralAmount(e.target.value)}
                    placeholder="0.0"
                    className="flex-1 min-w-0 bg-transparent mono text-sm outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
                  />
                  <TokenSelector
                    selectedToken={selectedToken}
                    onSelect={(token) => { setSelectedToken(token); setCollateralAmount(""); }}
                    priorityTokens={[vaultToken]}
                    excludeDefiTokens
                  />
                  <MaxButton
                    balance={isCollateralToken ? formatUnits(userBalanceBn, vault.decimals) : (isEth && altTokenBalance?.value ? getMaxEthAmount(altTokenBalance.value, gasPrice) : formatUnits(effectiveBalance, effectiveDecimals))}
                    onSelect={setCollateralAmount}
                  />
                </div>
              </div>

              {/* At max leverage — show when slider can't be shown and user has entered collateral or position is at max */}
              {!showSlider && totalCollateral > 0n && !pendingYolo && maxBorrowableLoaded && (collateralAmount && Number(collateralAmount) > 0 || !position?.hasLoan || (position?.hasLoan && maxAdditionalBorrow < parseUnits("1", 18))) && (
                <div className="p-3 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/30 text-sm text-[var(--accent)] flex items-center gap-2">
                  <AlertTriangle size={16} className="shrink-0" />
                  <span>
                    At max leverage ({currentLeverage.toFixed(2)}x).
                    {collateralAmount && Number(collateralAmount) > 0
                      ? " Pool liquidity limits further leverage."
                      : effectiveBalance > 0n
                        ? " Add collateral above to increase borrowing capacity."
                        : " Select a token you hold to add collateral."}
                  </span>
                </div>
              )}

              {/* Leverage target slider */}
              {showSlider && (
                <div className={sliderLoading ? "opacity-50 pointer-events-none" : ""}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-[var(--muted-foreground)]">
                      Target Leverage
                    </label>
                    <div className="flex items-center gap-1 px-1.5 py-1 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
                      <input
                        type="text"
                        value={leverageInput}
                        onChange={(e) => {
                          setLeverageInput(e.target.value);
                          clearTimeout(leverageDebounce.current);
                          leverageDebounce.current = setTimeout(() => {
                            const v = parseFloat(e.target.value);
                            if (!isNaN(v)) {
                              leverageFollowsBase.current = false;
                              const clamped = Math.min(Math.max(v, baseLeverage), maxLeverage);
                              setLeverage(clamped);
                              setLeverageInput(clamped.toFixed(2));
                            }
                          }, 500);
                        }}
                        onFocus={() => { cancelLeverageAnim(); leverageInputFocused.current = true; }}
                        onBlur={() => {
                          leverageInputFocused.current = false;
                          const v = parseFloat(leverageInput);
                          if (!isNaN(v)) {
                            leverageFollowsBase.current = false;
                            const clamped = Math.min(Math.max(v, baseLeverage), maxLeverage);
                            setLeverage(clamped);
                            setLeverageInput(clamped.toFixed(2));
                          } else {
                            setLeverageInput(effectiveLeverage.toFixed(2));
                          }
                        }}
                        className="w-[3rem] bg-transparent text-right mono text-sm outline-none"
                      />
                      <span className="text-sm text-[var(--muted-foreground)] pointer-events-none">x</span>
                      <LeverageMaxButton
                        onMax={() => {
                          cancelLeverageAnim();
                          leverageFollowsBase.current = false;
                          animateLeverage(effectiveLeverage, maxLeverage, 300);
                        }}
                        onMaxAll={effectiveBalance > 0n ? () => {
                          cancelLeverageAnim();
                          leverageFollowsBase.current = false;
                          setCollateralAmount(formatUnits(effectiveBalance, effectiveDecimals));
                          yoloWaitSeq.current = calcMaxSeq;
                          setForceCalcMax(c => c + 1);
                          setPendingYolo(true);
                          // Start animation immediately with stale estimate — re-targeted when calcMax completes
                          animateLeverage(effectiveLeverage, maxLeverage > 1.15 ? maxLeverage : 3.0, 600);
                        } : undefined}
                        onReset={Math.round(effectiveLeverage * 100) !== sliderMin || collateralAmount !== "" ? () => {
                          const from = effectiveLeverage;
                          setPendingYolo(false);
                          leverageFollowsBase.current = false;
                          // Animate within CURRENT range first, then clear collateral after
                          // (clearing collateral shifts the range — slider min can exceed frozen max)
                          animateLeverage(from, baseLeverage, 300, () => {
                            leverageFollowsBase.current = true;
                            // Temporarily widen frozen max so slider min doesn't exceed max
                            // while calcMax is in-flight for the new collateral amount
                            stableMaxLevRef.current = 10;
                            setCollateralAmount("");
                          });
                        } : undefined}
                      />
                    </div>
                  </div>
                  <input
                    type="range"
                    min={baseLeverage}
                    max={renderMaxLeverage}
                    step="any"
                    value={effectiveLeverage}
                    onChange={(e) => { cancelLeverageAnim(); leverageFollowsBase.current = false; setLeverage(parseFloat(e.target.value)); }}
                    className="w-full"
                  />
                </div>
              )}

              {debtAmount > 0n && Number(formatUnits(debtAmount, 18)) >= 0.1 && (
                <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-2 text-sm">
                  {!isCollateralToken && collateralAmount && Number(collateralAmount) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Sending</span>
                      <span className="mono">
                        {Number(collateralAmount).toLocaleString(undefined, { maximumFractionDigits: 4 })} {selectedToken.symbol}
                      </span>
                    </div>
                  )}
                  {!isCollateralToken && estimatedCollateralFromSwap > 0n && (
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Depositing</span>
                      <span className="mono">
                        ~{Number(formatUnits(estimatedCollateralFromSwap, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {vault.symbol}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Borrowing</span>
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
              {/* Collateral to Withdraw (V2 only) */}
              {isV2Available && (
                <div className={isClosePosition ? "opacity-40 pointer-events-none" : ""}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-[var(--muted-foreground)]">
                      Withdraw {isWithdrawToOtherToken ? `as ${withdrawToken.symbol}` : ""} (optional)
                    </label>
                    <span className="text-xs text-[var(--muted-foreground)]">
                      {isWithdrawToOtherToken && withdrawRate === 0 && position?.hasLoan ? (
                        <>Max: <LoadingDots /></>
                      ) : (
                        <>Max: {(() => {
                          if (!position?.hasLoan) return "0";
                          const maxYcvxcrv = Number(formatUnits(stableMaxWithdrawable, vault.decimals));
                          if (isWithdrawToOtherToken && withdrawRate > 0) {
                            return (maxYcvxcrv / withdrawRate).toLocaleString(undefined, { maximumFractionDigits: 4 });
                          }
                          return maxYcvxcrv.toLocaleString(undefined, { maximumFractionDigits: 4 });
                        })()} {isWithdrawToOtherToken ? withdrawToken.symbol : vault.symbol}</>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
                    <input
                      type="text"
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                      placeholder="0.0"
                      className="flex-1 min-w-0 bg-transparent mono text-sm outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
                    />
                    <TokenSelector
                      selectedToken={withdrawToken ?? vaultToken}
                      onSelect={(token) => { setWithdrawToken(token.address.toLowerCase() === vault.address.toLowerCase() ? null : token); setWithdrawAmount(""); }}
                      priorityTokens={[vaultToken]}
                      excludeDefiTokens
                    />
                    <MaxButton
                      balance={(() => {
                        if (!position?.hasLoan) return "0";
                        if (isWithdrawToOtherToken && withdrawRate === 0) return "0";
                        const maxYcvxcrv = Number(formatUnits(stableMaxWithdrawable, vault.decimals));
                        if (isWithdrawToOtherToken && withdrawRate > 0) {
                          return (maxYcvxcrv / withdrawRate).toFixed(withdrawTokenDecimals > 8 ? 8 : withdrawTokenDecimals);
                        }
                        return formatUnits(stableMaxWithdrawable, vault.decimals);
                      })()}
                      onSelect={setWithdrawAmount}
                    />
                  </div>
                </div>
              )}

              {/* Target Leverage slider */}
              {position?.hasLoan && currentLeverage > 1.01 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-[var(--muted-foreground)]">
                      Target Leverage
                    </label>
                    <div className="flex items-center gap-1 px-1.5 py-1 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
                      <input
                        type="text"
                        value={deleverageInput}
                        onChange={(e) => {
                          setDeleverageInput(e.target.value);
                          clearTimeout(deleverageDebounce.current);
                          deleverageDebounce.current = setTimeout(() => {
                            const v = parseFloat(e.target.value);
                            if (!isNaN(v)) {
                              const clamped = Math.min(Math.max(v, 1.0), currentLeverage);
                              setDeleverageTarget(clamped);
                              setDeleverageInput(clamped.toFixed(2));
                              if (clamped <= 1.001) setWithdrawAmount("");
                            }
                          }, 500);
                        }}
                        onFocus={() => { cancelDeleverageAnim(); deleverageInputFocused.current = true; }}
                        onBlur={() => {
                          deleverageInputFocused.current = false;
                          const v = parseFloat(deleverageInput);
                          if (!isNaN(v)) {
                            const clamped = Math.min(Math.max(v, 1.0), currentLeverage);
                            setDeleverageTarget(clamped);
                            setDeleverageInput(clamped.toFixed(2));
                            if (clamped <= 1.001) setWithdrawAmount("");
                          } else {
                            setDeleverageInput(deleverageTarget.toFixed(2));
                          }
                        }}
                        className="w-[3rem] bg-transparent text-right mono text-sm outline-none"
                      />
                      <span className="text-sm text-[var(--muted-foreground)] pointer-events-none">x</span>
                      <DeleverageMinButton
                        onMin={() => {
                          cancelDeleverageAnim();
                          animateDeleverage(deleverageTarget, 1.01, 300);
                        }}
                        onClose={() => {
                          cancelDeleverageAnim();
                          animateDeleverage(deleverageTarget, 1.0, 300);
                          setWithdrawAmount("");
                        }}
                        onReset={deleverageTarget !== currentLeverage ? () => {
                          cancelDeleverageAnim();
                          animateDeleverage(deleverageTarget, currentLeverage, 300);
                        } : undefined}
                      />
                    </div>
                  </div>
                  <input
                    type="range"
                    min={1.0}
                    max={currentLeverage}
                    step="any"
                    value={deleverageTarget}
                    onChange={(e) => {
                      cancelDeleverageAnim();
                      const v = parseFloat(e.target.value);
                      setDeleverageTarget(v);
                      if (!deleverageInputFocused.current) setDeleverageInput(v.toFixed(2));
                      if (v <= 1.001) setWithdrawAmount("");
                    }}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-[var(--muted-foreground)] mt-1">
                    <span>1.00x (close loan)</span>
                    <span>{currentLeverage.toFixed(2)}x (current)</span>
                  </div>
                </div>
              )}

              {(deleverageCollateralToSell > 0n || withdrawAmountBn > 0n) && (
                <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-2 text-sm">
                  {deleverageCollateralToSell > 0n && (
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Selling</span>
                      <span className="mono">
                        {Number(formatUnits(deleverageCollateralToSell, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {vault.symbol}
                      </span>
                    </div>
                  )}
                  {debtToRepay > 0n && (
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Repaying</span>
                      <span className="mono">
                        ~{Number(formatUnits(debtToRepay, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD
                      </span>
                    </div>
                  )}
                  {withdrawAmountBn > 0n && (
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Withdrawing</span>
                      <span className="mono">
                        {isWithdrawToOtherToken
                          ? <>{withdrawAmount} {withdrawToken?.symbol}</>
                          : <>{Number(formatUnits(withdrawAmountBn, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {vault.symbol}</>
                        }
                      </span>
                    </div>
                  )}
                </div>
              )}

            </>
          )}
        </>
      )}

      {/* Self Liquidate */}
      {activeMode === "selfLiquidate" && (
        <>
          <div className={cn(
            "p-3 rounded-lg text-sm flex items-center gap-2",
            position?.health !== undefined && position.health <= 0
              ? "bg-red-500/10 border border-red-500/30 text-red-500"
              : "bg-yellow-500/10 border border-yellow-500/30 text-yellow-500"
          )}>
            <AlertTriangle size={16} className="shrink-0" />
            <div>
              <div className="font-medium">
                {position?.health !== undefined && position.health <= 0
                  ? "Position Underwater"
                  : "Soft Liquidation"}
              </div>
              <div className="text-xs mt-0.5">
                Withdraw collateral and close all or part of your position. Converted crvUSD covers debt — you pay any remaining gap from your wallet.{onSwitchTab && (
                  <> Use <button type="button" onClick={() => onSwitchTab("repay")} className="underline hover:text-yellow-300 transition-colors">Repay</button> to reduce debt while keeping your position open.</>
                )}
              </div>
            </div>
          </div>

          {/* AMM Breakdown */}
          {position?.hasLoan && (
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-[var(--muted-foreground)]">Collateral in AMM</span>
                <span className="mono">{Number(formatUnits(position.collateral, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {vault.symbol}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--muted-foreground)]">crvUSD in AMM</span>
                <span className="mono">{Number(formatUnits(position.stablecoin, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--muted-foreground)]">Debt</span>
                <span className="mono">{Number(formatUnits(position.debt, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD</span>
              </div>
              <div
                className="grid transition-[grid-template-rows] duration-300 ease-in-out"
                style={{ gridTemplateRows: crvUsdGap > 0n ? "1fr" : "0fr" }}
              >
                <div className="overflow-hidden space-y-1.5">
                  <div className="border-t border-[var(--border)] my-1" />
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">crvUSD gap (you provide)</span>
                    <span className="mono text-yellow-500">{Number(formatUnits(crvUsdGap, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--muted-foreground)]">Your crvUSD balance</span>
                    <span className={cn("mono", userCrvUsdBalance < crvUsdGap ? "text-red-500" : "text-green-500")}>
                      {Number(formatUnits(userCrvUsdBalance, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD
                    </span>
                  </div>
                  <div
                    className="grid transition-[grid-template-rows] duration-300 ease-in-out"
                    style={{ gridTemplateRows: userCrvUsdBalance < crvUsdGap ? "1fr" : "0fr" }}
                  >
                    <div className="overflow-hidden">
                      <div className="flex justify-between">
                        <span className="text-[var(--muted-foreground)]">Need</span>
                        <span className="mono text-red-500">
                          {Number(formatUnits(crvUsdGap > userCrvUsdBalance ? crvUsdGap - userCrvUsdBalance : 0n, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} more crvUSD
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-[var(--muted-foreground)]">
                Liquidation Amount
              </label>
            </div>
            {forceFullLiquidation ? (
              <div className="p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)]">
                <div className="mono text-lg">100%</div>
                <div className="text-xs text-[var(--muted-foreground)] mt-1">Full close required — no collateral remaining for partial liquidation.</div>
              </div>
            ) : (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
                <input
                  type="text"
                  inputMode="decimal"
                  value={selfLiqPercent || ""}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^0-9]/g, "");
                    if (raw === "") { setSelfLiqPercent(0); return; }
                    const v = Math.min(parseInt(raw, 10), 100);
                    setSelfLiqPercent(v);
                  }}
                  placeholder="0"
                  className="flex-1 min-w-0 bg-transparent mono text-lg outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
                />
                <span className="text-sm text-[var(--muted-foreground)] shrink-0 mr-1">%</span>
                <MaxButton
                  balance="100"
                  onSelect={(v) => {
                    const n = Math.round(parseFloat(v) || 0);
                    setSelfLiqPercent(Math.min(n, 100));
                  }}
                />
              </div>
            )}
          </div>

          {/* Underwater confirmation checkbox */}
          {isUnderwater && (
            <label className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={underwaterConfirmed}
                onChange={(e) => setUnderwaterConfirmed(e.target.checked)}
                className="mt-0.5 accent-red-500"
              />
              <span className="text-xs text-red-500">
                I understand I am paying to close a losing position and will not receive any collateral back.
              </span>
            </label>
          )}

        </>
      )}

      {/* Low liquidity warning */}
      {isLiquidityConstrained && maxBorrowable > 0n && activeMode === "leverageUp" && debtAmount > 0n && debtAmount >= maxBorrowable * 90n / 100n && (
        <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500 text-xs flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0" />
          <span>
            Only {Number(formatUnits(controllerCrvUsdBalance!, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })} crvUSD available in lending market. Max leverage is limited by pool liquidity, not your collateral.
          </span>
        </div>
      )}

      {/* Approval Flow */}
      <ApprovalCard
        show={showApprovalCard}
        pendingApproval={lastApprovalRef.current}
        approvalProgress={approvalProgress}
        decimals={vault.decimals}
        isApproving={isApproving}
        onApprove={(exact) => approve(exact)}
      />

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
          leverageMode={activeMode === "leverageUp"}
        />
      )}

      {/* Action Button */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: !showApprovalCard ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          {isClosePosition && activeMode === "deleverage" && deleverageInitialized.current && (
            <div className="mb-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500 text-xs flex items-center gap-2">
              <AlertTriangle size={14} className="shrink-0" />
              Sells all collateral, repays debt, returns remainder
            </div>
          )}
          <button
            onClick={() => {
              if (status === "error" || status === "reverted" || status === "success") {
                reset();
              } else if (simulationResult && !showSimulationModal && currentBlock === simulationBlock.current) {
                // Re-open cached simulation modal if same block
                setShowSimulationModal(true);
              } else if (!quoteLoading) {
                handleSubmit();
              }
            }}
            disabled={showApprovalCard || isProcessing || quoteLoading || (!isFormValid() && status === "idle")}
            className={cn(
              "w-full py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
              isProcessing || quoteLoading || (!isFormValid() && status === "idle")
                ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
            )}
          >
            {getButtonText()}
          </button>
        </div>
      </div>

      {/* Powered by Enso + Route toggle + Settings — hide for self-liquidation (no Enso involved) */}
      {activeMode !== "selfLiquidate" && (
      <div className="flex items-center justify-between pt-2">
        <a
          href="https://www.enso.build"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
        >
          <span>Powered by</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/enso.png"
            alt="Enso"
            width={14}
            height={14}
            className="rounded-sm"
          />
          <span className="font-medium">Enso</span>
        </a>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleRoute}
            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors p-1"
            title={showRoute ? "Hide route" : "Show route"}
          >
            {showRoute ? <RouteOff size={16} /> : <RouteIcon size={16} />}
          </button>
          <button
            onClick={() => setShowSlippageModal(true)}
            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors p-1"
            title="Slippage settings"
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
      </div>
      )}

      {/* Route details panel */}
      {(() => {
        const hasLeverageRoute = activeMode === "leverageUp" && !isCollateralToken && collateralAmount && Number(collateralAmount) > 0 && (swapRouteInfo || swapQuoteLoading);
        const hasDeleverageRoute = activeMode === "deleverage" && deleverageRouteInfo;
        const routeVisible = showRoute && (hasLeverageRoute || hasDeleverageRoute);
        return (
          <div
            className="grid transition-[grid-template-rows] duration-300 ease-in-out"
            style={{ gridTemplateRows: routeVisible ? "1fr" : "0fr" }}
          >
            <div className="overflow-hidden">
              <div className="pt-3 mt-3 border-t border-[var(--border)]">
                <div className="text-xs text-[var(--muted-foreground)] mb-2">
                  Route
                </div>
                {hasLeverageRoute && (
                  <RouteDisplay
                    routeInfo={swapRouteInfo}
                    inputSymbol={selectedToken.symbol}
                    outputSymbol={vault.symbol}
                    inputAmount={collateralAmount}
                    outputAmount={estimatedCollateralFromSwap > 0n ? Number(formatUnits(estimatedCollateralFromSwap, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }) : undefined}
                    isLoading={swapQuoteLoading}
                  />
                )}
                {hasDeleverageRoute && (
                  <RouteDisplay
                    routeInfo={deleverageRouteInfo}
                  />
                )}
              </div>
            </div>
          </div>
        );
      })()}

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
          refreshSimulationPreview();
        }}
        slippage={slippage}
        onSlippageChange={updateSlippage}
      />
    </div>
  );
}
