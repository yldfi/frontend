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
  Plus,
  X,
} from "lucide-react";
import { ApprovalCard } from "@/components/ApprovalCard";
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
import { getMaxEthAmount } from "@/lib/eth-gas";
import { CRVUSD_ADDRESS, WETH_ADDRESS } from "@/config/addresses";
import { CURVE_SAVINGS } from "@/config/vaults";
import { getVaultInfo } from "@/lib/curve-lending";
// previewRedeem ABI for ERC4626 vaults
const PREVIEW_REDEEM_ABI = [{
  inputs: [{ name: "shares", type: "uint256" }],
  name: "previewRedeem",
  outputs: [{ name: "", type: "uint256" }],
  stateMutability: "view",
  type: "function",
}] as const;
import type { EnsoToken, EnsoRouteResponse } from "@/types/enso";

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
  onDebtDeltaChange?: (delta: bigint | null) => void;
  onCollateralDeltaChange?: (delta: bigint | null) => void;
  onTxStateChange?: (state: { status: "pending" | "success" | "reverted"; action: string; hash: string; details?: { fromAmount: string; fromSymbol: string; fromLogo: string; toAmount: string; toSymbol: string; toLogo: string } } | null) => void;
  onSwitchTab?: (tab: string) => void;
}

export function RepayTab({
  vault,
  position,
  controllerAddress,
  onTransactionSuccess,
  onEstimatedHealthChange,
  onDebtDeltaChange,
  onCollateralDeltaChange,
  onTxStateChange,
  onSwitchTab,
}: RepayTabProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  // Token selection (default: crvUSD)
  const [repayToken, setRepayToken] = useState<EnsoToken>(CRVUSD_TOKEN);
  const isCrvUsd =
    repayToken.address.toLowerCase() === CRVUSD_ADDRESS.toLowerCase();

  // Close loan is an explicit user action (CLOSE button only) — never auto-derived from amounts
  const [isClosingLoan, setIsClosingLoan] = useState(false);

  // Form state — persisted across refresh
  const repayStorageKey = `yldfi-lending-repay-${vault.address}`;
  const [repayAmount, setRepayAmountState] = useState(() => {
    if (typeof window === "undefined") return "";
    try { return sanitizeAmount(localStorage.getItem(repayStorageKey) ?? ""); } catch { return ""; }
  });
  const setRepayAmount = useCallback(
    (v: string) => {
      const sanitized = sanitizeAmount(v);
      setRepayAmountState(sanitized);
      setIsClosingLoan(false);
      hasAutoCapped.current = false;
      try {
        if (sanitized) localStorage.setItem(repayStorageKey, sanitized);
        else localStorage.removeItem(repayStorageKey);
      } catch { /* */ }
    },
    [repayStorageKey]
  );

  // Withdraw collateral (optional)
  const [showWithdrawInput, setShowWithdrawInput] = useState(false);
  const [withdrawAmount, setWithdrawAmountState] = useState("");
  const setWithdrawAmount = useCallback(
    (v: string) => setWithdrawAmountState(sanitizeAmount(v)),
    []
  );
  const debouncedWithdrawAmount = useDebouncedValue(withdrawAmount, 500);

  // Withdrawal output token (default: vault's collateral token; can swap to other tokens)
  const defaultWithdrawToken: EnsoToken = useMemo(() => ({
    address: vault.address,
    chainId: 1,
    name: vault.name,
    symbol: vault.symbol,
    decimals: vault.decimals,
    logoURI: vault.logoSmall || "",
    type: "defi" as const,
  }), [vault]);
  const [withdrawToken, setWithdrawToken] = useState<EnsoToken>(defaultWithdrawToken);
  const isWithdrawSwap = withdrawToken.address.toLowerCase() !== vault.address.toLowerCase();

  // Slippage (basis points) - persisted to localStorage
  const [rateInverted, setRateInverted] = useState(false);
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
  const hasAutoCapped = useRef(false);
  // Suppress rate box display while auto-cap is adjusting the amount and re-quoting
  const [suppressQuoteDisplay, setSuppressQuoteDisplay] = useState(false);
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
    repayAndWithdraw,
    repayWithSwap,
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
  } = useCurveLendingActions();

  // Preserve last approval data so content stays in DOM during close animation
  const lastApprovalRef = useRef(pendingApproval);
  if (pendingApproval) lastApprovalRef.current = pendingApproval;
  const showApprovalCard = !!(pendingApproval && (status === "needsApproval" || status === "approving"));


  // Read selected token balance (native ETH or ERC20)
  const isEth = repayToken.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const { data: repayTokenBalance, refetch: refetchBalance } = useBalance({
    address,
    token: isEth ? undefined : (repayToken.address as `0x${string}`),
    query: { enabled: !!address },
  });
  // For ETH: reserve gas from max balance
  const balanceFormatted = isEth && repayTokenBalance?.value
    ? getMaxEthAmount(repayTokenBalance.value, gasPrice)
    : repayTokenBalance?.formatted ?? "0";
  const currentBalance = repayTokenBalance?.value ?? 0n;

  const formattedBalance = useMemo(() => {
    const value = parseFloat(balanceFormatted) || 0;
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }, [balanceFormatted]);

  // Collateral balance for optional withdrawal
  const formattedCollateral = useMemo(() => {
    if (!position?.collateral) return "0";
    const value = Number(formatUnits(position.collateral, vault.decimals));
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }, [position?.collateral, vault.decimals]);

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

  // Intermediate amount for route display (underlying amount from vault redeem)
  const [redeemIntermediateAmount, setRedeemIntermediateAmount] = useState<string | null>(null);

  // For vault tokens with crvUSD underlying (e.g., scrvUSD): just previewRedeem, no swap
  const {
    data: redeemPreview,
    isLoading: redeemPreviewLoading,
  } = useQuery({
    queryKey: ["repay-redeem-preview", repayToken.address, debouncedAmount],
    queryFn: async () => {
      if (!publicClient) throw new Error("No public client");
      const amountWei = parseUnits(debouncedAmount, repayToken.decimals);
      const result = await publicClient.readContract({
        address: vaultInfo!.address as `0x${string}`,
        abi: PREVIEW_REDEEM_ABI,
        functionName: "previewRedeem",
        args: [amountWei],
      });
      return result.toString();
    },
    enabled:
      isVaultWithCrvUsdUnderlying &&
      !!publicClient &&
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
      if (!address || !publicClient) throw new Error("No address or client");
      const amountWei = parseUnits(
        debouncedAmount,
        repayToken.decimals
      );

      if (vaultInfo) {
        // Vault token: estimate underlying from redeem, then quote underlying → crvUSD
        const underlyingAmount = await publicClient.readContract({
          address: vaultInfo.address as `0x${string}`,
          abi: PREVIEW_REDEEM_ABI,
          functionName: "previewRedeem",
          args: [amountWei],
        });
        // Store intermediate amount for route display
        setRedeemIntermediateAmount(
          Number(formatUnits(underlyingAmount, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })
        );
        return fetchRoute({
          fromAddress: address,
          tokenIn: vaultInfo.underlying,
          tokenOut: CRVUSD_ADDRESS,
          amountIn: underlyingAmount.toString(),
          slippage,
        });
      }

      setRedeemIntermediateAmount(null);
      // Regular token: direct quote
      return fetchRoute({
        fromAddress: address,
        tokenIn: repayToken.address,
        tokenOut: CRVUSD_ADDRESS,
        amountIn: amountWei.toString(),
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
    if (!debouncedAmount || Number(debouncedAmount) === 0) return null;
    // For vault-with-crvUSD-underlying: use redeem preview
    if (isVaultWithCrvUsdUnderlying && redeemPreview) {
      const outFormatted = Number(formatUnits(BigInt(redeemPreview), 18));
      return outFormatted / Number(debouncedAmount);
    }
    // For regular swaps: use swap quote
    if (!swapQuote?.amountOut) return null;
    const outFormatted = Number(formatUnits(BigInt(swapQuote.amountOut), 18));
    return outFormatted / Number(debouncedAmount);
  }, [swapQuote, debouncedAmount, isVaultWithCrvUsdUnderlying, redeemPreview]);

  // Pre-compute max repay in token units for non-crvUSD tokens (same pattern as BorrowTab's maxTokenEquivalent)
  // Converts debt (crvUSD) → repay token amount via forward quote
  const { data: maxRepayTokenEquivalent } = useQuery({
    queryKey: [
      "repay-max-token",
      repayToken.address,
      position?.debt?.toString(),
      address,
    ],
    queryFn: async () => {
      if (!address || !publicClient || !position?.debt || position.debt === 0n) throw new Error("Missing");

      if (isVaultWithCrvUsdUnderlying) {
        // scrvUSD: estimate deposit shares for debt crvUSD via previewRedeem ratio
        const oneShare = 10n ** 18n;
        const crvUsdPerShare = await publicClient.readContract({
          address: vaultInfo!.address as `0x${string}`,
          abi: PREVIEW_REDEEM_ABI,
          functionName: "previewRedeem",
          args: [oneShare],
        });
        // maxShares = debt / (crvUsdPerShare / 1e18)
        const maxShares = (position.debt * 10n ** 18n) / BigInt(crvUsdPerShare);
        // Apply 0.1% haircut to avoid exceeding debt on reverse check
        const haircut = maxShares * 999n / 1000n;
        return formatUnits(haircut, repayToken.decimals);
      }

      // Regular token or vault with non-crvUSD underlying: forward quote crvUSD → token
      const quote = await fetchRoute({
        fromAddress: address,
        tokenIn: CRVUSD_ADDRESS,
        tokenOut: vaultInfo ? vaultInfo.underlying : repayToken.address,
        amountIn: position.debt.toString(),
        slippage: "300",
      });
      if (!quote?.amountOut) return null;

      if (vaultInfo) {
        // Vault token: convert underlying → shares, then haircut
        const underlyingAmount = BigInt(quote.amountOut);
        const oneShare = 10n ** 18n;
        const underlyingPerShare = await publicClient.readContract({
          address: vaultInfo.address as `0x${string}`,
          abi: PREVIEW_REDEEM_ABI,
          functionName: "previewRedeem",
          args: [oneShare],
        });
        const maxShares = (underlyingAmount * oneShare) / underlyingPerShare;
        const haircut = maxShares * 99n / 100n;
        return formatUnits(haircut, repayToken.decimals);
      }

      // Regular token: apply 0.5% haircut for quote spread
      const out = Number(formatUnits(BigInt(quote.amountOut), repayToken.decimals));
      return (out * 0.995).toFixed(Math.min(repayToken.decimals, 8));
    },
    enabled: !isCrvUsd && !!address && !!publicClient && !!position?.debt && position.debt > 0n,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });

  // Max repay amount that won't close the loan (CLOSE button handles full closure)
  const maxRepayBalance = useMemo(() => {
    if (!position?.hasLoan || !position.debt) return balanceFormatted;
    const balance = parseFloat(balanceFormatted) || 0;
    if (balance === 0) return balanceFormatted;

    if (isCrvUsd) {
      // For crvUSD: cap at debt so we don't overpay
      const debt = Number(formatUnits(position.debt, 18));
      if (balance <= debt) return balanceFormatted;
      return debt.toFixed(4);
    }

    // For non-crvUSD: use pre-computed token equivalent of debt
    if (maxRepayTokenEquivalent) {
      const maxTokens = parseFloat(maxRepayTokenEquivalent);
      if (balance <= maxTokens) return balanceFormatted;
      return maxRepayTokenEquivalent;
    }

    return balanceFormatted;
  }, [balanceFormatted, position?.hasLoan, position?.debt, isCrvUsd, maxRepayTokenEquivalent]);

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
    enabled: !isCrvUsd,
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

  // Compute max withdrawable collateral via binary search on health_calculator.
  // Pre-computed so MAX button is instant; recalculates when repay amount changes.
  const { data: maxWithdrawable } = useQuery({
    queryKey: [
      "max-withdrawable",
      controllerAddress,
      address,
      debouncedAmount,
      isCrvUsd,
      estimatedCrvUsdOut?.toString(),
      position?.collateral?.toString(),
      position?.debt?.toString(),
    ],
    queryFn: async () => {
      if (!publicClient || !address || !position?.hasLoan || !position.collateral) return "0";

      // Calculate debt change from current repay input
      let dDebt = 0n;
      if (isCrvUsd && debouncedAmount && Number(debouncedAmount) > 0) {
        try {
          const repayWei = parseUnits(debouncedAmount, 18);
          dDebt = -(repayWei > position.debt ? position.debt : repayWei);
        } catch { /* invalid input */ }
      } else if (!isCrvUsd && estimatedCrvUsdOut !== null) {
        dDebt = -(estimatedCrvUsdOut > position.debt ? position.debt : estimatedCrvUsdOut);
      }

      const total = position.collateral;
      const minHealth = 5n * 10n ** 14n; // 5% health buffer

      // Quick check: can we withdraw everything?
      try {
        const h = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "health_calculator",
          args: [address, -total, BigInt(dDebt), true, 0n],
        }) as bigint;
        if (h > minHealth) {
          return parseFloat(Number(formatUnits(total, vault.decimals)).toFixed(4)).toString();
        }
      } catch { /* full withdrawal not possible */ }

      // Binary search for max withdrawable
      let low = 0n;
      let high = total;

      for (let i = 0; i < 10; i++) {
        const mid = (low + high) / 2n;
        if (mid === low) break;
        try {
          const h = await publicClient.readContract({
            address: controllerAddress,
            abi: CONTROLLER_ABI,
            functionName: "health_calculator",
            args: [address, -mid, BigInt(dDebt), true, 0n],
          }) as bigint;
          if (h > minHealth) {
            low = mid;
          } else {
            high = mid;
          }
        } catch {
          high = mid;
        }
      }

      return parseFloat(Number(formatUnits(low, vault.decimals)).toFixed(4)).toString();
    },
    enabled: !!publicClient && !!address && !!position?.hasLoan && !isClosingLoan && !position?.inSoftLiquidation,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  // For non-collateral withdrawal tokens: convert maxWithdrawable to withdrawal token units
  // Used for MAX button display and input → collateral conversion rate
  const { data: maxWithdrawInTokenUnits } = useQuery({
    queryKey: [
      "max-withdraw-token",
      vault.address,
      withdrawToken.address,
      maxWithdrawable,
      address,
    ],
    queryFn: async () => {
      if (!address || !maxWithdrawable || Number(maxWithdrawable) <= 0) throw new Error("Missing");
      const amountWei = parseUnits(maxWithdrawable, vault.decimals);
      const quote = await fetchRoute({
        fromAddress: address,
        tokenIn: vault.address,
        tokenOut: withdrawToken.address,
        amountIn: amountWei.toString(),
        slippage: "300",
      });
      if (!quote?.amountOut) return null;
      const out = Number(formatUnits(BigInt(quote.amountOut), withdrawToken.decimals));
      // Apply small haircut for quote spread (0.5%)
      return (out * 0.995).toFixed(Math.min(withdrawToken.decimals, 8));
    },
    enabled: isWithdrawSwap && !!address && !!maxWithdrawable && Number(maxWithdrawable) > 0,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });

  // Reverse quote: withdrawal token → collateral (same pattern as BorrowTab's swapQuote)
  // User enters desired token amount; quote tells us how much collateral to withdraw
  const {
    data: withdrawReverseQuote,
    isLoading: withdrawSwapLoading,
  } = useQuery({
    queryKey: [
      "withdraw-reverse-quote",
      vault.address,
      withdrawToken.address,
      debouncedWithdrawAmount,
      slippage,
      address,
    ],
    queryFn: async (): Promise<EnsoRouteResponse> => {
      if (!address) throw new Error("No address");
      const amountWei = parseUnits(debouncedWithdrawAmount, withdrawToken.decimals);
      return fetchRoute({
        fromAddress: address,
        tokenIn: withdrawToken.address,
        tokenOut: vault.address,
        amountIn: amountWei.toString(),
        slippage,
      });
    },
    enabled:
      isWithdrawSwap &&
      !!address &&
      !!debouncedWithdrawAmount &&
      Number(debouncedWithdrawAmount) > 0,
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1,
  });

  // Collateral amount in wei — for non-collateral tokens, derived from reverse quote
  const withdrawAmountWei = useMemo(() => {
    if (!debouncedWithdrawAmount || Number(debouncedWithdrawAmount) === 0) return 0n;
    try {
      if (isWithdrawSwap) {
        // Use reverse quote output: exact collateral equivalent for desired token amount
        if (!withdrawReverseQuote?.amountOut) return 0n;
        return BigInt(withdrawReverseQuote.amountOut);
      }
      return parseUnits(debouncedWithdrawAmount, vault.decimals);
    } catch {
      return 0n;
    }
  }, [debouncedWithdrawAmount, vault.decimals, isWithdrawSwap, withdrawReverseQuote]);

  // Rate: 1 collateral = X withdrawal token (derived from reverse quote)
  const withdrawSwapRate = useMemo(() => {
    if (!isWithdrawSwap || !debouncedWithdrawAmount || Number(debouncedWithdrawAmount) === 0) return null;
    if (!withdrawReverseQuote?.amountOut) return null;
    const collateralFormatted = Number(formatUnits(BigInt(withdrawReverseQuote.amountOut), vault.decimals));
    if (collateralFormatted === 0) return null;
    return Number(debouncedWithdrawAmount) / collateralFormatted;
  }, [withdrawReverseQuote, debouncedWithdrawAmount, isWithdrawSwap, vault.decimals]);

  // Estimated collateral to withdraw (for display in quote box)
  const withdrawCollateralEstimate = useMemo(() => {
    if (!withdrawReverseQuote?.amountOut) return null;
    return Number(formatUnits(BigInt(withdrawReverseQuote.amountOut), vault.decimals));
  }, [withdrawReverseQuote, vault.decimals]);

  // Withdrawal price impact: manual USD comparison (same pattern as repay priceImpact)
  // Collateral is a vault token (ERC4626) — price its underlying for accuracy
  const collateralVaultInfo = useMemo(
    () => getVaultInfo(vault.address),
    [vault.address]
  );

  const withdrawPriceTokenAddress = useMemo(() => {
    if (collateralVaultInfo) return collateralVaultInfo.underlying;
    return vault.address;
  }, [collateralVaultInfo, vault.address]);

  const withdrawOutputPriceAddress = useMemo(() => {
    if (withdrawToken.address.toLowerCase() === ETH_ADDRESS.toLowerCase()) return WETH_ADDRESS;
    return withdrawToken.address;
  }, [withdrawToken.address]);

  const { data: withdrawTokenPrices } = useQuery({
    queryKey: ["withdraw-token-prices", withdrawPriceTokenAddress, withdrawOutputPriceAddress],
    queryFn: () => fetchTokenPrices([withdrawPriceTokenAddress, withdrawOutputPriceAddress]),
    enabled: isWithdrawSwap,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Convert collateral to underlying for accurate USD pricing (if vault token)
  const { data: withdrawCollateralUnderlying } = useQuery({
    queryKey: ["withdraw-collateral-underlying", collateralVaultInfo?.address, withdrawAmountWei.toString()],
    queryFn: async () => {
      if (!publicClient || !collateralVaultInfo) throw new Error("Missing");
      const result = await publicClient.readContract({
        address: collateralVaultInfo.address as `0x${string}`,
        abi: ERC4626_CONVERT_ABI,
        functionName: "convertToAssets",
        args: [withdrawAmountWei],
      });
      return result.toString();
    },
    enabled: !!collateralVaultInfo && !!publicClient && withdrawAmountWei > 0n,
    staleTime: 30_000,
  });

  const withdrawPriceImpact = useMemo(() => {
    if (withdrawSwapLoading) return null;
    if (!withdrawCollateralEstimate || !debouncedWithdrawAmount || Number(debouncedWithdrawAmount) <= 0) return null;
    if (!withdrawTokenPrices || withdrawTokenPrices.length < 2) return null;

    const collateralPrice = withdrawTokenPrices.find(
      (p) => p.address.toLowerCase() === withdrawPriceTokenAddress.toLowerCase()
    )?.price;
    const outputPrice = withdrawTokenPrices.find(
      (p) => p.address.toLowerCase() === withdrawOutputPriceAddress.toLowerCase()
    )?.price;
    if (!collateralPrice || !outputPrice) return null;

    // Input: collateral value (use underlying equivalent if vault token)
    const inputAmount = collateralVaultInfo && withdrawCollateralUnderlying
      ? Number(formatUnits(BigInt(withdrawCollateralUnderlying), 18))
      : withdrawCollateralEstimate;
    const inputUsd = inputAmount * collateralPrice;
    // Output: withdrawal token value (what user receives)
    const outputUsd = Number(debouncedWithdrawAmount) * outputPrice;
    if (inputUsd === 0) return null;
    return ((inputUsd - outputUsd) / inputUsd) * 100;
  }, [withdrawSwapLoading, withdrawCollateralEstimate, debouncedWithdrawAmount, withdrawTokenPrices, withdrawPriceTokenAddress, withdrawOutputPriceAddress, collateralVaultInfo, withdrawCollateralUnderlying]);

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

        // Collateral change from optional withdrawal
        const dCollateral = withdrawAmountWei > 0n ? -withdrawAmountWei : 0n;

        if (dDebt === 0n && dCollateral === 0n) {
          setEstimatedHealth(null);
          return;
        }

        const health = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "health_calculator",
          args: [address, BigInt(dCollateral), BigInt(dDebt), true, 0n],
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
    withdrawAmountWei,
  ]);

  // Report estimated health to parent
  useEffect(() => {
    onEstimatedHealthChange?.(estimatedHealth);
  }, [estimatedHealth, onEstimatedHealthChange]);

  // Report debt delta to parent (negative = repaying)
  useEffect(() => {
    if (isCrvUsd && repayAmount && Number(repayAmount) > 0) {
      try {
        onDebtDeltaChange?.(-parseUnits(repayAmount, 18));
      } catch {
        onDebtDeltaChange?.(null);
      }
    } else if (!isCrvUsd && estimatedCrvUsdOut) {
      onDebtDeltaChange?.(-estimatedCrvUsdOut);
    } else {
      onDebtDeltaChange?.(null);
    }
  }, [isCrvUsd, repayAmount, estimatedCrvUsdOut, onDebtDeltaChange]);

  // Report collateral delta to parent (negative = withdrawing collateral)
  useEffect(() => {
    onCollateralDeltaChange?.(withdrawAmountWei > 0n ? -withdrawAmountWei : null);
  }, [withdrawAmountWei, onCollateralDeltaChange]);

  // Report tx state to parent for full-screen overlay
  useEffect(() => {
    if ((status === "waitingTx" || status === "success" || status === "reverted") && txHash) {
      const action = isClosingLoan ? "Close Loan" : "Repay";
      const crvUsdAmount = isCrvUsd
        ? Number(repayAmount).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })
        : estimatedCrvUsdOut
          ? Number(formatUnits(estimatedCrvUsdOut, 18)).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })
          : "~";
      // Build a descriptive message for the overlay
      const withdrawSuffix = withdrawAmountWei > 0n
        ? ` + withdrawing ${Number(formatUnits(withdrawAmountWei, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${vault.symbol}`
        : "";
      let message: string | undefined;
      if (isCrvUsd) {
        message = `Repaying ${repayAmount} crvUSD debt${withdrawSuffix}`;
      } else if (isVaultWithCrvUsdUnderlying) {
        message = `Repaying ${crvUsdAmount} crvUSD debt with ${repayAmount} ${repayToken.symbol}${withdrawSuffix}`;
      } else {
        message = `Repaying ${crvUsdAmount} crvUSD debt with ${repayAmount} ${repayToken.symbol}${withdrawSuffix}`;
      }
      const fromNum = Number(repayAmount);
      const fromDp = fromNum > 0 && fromNum < 0.01 ? 6 : fromNum < 1 ? 4 : 2;
      const formattedFrom = fromNum.toLocaleString(undefined, { maximumFractionDigits: fromDp, minimumFractionDigits: 2 });
      const details = repayAmount && Number(repayAmount) > 0 ? {
        fromAmount: formattedFrom,
        fromSymbol: repayToken.symbol,
        fromLogo: repayToken.logoURI || "/tokens/unknown.png",
        toAmount: crvUsdAmount,
        toSymbol: "crvUSD",
        toLogo: "/tokens/crvusd.png",
        message,
      } : undefined;
      const mapped = status === "waitingTx" ? "pending" : status;
      onTxStateChange?.({ status: mapped as "pending" | "success" | "reverted", action, hash: txHash, details });
    }
  }, [status, txHash, isClosingLoan, onTxStateChange, repayAmount, repayToken, isCrvUsd, isVaultWithCrvUsdUnderlying, estimatedCrvUsdOut, withdrawAmountWei, debouncedWithdrawAmount, vault.symbol]);

  // Handle transaction success — clear inputs and reset to idle
  useEffect(() => {
    if (status === "success") {
      setRepayAmountState("");
      setWithdrawAmountState("");
      try { localStorage.removeItem(repayStorageKey); } catch { /* */ }
      onTransactionSuccess();
      refetchBalance();
      reset();
    }
  }, [status, onTransactionSuccess, reset, refetchBalance, repayStorageKey]);

  // Toast error messages to user
  useEffect(() => {
    if ((status === "error" || status === "reverted") && error) {
      if (isUserRejection(error)) {
        toast("Transaction cancelled", { id: "repay-cancelled", duration: 3000 });
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
  }, [repayAmount, withdrawAmount, withdrawToken.address]);

  // Clear amount and reset action state when switching tokens
  useEffect(() => {
    setRepayAmountState("");
    setWithdrawAmountState("");
    setWithdrawToken(defaultWithdrawToken);
    setIsClosingLoan(false);
    hasAutoCapped.current = false;
    setSuppressQuoteDisplay(false);
    reset();
  }, [repayToken.address]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close withdrawal panel when closing loan (full repay returns all collateral automatically)
  useEffect(() => {
    if (isClosingLoan) {
      setWithdrawAmountState("");
      setShowWithdrawInput(false);
    }
  }, [isClosingLoan]);

  // Auto-cap repay amount when swap quote exceeds debt (unless closing loan)
  // Handles the case where MAX is clicked before any exchange rate is known
  // Fires at most once per user action (MAX click / manual input) to prevent oscillation
  useEffect(() => {
    if (hasAutoCapped.current) return;
    if (isClosingLoan || isCrvUsd || quoteLoading) return;
    if (!estimatedCrvUsdOut || !position?.debt || !repayAmount || Number(repayAmount) === 0) return;
    if (estimatedCrvUsdOut <= position.debt * 102n / 100n) return;
    hasAutoCapped.current = true;
    setSuppressQuoteDisplay(true);
    // Scale down proportionally: newAmount = currentAmount * (debt / estimatedOutput)
    const ratio = Number(formatUnits(position.debt, 18)) / Number(formatUnits(estimatedCrvUsdOut, 18));
    const adjusted = Number(repayAmount) * ratio;
    const dp = Math.min(repayToken.decimals, 8);
    setRepayAmountState(adjusted.toFixed(dp));
  }, [estimatedCrvUsdOut, position?.debt, isClosingLoan, isCrvUsd, quoteLoading, repayAmount, repayToken.decimals]);

  // Clear quote suppression once the adjusted amount's quote has arrived
  useEffect(() => {
    if (!suppressQuoteDisplay) return;
    // Wait until debounce catches up to the auto-capped amount AND quote finishes loading
    if (!quoteLoading && hasAutoCapped.current && debouncedAmount === repayAmount) {
      setSuppressQuoteDisplay(false);
    }
  }, [suppressQuoteDisplay, quoteLoading, debouncedAmount, repayAmount]);

  // Clear withdrawal amount when withdrawal token changes (denomination changes)
  useEffect(() => {
    setWithdrawAmountState("");
  }, [withdrawToken.address]);

  // Reset action state when withdrawal amount or token changes
  useEffect(() => {
    if (status !== "idle") {
      reset();
    }
  }, [debouncedWithdrawAmount, withdrawToken.address]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async () => {
    if (!address || !controllerAddress || !repayAmount || !position?.hasLoan)
      return;

    const hasWithdrawal = withdrawAmountWei > 0n;

    try {
      if (isCrvUsd && !hasWithdrawal) {
        // Path A: direct controller.repay() — no withdrawal, no bundle needed
        const repayWei = parseUnits(repayAmount, 18);
        if (showSimulationPreview) {
          const result = await repayDirect(controllerAddress, repayWei, { previewOnly: true, closeLoan: isClosingLoan });
          if (result) {
            simulationBlock.current = currentBlock ?? 0n;
            setShowSimulationModal(true);
            return;
          }
        }
        await repayDirect(controllerAddress, repayWei, { closeLoan: isClosingLoan });
      } else if (isCrvUsd && hasWithdrawal) {
        // Path B: crvUSD repay + collateral withdrawal — Enso bundle
        const repayWei = parseUnits(repayAmount, 18);
        const withdrawOpts = {
          closeLoan: isClosingLoan,
          ...(isWithdrawSwap ? { withdrawTokenOut: withdrawToken.address, withdrawTokenSymbol: withdrawToken.symbol } : {}),
        };
        if (showSimulationPreview) {
          const result = await repayAndWithdraw(controllerAddress, repayWei, withdrawAmountWei, vault.address as `0x${string}`, { previewOnly: true, ...withdrawOpts });
          if (result) {
            simulationBlock.current = currentBlock ?? 0n;
            setShowSimulationModal(true);
            return;
          }
        }
        await repayAndWithdraw(controllerAddress, repayWei, withdrawAmountWei, vault.address as `0x${string}`, withdrawOpts);
      } else {
        // Path C: Enso bundle — handles vault tokens (redeem + repay) and regular tokens (swap + repay)
        // Optionally includes withdrawal via withdrawAmount param
        const swapOptions: { previewOnly?: boolean; tokenSymbol?: string; inSoftLiquidation?: boolean; withdrawAmount?: string; withdrawTokenOut?: string; withdrawTokenSymbol?: string } = {
          tokenSymbol: repayToken.symbol,
          inSoftLiquidation: position?.inSoftLiquidation,
          ...(hasWithdrawal ? { withdrawAmount: withdrawAmountWei.toString() } : {}),
          ...(hasWithdrawal && isWithdrawSwap ? { withdrawTokenOut: withdrawToken.address, withdrawTokenSymbol: withdrawToken.symbol } : {}),
        };
        if (showSimulationPreview) {
          const result = await repayWithSwap(
            vault.address as `0x${string}`,
            repayToken.address,
            repayAmount,
            repayToken.decimals,
            Number(slippage),
            { ...swapOptions, previewOnly: true }
          );
          if (result) {
            simulationBlock.current = currentBlock ?? 0n;
            setShowSimulationModal(true);
            return;
          }
        }
        await repayWithSwap(
          vault.address as `0x${string}`,
          repayToken.address,
          repayAmount,
          repayToken.decimals,
          Number(slippage),
          swapOptions
        );
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
    status !== "reverted" &&
    status !== "needsApproval";

  // Withdrawal reverse quote is loading (collateral amount not yet known)
  const withdrawRateLoading = isWithdrawSwap &&
    !!debouncedWithdrawAmount &&
    Number(debouncedWithdrawAmount) > 0 &&
    !withdrawReverseQuote;

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
    if (status === "building") return <>Building transaction<LoadingDots /></>;
    if (status === "simulating") return <>Simulating<LoadingDots /></>;
    if (status === "executing") return <>Confirm in wallet<LoadingDots /></>;
    if (status === "waitingTx") return <>Waiting for confirmation<LoadingDots /></>;
    if (hasInsufficientBalance) return "Insufficient balance";

    const hasWithdrawal = withdrawAmountWei > 0n;

    if (isCrvUsd) {
      if (isClosingLoan) return "Close Loan";
      return hasWithdrawal ? "Repay & Withdraw" : "Repay Debt";
    }
    if (isVaultWithCrvUsdUnderlying) {
      if (isClosingLoan) return "Redeem & Close Loan";
      return hasWithdrawal ? "Redeem, Repay & Withdraw" : "Redeem & Repay";
    }
    if (isClosingLoan) return "Swap & Close Loan";
    return hasWithdrawal ? "Swap, Repay & Withdraw" : "Swap & Repay";
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
      {position?.inSoftLiquidation && onSwitchTab && (
        <div className={cn(
          "p-3 rounded-lg text-sm flex items-center gap-2",
          position.health <= 0
            ? "bg-red-500/10 border border-red-500/30 text-red-500"
            : "bg-yellow-500/10 border border-yellow-500/30 text-yellow-500"
        )}>
          <AlertTriangle size={16} className="shrink-0" />
          <div>
            <div className="font-medium">
              {position.health <= 0 ? "Position Underwater" : "Soft Liquidation"}
            </div>
            <div className="text-xs mt-0.5">
              Reduce debt from your wallet — your collateral stays deposited and the position remains open. Use <button type="button" onClick={() => onSwitchTab("leverage")} className={cn("underline transition-colors", position.health <= 0 ? "hover:text-red-300" : "hover:text-yellow-300")}>Liquidate</button> to withdraw collateral and close instead.
            </div>
          </div>
        </div>
      )}

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
        <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
          <input
            type="text"
            value={repayAmount}
            onChange={(e) => setRepayAmount(e.target.value)}
            placeholder="0.0"
            className="flex-1 min-w-0 bg-transparent mono text-sm outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
          />
          <TokenSelector
            selectedToken={repayToken}
            onSelect={setRepayToken}
            priorityTokens={[CRVUSD_TOKEN, SCRVUSD_TOKEN]}
            excludeDefiTokens
          />
          {isCrvUsd ? (
            <MaxButton
              balance={maxRepayBalance}
              onSelect={setRepayAmount}
              showClose={!!position?.hasLoan}
              onClose={() => {
                setRepayAmountState(formatUnits(position!.debt, 18));
                setIsClosingLoan(true);
              }}
            />
          ) : maxRepayTokenEquivalent ? (
            <MaxButton
              balance={maxRepayBalance}
              onSelect={setRepayAmount}
              showClose={!!position?.hasLoan}
              onClose={() => {
                setRepayAmountState(balanceFormatted);
                setIsClosingLoan(true);
              }}
            />
          ) : (
            <span className="shrink-0 px-2 py-1 text-xs font-medium text-[var(--muted-foreground)] animate-pulse">
              MAX
            </span>
          )}
        </div>
      </div>

      {/* Quote details (non-crvUSD, when amount entered and quote loaded) */}
      {!isCrvUsd && !suppressQuoteDisplay && repayAmount && Number(repayAmount) > 0 && (
        (isVaultWithCrvUsdUnderlying ? estimatedCrvUsdOut !== null && !quoteLoading : swapQuote && !quoteLoading) && (
          <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-2 text-sm">
            {/* Exchange rate */}
            {exchangeRate !== null && (
              <div className="flex justify-between items-center">
                <span className="text-[var(--muted-foreground)]">Rate</span>
                <button
                  type="button"
                  onClick={() => setRateInverted(v => !v)}
                  className="flex items-center gap-1 mono hover:text-[var(--accent)] transition-colors"
                >
                  {rateInverted
                    ? <>1 crvUSD = {(1 / exchangeRate).toLocaleString(undefined, { maximumFractionDigits: 4 })} {repayToken.symbol}</>
                    : <>1 {repayToken.symbol} = {exchangeRate.toLocaleString(undefined, { maximumFractionDigits: 4 })} crvUSD</>
                  }
                  <ArrowRightLeft size={12} className="text-[var(--muted-foreground)]" />
                </button>
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
                  {isClosingLoan
                    ? `${Number(formatUnits(position.debt, 18)).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} / ${Number(formatUnits(position.debt, 18)).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} crvUSD`
                    : `~${Number(formatUnits(estimatedCrvUsdOut, 18)).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} / ${Number(formatUnits(position.debt, 18)).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} crvUSD`
                  }
                </span>
              </div>
            )}
          </div>
        )
      )}

      {/* Withdraw Collateral toggle + panel — hidden during soft-liq and closing loan */}
      {!position?.inSoftLiquidation && !isClosingLoan && (
        <div>
          <button
            type="button"
            onClick={() => {
              if (showWithdrawInput) {
                setWithdrawAmountState("");
                setWithdrawToken(defaultWithdrawToken);
              }
              setShowWithdrawInput(v => !v);
            }}
            className="flex items-center gap-1 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            {showWithdrawInput ? <X size={12} /> : <Plus size={12} />}
            {showWithdrawInput ? "Cancel" : "Withdraw collateral"}
          </button>
          <div
            className="grid transition-[grid-template-rows] duration-300 ease-in-out"
            style={{ gridTemplateRows: showWithdrawInput ? "1fr" : "0fr" }}
          >
            <div className="overflow-hidden">
              <div className="pt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm text-[var(--muted-foreground)]">
                    Withdraw Collateral
                  </label>
                  <span className="text-xs text-[var(--muted-foreground)]">
                    Deposited: {formattedCollateral}
                  </span>
                </div>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-inset focus-within:ring-[var(--accent)] transition-shadow">
                  <input
                    type="text"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                    placeholder="0.0"
                    className="flex-1 min-w-0 bg-transparent mono text-sm outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
                  />
                  <TokenSelector
                    selectedToken={withdrawToken}
                    onSelect={setWithdrawToken}
                    priorityTokens={[defaultWithdrawToken, CRVUSD_TOKEN]}
                  />
                  {isWithdrawSwap ? (
                    maxWithdrawInTokenUnits ? (
                      <MaxButton
                        balance={maxWithdrawInTokenUnits}
                        onSelect={setWithdrawAmount}
                      />
                    ) : (
                      <span className="shrink-0 px-2 py-1 text-xs font-medium text-[var(--muted-foreground)] animate-pulse">
                        MAX
                      </span>
                    )
                  ) : (
                    <MaxButton
                      balance={maxWithdrawable ?? "0"}
                      onSelect={setWithdrawAmount}
                    />
                  )}
                </div>

                {/* Withdrawal swap quote details */}
                {isWithdrawSwap && debouncedWithdrawAmount && Number(debouncedWithdrawAmount) > 0 && !withdrawSwapLoading && withdrawReverseQuote && withdrawSwapRate !== null && (
                  <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-2 text-sm">
                    <div className="flex justify-between items-center">
                      <span className="text-[var(--muted-foreground)]">Rate</span>
                      <span className="mono">
                        1 {vault.symbol} = {withdrawSwapRate.toLocaleString(undefined, { maximumFractionDigits: 4 })} {withdrawToken.symbol}
                      </span>
                    </div>
                    {withdrawPriceImpact !== null && (
                      <div className="flex justify-between">
                        <span className="text-[var(--muted-foreground)]">Price Impact</span>
                        <span className={cn(
                          "mono",
                          withdrawPriceImpact <= 0
                            ? "text-green-500"
                            : withdrawPriceImpact < 3
                              ? "text-yellow-500"
                              : "text-red-500"
                        )}>
                          {withdrawPriceImpact > 0 ? "" : "+"}{(-withdrawPriceImpact).toFixed(2)}%
                        </span>
                      </div>
                    )}
                    {withdrawCollateralEstimate !== null && (
                      <div className="flex justify-between">
                        <span className="text-[var(--muted-foreground)]">Withdrawing</span>
                        <span className="mono">
                          ~{withdrawCollateralEstimate.toLocaleString(undefined, { maximumFractionDigits: 4 })} {vault.symbol}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Approval Flow */}
      <ApprovalCard
        show={showApprovalCard}
        pendingApproval={lastApprovalRef.current}
        approvalProgress={approvalProgress}
        isApproving={isApproving}
        onApprove={(exact) => approve(exact)}
      />

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

      {/* Close loan warning */}
      {isClosingLoan && (
        <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500 text-xs flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0" />
          Repays all debt and closes loan, collateral returned to wallet
        </div>
      )}

      {/* Underwater warning before action */}
      {position?.health !== undefined && position.health <= 0 && (
        <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-500 text-xs flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0" />
          <span>Debt exceeds collateral value. Repaying may not be worthwhile.</span>
        </div>
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
                // Re-open cached simulation modal if same block
                setShowSimulationModal(true);
              } else if (!quoteLoading && !suppressQuoteDisplay && !withdrawSwapLoading && !withdrawRateLoading) {
                handleSubmit();
              }
            }}
            disabled={showApprovalCard || isProcessing || quoteLoading || suppressQuoteDisplay || withdrawSwapLoading || withdrawRateLoading || (!isFormValid && status === "idle")}
            className={cn(
              "w-full py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
              isProcessing || quoteLoading || suppressQuoteDisplay || withdrawSwapLoading || withdrawRateLoading || (!isFormValid && status === "idle")
                ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
            )}
          >
            {((!isCrvUsd && (quoteLoading || suppressQuoteDisplay)) || withdrawSwapLoading || withdrawRateLoading) && status === "idle" ? (
              <>Getting quote<LoadingDots /></>
            ) : (
              getButtonText()
            )}
          </button>
        </div>
      </div>

      {/* Settings icon for direct crvUSD / vault-crvUSD paths */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: (isCrvUsd || isVaultWithCrvUsdUnderlying) ? "1fr" : "0fr" }}
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

      {/* Enso Attribution + Route Toggle + Slippage Settings */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: (!isCrvUsd && !isVaultWithCrvUsdUnderlying) ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
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

        </div>
      </div>

      {/* Route details panel */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{
          gridTemplateRows:
            showRoute && repayAmount && Number(repayAmount) > 0 && (swapQuote || (isVaultWithCrvUsdUnderlying && estimatedCrvUsdOut) || quoteLoading) ? "1fr" : "0fr",
        }}
      >
        <div className="overflow-hidden">
          <div className="pt-3 mt-3 border-t border-[var(--border)]">
                <div className="text-xs text-[var(--muted-foreground)] mb-2">
                  Route
                </div>
                <RouteDisplay
                  routeInfo={
                    (swapQuote || (isVaultWithCrvUsdUnderlying && estimatedCrvUsdOut))
                      ? {
                          steps: [
                            // For vault-with-crvUSD-underlying: Redeem → Repay
                            // For vault tokens with non-crvUSD underlying: Redeem → Swap → Repay
                            // For regular tokens: Swap → Repay
                            ...(isVaultWithCrvUsdUnderlying
                              ? [
                                  {
                                    tokenSymbol: repayToken.symbol,
                                    action: "Redeem",
                                    description: "for crvUSD",
                                    protocol: "Curve Savings",
                                  },
                                ]
                              : vaultInfo
                                ? [
                                    {
                                      tokenSymbol: repayToken.symbol,
                                      action: "Redeem",
                                      description: `for ${vaultInfo.underlyingSymbol}`,
                                      protocol: "yld",
                                    },
                                    {
                                      tokenSymbol: vaultInfo.underlyingSymbol,
                                      amount: redeemIntermediateAmount ?? undefined,
                                      action: "Swap",
                                      description: "for crvUSD",
                                      protocol: "Enso Router",
                                    },
                                  ]
                                : [
                                    {
                                      tokenSymbol: repayToken.symbol,
                                      action: "Swap",
                                      description: "for crvUSD",
                                      protocol: "Enso Router",
                                    },
                                  ]),
                            {
                              tokenSymbol: "crvUSD",
                              amount: estimatedCrvUsdOut
                                ? Number(formatUnits(estimatedCrvUsdOut, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })
                                : undefined,
                              action: "Repay",
                              protocol: "Curve LlamaLend",
                            },
                            ...(withdrawAmountWei > 0n ? [
                              {
                                tokenSymbol: vault.symbol,
                                amount: Number(formatUnits(withdrawAmountWei, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }),
                                action: "Withdraw",
                                description: isWithdrawSwap ? "collateral from position" : "collateral to wallet",
                                protocol: "Curve LlamaLend",
                              },
                              ...(isWithdrawSwap ? [{
                                tokenSymbol: withdrawToken.symbol,
                                amount: debouncedWithdrawAmount
                                  ? `~${Number(debouncedWithdrawAmount).toLocaleString(undefined, { maximumFractionDigits: 4 })}`
                                  : undefined,
                                action: "Receive",
                                description: `from ${vault.symbol} swap`,
                                protocol: "Enso",
                              }] : []),
                            ] : []),
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
                    withdrawAmountWei > 0n
                      ? undefined
                      : estimatedCrvUsdOut
                        ? Number(formatUnits(estimatedCrvUsdOut, 18)).toFixed(4)
                        : undefined
                  }
                  isLoading={quoteLoading}
                  closingLoan={isClosingLoan && position?.hasLoan ? {
                    collateralReturned: Number(formatUnits(position.collateral, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }),
                    collateralSymbol: vault.symbol,
                  } : undefined}
                />
          </div>
        </div>
      </div>

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
