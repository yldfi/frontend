"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { SlippageModal } from "@/components/SlippageModal";
import { SimulationModal } from "@/components/SimulationModal";
import { toast } from "sonner";
import { isUserRejection } from "@/lib/analytics";
import {
  Loader2,
  Check,
  AlertTriangle,
  Route,
  RouteOff,

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

interface NewLoanTabProps {
  vault: VaultConfig;
  userBalance: string; // Vault token balance in wei
  controllerAddress: `0x${string}`;
  onTransactionSuccess: () => void;
  onEstimatedHealthChange?: (health: number | null) => void;
  /** Pre-select a token (e.g., after migration frees cvxCRV) */
  defaultToken?: EnsoToken;
}

export function NewLoanTab({
  vault,
  userBalance,
  controllerAddress,
  onTransactionSuccess,
  onEstimatedHealthChange,
  defaultToken,
}: NewLoanTabProps) {
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

  // Token selection
  const [selectedToken, setSelectedToken] = useState<EnsoToken>(defaultToken ?? vaultToken);
  const isVaultToken =
    selectedToken.address.toLowerCase() === vault.address.toLowerCase();

  // Form state
  const [amount, setAmountState] = useState("");
  const setAmount = useCallback((v: string) => setAmountState(sanitizeAmount(v)), []);
  const [debtInput, setDebtInputState] = useState("");
  const setDebtInput = useCallback((v: string) => setDebtInputState(sanitizeAmount(v)), []);
  const [bands, setBands] = useState(10);

  // Leverage toggle
  const [leverageEnabled, setLeverageEnabled] = useState(false);
  const [leverage, setLeverage] = useState(2.0);
  const [leverageInput, setLeverageInput] = useState(leverage.toFixed(2));
  const leverageInputFocused = useRef(false);
  const leverageDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pendingYolo, setPendingYolo] = useState(false);
  const [calcMaxSeq, setCalcMaxSeq] = useState(0);
  const yoloWaitSeq = useRef(0);

  // Slippage
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
    pendingApproval: zapperPendingApproval,
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
  const isLeveraged = leverageEnabled && isVaultToken;
  const status = isLeveraged ? zapperStatus : lendingStatus;
  const txHash = isLeveraged ? zapperTxHash : lendingTxHash;
  const error = isLeveraged ? zapperError : lendingError;
  const simulationResult = isLeveraged ? zapperSimulationResult : lendingSimulationResult;
  const pendingApproval = isLeveraged ? zapperPendingApproval : lendingPendingApproval;
  const isApproving = isLeveraged ? zapperIsApproving : lendingIsApproving;
  const reset = isLeveraged ? zapperReset : lendingReset;

  // Read selected token balance
  const isEth = selectedToken.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const { data: tokenBalance } = useBalance({
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
      return fetchRoute({
        fromAddress: address,
        tokenIn: selectedToken.address,
        tokenOut: vault.address,
        amountIn: amountWei,
        slippage,
      });
    },
    enabled:
      needsSwap &&
      !!address &&
      !!debouncedAmount &&
      Number(debouncedAmount) > 0,
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1,
  });

  const quoteLoading = needsSwap && swapQuoteLoading;

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

  // Exchange rate
  const exchangeRate = useMemo(() => {
    if (!swapQuote?.amountOut || !debouncedAmount || Number(debouncedAmount) === 0)
      return null;
    const outFormatted = Number(formatUnits(BigInt(swapQuote.amountOut), vault.decimals));
    return outFormatted / Number(debouncedAmount);
  }, [swapQuote, debouncedAmount, vault.decimals]);

  // Price impact
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

  const priceImpact = useMemo(() => {
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

  // Max borrowable for the estimated collateral
  const [maxBorrowable, setMaxBorrowable] = useState<bigint>(0n);

  useEffect(() => {
    let stale = false;
    async function calcMax() {
      if (!publicClient || !estimatedVaultTokenAmount) {
        setMaxBorrowable(0n);
        setCalcMaxSeq(s => s + 1);
        return;
      }
      try {
        const max = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "max_borrowable",
          args: [estimatedVaultTokenAmount, BigInt(bands)],
        });
        if (stale) return;
        setMaxBorrowable(max);
      } catch {
        if (stale) return;
        setMaxBorrowable(0n);
      }
      setCalcMaxSeq(s => s + 1);
    }
    calcMax();
    return () => { stale = true; };
  }, [publicClient, controllerAddress, estimatedVaultTokenAmount, bands]);

  // Debt amount (wei)
  const debtAmount = useMemo(() => {
    if (leverageEnabled) {
      // Leverage mode: calculate debt from leverage ratio
      if (!estimatedVaultTokenAmount || leverage <= 1) return 0n;
      const leverageFraction = Math.floor((leverage - 1) * 10000);
      const rawDebt = estimatedVaultTokenAmount * BigInt(leverageFraction) / 10000n;
      if (maxBorrowable > 0n && rawDebt > maxBorrowable) {
        return maxBorrowable;
      }
      return rawDebt;
    }
    // Simple mode: manual debt input
    if (!debtInput || Number(debtInput) <= 0) return 0n;
    try {
      return parseUnits(debtInput, 18);
    } catch {
      return 0n;
    }
  }, [leverageEnabled, estimatedVaultTokenAmount, leverage, maxBorrowable, debtInput]);

  // Max leverage
  const maxLeverage = useMemo(() => {
    if (!estimatedVaultTokenAmount || maxBorrowable === 0n) return 5;
    try {
      if (estimatedVaultTokenAmount === 0n) return 5;
      const ratio = Number(formatUnits(maxBorrowable, 18)) / Number(formatUnits(estimatedVaultTokenAmount, vault.decimals));
      return Math.min(Math.max(1 + ratio, 1.1), 10);
    } catch {
      return 5;
    }
  }, [estimatedVaultTokenAmount, maxBorrowable, vault.decimals]);

  // Sync leverage text input when leverage changes from slider (not while typing)
  useEffect(() => {
    if (!leverageInputFocused.current) {
      setLeverageInput(leverage.toFixed(2));
    }
  }, [leverage]);

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

  // Estimate health
  useEffect(() => {
    async function calcHealth() {
      if (!publicClient || !address || !estimatedVaultTokenAmount || debtAmount === 0n) {
        setEstimatedHealth(null);
        return;
      }

      try {
        const health = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "health_calculator",
          args: [
            address,
            estimatedVaultTokenAmount,
            debtAmount,
            true,
            BigInt(bands),
          ],
        });

        setEstimatedHealth(Number(health) / 1e16);
      } catch {
        setEstimatedHealth(null);
      }
    }

    const timer = setTimeout(calcHealth, 300);
    return () => clearTimeout(timer);
  }, [publicClient, address, controllerAddress, estimatedVaultTokenAmount, debtAmount, bands]);

  // Report estimated health to parent
  useEffect(() => {
    onEstimatedHealthChange?.(estimatedHealth);
  }, [estimatedHealth, onEstimatedHealthChange]);

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
    }
  }, [status, txHash, onTransactionSuccess]);

  useEffect(() => {
    if (status === "error" && error) {
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

  // Clear simulation when inputs change
  useEffect(() => {
    if (simulationResult) {
      reset();
      setShowSimulationModal(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, debtInput, selectedToken.address, leverageEnabled, leverage, bands]);

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

  // Clear amount when switching token
  useEffect(() => {
    setAmountState("");
    setDebtInputState("");
    lendingReset();
    zapperReset();
  }, [selectedToken.address, lendingReset, zapperReset]);

  // Disable leverage for non-vault tokens
  useEffect(() => {
    if (!isVaultToken && leverageEnabled) {
      setLeverageEnabled(false);
    }
  }, [isVaultToken, leverageEnabled]);

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

    const openModalIfPreview = (result: unknown) => {
      if (result && preview) {
        simulationBlock.current = currentBlock ?? 0n;
        setShowSimulationModal(true);
        fetchEthPrice();
      }
    };

    try {
      if (isLeveraged) {
        // Leveraged: vault token only, via Zapper
        const collateralWei = parseUnits(amount, vault.decimals);
        const result = await createLeveragedLoan(
          controllerAddress,
          collateralWei,
          debtAmount,
          bands,
          vault.address as `0x${string}`,
          Number(slippage),
          preview
        );
        openModalIfPreview(result);
      } else if (isVaultToken) {
        // Simple: vault token, direct controller call
        if (preview) {
          const result = await createLoan(
            vault.address as `0x${string}`,
            amount,
            debtAmount.toString(),
            bands,
            { tokenSymbol: vault.symbol, previewOnly: true }
          );
          openModalIfPreview(result);
        } else {
          await createLoan(
            vault.address as `0x${string}`,
            amount,
            debtAmount.toString(),
            bands,
            { tokenSymbol: vault.symbol }
          );
        }
      } else {
        // Swap: non-vault token → createLoanWithSwap Enso bundle
        const result = await createLoanWithSwap(
          vault.address as `0x${string}`,
          selectedToken.address,
          amount,
          debtAmount.toString(),
          bands,
          Number(slippage),
          { previewOnly: preview, tokenSymbol: selectedToken.symbol }
        );
        openModalIfPreview(result);
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
    if (debtAmount === 0n || maxBorrowable === 0n) return false;
    return debtAmount > maxBorrowable;
  }, [debtAmount, maxBorrowable]);

  const isProcessing =
    status !== "idle" &&
    status !== "success" &&
    status !== "error" &&
    status !== "needsApproval";

  const isFormValid =
    !!amount &&
    Number(amount) > 0 &&
    debtAmount > 0n &&
    !hasInsufficientBalance &&
    !exceedsMaxBorrowable &&
    (isVaultToken || (!quoteLoading && swapQuote !== undefined));

  const getButtonText = () => {
    if (status === "building" || status === "simulating") return needsSwap ? "Simulating..." : "Preparing...";
    if (status === "executing") return "Confirm in wallet...";
    if (status === "waitingTx") return "Waiting for confirmation...";
    if (status === "success") return "Done!";
    if (status === "error") return "Try Again";
    if (hasInsufficientBalance) return "Insufficient balance";
    if (exceedsMaxBorrowable) return "Exceeds max borrowable";

    if (isLeveraged) return "Create Leveraged Loan";
    if (isVaultToken) return "Create Loan";
    return "Swap & Create Loan";
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
        <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:border-[var(--foreground)]">
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            className="flex-1 min-w-0 bg-transparent mono text-base outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
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
      </div>

      {/* Swap quote details */}
      {needsSwap && amount && Number(amount) > 0 && swapQuote && !quoteLoading && (
        <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-2 text-sm">
          {swapQuote.amountOut && (
            <div className="flex justify-between">
              <span className="text-[var(--muted-foreground)]">Collateral after swap</span>
              <span className="mono">
                ~{Number(formatUnits(BigInt(swapQuote.amountOut), vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })}{" "}
                {vault.symbol}
              </span>
            </div>
          )}
          {exchangeRate !== null && (
            <div className="flex justify-between">
              <span className="text-[var(--muted-foreground)]">Rate</span>
              <span className="mono">
                1 {selectedToken.symbol} = {exchangeRate.toLocaleString(undefined, { maximumFractionDigits: 4 })} {vault.symbol}
              </span>
            </div>
          )}
          {priceImpact !== null && (
            <div className="flex justify-between">
              <span className="text-[var(--muted-foreground)]">Price Impact</span>
              <span className={cn(
                "mono",
                priceImpact <= 0 ? "text-green-500" : priceImpact < 3 ? "text-yellow-500" : "text-red-500"
              )}>
                {priceImpact > 0 ? "" : "+"}{(-priceImpact).toFixed(2)}%
              </span>
            </div>
          )}
        </div>
      )}

      {/* Leverage Toggle (only for vault token) */}
      {isVaultToken && (
        <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)]">
          <span className="text-sm text-[var(--muted-foreground)]">Leverage</span>
          <button
            onClick={() => setLeverageEnabled(!leverageEnabled)}
            className={cn(
              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
              leverageEnabled ? "bg-[var(--foreground)]" : "bg-[var(--muted)]"
            )}
          >
            <span
              className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-[var(--background)] transition-transform",
                leverageEnabled ? "translate-x-6" : "translate-x-1"
              )}
            />
          </button>
        </div>
      )}

      {/* Leverage Slider (when enabled) */}
      {leverageEnabled && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-[var(--muted-foreground)]">Leverage</label>
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
                      const clamped = Math.min(Math.max(v, 1.1), maxLeverage);
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
                    const clamped = Math.min(Math.max(v, 1.1), maxLeverage);
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
                onMaxAll={currentTokenBalance > 0n ? () => {
                  setAmount(maxBalance);
                  yoloWaitSeq.current = calcMaxSeq;
                  setPendingYolo(true);
                } : undefined}
                onReset={leverage > 1.1 || (amount !== "" && Number(amount) > 0) ? () => {
                  setLeverage(1.1);
                  setLeverageInput("1.10");
                  setAmount("");
                } : undefined}
              />
            </div>
          </div>
          <input
            type="range"
            min={110}
            max={Math.floor(maxLeverage * 100)}
            value={Math.floor(leverage * 100)}
            onChange={(e) => setLeverage(Number(e.target.value) / 100)}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-[var(--muted-foreground)] mt-1">
            <span>1.1x</span>
            <div className="flex gap-2">
              {[1.5, 2, 2.5, 3].filter(v => v <= maxLeverage).map(v => (
                <button
                  key={v}
                  onClick={() => setLeverage(v)}
                  className={cn(
                    "px-1.5 py-0.5 rounded text-xs transition-colors",
                    Math.abs(leverage - v) < 0.05
                      ? "bg-[var(--foreground)] text-[var(--background)]"
                      : "hover:text-[var(--foreground)]"
                  )}
                >
                  {v}x
                </button>
              ))}
            </div>
            <span>{maxLeverage.toFixed(1)}x</span>
          </div>
        </div>
      )}

      {/* Debt Input (simple mode only) */}
      {!leverageEnabled && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-[var(--muted-foreground)]">Borrow Amount (crvUSD)</label>
            {maxBorrowable > 0n && (
              <span className="text-xs text-[var(--muted-foreground)]">
                Max: {Number(formatUnits(maxBorrowable, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:border-[var(--foreground)]">
            <input
              type="text"
              value={debtInput}
              onChange={(e) => setDebtInput(e.target.value)}
              placeholder="0.0"
              className="flex-1 min-w-0 bg-transparent mono text-base outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
            />
            <span className="mono text-sm font-medium shrink-0">crvUSD</span>
            {maxBorrowable > 0n && (
              <MaxButton
                balance={formatUnits(maxBorrowable, 18)}
                onSelect={setDebtInput}
              />
            )}
          </div>
        </div>
      )}

      {/* Bands Selector */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-[var(--muted-foreground)]">Number of Bands</label>
          <span className="text-sm mono">{bands}</span>
        </div>
        <input
          type="range"
          min={4}
          max={50}
          value={bands}
          onChange={(e) => setBands(Number(e.target.value))}
          className="w-full"
        />
        <div className="flex justify-between text-xs text-[var(--muted-foreground)]">
          <span>4 (higher liq. risk)</span>
          <span>50 (more gradual)</span>
        </div>
      </div>

      {/* Borrow summary */}
      {debtAmount > 0n && estimatedVaultTokenAmount && (
        <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">Borrow Amount</span>
            <span className="mono">
              {Number(formatUnits(debtAmount, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD
            </span>
          </div>
          {leverageEnabled && (
            <div className="flex justify-between">
              <span className="text-[var(--muted-foreground)]">Effective Leverage</span>
              <span className="mono">{leverage.toFixed(2)}x</span>
            </div>
          )}
        </div>
      )}

      {/* Warnings */}
      {hasInsufficientBalance && amount && Number(amount) > 0 && (
        <p className="text-sm text-red-500 flex items-center gap-1.5">
          <AlertTriangle size={14} />
          Insufficient balance
        </p>
      )}
      {exceedsMaxBorrowable && debtAmount > 0n && (
        <p className="text-sm text-red-500 flex items-center gap-1.5">
          <AlertTriangle size={14} />
          Exceeds max borrowable ({maxBorrowable > 0n
            ? `${Number(formatUnits(maxBorrowable, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD`
            : "0 crvUSD"})
        </p>
      )}

      {/* Approval Flow */}
      {pendingApproval && status === "needsApproval" && (
        <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-3">
          <div className="text-sm font-medium">Approval Required</div>
          <div className="text-sm text-[var(--muted-foreground)]">
            Approve {pendingApproval.tokenSymbol} spending
          </div>
          {pendingApproval.type !== "controller" && pendingApproval.amount ? (
            <div className="flex gap-2">
              <button
                onClick={() => (isLeveraged ? zapperApprove : lendingApprove)(true)}
                disabled={isApproving}
                className={cn(
                  "flex-1 py-2.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm",
                  isApproving
                    ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                    : "border border-[var(--foreground)] text-[var(--foreground)] hover:bg-[var(--foreground)]/10"
                )}
              >
                {isApproving && <Loader2 className="w-4 h-4 animate-spin" />}
                {isApproving ? "Approving..." : `Exact (~${Number(formatUnits(pendingApproval.amount, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })})`}
              </button>
              <button
                onClick={() => (isLeveraged ? zapperApprove : lendingApprove)(false)}
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
              onClick={() => (isLeveraged ? zapperApprove : lendingApprove)()}
              disabled={isApproving}
              className={cn(
                "w-full py-2.5 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
                isApproving
                  ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                  : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
              )}
            >
              {isApproving && <Loader2 className="w-4 h-4 animate-spin" />}
              {isApproving ? "Approving..." : `Approve ${pendingApproval.tokenSymbol}`}
            </button>
          )}
        </div>
      )}

      {/* Success Display */}
      {status === "success" && txHash && (
        <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-500 text-sm flex items-center gap-2">
          <Check size={16} />
          Loan created!
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
      {status !== "needsApproval" && (
        <button
          onClick={() => {
            if (status === "error" || status === "success") {
              reset();
            } else if (simulationResult && !showSimulationModal && currentBlock === simulationBlock.current) {
              setShowSimulationModal(true);
            } else if (!quoteLoading) {
              handleSubmit();
            }
          }}
          disabled={isProcessing || quoteLoading || (!isFormValid && status === "idle")}
          className={cn(
            "w-full py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
            isProcessing || quoteLoading || (!isFormValid && status === "idle")
              ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
              : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
          )}
        >
          {isProcessing && <Loader2 className="w-4 h-4 animate-spin" />}
          {needsSwap && quoteLoading && status === "idle" ? (
            <>Getting quote<LoadingDots /></>
          ) : (
            getButtonText()
          )}
        </button>
      )}

      {/* Settings / Route */}
      {!needsSwap && (
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
      )}

      {needsSwap && (
        <>
          <div className="flex items-center justify-between pt-2">
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

          {/* Route details panel */}
          <div
            className="grid transition-all duration-300 ease-in-out"
            style={{
              gridTemplateRows:
                showRoute && amount && Number(amount) > 0 && (swapQuote || quoteLoading) ? "1fr" : "0fr",
            }}
          >
            <div className="overflow-hidden">
              <div className="pt-3 mt-3 border-t border-[var(--border)]">
                <div className="text-xs text-[var(--muted-foreground)] mb-2">Route</div>
                <RouteDisplay
                  routeInfo={
                    swapQuote
                      ? {
                          steps: [
                            {
                              tokenSymbol: selectedToken.symbol,
                              action: "Swap",
                              description: `${selectedToken.symbol} for ${vault.symbol}`,
                              protocol: "Enso Router",
                            },
                            {
                              tokenSymbol: vault.symbol,
                              action: "Create Loan",
                              description: `Deposit ${vault.symbol} and borrow crvUSD`,
                              protocol: "Curve LlamaLend",
                            },
                          ],
                        }
                      : undefined
                  }
                  inputSymbol={selectedToken.symbol}
                  outputSymbol="crvUSD"
                  inputAmount={amount ? Number(amount).toFixed(4) : undefined}
                  outputAmount={
                    debtAmount > 0n
                      ? Number(formatUnits(debtAmount, 18)).toFixed(2)
                      : undefined
                  }
                  isLoading={quoteLoading}
                />
              </div>
            </div>
          </div>
        </>
      )}

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
