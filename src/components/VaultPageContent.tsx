"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { useAccount, useBalance } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { CustomConnectButton } from "@/components/CustomConnectButton";
import { ArrowLeft, ArrowUpRight, ExternalLink, Loader2, Search, Route, RouteOff } from "lucide-react";
import { RouteDisplay } from "@/components/RouteDisplay";

// Animated loading dots for quote fetching
function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-0.5 text-[var(--muted-foreground)]">
      <span className="animate-bounce" style={{ animationDelay: "0ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "150ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "300ms", animationDuration: "600ms" }}>.</span>
    </span>
  );
}

// Parse Enso API errors into user-friendly messages
function parseQuoteError(error: Error | null): string {
  if (!error) return "Failed to get quote";
  const msg = error.message || "";

  // Amount too large/out of range
  if (msg.includes("amountIn") && msg.includes("acceptable range")) {
    return "Amount too large to quote - try a smaller amount";
  }
  // Insufficient liquidity
  if (msg.includes("insufficient liquidity") || msg.includes("no route found")) {
    return "No route available - insufficient liquidity";
  }
  // Rate limit
  if (msg.includes("rate limit") || msg.includes("429")) {
    return "Too many requests - please wait a moment";
  }
  // Network/timeout errors
  if (msg.includes("timeout") || msg.includes("network") || msg.includes("fetch")) {
    return "Network error - please try again";
  }
  // Generic API error - show shortened version
  if (msg.startsWith("API Error:")) {
    return "Quote unavailable - try a different amount";
  }

  return "Failed to get quote";
}

// MAX button with percentage options on hover
function MaxButton({ balance, onSelect }: { balance: string; onSelect: (amount: string) => void }) {
  const [isHovered, setIsHovered] = useState(false);
  const balanceNum = parseFloat(balance) || 0;

  const handlePercentage = (percent: number) => {
    const amount = balanceNum * (percent / 100);
    // Use full precision for 100%, otherwise limit decimals
    if (percent === 100) {
      onSelect(balance);
    } else {
      onSelect(amount.toString());
    }
  };

  return (
    <div
      className="relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Floating percentage options - stacked vertically above MAX */}
      <div
        className={cn(
          "absolute bottom-full right-0 pb-1 flex flex-col gap-1 transition-all duration-150",
          isHovered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1 pointer-events-none"
        )}
      >
        {[25, 50, 75].map((percent) => (
          <button
            key={percent}
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handlePercentage(percent)}
            className="shrink-0 px-2 py-1 text-xs font-medium bg-[var(--background)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded transition-colors cursor-pointer"
          >
            {percent}%
          </button>
        ))}
      </div>
      {/* Main MAX button */}
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => handlePercentage(100)}
        className="shrink-0 px-2 py-1 text-xs font-medium bg-[var(--background)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded transition-colors cursor-pointer"
      >
        MAX
      </button>
    </div>
  );
}
import { ContractExplorer, useContractExplorer } from "@/components/ContractExplorer";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";
import { useCurveLendingVault, formatCurveVaultData } from "@/hooks/useCurveLendingData";
import { useYearnVault, formatYearnVaultData, calculateStrategyNetApy } from "@/hooks/useYearnVault";
import { useVaultBalance } from "@/hooks/useVaultBalance";
import { useTokenBalance } from "@/hooks/useTokenBalance";
import { useCvxCrvPrice } from "@/hooks/useCvxCrvPrice";
import { usePricePerShare } from "@/hooks/usePricePerShare";
import { useVaultCache } from "@/hooks/useVaultCache";
import { useVaultActions } from "@/hooks/useVaultActions";
import { useZapQuote } from "@/hooks/useZapQuote";
import { useZapActions } from "@/hooks/useZapActions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { DEFAULT_ETH_TOKEN } from "@/hooks/useEnsoTokens";
import { TokenSelector } from "@/components/TokenSelector";
import { ETH_ADDRESS } from "@/lib/enso";
import { getVault, getParentVault, TOKENS, VAULT_UNDERLYING_TOKENS } from "@/config/vaults";
import type { EnsoToken, ZapDirection } from "@/types/enso";
import {
  trackVaultView,
  trackDepositInitiated,
  trackDepositSuccess,
  trackWithdrawInitiated,
  trackWithdrawSuccess,
  trackApprovalInitiated,
  trackApprovalSuccess,
  trackTransactionError,
  trackTransactionCancelled,
  isUserRejection,
} from "@/lib/analytics";
import { toast } from "sonner";

export function VaultPageContent({ id }: { id: string }) {
  const vault = getVault(id);

  // Check if vault is deployed (has non-zero address)
  const isVaultDeployed = vault?.address && vault.address !== "0x0000000000000000000000000000000000000000";

  const { isConnected, address: userAddress } = useAccount();
  const { openConnectModal } = useConnectModal();
  // Active tab with localStorage persistence
  const [activeTab, setActiveTabState] = useState<"deposit" | "withdraw" | "zap">(() => {
    if (typeof window === "undefined") return "deposit";
    const saved = localStorage.getItem("yldfi-active-tab");
    if (saved === "deposit" || saved === "withdraw" || saved === "zap") return saved;
    return "deposit";
  });
  const setActiveTab = (tab: "deposit" | "withdraw" | "zap") => {
    setActiveTabState(tab);
    localStorage.setItem("yldfi-active-tab", tab);
  };

  // Contract explorer state
  const { isOpen: explorerOpen, address: explorerAddress, title: explorerTitle, lastUpdated: explorerLastUpdated, icon: explorerIcon, openExplorer, closeExplorer } = useContractExplorer();
  const [amount, setAmount] = useState("");

  // Zap state with localStorage persistence (scoped per vault)
  const [zapDirection, setZapDirectionState] = useState<ZapDirection>(() => {
    if (typeof window === "undefined") return "in";
    const saved = localStorage.getItem(`yldfi-zap-direction-${id}`);
    return saved === "out" ? "out" : "in";
  });
  const setZapDirection = (dir: ZapDirection) => {
    setZapDirectionState(dir);
    localStorage.setItem(`yldfi-zap-direction-${id}`, dir);
  };
  const [zapInputToken, setZapInputTokenState] = useState<EnsoToken | null>(() => {
    if (typeof window === "undefined") return DEFAULT_ETH_TOKEN;
    try {
      const saved = localStorage.getItem(`yldfi-zap-input-token-${id}`);
      return saved ? JSON.parse(saved) : DEFAULT_ETH_TOKEN;
    } catch {
      return DEFAULT_ETH_TOKEN;
    }
  });
  const setZapInputToken = (token: EnsoToken | null) => {
    setZapInputTokenState(token);
    if (token) {
      localStorage.setItem(`yldfi-zap-input-token-${id}`, JSON.stringify(token));
    } else {
      localStorage.removeItem(`yldfi-zap-input-token-${id}`);
    }
  };
  const [zapOutputToken, setZapOutputTokenState] = useState<EnsoToken | null>(() => {
    if (typeof window === "undefined") return DEFAULT_ETH_TOKEN;
    try {
      const saved = localStorage.getItem(`yldfi-zap-output-token-${id}`);
      return saved ? JSON.parse(saved) : DEFAULT_ETH_TOKEN;
    } catch {
      return DEFAULT_ETH_TOKEN;
    }
  });
  const setZapOutputToken = (token: EnsoToken | null) => {
    setZapOutputTokenState(token);
    if (token) {
      localStorage.setItem(`yldfi-zap-output-token-${id}`, JSON.stringify(token));
    } else {
      localStorage.removeItem(`yldfi-zap-output-token-${id}`);
    }
  };
  const [zapAmount, setZapAmountState] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(`yldfi-zap-amount-${id}`) ?? "";
  });
  const setZapAmount = useCallback((amount: string) => {
    setZapAmountState(amount);
    if (amount) {
      localStorage.setItem(`yldfi-zap-amount-${id}`, amount);
    } else {
      localStorage.removeItem(`yldfi-zap-amount-${id}`);
    }
  }, [id]);
  // Debounce zap amount to prevent rate limiting from Enso API (1 req/sec)
  const debouncedZapAmount = useDebouncedValue(zapAmount, 500);
  // Load slippage from localStorage with lazy initialization
  const [zapSlippage, setZapSlippage] = useState(() => {
    if (typeof window === "undefined") return "10";
    return localStorage.getItem("yldfi-zap-slippage") ?? "10";
  });
  const [showSlippageModal, setShowSlippageModal] = useState(false);
  const [showPriceImpactModal, setShowPriceImpactModal] = useState(false);
  const [priceImpactConfirmText, setPriceImpactConfirmText] = useState("");
  // Route display toggle with localStorage persistence
  const [showRoute, setShowRoute] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("yldfi-show-route") === "true";
  });
  const toggleRoute = () => {
    const newValue = !showRoute;
    setShowRoute(newValue);
    localStorage.setItem("yldfi-show-route", String(newValue));
  };

  // Handle token selection
  // Zap in: changing input token resets amount (you're changing what you send)
  // Zap out: changing output token does NOT reset amount (you're just changing what you receive)
  const handleZapInputTokenChange = (token: EnsoToken) => {
    setZapInputToken(token);
    setZapAmount(""); // Reset when changing input (zap in)
  };
  const handleZapOutputTokenChange = (token: EnsoToken) => {
    setZapOutputToken(token);
    // Don't reset amount - user is just changing what they want to receive
  };

  // Last transaction result for showing success/error message (stored for potential future UI use)
  const [_lastTxResult, setLastTxResult] = useState<{
    hash: string;
    status: "success" | "reverted";
    type: "deposit" | "withdraw" | "zap";
  } | null>(null);

  // Price impact threshold for confirmation (5%)
  const PRICE_IMPACT_CONFIRM_THRESHOLD = 5;

  // Save slippage to localStorage when changed
  const updateSlippage = (value: string) => {
    setZapSlippage(value);
    localStorage.setItem("yldfi-zap-slippage", value);
  };

  // Fetch Yearn Kong API data
  const { data: yearnData, isLoading: yearnLoading } = useYearnVault(vault?.address ?? "");
  const yearnVault = formatYearnVaultData(yearnData?.vault, yearnData?.vaultStrategies);

  // For strategy, also fetch parent vault data to get gross APR for calculating net APY
  const parentVaultAddress = vault?.type === "strategy" ? getParentVault(vault.address)?.address ?? null : null;
  const { data: parentVaultData, isLoading: parentLoading } = useYearnVault(parentVaultAddress ?? "", 1);
  const parentVault = formatYearnVaultData(parentVaultData?.vault, parentVaultData?.vaultStrategies);

  // Calculate APY based on type:
  const vaultNetApy = parentVault?.apy ?? yearnVault?.apy ?? 0;
  const strategyNetApy = calculateStrategyNetApy(vaultNetApy);

  const displayApyFormatted = vault?.type === "strategy"
    ? `${strategyNetApy.toFixed(2)}%`
    : (yearnVault?.apyFormatted ?? "—");

  // Fetch Curve lending market data (only for vault type)
  const { vault: curveVault } = useCurveLendingVault(
    vault?.type === "vault" ? vault?.address ?? "" : ""
  );
  const curveData = formatCurveVaultData(curveVault);

  // Fetch cvxCRV price from on-chain oracles
  const { price: cvxCrvPrice } = useCvxCrvPrice();

  // Fetch vault cache for all underlying prices
  const { data: vaultCache } = useVaultCache();

  // Get the correct underlying price based on vault's asset
  const getUnderlyingPrice = (): number => {
    if (!vault) return cvxCrvPrice;
    switch (vault.assetSymbol) {
      case "cvgCVX":
        return vaultCache?.cvgCvxPrice ?? 0;
      case "pxCVX":
        return vaultCache?.pxCvxPrice ?? 0;
      case "cvxCRV":
      default:
        return cvxCrvPrice;
    }
  };
  const underlyingPrice = getUnderlyingPrice();

  // Fetch price per share from on-chain
  const vaultAddressTyped = (vault?.address ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
  const { pricePerShare, pricePerShareFormatted, isLoading: ppsLoading } = usePricePerShare(vaultAddressTyped);

  // Fetch user balances
  const { formatted: tokenBalanceFormatted, isLoading: tokenBalanceLoading, refetch: refetchTokenBalance } = useTokenBalance(TOKENS.CVXCRV);
  const {
    formatted: vaultBalanceFormatted,
    isLoading: vaultBalanceLoading,
    refetch: refetchVaultBalance,
  } = useVaultBalance(
    vaultAddressTyped,
    pricePerShare,
    underlyingPrice
  );

  const tokenBalance = parseFloat(tokenBalanceFormatted) || 0;
  const vaultBalance = parseFloat(vaultBalanceFormatted) || 0;
  // Raw formatted strings preserve full precision for MAX button
  const tokenBalanceMax = tokenBalanceFormatted;
  const vaultBalanceMax = vaultBalanceFormatted;
  const exchangeRate = pricePerShare;

  // Zap input token balance (for MAX button)
  const isZapInputEth = zapInputToken?.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const { data: zapInputBalance, refetch: refetchZapInputBalance } = useBalance({
    address: userAddress,
    token: isZapInputEth ? undefined : (zapInputToken?.address as `0x${string}`),
    query: {
      enabled: !!userAddress && !!zapInputToken,
    },
  });
  const zapInputBalanceFormatted = zapInputBalance?.formatted ?? "0";
  const zapInputBalanceNum = parseFloat(zapInputBalanceFormatted) || 0;

  // Vault actions (approve, deposit, withdraw)
  const {
    needsApproval,
    approve,
    deposit,
    withdraw,
    reset: resetVaultActions,
    status: txStatus,
    error: txError,
    isLoading,
    isSuccess,
    isReverted,
    depositHash,
    withdrawHash,
  } = useVaultActions(vaultAddressTyped, vault?.assetAddress ?? TOKENS.CVXCRV, vault?.assetDecimals ?? 18);

  // Zap quote - fetch route from Enso (debounced to prevent rate limiting)
  const { quote: zapQuote, isLoading: zapQuoteLoading, error: zapQuoteError } = useZapQuote({
    inputToken: zapDirection === "in" ? zapInputToken : null,
    outputToken: zapDirection === "out" ? zapOutputToken : null,
    inputAmount: debouncedZapAmount,
    direction: zapDirection,
    vaultAddress: vault?.address ?? "",
    underlyingToken: vault?.assetAddress ?? "",
    slippage: zapSlippage,
    underlyingTokenPrice: underlyingPrice, // For illiquid tokens like cvgCVX
  });

  // Zap actions (approve + execute)
  const {
    needsApproval: zapNeedsApproval,
    approve: zapApprove,
    executeZap,
    reset: resetZapActions,
    status: zapStatus,
    error: zapActionError,
    isLoading: zapIsLoading,
    isSuccess: zapIsSuccess,
    isReverted: zapIsReverted,
    zapHash,
  } = useZapActions(zapQuote);

  const inputAmount = parseFloat(amount) || 0;
  const outputAmount = activeTab === "deposit"
    ? inputAmount / exchangeRate
    : inputAmount * exchangeRate;
  const maxAmount = activeTab === "deposit" ? tokenBalance : vaultBalance;
  const hasInsufficientBalance = inputAmount > maxAmount;

  // Track vault view on mount
  const hasTrackedView = useRef(false);
  useEffect(() => {
    if (vault && !hasTrackedView.current) {
      trackVaultView(id, vault.name);
      hasTrackedView.current = true;
    }
  }, [id, vault]);

  // Track transaction status changes
  const prevTxStatus = useRef(txStatus);
  useEffect(() => {
    if (prevTxStatus.current !== txStatus && vault) {
      // Track approval success
      if (prevTxStatus.current === "waitingApproval" && txStatus === "idle") {
        trackApprovalSuccess(vault.assetSymbol, id);
      }
      // Track deposit success (only when we have a tx hash confirming it happened)
      if (prevTxStatus.current === "waitingTx" && txStatus === "success" && activeTab === "deposit" && depositHash) {
        trackDepositSuccess(id, amount, vault.assetSymbol);
      }
      // Track withdraw success (only when we have a tx hash confirming it happened)
      if (prevTxStatus.current === "waitingTx" && txStatus === "success" && activeTab === "withdraw" && withdrawHash) {
        trackWithdrawSuccess(id, amount, vault.assetSymbol);
      }
      // Track errors or cancellations
      if (txStatus === "error" && prevTxStatus.current !== "error") {
        const action = prevTxStatus.current === "waitingApproval" || prevTxStatus.current === "approving"
          ? "approval"
          : activeTab === "deposit"
          ? "deposit"
          : "withdraw";

        // Check if user cancelled (rejected in wallet)
        if (txError && isUserRejection(txError)) {
          trackTransactionCancelled(action, id);
        } else {
          trackTransactionError(action, id, txError || "Transaction failed");
        }
      }
    }
    prevTxStatus.current = txStatus;
  }, [txStatus, txError, vault, id, amount, activeTab, depositHash, withdrawHash]);

  if (!vault) {
    notFound();
  }

  // Check if approval needed for deposit
  const requiresApproval = activeTab === "deposit" && amount && needsApproval(amount);

  const handleSubmit = async () => {
    if (!inputAmount || hasInsufficientBalance || !vault) return;

    if (activeTab === "deposit") {
      if (requiresApproval) {
        trackApprovalInitiated(vault.assetSymbol, id);
        approve();
      } else {
        trackDepositInitiated(id, amount, vault.assetSymbol);
        deposit(amount);
      }
    } else {
      trackWithdrawInitiated(id, amount, vault.assetSymbol);
      withdraw(amount);
    }
  };

  // Track transaction hashes to detect new successful transactions
  const lastHandledDepositHash = useRef<string | null>(null);
  const lastHandledWithdrawHash = useRef<string | null>(null);
  const lastHandledZapHash = useRef<string | null>(null);

  // Handle deposit/withdraw completion (success or revert) - refetch balances and reset form
  useEffect(() => {
    const currentHash = depositHash || withdrawHash;
    const isComplete = isSuccess || isReverted;
    if (isComplete && currentHash && currentHash !== lastHandledDepositHash.current && currentHash !== lastHandledWithdrawHash.current) {
      // Mark as handled
      if (depositHash) lastHandledDepositHash.current = depositHash;
      if (withdrawHash) lastHandledWithdrawHash.current = withdrawHash;
      // Refetch all balances after tx completes (even on revert, tokens are still there)
      refetchTokenBalance();
      refetchVaultBalance();
      // Show success/error message, clear form and reset state (use setTimeout to avoid sync setState in effect)
      const txResult = {
        hash: currentHash,
        status: (isSuccess ? "success" : "reverted") as "success" | "reverted",
        type: (depositHash ? "deposit" : "withdraw") as "deposit" | "withdraw" | "zap",
      };
      setTimeout(() => {
        setLastTxResult(txResult);
        setAmount("");
        resetVaultActions();

        // Show toast notification
        if (isSuccess) {
          toast.success(`${depositHash ? "Deposit" : "Withdrawal"} successful!`, {
            action: {
              label: "View Tx",
              onClick: () => window.open(`https://etherscan.io/tx/${currentHash}`, "_blank"),
            },
          });
        } else if (isReverted) {
          toast.error(`${depositHash ? "Deposit" : "Withdrawal"} failed - transaction reverted`, {
            action: {
              label: "View Tx",
              onClick: () => window.open(`https://etherscan.io/tx/${currentHash}`, "_blank"),
            },
          });
        }
      }, 0);
    }
  }, [isSuccess, isReverted, depositHash, withdrawHash, refetchTokenBalance, refetchVaultBalance, resetVaultActions]);

  // Handle zap completion (success or revert) - refetch balances and reset form
  useEffect(() => {
    const isComplete = zapIsSuccess || zapIsReverted;
    if (isComplete && zapHash && zapHash !== lastHandledZapHash.current) {
      // Mark as handled
      lastHandledZapHash.current = zapHash;
      // Refetch all balances after tx completes (even on revert, tokens are still there)
      refetchTokenBalance();
      refetchVaultBalance();
      refetchZapInputBalance();
      // Show success/error message, clear form and reset state (use setTimeout to avoid sync setState in effect)
      const txResult = {
        hash: zapHash,
        status: (zapIsSuccess ? "success" : "reverted") as "success" | "reverted",
        type: "zap" as "deposit" | "withdraw" | "zap",
      };
      setTimeout(() => {
        setLastTxResult(txResult);
        setZapAmount("");
        resetZapActions();

        // Show toast notification
        if (zapIsSuccess) {
          toast.success("Zap successful!", {
            action: {
              label: "View Tx",
              onClick: () => window.open(`https://etherscan.io/tx/${zapHash}`, "_blank"),
            },
          });
        } else if (zapIsReverted) {
          toast.error("Zap failed - transaction reverted", {
            action: {
              label: "View Tx",
              onClick: () => window.open(`https://etherscan.io/tx/${zapHash}`, "_blank"),
            },
          });
        }
      }, 0);
    }
  }, [zapIsSuccess, zapIsReverted, zapHash, refetchTokenBalance, refetchVaultBalance, refetchZapInputBalance, resetZapActions, setZapAmount]);

  // Show toast notifications for errors
  useEffect(() => {
    if (txError) {
      toast.error(txError);
    }
  }, [txError]);

  useEffect(() => {
    if (zapActionError) {
      toast.error(zapActionError);
    }
  }, [zapActionError]);

  // Show toast for quote errors (with friendly message and deduplication)
  const lastQuoteErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (zapQuoteError) {
      const friendlyMessage = parseQuoteError(zapQuoteError);
      // Only show toast if it's a different error message
      if (lastQuoteErrorRef.current !== friendlyMessage) {
        lastQuoteErrorRef.current = friendlyMessage;
        toast.error(friendlyMessage);
      }
    } else {
      // Clear the ref when there's no error (quote succeeded)
      lastQuoteErrorRef.current = null;
    }
  }, [zapQuoteError]);

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <header className="fixed left-0 right-0 z-50 border-b border-[var(--border)] backdrop-blur-lg bg-[var(--background)]/80" style={{ top: "var(--test-banner-height)" }}>
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Logo size={28} />
            <span className="mono text-lg font-medium tracking-tight leading-none">
              yld<span className="text-[var(--muted-foreground)]">_</span>fi
            </span>
          </Link>
          <CustomConnectButton />
        </div>
      </header>

      <main className="overflow-x-hidden" style={{ paddingTop: "calc(4rem + var(--test-banner-height))" }}>
        {/* Back link */}
        <div className="border-b border-[var(--border)]">
          <div className="max-w-6xl mx-auto px-6 py-4">
            <Link
              href="/#vaults"
              className="inline-flex items-center gap-2 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
            >
              <ArrowLeft size={16} />
              Back to vaults
            </Link>
          </div>
        </div>

        <div className="max-w-6xl mx-auto px-6 py-12">
          <div className="grid lg:grid-cols-5 gap-12">
            {/* Left column - Info */}
            <div className="lg:col-span-3 space-y-12">
              {/* Header */}
              <div>
                <div className="flex items-center gap-3 mb-4">
                  {vault.logo && (
                    <Image
                      src={vault.logo}
                      alt={vault.name}
                      width={40}
                      height={40}
                      className="rounded-full translate-y-[1px]"
                    />
                  )}
                  <h1 className="text-3xl md:text-4xl font-medium tracking-tight leading-none">
                    {vault.name}
                  </h1>
                </div>
                <p className="text-[var(--muted-foreground)] max-w-xl leading-relaxed">
                  {vault.longDescription}
                </p>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                <div>
                  <p className="text-sm text-[var(--muted-foreground)] mb-1">APY</p>
                  <p className="mono text-2xl font-medium text-[var(--success)]">
                    {yearnLoading || parentLoading ? "..." : displayApyFormatted}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-[var(--muted-foreground)] mb-1">TVL</p>
                  <p className="mono text-2xl font-medium">
                    {yearnLoading ? "..." : yearnVault?.tvlFormatted ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-[var(--muted-foreground)] mb-1">Price/Share</p>
                  <p className="mono text-2xl font-medium">
                    {ppsLoading ? "..." : pricePerShareFormatted}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-[var(--muted-foreground)] mb-1">Token</p>
                  <p className="mono text-2xl font-medium">
                    {vault.assetSymbol}
                  </p>
                </div>
              </div>

              {/* Details */}
              <div className="space-y-6">
                <h2 className="text-lg font-medium">{vault.type === "vault" ? "Vault" : "Strategy"} Details</h2>

                <div className="space-y-4">
                  <div className="flex items-center justify-between py-3 border-b border-[var(--border)]">
                    <span className="text-[var(--muted-foreground)]">Strategy</span>
                    <span className="mono text-sm">{vault.strategy}</span>
                  </div>
                  <div className="flex items-center justify-between py-3 border-b border-[var(--border)]">
                    <span className="text-[var(--muted-foreground)]">Performance Fee</span>
                    <span className="mono text-sm text-right">
                      {vault.type === "vault" ? (
                        <>15% Vault (to LlamaLend lenders) + 5% Strategy</>
                      ) : (
                        <>{vault.fees.performance}%</>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-3 border-b border-[var(--border)]">
                    <span className="text-[var(--muted-foreground)]">
                      {vault.type === "strategy" ? "Strategy" : "Vault"}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openExplorer(vault.address, vault.name, vault.logo)}
                        className="mono text-xs px-2 py-1 bg-[var(--muted)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)] rounded flex items-center gap-1 transition-colors"
                      >
                        <Search size={10} />
                        Explore
                      </button>
                      <a
                        href={vault.links?.etherscan || `https://etherscan.io/address/${vault.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mono text-sm flex items-center gap-1 hover:text-[var(--accent)] transition-colors"
                      >
                        {vault.address.slice(0, 6)}...{vault.address.slice(-4)}
                        <ExternalLink size={12} />
                      </a>
                    </div>
                  </div>
                  {vault.underlyingStrategy && vault.type === "vault" && (
                    <div className="flex items-center justify-between py-3 border-b border-[var(--border)]">
                      <span className="text-[var(--muted-foreground)]">Strategy</span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => openExplorer(vault.underlyingStrategy!, "yscvxCRV Strategy", vault.logo)}
                          className="mono text-xs px-2 py-1 bg-[var(--muted)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)] rounded flex items-center gap-1 transition-colors"
                        >
                          <Search size={10} />
                          Explore
                        </button>
                        <a
                          href={`https://etherscan.io/address/${vault.underlyingStrategy}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mono text-sm flex items-center gap-1 hover:text-[var(--accent)] transition-colors"
                        >
                          {vault.underlyingStrategy.slice(0, 6)}...{vault.underlyingStrategy.slice(-4)}
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* LlamaLend Market Stats */}
              {curveData && (
                <div className="space-y-6">
                  <a
                    href={curveData.depositUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-lg font-medium flex items-center gap-2 hover:text-[var(--accent)] transition-colors"
                  >
                    ycvxCRV LlamaLend Market
                    <ExternalLink size={16} />
                  </a>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between py-3 border-b border-[var(--border)]">
                      <span className="text-[var(--muted-foreground)]">Borrow APY</span>
                      <span className="mono text-sm">{curveData.borrowApyFormatted}</span>
                    </div>
                    <div className="flex items-center justify-between py-3 border-b border-[var(--border)]">
                      <span className="text-[var(--muted-foreground)]">Total Borrowed</span>
                      <span className="mono text-sm">{curveData.totalBorrowedFormatted}</span>
                    </div>
                    <div className="flex items-center justify-between py-3 border-b border-[var(--border)]">
                      <span className="text-[var(--muted-foreground)]">Available to Borrow</span>
                      <span className="mono text-sm">{curveData.availableToBorrowFormatted}</span>
                    </div>
                    <div className="flex items-center justify-between py-3 border-b border-[var(--border)]">
                      <span className="text-[var(--muted-foreground)]">Total Collateral</span>
                      <span className="mono text-sm">
                        {curveData.collateralInAmm.toFixed(2)} ycvxCRV
                        <span className="text-[var(--muted-foreground)]">
                          {" "}(${(curveData.collateralInAmm * pricePerShare * underlyingPrice).toLocaleString(undefined, { maximumFractionDigits: 0 })})
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Right column - Action Card */}
            <div className="lg:col-span-2 min-w-0">
              <div className="sticky border border-[var(--border)] rounded-xl overflow-hidden w-full" style={{ top: "calc(6rem + var(--test-banner-height))" }}>
                {/* Your Position - Always visible when connected with balance */}
                {isConnected && vaultBalance > 0 && (
                  <div className="bg-[var(--muted)]/30 p-5 border-b border-[var(--border)]">
                    <div className="flex flex-wrap items-center justify-center gap-4">
                      <div className="text-center basis-full sm:basis-auto">
                        <span className="text-xs uppercase tracking-wider text-[var(--muted-foreground)]">Your Position</span>
                        <div className="mt-1">
                          {(() => {
                            const formatted = vaultBalanceLoading ? "..." : vaultBalance.toFixed(4);
                            const len = formatted.length;
                            // Scale font based on length
                            const sizeClass = len > 16 ? "text-xs" : len > 13 ? "text-sm" : len > 10 ? "text-base" : len > 8 ? "text-lg" : "text-xl";
                            const symbolSize = len > 10 ? "text-xs" : "text-sm";
                            return (
                              <>
                                <span className={`mono font-semibold ${sizeClass}`}>{formatted}</span>
                                <span className={`${symbolSize} text-[var(--muted-foreground)] ml-1`}>{vault.symbol}</span>
                              </>
                            );
                          })()}
                        </div>
                      </div>
                      {/* Collateral link - only for vault type with holdings */}
                      {vault.type === "vault" && vault.links?.curve && (
                        <a
                          href={vault.links.curve}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="collateral-link shrink-0"
                        >
                          <span className="whitespace-nowrap">
                            <Image src="/curve-logo.png" alt="Curve" width={14} height={14} className="inline-block" />
                            Use as Collateral
                            <ArrowUpRight size={12} />
                          </span>
                        </a>
                      )}
                    </div>
                  </div>
                )}

                {/* Tabs */}
                <div className="p-5 pb-0">
                  <div className="flex border-b border-[var(--border)]">
                    {(["deposit", "withdraw", "zap"] as const).map((tab) => {
                      // Disable all tabs for non-deployed vaults
                      const isDisabled = !isVaultDeployed;
                      return (
                        <button
                          key={tab}
                          disabled={isDisabled}
                          onClick={() => {
                            if (isDisabled) return;
                            setActiveTab(tab);
                            setAmount("");
                            setZapAmount("");
                            setLastTxResult(null);
                            // Clear any pending error states when switching tabs
                            resetVaultActions();
                            resetZapActions();
                          }}
                          className={cn(
                            "flex-1 pb-3 text-sm font-medium transition-all capitalize relative",
                            isDisabled
                              ? "text-[var(--muted-foreground)]/50 cursor-not-allowed"
                              : "cursor-pointer",
                            !isDisabled && activeTab === tab
                              ? "text-[var(--foreground)]"
                              : !isDisabled && "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                          )}
                          title={isDisabled ? "Vault not yet deployed" : undefined}
                        >
                          {tab}
                          {!isDisabled && activeTab === tab && (
                            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--foreground)]" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Form - min-height prevents layout shift when switching tabs */}
                <div className="p-5 space-y-5 min-h-[622px]">
                  {/* Coming Soon banner for non-deployed vaults */}
                  {!isVaultDeployed && (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <div className="w-16 h-16 rounded-full bg-[var(--muted)] flex items-center justify-center mb-4">
                        <svg className="w-8 h-8 text-[var(--muted-foreground)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                      <h3 className="text-lg font-medium mb-2">Coming Soon</h3>
                      <p className="text-sm text-[var(--muted-foreground)] max-w-xs">
                        This vault is not yet deployed. Check back later or follow us for updates.
                      </p>
                    </div>
                  )}

                  {/* Deposit/Withdraw Form */}
                  {isVaultDeployed && activeTab !== "zap" && (
                    <>
                      {/* Input */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm text-[var(--muted-foreground)]">Amount</span>
                          <span className="text-xs mono text-[var(--muted-foreground)]">
                            {(activeTab === "deposit" ? tokenBalanceLoading : vaultBalanceLoading)
                              ? "..."
                              : (activeTab === "deposit" ? tokenBalance : vaultBalance).toFixed(4)
                            }
                          </span>
                        </div>
                        <div className="bg-[var(--muted)] rounded-lg p-4 flex items-center gap-2 focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
                          <input
                            type="number"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            placeholder="0.00"
                            className="flex-1 min-w-0 bg-transparent mono text-base outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
                          />
                          <span className="mono text-sm font-medium shrink-0">
                            {activeTab === "deposit" ? vault.assetSymbol : vault.symbol}
                          </span>
                          <MaxButton
                            balance={activeTab === "deposit" ? tokenBalanceMax : vaultBalanceMax}
                            onSelect={setAmount}
                          />
                        </div>
                        <p className={cn(
                          "text-xs mt-2 h-4",
                          hasInsufficientBalance ? "text-[var(--destructive)]" : "invisible"
                        )}>
                          {hasInsufficientBalance ? "Insufficient balance" : "\u00A0"}
                        </p>
                      </div>

                      {/* Arrow indicator */}
                      <div className="flex justify-center">
                        <div className="w-8 h-8 rounded-full bg-[var(--muted)] flex items-center justify-center">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--muted-foreground)]">
                            <path d="M12 5v14M19 12l-7 7-7-7"/>
                          </svg>
                        </div>
                      </div>

                      {/* Output */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm text-[var(--muted-foreground)]">You receive</span>
                        </div>
                        <div className="bg-[var(--muted)] rounded-lg p-4 flex items-center gap-2">
                          <span className="mono text-base text-[var(--foreground)] flex-1">
                            {outputAmount > 0 ? outputAmount.toFixed(4) : "0.00"}
                          </span>
                          <span className="mono text-sm font-medium shrink-0">
                            {activeTab === "deposit" ? vault.symbol : vault.assetSymbol}
                          </span>
                        </div>
                      </div>

                      {/* Details */}
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center justify-between py-1">
                          <span className="text-[var(--muted-foreground)]">Exchange rate</span>
                          <span className="mono">1 {vault.assetSymbol} = {(1 / exchangeRate).toFixed(4)} {vault.symbol}</span>
                        </div>
                        <div className={cn(
                          "flex items-center justify-between py-1",
                          inputAmount > 0 ? "" : "invisible"
                        )}>
                          <span className="text-[var(--muted-foreground)]">Value</span>
                          {/* For deposit: input is underlying, for withdraw: output is underlying */}
                          <span className="mono">~${((activeTab === "deposit" ? inputAmount : outputAmount) * underlyingPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                      </div>

                      {/* Action button */}
                      {isConnected ? (
                        <button
                          onClick={handleSubmit}
                          disabled={!inputAmount || hasInsufficientBalance || isLoading}
                          className={cn(
                            "w-full py-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-base",
                            !inputAmount || hasInsufficientBalance
                              ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                              : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 cursor-pointer"
                          )}
                        >
                          {isLoading ? (
                            <>
                              <Loader2 size={18} className="animate-spin" />
                              {txStatus === "approving" || txStatus === "waitingApproval"
                                ? "Approving..."
                                : txStatus === "depositing" || txStatus === "withdrawing"
                                ? "Confirming..."
                                : "Processing..."}
                            </>
                          ) : !inputAmount ? (
                            "Enter amount"
                          ) : hasInsufficientBalance ? (
                            "Insufficient balance"
                          ) : activeTab === "deposit" ? (
                            requiresApproval ? "Approve" : "Deposit"
                          ) : (
                            "Withdraw"
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

                      {/* Spacer to match Zap tab's Enso footer height */}
                      <div className="h-[28px]" />
                    </>
                  )}

                  {/* Zap Form */}
                  {isVaultDeployed && activeTab === "zap" && (
                    <>
                      {/* Direction Toggle + Settings */}
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setZapDirection("in");
                            setZapAmount("");
                          }}
                          className={cn(
                            "flex-1 py-2 text-sm rounded-lg transition-colors",
                            zapDirection === "in"
                              ? "bg-[var(--foreground)] text-[var(--background)]"
                              : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                          )}
                        >
                          Zap In
                        </button>
                        <button
                          onClick={() => {
                            setZapDirection("out");
                            setZapAmount("");
                          }}
                          className={cn(
                            "flex-1 py-2 text-sm rounded-lg transition-colors",
                            zapDirection === "out"
                              ? "bg-[var(--foreground)] text-[var(--background)]"
                              : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                          )}
                        >
                          Zap Out
                        </button>
                      </div>

                      {/* Zap In */}
                      {zapDirection === "in" && (
                        <>
                          {/* Input Token + Amount */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm text-[var(--muted-foreground)]">Amount</span>
                              <span className="text-xs mono text-[var(--muted-foreground)]">{zapInputBalanceNum.toFixed(4)}</span>
                            </div>
                            <div className="bg-[var(--muted)] rounded-lg p-4 flex items-center gap-2 focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
                              <input
                                type="number"
                                value={zapAmount}
                                onChange={(e) => setZapAmount(e.target.value)}
                                placeholder="0.00"
                                className="flex-1 min-w-0 bg-transparent mono text-base outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
                              />
                              <TokenSelector
                                selectedToken={zapInputToken}
                                onSelect={handleZapInputTokenChange}
                                excludeTokens={[...VAULT_UNDERLYING_TOKENS, vault?.address ?? ""]} // Exclude underlying tokens + current vault
                              />
                              <MaxButton
                                balance={zapInputBalanceFormatted}
                                onSelect={setZapAmount}
                              />
                            </div>
                          </div>

                          {/* Arrow */}
                          <div className="flex justify-center">
                            <div className="w-8 h-8 rounded-full bg-[var(--muted)] flex items-center justify-center">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--muted-foreground)]">
                                <path d="M12 5v14M19 12l-7 7-7-7"/>
                              </svg>
                            </div>
                          </div>

                          {/* Output */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm text-[var(--muted-foreground)]">You receive</span>
                            </div>
                            <div className="bg-[var(--muted)] rounded-lg p-4 flex items-center gap-2">
                              <span className="mono text-base text-[var(--foreground)] flex-1">
                                {zapQuoteLoading ? "—" : zapQuote ? Number(zapQuote.outputAmountFormatted).toFixed(4) : "0.00"}
                              </span>
                              <span className="mono text-sm font-medium shrink-0">{vault.symbol}</span>
                            </div>
                          </div>
                        </>
                      )}

                      {/* Zap Out */}
                      {zapDirection === "out" && (
                        <>
                          {/* Input - Vault Shares */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm text-[var(--muted-foreground)]">Amount</span>
                              <span className="text-xs mono text-[var(--muted-foreground)]">{vaultBalance.toFixed(4)}</span>
                            </div>
                            <div className="bg-[var(--muted)] rounded-lg p-4 flex items-center gap-2 focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
                              <input
                                type="number"
                                value={zapAmount}
                                onChange={(e) => setZapAmount(e.target.value)}
                                placeholder="0.00"
                                className="flex-1 min-w-0 bg-transparent mono text-base outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
                              />
                              <span className="mono text-sm font-medium shrink-0">{vault.symbol}</span>
                              <MaxButton
                                balance={vaultBalanceMax}
                                onSelect={setZapAmount}
                              />
                            </div>
                          </div>

                          {/* Arrow */}
                          <div className="flex justify-center">
                            <div className="w-8 h-8 rounded-full bg-[var(--muted)] flex items-center justify-center">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--muted-foreground)]">
                                <path d="M12 5v14M19 12l-7 7-7-7"/>
                              </svg>
                            </div>
                          </div>

                          {/* Output Token */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm text-[var(--muted-foreground)]">You receive</span>
                            </div>
                            <div className="bg-[var(--muted)] rounded-lg p-4 flex items-center gap-2">
                              <span className="mono text-base text-[var(--foreground)] flex-1">
                                {zapQuoteLoading ? "—" : zapQuote ? Number(zapQuote.outputAmountFormatted).toFixed(4) : "0.00"}
                              </span>
                              <TokenSelector
                                selectedToken={zapOutputToken}
                                onSelect={handleZapOutputTokenChange}
                                excludeTokens={[...VAULT_UNDERLYING_TOKENS, vault?.address ?? ""]} // Exclude underlying tokens + current vault
                              />
                            </div>
                          </div>
                        </>
                      )}

                      {/* Zap Details - always render to prevent layout shift */}
                      <div className={cn(
                        "space-y-2 text-sm",
                        !zapQuote && "invisible"
                      )}>
                        <div className="flex items-center justify-between py-1">
                          <span className="text-[var(--muted-foreground)]">Rate</span>
                          <span className="mono">
                            {zapQuote ? (
                              <>1 {zapDirection === "in" ? zapInputToken?.symbol : vault.symbol} = {zapQuote.exchangeRate.toFixed(4)} {zapDirection === "in" ? vault.symbol : zapOutputToken?.symbol}</>
                            ) : (
                              "—"
                            )}
                          </span>
                        </div>
                        <div className="flex items-center justify-between py-1">
                          <span className="text-[var(--muted-foreground)]">Price Impact</span>
                          <span className={cn(
                            "mono",
                            zapQuote && (zapQuote.priceImpact ?? 0) < 0
                              ? "text-green-500"
                              : zapQuote && (zapQuote.priceImpact ?? 0) > 2
                                ? "text-[var(--destructive)]"
                                : zapQuote && (zapQuote.priceImpact ?? 0) > 1
                                  ? "text-[var(--warning)]"
                                  : ""
                          )}>
                            {zapQuote?.priceImpact != null ? `${zapQuote.priceImpact.toFixed(2)}%` : "—"}
                          </span>
                        </div>
                        {/* Show value - for zap in, use output (vault shares) × underlying price */}
                        <div className="flex items-center justify-between py-1">
                          <span className="text-[var(--muted-foreground)]">Value</span>
                          <span className="mono">
                            {zapQuote ? (
                              <>~${(
                                zapDirection === "in"
                                  ? Number(zapQuote.outputAmountFormatted) * pricePerShare * underlyingPrice
                                  : Number(zapAmount) * pricePerShare * underlyingPrice
                              ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
                            ) : (
                              "—"
                            )}
                          </span>
                        </div>
                      </div>

                      {/* Zap Action Button */}
                      {isConnected ? (
                        <button
                          onClick={() => {
                            if (zapNeedsApproval()) {
                              zapApprove();
                            } else if ((zapQuote?.priceImpact ?? 0) >= PRICE_IMPACT_CONFIRM_THRESHOLD) {
                              // High price impact - show confirmation modal
                              setPriceImpactConfirmText("");
                              setShowPriceImpactModal(true);
                            } else {
                              executeZap();
                            }
                          }}
                          disabled={!zapQuote || zapIsLoading || zapQuoteLoading || (zapDirection === "in" ? Number(zapAmount) > zapInputBalanceNum : Number(zapAmount) > vaultBalance)}
                          className={cn(
                            "w-full py-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-base",
                            !zapQuote || zapQuoteLoading || (zapAmount && (zapDirection === "in" ? Number(zapAmount) > zapInputBalanceNum : Number(zapAmount) > vaultBalance))
                              ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                              : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 cursor-pointer"
                          )}
                        >
                          {zapIsLoading ? (
                            <>
                              <Loader2 size={18} className="animate-spin" />
                              {zapStatus === "approving" || zapStatus === "waitingApproval"
                                ? "Approving..."
                                : "Zapping..."}
                            </>
                          ) : zapQuoteLoading ? (
                            <>Getting quote<LoadingDots /></>
                          ) : !zapAmount || Number(zapAmount) === 0 ? (
                            "Enter amount"
                          ) : (zapDirection === "in" ? Number(zapAmount) > zapInputBalanceNum : Number(zapAmount) > vaultBalance) ? (
                            "Insufficient balance"
                          ) : !zapQuote ? (
                            "No route found"
                          ) : zapNeedsApproval() ? (
                            `Approve ${zapDirection === "in" ? zapInputToken?.symbol : vault.symbol}`
                          ) : (
                            `Zap ${zapDirection === "in" ? "In" : "Out"}`
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

                      {/* Enso Attribution + Route Toggle + Slippage Settings */}
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
                          {/* Route toggle */}
                          <button
                            onClick={toggleRoute}
                            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors p-1"
                            title={showRoute ? "Hide route" : "Show route"}
                          >
                            {showRoute ? <RouteOff size={16} /> : <Route size={16} />}
                          </button>
                          {/* Slippage settings */}
                          <button
                            onClick={() => setShowSlippageModal(true)}
                            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors p-1"
                            title="Slippage settings"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="4" y1="6" x2="20" y2="6"/>
                              <circle cx="8" cy="6" r="2"/>
                              <line x1="4" y1="18" x2="20" y2="18"/>
                              <circle cx="16" cy="18" r="2"/>
                            </svg>
                          </button>
                        </div>
                      </div>

                      {/* Route details panel - expandable with slide animation (only show when have quote or loading) */}
                      <div
                        className="grid transition-all duration-300 ease-in-out"
                        style={{ gridTemplateRows: showRoute && zapAmount && Number(zapAmount) > 0 && (zapQuote || zapQuoteLoading) ? "1fr" : "0fr" }}
                      >
                        <div className="overflow-hidden">
                          <div className="pt-3 mt-3 border-t border-[var(--border)]">
                            <div className="text-xs text-[var(--muted-foreground)] mb-2">Route</div>
                            <RouteDisplay
                              routeInfo={zapQuote?.routeInfo}
                              inputSymbol={zapDirection === "in" ? zapInputToken?.symbol : vault?.symbol}
                              outputSymbol={zapDirection === "in" ? vault?.symbol : zapOutputToken?.symbol}
                              inputAmount={zapAmount ? Number(zapAmount).toFixed(4) : undefined}
                              outputAmount={zapQuote?.outputAmountFormatted ? Number(zapQuote.outputAmountFormatted).toFixed(4) : undefined}
                              isLoading={zapQuoteLoading}
                            />
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Slippage Settings Modal */}
      {showSlippageModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowSlippageModal(false)}
          />
          <div className="relative bg-[var(--background)] border border-[var(--border)] rounded-xl w-full max-w-sm p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">Slippage Tolerance</h3>
              <button
                onClick={() => setShowSlippageModal(false)}
                className="p-1 hover:bg-[var(--muted)] rounded transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="text-sm text-[var(--muted-foreground)]">
              Maximum price change you&apos;re willing to accept. Higher slippage may result in worse rates.
            </p>

            {/* Preset buttons */}
            <div className="flex gap-2">
              {["10", "50", "100", "300"].map((value) => (
                <button
                  key={value}
                  onClick={() => updateSlippage(value)}
                  className={cn(
                    "flex-1 py-2 text-sm rounded-lg transition-colors",
                    zapSlippage === value
                      ? "bg-[var(--foreground)] text-[var(--background)]"
                      : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  )}
                >
                  {(Number(value) / 100).toFixed(1)}%
                </button>
              ))}
            </div>

            {/* Custom input */}
            <div>
              <label className="text-sm text-[var(--muted-foreground)] mb-2 block">Custom</label>
              <div className="relative">
                <input
                  type="number"
                  value={(Number(zapSlippage) / 100).toString()}
                  onChange={(e) => {
                    const percent = parseFloat(e.target.value) || 0;
                    const bps = Math.round(percent * 100).toString();
                    updateSlippage(bps);
                  }}
                  step="0.1"
                  min="0.01"
                  max="50"
                  className="w-full bg-[var(--muted)] rounded-lg p-3 pr-8 mono text-base focus:outline-none focus:ring-1 focus:ring-[var(--border-hover)]"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]">%</span>
              </div>
            </div>

            {/* Warning for high slippage */}
            {Number(zapSlippage) > 300 && (
              <p className="text-xs text-[var(--warning)] flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                High slippage increases risk of unfavorable trades
              </p>
            )}
          </div>
        </div>
      )}

      {/* Price Impact Confirmation Modal */}
      {showPriceImpactModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowPriceImpactModal(false)}
          />
          <div className="relative bg-[var(--background)] border border-[var(--border)] rounded-xl w-full max-w-sm p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-[var(--destructive)]">High Price Impact Warning</h3>
              <button
                onClick={() => setShowPriceImpactModal(false)}
                className="p-1 hover:bg-[var(--muted)] rounded transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="bg-[var(--destructive)]/10 border border-[var(--destructive)]/20 rounded-lg p-4">
              <p className="text-sm text-[var(--foreground)]">
                This transaction has a <span className="font-bold text-[var(--destructive)]">{zapQuote?.priceImpact?.toFixed(2)}%</span> price impact.
                You may receive significantly less value than expected.
              </p>
            </div>

            <p className="text-sm text-[var(--muted-foreground)]">
              Type <span className="font-mono font-bold text-[var(--foreground)]">CONFIRM</span> below to acknowledge the risk and proceed.
            </p>

            <input
              type="text"
              value={priceImpactConfirmText}
              onChange={(e) => setPriceImpactConfirmText(e.target.value.toUpperCase())}
              placeholder="Type CONFIRM"
              className="w-full bg-[var(--muted)] rounded-lg p-3 mono text-base focus:outline-none focus:ring-2 focus:ring-[var(--destructive)] placeholder:text-[var(--muted-foreground)]/50"
              autoFocus
            />

            <div className="flex gap-3">
              <button
                onClick={() => setShowPriceImpactModal(false)}
                className="flex-1 py-3 rounded-lg font-medium transition-all bg-[var(--muted)] text-[var(--foreground)] hover:bg-[var(--muted)]/80"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowPriceImpactModal(false);
                  setPriceImpactConfirmText("");
                  executeZap();
                }}
                disabled={priceImpactConfirmText !== "CONFIRM"}
                className={cn(
                  "flex-1 py-3 rounded-lg font-medium transition-all",
                  priceImpactConfirmText === "CONFIRM"
                    ? "bg-[var(--destructive)] text-white hover:opacity-90 cursor-pointer"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                )}
              >
                Zap {zapDirection === "in" ? "In" : "Out"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Contract Explorer Modal */}
      <ContractExplorer
        address={explorerAddress}
        isOpen={explorerOpen}
        onClose={closeExplorer}
        title={explorerTitle}
        lastUpdated={explorerLastUpdated}
        icon={explorerIcon}
      />
    </div>
  );
}
