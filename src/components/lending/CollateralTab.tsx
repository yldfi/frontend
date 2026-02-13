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
  Plus,
  Minus,
  ArrowRightLeft,
  ExternalLink,
} from "lucide-react";
import { useAccount, usePublicClient, useBalance, useGasPrice, useBlockNumber } from "wagmi";
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
import { fetchRoute, fetchTokenPrices, ETH_ADDRESS } from "@/lib/enso";
import type { EnsoToken, EnsoRouteResponse } from "@/types/enso";

const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

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

// Animated loading dots (matches BorrowTab pattern)
function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="animate-bounce" style={{ animationDelay: "0ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "150ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "300ms", animationDuration: "600ms" }}>.</span>
    </span>
  );
}

type CollateralMode = "add" | "remove";

interface CollateralTabProps {
  vault: VaultConfig;
  userBalance: string; // Vault token balance in wei
  position: LendingPosition | null;
  controllerAddress: `0x${string}`;
  onTransactionSuccess: () => void;
  onEstimatedHealthChange?: (health: number | null) => void;
  onCollateralDeltaChange?: (delta: bigint | null) => void;
  onTxStateChange?: (state: { status: "pending" | "success" | "reverted"; action: string; hash: string; details?: { fromAmount: string; fromSymbol: string; fromLogo: string; toAmount: string; toSymbol: string; toLogo: string } } | null) => void;
  onSwitchTab?: (tab: string) => void;
}

export function CollateralTab({
  vault,
  userBalance,
  position,
  controllerAddress,
  onTransactionSuccess,
  onEstimatedHealthChange,
  onCollateralDeltaChange,
  onTxStateChange,
  onSwitchTab,
}: CollateralTabProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  // +/- mode
  const [mode, setMode] = useState<CollateralMode>("add");

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

  // Token selection — default is the vault token
  const [selectedToken, setSelectedToken] = useState<EnsoToken>(vaultToken);
  const isVaultToken =
    selectedToken.address.toLowerCase() === vault.address.toLowerCase();

  // Form state
  const [amount, setAmountState] = useState("");
  const setAmount = useCallback((v: string) => setAmountState(sanitizeAmount(v)), []);

  // Slippage (basis points) — persisted
  const [rateInverted, setRateInverted] = useState(false);
  const [slippage, setSlippage] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("yldfi-slippage") || "50";
    }
    return "50";
  });
  const [showSlippageModal, setShowSlippageModal] = useState(false);

  // Route display toggle — persisted
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

  // Simulation
  const [showSimulationModal, setShowSimulationModal] = useState(false);
  const [ethPrice, setEthPrice] = useState<number | null>(null);
  const { data: gasPrice } = useGasPrice();
  const { data: currentBlock } = useBlockNumber({ watch: true });
  const simulationBlock = useRef<bigint>(0n);

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
    addCollateral,
    removeCollateral,
    addCollateralWithSwap,
    removeCollateralAndSwap,
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
    clearError,
    executeAfterPreview,
  } = useCurveLendingActions();

  // Preserve last approval data so content stays in DOM during close animation
  const lastApprovalRef = useRef(pendingApproval);
  if (pendingApproval) lastApprovalRef.current = pendingApproval;
  const showApprovalCard = !!(pendingApproval && (status === "needsApproval" || status === "approving"));

  // Track which approval button was clicked
  const [approvingType, setApprovingType] = useState<"exact" | "unlimited" | "single" | null>(null);
  useEffect(() => {
    if (!isApproving) setApprovingType(null);
  }, [isApproving]);

  // Read selected token balance (native ETH or ERC20)
  const isEth = selectedToken.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const { data: tokenBalance, refetch: refetchBalance } = useBalance({
    address,
    token: isEth ? undefined : (selectedToken.address as `0x${string}`),
    query: { enabled: !!address },
  });

  // Max balance for add mode
  const addMaxBalance = useMemo(() => {
    if (isVaultToken) {
      return formatUnits(BigInt(userBalance), vault.decimals);
    }
    return tokenBalance?.formatted ?? "0";
  }, [isVaultToken, userBalance, vault.decimals, tokenBalance]);

  // Max balance for remove mode (max withdrawable without breaking health)
  const removeMaxBalance = useMemo(() => {
    if (!position?.hasLoan) return "0";
    return formatUnits(position.maxWithdrawable, vault.decimals);
  }, [position, vault.decimals]);

  const maxBalance = mode === "add" ? addMaxBalance : removeMaxBalance;
  const currentTokenBalance = isVaultToken
    ? BigInt(userBalance)
    : (tokenBalance?.value ?? 0n);

  const formattedBalance = useMemo(() => {
    const value = parseFloat(maxBalance) || 0;
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }, [maxBalance]);

  // Debounced amount for quote fetching
  const debouncedAmount = useDebouncedValue(amount, 500);

  // Swap quote — only needed when token != vault token
  const needsSwap = !isVaultToken;

  // Add mode: quote tokenIn → vaultToken
  // Remove mode: quote vaultToken → tokenOut
  const {
    data: swapQuote,
    isLoading: swapQuoteLoading,
  } = useQuery({
    queryKey: [
      "collateral-swap-quote",
      mode,
      selectedToken.address,
      vault.address,
      debouncedAmount,
      slippage,
      address,
    ],
    queryFn: async (): Promise<EnsoRouteResponse> => {
      if (!address) throw new Error("No address");

      if (mode === "add") {
        // tokenIn → vaultToken
        const amountWei = parseUnits(debouncedAmount, selectedToken.decimals).toString();
        return fetchRoute({
          fromAddress: address,
          tokenIn: selectedToken.address,
          tokenOut: vault.address,
          amountIn: amountWei,
          slippage,
        });
      } else {
        // vaultToken → tokenOut
        const amountWei = parseUnits(debouncedAmount, vault.decimals).toString();
        return fetchRoute({
          fromAddress: address,
          tokenIn: vault.address,
          tokenOut: selectedToken.address,
          amountIn: amountWei,
          slippage,
        });
      }
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

  // Estimated vault token amount from swap (for health calculation)
  const estimatedVaultTokenAmount = useMemo(() => {
    if (isVaultToken) {
      if (!amount || Number(amount) <= 0) return null;
      try {
        return parseUnits(amount, vault.decimals);
      } catch {
        return null;
      }
    }
    if (mode === "add" && swapQuote?.amountOut) {
      return BigInt(swapQuote.amountOut);
    }
    if (mode === "remove") {
      if (!amount || Number(amount) <= 0) return null;
      try {
        return parseUnits(amount, vault.decimals);
      } catch {
        return null;
      }
    }
    return null;
  }, [isVaultToken, amount, vault.decimals, mode, swapQuote]);

  // Exchange rate
  const exchangeRate = useMemo(() => {
    if (!swapQuote?.amountOut || !debouncedAmount || Number(debouncedAmount) === 0)
      return null;
    if (mode === "add") {
      // tokenIn → vaultToken: 1 tokenIn = X vaultToken
      const outFormatted = Number(formatUnits(BigInt(swapQuote.amountOut), vault.decimals));
      return outFormatted / Number(debouncedAmount);
    } else {
      // vaultToken → tokenOut: 1 vaultToken = X tokenOut
      const outFormatted = Number(formatUnits(BigInt(swapQuote.amountOut), selectedToken.decimals));
      return outFormatted / Number(debouncedAmount);
    }
  }, [swapQuote, debouncedAmount, mode, vault.decimals, selectedToken.decimals]);

  // Price impact: manual calculation using USD token prices + convertToAssets
  // Same pattern as BorrowTab/useZapQuote: ((inputUsd - outputUsd) / inputUsd) × 100
  const priceTokenAddress = useMemo(
    () => (isEth ? WETH_ADDRESS : selectedToken.address),
    [isEth, selectedToken.address]
  );
  const { data: tokenPrices } = useQuery({
    queryKey: ["collateral-token-prices", priceTokenAddress, vault.assetAddress],
    queryFn: () => fetchTokenPrices([priceTokenAddress, vault.assetAddress]),
    enabled: needsSwap,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Convert vault token amount to underlying via convertToAssets for pricing
  const vaultTokenAmountForPricing = useMemo(() => {
    if (!needsSwap || !swapQuote?.amountOut) return null;
    if (mode === "add") return BigInt(swapQuote.amountOut);
    // remove: input is vault token amount
    if (!debouncedAmount || Number(debouncedAmount) <= 0) return null;
    try { return parseUnits(debouncedAmount, vault.decimals); } catch { return null; }
  }, [needsSwap, swapQuote, mode, debouncedAmount, vault.decimals]);

  const { data: underlyingEquivalent } = useQuery({
    queryKey: ["collateral-underlying-eq", vault.address, vaultTokenAmountForPricing?.toString()],
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

    if (mode === "add") {
      // Input: user sends selectedToken, output: vault token (priced via underlying)
      const inputUsd = Number(debouncedAmount) * selectedPrice;
      const outputUsd = underlyingAmount * underlyingPrice;
      if (inputUsd === 0) return null;
      return ((inputUsd - outputUsd) / inputUsd) * 100;
    } else {
      // Remove: input: vault token (priced via underlying), output: user receives selectedToken
      const inputUsd = underlyingAmount * underlyingPrice;
      const outputUsd = Number(formatUnits(BigInt(swapQuote.amountOut), selectedToken.decimals)) * selectedPrice;
      if (inputUsd === 0) return null;
      return ((inputUsd - outputUsd) / inputUsd) * 100;
    }
  }, [quoteLoading, debouncedAmount, swapQuote, tokenPrices, underlyingEquivalent, priceTokenAddress, vault.assetAddress, vault.assetDecimals, selectedToken.decimals, mode]);

  // Calculate estimated health
  useEffect(() => {
    async function calculateHealth() {
      if (!publicClient || !controllerAddress || !address || !position?.hasLoan) {
        setEstimatedHealth(null);
        return;
      }

      if (!estimatedVaultTokenAmount) {
        setEstimatedHealth(null);
        return;
      }

      try {
        // d_collateral: positive for add, negative for remove
        const dCollateral = mode === "add"
          ? estimatedVaultTokenAmount
          : -estimatedVaultTokenAmount;

        const health = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "health_calculator",
          args: [address, dCollateral, 0n, true, 0n],
        });

        setEstimatedHealth(Number(health) / 1e16);
      } catch {
        if (mode === "remove") {
          // Removing too much collateral can revert
          setEstimatedHealth(0);
        } else {
          setEstimatedHealth(null);
        }
      }
    }

    const timer = setTimeout(calculateHealth, 300);
    return () => clearTimeout(timer);
  }, [publicClient, controllerAddress, address, position, estimatedVaultTokenAmount, mode]);

  // Report estimated health to parent
  useEffect(() => {
    onEstimatedHealthChange?.(estimatedHealth);
  }, [estimatedHealth, onEstimatedHealthChange]);

  // Report collateral delta to parent
  useEffect(() => {
    if (estimatedVaultTokenAmount && estimatedVaultTokenAmount > 0n) {
      onCollateralDeltaChange?.(mode === "add" ? estimatedVaultTokenAmount : -estimatedVaultTokenAmount);
    } else {
      onCollateralDeltaChange?.(null);
    }
  }, [estimatedVaultTokenAmount, mode, onCollateralDeltaChange]);

  // Report tx state to parent for full-screen overlay
  useEffect(() => {
    if ((status === "waitingTx" || status === "success" || status === "reverted") && txHash) {
      const action = mode === "add" ? "Add Collateral" : "Remove Collateral";
      const details = amount && Number(amount) > 0 ? (mode === "add" ? {
        fromAmount: amount,
        fromSymbol: selectedToken.symbol,
        fromLogo: selectedToken.logoURI || "/tokens/unknown.png",
        toAmount: isVaultToken ? amount : estimatedVaultTokenAmount ? Number(formatUnits(estimatedVaultTokenAmount, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }) : "~",
        toSymbol: vault.symbol,
        toLogo: vault.logo,
      } : {
        fromAmount: amount,
        fromSymbol: vault.symbol,
        fromLogo: vault.logo,
        toAmount: isVaultToken ? amount : swapQuote?.amountOut ? Number(formatUnits(BigInt(swapQuote.amountOut), selectedToken.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }) : "~",
        toSymbol: selectedToken.symbol,
        toLogo: selectedToken.logoURI || "/tokens/unknown.png",
      }) : undefined;
      const mapped = status === "waitingTx" ? "pending" : status;
      onTxStateChange?.({ status: mapped as "pending" | "success" | "reverted", action, hash: txHash, details });
    }
  }, [status, txHash, mode, onTxStateChange, amount, selectedToken, isVaultToken, estimatedVaultTokenAmount, vault, swapQuote]);

  // Collateral change summary from Tenderly simulation + position data
  const collateralSummary = useMemo(() => {
    if (!simulationResult?.success || !position?.hasLoan) return undefined;
    // Find the deposit or receive entry for the vault token
    const depositEntry = simulationResult.assetChanges.find(
      (c) => c.type === "deposit" && c.address.toLowerCase() === vault.address.toLowerCase()
    );
    const receiveEntry = simulationResult.assetChanges.find(
      (c) => c.type === "receive" && c.address.toLowerCase() === vault.address.toLowerCase()
    );
    const fmt = (wei: bigint) =>
      Number(formatUnits(wei, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });

    if (mode === "add" && depositEntry) {
      const added = BigInt(depositEntry.rawAmount);
      const newTotal = position.collateral + added;
      return [
        { label: "Current Collateral", value: `${fmt(position.collateral)} ${vault.symbol}` },
        { label: "New Collateral", value: `${fmt(newTotal)} ${vault.symbol}`, subValue: `+${fmt(added)}`, subValueColor: "#22c55e" },
      ];
    }
    if (mode === "remove" && receiveEntry) {
      const removed = BigInt(receiveEntry.rawAmount);
      const remaining = position.collateral > removed ? position.collateral - removed : 0n;
      return [
        { label: "Current Collateral", value: `${fmt(position.collateral)} ${vault.symbol}` },
        { label: "New Collateral", value: `${fmt(remaining)} ${vault.symbol}`, subValue: `-${fmt(removed)}`, subValueColor: "#ef4444" },
      ];
    }
    return undefined;
  }, [simulationResult, position, vault.address, vault.decimals, vault.symbol, mode]);

  // Clear simulation/approval state when inputs change
  useEffect(() => {
    if (simulationResult || status === "needsApproval") {
      reset();
      setShowSimulationModal(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, selectedToken.address, mode]);

  // Toast notifications
  useEffect(() => {
    if (status === "success" && txHash) {
      toast.success(mode === "add" ? "Collateral added!" : "Collateral removed!", {
        action: {
          label: "View Tx",
          onClick: () => window.open(`https://etherscan.io/tx/${txHash}`, "_blank"),
        },
      });
      onTransactionSuccess();
      refetchBalance();
      reset();
    }
  }, [status, txHash, mode, onTransactionSuccess, reset, refetchBalance]);

  useEffect(() => {
    if ((status === "error" || status === "reverted") && error) {
      if (isUserRejection(error)) {
        toast("Transaction cancelled", { id: "collateral-cancelled", duration: 3000 });
        clearError();
      } else {
        toast.error(error);
        reset();
      }
    }
  }, [status, error, reset, clearError]);

  // Handle approval success -> continue execution
  const handleSubmitRef = useRef<(() => Promise<void>) | undefined>(undefined);
  useEffect(() => {
    if (isApprovalSuccess && status === "approving") {
      if (isVaultToken) {
        executeAfterApproval();
      } else {
        handleSubmitRef.current?.();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isApprovalSuccess, status]);

  // Clear amount and reset when switching mode or token
  useEffect(() => {
    setAmountState("");
    reset();
  }, [mode, selectedToken.address, reset]);

  // Fetch ETH price for gas display
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
    if (!address || !controllerAddress || !amount || Number(amount) <= 0) return;

    try {
      if (mode === "add") {
        if (isVaultToken) {
          if (showSimulationPreview) {
            const result = await addCollateral(
              vault.address as `0x${string}`,
              amount,
              { tokenSymbol: vault.symbol, previewOnly: true }
            );
            if (result) {
              simulationBlock.current = currentBlock ?? 0n;
              setShowSimulationModal(true);
              fetchEthPrice();
              return; // Modal opened — bail
            }
            // No simulation data (e.g. Anvil) — fall through to execute
          }
          await addCollateral(
            vault.address as `0x${string}`,
            amount,
            { tokenSymbol: vault.symbol }
          );
        } else {
          // Swap: tokenIn → vaultToken → add_collateral
          if (showSimulationPreview) {
            const result = await addCollateralWithSwap(
              vault.address as `0x${string}`,
              selectedToken.address,
              amount,
              Number(slippage),
              { previewOnly: true, tokenSymbol: selectedToken.symbol }
            );
            if (result) {
              simulationBlock.current = currentBlock ?? 0n;
              setShowSimulationModal(true);
              fetchEthPrice();
              return; // Modal opened — bail
            }
            // No simulation data (e.g. Anvil) — fall through to execute
          }
          await addCollateralWithSwap(
            vault.address as `0x${string}`,
            selectedToken.address,
            amount,
            Number(slippage),
            { tokenSymbol: selectedToken.symbol }
          );
        }
      } else {
        // Remove mode
        if (isVaultToken) {
          if (showSimulationPreview) {
            const result = await removeCollateral(
              vault.address as `0x${string}`,
              amount,
              { previewOnly: true }
            );
            if (result) {
              simulationBlock.current = currentBlock ?? 0n;
              setShowSimulationModal(true);
              fetchEthPrice();
              return; // Modal opened — bail
            }
            // No simulation data (e.g. Anvil) — fall through to execute
          }
          await removeCollateral(
            vault.address as `0x${string}`,
            amount,
          );
        } else {
          // Swap: remove_collateral → vaultToken → tokenOut
          if (showSimulationPreview) {
            const result = await removeCollateralAndSwap(
              vault.address as `0x${string}`,
              amount,
              selectedToken.address,
              Number(slippage),
              { previewOnly: true, tokenSymbol: selectedToken.symbol }
            );
            if (result) {
              simulationBlock.current = currentBlock ?? 0n;
              setShowSimulationModal(true);
              fetchEthPrice();
              return; // Modal opened — bail
            }
            // No simulation data (e.g. Anvil) — fall through to execute
          }
          await removeCollateralAndSwap(
            vault.address as `0x${string}`,
            amount,
            selectedToken.address,
            Number(slippage),
            { tokenSymbol: selectedToken.symbol }
          );
        }
      }
    } catch (err) {
      console.error("Collateral action failed:", err);
    }
  };
  handleSubmitRef.current = handleSubmit;

  const handleExecute = async () => {
    try {
      await executeAfterPreview();
    } catch (err) {
      console.error("Collateral execution failed:", err);
    }
  };

  // Validation
  const hasInsufficientBalance = useMemo(() => {
    if (mode === "remove" || !amount || Number(amount) === 0) return false;
    try {
      const amountWei = parseUnits(amount, isVaultToken ? vault.decimals : selectedToken.decimals);
      return amountWei > currentTokenBalance;
    } catch {
      return false;
    }
  }, [mode, amount, isVaultToken, vault.decimals, selectedToken.decimals, currentTokenBalance]);

  const exceedsCollateral = useMemo(() => {
    if (mode !== "remove" || !amount || Number(amount) === 0 || !position?.hasLoan) return false;
    try {
      const amountWei = parseUnits(amount, vault.decimals);
      return amountWei > position.maxWithdrawable;
    } catch {
      return false;
    }
  }, [mode, amount, vault.decimals, position]);

  const healthTooLow = estimatedHealth !== null && estimatedHealth <= 0 && mode === "remove";

  const isProcessing =
    status !== "idle" &&
    status !== "success" &&
    status !== "error" &&
    status !== "reverted" &&
    status !== "needsApproval";

  const isFormValid =
    !!amount &&
    Number(amount) > 0 &&
    !hasInsufficientBalance &&
    !exceedsCollateral &&
    !healthTooLow &&
    (isVaultToken || (!quoteLoading && swapQuote !== undefined));

  const getButtonText = () => {
    if (status === "building") return <>Building transaction<LoadingDots /></>;
    if (status === "simulating") return <>Simulating<LoadingDots /></>;
    if (status === "executing") return <>Confirm in wallet<LoadingDots /></>;
    if (status === "waitingTx") return <>Waiting for confirmation<LoadingDots /></>;
    if (hasInsufficientBalance) return "Insufficient balance";
    if (exceedsCollateral) return "Exceeds collateral";
    if (healthTooLow) return "Position would be unhealthy";

    if (mode === "add") {
      if (isVaultToken) return "Add Collateral";
      return "Swap & Add Collateral";
    } else {
      if (isVaultToken) return "Remove Collateral";
      return "Remove & Swap";
    }
  };

  if (position?.inSoftLiquidation) {
    return (
      <div className="py-6 px-2 space-y-2 text-center">
        <AlertTriangle size={20} className="mx-auto text-yellow-500" />
        <div className="text-sm font-medium text-[var(--foreground)]">Collateral management unavailable</div>
        <div className="text-xs text-[var(--muted-foreground)]">
          Your position is in soft-liquidation.{onSwitchTab ? (<> Use <button type="button" onClick={() => onSwitchTab("repay")} className="underline hover:text-[var(--foreground)] transition-colors">Repay</button> to reduce debt or <button type="button" onClick={() => onSwitchTab("leverage")} className="underline hover:text-[var(--foreground)] transition-colors">Liquidate</button> to close your position.</>) : " Repay debt or close your position."}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* +/- Mode Toggle */}
      <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--muted)] border border-[var(--border)]">
        <button
          onClick={() => setMode("add")}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium transition-all",
            mode === "add"
              ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          )}
        >
          <Plus size={14} />
          Add
        </button>
        <button
          onClick={() => setMode("remove")}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium transition-all",
            mode === "remove"
              ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          )}
        >
          <Minus size={14} />
          Remove
        </button>
      </div>

      {/* Amount Input + Token Selector */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-[var(--muted-foreground)]">
            {mode === "add" ? "Add Amount" : "Remove Amount"}
          </label>
          <span className="text-xs text-[var(--muted-foreground)]">
            {mode === "add" ? "Balance" : "Collateral"}: {formattedBalance}
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
            excludeDefiTokens={mode === "add"}
          />
          <MaxButton
            balance={maxBalance}
            onSelect={setAmount}
          />
        </div>
      </div>

      {/* Quote details (non-vault-token, when amount entered and quote loaded) */}
      {needsSwap && amount && Number(amount) > 0 && swapQuote && !quoteLoading && (
        <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-2 text-sm">
          {/* Output estimate */}
          {swapQuote.amountOut && (
            <div className="flex justify-between">
              <span className="text-[var(--muted-foreground)]">
                {mode === "add" ? "Adding" : "Receiving"}
              </span>
              <span className="mono">
                ~{Number(formatUnits(
                  BigInt(swapQuote.amountOut),
                  mode === "add" ? vault.decimals : selectedToken.decimals
                )).toLocaleString(undefined, { maximumFractionDigits: 4 })}{" "}
                {mode === "add" ? vault.symbol : selectedToken.symbol}
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
                  ? <>1 {mode === "add" ? vault.symbol : selectedToken.symbol} = {(1 / exchangeRate).toLocaleString(undefined, { maximumFractionDigits: 4 })} {mode === "add" ? selectedToken.symbol : vault.symbol}</>
                  : <>1 {mode === "add" ? selectedToken.symbol : vault.symbol} = {exchangeRate.toLocaleString(undefined, { maximumFractionDigits: 4 })} {mode === "add" ? vault.symbol : selectedToken.symbol}</>
                }
                <ArrowRightLeft size={12} className="text-[var(--muted-foreground)]" />
              </button>
            </div>
          )}

          {/* Price impact */}
          {priceImpact !== null && (
            <div className="flex justify-between">
              <span className="text-[var(--muted-foreground)]">Price Impact</span>
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

      {/* Approval Flow */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: showApprovalCard ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          {lastApprovalRef.current && (
            <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-3">
              <div className="text-sm font-medium">Approval Required</div>
              <div className="text-sm text-[var(--muted-foreground)]">
                {lastApprovalRef.current!.type === "controller"
                  ? <>Allow yld Zapper to manage position on LlamaLend{" "}<span className="whitespace-nowrap">controller <a href={`https://etherscan.io/address/${lastApprovalRef.current!.spender}`} target="_blank" rel="noopener noreferrer" className="inline hover:text-[var(--foreground)] transition-colors"><ExternalLink size={12} className="!inline -mt-0.5" /></a></span></>
                  : <>Allow yld Zapper to spend {lastApprovalRef.current!.tokenSymbol}{" "}<span className="whitespace-nowrap"><a href={`https://etherscan.io/address/${lastApprovalRef.current!.spender}`} target="_blank" rel="noopener noreferrer" className="inline hover:text-[var(--foreground)] transition-colors"><ExternalLink size={12} className="!inline -mt-0.5" /></a></span></>
                }
              </div>
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
                  {isApproving ? <>Approving<LoadingDots /></> : "Approve"}
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
            toast("Transaction cancelled", { id: "collateral-cancelled", duration: 3000 });
          }}
          onConfirm={() => {
            setShowSimulationModal(false);
            handleExecute();
          }}
          simulationResult={simulationResult}
          gasPrice={gasPrice}
          ethPrice={ethPrice}
          confirmText="Confirm & Execute"
          summary={collateralSummary}
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
              "w-full py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
              isProcessing || quoteLoading || (!isFormValid && status === "idle")
                ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
            )}
          >
            {needsSwap && quoteLoading && status === "idle" ? (
              <>Getting quote<LoadingDots /></>
            ) : (
              getButtonText()
            )}
          </button>
        </div>
      </div>

      {/* Settings icon for direct vault token paths (no swap) */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: !needsSwap ? "1fr" : "0fr" }}
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
        style={{ gridTemplateRows: needsSwap ? "1fr" : "0fr" }}
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
            showRoute && amount && Number(amount) > 0 && (swapQuote || quoteLoading) ? "1fr" : "0fr",
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
                          steps: mode === "add"
                            ? [
                                {
                                  tokenSymbol: selectedToken.symbol,
                                  action: "Swap",
                                  description: `for ${vault.symbol}`,
                                  protocol: "Enso Router",
                                },
                                {
                                  tokenSymbol: vault.symbol,
                                  action: "Add Collateral",
                                  protocol: "Curve LlamaLend",
                                },
                              ]
                            : [
                                {
                                  tokenSymbol: vault.symbol,
                                  action: "Remove Collateral",
                                  protocol: "Curve LlamaLend",
                                },
                                {
                                  tokenSymbol: selectedToken.symbol,
                                  action: "Swap",
                                  description: `from ${vault.symbol}`,
                                  protocol: "Enso Router",
                                },
                              ],
                        }
                      : undefined
                  }
                  inputSymbol={mode === "add" ? selectedToken.symbol : vault.symbol}
                  outputSymbol={mode === "add" ? vault.symbol : selectedToken.symbol}
                  inputAmount={
                    amount ? Number(amount).toFixed(4) : undefined
                  }
                  outputAmount={
                    swapQuote?.amountOut
                      ? Number(formatUnits(
                          BigInt(swapQuote.amountOut),
                          mode === "add" ? vault.decimals : selectedToken.decimals
                        )).toFixed(4)
                      : undefined
                  }
                  isLoading={quoteLoading}
                />
          </div>
        </div>
      </div>

      {/* Connect wallet prompt */}
      {!address && (
        <div className="text-center text-sm text-[var(--muted-foreground)] py-4">
          Connect your wallet to manage collateral
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
