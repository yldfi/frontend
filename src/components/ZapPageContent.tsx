"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useAccount, useBalance, useBlockNumber, useGasPrice } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { ArrowUpDown, ArrowRightLeft, Check, ChevronRight, ExternalLink, Route, RouteOff, X, Zap } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { TokenSelector } from "@/components/TokenSelector";
import { MaxButton } from "@/components/MaxButton";
import { ApprovalCard } from "@/components/ApprovalCard";
import { LoadingDots } from "@/components/LoadingDots";
import { RouteDisplay } from "@/components/RouteDisplay";
import { SlippageModal } from "@/components/SlippageModal";
import { SimulationModal } from "@/components/SimulationModal";

import { useUniversalZap } from "@/hooks/useUniversalZap";
import { useZapActions } from "@/hooks/useZapActions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { DEFAULT_ETH_TOKEN } from "@/hooks/useEnsoTokens";
import { useSettings } from "@/hooks/useSettings";
import { useTokenBalances } from "@/hooks/useTokenBalances";

import { ETH_ADDRESS, applyTokenDisplayOverride } from "@/lib/enso";
import { cn } from "@/lib/utils";
import { sanitizeAmount } from "@/lib/sanitize";
import { getMaxEthAmount } from "@/lib/eth-gas";
import { VAULTS } from "@/config/vaults";
import {
  getPendingTxCopy,
  getRevertedTxCopy,
  getSuccessTxCopy,
  isZapTxPendingVisible,
  TX_REVERTED_VISIBLE_MS,
  TX_SUCCESS_VISIBLE_MS,
} from "@/lib/transaction-ui";

import type { EnsoToken } from "@/types/enso";

const STORAGE_PREFIX = "yldfi-universal-zap";

// Default output: ycvxCRV vault (primary use case)
const DEFAULT_OUTPUT_TOKEN: EnsoToken = {
  address: VAULTS.ycvxcrv.address,
  chainId: 1,
  name: VAULTS.ycvxcrv.name,
  symbol: VAULTS.ycvxcrv.symbol,
  decimals: VAULTS.ycvxcrv.decimals,
  logoURI: VAULTS.ycvxcrv.logoSmall,
  type: "defi",
};

function loadToken(key: string, fallback: EnsoToken): EnsoToken {
  if (typeof window === "undefined") return fallback;
  try {
    const saved = sessionStorage.getItem(`${STORAGE_PREFIX}-${key}`);
    return saved ? applyTokenDisplayOverride(JSON.parse(saved) as EnsoToken) : fallback;
  } catch {
    return fallback;
  }
}

function saveToken(key: string, token: EnsoToken | null) {
  if (typeof window === "undefined") return;
  try {
    const storageKey = `${STORAGE_PREFIX}-${key}`;
    if (token) sessionStorage.setItem(storageKey, JSON.stringify(token));
    else sessionStorage.removeItem(storageKey);
  } catch {
    // ignore
  }
}

export function ZapPageContent() {
  const { address: userAddress, isConnected } = useAccount();
  const queryClient = useQueryClient();
  const { openConnectModal } = useConnectModal();
  const { data: gasPrice } = useGasPrice();
  const { data: currentBlock } = useBlockNumber({ watch: true });

  const {
    slippage,
    updateSlippage,
    showSlippageModal,
    setShowSlippageModal,
    showSimulationPreview,
    refreshSimulationPreview,
    showSimulationModal,
    setShowSimulationModal,
    showRoute,
    toggleRoute,
  } = useSettings();
  const [isSimulatingPreview, setIsSimulatingPreview] = useState(false);

  // Token state
  const [inputToken, setInputTokenState] = useState<EnsoToken>(() =>
    loadToken("input", DEFAULT_ETH_TOKEN),
  );
  const [outputToken, setOutputTokenState] = useState<EnsoToken>(() =>
    loadToken("output", DEFAULT_OUTPUT_TOKEN),
  );
  const [amount, setAmountState] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      return sanitizeAmount(sessionStorage.getItem(`${STORAGE_PREFIX}-amount`) ?? "");
    } catch {
      return "";
    }
  });

  const setInputToken = useCallback((t: EnsoToken) => {
    setInputTokenState(t);
    saveToken("input", t);
    setAmountState("");
    try { sessionStorage.removeItem(`${STORAGE_PREFIX}-amount`); } catch { /* ignore */ }
  }, []);

  const setOutputToken = useCallback((t: EnsoToken) => {
    setOutputTokenState(t);
    saveToken("output", t);
  }, []);

  const setAmount = useCallback((v: string) => {
    const sanitized = sanitizeAmount(v);
    setAmountState(sanitized);
    try {
      if (sanitized) sessionStorage.setItem(`${STORAGE_PREFIX}-amount`, sanitized);
      else sessionStorage.removeItem(`${STORAGE_PREFIX}-amount`);
    } catch {
      // ignore
    }
  }, []);

  const swapTokens = useCallback(() => {
    setInputTokenState(outputToken);
    setOutputTokenState(inputToken);
    saveToken("input", outputToken);
    saveToken("output", inputToken);
    setAmount("");
  }, [inputToken, outputToken, setAmount]);

  // Input balance — same source as TokenSelector (Enso API on mainnet, on-chain
  // multicall on test network) so the displayed balance stays consistent when
  // switching tokens. For the selected input token, prefer an on-chain read so
  // the balance updates immediately after a successful tx receipt.
  const isInputEth = inputToken.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const {
    balanceMap,
    refetch: refetchZapTokenBalances,
    refetchOnchain: refetchZapTokenBalancesOnchain,
  } = useTokenBalances([inputToken, outputToken], {
    preferOnchain: true,
  });
  const { data: ethBalance, refetch: refetchEthBalance } = useBalance({
    address: userAddress,
    query: { enabled: !!userAddress && isInputEth },
  });
  const inputBalanceRaw = isInputEth
    ? ethBalance?.value ?? 0n
    : balanceMap.get(inputToken.address.toLowerCase()) ?? 0n;
  const inputBalanceFormatted = formatUnits(inputBalanceRaw, inputToken.decimals);
  const inputMaxFormatted =
    isInputEth && ethBalance?.value
      ? getMaxEthAmount(ethBalance.value, gasPrice)
      : inputBalanceFormatted;
  const inputBalanceNum = parseFloat(inputBalanceFormatted) || 0;
  const refetchInputBalance = useCallback(() => {
    if (isInputEth) {
      void refetchEthBalance();
      return;
    }
    refetchZapTokenBalances();
    queryClient.invalidateQueries({ queryKey: ["onchain-balances"] });
    queryClient.invalidateQueries({ queryKey: ["enso-wallet-balances"] });
  }, [isInputEth, queryClient, refetchEthBalance, refetchZapTokenBalances]);

  useEffect(() => {
    if (!isConnected || !userAddress || !currentBlock) return;

    if (isInputEth) {
      refetchEthBalance();
      return;
    }

    refetchZapTokenBalancesOnchain();
  }, [currentBlock, isConnected, isInputEth, refetchEthBalance, refetchZapTokenBalancesOnchain, userAddress]);

  // Quote (debounced for rate-limit friendliness)
  const debouncedAmount = useDebouncedValue(amount, 500);
  const sameToken =
    inputToken.address.toLowerCase() === outputToken.address.toLowerCase();
  const { quote, isLoading: quoteLoading, error: quoteError } = useUniversalZap({
    inputToken,
    outputToken,
    inputAmount: debouncedAmount,
    slippage,
    paused: sameToken || showSimulationModal,
  });

  // Insufficient balance check (bigint precision)
  const hasInsufficientBalance = (() => {
    if (!amount || Number(amount) === 0) return false;
    try {
      const inputBigInt = parseUnits(amount, inputToken.decimals);
      return inputBigInt > inputBalanceRaw;
    } catch {
      return Number(amount) > inputBalanceNum;
    }
  })();

  // Actions (approval + execute)
  const {
    needsApproval,
    approve,
    executeZap,
    reset: resetActions,
    status,
    error: actionError,
    isLoading,
    isSuccess,
    isReverted,
    zapHash,
    pendingApproval,
    approvalProgress,
    isApproving,
    simulationResult,
  } = useZapActions(quote ?? null);

  const showApprovalCard = !!(
    pendingApproval &&
    (status === "needsApproval" || status === "approving" || status === "waitingApproval")
  );
  const [pendingTxDetails, setPendingTxDetails] = useState<{
    fromAmount: string;
    fromSymbol: string;
    fromLogo?: string;
    toAmount: string;
    toSymbol: string;
    toLogo?: string;
  } | null>(null);
  const [showTxSuccess, setShowTxSuccess] = useState<{
    show: boolean;
    hash: string;
  } | null>(null);
  const [showTxReverted, setShowTxReverted] = useState<{
    show: boolean;
    hash: string;
  } | null>(null);
  const completionResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCompletionResetTimer = useCallback(() => {
    if (completionResetTimerRef.current) {
      clearTimeout(completionResetTimerRef.current);
      completionResetTimerRef.current = null;
    }
  }, []);

  const resetCompletionState = useCallback(() => {
    clearCompletionResetTimer();
    setShowTxSuccess(null);
    setShowTxReverted(null);
    setPendingTxDetails(null);
    resetActions();
  }, [clearCompletionResetTimer, resetActions]);

  const buildPendingTxDetails = useCallback(() => {
    if (!quote) return null;

    return {
      fromAmount: amount ? Number(amount).toFixed(4) : "0.0000",
      fromSymbol: inputToken.symbol,
      fromLogo: inputToken.logoURI,
      toAmount: Number(quote.outputAmountFormatted).toFixed(4),
      toSymbol: outputToken.symbol,
      toLogo: outputToken.logoURI,
    };
  }, [amount, inputToken.logoURI, inputToken.symbol, outputToken.logoURI, outputToken.symbol, quote]);

  const stagePendingTxDetails = useCallback(() => {
    const txDetails = buildPendingTxDetails();
    if (txDetails) {
      setPendingTxDetails(txDetails);
    }
  }, [buildPendingTxDetails]);

  // Reset stale approval state on input change
  useEffect(() => {
    if (status === "needsApproval") resetActions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputToken.address, outputToken.address, debouncedAmount]);

  // Toast on action error
  useEffect(() => {
    if (actionError) {
      console.log("[TOAST ERROR] universal-zap actionError:", actionError);
      toast.error(actionError);
      setTimeout(() => setPendingTxDetails(null), 0);
    }
  }, [actionError]);

  const prevSimulationResultRef = useRef<typeof simulationResult>(null);
  useEffect(() => {
    if (
      showSimulationPreview &&
      simulationResult &&
      !prevSimulationResultRef.current &&
      status === "idle" &&
      !showSimulationModal
    ) {
      setShowSimulationModal(true);
    }
    prevSimulationResultRef.current = simulationResult;
  }, [showSimulationPreview, simulationResult, status, showSimulationModal, setShowSimulationModal]);

  const runSimulationPreview = useCallback(async () => {
    if (!quote) return null;
    setIsSimulatingPreview(true);
    try {
      const result = await executeZap({ previewOnly: true });
      if (result) {
        setShowSimulationModal(true);
      }
      return result;
    } finally {
      setIsSimulatingPreview(false);
    }
  }, [quote, executeZap, setShowSimulationModal]);

  const handleExecuteZap = useCallback(async () => {
    clearCompletionResetTimer();
    setShowTxSuccess(null);
    setShowTxReverted(null);
    if (showSimulationPreview) {
      const result = await runSimulationPreview();
      if (result) return;
      if (needsApproval()) return;
    }
    stagePendingTxDetails();
    await executeZap();
  }, [clearCompletionResetTimer, executeZap, needsApproval, runSimulationPreview, showSimulationPreview, stagePendingTxDetails]);

  useEffect(() => {
    return () => clearCompletionResetTimer();
  }, [clearCompletionResetTimer]);

  // Completion handling
  const lastHandledHashRef = useRef<string | null>(null);
  useEffect(() => {
    const complete = isSuccess || isReverted;
    if (!complete || !zapHash || zapHash === lastHandledHashRef.current) return;
    lastHandledHashRef.current = zapHash;
    refetchInputBalance();

    if (isSuccess) {
      setTimeout(() => {
        setShowTxSuccess({ show: true, hash: zapHash });
        setShowTxReverted(null);
      }, 0);
      toast.success("Zap successful!", {
        action: {
          label: "View",
          onClick: () => window.open(`https://etherscan.io/tx/${zapHash}`, "_blank"),
        },
      });
      setTimeout(() => setAmount(""), 0);
    } else if (isReverted) {
      setTimeout(() => {
        setShowTxReverted({ show: true, hash: zapHash });
        setShowTxSuccess(null);
      }, 0);
      toast.error("Zap failed — transaction reverted", {
        action: {
          label: "View",
          onClick: () => window.open(`https://etherscan.io/tx/${zapHash}`, "_blank"),
        },
      });
    }

    // Keep completion visible long enough for wallet app handoffs.
    clearCompletionResetTimer();
    completionResetTimerRef.current = setTimeout(
      resetCompletionState,
      isSuccess ? TX_SUCCESS_VISIBLE_MS : TX_REVERTED_VISIBLE_MS,
    );
  }, [clearCompletionResetTimer, isSuccess, isReverted, zapHash, refetchInputBalance, resetCompletionState, setAmount]);

  // Error display
  const noRoute = !quoteLoading && !!quoteError && !!amount && Number(amount) > 0;
  const isPendingTx = isZapTxPendingVisible(status) && !isSimulatingPreview && !showSimulationModal;
  const isZapSuccessVisible = !!showTxSuccess?.show;
  const isZapRevertedVisible = !!showTxReverted?.show;
  const isTxStateVisible = isPendingTx || isZapSuccessVisible || isZapRevertedVisible;
  const pendingCopy = getPendingTxCopy(Boolean(zapHash), "zap");
  const successCopy = getSuccessTxCopy("zap");
  const revertedCopy = getRevertedTxCopy("zap");

  return (
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      <Header />

      <main className="flex-1 pt-16" style={{ paddingTop: "calc(4rem + var(--test-banner-height))" }}>
        <div className="border-b border-[var(--border)]">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
            <nav className="flex items-center gap-2 text-sm">
              <Link
                href="/"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              >
                yld Vaults
              </Link>
              <ChevronRight size={14} className="text-[var(--muted-foreground)]" />
              <span className="text-[var(--foreground)]">Zap</span>
            </nav>
          </div>
        </div>

        <div className="max-w-xl mx-auto px-4 sm:px-6 py-8">
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-2">
              <Zap className="w-6 h-6" />
              <h1 className="text-2xl font-semibold tracking-tight">Zap</h1>
            </div>
            <p className="text-sm text-[var(--muted-foreground)]">
              Swap between any tokens in one transaction.
            </p>
          </div>

          <div className="relative">
          <div className="border border-[var(--border)] rounded-xl p-5 space-y-4">
            {!isTxStateVisible && (
              <>
                {/* Input */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-[var(--muted-foreground)]">From</span>
                    <span className="text-xs mono text-[var(--muted-foreground)]">
                      {inputBalanceNum.toFixed(4)}
                    </span>
                  </div>
                  <div className="bg-[var(--muted)] border border-[var(--border)] rounded-lg p-3 flex items-center gap-2 focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                      className="flex-1 min-w-0 bg-transparent mono text-base outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
                    />
                    <TokenSelector
                      selectedToken={inputToken}
                      onSelect={setInputToken}
                      excludeTokens={[outputToken.address]}
                      preferOnchainBalances
                    />
                    <MaxButton balance={inputMaxFormatted} onSelect={setAmount} />
                  </div>
                </div>

                {/* Swap direction button */}
                <div className="flex justify-center -my-2">
                  <button
                    onClick={swapTokens}
                    className="w-8 h-8 rounded-full bg-[var(--muted)] border border-[var(--border)] flex items-center justify-center hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
                    aria-label="Swap input and output"
                  >
                    <ArrowUpDown size={14} />
                  </button>
                </div>

                {/* Output */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-[var(--muted-foreground)]">To</span>
                  </div>
                  <div className="bg-[var(--muted)] border border-[var(--border)] rounded-lg p-3 flex items-center gap-2">
                    <span className="mono text-base text-[var(--foreground)] flex-1">
                      {quoteLoading
                        ? "—"
                        : quote
                        ? Number(quote.outputAmountFormatted).toFixed(4)
                        : "0.00"}
                    </span>
                    <TokenSelector
                      selectedToken={outputToken}
                      onSelect={setOutputToken}
                      excludeTokens={[inputToken.address]}
                      preferOnchainBalances
                    />
                  </div>
                </div>

                {/* Details */}
                <div className={cn("space-y-2 text-sm", !quote && "invisible")}>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-[var(--muted-foreground)]">Rate</span>
                    {quote ? (
                      <span className="mono flex items-center gap-1">
                        1 {inputToken.symbol} = {quote.exchangeRate.toFixed(4)} {outputToken.symbol}
                        <ArrowRightLeft size={12} className="text-[var(--muted-foreground)]" />
                      </span>
                    ) : (
                      <span className="mono">—</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-[var(--muted-foreground)]">Price Impact</span>
                    <span
                      className={cn(
                        "mono",
                        quote && (quote.priceImpact ?? 0) < 0
                          ? "text-green-500"
                          : quote && (quote.priceImpact ?? 0) > 2
                          ? "text-[var(--destructive)]"
                          : quote && (quote.priceImpact ?? 0) > 1
                          ? "text-[var(--warning)]"
                          : "",
                      )}
                    >
                      {quote?.priceImpact != null ? `${quote.priceImpact.toFixed(2)}%` : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-[var(--muted-foreground)]">Value</span>
                    <span className="mono">
                      {quote?.outputUsdValue != null
                        ? `~$${quote.outputUsdValue.toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}`
                        : "—"}
                    </span>
                  </div>
                </div>
              </>
            )}

            {isTxStateVisible ? (
              <>
                {isPendingTx && (
                  <div className="flex flex-col items-center justify-center py-12 text-center animate-in fade-in duration-300">
                    <div className="w-16 h-16 rounded-full bg-[var(--muted)] flex items-center justify-center mb-4">
                      <LoadingDots />
                    </div>
                    <h3 className="text-lg font-medium mb-2">{pendingCopy.title}</h3>
                    {pendingTxDetails && (
                      <div className="flex items-center gap-2 mb-3 px-4 py-2 bg-[var(--muted)] rounded-lg max-w-full">
                        {pendingTxDetails.fromLogo ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={pendingTxDetails.fromLogo} alt={pendingTxDetails.fromSymbol} className="w-5 h-5 rounded-full" />
                        ) : null}
                        <span className="mono text-sm truncate">
                          {pendingTxDetails.fromAmount} {pendingTxDetails.fromSymbol}
                        </span>
                        <ArrowRightLeft size={14} className="text-[var(--muted-foreground)] shrink-0" />
                        {pendingTxDetails.toLogo ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={pendingTxDetails.toLogo} alt={pendingTxDetails.toSymbol} className="w-5 h-5 rounded-full" />
                        ) : null}
                        <span className="mono text-sm truncate">
                          {pendingTxDetails.toAmount} {pendingTxDetails.toSymbol}
                        </span>
                      </div>
                    )}
                    <p className="text-sm text-[var(--muted-foreground)] max-w-xs mb-4">
                      {pendingCopy.message}
                    </p>
                    {zapHash && (
                      <a
                        href={`https://etherscan.io/tx/${zapHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm text-[var(--foreground)] hover:text-[var(--accent)] transition-colors mono"
                      >
                        View on Etherscan
                        <ExternalLink size={14} />
                      </a>
                    )}
                  </div>
                )}

                {isZapSuccessVisible && (
                  <div className="flex flex-col items-center justify-center py-16 text-center animate-in fade-in zoom-in-95 duration-300">
                    <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mb-4">
                      <Check className="w-8 h-8 text-green-500" />
                    </div>
                    <h3 className="text-lg font-medium mb-2 text-green-500">{successCopy.title}</h3>
                    <p className="text-sm text-[var(--muted-foreground)] max-w-xs mb-4">
                      {successCopy.message}
                    </p>
                    <a
                      href={`https://etherscan.io/tx/${showTxSuccess?.hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm text-[var(--foreground)] hover:text-[var(--accent)] transition-colors mono"
                    >
                      View on Etherscan
                      <ExternalLink size={14} />
                    </a>
                    <button
                      type="button"
                      onClick={resetCompletionState}
                      className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--muted)] transition-colors"
                    >
                      <Zap size={14} />
                      New zap
                    </button>
                  </div>
                )}

                {isZapRevertedVisible && (
                  <div className="flex flex-col items-center justify-center py-16 text-center animate-in fade-in zoom-in-95 duration-300">
                    <div className="w-16 h-16 rounded-full bg-[var(--destructive)]/20 flex items-center justify-center mb-4">
                      <X className="w-8 h-8 text-[var(--destructive)]" />
                    </div>
                    <h3 className="text-lg font-medium mb-2 text-[var(--destructive)]">{revertedCopy.title}</h3>
                    <p className="text-sm text-[var(--muted-foreground)] max-w-xs mb-4">
                      {revertedCopy.message}
                    </p>
                    <a
                      href={`https://etherscan.io/tx/${showTxReverted?.hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm text-[var(--foreground)] hover:text-[var(--accent)] transition-colors mono"
                    >
                      View on Etherscan
                      <ExternalLink size={14} />
                    </a>
                    <button
                      type="button"
                      onClick={resetCompletionState}
                      className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--muted)] transition-colors"
                    >
                      <ArrowRightLeft size={14} />
                      Try again
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Approval */}
                <ApprovalCard
                  show={showApprovalCard}
                  pendingApproval={pendingApproval}
                  approvalProgress={approvalProgress}
                  decimals={inputToken.decimals ?? 18}
                  isApproving={isApproving}
                  onApprove={(exact) => approve(exact)}
                />

                {/* Execute button */}
                {isConnected ? (
                  <button
                    onClick={handleExecuteZap}
                    disabled={
                      showApprovalCard ||
                      !quote ||
                      isLoading ||
                      quoteLoading ||
                      isSimulatingPreview ||
                      showSimulationModal ||
                      hasInsufficientBalance ||
                      sameToken ||
                      noRoute
                    }
                    className={cn(
                      "w-full py-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-base",
                      showApprovalCard ||
                        !quote ||
                        isLoading ||
                        quoteLoading ||
                        isSimulatingPreview ||
                        showSimulationModal ||
                        (amount && hasInsufficientBalance) ||
                        sameToken ||
                        noRoute
                        ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                      : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 cursor-pointer",
                    )}
                  >
                    {isSimulatingPreview || showSimulationModal ? (
                      <>Simulating<LoadingDots /></>
                    ) : status === "waitingApproval" ? (
                      <>Waiting for approval<LoadingDots /></>
                    ) : isLoading ? (
                      <>Confirm in wallet<LoadingDots /></>
                    ) : quoteLoading ? (
                      <>Getting quote<LoadingDots /></>
                    ) : sameToken ? (
                      "Select different tokens"
                    ) : !amount || Number(amount) === 0 ? (
                      "Enter amount"
                    ) : hasInsufficientBalance ? (
                      "Insufficient balance"
                    ) : noRoute || !quote ? (
                      "No route found"
                    ) : (
                      needsApproval() ? "Approve & zap" : "Zap"
                    )}
                  </button>
                ) : (
                  <button
                    onClick={openConnectModal}
                    className="w-full py-4 bg-[var(--foreground)] text-[var(--background)] rounded-lg font-medium hover:opacity-90 transition-all cursor-pointer"
                  >
                    Connect Wallet
                  </button>
                )}

                {/* Attribution + settings */}
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
                </div>

                {/* Inline route display — mobile only */}
                <div
                  className="lg:hidden grid transition-[grid-template-rows] duration-300 ease-in-out"
                  style={{
                    gridTemplateRows:
                      showRoute && amount && Number(amount) > 0 && (quote || quoteLoading)
                        ? "1fr"
                        : "0fr",
                  }}
                >
                  <div className="overflow-hidden">
                    <div className="pt-3 mt-3 border-t border-[var(--border)]">
                      <div className="text-xs text-[var(--muted-foreground)] mb-2">Route</div>
                      <RouteDisplay
                        routeInfo={quote?.routeInfo}
                        inputSymbol={inputToken.symbol}
                        outputSymbol={outputToken.symbol}
                        inputAmount={amount ? Number(amount).toFixed(4) : undefined}
                        outputAmount={
                          quote?.outputAmountFormatted
                            ? Number(quote.outputAmountFormatted).toFixed(4)
                            : undefined
                        }
                        isLoading={quoteLoading}
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Desktop-only route panel — slides out to the right of the main card */}
          <aside
            className={cn(
              "hidden lg:block absolute top-0 left-full ml-6 w-[360px]",
              "transition-[opacity,transform] duration-500 ease-out",
              showRoute && !isTxStateVisible && amount && Number(amount) > 0 && (quote || quoteLoading)
                ? "opacity-100 translate-x-0"
                : "opacity-0 -translate-x-4 pointer-events-none",
            )}
            aria-hidden={!(showRoute && !isTxStateVisible && amount && Number(amount) > 0 && (quote || quoteLoading))}
          >
            <div className="border border-[var(--border)] rounded-xl p-5">
              <div className="text-xs text-[var(--muted-foreground)] uppercase tracking-wider mb-3">
                Route
              </div>
              <RouteDisplay
                routeInfo={quote?.routeInfo}
                inputSymbol={inputToken.symbol}
                outputSymbol={outputToken.symbol}
                inputAmount={amount ? Number(amount).toFixed(4) : undefined}
                outputAmount={
                  quote?.outputAmountFormatted
                    ? Number(quote.outputAmountFormatted).toFixed(4)
                    : undefined
                }
                isLoading={quoteLoading}
              />
            </div>
          </aside>
          </div>
        </div>
      </main>

      <Footer />

      <SlippageModal
        open={showSlippageModal}
        onClose={() => {
          setShowSlippageModal(false);
          refreshSimulationPreview();
        }}
        slippage={slippage}
        onSlippageChange={updateSlippage}
        title="Zap Settings"
      />

      {showSimulationModal && simulationResult && (
        <SimulationModal
          isOpen={showSimulationModal}
          onClose={() => setShowSimulationModal(false)}
          onConfirm={() => {
            setShowSimulationModal(false);
            stagePendingTxDetails();
            executeZap({ skipSimulation: true });
          }}
          simulationResult={{
            success: simulationResult.success,
            gasUsed: simulationResult.gasUsed ?? null,
            errorMessage: simulationResult.errorMessage ?? null,
            tenderlyUrl: simulationResult.tenderlyUrl ?? null,
            assetChanges: simulationResult.assetChanges,
            simulationUnavailable: simulationResult.simulationUnavailable,
            simulationUnavailableReason: simulationResult.simulationUnavailableReason,
          }}
          gasPrice={gasPrice}
          routePriceImpact={quote?.priceImpact ?? null}
          confirmText="Confirm Zap"
        />
      )}
    </div>
  );
}
