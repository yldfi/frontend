"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useAccount, useBalance, useBlockNumber, useGasPrice } from "wagmi";
import { parseUnits, formatUnits, isAddress } from "viem";
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
import { PriceImpactConfirmModal } from "@/components/PriceImpactConfirmModal";
import { TxPendingCard } from "@/components/TxPendingCard";

import { useUniversalZap } from "@/hooks/useUniversalZap";
import { useZapActions } from "@/hooks/useZapActions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useIdle } from "@/hooks/useIdle";
import { useQuoteGuards } from "@/hooks/useQuoteGuards";
import { DEFAULT_ETH_TOKEN } from "@/hooks/useEnsoTokens";
import { useSettings } from "@/hooks/useSettings";
import { useTokenBalances } from "@/hooks/useTokenBalances";

import { ETH_ADDRESS, applyKnownTokenMetadata, getCustomTokenMetadata } from "@/lib/enso";
import { cn, formatDisplayAmount } from "@/lib/utils";
import { parseQuoteError } from "@/lib/quote-errors";
import { QUOTE_IDLE_MS } from "@/lib/quote-freshness";
import { aboveMarketWarning, priceImpactClassName } from "@/lib/price-impact";
import { isSameAmount, sanitizeAmount } from "@/lib/sanitize";
import { fillMissingSimulationUsd } from "@/lib/simulation-pricing";
import { getMaxEthAmount } from "@/lib/eth-gas";
import { TOKENS, VAULTS, isVaultEntryDisabled } from "@/config/vaults";
import {
  getPendingTxCopy,
  getRevertedTxCopy,
  getSuccessTxCopy,
  getTxActionLabel,
  isZapTxPendingVisible,
  TX_REVERTED_VISIBLE_MS,
  TX_SUCCESS_VISIBLE_MS,
  type TxActionKind,
  type TxAssetDetails,
} from "@/lib/transaction-ui";

import type { EnsoToken } from "@/types/enso";

// Versioned: entries written by an older build trusted token metadata from a
// URL, so nothing under the previous prefix is ever read again.
const STORAGE_PREFIX = "yldfi-universal-zap-v2";


const ENTRY_DISABLED_VAULT_ADDRESSES = Object.values(VAULTS)
  .filter(isVaultEntryDisabled)
  .map((vault) => vault.address.toLowerCase());

function isEntryDisabledOutput(address: string): boolean {
  return ENTRY_DISABLED_VAULT_ADDRESSES.includes(address.toLowerCase());
}

// Default output: active cvxCRV strategy vault. ycvxCRV is deprecated for new UI entry.
const DEFAULT_OUTPUT_TOKEN: EnsoToken = {
  address: VAULTS.yscvxcrv.address,
  chainId: 1,
  name: VAULTS.yscvxcrv.name,
  symbol: VAULTS.yscvxcrv.symbol,
  decimals: VAULTS.yscvxcrv.decimals,
  logoURI: VAULTS.yscvxcrv.logoSmall,
  type: "defi",
};

const IMPORTED_TOKENS_STORAGE_KEY = "yldfi-imported-tokens";

// Tokens a /zap deep link may select even though they are not in the
// built-in custom token list. Metadata lives here, never in the URL: a link
// must not be able to choose the symbol, decimals or logo shown for an address.
const DEEP_LINK_TOKENS: Record<string, EnsoToken> = {
  [TOKENS.CVX.toLowerCase()]: {
    address: TOKENS.CVX,
    chainId: 1,
    name: "Convex Token",
    symbol: "CVX",
    decimals: 18,
    logoURI: "/tokens/cvx.png",
    type: "base",
  },
};

// Read the same storage the imported-token hook uses without calling the hook:
// loadToken runs outside React as part of the initial state.
function loadImportedToken(address: string): EnsoToken | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const stored = localStorage.getItem(IMPORTED_TOKENS_STORAGE_KEY);
    if (!stored) return undefined;
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return undefined;
    const lower = address.toLowerCase();
    return parsed.find(
      (token: unknown): token is EnsoToken =>
        typeof token === "object" &&
        token !== null &&
        typeof (token as { address?: unknown }).address === "string" &&
        (token as { address: string }).address.toLowerCase() === lower,
    );
  } catch {
    return undefined;
  }
}

// Shape check only: an entry under the versioned prefix was written by this
// build from a token the user picked, so its metadata can be shown. A URL
// never writes here.
function toStoredToken(parsed: unknown): EnsoToken | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.address !== "string" || !isAddress(candidate.address)) return undefined;
  if (
    typeof candidate.symbol !== "string" ||
    candidate.symbol.length === 0 ||
    candidate.symbol.length > 32
  ) {
    return undefined;
  }
  const decimals = candidate.decimals;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return undefined;
  }
  if (candidate.chainId !== undefined && candidate.chainId !== 1) return undefined;
  return {
    address: candidate.address,
    chainId: 1,
    name: typeof candidate.name === "string" && candidate.name ? candidate.name : candidate.symbol,
    symbol: candidate.symbol,
    decimals,
    logoURI: typeof candidate.logoURI === "string" ? candidate.logoURI : undefined,
    type: candidate.type === "defi" ? "defi" : "base",
  };
}

// A rejected entry must not leave an amount behind: applying a stored amount to
// a different token would quote a number the user never typed for it.
function clearStoredAmount() {
  try {
    sessionStorage.removeItem(`${STORAGE_PREFIX}-amount`);
  } catch {
    // ignore
  }
}

function loadToken(key: string, fallback: EnsoToken): EnsoToken {
  const normalizedFallback = applyKnownTokenMetadata(fallback);
  if (typeof window === "undefined") return normalizedFallback;
  try {
    const saved = sessionStorage.getItem(`${STORAGE_PREFIX}-${key}`);
    if (!saved) return normalizedFallback;
    const stored = toStoredToken(JSON.parse(saved));
    if (!stored) {
      clearStoredAmount();
      return normalizedFallback;
    }
    // The user's imported entry keeps describing the token, as before.
    const imported = loadImportedToken(stored.address);
    return applyKnownTokenMetadata(imported ?? stored);
  } catch {
    clearStoredAmount();
    return normalizedFallback;
  }
}

type RequestedToken = {
  token: EnsoToken;
  unresolved: boolean;
};

function loadRequestedToken(key: "input" | "output", fallback: EnsoToken): RequestedToken {
  if (typeof window === "undefined") return { token: fallback, unresolved: false };
  const searchParams = new URLSearchParams(window.location.search);
  if (!searchParams.has(key)) return { token: fallback, unresolved: false };
  const requestedAddress = searchParams.get(key) ?? "";
  if (!isAddress(requestedAddress)) return { token: fallback, unresolved: true };
  const knownToken =
    getCustomTokenMetadata(requestedAddress) ?? DEEP_LINK_TOKENS[requestedAddress.toLowerCase()];
  // Unknown address: keep the fallback. The user can still add the token
  // through the selector, which asks for confirmation first.
  return knownToken
    ? { token: applyKnownTokenMetadata(knownToken), unresolved: false }
    : { token: fallback, unresolved: true };
}

function hasRequestedPair(): boolean {
  if (typeof window === "undefined") return false;
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.has("input") || searchParams.has("output");
}

function loadRequestedOutputAmount(): string {
  if (typeof window === "undefined") return "";
  const amount = new URLSearchParams(window.location.search).get("outputAmount")?.trim() ?? "";
  // URL targets must be positive decimals, not editable input to sanitize.
  // In particular, "0" would keep quote calibration waiting forever.
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(amount) && Number.isFinite(Number(amount)) && Number(amount) > 0
    ? amount
    : "";
}

function saveToken(key: string, token: EnsoToken | null) {
  if (typeof window === "undefined") return;
  try {
    const storageKey = `${STORAGE_PREFIX}-${key}`;
    if (token) sessionStorage.setItem(storageKey, JSON.stringify(applyKnownTokenMetadata(token)));
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
  const [rateInverted, setRateInverted] = useState(false);
  const [requestedInput] = useState(() =>
    loadRequestedToken("input", loadToken("input", DEFAULT_ETH_TOKEN)),
  );
  const [requestedOutput] = useState(() =>
    loadRequestedToken("output", loadToken("output", DEFAULT_OUTPUT_TOKEN)),
  );
  // An address the link names but the app cannot resolve makes the whole pair
  // inapplicable: do not force an amount or apply its requested output amount.
  const requestedPairUnresolved = requestedInput.unresolved || requestedOutput.unresolved;
  const [requestedOutputAmount] = useState(() =>
    requestedPairUnresolved ? "" : loadRequestedOutputAmount(),
  );
  const [targetQuoteAdjustments, setTargetQuoteAdjustments] = useState(0);

  // Token state
  const [inputToken, setInputTokenState] = useState<EnsoToken>(requestedInput.token);
  const [outputToken, setOutputTokenState] = useState<EnsoToken>(requestedOutput.token);
  const [amount, setAmountState] = useState(() => {
    if (typeof window === "undefined") return "";
    if (requestedOutputAmount) return "1";
    if (!requestedPairUnresolved && hasRequestedPair()) return "1";
    try {
      return sanitizeAmount(sessionStorage.getItem(`${STORAGE_PREFIX}-amount`) ?? "");
    } catch {
      return "";
    }
  });

  const unresolvedLinkToastShown = useRef(false);
  useEffect(() => {
    if (!requestedPairUnresolved || unresolvedLinkToastShown.current) return;
    unresolvedLinkToastShown.current = true;
    toast.info("This link names a token the app doesn't recognise. Pick it in the token selector.");
  }, [requestedPairUnresolved]);

  const setInputToken = useCallback((t: EnsoToken) => {
    const token = applyKnownTokenMetadata(t);
    setInputTokenState(token);
    saveToken("input", token);
    setAmountState("");
    try { sessionStorage.removeItem(`${STORAGE_PREFIX}-amount`); } catch { /* ignore */ }
  }, []);

  const setOutputToken = useCallback((t: EnsoToken) => {
    const token = applyKnownTokenMetadata(t);
    setOutputTokenState(token);
    saveToken("output", token);
  }, []);

  const setAmount = useCallback((v: string) => {
    const sanitized = sanitizeAmount(v);
    setAmountState(sanitized);
    setShowSimulationModal(false);
    try {
      if (sanitized) sessionStorage.setItem(`${STORAGE_PREFIX}-amount`, sanitized);
      else sessionStorage.removeItem(`${STORAGE_PREFIX}-amount`);
    } catch {
      // ignore
    }
  }, [setShowSimulationModal]);

  useEffect(() => {
    if (!isEntryDisabledOutput(outputToken.address)) return;
    const timer = setTimeout(() => {
      setOutputTokenState(applyKnownTokenMetadata(DEFAULT_OUTPUT_TOKEN));
      saveToken("output", DEFAULT_OUTPUT_TOKEN);
    }, 0);
    return () => clearTimeout(timer);
  }, [outputToken.address]);

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
    // Only balanceMap is used here; the quote fetches its own prices.
    fetchPrices: false,
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

  // An action held back until the user types CONFIRM for a high-price-impact quote.
  const [pendingImpactAction, setPendingImpactAction] = useState<{ label: string; run: () => void } | null>(null);

  // Quote (debounced for rate-limit friendliness)
  const debouncedAmount = useDebouncedValue(amount, 500);
  const sameToken =
    inputToken.address.toLowerCase() === outputToken.address.toLowerCase();
  // Stop the 60 s re-quote loop after 3 idle minutes: an open tab otherwise
  // spends ~2,000+ Enso credits an hour. Hidden tabs are already paused by
  // React Query (refetchIntervalInBackground is off).
  const isIdle = useIdle(QUOTE_IDLE_MS);
  const {
    quote: rawQuote,
    quoteUpdatedAt,
    isLoading: quoteLoading,
    error: quoteError,
    refetch: refetchQuote,
  } = useUniversalZap({
    inputToken,
    outputToken,
    inputAmount: debouncedAmount,
    slippage,
    paused: sameToken || showSimulationModal || isSimulatingPreview || pendingImpactAction !== null,
    autoRefresh: !isIdle,
  });
  const quoteIsCurrent = !!(
    rawQuote &&
    amount &&
    amount === debouncedAmount &&
    isSameAmount(rawQuote.inputAmount, debouncedAmount, inputToken.decimals) &&
    rawQuote.inputToken.address.toLowerCase() === inputToken.address.toLowerCase()
  );
  const currentQuote = quoteIsCurrent ? rawQuote : null;
  const targetQuoteNeedsAdjustment = !!(
    requestedOutputAmount &&
    currentQuote &&
    targetQuoteAdjustments < 2 &&
    Math.abs(Number(currentQuote.outputAmountFormatted) - Number(requestedOutputAmount)) / Number(requestedOutputAmount) > 0.001
  );
  const quote = currentQuote && !targetQuoteNeedsAdjustment ? currentQuote : null;
  const quoteSettling = !!amount && (
    amount !== debouncedAmount ||
    quoteLoading ||
    (!!rawQuote && !quoteIsCurrent) ||
    targetQuoteNeedsAdjustment
  );

  const { isQuoteTooOld, refreshIfQuoteTooOld, handleStaleQuote, guardHighImpact } = useQuoteGuards({
    quoteUpdatedAt,
    refetch: refetchQuote,
    isIdle,
    priceImpact: quote?.priceImpact,
    setPendingImpactAction,
  });

  useEffect(() => {
    if (!requestedOutputAmount || !quoteIsCurrent || !rawQuote || targetQuoteAdjustments >= 2) return;
    const target = Number(requestedOutputAmount);
    const quotedOutput = Number(rawQuote.outputAmountFormatted);
    const quotedInput = Number(amount);
    if (!Number.isFinite(target) || !Number.isFinite(quotedOutput) || !Number.isFinite(quotedInput) || target <= 0 || quotedOutput <= 0 || quotedInput <= 0) return;
    if (Math.abs(quotedOutput - target) / target <= 0.001) return;

    // Token swap quotes are locally linear enough for this ratio to converge in
    // one or two passes; the final executable quote still supplies slippage protection.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTargetQuoteAdjustments((count) => count + 1);
    setAmount((quotedInput * target / quotedOutput).toPrecision(12).replace(/\.?0+$/, ""));
  }, [amount, quoteIsCurrent, rawQuote, requestedOutputAmount, setAmount, targetQuoteAdjustments]);

  const swapTokens = useCallback(() => {
    if (isEntryDisabledOutput(inputToken.address)) {
      toast.error(`New ${inputToken.symbol} entry is hidden in the UI. Exchange to yscvxCRV instead.`);
      return;
    }
    setInputTokenState(outputToken);
    setOutputTokenState(inputToken);
    saveToken("input", outputToken);
    saveToken("output", inputToken);
    setAmount(quote?.outputAmountFormatted ?? amount);
  }, [amount, inputToken, outputToken, quote?.outputAmountFormatted, setAmount]);

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
    isSimulationForCurrentQuote,
    safePending,
    batchesApproval,
  } = useZapActions(quote ?? null, { quoteUpdatedAt, onStaleQuote: handleStaleQuote });

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
  // Action kind captured at submit: the live quote is cleared once the amount resets on success.
  const [submittedActionKind, setSubmittedActionKind] = useState<TxActionKind | null>(null);

  // DEBUG (dev only) — TX State Preview panel. Mirrors VaultPageContent.
  type DebugTxState = "none" | "deposit-pending" | "deposit-success" | "deposit-reverted" | "withdraw-pending" | "withdraw-success" | "withdraw-reverted" | "swap-pending" | "swap-success" | "swap-reverted";
  const [debugTxState, setDebugTxState] = useState<DebugTxState>("none");
  const [debugPanelPos, setDebugPanelPos] = useState<{ x: number; y: number } | null>(() => {
    if (typeof window === "undefined") return null;
    try { return localStorage.getItem("yldfi-zap-debug-panel-pos") ? JSON.parse(localStorage.getItem("yldfi-zap-debug-panel-pos")!) : null; } catch { return null; }
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [debugMinimized, setDebugMinimized] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("yldfi-zap-tx-preview-minimized") === "true"; } catch { return false; }
  });
  const toggleDebugMinimized = useCallback(() => {
    setDebugMinimized(prev => {
      const next = !prev;
      try { localStorage.setItem("yldfi-zap-tx-preview-minimized", String(next)); } catch {}
      return next;
    });
  }, []);

  // Drag handlers for debug panel
  const handleDebugDragStart = useCallback((e: React.MouseEvent) => {
    const panel = (e.target as HTMLElement).closest("[data-debug-panel]") as HTMLElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setIsDragging(true);
  }, []);

  const handleDebugDrag = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    setDebugPanelPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y });
  }, [isDragging]);

  const handleDebugDragEnd = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);
    if (debugPanelPos) {
      try { localStorage.setItem("yldfi-zap-debug-panel-pos", JSON.stringify(debugPanelPos)); } catch {}
    }
  }, [isDragging, debugPanelPos]);

  useEffect(() => {
    if (!isDragging) return;
    window.addEventListener("mousemove", handleDebugDrag);
    window.addEventListener("mouseup", handleDebugDragEnd);
    return () => {
      window.removeEventListener("mousemove", handleDebugDrag);
      window.removeEventListener("mouseup", handleDebugDragEnd);
    };
  }, [isDragging, handleDebugDrag, handleDebugDragEnd]);

  const isDebugActive = debugTxState !== "none";
  const isDebugPending = debugTxState.endsWith("-pending");
  const isDebugSuccess = debugTxState.endsWith("-success");
  const isDebugReverted = debugTxState.endsWith("-reverted");
  const isDebugDeposit = debugTxState.startsWith("deposit-");
  const isDebugWithdraw = debugTxState.startsWith("withdraw-");
  const isDebugSwap = debugTxState.startsWith("swap-");
  const debugHash = isDebugActive ? `0x${"a".repeat(62)}` : undefined;

  // Fixed asset details for the debug preview states
  const debugTxDetails: TxAssetDetails | null = isDebugDeposit
    ? { fromAmount: "1,000.0000", fromSymbol: "crvUSD", fromLogo: "/tokens/crvusd.png", toAmount: "0.5250", toSymbol: "ysCVX", toLogo: "/tokens/yscvx.png" }
    : isDebugWithdraw
      ? { fromAmount: "0.5250", fromSymbol: "ysCVX", fromLogo: "/tokens/yscvx.png", toAmount: "1,000.0000", toSymbol: "crvUSD", toLogo: "/tokens/crvusd.png" }
      : isDebugSwap
        ? { fromAmount: "1,000.0000", fromSymbol: "crvUSD", fromLogo: "/tokens/crvusd.png", toAmount: "157.2043", toSymbol: "CVX", toLogo: "/tokens/cvx.png" }
        : null;

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
    setSubmittedActionKind(null);
    resetActions();
  }, [clearCompletionResetTimer, resetActions]);

  const buildPendingTxDetails = useCallback(() => {
    if (!quote) return null;

    return {
      fromAmount: amount ? formatDisplayAmount(amount) : "0.0000",
      fromSymbol: inputToken.symbol,
      fromLogo: inputToken.logoURI,
      toAmount: formatDisplayAmount(quote.outputAmountFormatted),
      toSymbol: outputToken.symbol,
      toLogo: outputToken.logoURI,
    };
  }, [amount, inputToken.logoURI, inputToken.symbol, outputToken.logoURI, outputToken.symbol, quote]);

  const stagePendingTxDetails = useCallback(() => {
    const txDetails = buildPendingTxDetails();
    if (txDetails) {
      setPendingTxDetails(txDetails);
    }
    setSubmittedActionKind(quote?.directVault?.action ?? "zap");
  }, [buildPendingTxDetails, quote]);

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
      return;
    }
    stagePendingTxDetails();
    await executeZap();
  }, [clearCompletionResetTimer, executeZap, runSimulationPreview, showSimulationPreview, stagePendingTxDetails]);

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
      toast.success(`${getTxActionLabel(submittedActionKind ?? "zap")} successful!`, {
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
      toast.error(`${getTxActionLabel(submittedActionKind ?? "zap")} failed — transaction reverted`, {
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
  }, [clearCompletionResetTimer, isSuccess, isReverted, zapHash, refetchInputBalance, resetCompletionState, setAmount, submittedActionKind]);

  // Error display
  const noRoute = !quoteSettling && !!quoteError && !!amount && Number(amount) > 0;
  // Keep the route panel mounted when a quote fails so it shows an error instead of vanishing.
  const hasRouteContent = !!amount && Number(amount) > 0 && (!!quote || quoteSettling || noRoute);
  const routeErrorMessage = noRoute ? parseQuoteError(quoteError) : undefined;
  const retryQuote = () => void refetchQuote();
  const isPendingTx =
    (isZapTxPendingVisible(status) && !isSimulatingPreview && !showSimulationModal) || isDebugPending;
  const isZapSuccessVisible = !!showTxSuccess?.show || isDebugSuccess;
  const isZapRevertedVisible = !!showTxReverted?.show || isDebugReverted;
  const isTxStateVisible = isPendingTx || isZapSuccessVisible || isZapRevertedVisible;
  // Direct vault pairs (ERC20⇄vault share) are a deposit/redeem at NAV, not a swap.
  // Override for the debug preview; during tx states use the action captured at submit,
  // otherwise drive off the quote's directVault action.
  const actionKind: TxActionKind = isDebugDeposit
    ? "deposit"
    : isDebugWithdraw
      ? "withdraw"
      : (isTxStateVisible && submittedActionKind) || quote?.directVault?.action || "zap";
  const effectiveHash = isDebugActive ? debugHash : zapHash;
  const effectivePendingDetails = isDebugActive ? debugTxDetails : pendingTxDetails;
  const pendingCopy = getPendingTxCopy(Boolean(effectiveHash), actionKind);
  const successCopy = getSuccessTxCopy(actionKind);
  const revertedCopy = getRevertedTxCopy(actionKind);

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
                      {formatDisplayAmount(inputBalanceNum)}
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
                      {quoteSettling
                        ? requestedOutputAmount || "—"
                        : quote
                        ? formatDisplayAmount(quote.outputAmountFormatted)
                        : requestedOutputAmount || "0.00"}
                    </span>
                    <TokenSelector
                      selectedToken={outputToken}
                      onSelect={setOutputToken}
                      excludeTokens={[inputToken.address, ...ENTRY_DISABLED_VAULT_ADDRESSES]}
                      preferOnchainBalances
                    />
                  </div>
                </div>

                {/* Details */}
                <div className={cn("space-y-2 text-sm", !quote && "invisible")}>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-[var(--muted-foreground)]">Rate</span>
                    {quote ? (
                      <button
                        type="button"
                        onClick={() => setRateInverted(v => !v)}
                        className="flex items-center gap-1 mono hover:text-[var(--accent)] transition-colors"
                      >
                        {rateInverted
                          ? <>1 {outputToken.symbol} = {formatDisplayAmount(1 / quote.exchangeRate)} {inputToken.symbol}</>
                          : <>1 {inputToken.symbol} = {formatDisplayAmount(quote.exchangeRate)} {outputToken.symbol}</>
                        }
                        <ArrowRightLeft size={12} className="text-[var(--muted-foreground)]" />
                      </button>
                    ) : (
                      <span className="mono">—</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-[var(--muted-foreground)]">Price Impact</span>
                    <span className={cn("mono", priceImpactClassName(quote?.priceImpact))}>
                      {quote?.priceImpact != null ? `${quote.priceImpact.toFixed(2)}%` : "—"}
                    </span>
                  </div>
                  {aboveMarketWarning(quote?.priceImpact) && (
                    <p role="status" className="py-1 text-xs text-[var(--warning)]">
                      {aboveMarketWarning(quote?.priceImpact)}
                    </p>
                  )}
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
                  <TxPendingCard
                    title={pendingCopy.title}
                    message={pendingCopy.message}
                    details={effectivePendingDetails}
                    actionLabel={actionKind === "zap" ? "Zap" : actionKind === "deposit" ? "Deposit" : "Withdraw"}
                    hash={effectiveHash}
                  />
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
                      href={`https://etherscan.io/tx/${showTxSuccess?.hash ?? debugHash}`}
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
                      href={`https://etherscan.io/tx/${showTxReverted?.hash ?? debugHash}`}
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
                  onApprove={(exact) => guardHighImpact("Approve & zap", () => approve(exact))}
                />

                {isIdle && quote && !quoteSettling && !isPendingTx && (
                  <div className="mb-3 flex items-center justify-between text-xs text-[var(--muted-foreground)]">
                    <span>Quote may be out of date</span>
                    <button
                      type="button"
                      onClick={() => void refetchQuote()}
                      className="text-[var(--foreground)] hover:text-[var(--accent)] transition-colors"
                    >
                      Refresh
                    </button>
                  </div>
                )}

                {/* Execute button */}
                {isConnected ? (
                  <button
                    onClick={() => guardHighImpact("Zap", () => void handleExecuteZap())}
                    disabled={
                      showApprovalCard ||
                      !quote ||
                      isLoading ||
                      quoteSettling ||
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
                        quoteSettling ||
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
                    ) : safePending ? (
                      <>
                        Waiting for Safe
                        {safePending.confirmationsRequired
                          ? ` (${safePending.confirmations}/${safePending.confirmationsRequired} signed)`
                          : ""}
                        <LoadingDots />
                      </>
                    ) : status === "checkingApproval" ? (
                      <>Checking approval<LoadingDots /></>
                    ) : status === "waitingApproval" ? (
                      <>Waiting for approval<LoadingDots /></>
                    ) : isLoading ? (
                      <>Confirm in wallet<LoadingDots /></>
                    ) : quoteSettling ? (
                      <>Getting quote<LoadingDots /></>
                    ) : sameToken ? (
                      "Select different tokens"
                    ) : !amount || Number(amount) === 0 ? (
                      "Enter amount"
                    ) : hasInsufficientBalance ? (
                      "Insufficient balance"
                    ) : noRoute && quoteError?.message.toLowerCase().includes("temporarily unavailable") ? (
                      "Route temporarily unavailable"
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

                {batchesApproval && amount && !hasInsufficientBalance && needsApproval() && (
                  <p className="text-xs text-[var(--muted-foreground)]">
                    Your Safe approves and zaps in one transaction. If your Safe executes after the price moves past your slippage, the zap fails and nothing changes.
                  </p>
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
                      showRoute && hasRouteContent
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
                        inputAmount={amount ? formatDisplayAmount(amount) : undefined}
                        outputAmount={
                          quote?.outputAmountFormatted
                            ? formatDisplayAmount(quote.outputAmountFormatted)
                            : undefined
                        }
                        isLoading={quoteSettling}
                        errorMessage={routeErrorMessage}
                        onRetry={retryQuote}
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
              showRoute && !isTxStateVisible && hasRouteContent
                ? "opacity-100 translate-x-0"
                : "opacity-0 -translate-x-4 pointer-events-none",
            )}
            aria-hidden={!(showRoute && !isTxStateVisible && hasRouteContent)}
          >
            <div className="border border-[var(--border)] rounded-xl p-5">
              <div className="text-xs text-[var(--muted-foreground)] uppercase tracking-wider mb-3">
                Route
              </div>
              <RouteDisplay
                routeInfo={quote?.routeInfo}
                inputSymbol={inputToken.symbol}
                outputSymbol={outputToken.symbol}
                inputAmount={amount ? formatDisplayAmount(amount) : undefined}
                outputAmount={
                  quote?.outputAmountFormatted
                    ? formatDisplayAmount(quote.outputAmountFormatted)
                    : undefined
                }
                isLoading={quoteSettling}
                errorMessage={routeErrorMessage}
                onRetry={retryQuote}
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

      {pendingImpactAction && (
        <PriceImpactConfirmModal
          priceImpact={quote?.priceImpact}
          confirmLabel={pendingImpactAction.label}
          onCancel={() => setPendingImpactAction(null)}
          onConfirm={() => {
            const { run } = pendingImpactAction;
            setPendingImpactAction(null);
            if (refreshIfQuoteTooOld()) return;
            run();
          }}
        />
      )}

      {showSimulationModal && quote && simulationResult && (
        <SimulationModal
          isOpen={showSimulationModal}
          onClose={() => setShowSimulationModal(false)}
          onConfirm={async () => {
            if (!isSimulationForCurrentQuote()) {
              // The quote changed under the preview: never send a transaction the
              // user never saw. Re-preview through the page (it re-runs the price
              // impact gate and hides the pending card while simulating).
              setShowSimulationModal(false);
              toast.info("The quote changed since the preview. Check the new preview, then confirm.");
              guardHighImpact("Zap", () => void runSimulationPreview());
              return;
            }
            setShowSimulationModal(false);
            if (refreshIfQuoteTooOld()) return;
            // The preview belongs to this quote, so its impact confirmation still covers it.
            stagePendingTxDetails();
            const rePreview = await executeZap({ skipSimulation: true });
            if (rePreview) {
              setPendingTxDetails(null);
              setShowSimulationModal(true);
              toast.info("The quote changed since the preview. Check the new preview, then confirm.");
            }
          }}
          simulationResult={{
            success: simulationResult.success,
            gasUsed: simulationResult.gasUsed ?? null,
            errorMessage: simulationResult.errorMessage ?? null,
            tenderlyUrl: simulationResult.tenderlyUrl ?? null,
            assetChanges: fillMissingSimulationUsd(simulationResult.assetChanges, {
              input: { address: inputToken.address, amount: Number(quote.inputAmount), usd: quote.inputUsdValue },
              output: { address: outputToken.address, amount: Number(quote.outputAmountFormatted), usd: quote.outputUsdValue },
            }),
            simulationUnavailable: simulationResult.simulationUnavailable,
            simulationUnavailableReason: simulationResult.simulationUnavailableReason,
          }}
          gasPrice={gasPrice}
          routePriceImpact={quote?.priceImpact ?? null}
          confirmText={actionKind === "zap" ? "Confirm Zap" : actionKind === "deposit" ? "Confirm Deposit" : "Confirm Withdraw"}
        />
      )}

      {/* DEBUG: Transaction State Preview Panel - Only shows in development */}
      {process.env.NODE_ENV === "development" && (
        <div
          data-debug-panel
          className={cn(
            "fixed z-50 bg-[var(--card)] border border-[var(--border)] rounded-lg p-3 shadow-lg max-w-xs",
            isDragging && "cursor-grabbing"
          )}
          style={debugPanelPos ? {
            left: debugPanelPos.x,
            top: debugPanelPos.y,
            bottom: "auto",
            right: "auto",
          } : {
            bottom: 16,
            right: 16,
          }}
        >
          <div
            className="text-xs text-[var(--muted-foreground)] mb-2 font-medium cursor-grab select-none flex items-center justify-between"
            onMouseDown={handleDebugDragStart}
          >
            <span>⋮⋮ TX State Preview</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleDebugMinimized(); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="ml-2 px-1.5 py-0.5 rounded hover:bg-[var(--muted)] transition-colors text-[10px]"
            >
              {debugMinimized ? "+" : "−"}
            </button>
          </div>
          {!debugMinimized && <div className="space-y-2">
            {/* Reset */}
            <button
              onClick={() => {
                setDebugTxState("none");
                setShowSimulationModal(false);
                setShowSlippageModal(false);
                setShowTxSuccess(null);
                setShowTxReverted(null);
                setPendingTxDetails(null);
              }}
              className={cn(
                "w-full px-2 py-1 text-xs rounded transition-colors",
                debugTxState === "none" && !showSimulationModal && !showSlippageModal
                  ? "bg-[var(--foreground)] text-[var(--background)]"
                  : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              )}
            >
              Reset All
            </button>
            {([["Deposit", "deposit"], ["Withdraw", "withdraw"], ["Swap", "swap"]] as const).map(([label, prefix]) => (
              <div key={prefix} className="flex gap-1">
                <span className="text-[10px] text-[var(--muted-foreground)] w-14 flex items-center">{label}</span>
                {([["Pending", "pending", "bg-[var(--accent)] text-[var(--background)]"], ["Success", "success", "bg-green-500 text-white"], ["Reverted", "reverted", "bg-red-500 text-white"]] as const).map(([stateLabel, state, activeClass]) => {
                  const value = `${prefix}-${state}` as DebugTxState;
                  return (
                    <button
                      key={state}
                      onClick={() => { setPendingTxDetails(null); setShowTxSuccess(null); setShowTxReverted(null); setDebugTxState(value); }}
                      className={cn(
                        "flex-1 px-2 py-1 text-xs rounded transition-colors",
                        debugTxState === value
                          ? activeClass
                          : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                      )}
                    >
                      {stateLabel}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>}
        </div>
      )}
    </div>
  );
}
