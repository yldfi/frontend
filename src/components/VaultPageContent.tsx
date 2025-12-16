"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { CustomConnectButton } from "@/components/CustomConnectButton";
import { ArrowLeft, ArrowUpRight, ExternalLink, Loader2 } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";
import { useCurveLendingVault, formatCurveVaultData } from "@/hooks/useCurveLendingData";
import { useYearnVault, formatYearnVaultData, calculateStrategyNetApy } from "@/hooks/useYearnVault";
import { useVaultBalance } from "@/hooks/useVaultBalance";
import { useTokenBalance } from "@/hooks/useTokenBalance";
import { useCvxCrvPrice } from "@/hooks/useCvxCrvPrice";
import { usePricePerShare } from "@/hooks/usePricePerShare";
import { useVaultActions } from "@/hooks/useVaultActions";
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

// Token addresses
const CVXCRV_ADDRESS = "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7" as `0x${string}`;

// Vault/Strategy data
const vaultsData: Record<string, {
  name: string;
  symbol: string;
  token: string;
  description: string;
  longDescription: string;
  contractAddress: string;
  strategy: string;
  type: "vault" | "strategy";
  fees: { management: number; performance: number };
  links: { curve?: string; etherscan?: string };
  underlyingStrategy?: string;
  logo?: string;
}> = {
  ycvxcrv: {
    name: "ycvxCRV",
    symbol: "ycvxCRV",
    token: "cvxCRV",
    type: "vault",
    description: "Auto-compounding vault for cvxCRV tokens via Convex Finance",
    longDescription: "Deposits are allocated to the yscvxCRV strategy, which auto-compounds cvxCRV staking rewards from Convex. Use as collateral on Curve LlamaLend to borrow crvUSD. 15% of the 20% performance fee on yield is distributed to LlamaLend lenders to encourage borrowing liquidity.",
    contractAddress: "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86",
    strategy: "Convex cvxCRV Compounder",
    fees: { management: 0, performance: 20 },
    underlyingStrategy: "0xCa960E6DF1150100586c51382f619efCCcF72706",
    links: {
      curve: "https://www.curve.finance/lend/ethereum/markets/one-way-market-35/create",
      etherscan: "https://etherscan.io/address/0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86",
    },
    logo: "/ycvxcrv-128.png",
  },
  yscvxcrv: {
    name: "yscvxCRV",
    symbol: "yscvxCRV",
    token: "cvxCRV",
    type: "strategy",
    description: "Pure auto-compounding cvxCRV strategy",
    longDescription: "This strategy accepts cvxCRV deposits and stakes them on Convex Finance. Earned CRV, CVX, and 3CRV rewards are automatically harvested, swapped to cvxCRV, and re-deposited to compound your position. Lower 5% performance fee but cannot be used as collateral on LlamaLend.",
    contractAddress: "0xCa960E6DF1150100586c51382f619efCCcF72706",
    strategy: "Convex cvxCRV Compounder",
    fees: { management: 0, performance: 5 },
    links: {
      etherscan: "https://etherscan.io/address/0xCa960E6DF1150100586c51382f619efCCcF72706",
    },
    logo: "/yscvxcrv-128.png",
  },
};

export function VaultPageContent({ id }: { id: string }) {
  const vault = vaultsData[id];

  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [activeTab, setActiveTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");

  // Fetch Yearn Kong API data
  const { data: yearnData, isLoading: yearnLoading } = useYearnVault(vault?.contractAddress ?? "");
  const yearnVault = formatYearnVaultData(yearnData?.vault, yearnData?.vaultStrategies);

  // For strategy, also fetch parent vault data to get gross APR for calculating net APY
  const parentVaultAddress = vault?.type === "strategy" ? "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86" : null;
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
    vault?.type === "vault" ? vault?.contractAddress ?? "" : ""
  );
  const curveData = formatCurveVaultData(curveVault);

  // Fetch cvxCRV price from on-chain oracles
  const { price: cvxCrvPrice } = useCvxCrvPrice();

  // Fetch price per share from on-chain
  const vaultAddressTyped = (vault?.contractAddress ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
  const { pricePerShare, pricePerShareFormatted, isLoading: ppsLoading } = usePricePerShare(vaultAddressTyped);

  // Fetch user balances
  const { formatted: tokenBalanceFormatted, balance: tokenBalanceRaw, isLoading: tokenBalanceLoading } = useTokenBalance(CVXCRV_ADDRESS);
  const {
    formatted: vaultBalanceFormatted,
    balance: vaultBalanceRaw,
    isLoading: vaultBalanceLoading,
  } = useVaultBalance(
    vaultAddressTyped,
    pricePerShare,
    cvxCrvPrice
  );

  const tokenBalance = parseFloat(tokenBalanceFormatted) || 0;
  const vaultBalance = parseFloat(vaultBalanceFormatted) || 0;
  // Raw formatted strings preserve full precision for MAX button
  const tokenBalanceMax = tokenBalanceFormatted;
  const vaultBalanceMax = vaultBalanceFormatted;
  const exchangeRate = pricePerShare;

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
    depositHash,
    withdrawHash,
  } = useVaultActions(vaultAddressTyped, CVXCRV_ADDRESS, 18);

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
        trackApprovalSuccess(vault.token, id);
      }
      // Track deposit success (only when we have a tx hash confirming it happened)
      if (prevTxStatus.current === "waitingTx" && txStatus === "success" && activeTab === "deposit" && depositHash) {
        trackDepositSuccess(id, amount, vault.token);
      }
      // Track withdraw success (only when we have a tx hash confirming it happened)
      if (prevTxStatus.current === "waitingTx" && txStatus === "success" && activeTab === "withdraw" && withdrawHash) {
        trackWithdrawSuccess(id, amount, vault.token);
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
    return (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <p className="text-[var(--muted-foreground)]">Vault not found</p>
      </div>
    );
  }

  // Check if approval needed for deposit
  const requiresApproval = activeTab === "deposit" && amount && needsApproval(amount);

  const handleSubmit = async () => {
    if (!inputAmount || hasInsufficientBalance || !vault) return;

    if (activeTab === "deposit") {
      if (requiresApproval) {
        trackApprovalInitiated(vault.token, id);
        approve();
      } else {
        trackDepositInitiated(id, amount, vault.token);
        deposit(amount);
      }
    } else {
      trackWithdrawInitiated(id, amount, vault.token);
      withdraw(amount);
    }
  };

  // Reset on success and clear amount
  if (isSuccess && amount) {
    setAmount("");
    resetVaultActions();
  }

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-[var(--border)] backdrop-blur-lg bg-[var(--background)]/80">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Logo size={28} />
            <span className="mono text-lg font-medium tracking-tight">
              yld<span className="text-[var(--muted-foreground)]">_</span>fi
            </span>
          </Link>
          <CustomConnectButton />
        </div>
      </header>

      <main className="pt-16">
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
                    {vault.token}
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
                    <a
                      href={vault.links?.etherscan || `https://etherscan.io/address/${vault.contractAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono text-sm flex items-center gap-1 hover:text-[var(--accent)] transition-colors"
                    >
                      {vault.contractAddress.slice(0, 6)}...{vault.contractAddress.slice(-4)}
                      <ExternalLink size={12} />
                    </a>
                  </div>
                  {vault.underlyingStrategy && vault.type === "vault" && (
                    <div className="flex items-center justify-between py-3 border-b border-[var(--border)]">
                      <span className="text-[var(--muted-foreground)]">Strategy</span>
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
                          {" "}(${(curveData.collateralInAmm * pricePerShare * cvxCrvPrice).toLocaleString(undefined, { maximumFractionDigits: 0 })})
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Right column - Action Card */}
            <div className="lg:col-span-2">
              <div className="sticky top-24 border border-[var(--border)] rounded-xl overflow-hidden">
                {/* Your Position - Always visible when connected with balance */}
                {isConnected && vaultBalance > 0 && (
                  <div className="bg-[var(--muted)]/30 p-5 border-b border-[var(--border)]">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <span className="text-xs uppercase tracking-wider text-[var(--muted-foreground)]">Your Position</span>
                        <div className="mt-1">
                          <span className="mono text-2xl font-semibold">
                            {vaultBalanceLoading ? "..." : vaultBalance.toFixed(4)}
                          </span>
                          <span className="text-sm text-[var(--muted-foreground)] ml-1">
                            {vault.symbol}
                          </span>
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
                    {(["deposit", "withdraw"] as const).map((tab) => (
                      <button
                        key={tab}
                        onClick={() => {
                          setActiveTab(tab);
                          setAmount("");
                        }}
                        className={cn(
                          "flex-1 pb-3 text-sm font-medium transition-all capitalize relative cursor-pointer",
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

                {/* Form */}
                <div className="p-5 space-y-5">
                  {/* Input */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-[var(--muted-foreground)]">
                        {activeTab === "deposit" ? "Amount" : "Shares"}
                      </span>
                      <button
                        onClick={() => setAmount(activeTab === "deposit" ? tokenBalanceMax : vaultBalanceMax)}
                        className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
                      >
                        Balance: <span className="mono">
                          {(activeTab === "deposit" ? tokenBalanceLoading : vaultBalanceLoading)
                            ? "..."
                            : (activeTab === "deposit" ? tokenBalance : vaultBalance).toFixed(4)
                          }
                        </span>
                      </button>
                    </div>
                    <div className="relative">
                      <input
                        type="number"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.00"
                        className="w-full bg-[var(--muted)] rounded-lg p-4 pr-36 mono text-base focus:outline-none focus:ring-1 focus:ring-[var(--border-hover)] placeholder:text-[var(--muted-foreground)]/50"
                      />
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
                        <button
                          onClick={() => setAmount(activeTab === "deposit" ? tokenBalanceMax : vaultBalanceMax)}
                          className="px-2 py-1 text-xs font-medium bg-[var(--background)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded transition-colors cursor-pointer"
                        >
                          MAX
                        </button>
                        <span className="mono text-sm font-medium min-w-[3.75rem] text-right">
                          {activeTab === "deposit" ? vault.token : vault.symbol}
                        </span>
                      </div>
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
                    <div className="bg-[var(--muted)] rounded-lg p-4 flex items-center justify-between gap-2">
                      <span className="mono text-base text-[var(--foreground)] truncate min-w-0 flex-1">
                        {outputAmount > 0 ? outputAmount.toFixed(4) : "0.00"}
                      </span>
                      <span className="mono text-sm font-medium shrink-0">
                        {activeTab === "deposit" ? vault.symbol : vault.token}
                      </span>
                    </div>
                  </div>

                  {/* Details */}
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center justify-between py-1">
                      <span className="text-[var(--muted-foreground)]">Exchange rate</span>
                      <span className="mono">1 {vault.token} = {(1 / exchangeRate).toFixed(4)} {vault.symbol}</span>
                    </div>
                    <div className={cn(
                      "flex items-center justify-between py-1",
                      inputAmount > 0 ? "" : "invisible"
                    )}>
                      <span className="text-[var(--muted-foreground)]">Value</span>
                      <span className="mono">~${(inputAmount * cvxCrvPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
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
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
