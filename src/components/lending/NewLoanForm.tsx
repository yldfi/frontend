"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { SlippageModal } from "@/components/SlippageModal";
import { SimulationModal } from "@/components/SimulationModal";
import { toast } from "sonner";
import { isUserRejection } from "@/lib/analytics";
import {
  Loader2,
  AlertTriangle,
  Route,
  RouteOff,
  ArrowRightLeft,
  Landmark,
  TrendingUp,
  Check,
  ExternalLink,
} from "lucide-react";
import { useAccount, usePublicClient, useBalance, useGasPrice, useBlockNumber } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { useQuery } from "@tanstack/react-query";
import type { VaultConfig } from "@/config/vaults";
import { useCurveLendingActions } from "@/hooks/useCurveLendingActions";
import { useZapperActions } from "@/hooks/useZapperActions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { TokenSelector } from "@/components/TokenSelector";
import { RouteDisplay } from "@/components/RouteDisplay";
import { MaxButton } from "@/components/MaxButton";
import { cn } from "@/lib/utils";
import { sanitizeAmount } from "@/lib/sanitize";
import { fetchRoute, fetchTokenPrices, ETH_ADDRESS } from "@/lib/enso";
import { CRVUSD_ADDRESS } from "@/lib/zapper";
import type { EnsoToken, EnsoRouteResponse } from "@/types/enso";

const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Controller ABI for health calculator + max_borrowable
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
] as const;

// ERC20 balanceOf ABI (for checking controller's available crvUSD)
const BALANCE_OF_ABI = [{
  name: "balanceOf",
  type: "function",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

// ERC4626 convertToAssets ABI
const ERC4626_CONVERT_ABI = [
  {
    name: "convertToAssets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
] as const;

function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="animate-bounce" style={{ animationDelay: "0ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "150ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "300ms", animationDuration: "600ms" }}>.</span>
    </span>
  );
}

// Combined MAX button with hover options: MAX ALL (above) + Reset (below)
function LeverageMaxButton({
  onMax,
  onMaxAll,
  onReset,
}: {
  onMax: () => void;
  onMaxAll?: () => void;
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

interface NewLoanFormProps {
  vault: VaultConfig;
  userBalance: string; // Vault token balance in wei
  controllerAddress: `0x${string}`;
  oraclePrice?: bigint; // AMM oracle price (collateral/crvUSD, 18 decimals)
  onTransactionSuccess: () => void;
  onEstimatedHealthChange?: (health: number | null) => void;
  onEstimatedLeverageChange?: (leverage: number | null) => void;
  onDebtDeltaChange?: (delta: bigint | null) => void;
  onCollateralAmountChange?: (amount: bigint | null) => void;
  onSettlingChange?: (settling: boolean) => void;
  onTxStateChange?: (state: { status: "pending" | "success" | "reverted"; action: string; hash: string; details?: { fromAmount: string; fromSymbol: string; fromLogo: string; toAmount: string; toSymbol: string; toLogo: string } } | null) => void;
  onBandsChange?: (bands: number) => void;
  defaultToken?: EnsoToken;
}

export function NewLoanForm({
  vault,
  userBalance,
  controllerAddress,
  oraclePrice,
  onTransactionSuccess,
  onEstimatedHealthChange,
  onEstimatedLeverageChange,
  onDebtDeltaChange,
  onCollateralAmountChange,
  onSettlingChange,
  onTxStateChange,
  onBandsChange,
  defaultToken,
}: NewLoanFormProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  // Default token for this vault
  const vaultToken: EnsoToken = useMemo(() => ({
    address: vault.address,
    chainId: 1,
    name: vault.name,
    symbol: vault.symbol,
    decimals: vault.decimals,
    logoURI: vault.logoSmall,
    type: "defi" as const,
  }), [vault]);

  // Loan / Leverage tab
  const [loanTab, setLoanTab] = useState<"loan" | "leverage">(() => {
    if (typeof window === "undefined") return "loan";
    try {
      const saved = localStorage.getItem("yldfi-newloan-tab");
      if (saved === "loan" || saved === "leverage") return saved;
    } catch { /* localStorage unavailable */ }
    return "loan";
  });

  // Output token (what user receives after borrowing crvUSD)
  const crvUsdToken: EnsoToken = useMemo(() => ({
    address: CRVUSD_ADDRESS,
    chainId: 1,
    name: "Curve USD",
    symbol: "crvUSD",
    decimals: 18,
    logoURI: "/tokens/crvusd.png",
    type: "base" as const,
  }), []);
  const [outputToken, setOutputToken] = useState<EnsoToken>(crvUsdToken);
  const hasOutputSwap = outputToken.address.toLowerCase() !== CRVUSD_ADDRESS.toLowerCase();

  // Token selection
  const [selectedToken, setSelectedTokenState] = useState<EnsoToken>(defaultToken ?? vaultToken);
  const isVaultToken =
    selectedToken.address.toLowerCase() === vault.address.toLowerCase();

  // Form state
  const [amount, setAmountState] = useState("");
  const setAmount = useCallback((v: string) => setAmountState(sanitizeAmount(v)), []);
  const [debtInput, setDebtInputState] = useState("");
  const debtRatio = useRef<number | null>(null); // ratio of debt to maxBorrowable (0-1)
  const setDebtInput = useCallback((v: string) => {
    setDebtInputState(sanitizeAmount(v));
    debtRatio.current = null; // will be recalculated in effect
  }, []);
  const [bands, setBands] = useState(10);
  const debouncedBands = useDebouncedValue(bands, 400);
  useEffect(() => { onBandsChange?.(bands); }, [bands, onBandsChange]);

  // Smooth bands animation (YOLO snaps to 4, RESET back to 10)
  const bandsAnimRef = useRef<number | null>(null);
  const cancelBandsAnim = useCallback(() => {
    if (bandsAnimRef.current !== null) {
      cancelAnimationFrame(bandsAnimRef.current);
      bandsAnimRef.current = null;
    }
  }, []);
  const animateBands = useCallback((from: number, to: number, duration: number, onComplete?: () => void) => {
    cancelBandsAnim();
    const startTime = performance.now();
    function tick(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
      const value = Math.round(from + (to - from) * eased);
      setBands(value);
      if (progress < 1) {
        bandsAnimRef.current = requestAnimationFrame(tick);
      } else {
        bandsAnimRef.current = null;
        onComplete?.();
      }
    }
    bandsAnimRef.current = requestAnimationFrame(tick);
  }, [cancelBandsAnim]);
  useEffect(() => () => cancelBandsAnim(), [cancelBandsAnim]);


  // Leverage (always-on for vault tokens, slider at 1.0x = no leverage)
  const [leverage, setLeverage] = useState(1.0);
  const [leverageInput, setLeverageInput] = useState(leverage.toFixed(2));
  const leverageInputFocused = useRef(false);
  const leverageDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leverageFollowsBase = useRef(true); // true = leverage tracks 1.0 (no debt); false = user explicitly set it
  const leverageAnimRef = useRef<number | null>(null);
  const [pendingYolo, setPendingYolo] = useState(false);
  const [calcMaxSeq, setCalcMaxSeq] = useState(0);
  const yoloWaitSeq = useRef(0);
  const [forceCalcMax, setForceCalcMax] = useState(0);
  const [maxBorrowableLoaded, setMaxBorrowableLoaded] = useState(false);

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

  // Slippage
  const [rateInverted, setRateInverted] = useState(false);
  const [slippage, setSlippage] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("yldfi-slippage") || "50";
    }
    return "50";
  });
  const [showSlippageModal, setShowSlippageModal] = useState(false);

  // Simulation
  const [showSimulationPreview, setShowSimulationPreview] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("yldfi-show-simulation") === "true";
    }
    return false;
  });
  const [showSimulationModal, setShowSimulationModal] = useState(false);
  const [ethPrice, setEthPrice] = useState<number | null>(null);
  const { data: gasPrice } = useGasPrice();
  const { data: currentBlock } = useBlockNumber({ watch: true });
  const simulationBlock = useRef<bigint>(0n);

  // Route display toggle
  const [showRoute, setShowRoute] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("yldfi-lending-show-route") !== "false";
    }
    return true;
  });

  const updateSlippage = useCallback((value: string) => {
    setSlippage(value);
    if (typeof window !== "undefined") {
      localStorage.setItem("yldfi-slippage", value);
    }
  }, []);

  const toggleRoute = useCallback(() => {
    setShowRoute((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        localStorage.setItem("yldfi-lending-show-route", String(next));
      }
      return next;
    });
  }, []);

  // Health estimation
  const [estimatedHealth, setEstimatedHealth] = useState<number | null>(null);

  // Lending actions (for direct create_loan + swap create_loan)
  const lendingActions = useCurveLendingActions();
  const {
    createLoan,
    createLoanWithSwap,
    createLoanWithOutputSwap,
    pendingApproval: lendingPendingApproval,
    approve: lendingApprove,
    isApproving: lendingIsApproving,
    isApprovalSuccess: lendingIsApprovalSuccess,
    executeAfterApproval: lendingExecuteAfterApproval,
    status: lendingStatus,
    txHash: lendingTxHash,
    error: lendingError,
    simulationResult: lendingSimulationResult,
    reset: lendingReset,
    clearError: lendingClearError,
    executeAfterPreview: lendingExecuteAfterPreview,
  } = lendingActions;

  // Zapper actions (for leveraged create)
  const zapperActions = useZapperActions();
  const {
    createLeveragedLoan,
    createLeveragedLoanFromToken,
    pendingApproval: zapperPendingApproval,
    approvalProgress,
    approve: zapperApprove,
    isApproving: zapperIsApproving,
    isApprovalSuccess: zapperIsApprovalSuccess,
    executeAfterApproval: zapperExecuteAfterApproval,
    status: zapperStatus,
    txHash: zapperTxHash,
    error: zapperError,
    simulationResult: zapperSimulationResult,
    reset: zapperReset,
    executeAfterPreview: zapperExecuteAfterPreview,
  } = zapperActions;

  // Derived: which action system is active
  // Zapper loop leverage: leverage tab + collateral token, OR leverage tab + non-collateral (ZapperV2)
  // Loan tab with non-collateral: Enso swap bundle
  // Loan tab with collateral: direct controller
  const isLeveraged = loanTab === "leverage";
  const status = isLeveraged ? zapperStatus : lendingStatus;
  const txHash = isLeveraged ? zapperTxHash : lendingTxHash;
  const error = isLeveraged ? zapperError : lendingError;
  const simulationResult = isLeveraged ? zapperSimulationResult : lendingSimulationResult;
  const pendingApproval = isLeveraged ? zapperPendingApproval : lendingPendingApproval;
  const isApproving = isLeveraged ? zapperIsApproving : lendingIsApproving;
  const reset = isLeveraged ? zapperReset : lendingReset;

  // Preserve last approval data so content stays in DOM during close animation
  const lastApprovalRef = useRef(pendingApproval);
  if (pendingApproval) lastApprovalRef.current = pendingApproval;
  const showApprovalCard = !!(pendingApproval && (status === "needsApproval" || status === "approving"));

  // Track which approval button was clicked (spinner only on that button)
  const [approvingType, setApprovingType] = useState<"exact" | "unlimited" | "single" | null>(null);
  useEffect(() => {
    if (!isApproving) setApprovingType(null);
  }, [isApproving]);

  // Switch between Loan and Leverage tabs
  const switchTab = useCallback((tab: "loan" | "leverage") => {
    setLoanTab(tab);
    try { localStorage.setItem("yldfi-newloan-tab", tab); } catch { /* */ }
    lendingReset();
    zapperReset();
    setShowSimulationModal(false);
    if (tab === "loan") {
      cancelLeverageAnim();
      leverageFollowsBase.current = true;
      setLeverage(1.0);
      setPendingYolo(false);
    } else {
      setDebtInputState("");
      setOutputToken(crvUsdToken); // Reset output token when switching to leverage
    }
  }, [lendingReset, zapperReset, cancelLeverageAnim]);

  // Read selected token balance
  const isEth = selectedToken.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const { data: tokenBalance, refetch: refetchBalance } = useBalance({
    address,
    token: isEth ? undefined : (selectedToken.address as `0x${string}`),
    query: { enabled: !!address },
  });

  const maxBalance = useMemo(() => {
    if (isVaultToken) {
      return formatUnits(BigInt(userBalance), vault.decimals);
    }
    return tokenBalance?.formatted ?? "0";
  }, [isVaultToken, userBalance, vault.decimals, tokenBalance]);

  const currentTokenBalance = isVaultToken
    ? BigInt(userBalance)
    : (tokenBalance?.value ?? 0n);

  const formattedBalance = useMemo(() => {
    const value = parseFloat(maxBalance) || 0;
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }, [maxBalance]);

  // Debounced amount for quotes
  const debouncedAmount = useDebouncedValue(amount, 500);
  const needsSwap = !isVaultToken;

  // Swap quote: tokenIn → vaultToken
  const {
    data: swapQuote,
    isLoading: swapQuoteLoading,
    isFetching: swapQuoteFetching,
    isPlaceholderData: swapQuoteIsPlaceholder,
  } = useQuery({
    queryKey: [
      "new-loan-swap-quote",
      selectedToken.address,
      vault.address,
      debouncedAmount,
      slippage,
      address,
    ],
    queryFn: async (): Promise<EnsoRouteResponse> => {
      if (!address) throw new Error("No address");
      const amountWei = parseUnits(debouncedAmount, selectedToken.decimals).toString();
      if (process.env.NODE_ENV === "development") console.log("[NewLoan] Swap quote request:", { tokenIn: selectedToken.symbol, tokenOut: vault.symbol, amount: debouncedAmount });
      const result = await fetchRoute({
        fromAddress: address,
        tokenIn: selectedToken.address,
        tokenOut: vault.address,
        amountIn: amountWei,
        slippage,
      });
      if (process.env.NODE_ENV === "development") console.log("[NewLoan] Swap quote result:", { amountOut: result.amountOut, gas: result.gas });
      return result;
    },
    enabled:
      needsSwap &&
      !!address &&
      !!debouncedAmount &&
      Number(debouncedAmount) > 0,
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1,
    placeholderData: (prev) => prev,
  });

  // Output swap: reverse quote (outputToken → crvUSD) to determine how much crvUSD to borrow
  // User enters desired output token amount; quote tells us the crvUSD debt needed
  const debouncedDebtInput = useDebouncedValue(debtInput, 500);
  const {
    data: outputSwapQuote,
    isLoading: outputSwapQuoteLoading,
  } = useQuery({
    queryKey: [
      "new-loan-output-swap-quote",
      outputToken.address,
      debouncedDebtInput,
      slippage,
      address,
    ],
    queryFn: async (): Promise<EnsoRouteResponse> => {
      if (!address) throw new Error("No address");
      const amountWei = parseUnits(debouncedDebtInput, outputToken.decimals).toString();
      if (process.env.NODE_ENV === "development") console.log("[NewLoan] Output swap quote request:", { tokenIn: outputToken.symbol, tokenOut: "crvUSD", amount: debouncedDebtInput });
      const result = await fetchRoute({
        fromAddress: address,
        tokenIn: outputToken.address,
        tokenOut: CRVUSD_ADDRESS,
        amountIn: amountWei,
        slippage,
      });
      if (process.env.NODE_ENV === "development") console.log("[NewLoan] Output swap quote result:", { amountOut: result.amountOut, gas: result.gas });
      return result;
    },
    enabled:
      hasOutputSwap &&
      loanTab === "loan" &&
      !!address &&
      !!debouncedDebtInput &&
      Number(debouncedDebtInput) > 0,
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1,
  });

  // Estimated crvUSD debt when using output swap (derived from reverse quote)
  const estimatedCrvUsdDebt = useMemo(() => {
    if (!hasOutputSwap || !outputSwapQuote?.amountOut) return null;
    return BigInt(outputSwapQuote.amountOut);
  }, [hasOutputSwap, outputSwapQuote]);

  const quoteLoading = needsSwap && swapQuoteLoading;

  // Swap quote details visibility: show when we have data + input > 0
  const swapQuoteVisible = !!(needsSwap && swapQuote && amount && Number(amount) > 0);

  // Whether the swap quote values are stale (refetching or input changed)
  const swapQuoteStale = swapQuoteFetching || (!!amount && amount !== debouncedAmount);

  // Estimated vault token amount from swap (for health calculation + max_borrowable)
  const estimatedVaultTokenAmount = useMemo(() => {
    if (isVaultToken) {
      if (!amount || Number(amount) <= 0) return null;
      try {
        return parseUnits(amount, vault.decimals);
      } catch {
        return null;
      }
    }
    if (swapQuote?.amountOut) {
      return BigInt(swapQuote.amountOut);
    }
    return null;
  }, [isVaultToken, amount, vault.decimals, swapQuote]);

  // Exchange rate (live value — may be inconsistent during placeholder data)
  const exchangeRateLive = useMemo(() => {
    if (!swapQuote?.amountOut || !debouncedAmount || Number(debouncedAmount) === 0)
      return null;
    const outFormatted = Number(formatUnits(BigInt(swapQuote.amountOut), vault.decimals));
    return outFormatted / Number(debouncedAmount);
  }, [swapQuote, debouncedAmount, vault.decimals]);

  // Price impact dependencies
  const priceTokenAddress = useMemo(
    () => (isEth ? WETH_ADDRESS : selectedToken.address),
    [isEth, selectedToken.address]
  );
  const { data: tokenPrices } = useQuery({
    queryKey: ["new-loan-token-prices", priceTokenAddress, vault.assetAddress],
    queryFn: () => fetchTokenPrices([priceTokenAddress, vault.assetAddress]),
    enabled: needsSwap,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const vaultTokenAmountForPricing = useMemo(() => {
    if (!needsSwap || !swapQuote?.amountOut) return null;
    return BigInt(swapQuote.amountOut);
  }, [needsSwap, swapQuote]);

  const { data: underlyingEquivalent } = useQuery({
    queryKey: ["new-loan-underlying-eq", vault.address, vaultTokenAmountForPricing?.toString()],
    queryFn: async () => {
      if (!publicClient || !vaultTokenAmountForPricing) throw new Error("Missing");
      const result = await publicClient.readContract({
        address: vault.address as `0x${string}`,
        abi: ERC4626_CONVERT_ABI,
        functionName: "convertToAssets",
        args: [vaultTokenAmountForPricing],
      });
      return result.toString();
    },
    enabled: needsSwap && !!publicClient && vaultTokenAmountForPricing !== null && vaultTokenAmountForPricing > 0n,
    staleTime: 30_000,
  });

  // Price impact (live value)
  const priceImpactLive = useMemo(() => {
    if (quoteLoading) return null;
    if (!debouncedAmount || Number(debouncedAmount) <= 0) return null;
    if (!swapQuote?.amountOut) return null;
    if (!tokenPrices || tokenPrices.length < 2) return null;
    if (!underlyingEquivalent) return null;

    const selectedPrice = tokenPrices.find(
      (p) => p.address.toLowerCase() === priceTokenAddress.toLowerCase()
    )?.price;
    const underlyingPrice = tokenPrices.find(
      (p) => p.address.toLowerCase() === vault.assetAddress.toLowerCase()
    )?.price;
    if (!selectedPrice || !underlyingPrice) return null;

    const underlyingAmount = Number(formatUnits(BigInt(underlyingEquivalent), vault.assetDecimals));
    const inputUsd = Number(debouncedAmount) * selectedPrice;
    const outputUsd = underlyingAmount * underlyingPrice;
    if (inputUsd === 0) return null;
    return ((inputUsd - outputUsd) / inputUsd) * 100;
  }, [quoteLoading, debouncedAmount, swapQuote, tokenPrices, underlyingEquivalent, priceTokenAddress, vault.assetAddress, vault.assetDecimals]);

  // Snapshot: freeze all display values when quote is fully resolved, use snapshot otherwise.
  // "Fully resolved" means the quote is fresh AND all async dependencies (including underlyingEquivalent
  // for price impact) have loaded. This prevents momentary disappearance of price impact when
  // the swap quote arrives but underlyingEquivalent hasn't loaded yet for the new amountOut.
  const swapDisplaySnapshot = useRef<{ amountOut: string; exchangeRate: number; priceImpact: number | null } | null>(null);
  const isFreshQuote = !swapQuoteStale && !swapQuoteIsPlaceholder && !!swapQuote?.amountOut;
  const isFullyResolved = isFreshQuote && exchangeRateLive !== null && priceImpactLive !== null;
  if (isFullyResolved) {
    swapDisplaySnapshot.current = {
      amountOut: swapQuote.amountOut,
      exchangeRate: exchangeRateLive,
      priceImpact: priceImpactLive,
    };
  }
  if (!needsSwap) swapDisplaySnapshot.current = null;

  // Use live values only when fully resolved; otherwise fall back to snapshot
  const displayAmountOut = isFullyResolved ? swapQuote.amountOut : swapDisplaySnapshot.current?.amountOut ?? swapQuote?.amountOut;
  const exchangeRate = isFullyResolved ? exchangeRateLive : (swapDisplaySnapshot.current?.exchangeRate ?? exchangeRateLive);
  const priceImpact = isFullyResolved ? priceImpactLive : (swapDisplaySnapshot.current?.priceImpact ?? priceImpactLive);

  // Max borrowable for the estimated collateral
  const [maxBorrowable, setMaxBorrowable] = useState<bigint>(0n);
  const [maxBorrowableFetching, setMaxBorrowableFetching] = useState(false);
  const maxBorrowableBandsRef = useRef<number>(10); // tracks which debouncedBands produced current maxBorrowable

  useEffect(() => {
    let stale = false;
    // Don't reset maxBorrowableLoaded — keep old max visible until new arrives
    // to prevent button flicker between "Create Loan" and "Exceeds max borrowable"
    async function calcMax() {
      if (!publicClient || !estimatedVaultTokenAmount) {
        setMaxBorrowable(0n);
        setMaxBorrowableLoaded(true);
        setMaxBorrowableFetching(false);
        setCalcMaxSeq(s => s + 1);
        return;
      }
      setMaxBorrowableFetching(true);
      let max = 0n;
      try {
        max = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "max_borrowable",
          args: [estimatedVaultTokenAmount, BigInt(debouncedBands)],
        });
        if (stale) return;
        if (process.env.NODE_ENV === "development") console.log("[NewLoan] max_borrowable:", { max: max.toString(), bands: debouncedBands, collateral: estimatedVaultTokenAmount.toString() });
      } catch (err) {
        if (stale) return;
        if (process.env.NODE_ENV === "development") console.log("[NewLoan] max_borrowable error:", err);
      }
      // Batch: update maxBorrowable AND adjust debt together to avoid
      // a render where old debt > new max (which causes button flicker)
      setMaxBorrowable(max);
      setMaxBorrowableFetching(false);
      maxBorrowableBandsRef.current = debouncedBands;
      if (max > 0n && debtRatio.current !== null && loanTab === "loan" && !hasOutputSwap) {
        const ratio = Math.min(debtRatio.current, 1.0);
        // Scale using bigint math then truncate string to 2dp — avoids floating point rounding past max
        const scaled = max * BigInt(Math.floor(ratio * 10000)) / 10000n;
        const str = formatUnits(scaled, 18);
        const dot = str.indexOf(".");
        setDebtInputState(dot === -1 ? str : str.slice(0, dot + 3));
      }
      setMaxBorrowableLoaded(true);
      setCalcMaxSeq(s => s + 1);
    }
    calcMax();
    return () => { stale = true; };
  }, [publicClient, controllerAddress, estimatedVaultTokenAmount, debouncedBands, forceCalcMax]); // eslint-disable-line react-hooks/exhaustive-deps

  // Controller's available crvUSD — detects when pool liquidity is the borrowing constraint
  const { data: controllerCrvUsdBalance } = useQuery({
    queryKey: ["controller-crvusd-balance", controllerAddress],
    queryFn: async () => {
      if (!publicClient) throw new Error("No client");
      return publicClient.readContract({
        address: CRVUSD_ADDRESS as `0x${string}`,
        abi: BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [controllerAddress],
      });
    },
    enabled: !!publicClient,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // True when pool liquidity caps borrowing (maxBorrowable ≈ controller balance)
  const isLiquidityConstrained = useMemo(() => {
    if (!controllerCrvUsdBalance || maxBorrowable === 0n) return false;
    // If max borrowable is within 5% of controller balance, liquidity is the bottleneck
    const threshold = controllerCrvUsdBalance * 105n / 100n;
    return maxBorrowable <= threshold;
  }, [controllerCrvUsdBalance, maxBorrowable]);

  // Max receivable in output token terms (forward quote: maxBorrowable crvUSD → outputToken)
  const maxBorrowableStr = useMemo(
    () => (maxBorrowable > 0n ? maxBorrowable.toString() : null),
    [maxBorrowable]
  );
  const { data: maxOutputTokenEquivalent, isFetching: maxOutputTokenFetching } = useQuery({
    queryKey: [
      "new-loan-max-output-token",
      outputToken.address,
      maxBorrowableStr,
      address,
    ],
    queryFn: async () => {
      if (!address || !maxBorrowableStr) throw new Error("Missing params");
      if (process.env.NODE_ENV === "development") console.log("[NewLoan] Max output token quote request:", { tokenOut: outputToken.symbol, maxCrvUSD: formatUnits(BigInt(maxBorrowableStr), 18) });
      const quote = await fetchRoute({
        fromAddress: address,
        tokenIn: CRVUSD_ADDRESS,
        tokenOut: outputToken.address,
        amountIn: maxBorrowableStr,
        slippage: "300", // wider slippage for max estimate
      });
      if (!quote?.amountOut) return null;
      // Apply 1% haircut for forward/reverse AMM spread
      const haircut = BigInt(quote.amountOut) * 99n / 100n;
      const result = formatUnits(haircut, outputToken.decimals);
      if (process.env.NODE_ENV === "development") console.log("[NewLoan] Max output token quote result:", { maxOutput: result, outputToken: outputToken.symbol });
      return result;
    },
    enabled:
      hasOutputSwap &&
      loanTab === "loan" &&
      !!address &&
      maxBorrowable > 0n,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });

  // Track debt ratio: capture when debtInput changes, adjust when maxBorrowable changes
  // Skip when output swap is active (debtInput is in output token units, not crvUSD)
  const prevMaxBorrowable = useRef<bigint>(0n);
  useEffect(() => {
    if (loanTab !== "loan" || maxBorrowable === 0n || hasOutputSwap) return;
    // If maxBorrowable changed and we have a ratio, adjust the input
    if (prevMaxBorrowable.current !== 0n && prevMaxBorrowable.current !== maxBorrowable && debtRatio.current !== null) {
      const ratio = Math.min(debtRatio.current, 1.0);
      // Scale using bigint math then truncate string to 2dp — avoids floating point rounding past max
      const scaled = maxBorrowable * BigInt(Math.floor(ratio * 10000)) / 10000n;
      const str = formatUnits(scaled, 18);
      const dot = str.indexOf(".");
      setDebtInputState(dot === -1 ? str : str.slice(0, dot + 3));
    }
    // Capture current ratio from debtInput
    if (debtInput && Number(debtInput) > 0) {
      try {
        const debtWei = parseUnits(debtInput, 18);
        debtRatio.current = Number(debtWei) / Number(maxBorrowable);
      } catch {
        debtRatio.current = null;
      }
    } else {
      debtRatio.current = null;
    }
    prevMaxBorrowable.current = maxBorrowable;
  }, [maxBorrowable, debtInput, loanTab, hasOutputSwap]);

  // Track receive ratio for output swap mode: scale debtInput (output token units)
  // proportionally when maxOutputTokenEquivalent changes (due to bands/collateral changes)
  const receiveRatio = useRef<number | null>(null);
  const prevMaxOutputToken = useRef<string | null>(null);
  useEffect(() => {
    if (!hasOutputSwap || loanTab !== "loan" || !maxOutputTokenEquivalent) return;
    // maxOutputTokenEquivalent changed — scale debtInput proportionally
    if (prevMaxOutputToken.current !== null && prevMaxOutputToken.current !== maxOutputTokenEquivalent && receiveRatio.current !== null) {
      const ratio = Math.min(receiveRatio.current, 1.0);
      const maxNum = Number(maxOutputTokenEquivalent);
      const scaled = maxNum * ratio;
      // Format to 4 decimal places
      const str = scaled.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
      setDebtInputState(str);
    }
    // Capture current ratio
    if (debtInput && Number(debtInput) > 0 && Number(maxOutputTokenEquivalent) > 0) {
      receiveRatio.current = Number(debtInput) / Number(maxOutputTokenEquivalent);
    } else {
      receiveRatio.current = null;
    }
    prevMaxOutputToken.current = maxOutputTokenEquivalent;
  }, [maxOutputTokenEquivalent, debtInput, hasOutputSwap, loanTab]);

  // Max leverage — uses oracle price to convert collateral to crvUSD value,
  // plus loop adjustment (borrowed crvUSD → swap → more collateral → more borrowing)
  const maxLeverage = useMemo(() => {
    if (!estimatedVaultTokenAmount || maxBorrowable === 0n || !oraclePrice || oraclePrice === 0n) return 5;
    try {
      if (estimatedVaultTokenAmount === 0n) return 5;
      const collValue = Number(formatUnits(estimatedVaultTokenAmount * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
      if (collValue <= 0) return 5;
      // Loop adjustment: r = LTV ratio, loopMaxD = maxBorrowable / (1 - r), with 0.2% safety margin
      const r = Number(formatUnits(maxBorrowable, 18)) / collValue;
      const loopMaxD = r < 0.99 ? Number(formatUnits(maxBorrowable, 18)) / (1 - r) * 0.998 : Number(formatUnits(maxBorrowable, 18));
      return Math.min(Math.max(1 + loopMaxD / collValue, 1.0), 10);
    } catch {
      return 5;
    }
  }, [estimatedVaultTokenAmount, maxBorrowable, vault.decimals, oraclePrice]);

  // effectiveLeverage: when user hasn't touched slider → 1.0 (no leverage)
  const effectiveLeverage = leverageFollowsBase.current ? 1.0 : leverage;

  // Anti-flash: stable maxLeverage for slider rendering
  const isAnimating = leverageAnimRef.current !== null;
  const shouldFreezeMax = (isAnimating && !pendingYolo) || bandsAnimRef.current !== null;
  const stableMaxLevRef = useRef(maxLeverage);
  if (maxBorrowableLoaded && !shouldFreezeMax) {
    // Only allow max to decrease naturally (safer bands = less leverage available).
    // Max increases only on explicit user interaction (MAX button, YOLO, slider drag)
    // to prevent bands changes from visually shifting the leverage thumb position.
    if (maxLeverage <= stableMaxLevRef.current) {
      stableMaxLevRef.current = maxLeverage;
    }
  }
  const renderMaxLeverage = stableMaxLevRef.current;

  // Slider visibility: show as soon as user enters collateral (even before maxBorrowable loads)
  const sliderMin = 100; // 1.0x always for new loans
  const sliderVisibleRef = useRef(false);
  const hasCollateral = !!estimatedVaultTokenAmount;
  const sliderCondition = maxBorrowable > 0n && Math.floor(renderMaxLeverage * 100) > sliderMin;
  const showSlider = pendingYolo || isAnimating || (maxBorrowableLoaded ? sliderCondition : (sliderVisibleRef.current || hasCollateral));
  if (maxBorrowableLoaded && !isAnimating) sliderVisibleRef.current = sliderCondition;

  // Debt amount (wei)
  const debtAmount = useMemo(() => {
    if (loanTab === "leverage") {
      // Leverage tab: calculate debt from leverage ratio
      // debt = collateralValue_in_crvUSD * (leverage - 1)
      if (!estimatedVaultTokenAmount || effectiveLeverage <= 1 || !oraclePrice || oraclePrice === 0n) return 0n;
      const collValue = estimatedVaultTokenAmount * oraclePrice / (10n ** BigInt(vault.decimals));
      const leverageFraction = Math.floor((effectiveLeverage - 1) * 10000);
      const rawDebt = collValue * BigInt(leverageFraction) / 10000n;
      // Loop-adjusted cap: borrowed crvUSD swaps to more collateral, enabling further borrowing
      const collValueNum = Number(formatUnits(collValue, 18));
      const r = collValueNum > 0 ? Number(formatUnits(maxBorrowable, 18)) / collValueNum : 0;
      const singleStepMax = Number(formatUnits(maxBorrowable, 18));
      const loopMaxD = r < 0.99 ? singleStepMax / (1 - r) * 0.998 : singleStepMax;
      const loopMaxWei = parseUnits(loopMaxD.toFixed(6), 18);
      if (rawDebt > loopMaxWei) {
        return loopMaxWei;
      }
      return rawDebt;
    }
    // Loan tab: manual debt input
    if (!debtInput || Number(debtInput) <= 0) return 0n;
    // When output swap is active, debtInput is in output token units — use reverse quote for crvUSD
    if (hasOutputSwap && estimatedCrvUsdDebt) {
      return estimatedCrvUsdDebt;
    }
    try {
      return parseUnits(debtInput, 18);
    } catch {
      return 0n;
    }
  }, [loanTab, estimatedVaultTokenAmount, effectiveLeverage, maxBorrowable, debtInput, hasOutputSwap, estimatedCrvUsdDebt, oraclePrice, vault.decimals]);

  // Leverage swap quote: crvUSD → vaultToken (for route display amount)
  const debouncedDebtAmount = useDebouncedValue(debtAmount > 0n ? formatUnits(debtAmount, 18) : "", 500);
  const {
    data: leverageSwapQuote,
    isPending: leverageSwapPending,
    isFetching: leverageSwapFetching,
    isPlaceholderData: leverageSwapIsPlaceholder,
  } = useQuery({
    queryKey: [
      "new-loan-leverage-swap-quote",
      vault.address,
      debouncedDebtAmount,
      slippage,
      address,
    ],
    queryFn: async (): Promise<EnsoRouteResponse> => {
      if (!address) throw new Error("No address");
      const debtWei = parseUnits(debouncedDebtAmount, 18).toString();
      if (process.env.NODE_ENV === "development") console.log("[NewLoan] Leverage swap quote request:", { tokenIn: "crvUSD", tokenOut: vault.symbol, debtAmount: debouncedDebtAmount });
      const result = await fetchRoute({
        fromAddress: address,
        tokenIn: CRVUSD_ADDRESS,
        tokenOut: vault.address,
        amountIn: debtWei,
        slippage,
      });
      if (process.env.NODE_ENV === "development") console.log("[NewLoan] Leverage swap quote result:", { amountOut: result.amountOut, gas: result.gas });
      return result;
    },
    enabled:
      loanTab === "leverage" &&
      effectiveLeverage > 1.005 &&
      !!address &&
      !!debouncedDebtAmount &&
      Number(debouncedDebtAmount) > 0,
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1,
    placeholderData: (prev) => prev,
  });

  // Clamp leverage to valid range when maxLeverage changes
  // Note: we do NOT clamp leverage > maxLeverage here because debtAmount already
  // caps at maxBorrowable (line 701). This avoids the jarring UX where changing
  // bands drags the leverage slider down. The slider max attribute naturally
  // prevents dragging past the limit on subsequent interactions.
  useEffect(() => {
    if (pendingYolo || !maxBorrowableLoaded || leverageAnimRef.current !== null) return;
    if (leverageFollowsBase.current) {
      if (Math.abs(leverage - 1.0) > 0.001) setLeverage(1.0);
      return;
    }
    if (leverage < 1.0) setLeverage(1.0);
  }, [maxLeverage, pendingYolo, maxBorrowableLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // YOLO: re-target animation once calcMax completes with real maxLeverage
  useEffect(() => {
    if (!pendingYolo) return;
    if (calcMaxSeq > yoloWaitSeq.current && maxBorrowableLoaded) {
      if (maxBorrowable > 0n) {
        leverageFollowsBase.current = false;
        stableMaxLevRef.current = maxLeverage; // expand slider range for YOLO
        animateLeverage(leverage, maxLeverage, 200, () => setPendingYolo(false));
      } else {
        cancelLeverageAnim();
        setPendingYolo(false);
      }
    }
  }, [pendingYolo, calcMaxSeq, maxBorrowable, maxBorrowableLoaded, maxLeverage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync text input when effective leverage changes (not while user is typing)
  useEffect(() => {
    if (!leverageInputFocused.current) {
      setLeverageInput(effectiveLeverage.toFixed(2));
    }
  }, [effectiveLeverage]);

  // Output swap settling: true when any part of the async chain is in flight
  // (slider moving → calcMax → forward quote → debtInput debounce → reverse quote)
  // Also covers collateral input swap quote when both swaps are active
  const outputSwapIsSettling = hasOutputSwap && (
    bands !== debouncedBands || debouncedBands !== maxBorrowableBandsRef.current || maxOutputTokenFetching || debtInput !== debouncedDebtInput || outputSwapQuoteLoading
  );
  const isQuoteSettling = outputSwapIsSettling || (!isVaultToken && quoteLoading);

  // Leverage route settling: true when any part of the leverage async chain is in flight
  // (YOLO pending → maxBorrowable calc → leverage animation → debt debounce → swap quote)
  const debtAmountStr = debtAmount > 0n ? formatUnits(debtAmount, 18) : "";
  const leverageIsSettling = loanTab === "leverage" && (
    pendingYolo ||
    leverageAnimRef.current !== null ||
    (effectiveLeverage > 1.005 && (debtAmountStr !== debouncedDebtAmount || leverageSwapFetching))
  );

  // Memoize route steps — only update when all data is settled
  const routeSteps = useMemo(() => [
    ...(needsSwap && swapQuote ? [{
      tokenSymbol: selectedToken.symbol,
      amount: amount ? Number(amount).toLocaleString(undefined, { maximumFractionDigits: 4 }) : undefined,
      action: "Swap" as const,
      description: `for ${vault.symbol}`,
      protocol: "Enso Router",
    }] : []),
    {
      tokenSymbol: vault.symbol,
      amount: estimatedVaultTokenAmount
        ? Number(formatUnits(estimatedVaultTokenAmount, vault.decimals)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : undefined,
      action: "Deposit as Collateral" as const,
      protocol: "Curve LlamaLend",
    },
    ...(debtAmount > 0n ? [{
      tokenSymbol: "crvUSD",
      amount: Number(formatUnits(debtAmount, 18)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      action: "Borrow" as const,
      protocol: "Curve LlamaLend",
    }] : []),
    ...(loanTab === "leverage" && effectiveLeverage > 1.005 && debtAmount > 0n ? [{
      tokenSymbol: vault.symbol,
      amount: leverageSwapQuote?.amountOut
        ? Number(formatUnits(BigInt(leverageSwapQuote.amountOut), vault.decimals)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : undefined,
      action: "Swap" as const,
      description: "from crvUSD",
      protocol: "Enso Router",
    }] : []),
    ...(hasOutputSwap ? [{
      tokenSymbol: outputToken.symbol,
      amount: debtInput
        ? Number(debtInput).toLocaleString(undefined, { maximumFractionDigits: 4 })
        : undefined,
      action: "Swap" as const,
      description: "from crvUSD",
      protocol: "Enso Router",
    }] : []),
  ], [needsSwap, swapQuote, selectedToken.symbol, amount, vault.symbol, vault.decimals, estimatedVaultTokenAmount, debtAmount, loanTab, effectiveLeverage, leverageSwapQuote, hasOutputSwap, outputToken?.symbol, debtInput]);

  // Lock route display during settling — avoid showing partial/mismatched values
  // Initialize empty so the route panel doesn't open until all data is ready
  const settledRouteRef = useRef<typeof routeSteps>([]);
  const anySettling = isQuoteSettling || leverageIsSettling;

  // Report settling state to parent (for health bar animation)
  const prevSettling = useRef(false);
  useEffect(() => {
    if (anySettling !== prevSettling.current) {
      prevSettling.current = anySettling;
      onSettlingChange?.(anySettling);
    }
  }, [anySettling, onSettlingChange]);

  if (!anySettling && routeSteps.length > 0) {
    settledRouteRef.current = routeSteps;
  }
  // During settling: show previous settled route (or nothing if no previous)
  const displayRouteSteps = anySettling
    ? settledRouteRef.current
    : routeSteps;

  // Estimate health — skip during settling to avoid stale intermediate values
  useEffect(() => {
    if (isQuoteSettling || leverageIsSettling) {
      setEstimatedHealth(null); // clear stale health so it doesn't flash old value when settling ends
      return;
    }
    let cancelled = false;
    async function calcHealth() {
      if (!publicClient || !address || !estimatedVaultTokenAmount || debtAmount === 0n) {
        setEstimatedHealth(null);
        return;
      }

      try {
        // For leverage: total collateral = user input + collateral from swap
        // ONLY use the real swap quote — no oracle fallback — to avoid health jumping
        let totalCollateral = estimatedVaultTokenAmount;
        if (loanTab === "leverage" && debtAmount > 0n) {
          if (!leverageSwapQuote?.amountOut || leverageSwapIsPlaceholder) {
            // No swap quote yet or stale placeholder — don't estimate health (it will jump)
            setEstimatedHealth(null);
            return;
          }
          totalCollateral = estimatedVaultTokenAmount + BigInt(leverageSwapQuote.amountOut);
        }

        const health = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "health_calculator",
          args: [
            address,
            totalCollateral,
            debtAmount,
            true,
            BigInt(debouncedBands),
          ],
        });

        if (!cancelled) {
          const h = Number(health) / 1e16;
          if (process.env.NODE_ENV === "development") console.log("[NewLoan] health_calculator:", { health: h.toFixed(2) + "%", collateral: estimatedVaultTokenAmount.toString(), debt: debtAmount.toString(), bands: debouncedBands });
          setEstimatedHealth(h);
        }
      } catch (err) {
        if (!cancelled) {
          if (process.env.NODE_ENV === "development") console.log("[NewLoan] health_calculator error:", err);
          setEstimatedHealth(null);
        }
      }
    }

    calcHealth();
    return () => { cancelled = true; };
  }, [publicClient, address, controllerAddress, estimatedVaultTokenAmount, debtAmount, debouncedBands, isQuoteSettling, leverageIsSettling, loanTab, leverageSwapQuote, leverageSwapIsPlaceholder, oraclePrice, vault.decimals]);

  // Report estimated health to parent (null if exceeds max borrowable)
  const exceedsBorrow = debtAmount > 0n && maxBorrowableLoaded && maxBorrowable > 0n && debtAmount > maxBorrowable;
  const healthToReport = (isQuoteSettling || leverageIsSettling) ? undefined : (exceedsBorrow ? null : estimatedHealth);
  const prevHealthReport = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (healthToReport === undefined) return; // settling — keep parent's old value
    if (healthToReport === prevHealthReport.current) return;
    prevHealthReport.current = healthToReport;
    onEstimatedHealthChange?.(healthToReport);
  }, [healthToReport, onEstimatedHealthChange]);

  // Report collateral amount to parent (for position summary display)
  // For leverage mode, include the leverage swap collateral (borrowed crvUSD → collateral)
  const collateralToReport = useMemo(() => {
    if (isQuoteSettling || !estimatedVaultTokenAmount) return null;
    if (loanTab === "leverage" && debtAmount > 0n) {
      // During leverage settling, use oracle estimate for collateral to keep the panel visible
      // (the actual swap quote will update this when settling completes)
      const swapCollateral = leverageSwapQuote?.amountOut
        ? BigInt(leverageSwapQuote.amountOut)
        : (oraclePrice && oraclePrice > 0n
          ? debtAmount * (10n ** BigInt(vault.decimals)) / oraclePrice
          : 0n);
      return estimatedVaultTokenAmount + swapCollateral;
    }
    return estimatedVaultTokenAmount;
  }, [isQuoteSettling, estimatedVaultTokenAmount, loanTab, debtAmount, leverageSwapQuote, oraclePrice, vault.decimals]);

  const prevCollateralReport = useRef<bigint | null>(null);
  useEffect(() => {
    if (collateralToReport === prevCollateralReport.current) return;
    prevCollateralReport.current = collateralToReport;
    onCollateralAmountChange?.(collateralToReport);
  }, [collateralToReport, onCollateralAmountChange]);

  // Report estimated leverage to parent
  // leverage = collateralValue / (collateralValue - debt)
  // Uses total collateral (deposit + leverage swap output), not just the deposit
  const leverageToReport = useMemo(() => {
    if (isQuoteSettling || leverageIsSettling || !collateralToReport || debtAmount === 0n || !oraclePrice || oraclePrice === 0n) return null;
    const collValue = Number(formatUnits(collateralToReport * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
    const debt = Number(formatUnits(debtAmount, 18));
    if (collValue <= 0 || collValue <= debt) return null;
    const lev = collValue / (collValue - debt);
    return lev > 1.005 ? lev : null;
  }, [isQuoteSettling, leverageIsSettling, collateralToReport, debtAmount, oraclePrice, vault.decimals]);

  const prevLeverageReport = useRef<number | null>(null);
  useEffect(() => {
    if (leverageToReport === prevLeverageReport.current) return;
    prevLeverageReport.current = leverageToReport;
    onEstimatedLeverageChange?.(leverageToReport);
  }, [leverageToReport, onEstimatedLeverageChange]);

  // Report debt delta to parent (for projected borrow APR calculation)
  const debtDeltaToReport = useMemo(() => {
    if (isQuoteSettling || debtAmount === 0n) return null;
    return debtAmount;
  }, [isQuoteSettling, debtAmount]);

  const prevDebtDeltaReport = useRef<bigint | null>(null);
  useEffect(() => {
    if (debtDeltaToReport === prevDebtDeltaReport.current) return;
    prevDebtDeltaReport.current = debtDeltaToReport;
    onDebtDeltaChange?.(debtDeltaToReport);
  }, [debtDeltaToReport, onDebtDeltaChange]);

  // Report tx state to parent for full-screen overlay
  useEffect(() => {
    if ((status === "waitingTx" || status === "success" || status === "reverted") && txHash) {
      // Determine output token details
      const toAmount = hasOutputSwap && debtInput
        ? Number(debtInput).toLocaleString(undefined, { maximumFractionDigits: 4 })
        : Number(formatUnits(debtAmount, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
      const toSymbol = hasOutputSwap ? outputToken.symbol : "crvUSD";
      const toLogo = hasOutputSwap ? (outputToken.logoURI || "/tokens/unknown.png") : "/tokens/crvusd.png";

      const details = amount && Number(amount) > 0 && debtAmount > 0n ? {
        fromAmount: amount,
        fromSymbol: selectedToken.symbol,
        fromLogo: selectedToken.logoURI || "/tokens/unknown.png",
        toAmount,
        toSymbol,
        toLogo,
      } : undefined;
      const mapped = status === "waitingTx" ? "pending" : status;
      onTxStateChange?.({ status: mapped as "pending" | "success" | "reverted", action: "Create Loan", hash: txHash, details });
    }
  }, [status, txHash, onTxStateChange, amount, selectedToken, debtAmount, hasOutputSwap, outputToken, outputSwapQuote]);

  // Handle transaction success
  useEffect(() => {
    if (status === "success" && txHash) {
      toast.success("Loan created!", {
        action: {
          label: "View Tx",
          onClick: () => window.open(`https://etherscan.io/tx/${txHash}`, "_blank"),
        },
      });
      onTransactionSuccess();
      refetchBalance();
      reset();
    }
  }, [status, txHash, onTransactionSuccess, reset, refetchBalance]);

  useEffect(() => {
    if ((status === "error" || status === "reverted") && error) {
      if (isUserRejection(error)) {
        toast("Transaction cancelled", { id: "new-loan-cancelled", duration: 3000 });
        if (isLeveraged) {
          zapperReset();
        } else {
          lendingClearError();
        }
      } else {
        toast.error(error);
        reset();
      }
    }
  }, [status, error, reset, isLeveraged, zapperReset, lendingClearError]);

  // Clear simulation/approval state when inputs change
  useEffect(() => {
    if (simulationResult || status === "needsApproval") {
      reset();
      setShowSimulationModal(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, debtInput, selectedToken.address, outputToken.address, effectiveLeverage, bands, loanTab]);

  // Handle approval success
  const handleSubmitRef = useRef<(() => Promise<void>) | undefined>(undefined);
  useEffect(() => {
    if (isLeveraged) {
      if (zapperIsApprovalSuccess && zapperStatus === "approving") {
        zapperExecuteAfterApproval();
      }
    } else {
      if (lendingIsApprovalSuccess && lendingStatus === "approving") {
        if (isVaultToken) {
          lendingExecuteAfterApproval();
        } else {
          handleSubmitRef.current?.();
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lendingIsApprovalSuccess, lendingStatus, zapperIsApprovalSuccess, zapperStatus]);

  // Clear amounts synchronously when switching token (avoids stale-data flash in RouteDisplay)
  const setSelectedToken = useCallback((token: EnsoToken) => {
    setSelectedTokenState(token);
    setAmountState("");
    setDebtInputState("");
    debtRatio.current = null;
    receiveRatio.current = null;
    lendingReset();
    zapperReset();
  }, [lendingReset, zapperReset]);

  // Reset leverage when collateral is cleared
  useEffect(() => {
    if (!amount || Number(amount) <= 0) {
      cancelLeverageAnim();
      leverageFollowsBase.current = true;
      setLeverage(1.0);
      setLeverageInput("1.00");
      setPendingYolo(false);
    }
  }, [amount, cancelLeverageAnim]);

  const fetchEthPrice = useCallback(async () => {
    if (!publicClient) return;
    try {
      const data = await publicClient.readContract({
        address: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
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
      });
      setEthPrice(Number(data[1] as bigint) / 1e8);
    } catch { /* ignore */ }
  }, [publicClient]);

  const handleSubmit = async () => {
    if (!address || !controllerAddress || !amount || Number(amount) <= 0 || debtAmount === 0n) return;

    const preview = showSimulationPreview;

    // Show simulation modal if preview result is available; returns true to bail from handleSubmit
    const openModalIfPreview = (result: unknown): boolean => {
      if (preview) {
        if (result) {
          simulationBlock.current = currentBlock ?? 0n;
          setShowSimulationModal(true);
          fetchEthPrice();
          return true;
        }
        // No simulation data (e.g. Anvil/test network) — fall through to execute directly
        return false;
      }
      return false;
    };

    try {
      if (loanTab === "leverage" && isVaultToken) {
        // Leverage tab + collateral token → existing Zapper loop
        if (process.env.NODE_ENV === "development") console.log("[NewLoan] Submit: leveraged loan (vault token)", { collateral: amount, debt: debtAmount.toString(), leverage: effectiveLeverage.toFixed(2), bands });
        const collateralWei = parseUnits(amount, vault.decimals);
        if (preview) {
          const result = await createLeveragedLoan(controllerAddress, collateralWei, debtAmount, bands, vault.address as `0x${string}`, Number(slippage), true);
          if (openModalIfPreview(result)) return;
        }
        await createLeveragedLoan(controllerAddress, parseUnits(amount, vault.decimals), debtAmount, bands, vault.address as `0x${string}`, Number(slippage), false);
      } else if (loanTab === "leverage" && !isVaultToken) {
        // Leverage tab + non-collateral → ZapperV2 FromToken loop
        if (process.env.NODE_ENV === "development") console.log("[NewLoan] Submit: leveraged loan (swap)", { token: selectedToken.symbol, amount, debt: debtAmount.toString(), leverage: effectiveLeverage.toFixed(2), bands });
        const inputWei = parseUnits(amount, selectedToken.decimals);
        if (preview) {
          const result = await createLeveragedLoanFromToken(controllerAddress, selectedToken.address as `0x${string}`, inputWei, debtAmount, bands, vault.address as `0x${string}`, selectedToken.symbol, Number(slippage), true);
          if (openModalIfPreview(result)) return;
        }
        await createLeveragedLoanFromToken(controllerAddress, selectedToken.address as `0x${string}`, parseUnits(amount, selectedToken.decimals), debtAmount, bands, vault.address as `0x${string}`, selectedToken.symbol, Number(slippage), false);
      } else if (hasOutputSwap) {
        // Loan tab + output swap → create_loan + swap crvUSD to output token
        if (process.env.NODE_ENV === "development") console.log("[NewLoan] Submit: borrow & swap", { token: selectedToken.symbol, amount, debt: debtAmount.toString(), outputToken: outputToken.symbol, bands });
        if (preview) {
          const result = await createLoanWithOutputSwap(vault.address as `0x${string}`, isVaultToken ? undefined : selectedToken.address, amount, debtAmount.toString(), bands, outputToken.address, Number(slippage), { previewOnly: true, tokenSymbol: isVaultToken ? vault.symbol : selectedToken.symbol });
          if (openModalIfPreview(result)) return;
        }
        await createLoanWithOutputSwap(vault.address as `0x${string}`, isVaultToken ? undefined : selectedToken.address, amount, debtAmount.toString(), bands, outputToken.address, Number(slippage), { tokenSymbol: isVaultToken ? vault.symbol : selectedToken.symbol });
      } else if (isVaultToken) {
        // Loan tab + collateral token → direct controller create_loan
        if (process.env.NODE_ENV === "development") console.log("[NewLoan] Submit: create_loan (direct)", { collateral: amount, debt: debtAmount.toString(), bands });
        if (preview) {
          const result = await createLoan(vault.address as `0x${string}`, amount, debtAmount.toString(), bands, { previewOnly: true, tokenSymbol: vault.symbol });
          if (openModalIfPreview(result)) return;
        }
        await createLoan(vault.address as `0x${string}`, amount, debtAmount.toString(), bands, { tokenSymbol: vault.symbol });
      } else {
        // Loan tab + non-collateral → Enso swap + create_loan
        if (process.env.NODE_ENV === "development") console.log("[NewLoan] Submit: swap & create_loan", { token: selectedToken.symbol, amount, debt: debtAmount.toString(), bands });
        if (preview) {
          const result = await createLoanWithSwap(vault.address as `0x${string}`, selectedToken.address, amount, debtAmount.toString(), bands, Number(slippage), { previewOnly: true, tokenSymbol: selectedToken.symbol });
          if (openModalIfPreview(result)) return;
        }
        await createLoanWithSwap(vault.address as `0x${string}`, selectedToken.address, amount, debtAmount.toString(), bands, Number(slippage), { tokenSymbol: selectedToken.symbol });
      }
    } catch (err) {
      console.error("Create loan failed:", err);
    }
  };
  handleSubmitRef.current = handleSubmit;

  const handleExecute = async () => {
    try {
      if (isLeveraged) {
        await zapperExecuteAfterPreview();
      } else {
        await lendingExecuteAfterPreview();
      }
    } catch (err) {
      console.error("Loan execution failed:", err);
    }
  };

  // Validation
  const hasInsufficientBalance = useMemo(() => {
    if (!amount || Number(amount) === 0) return false;
    try {
      const amountWei = parseUnits(amount, isVaultToken ? vault.decimals : selectedToken.decimals);
      return amountWei > currentTokenBalance;
    } catch {
      return false;
    }
  }, [amount, isVaultToken, vault.decimals, selectedToken.decimals, currentTokenBalance]);

  const exceedsMaxBorrowable = useMemo(() => {
    if (debtAmount === 0n || maxBorrowable === 0n || !maxBorrowableLoaded) return false;
    // Leverage tab uses loop-adjusted cap (debtAmount already capped at loopMaxWei),
    // so single-step maxBorrowable is not the right limit
    if (loanTab === "leverage") return false;
    return debtAmount > maxBorrowable;
  }, [debtAmount, maxBorrowable, maxBorrowableLoaded, loanTab]);

  const isProcessing =
    status !== "idle" &&
    status !== "success" &&
    status !== "error" &&
    status !== "reverted" &&
    status !== "needsApproval";

  const isFormValid =
    !!amount &&
    Number(amount) > 0 &&
    debtAmount > 0n &&
    !hasInsufficientBalance &&
    !exceedsMaxBorrowable &&
    !isQuoteSettling &&
    !leverageIsSettling &&
    (isVaultToken || swapQuote !== undefined) &&
    (!hasOutputSwap || outputSwapQuote !== undefined);

  const getButtonText = () => {
    if (status === "building") return <>Building transaction<LoadingDots /></>;
    if (status === "simulating") return <>Simulating<LoadingDots /></>;
    if (status === "executing") return <>Confirm in wallet<LoadingDots /></>;
    if (status === "waitingTx") return <>Waiting for confirmation<LoadingDots /></>;
    if (hasInsufficientBalance) return "Insufficient balance";
    if (!amount || Number(amount) <= 0) return "Enter amount";
    if (needsSwap && (!estimatedVaultTokenAmount || amount !== debouncedAmount || swapQuoteIsPlaceholder)) return <><span>Getting quote</span><LoadingDots /></>;
    if (maxBorrowableFetching) return <><span>Getting max borrowable</span><LoadingDots /></>;
    if (loanTab !== "leverage" && (!debtInput || Number(debtInput) <= 0)) return "Enter amount";
    if (loanTab === "leverage" && debtAmount <= 0n) return "Increase leverage";
    if (isQuoteSettling || leverageIsSettling) return <><span>Getting quote</span><LoadingDots /></>;
    if (exceedsMaxBorrowable) return "Exceeds max borrowable";

    if (loanTab === "leverage") {
      return isVaultToken ? "Create Leveraged Loan" : "Swap & Leverage";
    }
    if (hasOutputSwap) {
      return isVaultToken ? "Borrow & Swap" : "Swap, Borrow & Swap";
    }
    return isVaultToken ? "Create Loan" : "Swap & Create Loan";
  };

  return (
    <div className="space-y-4">
      {/* Collateral Input + Token Selector */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-[var(--muted-foreground)]">
            Collateral
          </label>
          <span className="text-xs text-[var(--muted-foreground)]">
            Balance: {formattedBalance}
          </span>
        </div>
        <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            className="flex-1 min-w-0 bg-transparent mono text-sm outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
          />
          <TokenSelector
            selectedToken={selectedToken}
            onSelect={setSelectedToken}
            priorityTokens={[vaultToken]}
            excludeDefiTokens
          />
          <MaxButton
            balance={maxBalance}
            onSelect={setAmount}
          />
        </div>

        {/* Swap quote details — animated via grid row transition, spinner overlay during refetch */}
        <div
          className="grid transition-[grid-template-rows] duration-300 ease-in-out"
          style={{ gridTemplateRows: swapQuoteVisible ? "1fr" : "0fr" }}
        >
          <div className="overflow-hidden">
            {swapQuote && (
              <div className="pt-4">
                <div className="relative p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-2 text-sm">
                  {/* Loading dots overlay when stale */}
                  {swapQuoteStale && (
                    <div className="absolute inset-0 flex items-center justify-center z-10">
                      <span className="inline-flex items-center gap-1 text-[var(--muted-foreground)] text-2xl">
                        <span className="animate-bounce" style={{ animationDelay: "0ms", animationDuration: "600ms" }}>.</span>
                        <span className="animate-bounce" style={{ animationDelay: "150ms", animationDuration: "600ms" }}>.</span>
                        <span className="animate-bounce" style={{ animationDelay: "300ms", animationDuration: "600ms" }}>.</span>
                      </span>
                    </div>
                  )}
                  <div className={cn("space-y-2 transition-opacity duration-200", swapQuoteStale && "opacity-0")}>
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Collateral after swap</span>
                      <span className="mono">
                        {displayAmountOut
                          ? <>~{Number(formatUnits(BigInt(displayAmountOut), vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {vault.symbol}</>
                          : "—"
                        }
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-[var(--muted-foreground)]">Rate</span>
                      {exchangeRate !== null ? (
                        <button
                          type="button"
                          onClick={() => setRateInverted(v => !v)}
                          className="flex items-center gap-1 mono hover:text-[var(--accent)] transition-colors"
                        >
                          {rateInverted
                            ? <>1 {vault.symbol} = {(1 / exchangeRate).toLocaleString(undefined, { maximumFractionDigits: 4 })} {selectedToken.symbol}</>
                            : <>1 {selectedToken.symbol} = {exchangeRate.toLocaleString(undefined, { maximumFractionDigits: 4 })} {vault.symbol}</>
                          }
                          <ArrowRightLeft size={12} className="text-[var(--muted-foreground)]" />
                        </button>
                      ) : (
                        <span className="mono">—</span>
                      )}
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Price Impact</span>
                      {priceImpact !== null ? (
                        <span className={cn(
                          "mono",
                          priceImpact <= 0 ? "text-green-500" : priceImpact < 3 ? "text-yellow-500" : "text-red-500"
                        )}>
                          {priceImpact > 0 ? "" : "+"}{(-priceImpact).toFixed(2)}%
                        </span>
                      ) : (
                        <span className="mono">—</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Loan / Leverage toggle */}
      <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--muted)] border border-[var(--border)]">
        <button
          onClick={() => switchTab("loan")}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium transition-colors",
            loanTab === "loan"
              ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          )}
        >
          <Landmark size={14} />
          Loan
        </button>
        <button
          onClick={() => switchTab("leverage")}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium transition-colors",
            loanTab === "leverage"
              ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          )}
        >
          <TrendingUp size={14} />
          Leverage
        </button>
      </div>

      {/* Leverage Slider (leverage tab, any token) */}
      {loanTab === "leverage" && (() => {
        const leverageDisabled = !amount || Number(amount) <= 0 || (needsSwap && !estimatedVaultTokenAmount);
        return (
        <div className={cn(leverageDisabled && "opacity-50 pointer-events-none")}>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-[var(--muted-foreground)]">Leverage</label>
            <div className="flex items-center gap-1 px-1.5 py-1 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
              <input
                type="text"
                value={leverageDisabled ? "1.00" : leverageInput}
                disabled={leverageDisabled}
                onChange={(e) => {
                  setLeverageInput(e.target.value);
                  clearTimeout(leverageDebounce.current);
                  leverageDebounce.current = setTimeout(() => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) {
                      leverageFollowsBase.current = false;
                      const clamped = Math.min(Math.max(v, 1.0), maxLeverage);
                      setLeverage(clamped);
                      setLeverageInput(clamped.toFixed(2));
                    }
                  }, 500);
                }}
                onFocus={() => { cancelLeverageAnim(); leverageInputFocused.current = true; stableMaxLevRef.current = maxLeverage; }}
                onBlur={() => {
                  leverageInputFocused.current = false;
                  const v = parseFloat(leverageInput);
                  if (!isNaN(v)) {
                    leverageFollowsBase.current = false;
                    const clamped = Math.min(Math.max(v, 1.0), maxLeverage);
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
                  stableMaxLevRef.current = maxLeverage; // expand slider range
                  animateLeverage(effectiveLeverage, maxLeverage, 300);
                }}
                onMaxAll={currentTokenBalance > 0n ? () => {
                  cancelLeverageAnim();
                  leverageFollowsBase.current = false;
                  setAmount(maxBalance);
                  animateBands(bands, 4, 300);
                  yoloWaitSeq.current = calcMaxSeq;
                  setForceCalcMax(c => c + 1);
                  setPendingYolo(true);
                  animateLeverage(effectiveLeverage, maxLeverage > 1.15 ? maxLeverage : 3.0, 600);
                } : undefined}
                onReset={effectiveLeverage > 1.005 || (amount !== "" && Number(amount) > 0) ? () => {
                  const from = effectiveLeverage;
                  setPendingYolo(false);
                  leverageFollowsBase.current = false;
                  animateBands(bands, 10, 300);
                  animateLeverage(from, 1.0, 300, () => {
                    leverageFollowsBase.current = true;
                    stableMaxLevRef.current = 10;
                    setAmount("");
                  });
                } : undefined}
              />
            </div>
          </div>
          <input
            type="range"
            min={1.0}
            max={Math.max(renderMaxLeverage, effectiveLeverage)}
            step="any"
            value={leverageDisabled ? 1.0 : effectiveLeverage}
            disabled={leverageDisabled}
            onChange={(e) => { cancelLeverageAnim(); leverageFollowsBase.current = false; stableMaxLevRef.current = maxLeverage; setLeverage(parseFloat(e.target.value)); }}
            className="w-full"
          />
        </div>
        );
      })()}

      {/* Debt Input (loan tab only) */}
      {loanTab === "loan" && (
        <div className={cn((!amount || Number(amount) <= 0 || (needsSwap && !estimatedVaultTokenAmount)) && "opacity-50 pointer-events-none")}>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-[var(--muted-foreground)]">
              {hasOutputSwap ? "Receive Amount" : "Borrow Amount"}
            </label>
            <span className="text-xs text-[var(--muted-foreground)]">
              Max: {maxBorrowable > 0n ? Number(formatUnits(maxBorrowable, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"} crvUSD
            </span>
          </div>
          <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
            <input
              type="text"
              value={debtInput}
              onChange={(e) => setDebtInput(e.target.value)}
              placeholder="0.0"
              className="flex-1 min-w-0 bg-transparent mono text-sm outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
            />
            <TokenSelector
              selectedToken={outputToken}
              onSelect={(token) => {
                setOutputToken(token);
                setDebtInputState(""); // Clear input when switching tokens (different units)
              }}
              priorityTokens={[crvUsdToken]}
              excludeDefiTokens
            />
            {hasOutputSwap ? (
              <MaxButton
                balance={maxOutputTokenEquivalent ?? "0"}
                onSelect={setDebtInput}
              />
            ) : (
              <MaxButton
                balance={maxBorrowable > 0n ? formatUnits(maxBorrowable, 18) : "0"}
                onSelect={setDebtInput}
              />
            )}
          </div>
        </div>
      )}

      {/* Bands Selector */}
      <div className={cn((!amount || Number(amount) <= 0 || debtAmount === 0n || (needsSwap && !estimatedVaultTokenAmount)) && "opacity-50 pointer-events-none")}>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-[var(--muted-foreground)]">
            Bands
            {bands <= 4 && <span className="text-red-500"> · Max LTV</span>}
            {bands > 4 && bands <= 10 && <span className="text-amber-500"> · Default</span>}
            {bands >= 50 && <span className="text-green-500"> · Safe</span>}
          </label>
          <span className="text-sm mono">{bands}</span>
        </div>
        <div className="relative">
          <input
            type="range"
            min={4}
            max={50}
            value={bands}
            onChange={(e) => { cancelBandsAnim(); setBands(Number(e.target.value)); }}
            className="w-full relative z-10"
          />
          {/* Notch ticks */}
          <div className="relative h-3 -mt-[10px] pointer-events-none">
            {[4, 10, 50].map((value) => {
              const pct = ((value - 4) / (50 - 4)) * 100;
              return (
                <div
                  key={value}
                  className="absolute -translate-x-1/2 w-1 h-3 rounded-b-full"
                  style={{ left: `calc(8px + (100% - 16px) * ${pct / 100})`, background: "#27272a" }}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Low liquidity warning */}
      {isLiquidityConstrained && maxBorrowable > 0n && debtAmount > 0n && debtAmount >= maxBorrowable * 90n / 100n && (
        <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500 text-xs flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0" />
          <span>
            Only {Number(formatUnits(controllerCrvUsdBalance!, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })} crvUSD available in lending market. Max borrow is limited by pool liquidity, not your collateral.
          </span>
        </div>
      )}

{/* Approval Flow */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: showApprovalCard ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          {lastApprovalRef.current && (
            <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-3">
              <div className="text-sm font-medium">{approvalProgress && approvalProgress.total > 1 ? "Approvals Required" : "Approval Required"}</div>
              {approvalProgress && approvalProgress.total > 1 ? (
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
                          {s.description}{s.spender && <>{" "}<a href={`https://etherscan.io/address/${s.spender}`} target="_blank" rel="noopener noreferrer" className="inline hover:text-[var(--foreground)] transition-colors"><ExternalLink size={10} className="!inline -mt-0.5" /></a></>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-[var(--muted-foreground)]">
                  Allow yld Zapper to manage position on LlamaLend{" "}<span className="whitespace-nowrap">controller <a href={`https://etherscan.io/address/${lastApprovalRef.current!.spender}`} target="_blank" rel="noopener noreferrer" className="inline hover:text-[var(--foreground)] transition-colors"><ExternalLink size={12} className="!inline -mt-0.5" /></a></span>
                </div>
              )}
              {lastApprovalRef.current!.type !== "controller" && lastApprovalRef.current!.amount ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => { setApprovingType("exact"); (isLeveraged ? zapperApprove : lendingApprove)(true); }}
                    disabled={isApproving}
                    className={cn(
                      "flex-[2] py-2.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm",
                      isApproving
                        ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                        : "border border-[var(--foreground)] text-[var(--foreground)] hover:bg-[var(--foreground)]/10"
                    )}
                  >
                    {isApproving && approvingType === "exact" ? <>Approving<LoadingDots /></> : `${Number(formatUnits(lastApprovalRef.current!.amount, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${lastApprovalRef.current!.tokenSymbol}`}
                  </button>
                  <button
                    onClick={() => { setApprovingType("unlimited"); (isLeveraged ? zapperApprove : lendingApprove)(false); }}
                    disabled={isApproving}
                    className={cn(
                      "flex-1 py-2.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm",
                      isApproving
                        ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                        : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
                    )}
                  >
                    {isApproving && approvingType === "unlimited" ? <>Approving<LoadingDots /></> : "Max"}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => { setApprovingType("single"); (isLeveraged ? zapperApprove : lendingApprove)(); }}
                  disabled={isApproving}
                  className={cn(
                    "w-full py-2.5 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
                    isApproving
                      ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                      : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
                  )}
                >
                  {isApproving
                    ? <>Approving<LoadingDots /></>
                    : `Approve ${approvalProgress?.steps[approvalProgress.step - 1]?.label ?? ""}`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Simulation Modal */}
      {showSimulationModal && simulationResult && (
        <SimulationModal
          isOpen={showSimulationModal}
          onClose={() => {
            setShowSimulationModal(false);
            toast("Transaction cancelled", { id: "new-loan-cancelled", duration: 3000 });
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

      {/* Action Button */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: !showApprovalCard ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <button
            onClick={() => {
              if (status === "error" || status === "reverted" || status === "success") {
                reset();
              } else if (simulationResult && !showSimulationModal && currentBlock === simulationBlock.current) {
                setShowSimulationModal(true);
              } else if (!quoteLoading) {
                handleSubmit();
              }
            }}
            disabled={showApprovalCard || isProcessing || quoteLoading || (!isFormValid && status === "idle")}
            className={cn(
              "w-full py-3 px-4 rounded-lg font-medium transition-colors flex items-center justify-center gap-2",
              isProcessing || quoteLoading || (!isFormValid && status === "idle")
                ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
            )}
          >
            {getButtonText()}
          </button>
        </div>
      </div>

      {/* Settings / Route */}
      {(() => {
        const usesEnso = needsSwap || hasOutputSwap || (loanTab === "leverage" && effectiveLeverage > 1.005);
        return (
        <>
        <div
          className="grid transition-[grid-template-rows] duration-300 ease-in-out"
          style={{ gridTemplateRows: !usesEnso ? "1fr" : "0fr" }}
        >
          <div className="overflow-hidden">
            <div className="flex items-center justify-end">
              <button
                onClick={() => setShowSlippageModal(true)}
                className="flex items-center gap-1.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors p-1"
                title="Settings"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="6" x2="20" y2="6" />
                  <circle cx="8" cy="6" r="2" />
                  <line x1="4" y1="18" x2="20" y2="18" />
                  <circle cx="16" cy="18" r="2" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <div
          className="grid transition-[grid-template-rows] duration-300 ease-in-out"
          style={{ gridTemplateRows: usesEnso ? "1fr" : "0fr" }}
        >
          <div className="overflow-hidden">
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-2">
              <a
                href="https://www.enso.build"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
            >
              <span>Powered by</span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/enso.png" alt="Enso" width={14} height={14} className="rounded-sm" />
              <span className="font-medium">Enso</span>
            </a>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={toggleRoute}
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors p-1"
                title={showRoute ? "Hide route" : "Show route"}
              >
                {showRoute ? <RouteOff size={16} /> : <Route size={16} />}
              </button>
              <button
                onClick={() => setShowSlippageModal(true)}
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors p-1"
                title="Slippage settings"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="6" x2="20" y2="6" />
                  <circle cx="8" cy="6" r="2" />
                  <line x1="4" y1="18" x2="20" y2="18" />
                  <circle cx="16" cy="18" r="2" />
                </svg>
              </button>
            </div>
          </div>

          </div>
        </div>

        {/* Route details panel */}
        <div
          className="grid transition-[grid-template-rows] duration-300 ease-in-out"
          style={{
            gridTemplateRows:
              showRoute && amount && Number(amount) > 0 && (needsSwap ? (swapQuote || quoteLoading) : (hasOutputSwap || displayRouteSteps.length > 1)) ? "1fr" : "0fr",
          }}
        >
          <div className="overflow-hidden">
            <div className="pt-3 mt-3 border-t border-[var(--border)]">
              <div className="text-xs text-[var(--muted-foreground)] mb-2">Route</div>
              <RouteDisplay
                routeInfo={{ steps: displayRouteSteps }}
                isLoading={quoteLoading || (hasOutputSwap && outputSwapQuoteLoading)}
                completionMessage="Loan created on Curve LlamaLend"
              />
            </div>
          </div>
        </div>
        </>
        );
      })()}

      {/* Connect wallet prompt */}
      {!address && (
        <div className="text-center text-sm text-[var(--muted-foreground)] py-4">
          Connect your wallet to create a loan
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
