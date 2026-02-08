"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Loader2,
  Check,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";
import {
  useAccount,
  useBalance,
  useReadContract,
  useSendTransaction,
  useWaitForTransactionReceipt,
} from "wagmi";
import { formatUnits, parseUnits, encodeFunctionData, maxUint256 } from "viem";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { sanitizeAmount } from "@/lib/sanitize";
import { fetchRoute, ETH_ADDRESS } from "@/lib/enso";
import { TokenSelector } from "@/components/TokenSelector";
import { MaxButton } from "@/components/MaxButton";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { InversePosition } from "@/hooks/useInversePosition";
import {
  INVERSE_MARKET,
  DOLA_ADDRESS,
} from "@/hooks/useInversePosition";
import { ERC20_APPROVAL_ABI } from "@/lib/abis";
import type { EnsoToken, EnsoRouteResponse } from "@/types/enso";

// --- ABIs ---

const REPAY_AND_WITHDRAW_ABI = [
  {
    name: "repayAndWithdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "repayAmount", type: "uint256" },
      { name: "withdrawAmount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// --- Constants ---

const DOLA_TOKEN: EnsoToken = {
  address: DOLA_ADDRESS,
  chainId: 1,
  name: "DOLA",
  symbol: "DOLA",
  decimals: 18,
  logoURI: "https://assets.coingecko.com/coins/images/14287/small/anchor-logo.png",
  type: "base",
};

// --- Types ---

interface MigrateSectionProps {
  inversePosition: InversePosition;
  onMigrationComplete?: () => void;
}

type MigrationStep = 1 | 2 | 3;

type StepStatus = "pending" | "active" | "complete" | "error";

// --- Helpers ---

function StepIndicator({ status }: { status: StepStatus }) {
  if (status === "complete") {
    return (
      <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center shrink-0">
        <Check size={14} className="text-white" />
      </div>
    );
  }
  if (status === "active") {
    return (
      <div className="w-6 h-6 rounded-full border-2 border-[var(--foreground)] flex items-center justify-center shrink-0">
        <Loader2 size={12} className="animate-spin text-[var(--foreground)]" />
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="w-6 h-6 rounded-full bg-red-500/20 flex items-center justify-center shrink-0">
        <AlertTriangle size={12} className="text-red-500" />
      </div>
    );
  }
  // pending
  return (
    <div className="w-6 h-6 rounded-full border-2 border-[var(--border)] shrink-0" />
  );
}

function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="animate-bounce" style={{ animationDelay: "0ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "150ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "300ms", animationDuration: "600ms" }}>.</span>
    </span>
  );
}

// --- Component ---

export function MigrateSection({
  inversePosition,
  onMigrationComplete,
}: MigrateSectionProps) {
  const { address } = useAccount();

  // Collapse state
  const [isOpen, setIsOpen] = useState(true);

  // Migration percentage (0-100)
  const [percent, setPercent] = useState(100);

  // Current step tracking
  const [currentStep, setCurrentStep] = useState<MigrationStep>(1);
  const [step1Status, setStep1Status] = useState<StepStatus>("pending");
  const [step2Status, setStep2Status] = useState<StepStatus>("pending");
  const [step3Status, setStep3Status] = useState<StepStatus>("pending");

  // Step 1: swap source token + amount
  const [swapToken, setSwapToken] = useState<EnsoToken>(DOLA_TOKEN);
  const [swapAmount, setSwapAmountState] = useState("");
  const setSwapAmount = useCallback(
    (v: string) => setSwapAmountState(sanitizeAmount(v)),
    []
  );
  const debouncedSwapAmount = useDebouncedValue(swapAmount, 500);

  // Step 2: tx hashes for tracking
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | undefined>();
  const [repayTxHash, setRepayTxHash] = useState<`0x${string}` | undefined>();

  // Step 1: swap tx hash
  const [swapTxHash, setSwapTxHash] = useState<`0x${string}` | undefined>();

  // Calculated amounts based on slider percentage
  const dolaRepayAmount = useMemo(() => {
    return (inversePosition.debt * BigInt(percent)) / 100n;
  }, [inversePosition.debt, percent]);

  const cvxCRVWithdrawAmount = useMemo(() => {
    return (inversePosition.collateralBalance * BigInt(percent)) / 100n;
  }, [inversePosition.collateralBalance, percent]);

  // Read DOLA balance
  const { data: dolaBalance, refetch: refetchDolaBalance } = useBalance({
    address,
    token: DOLA_ADDRESS as `0x${string}`,
    query: { enabled: !!address },
  });
  const dolaBalanceValue = dolaBalance?.value ?? 0n;

  // Read swap token balance (for non-DOLA tokens)
  const isSwapDola = swapToken.address.toLowerCase() === DOLA_ADDRESS.toLowerCase();
  const isSwapEth = swapToken.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const { data: swapTokenBalance } = useBalance({
    address,
    token: isSwapEth ? undefined : (swapToken.address as `0x${string}`),
    query: { enabled: !!address && !isSwapDola },
  });
  const swapBalanceFormatted = swapTokenBalance?.formatted ?? "0";

  // Whether user has enough DOLA already
  const hasSufficientDola = dolaBalanceValue >= dolaRepayAmount;
  const dolaDeficit = dolaRepayAmount > dolaBalanceValue
    ? dolaRepayAmount - dolaBalanceValue
    : 0n;

  // Auto-skip step 1 if user has enough DOLA
  useEffect(() => {
    if (hasSufficientDola && currentStep === 1 && step1Status !== "complete") {
      setStep1Status("complete");
      setCurrentStep(2);
    }
  }, [hasSufficientDola, currentStep, step1Status]);

  // Fetch swap quote for step 1 (non-DOLA token -> DOLA)
  const {
    data: swapQuote,
    isLoading: swapQuoteLoading,
  } = useQuery({
    queryKey: [
      "migrate-swap-quote",
      swapToken.address,
      debouncedSwapAmount,
      address,
    ],
    queryFn: async (): Promise<EnsoRouteResponse> => {
      if (!address) throw new Error("No address");
      const amountWei = parseUnits(debouncedSwapAmount, swapToken.decimals).toString();
      return fetchRoute({
        fromAddress: address,
        tokenIn: swapToken.address,
        tokenOut: DOLA_ADDRESS,
        amountIn: amountWei,
        slippage: "100", // 1% default
      });
    },
    enabled:
      !isSwapDola &&
      !hasSufficientDola &&
      !!address &&
      !!debouncedSwapAmount &&
      Number(debouncedSwapAmount) > 0,
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1,
  });

  // Estimated DOLA output from swap
  const estimatedDolaOut = useMemo(() => {
    if (!swapQuote?.amountOut) return null;
    return BigInt(swapQuote.amountOut);
  }, [swapQuote]);

  // Exchange rate display
  const exchangeRate = useMemo(() => {
    if (!estimatedDolaOut || !debouncedSwapAmount || Number(debouncedSwapAmount) === 0) return null;
    const outFormatted = Number(formatUnits(estimatedDolaOut, 18));
    return outFormatted / Number(debouncedSwapAmount);
  }, [estimatedDolaOut, debouncedSwapAmount]);

  // Insufficient swap balance check
  const hasInsufficientSwapBalance = useMemo(() => {
    if (!swapAmount || Number(swapAmount) === 0 || isSwapDola) return false;
    try {
      const amountWei = parseUnits(swapAmount, swapToken.decimals);
      return amountWei > (swapTokenBalance?.value ?? 0n);
    } catch {
      return false;
    }
  }, [swapAmount, swapToken.decimals, swapTokenBalance?.value, isSwapDola]);

  // --- Transaction hooks ---

  // Step 1: Execute swap via Enso route
  const {
    sendTransaction: sendSwapTx,
    isPending: isSwapPending,
    data: swapTxData,
  } = useSendTransaction();

  const { isSuccess: isSwapSuccess, isError: isSwapError } = useWaitForTransactionReceipt({
    hash: swapTxHash,
  });

  // Track swap tx hash
  useEffect(() => {
    if (swapTxData) {
      setSwapTxHash(swapTxData);
    }
  }, [swapTxData]);

  // Handle swap success
  useEffect(() => {
    if (isSwapSuccess && step1Status === "active") {
      toast.success("Swap completed! DOLA acquired.");
      setStep1Status("complete");
      setCurrentStep(2);
      refetchDolaBalance();
    }
  }, [isSwapSuccess, step1Status, refetchDolaBalance]);

  // Handle swap error
  useEffect(() => {
    if (isSwapError && step1Status === "active") {
      toast.error("Swap failed");
      setStep1Status("error");
    }
  }, [isSwapError, step1Status]);

  // Step 2a: Approve DOLA
  const {
    sendTransaction: sendApproveTx,
    isPending: isApprovePending,
    data: approveTxData,
  } = useSendTransaction();

  const { isSuccess: isApproveSuccess, isError: isApproveError } = useWaitForTransactionReceipt({
    hash: approveTxHash,
  });

  // Track approve tx hash
  useEffect(() => {
    if (approveTxData) {
      setApproveTxHash(approveTxData);
    }
  }, [approveTxData]);

  // Step 2b: repayAndWithdraw
  const {
    sendTransaction: sendRepayTx,
    isPending: isRepayPending,
    data: repayTxData,
  } = useSendTransaction();

  const { isSuccess: isRepaySuccess, isError: isRepayError } = useWaitForTransactionReceipt({
    hash: repayTxHash,
  });

  // Track repay tx hash
  useEffect(() => {
    if (repayTxData) {
      setRepayTxHash(repayTxData);
    }
  }, [repayTxData]);

  // Read DOLA allowance to Inverse market
  const { data: dolaAllowance, refetch: refetchAllowance } = useReadContract({
    address: DOLA_ADDRESS as `0x${string}`,
    abi: ERC20_APPROVAL_ABI,
    functionName: "allowance",
    args: address ? [address, INVERSE_MARKET] : undefined,
    query: { enabled: !!address },
  });
  const currentAllowance = (dolaAllowance as bigint) ?? 0n;
  const needsApproval = currentAllowance < dolaRepayAmount;

  // Handle approve success -> continue to repay
  useEffect(() => {
    if (isApproveSuccess && step2Status === "active") {
      toast.success("DOLA approved");
      refetchAllowance();
      // Now execute repayAndWithdraw
      const data = encodeFunctionData({
        abi: REPAY_AND_WITHDRAW_ABI,
        functionName: "repayAndWithdraw",
        args: [dolaRepayAmount, cvxCRVWithdrawAmount],
      });
      sendRepayTx({
        to: INVERSE_MARKET,
        data,
        value: 0n,
      });
    }
  }, [isApproveSuccess, step2Status, refetchAllowance, dolaRepayAmount, cvxCRVWithdrawAmount, sendRepayTx]);

  // Handle approve error
  useEffect(() => {
    if (isApproveError && step2Status === "active") {
      toast.error("DOLA approval failed");
      setStep2Status("error");
    }
  }, [isApproveError, step2Status]);

  // Handle repay success
  useEffect(() => {
    if (isRepaySuccess && step2Status === "active") {
      toast.success("Repaid and withdrew from Inverse Finance!");
      setStep2Status("complete");
      setCurrentStep(3);
      setStep3Status("pending");
    }
  }, [isRepaySuccess, step2Status]);

  // Handle repay error
  useEffect(() => {
    if (isRepayError && step2Status === "active") {
      toast.error("Repay & Withdraw failed");
      setStep2Status("error");
    }
  }, [isRepayError, step2Status]);

  // --- Handlers ---

  const handleSwap = () => {
    if (!swapQuote?.tx || !address) return;
    setStep1Status("active");
    sendSwapTx({
      to: swapQuote.tx.to as `0x${string}`,
      data: swapQuote.tx.data as `0x${string}`,
      value: BigInt(swapQuote.tx.value || "0"),
    });
  };

  const handleRepayAndWithdraw = () => {
    if (!address) return;
    setStep2Status("active");

    if (needsApproval) {
      // First approve DOLA to Inverse market
      const approveData = encodeFunctionData({
        abi: ERC20_APPROVAL_ABI,
        functionName: "approve",
        args: [INVERSE_MARKET, maxUint256],
      });
      sendApproveTx({
        to: DOLA_ADDRESS as `0x${string}`,
        data: approveData,
        value: 0n,
      });
    } else {
      // Already approved, go straight to repayAndWithdraw
      const data = encodeFunctionData({
        abi: REPAY_AND_WITHDRAW_ABI,
        functionName: "repayAndWithdraw",
        args: [dolaRepayAmount, cvxCRVWithdrawAmount],
      });
      sendRepayTx({
        to: INVERSE_MARKET,
        data,
        value: 0n,
      });
    }
  };

  const handleCreateLoan = () => {
    onMigrationComplete?.();
  };

  // Format helpers
  const fmtDola = (val: bigint) =>
    Number(formatUnits(val, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const fmtCvx = (val: bigint) =>
    Number(formatUnits(val, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 });

  // Health factor color
  const healthColor =
    inversePosition.healthFactor < 1.2
      ? "text-red-500"
      : inversePosition.healthFactor < 1.5
        ? "text-yellow-500"
        : "text-green-500";

  const isStep2Processing = isApprovePending || isRepayPending || step2Status === "active";

  return (
    <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl overflow-hidden">
      {/* Collapsible header */}
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full flex items-center justify-between p-4 hover:bg-[var(--muted)]/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          <AlertTriangle size={18} className="text-yellow-500" />
          <span className="text-sm font-medium">
            Migrate from Inverse Finance
          </span>
        </div>
        <ChevronDown
          size={16}
          className={cn(
            "text-[var(--muted-foreground)] transition-transform duration-200",
            isOpen && "rotate-180"
          )}
        />
      </button>

      {/* Collapsible content */}
      <div
        className="grid transition-all duration-300 ease-in-out"
        style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="px-4 pb-4 space-y-4">
            {/* Position Summary */}
            <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)]">
              <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)] mb-2">
                Inverse Finance Position
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="text-[10px] text-[var(--muted-foreground)]">
                    Collateral
                  </div>
                  <div className="mono text-sm font-medium">
                    {fmtCvx(inversePosition.collateralBalance)} cvxCRV
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-[var(--muted-foreground)]">
                    Debt
                  </div>
                  <div className="mono text-sm font-medium">
                    {fmtDola(inversePosition.debt)} DOLA
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-[var(--muted-foreground)]">
                    Health
                  </div>
                  <div className={cn("mono text-sm font-medium", healthColor)}>
                    {inversePosition.healthFactor.toFixed(2)}
                  </div>
                </div>
              </div>
            </div>

            {/* Migration Slider */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-[var(--muted-foreground)]">
                  Migrate
                </label>
                <span className="mono text-sm font-medium">{percent}%</span>
              </div>
              <input
                type="range"
                min={1}
                max={100}
                value={percent}
                onChange={(e) => setPercent(Number(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-[var(--muted-foreground)] mt-1">
                <span>{fmtDola(dolaRepayAmount)} DOLA</span>
                <span>{fmtCvx(cvxCRVWithdrawAmount)} cvxCRV</span>
              </div>
            </div>

            {/* Step 1: Get DOLA */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <StepIndicator status={step1Status} />
                <div className="flex-1">
                  <div className="text-sm font-medium">
                    1. Get DOLA
                    {hasSufficientDola && step1Status === "complete" && (
                      <span className="text-xs text-[var(--muted-foreground)] ml-2">
                        (sufficient balance)
                      </span>
                    )}
                  </div>
                  {!hasSufficientDola && (
                    <div className="text-xs text-[var(--muted-foreground)]">
                      Need {fmtDola(dolaDeficit)} more DOLA
                    </div>
                  )}
                </div>
              </div>

              {/* Step 1 form: only show if user needs DOLA and step not complete */}
              {!hasSufficientDola && step1Status !== "complete" && currentStep === 1 && (
                <div className="ml-9 space-y-3">
                  {/* Balance display */}
                  <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
                    <span>
                      DOLA balance: <span className="mono">{fmtDola(dolaBalanceValue)}</span>
                    </span>
                    {!isSwapDola && (
                      <span>
                        Balance: <span className="mono">{swapBalanceFormatted}</span>
                      </span>
                    )}
                  </div>

                  {/* Token selector + amount */}
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:border-[var(--foreground)]">
                    <input
                      type="text"
                      value={swapAmount}
                      onChange={(e) => setSwapAmount(e.target.value)}
                      placeholder="0.0"
                      className="flex-1 min-w-0 bg-transparent mono text-base outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
                    />
                    <TokenSelector
                      selectedToken={swapToken}
                      onSelect={setSwapToken}
                      excludeDefiTokens
                    />
                    {!isSwapDola && (
                      <MaxButton
                        balance={swapBalanceFormatted}
                        onSelect={setSwapAmount}
                      />
                    )}
                  </div>

                  {/* Quote details */}
                  {!isSwapDola && swapAmount && Number(swapAmount) > 0 && (
                    <>
                      {swapQuoteLoading && (
                        <div className="text-xs text-[var(--muted-foreground)]">
                          Getting quote<LoadingDots />
                        </div>
                      )}
                      {swapQuote && !swapQuoteLoading && estimatedDolaOut && (
                        <div className="p-2 rounded bg-[var(--muted)]/50 border border-[var(--border)] space-y-1 text-xs">
                          {exchangeRate !== null && (
                            <div className="flex justify-between">
                              <span className="text-[var(--muted-foreground)]">Rate</span>
                              <span className="mono">
                                1 {swapToken.symbol} = {exchangeRate.toLocaleString(undefined, { maximumFractionDigits: 4 })} DOLA
                              </span>
                            </div>
                          )}
                          <div className="flex justify-between">
                            <span className="text-[var(--muted-foreground)]">You receive</span>
                            <span className="mono">~{fmtDola(estimatedDolaOut)} DOLA</span>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* Error state */}
                  {step1Status === "error" && (
                    <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-red-500 text-xs">
                      Swap failed. Please try again.
                    </div>
                  )}

                  {/* Swap button */}
                  {!isSwapDola && (
                    <button
                      onClick={handleSwap}
                      disabled={
                        isSwapPending ||
                        step1Status === "active" ||
                        swapQuoteLoading ||
                        !swapQuote ||
                        !swapAmount ||
                        Number(swapAmount) === 0 ||
                        hasInsufficientSwapBalance
                      }
                      className={cn(
                        "w-full py-2.5 px-4 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2",
                        isSwapPending || step1Status === "active" || swapQuoteLoading || !swapQuote || hasInsufficientSwapBalance
                          ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                          : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
                      )}
                    >
                      {(isSwapPending || step1Status === "active") && (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      )}
                      {hasInsufficientSwapBalance
                        ? "Insufficient balance"
                        : isSwapPending
                          ? "Confirm in wallet..."
                          : step1Status === "active"
                            ? "Swapping..."
                            : swapQuoteLoading
                              ? <>Getting quote<LoadingDots /></>
                              : `Swap ${swapToken.symbol} for DOLA`}
                    </button>
                  )}

                  {/* If user selected DOLA token, just tell them to get more */}
                  {isSwapDola && (
                    <div className="text-xs text-[var(--muted-foreground)]">
                      You need {fmtDola(dolaDeficit)} more DOLA. Select a different token above to swap, or acquire DOLA externally.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Step 2: Repay & Withdraw */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <StepIndicator status={step2Status} />
                <div className="flex-1">
                  <div className="text-sm font-medium">2. Repay & Withdraw</div>
                  <div className="text-xs text-[var(--muted-foreground)]">
                    {needsApproval && step2Status !== "complete"
                      ? "Approve DOLA, then repay debt and withdraw cvxCRV"
                      : "Repay DOLA debt and withdraw cvxCRV from Inverse"}
                  </div>
                </div>
              </div>

              {currentStep === 2 && step2Status !== "complete" && (
                <div className="ml-9 space-y-3">
                  {/* Summary of what will happen */}
                  <div className="p-2 rounded bg-[var(--muted)]/50 border border-[var(--border)] space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Repay</span>
                      <span className="mono">{fmtDola(dolaRepayAmount)} DOLA</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Withdraw</span>
                      <span className="mono">{fmtCvx(cvxCRVWithdrawAmount)} cvxCRV</span>
                    </div>
                    {needsApproval && (
                      <div className="flex justify-between">
                        <span className="text-[var(--muted-foreground)]">Approval</span>
                        <span className="text-yellow-500">Required</span>
                      </div>
                    )}
                  </div>

                  {/* Error state */}
                  {step2Status === "error" && (
                    <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-red-500 text-xs">
                      Transaction failed. Please try again.
                    </div>
                  )}

                  {/* Tx links */}
                  {approveTxHash && (
                    <div className="text-xs text-[var(--muted-foreground)]">
                      Approval tx:{" "}
                      <a
                        href={`https://etherscan.io/tx/${approveTxHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-[var(--foreground)]"
                      >
                        {approveTxHash.slice(0, 10)}...
                      </a>
                    </div>
                  )}

                  <button
                    onClick={handleRepayAndWithdraw}
                    disabled={isStep2Processing}
                    className={cn(
                      "w-full py-2.5 px-4 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2",
                      isStep2Processing
                        ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                        : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
                    )}
                  >
                    {isStep2Processing && (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    )}
                    {isApprovePending
                      ? "Approve in wallet..."
                      : isRepayPending
                        ? "Confirm in wallet..."
                        : step2Status === "active"
                          ? "Processing..."
                          : step2Status === "error"
                            ? "Retry"
                            : needsApproval
                              ? "Approve & Repay"
                              : "Repay & Withdraw"}
                  </button>
                </div>
              )}
            </div>

            {/* Step 3: Create Loan */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <StepIndicator status={step3Status} />
                <div className="flex-1">
                  <div className="text-sm font-medium">3. Create Loan on yld.fi</div>
                  <div className="text-xs text-[var(--muted-foreground)]">
                    Use your cvxCRV as collateral on Curve LlamaLend
                  </div>
                </div>
              </div>

              {currentStep === 3 && step2Status === "complete" && (
                <div className="ml-9 space-y-3">
                  {repayTxHash && (
                    <div className="p-2 rounded bg-green-500/10 border border-green-500/30 text-green-500 text-xs flex items-center gap-2">
                      <Check size={12} />
                      Withdrew {fmtCvx(cvxCRVWithdrawAmount)} cvxCRV to your wallet.{" "}
                      <a
                        href={`https://etherscan.io/tx/${repayTxHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        View
                      </a>
                    </div>
                  )}

                  <button
                    onClick={handleCreateLoan}
                    className="w-full py-2.5 px-4 rounded-lg text-sm font-medium transition-all bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
                  >
                    Create Loan with cvxCRV
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
