"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { SlippageModal } from "@/components/SlippageModal";
import { SimulationModal } from "@/components/SimulationModal";
import { toast } from "sonner";
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
import type { LendingPosition } from "@/hooks/useCurveLendingPosition";
import { useCurveLendingActions } from "@/hooks/useCurveLendingActions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { TokenSelector } from "@/components/TokenSelector";
import { MaxButton } from "@/components/MaxButton";
import { RouteDisplay } from "@/components/RouteDisplay";
import { cn } from "@/lib/utils";
import { sanitizeAmount } from "@/lib/sanitize";
import { fetchRoute, fetchTokenPrices, ETH_ADDRESS } from "@/lib/enso";
import { CRVUSD_ADDRESS } from "@/lib/zapper";
import { CURVE_SAVINGS } from "@/config/vaults";
import { getVaultInfo } from "@/lib/curve-lending";
import { previewRedeem } from "@/lib/curve/rpc";
import type { EnsoToken, EnsoRouteResponse } from "@/types/enso";

const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// ERC4626 convertToAssets ABI (for vault token pricing)
const ERC4626_CONVERT_ABI = [
  {
    name: "convertToAssets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
] as const;

// Controller ABI for health calculator
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
] as const;

// crvUSD default token for TokenSelector
const CRVUSD_TOKEN: EnsoToken = {
  address: CRVUSD_ADDRESS,
  chainId: 1,
  name: "Curve.Fi USD Stablecoin",
  symbol: "crvUSD",
  decimals: 18,
  logoURI: "/tokens/crvusd.png",
  type: "base",
};

// scrvUSD (Savings crvUSD) - ERC4626 vault for crvUSD
const SCRVUSD_TOKEN: EnsoToken = {
  address: CURVE_SAVINGS.SCRVUSD,
  chainId: 1,
  name: "Savings crvUSD",
  symbol: "scrvUSD",
  decimals: 18,
  logoURI: "/tokens/scrvusd.png",
  type: "defi",
};

// Animated loading dots for quote fetching (matches VaultPageContent pattern)
function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="animate-bounce" style={{ animationDelay: "0ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "150ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "300ms", animationDuration: "600ms" }}>.</span>
    </span>
  );
}

interface RepayTabProps {
  vault: VaultConfig;
  position: LendingPosition | null;
  controllerAddress: `0x${string}`;
  onTransactionSuccess: () => void;
  onEstimatedHealthChange?: (health: number | null) => void;
}

export function RepayTab({
  vault,
  position,
  controllerAddress,
  onTransactionSuccess,
  onEstimatedHealthChange,
}: RepayTabProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  // Token selection (default: crvUSD)
  const [repayToken, setRepayToken] = useState<EnsoToken>(CRVUSD_TOKEN);
  const isCrvUsd =
    repayToken.address.toLowerCase() === CRVUSD_ADDRESS.toLowerCase();

  // Form state
  const [repayAmount, setRepayAmountState] = useState("");
  const setRepayAmount = useCallback(
    (v: string) => setRepayAmountState(sanitizeAmount(v)),
    []
  );

  // Slippage (basis points) - persisted to localStorage
  const [slippage, setSlippage] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("yldfi-slippage") || "50";
    }
    return "50";
  });
  const [showSlippageModal, setShowSlippageModal] = useState(false);

  // Route display toggle - persisted to localStorage
  const [showRoute, setShowRoute] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("yldfi-lending-show-route") !== "false";
    }
    return true;
  });

  // Health estimation
  const [estimatedHealth, setEstimatedHealth] = useState<number | null>(null);

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

  const toggleRoute = useCallback(() => {
    setShowRoute((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        localStorage.setItem("yldfi-lending-show-route", String(next));
      }
      return next;
    });
  }, []);

  // Lending actions
  const {
    repayDirect,
    repayWithSwap,
    pendingApproval,
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
  } = useCurveLendingActions();

  // Read selected token balance (native ETH or ERC20)
  const isEth = repayToken.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const { data: repayTokenBalance } = useBalance({
    address,
    token: isEth ? undefined : (repayToken.address as `0x${string}`),
    query: { enabled: !!address },
  });
  const balanceFormatted = repayTokenBalance?.formatted ?? "0";
  const currentBalance = repayTokenBalance?.value ?? 0n;

  const formattedBalance = useMemo(() => {
    const value = parseFloat(balanceFormatted) || 0;
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }, [balanceFormatted]);

  // Debounced amount for quote fetching
  const debouncedAmount = useDebouncedValue(repayAmount, 500);

  // Check if selected token is a vault token (ERC4626) that needs redeem → swap
  const vaultInfo = useMemo(
    () => (isCrvUsd ? null : getVaultInfo(repayToken.address)),
    [repayToken.address, isCrvUsd]
  );

  // Special case: vault with crvUSD underlying (e.g., scrvUSD) — redeem only, no swap
  const isVaultWithCrvUsdUnderlying = !!(
    vaultInfo && vaultInfo.underlying.toLowerCase() === CRVUSD_ADDRESS.toLowerCase()
  );

  // For vault tokens with crvUSD underlying (e.g., scrvUSD): just previewRedeem, no swap
  const {
    data: redeemPreview,
    isLoading: redeemPreviewLoading,
  } = useQuery({
    queryKey: ["repay-redeem-preview", repayToken.address, debouncedAmount],
    queryFn: async () => {
      const amountWei = parseUnits(debouncedAmount, repayToken.decimals).toString();
      return previewRedeem(vaultInfo!.address, amountWei);
    },
    enabled:
      isVaultWithCrvUsdUnderlying &&
      !!debouncedAmount &&
      Number(debouncedAmount) > 0,
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1,
  });

  // Fetch swap quote for non-crvUSD tokens that need a swap
  // For vault tokens: previewRedeem → fetchRoute(underlying → crvUSD)
  // For regular tokens: fetchRoute(token → crvUSD)
  const {
    data: swapQuote,
    isLoading: swapQuoteLoading,
  } = useQuery({
    queryKey: [
      "repay-swap-quote",
      repayToken.address,
      debouncedAmount,
      slippage,
      address,
      vaultInfo?.underlying ?? null,
    ],
    queryFn: async (): Promise<EnsoRouteResponse> => {
      if (!address) throw new Error("No address");
      const amountWei = parseUnits(
        debouncedAmount,
        repayToken.decimals
      ).toString();

      if (vaultInfo) {
        // Vault token: estimate underlying from redeem, then quote underlying → crvUSD
        const underlyingAmount = await previewRedeem(vaultInfo.address, amountWei);
        return fetchRoute({
          fromAddress: address,
          tokenIn: vaultInfo.underlying,
          tokenOut: CRVUSD_ADDRESS,
          amountIn: underlyingAmount,
          slippage,
        });
      }

      // Regular token: direct quote
      return fetchRoute({
        fromAddress: address,
        tokenIn: repayToken.address,
        tokenOut: CRVUSD_ADDRESS,
        amountIn: amountWei,
        slippage,
      });
    },
    enabled:
      !isCrvUsd &&
      !isVaultWithCrvUsdUnderlying &&
      !!address &&
      !!debouncedAmount &&
      Number(debouncedAmount) > 0,
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1,
  });

  // Unified quote loading state
  const quoteLoading = isVaultWithCrvUsdUnderlying ? redeemPreviewLoading : swapQuoteLoading;

  // Computed values from swap quote or redeem preview
  const estimatedCrvUsdOut = useMemo(() => {
    if (isVaultWithCrvUsdUnderlying && redeemPreview) {
      return BigInt(redeemPreview);
    }
    if (!swapQuote?.amountOut) return null;
    return BigInt(swapQuote.amountOut);
  }, [swapQuote, redeemPreview, isVaultWithCrvUsdUnderlying]);

  const exchangeRate = useMemo(() => {
    if (
      !swapQuote?.amountOut ||
      !debouncedAmount ||
      Number(debouncedAmount) === 0
    )
      return null;
    const outFormatted = Number(formatUnits(BigInt(swapQuote.amountOut), 18));
    return outFormatted / Number(debouncedAmount);
  }, [swapQuote, debouncedAmount]);

  // Price impact: manual calculation using USD token prices
  // Same pattern as BorrowTab: ((inputUsd - outputUsd) / inputUsd) × 100
  const priceTokenAddress = useMemo(() => {
    if (isEth) return WETH_ADDRESS;
    // For vault tokens, price the underlying (the actual swap is underlying → crvUSD)
    if (vaultInfo) return vaultInfo.underlying;
    return repayToken.address;
  }, [isEth, vaultInfo, repayToken.address]);

  const { data: tokenPrices } = useQuery({
    queryKey: ["repay-token-prices", priceTokenAddress],
    queryFn: () => fetchTokenPrices([priceTokenAddress, CRVUSD_ADDRESS]),
    enabled: !isCrvUsd && !isVaultWithCrvUsdUnderlying,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // For vault tokens: convert shares to underlying for accurate pricing
  const { data: repayUnderlyingEquivalent } = useQuery({
    queryKey: ["repay-underlying-eq", vaultInfo?.address, debouncedAmount],
    queryFn: async () => {
      if (!publicClient || !vaultInfo) throw new Error("Missing");
      const amountWei = parseUnits(debouncedAmount, repayToken.decimals);
      const result = await publicClient.readContract({
        address: vaultInfo.address as `0x${string}`,
        abi: ERC4626_CONVERT_ABI,
        functionName: "convertToAssets",
        args: [amountWei],
      });
      return result.toString();
    },
    enabled: !!vaultInfo && !!publicClient && !!debouncedAmount && Number(debouncedAmount) > 0,
    staleTime: 30_000,
  });

  const priceImpact = useMemo(() => {
    if (quoteLoading) return null;
    if (!estimatedCrvUsdOut || !debouncedAmount || Number(debouncedAmount) <= 0) return null;
    if (!tokenPrices || tokenPrices.length < 2) return null;

    const inputPrice = tokenPrices.find(
      (p) => p.address.toLowerCase() === priceTokenAddress.toLowerCase()
    )?.price;
    const crvUsdPrice = tokenPrices.find(
      (p) => p.address.toLowerCase() === CRVUSD_ADDRESS.toLowerCase()
    )?.price;
    if (!inputPrice || !crvUsdPrice) return null;

    // For vault tokens: use underlying equivalent amount; for regular tokens: use debounced amount
    const inputAmount = vaultInfo && repayUnderlyingEquivalent
      ? Number(formatUnits(BigInt(repayUnderlyingEquivalent), 18))
      : Number(debouncedAmount);
    const inputUsd = inputAmount * inputPrice;
    // Output: crvUSD received × crvUSD price
    const outputUsd = Number(formatUnits(estimatedCrvUsdOut, 18)) * crvUsdPrice;
    if (inputUsd === 0) return null;
    return ((inputUsd - outputUsd) / inputUsd) * 100;
  }, [quoteLoading, estimatedCrvUsdOut, debouncedAmount, tokenPrices, priceTokenAddress, vaultInfo, repayUnderlyingEquivalent]);

  // Determine if repaying full debt
  const isClosingLoan = useMemo(() => {
    if (!position?.hasLoan || !repayAmount) return false;
    try {
      if (isCrvUsd) {
        const repayWei = parseUnits(repayAmount, 18);
        return repayWei >= position.debt;
      }
      if (estimatedCrvUsdOut !== null) {
        return estimatedCrvUsdOut >= position.debt;
      }
    } catch {
      // Invalid amount
    }
    return false;
  }, [position, repayAmount, isCrvUsd, estimatedCrvUsdOut]);

  // Calculate estimated health
  useEffect(() => {
    async function calculateHealth() {
      if (!publicClient || !controllerAddress || !address || !position?.hasLoan) {
        setEstimatedHealth(null);
        return;
      }

      // Don't show health when closing loan entirely
      if (isClosingLoan) {
        setEstimatedHealth(null);
        return;
      }

      try {
        let dDebt = 0n;

        if (isCrvUsd && repayAmount) {
          const repayWei = parseUnits(repayAmount, 18);
          // Cap at debt
          const capped = repayWei > position.debt ? position.debt : repayWei;
          dDebt = -capped;
        } else if (!isCrvUsd && estimatedCrvUsdOut !== null) {
          const capped =
            estimatedCrvUsdOut > position.debt
              ? position.debt
              : estimatedCrvUsdOut;
          dDebt = -capped;
        }

        if (dDebt === 0n) {
          setEstimatedHealth(null);
          return;
        }

        const health = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "health_calculator",
          args: [address, 0n, BigInt(dDebt), true, 0n],
        });

        setEstimatedHealth(Number(health) / 1e16);
      } catch {
        setEstimatedHealth(null);
      }
    }

    const timer = setTimeout(calculateHealth, 300);
    return () => clearTimeout(timer);
  }, [
    publicClient,
    controllerAddress,
    address,
    position,
    repayAmount,
    isCrvUsd,
    estimatedCrvUsdOut,
    isClosingLoan,
  ]);

  // Report estimated health to parent
  useEffect(() => {
    onEstimatedHealthChange?.(estimatedHealth);
  }, [estimatedHealth, onEstimatedHealthChange]);

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

  // Clear amount when switching tokens
  useEffect(() => {
    setRepayAmountState("");
  }, [repayToken.address]);

  const handleSubmit = async () => {
    if (!address || !controllerAddress || !repayAmount || !position?.hasLoan)
      return;

    try {
      if (isCrvUsd) {
        // Path A: direct controller.repay()
        const repayWei = parseUnits(repayAmount, 18);
        if (showSimulationPreview) {
          const result = await repayDirect(controllerAddress, repayWei, { previewOnly: true });
          if (result) {
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
        } else {
          await repayDirect(controllerAddress, repayWei);
        }
      } else {
        // Path B: Enso swap + repay
        const result = await repayWithSwap(
          vault.address as `0x${string}`,
          repayToken.address,
          repayAmount,
          Number(slippage),
          { previewOnly: showSimulationPreview, tokenSymbol: repayToken.symbol }
        );
        if (result && showSimulationPreview) {
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
      }
    } catch (err) {
      console.error("Repay action failed:", err);
    }
  };

  const handleExecute = async () => {
    try {
      await executeAfterPreview();
    } catch (err) {
      console.error("Repay execution failed:", err);
    }
  };

  const isProcessing =
    status !== "idle" &&
    status !== "success" &&
    status !== "error" &&
    status !== "needsApproval";

  const hasInsufficientBalance = useMemo(() => {
    if (!repayAmount || Number(repayAmount) === 0) return false;
    try {
      const amountWei = parseUnits(repayAmount, repayToken.decimals);
      return amountWei > currentBalance;
    } catch {
      return false;
    }
  }, [repayAmount, repayToken.decimals, currentBalance]);

  const isFormValid =
    !!repayAmount &&
    Number(repayAmount) > 0 &&
    position?.hasLoan &&
    !hasInsufficientBalance &&
    (isCrvUsd || isVaultWithCrvUsdUnderlying || (!isCrvUsd && !quoteLoading));

  const getButtonText = () => {
    if (status === "building") return "Building transaction...";
    if (status === "simulating") return "Simulating...";
    if (status === "executing") return "Confirm in wallet...";
    if (status === "waitingTx") return "Waiting for confirmation...";
    if (status === "success") return "Done!";
    if (status === "error") return "Try Again";
    if (hasInsufficientBalance) return "Insufficient balance";

    if (isCrvUsd) {
      return isClosingLoan ? "Close Loan" : "Repay Debt";
    }
    if (isVaultWithCrvUsdUnderlying) {
      return isClosingLoan ? "Redeem & Close Loan" : "Redeem & Repay";
    }
    return isClosingLoan ? "Swap & Close Loan" : "Swap & Repay";
  };

  if (!position?.hasLoan) {
    return (
      <div className="text-center text-sm text-[var(--muted-foreground)] py-8">
        No active loan to repay
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Token Selector + Amount Input */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-[var(--muted-foreground)]">
            Repay With
          </label>
          <span className="text-xs text-[var(--muted-foreground)]">
            Balance: {formattedBalance}
          </span>
        </div>
        <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:border-[var(--foreground)]">
          <input
            type="text"
            value={repayAmount}
            onChange={(e) => setRepayAmount(e.target.value)}
            placeholder="0.0"
            className="flex-1 min-w-0 bg-transparent mono text-base outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
          />
          <TokenSelector
            selectedToken={repayToken}
            onSelect={setRepayToken}
            priorityTokens={[CRVUSD_TOKEN, SCRVUSD_TOKEN]}
            excludeDefiTokens
          />
          <MaxButton
            balance={balanceFormatted}
            onSelect={setRepayAmount}
          />
        </div>
      </div>

      {/* Quote details (non-crvUSD, when amount entered and quote loaded) */}
      {!isCrvUsd && repayAmount && Number(repayAmount) > 0 && (
        <>
          {/* Vault with crvUSD underlying (e.g., scrvUSD): show repay amount only */}
          {isVaultWithCrvUsdUnderlying && estimatedCrvUsdOut !== null && !quoteLoading && (
            <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-[var(--muted-foreground)]">Repaying</span>
                <span className="mono">
                  ~{Number(formatUnits(estimatedCrvUsdOut, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                  / {Number(formatUnits(position.debt, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD
                </span>
              </div>
            </div>
          )}

          {/* Regular swap: show rate, impact, repay amount */}
          {!isVaultWithCrvUsdUnderlying && swapQuote && !quoteLoading && (
            <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-2 text-sm">
              {/* Exchange rate */}
              {exchangeRate !== null && (
                <div className="flex justify-between">
                  <span className="text-[var(--muted-foreground)]">Rate</span>
                  <span className="mono">
                    1 {repayToken.symbol} ={" "}
                    {exchangeRate.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}{" "}
                    crvUSD
                  </span>
                </div>
              )}

              {/* Price impact */}
              {priceImpact !== null && (
                <div className="flex justify-between">
                  <span className="text-[var(--muted-foreground)]">
                    Price Impact
                  </span>
                  <span
                    className={cn(
                      "mono",
                      priceImpact <= 0
                        ? "text-green-500"
                        : priceImpact < 3
                          ? "text-yellow-500"
                          : "text-red-500"
                    )}
                  >
                    {priceImpact > 0 ? "" : "+"}{(-priceImpact).toFixed(2)}%
                  </span>
                </div>
              )}

              {/* Repaying amount */}
              {estimatedCrvUsdOut !== null && (
                <div className="flex justify-between">
                  <span className="text-[var(--muted-foreground)]">
                    Repaying
                  </span>
                  <span className="mono">
                    ~
                    {Number(
                      formatUnits(estimatedCrvUsdOut, 18)
                    ).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                    /{" "}
                    {Number(formatUnits(position.debt, 18)).toLocaleString(
                      undefined,
                      { maximumFractionDigits: 2 }
                    )}{" "}
                    crvUSD
                  </span>
                </div>
              )}
            </div>
          )}
        </>
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
                {isApproving ? "Approving..." : `Exact (~${Number(formatUnits(pendingApproval.amount, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })})`}
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
              {isApproving ? "Approving..." : "Approve"}
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
            toast("Transaction cancelled", { id: "repay-cancelled", duration: 3000 });
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
              // Re-open cached simulation modal if same block
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
          {!isCrvUsd && quoteLoading && status === "idle" ? (
            <>Getting quote<LoadingDots /></>
          ) : (
            getButtonText()
          )}
        </button>
      )}

      {/* Settings icon for direct crvUSD / vault-crvUSD paths */}
      {(isCrvUsd || isVaultWithCrvUsdUnderlying) && (
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

      {/* Enso Attribution + Route Toggle + Slippage Settings (after button, like zap) */}
      {!isCrvUsd && !isVaultWithCrvUsdUnderlying && (
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
                {showRoute ? <RouteOff size={16} /> : <Route size={16} />}
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

          {/* Route details panel - expandable with slide animation */}
          <div
            className="grid transition-all duration-300 ease-in-out"
            style={{
              gridTemplateRows:
                showRoute && repayAmount && Number(repayAmount) > 0 && (swapQuote || quoteLoading) ? "1fr" : "0fr",
            }}
          >
            <div className="overflow-hidden">
              <div className="pt-3 mt-3 border-t border-[var(--border)]">
                <div className="text-xs text-[var(--muted-foreground)] mb-2">
                  Route
                </div>
                <RouteDisplay
                  routeInfo={
                    swapQuote
                      ? {
                          steps: [
                            // For vault tokens: Redeem → Swap underlying → Repay
                            // For regular tokens: Swap → Repay
                            ...(vaultInfo
                              ? [
                                  {
                                    tokenSymbol: repayToken.symbol,
                                    action: "Redeem",
                                    description: `${repayToken.symbol} for ${vaultInfo.underlyingSymbol}`,
                                    protocol: "ERC4626",
                                  },
                                  {
                                    tokenSymbol: vaultInfo.underlyingSymbol,
                                    action: "Swap",
                                    description: `${vaultInfo.underlyingSymbol} for crvUSD`,
                                    protocol: "Enso Router",
                                  },
                                ]
                              : [
                                  {
                                    tokenSymbol: repayToken.symbol,
                                    action: "Swap",
                                    description: `${repayToken.symbol} for crvUSD`,
                                    protocol: "Enso Router",
                                  },
                                ]),
                            {
                              tokenSymbol: "crvUSD",
                              action: "Repay",
                              description: "crvUSD debt via Curve",
                              protocol: "Curve LlamaLend",
                            },
                          ],
                        }
                      : undefined
                  }
                  inputSymbol={repayToken.symbol}
                  outputSymbol="crvUSD"
                  inputAmount={
                    repayAmount ? Number(repayAmount).toFixed(4) : undefined
                  }
                  outputAmount={
                    estimatedCrvUsdOut
                      ? Number(formatUnits(estimatedCrvUsdOut, 18)).toFixed(4)
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
          Connect your wallet to repay
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
