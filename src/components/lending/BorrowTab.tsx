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
  ArrowRightLeft,
  Route,
  RouteOff,
  ExternalLink,
} from "lucide-react";
import { useAccount, usePublicClient, useGasPrice, useBlockNumber } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { useQuery } from "@tanstack/react-query";
import type { VaultConfig } from "@/config/vaults";
import type { LendingPosition } from "@/hooks/useCurveLendingPosition";
import { useCurveLendingActions } from "@/hooks/useCurveLendingActions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { TokenSelector } from "@/components/TokenSelector";
import { RouteDisplay } from "@/components/RouteDisplay";
import { MaxButton } from "@/components/MaxButton";
import { cn } from "@/lib/utils";
import { sanitizeAmount } from "@/lib/sanitize";
import { fetchRoute, fetchTokenPrices } from "@/lib/enso";
import { CRVUSD_ADDRESS } from "@/lib/zapper";
import { CURVE_SAVINGS, TOKENS, TANGENT } from "@/config/vaults";
import { getVaultInfo } from "@/lib/curve-lending";
import type { EnsoToken, EnsoRouteResponse } from "@/types/enso";

// Curve pool get_dy ABI (int128 for old-style pools like CVX1/cvgCVX)
const CURVE_GET_DY_ABI = [
  {
    name: "get_dy",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "dx", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ERC4626 previewRedeem ABI
const ERC4626_PREVIEW_ABI = [
  {
    name: "previewRedeem",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
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
      { name: "current_debt", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
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

// scrvUSD (Savings crvUSD)
const SCRVUSD_TOKEN: EnsoToken = {
  address: CURVE_SAVINGS.SCRVUSD,
  chainId: 1,
  name: "Savings crvUSD",
  symbol: "scrvUSD",
  decimals: 18,
  logoURI: "/tokens/scrvusd.png",
  type: "defi",
};

function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="animate-bounce" style={{ animationDelay: "0ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "150ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "300ms", animationDuration: "600ms" }}>.</span>
    </span>
  );
}

interface BorrowTabProps {
  vault: VaultConfig;
  position: LendingPosition | null;
  controllerAddress: `0x${string}`;
  onTransactionSuccess: () => void;
  onEstimatedHealthChange?: (health: number | null) => void;
  onDebtDeltaChange?: (delta: bigint | null) => void;
  onTxStateChange?: (state: { status: "pending" | "success" | "reverted"; action: string; hash: string; details?: { fromAmount: string; fromSymbol: string; fromLogo: string; toAmount: string; toSymbol: string; toLogo: string } } | null) => void;
  onSwitchTab?: (tab: string) => void;
}

export function BorrowTab({
  vault,
  position,
  controllerAddress,
  onTransactionSuccess,
  onEstimatedHealthChange,
  onDebtDeltaChange,
  onTxStateChange,
  onSwitchTab,
}: BorrowTabProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  // Max additional crvUSD the user can borrow (max_borrowable - current debt)
  // null = not yet calculated, 0n = truly zero capacity
  const [maxBorrowable, setMaxBorrowable] = useState<bigint | null>(null);

  useEffect(() => {
    async function calculateMaxBorrowable() {
      if (!publicClient || !controllerAddress || !position?.hasLoan) {
        setMaxBorrowable(null);
        return;
      }

      try {
        const N = BigInt(position.N);
        const maxTotal = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "max_borrowable",
          args: [position.collateral, N, position.debt],
        });
        const additional = maxTotal > position.debt ? maxTotal - position.debt : 0n;
        setMaxBorrowable(additional);
      } catch {
        setMaxBorrowable(null);
      }
    }

    calculateMaxBorrowable();
  }, [publicClient, controllerAddress, position]);

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

  const isLiquidityConstrained = useMemo(() => {
    if (!controllerCrvUsdBalance || !maxBorrowable || maxBorrowable === 0n) return false;
    // If max borrowable is within 5% of controller balance, liquidity is the bottleneck
    const threshold = controllerCrvUsdBalance * 105n / 100n;
    return maxBorrowable <= threshold;
  }, [controllerCrvUsdBalance, maxBorrowable]);

  // Token selection (default: crvUSD)
  const [borrowToken, setBorrowToken] = useState<EnsoToken>(CRVUSD_TOKEN);
  const isCrvUsd =
    borrowToken.address.toLowerCase() === CRVUSD_ADDRESS.toLowerCase();

  // Form state — amount is in the selected token's denomination
  // crvUSD: amount of crvUSD debt to create
  // Other tokens: desired amount of token to receive (reverse quote calculates crvUSD debt)
  const [borrowAmount, setBorrowAmountState] = useState("");
  const setBorrowAmount = useCallback(
    (v: string) => setBorrowAmountState(sanitizeAmount(v)),
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

  // Rate inversion toggle
  const [rateInverted, setRateInverted] = useState(false);

  // Health estimation
  const [estimatedHealth, setEstimatedHealth] = useState<number | null>(null);
  const [debtTooHigh, setDebtTooHigh] = useState(false);

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
    borrowMore,
    borrowAndSwap,
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

  // Track which approval button was clicked (spinner only on that button)
  const [approvingType, setApprovingType] = useState<"exact" | "unlimited" | "single" | null>(null);
  useEffect(() => {
    if (!isApproving) setApprovingType(null);
  }, [isApproving]);

  // Simulation toggle from settings
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

  // Clear simulation/approval state when inputs change
  useEffect(() => {
    if (simulationResult || status === "needsApproval") {
      reset();
      setShowSimulationModal(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [borrowAmount, borrowToken.address]);

  // Toast notifications
  useEffect(() => {
    if (status === "success" && txHash) {
      toast.success("Borrow successful!", {
        action: {
          label: "View Tx",
          onClick: () => window.open(`https://etherscan.io/tx/${txHash}`, "_blank"),
        },
      });
      onTransactionSuccess();
    }
  }, [status, txHash, onTransactionSuccess]);

  useEffect(() => {
    if ((status === "error" || status === "reverted") && error) {
      if (isUserRejection(error)) {
        // Wallet rejection: show toast, clear error but keep simulation cached
        toast("Transaction cancelled", { id: "borrow-cancelled", duration: 3000 });
        clearError();
      } else {
        toast.error(error);
        reset();
      }
    }
  }, [status, error, reset, clearError]);

  // Debounced amount for quote fetching
  const debouncedAmount = useDebouncedValue(borrowAmount, 500);

  // Check if selected token is a vault token
  const vaultInfo = useMemo(
    () => (isCrvUsd ? null : getVaultInfo(borrowToken.address)),
    [borrowToken.address, isCrvUsd]
  );

  // Special case: vault with crvUSD underlying (e.g., scrvUSD) — deposit only, no swap
  const isVaultWithCrvUsdUnderlying = !!(
    vaultInfo && vaultInfo.underlying.toLowerCase() === CRVUSD_ADDRESS.toLowerCase()
  );

  // Special case: vault with cvgCVX underlying (no DEX liquidity, needs Tangent routing through CVX)
  const isCvgCvxVault = !!(
    vaultInfo && vaultInfo.underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase()
  );

  // For non-crvUSD tokens: compute max receivable by quoting maxBorrowable crvUSD → token
  // This lets MaxButton work for any selected token
  const maxBorrowableStr = useMemo(
    () => (maxBorrowable !== null && maxBorrowable > 0n ? maxBorrowable.toString() : null),
    [maxBorrowable]
  );

  const { data: maxTokenEquivalent, isLoading: maxTokenLoading } = useQuery({
    queryKey: [
      "borrow-max-token",
      borrowToken.address,
      maxBorrowableStr,
      address,
    ],
    queryFn: async () => {
      if (!address || !maxBorrowableStr) throw new Error("Missing params");

      if (isVaultWithCrvUsdUnderlying) {
        // scrvUSD: estimate deposit shares for max crvUSD via previewRedeem ratio
        // previewRedeem(1e18 shares) gives us the crvUSD-per-share ratio
        const oneShare = 10n ** 18n;
        const crvUsdPerShare = await publicClient!.readContract({
          address: vaultInfo!.address as `0x${string}`,
          abi: ERC4626_PREVIEW_ABI,
          functionName: "previewRedeem",
          args: [oneShare],
        });
        // maxShares = maxBorrowable / (crvUsdPerShare / 1e18)
        const maxShares = (maxBorrowable! * 10n ** 18n) / BigInt(crvUsdPerShare);
        // Apply 0.1% haircut — two-step integer division (get ratio → divide → previewRedeem)
        // can round up past maxBorrowable, causing "Exceeds max" on the reverse check
        const haircut = maxShares * 999n / 1000n;
        return formatUnits(haircut, borrowToken.decimals);
      }

      if (isCvgCvxVault) {
        // cvgCVX vault: route crvUSD → CVX (Enso), then CVX → cvgCVX (Curve pool)
        const cvxQuote = await fetchRoute({
          fromAddress: address,
          tokenIn: CRVUSD_ADDRESS,
          tokenOut: TOKENS.CVX,
          amountIn: maxBorrowableStr,
          slippage: "300",
        });
        if (!cvxQuote?.amountOut) return null;
        const cvgCvxAmount = await publicClient!.readContract({
          address: TANGENT.CVX1_CVGCVX_POOL as `0x${string}`,
          abi: CURVE_GET_DY_ABI,
          functionName: "get_dy",
          args: [0n, 1n, BigInt(cvxQuote.amountOut)],
        });
        if (!cvgCvxAmount || cvgCvxAmount === 0n) return null;
        // Estimate vault shares from cvgCVX amount
        const oneShareBn = 10n ** 18n;
        const cvgCvxPerShare = await publicClient!.readContract({
          address: vaultInfo!.address as `0x${string}`,
          abi: ERC4626_PREVIEW_ABI,
          functionName: "previewRedeem",
          args: [oneShareBn],
        });
        const maxShares = (cvgCvxAmount * 10n ** 18n) / cvgCvxPerShare;
        // Apply haircut for quote spread
        const haircut = maxShares * 199n / 200n;
        return formatUnits(haircut, borrowToken.decimals);
      }

      // Regular token or vault with non-crvUSD underlying: forward quote crvUSD → token
      const quote = await fetchRoute({
        fromAddress: address,
        tokenIn: CRVUSD_ADDRESS,
        tokenOut: vaultInfo ? vaultInfo.underlying : borrowToken.address,
        amountIn: maxBorrowableStr,
        slippage: "300", // Use wider slippage for max estimate
      });

      if (!quote?.amountOut) return null;

      if (vaultInfo) {
        // Vault token: convert underlying amount → vault shares, then apply haircut
        const underlyingAmount = BigInt(quote.amountOut);
        const oneShare = 10n ** 18n;
        const underlyingPerShare = await publicClient!.readContract({
          address: vaultInfo.address as `0x${string}`,
          abi: ERC4626_PREVIEW_ABI,
          functionName: "previewRedeem",
          args: [oneShare],
        });
        const maxShares = (underlyingAmount * oneShare) / underlyingPerShare;
        // Apply 1% haircut for forward/reverse AMM spread
        const haircut = maxShares * 99n / 100n;
        return formatUnits(haircut, borrowToken.decimals);
      }

      // Regular (non-vault) token: apply 1% haircut directly
      const haircut = BigInt(quote.amountOut) * 99n / 100n;
      return formatUnits(haircut, borrowToken.decimals);
    },
    enabled:
      !isCrvUsd &&
      !!address &&
      maxBorrowable !== null && maxBorrowable > 0n,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });

  // For vault tokens with crvUSD underlying (e.g., scrvUSD):
  // Use previewRedeem to estimate how much crvUSD is needed per scrvUSD
  // (previewRedeem gives the same ratio as previewMint for estimation)
  const {
    data: redeemPreview,
    isLoading: redeemPreviewLoading,
  } = useQuery({
    queryKey: ["borrow-deposit-preview", borrowToken.address, debouncedAmount],
    queryFn: async () => {
      const amountWei = parseUnits(debouncedAmount, borrowToken.decimals);
      const result = await publicClient!.readContract({
        address: vaultInfo!.address as `0x${string}`,
        abi: ERC4626_PREVIEW_ABI,
        functionName: "previewRedeem",
        args: [amountWei],
      });
      return result.toString();
    },
    enabled:
      isVaultWithCrvUsdUnderlying &&
      !!debouncedAmount &&
      Number(debouncedAmount) > 0,
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1,
  });


  // Intermediate amounts for cvgCVX route display (set during swap quote)
  const [cvgCvxRouteAmounts, setCvgCvxRouteAmounts] = useState<{
    cvgCvx: string;
    cvx: string;
  } | null>(null);

  // Reverse quote for non-crvUSD tokens: selectedToken → crvUSD
  // User enters desired token amount; quote tells us how much crvUSD debt is needed
  const {
    data: swapQuote,
    isLoading: swapQuoteLoading,
  } = useQuery({
    queryKey: [
      "borrow-swap-quote",
      borrowToken.address,
      debouncedAmount,
      slippage,
      address,
    ],
    queryFn: async (): Promise<EnsoRouteResponse> => {
      if (!address) throw new Error("No address");
      const amountWei = parseUnits(debouncedAmount, borrowToken.decimals).toString();

      if (isCvgCvxVault) {
        // cvgCVX vault: vault shares → cvgCVX (previewRedeem) → CVX (Curve pool) → crvUSD (Enso)
        const cvgCvxAmount = (await publicClient!.readContract({
          address: vaultInfo!.address as `0x${string}`,
          abi: ERC4626_PREVIEW_ABI,
          functionName: "previewRedeem",
          args: [BigInt(amountWei)],
        })).toString();
        const cvxAmount = await publicClient!.readContract({
          address: TANGENT.CVX1_CVGCVX_POOL as `0x${string}`,
          abi: CURVE_GET_DY_ABI,
          functionName: "get_dy",
          args: [1n, 0n, BigInt(cvgCvxAmount)],
        });
        if (!cvxAmount || cvxAmount === 0n) throw new Error("cvgCVX → CVX swap rate unavailable");
        // Store intermediates for route display
        setCvgCvxRouteAmounts({
          cvgCvx: Number(formatUnits(BigInt(cvgCvxAmount), 18)).toFixed(2),
          cvx: Number(formatUnits(cvxAmount, 18)).toFixed(2),
        });
        return fetchRoute({
          fromAddress: address,
          tokenIn: TOKENS.CVX,
          tokenOut: CRVUSD_ADDRESS,
          amountIn: cvxAmount.toString(),
          slippage,
        });
      }

      setCvgCvxRouteAmounts(null);

      if (vaultInfo) {
        // Vault token: quote underlying → crvUSD (we'll redeem vault shares to underlying first)
        const underlyingAmount = await publicClient!.readContract({
          address: vaultInfo.address as `0x${string}`,
          abi: ERC4626_PREVIEW_ABI,
          functionName: "previewRedeem",
          args: [BigInt(amountWei)],
        });
        return fetchRoute({
          fromAddress: address,
          tokenIn: vaultInfo.underlying,
          tokenOut: CRVUSD_ADDRESS,
          amountIn: underlyingAmount.toString(),
          slippage,
        });
      }

      // Regular token: quote selectedToken → crvUSD
      return fetchRoute({
        fromAddress: address,
        tokenIn: borrowToken.address,
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

  // Estimated crvUSD debt amount (wei) based on the selected token
  const estimatedCrvUsdBorrow = useMemo(() => {
    if (isCrvUsd) {
      if (!borrowAmount || Number(borrowAmount) <= 0) return null;
      try {
        return parseUnits(borrowAmount, 18);
      } catch {
        return null;
      }
    }
    if (isVaultWithCrvUsdUnderlying && redeemPreview) {
      return BigInt(redeemPreview);
    }
    if (swapQuote?.amountOut) {
      return BigInt(swapQuote.amountOut);
    }
    return null;
  }, [isCrvUsd, borrowAmount, isVaultWithCrvUsdUnderlying, redeemPreview, swapQuote]);

  const quoteLoading = isVaultWithCrvUsdUnderlying
    ? redeemPreviewLoading
    : (!isCrvUsd && swapQuoteLoading);

  // Exchange rate: 1 selectedToken = X crvUSD
  const exchangeRate = useMemo(() => {
    if (!estimatedCrvUsdBorrow || !debouncedAmount || Number(debouncedAmount) === 0)
      return null;
    const crvUsdFormatted = Number(formatUnits(estimatedCrvUsdBorrow, 18));
    return crvUsdFormatted / Number(debouncedAmount);
  }, [estimatedCrvUsdBorrow, debouncedAmount]);

  // Price impact: compare input USD value (crvUSD debt) vs output USD value (tokens received)
  // Same pattern as useZapQuote: ((inputUsd - outputUsd) / inputUsd) × 100
  // Positive = loss (bad), Negative = gain (good)
  // For cvgCVX vaults: use CVX price (the actual DEX swap is crvUSD↔CVX; CVX→cvgCVX is Curve pool)
  // For other tokens: use the token's own price
  const priceCompareToken = isCvgCvxVault ? TOKENS.CVX : borrowToken.address;
  const { data: tokenPrices } = useQuery({
    queryKey: ["borrow-token-prices", priceCompareToken],
    queryFn: () => fetchTokenPrices([CRVUSD_ADDRESS, priceCompareToken]),
    enabled: !isCrvUsd && !isVaultWithCrvUsdUnderlying,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const priceImpact = useMemo(() => {
    // Use debouncedAmount (not borrowAmount) so the token amount and crvUSD quote are in sync.
    // Also hide while quote is loading — between debounce firing and new quote arriving,
    // debouncedAmount is new but estimatedCrvUsdBorrow is stale.
    if (quoteLoading) return null;
    if (!estimatedCrvUsdBorrow || !debouncedAmount || Number(debouncedAmount) <= 0) return null;
    if (!tokenPrices || tokenPrices.length < 2) return null;
    const crvUsdPrice = tokenPrices.find(
      (p) => p.address.toLowerCase() === CRVUSD_ADDRESS.toLowerCase()
    )?.price;
    const comparePrice = tokenPrices.find(
      (p) => p.address.toLowerCase() === priceCompareToken.toLowerCase()
    )?.price;
    if (!crvUsdPrice || !comparePrice) return null;
    // Input: crvUSD debt being created (what user pays)
    const inputUsd = Number(formatUnits(estimatedCrvUsdBorrow, 18)) * crvUsdPrice;
    // Output: for cvgCVX vaults use CVX intermediate amount; for others use token amount
    const outputAmount = isCvgCvxVault && cvgCvxRouteAmounts
      ? Number(cvgCvxRouteAmounts.cvx)
      : Number(debouncedAmount);
    const outputUsd = outputAmount * comparePrice;
    if (inputUsd === 0) return null;
    return ((inputUsd - outputUsd) / inputUsd) * 100;
  }, [quoteLoading, estimatedCrvUsdBorrow, debouncedAmount, tokenPrices, priceCompareToken, isCvgCvxVault, cvgCvxRouteAmounts]);

  // Calculate estimated health using the crvUSD debt amount
  useEffect(() => {
    async function calculateHealth() {
      if (!publicClient || !controllerAddress || !address || !position?.hasLoan) {
        setEstimatedHealth(null);
        return;
      }

      if (!estimatedCrvUsdBorrow) {
        setEstimatedHealth(null);
        setDebtTooHigh(false);
        return;
      }

      try {
        const health = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "health_calculator",
          args: [address, 0n, estimatedCrvUsdBorrow, true, 0n],
        });

        setEstimatedHealth(Number(health) / 1e16);
        setDebtTooHigh(false);
      } catch {
        // health_calculator reverts when debt is too high ("Debt too high")
        // Show health bar at 0 (red) instead of null (which falls back to current health ∞)
        setEstimatedHealth(0);
        setDebtTooHigh(true);
      }
    }

    const timer = setTimeout(calculateHealth, 300);
    return () => clearTimeout(timer);
  }, [publicClient, controllerAddress, address, position, estimatedCrvUsdBorrow]);

  // Report estimated health to parent
  useEffect(() => {
    onEstimatedHealthChange?.(estimatedHealth);
  }, [estimatedHealth, onEstimatedHealthChange]);

  // Report debt delta to parent (positive = borrowing more)
  useEffect(() => {
    onDebtDeltaChange?.(estimatedCrvUsdBorrow ?? null);
  }, [estimatedCrvUsdBorrow, onDebtDeltaChange]);

  // Report tx state to parent for full-screen overlay
  useEffect(() => {
    if ((status === "waitingTx" || status === "success" || status === "reverted") && txHash) {
      let details: { fromAmount: string; fromSymbol: string; fromLogo: string; toAmount: string; toSymbol: string; toLogo: string } | undefined;
      if (isCrvUsd && estimatedCrvUsdBorrow) {
        // Direct crvUSD borrow: show crvUSD amount only (no arrow needed, but using same shape)
        const amt = Number(formatUnits(estimatedCrvUsdBorrow, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
        details = {
          fromAmount: amt, fromSymbol: "crvUSD", fromLogo: "/tokens/crvusd.png",
          toAmount: amt, toSymbol: "crvUSD", toLogo: "/tokens/crvusd.png",
        };
      } else if (!isCrvUsd && estimatedCrvUsdBorrow && borrowAmount) {
        // Borrow + swap: show crvUSD debt → output token received
        details = {
          fromAmount: Number(formatUnits(estimatedCrvUsdBorrow, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }),
          fromSymbol: "crvUSD",
          fromLogo: "/tokens/crvusd.png",
          toAmount: borrowAmount,
          toSymbol: borrowToken.symbol,
          toLogo: borrowToken.logoURI || "/tokens/unknown.png",
        };
      }
      const mapped = status === "waitingTx" ? "pending" : status;
      onTxStateChange?.({ status: mapped as "pending" | "success" | "reverted", action: "Borrow", hash: txHash, details });
    }
  }, [status, txHash, onTxStateChange, estimatedCrvUsdBorrow, borrowAmount, borrowToken]);

  // Handle transaction success — reset to idle so button returns to normal
  useEffect(() => {
    if (status === "success") {
      onTransactionSuccess();
      reset();
    }
  }, [status, onTransactionSuccess, reset]);

  // Handle approval success -> continue execution
  // For swap path: re-run full flow to check next approval (controller → crvUSD → execute)
  // For direct borrow: executeAfterApproval is sufficient (single approval)
  const handleSubmitRef = useRef<(() => Promise<void>) | undefined>(undefined);
  useEffect(() => {
    if (isApprovalSuccess && status === "approving") {
      if (isCrvUsd) {
        executeAfterApproval();
      } else {
        handleSubmitRef.current?.();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isApprovalSuccess, status]);

  // Clear amount and reset validation when switching tokens
  useEffect(() => {
    setBorrowAmountState("");
    setDebtTooHigh(false);
  }, [borrowToken.address]);

  const handleSubmit = async () => {
    if (!address || !controllerAddress || !borrowAmount || !position?.hasLoan)
      return;

    try {
      if (isCrvUsd) {
        // Path A: direct controller.borrow_more()
        const debtWei = parseUnits(borrowAmount, 18).toString();
        if (showSimulationPreview) {
          const result = await borrowMore(vault.address as `0x${string}`, "0", debtWei, { previewOnly: true });
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
          if (result) return; // Modal opened — bail
          // No simulation data (e.g. Anvil) — fall through to execute
        }
        await borrowMore(vault.address as `0x${string}`, "0", debtWei);
      } else {
        // Path B: borrow crvUSD + swap
        if (!estimatedCrvUsdBorrow) return;
        const debtHumanReadable = formatUnits(estimatedCrvUsdBorrow, 18);
        const swapOutputEstimate = borrowAmount
          ? parseUnits(borrowAmount, borrowToken.decimals)
          : undefined;
        if (showSimulationPreview) {
          const result = await borrowAndSwap(
            vault.address as `0x${string}`,
            borrowToken.address,
            debtHumanReadable,
            Number(slippage),
            { previewOnly: true, tokenSymbol: borrowToken.symbol, estimatedSwapOutput: swapOutputEstimate }
          );
          if (result) {
            simulationBlock.current = currentBlock ?? 0n;
            setShowSimulationModal(true);
            if (publicClient) {
              publicClient.readContract({
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
              }).then(data => {
                setEthPrice(Number(data[1] as bigint) / 1e8);
              }).catch(() => {});
            }
          }
          if (result) return; // Modal opened — bail
          // No simulation data (e.g. Anvil) — fall through to execute
        }
        await borrowAndSwap(
          vault.address as `0x${string}`,
          borrowToken.address,
          debtHumanReadable,
          Number(slippage),
          { tokenSymbol: borrowToken.symbol, estimatedSwapOutput: swapOutputEstimate }
        );
      }
    } catch (err) {
      console.error("Borrow action failed:", err);
    }
  };
  handleSubmitRef.current = handleSubmit;

  const handleExecute = async () => {
    try {
      await executeAfterPreview();
    } catch (err) {
      console.error("Borrow execution failed:", err);
    }
  };

  // Validation: amount exceeds max borrowable
  const exceedsMax = useMemo(() => {
    if (!estimatedCrvUsdBorrow || maxBorrowable === null) return false;
    return estimatedCrvUsdBorrow > maxBorrowable;
  }, [estimatedCrvUsdBorrow, maxBorrowable]);

  const isProcessing =
    status !== "idle" &&
    status !== "success" &&
    status !== "error" &&
    status !== "reverted" &&
    status !== "needsApproval";

  const isFormValid =
    !!borrowAmount &&
    Number(borrowAmount) > 0 &&
    position?.hasLoan &&
    !exceedsMax &&
    !debtTooHigh &&
    (isCrvUsd || (!quoteLoading && estimatedCrvUsdBorrow !== null));

  const getButtonText = () => {
    if (status === "building") return <>Building transaction<LoadingDots /></>;
    if (status === "simulating") return <>Simulating<LoadingDots /></>;
    if (status === "executing") return <>Confirm in wallet<LoadingDots /></>;
    if (status === "waitingTx") return <>Waiting for confirmation<LoadingDots /></>;
    if (debtTooHigh || exceedsMax) return "Exceeds max borrowable";

    if (isCrvUsd) return "Borrow crvUSD";
    if (isVaultWithCrvUsdUnderlying) return "Borrow & Deposit";
    return "Borrow & Swap";
  };

  if (position?.inSoftLiquidation) {
    return (
      <div className="py-6 px-2 space-y-2 text-center">
        <AlertTriangle size={20} className="mx-auto text-yellow-500" />
        <div className="text-sm font-medium text-[var(--foreground)]">Borrowing unavailable</div>
        <div className="text-xs text-[var(--muted-foreground)]">
          Your position is in soft-liquidation.{onSwitchTab ? (<> Use <button type="button" onClick={() => onSwitchTab("repay")} className="underline hover:text-[var(--foreground)] transition-colors">Repay</button> to reduce debt or <button type="button" onClick={() => onSwitchTab("leverage")} className="underline hover:text-[var(--foreground)] transition-colors">Liquidate</button> to close your position.</>) : " Repay debt to resume borrowing."}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Amount Input + Token Selector */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-[var(--muted-foreground)]">
            {isCrvUsd ? "Borrow Amount" : "Receive Amount"}
          </label>
          {maxBorrowable !== null && maxBorrowable > 0n && (
            <span className="text-xs text-[var(--muted-foreground)]">
              Max: {Number(formatUnits(maxBorrowable, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
          <input
            type="text"
            value={borrowAmount}
            onChange={(e) => setBorrowAmount(e.target.value)}
            placeholder="0.0"
            className="flex-1 min-w-0 bg-transparent mono text-sm outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
          />
          <TokenSelector
            selectedToken={borrowToken}
            onSelect={setBorrowToken}
            priorityTokens={[CRVUSD_TOKEN, SCRVUSD_TOKEN]}
            excludeDefiTokens
          />
          {maxBorrowable !== null && maxBorrowable > 0n && (
            isCrvUsd ? (
              <MaxButton
                balance={formatUnits(maxBorrowable, 18)}
                onSelect={setBorrowAmount}
              />
            ) : maxTokenEquivalent ? (
              <MaxButton
                balance={maxTokenEquivalent}
                onSelect={setBorrowAmount}
              />
            ) : (
              <span className="shrink-0 px-2 py-1 text-xs font-medium text-[var(--muted-foreground)] animate-pulse">
                MAX
              </span>
            )
          )}
        </div>
      </div>


      {/* Quote details (non-crvUSD, when amount entered and quote loaded) */}
      {!isCrvUsd && borrowAmount && Number(borrowAmount) > 0 && (
        <>
          {/* Vault with crvUSD underlying (e.g., scrvUSD): show estimated debt */}
          {isVaultWithCrvUsdUnderlying && estimatedCrvUsdBorrow !== null && !quoteLoading && (
            <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-[var(--muted-foreground)]">Borrowing</span>
                <span className="mono">
                  ~{Number(formatUnits(estimatedCrvUsdBorrow, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                  crvUSD
                </span>
              </div>
              {exchangeRate !== null && (
                <div className="flex justify-between items-center">
                  <span className="text-[var(--muted-foreground)]">Rate</span>
                  <button
                    type="button"
                    onClick={() => setRateInverted(v => !v)}
                    className="flex items-center gap-1 mono hover:text-[var(--accent)] transition-colors"
                  >
                    {rateInverted
                      ? <>1 crvUSD = {(1 / exchangeRate).toLocaleString(undefined, { maximumFractionDigits: 4 })} {borrowToken.symbol}</>
                      : <>1 {borrowToken.symbol} = {exchangeRate.toLocaleString(undefined, { maximumFractionDigits: 4 })} crvUSD</>
                    }
                    <ArrowRightLeft size={12} className="text-[var(--muted-foreground)]" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Regular swap: show estimated debt, rate, impact */}
          {!isVaultWithCrvUsdUnderlying && swapQuote && !quoteLoading && (
            <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-2 text-sm">
              {/* Estimated crvUSD debt */}
              {estimatedCrvUsdBorrow !== null && (
                <div className="flex justify-between">
                  <span className="text-[var(--muted-foreground)]">
                    Borrowing
                  </span>
                  <span className="mono">
                    ~{Number(
                      formatUnits(estimatedCrvUsdBorrow, 18)
                    ).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                    crvUSD
                  </span>
                </div>
              )}

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
                      ? <>1 crvUSD = {(1 / exchangeRate).toLocaleString(undefined, { maximumFractionDigits: 4 })} {borrowToken.symbol}</>
                      : <>1 {borrowToken.symbol} = {exchangeRate.toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD</>
                    }
                    <ArrowRightLeft size={12} className="text-[var(--muted-foreground)]" />
                  </button>
                </div>
              )}

              {/* Price impact (from forward quote: crvUSD → token) */}
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

            </div>
          )}
        </>
      )}

      {/* Low liquidity warning */}
      {isLiquidityConstrained && maxBorrowable && maxBorrowable > 0n && estimatedCrvUsdBorrow && estimatedCrvUsdBorrow >= maxBorrowable * 90n / 100n && (
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
              <div className="text-sm font-medium">Approvals Required</div>
              {approvalProgress && (
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
              )}
              {lastApprovalRef.current!.type !== "controller" && lastApprovalRef.current!.amount ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => { setApprovingType("exact"); approve(true); }}
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
                    onClick={() => { setApprovingType("unlimited"); approve(false); }}
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
                  onClick={() => { setApprovingType("single"); approve(); }}
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
                    : `Approve${approvalProgress ? ` (${approvalProgress.step}/${approvalProgress.total})` : ""}`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>


      {/* Simulation Modal */}
      {showSimulationModal && simulationResult && (() => {
        // Filter asset changes to show only net result:
        // - "borrow" entries (crvUSD debt created)
        // - "receive" entries that don't also appear as "send" (skip intermediates)
        const changes = simulationResult.assetChanges ?? [];
        const sendSymbols = new Set(
          changes
            .filter((c) => c.type === "send")
            .map((c) => c.symbol.toLowerCase())
        );
        const filteredChanges = changes.filter(
          (c) =>
            c.type === "borrow" ||
            (c.type === "receive" && !sendSymbols.has(c.symbol.toLowerCase()))
        );
        return (
          <SimulationModal
            isOpen={showSimulationModal}
            onClose={() => {
              setShowSimulationModal(false);
              toast("Transaction cancelled", { id: "borrow-cancelled", duration: 3000 });
            }}
            onConfirm={() => {
              setShowSimulationModal(false);
              handleExecute();
            }}
            simulationResult={{
              ...simulationResult,
              assetChanges: filteredChanges,
            }}
            gasPrice={gasPrice}
            ethPrice={ethPrice}
            confirmText="Confirm & Execute"
          />
        );
      })()}

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
              } else if (!quoteLoading) {
                handleSubmit();
              }
            }}
            disabled={showApprovalCard || isProcessing || quoteLoading || (!isFormValid && status === "idle")}
            className={cn(
              "w-full py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
              isProcessing || quoteLoading || (!isFormValid && status === "idle")
                ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
            )}
          >
            {!isCrvUsd && quoteLoading && status === "idle" ? (
              <>Getting quote<LoadingDots /></>
            ) : (
              getButtonText()
            )}
          </button>
        </div>
      </div>

      {/* Settings icon for direct crvUSD path */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: isCrvUsd ? "1fr" : "0fr" }}
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
        style={{ gridTemplateRows: !isCrvUsd ? "1fr" : "0fr" }}
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
            showRoute && borrowAmount && Number(borrowAmount) > 0 && (swapQuote || quoteLoading || (isVaultWithCrvUsdUnderlying && estimatedCrvUsdBorrow !== null)) ? "1fr" : "0fr",
        }}
      >
        <div className="overflow-hidden">
          <div className="pt-3 mt-3 border-t border-[var(--border)]">
                <div className="text-xs text-[var(--muted-foreground)] mb-2">
                  Route
                </div>
                <RouteDisplay
                  routeInfo={
                    isVaultWithCrvUsdUnderlying && estimatedCrvUsdBorrow !== null
                      ? {
                          steps: [
                            {
                              tokenSymbol: "crvUSD",
                              action: "Borrow",
                              protocol: "Curve LlamaLend",
                            },
                            {
                              tokenSymbol: borrowToken.symbol,
                              action: "Deposit",
                              description: "from crvUSD",
                              protocol: "Curve Savings",
                            },
                          ],
                        }
                      : swapQuote
                      ? {
                          steps: [
                            {
                              tokenSymbol: "crvUSD",
                              action: "Borrow",
                              protocol: "Curve LlamaLend",
                            },
                            ...(isCvgCvxVault
                              ? [
                                  {
                                    tokenSymbol: "CVX",
                                    amount: cvgCvxRouteAmounts?.cvx,
                                    action: "Swap",
                                    description: "from crvUSD",
                                    protocol: "Enso Router",
                                  },
                                  {
                                    tokenSymbol: "cvgCVX",
                                    amount: cvgCvxRouteAmounts?.cvgCvx,
                                    action: "Swap",
                                    description: "CVX → CVX1 → cvgCVX",
                                    protocol: "LiquidBoost",
                                  },
                                  {
                                    tokenSymbol: borrowToken.symbol,
                                    action: "Deposit",
                                    protocol: "yld",
                                  },
                                ]
                              : vaultInfo
                                ? [
                                    {
                                      tokenSymbol: vaultInfo.underlyingSymbol,
                                      action: "Swap",
                                      description: "from crvUSD",
                                      protocol: "Enso Router",
                                    },
                                    {
                                      tokenSymbol: borrowToken.symbol,
                                      action: "Deposit",
                                      protocol: "yld",
                                    },
                                  ]
                                : [
                                    {
                                      tokenSymbol: borrowToken.symbol,
                                      action: "Swap",
                                      description: "from crvUSD",
                                      protocol: "Enso Router",
                                    },
                                  ]),
                          ],
                        }
                      : undefined
                  }
                  inputSymbol="crvUSD"
                  outputSymbol={borrowToken.symbol}
                  inputAmount={
                    estimatedCrvUsdBorrow
                      ? Number(formatUnits(estimatedCrvUsdBorrow, 18)).toFixed(2)
                      : undefined
                  }
                  outputAmount={
                    borrowAmount ? Number(borrowAmount).toFixed(4) : undefined
                  }
                  isLoading={quoteLoading}
                />
          </div>
        </div>
      </div>

      {/* Connect wallet prompt */}
      {!address && (
        <div className="text-center text-sm text-[var(--muted-foreground)] py-4">
          Connect your wallet to borrow
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
