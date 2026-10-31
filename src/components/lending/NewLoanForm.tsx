"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { SlippageModal } from "@/components/SlippageModal";
import { SimulationModal } from "@/components/SimulationModal";
import { toast } from "sonner";
import {
  isUserRejection,
  trackLendingBorrowInitiated,
  trackLendingBorrowSuccess,
  trackTransactionError,
  trackTransactionCancelled,
  categorizeError,
} from "@/lib/analytics";
import { AlertTriangle } from "lucide-react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { useAccount, usePublicClient, useGasPrice, useBlockNumber } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { useQuery } from "@tanstack/react-query";
import type { VaultConfig } from "@/config/vaults";
import { useCurveLendingActions } from "@/hooks/useCurveLendingActions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { TokenSelector } from "@/components/TokenSelector";
import { RouteDisplay } from "@/components/RouteDisplay";
import { MaxButton, MaxButtonSkeleton } from "@/components/MaxButton";
import { cn } from "@/lib/utils";
import { LoadingDots } from "@/components/LoadingDots";
import { sanitizeAmount } from "@/lib/sanitize";
import { useSettings } from "@/hooks/useSettings";
import { CRVUSD_ADDRESS, CHAINLINK_ETH_USD } from "@/config/addresses";
import type { EnsoToken } from "@/types/enso";
import { CONTROLLER_ABI, ERC20_BALANCE_ABI } from "@/lib/abis";
import { isLendingTxPendingVisible } from "@/lib/transaction-ui";

interface NewLoanFormProps {
  vault: VaultConfig;
  userBalance: string; // Vault token balance in wei
  controllerAddress: `0x${string}`;
  oraclePrice?: bigint; // AMM oracle price (collateral/crvUSD, 18 decimals)
  onTransactionSuccess: () => void;
  onEstimatedHealthChange?: (health: number | null) => void;
  onEstimatedLeverageChange?: (leverage: number | null) => void;
  onDebtDeltaChange?: (delta: bigint | null) => void;
  onCollateralAmountChange?: (amount: bigint | null) => void;
  onSettlingChange?: (settling: boolean) => void;
  onTxStateChange?: (state: { status: "pending" | "success" | "reverted"; action: string; hash?: string | null; details?: { fromAmount: string; fromSymbol: string; fromLogo: string; toAmount: string; toSymbol: string; toLogo: string; message?: string } } | null) => void;
  onBandsChange?: (bands: number) => void;
}

/**
 * Create a new LlamaLend loan: deposit vault tokens as collateral and borrow crvUSD
 * via a direct controller.create_loan call.
 */
export function NewLoanForm({
  vault,
  userBalance,
  controllerAddress,
  oraclePrice,
  onTransactionSuccess,
  onEstimatedHealthChange,
  onEstimatedLeverageChange,
  onDebtDeltaChange,
  onCollateralAmountChange,
  onSettlingChange,
  onTxStateChange,
  onBandsChange,
}: NewLoanFormProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  // Collateral token (always the vault token)
  const vaultToken: EnsoToken = useMemo(() => ({
    address: vault.address,
    chainId: 1,
    name: vault.name,
    symbol: vault.symbol,
    decimals: vault.decimals,
    logoURI: vault.logoSmall,
    type: "defi" as const,
  }), [vault]);

  // Borrowed token (always crvUSD)
  const crvUsdToken: EnsoToken = useMemo(() => ({
    address: CRVUSD_ADDRESS,
    chainId: 1,
    name: "Curve USD",
    symbol: "crvUSD",
    decimals: 18,
    logoURI: "/tokens/crvusd.png",
    type: "base" as const,
  }), []);

  // Form state — persisted across refresh
  const amountStorageKey = `yldfi-lending-newloan-amount-${vault.address}`;
  const debtStorageKey = `yldfi-lending-newloan-debt-${vault.address}`;
  const [amount, setAmountState] = useState(() => {
    if (typeof window === "undefined") return "";
    try { return sanitizeAmount(sessionStorage.getItem(amountStorageKey) ?? ""); } catch { return ""; }
  });
  const setAmount = useCallback((v: string) => {
    const sanitized = sanitizeAmount(v);
    setAmountState(sanitized);
    try {
      if (sanitized) sessionStorage.setItem(amountStorageKey, sanitized);
      else sessionStorage.removeItem(amountStorageKey);
    } catch { /* */ }
  }, [amountStorageKey]);
  const [debtInput, setDebtInputState] = useState(() => {
    if (typeof window === "undefined") return "";
    try { return sanitizeAmount(sessionStorage.getItem(debtStorageKey) ?? ""); } catch { return ""; }
  });
  const debtRatio = useRef<number | null>(null); // ratio of debt to maxBorrowable (0-1)
  const setDebtInput = useCallback((v: string) => {
    const sanitized = sanitizeAmount(v);
    setDebtInputState(sanitized);
    debtRatio.current = null; // will be recalculated in effect
    try {
      if (sanitized) sessionStorage.setItem(debtStorageKey, sanitized);
      else sessionStorage.removeItem(debtStorageKey);
    } catch { /* */ }
  }, [debtStorageKey]);
  const [bands, setBands] = useState(10);
  const debouncedBands = useDebouncedValue(bands, 400);
  useEffect(() => { onBandsChange?.(bands); }, [bands, onBandsChange]);

  const [maxBorrowableLoaded, setMaxBorrowableLoaded] = useState(false);

  const {
    slippage, updateSlippage, showSlippageModal, setShowSlippageModal,
    showSimulationPreview, refreshSimulationPreview,
    showSimulationModal, setShowSimulationModal,
    showRoute,
  } = useSettings();

  const [ethPrice, setEthPrice] = useState<number | null>(null);
  const { data: gasPrice } = useGasPrice();
  const { data: currentBlock } = useBlockNumber({ watch: true });
  const simulationBlock = useRef<bigint>(0n);


  // Health estimation
  const [estimatedHealth, setEstimatedHealth] = useState<number | null>(null);

  // Lending actions (direct create_loan)
  const {
    createLoan,
    pendingApproval,
    approvalProgress,
    approve,
    isApproving,
    isApprovalSuccess,
    executeAfterApproval,
    wasApprovalRequested,
    status,
    txHash,
    error,
    simulationResult,
    reset,
    clearError,
    executeAfterPreview,
  } = useCurveLendingActions();

  const showApprovalCard = !!(pendingApproval && (status === "needsApproval" || status === "approving"));

  const maxBalance = useMemo(
    () => formatUnits(BigInt(userBalance), vault.decimals),
    [userBalance, vault.decimals]
  );

  const currentTokenBalance = BigInt(userBalance);

  const formattedBalance = useMemo(() => {
    const value = parseFloat(maxBalance) || 0;
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }, [maxBalance]);

  // Collateral amount (for health calculation + max_borrowable)
  const estimatedVaultTokenAmount = useMemo(() => {
    if (!amount || Number(amount) <= 0) return null;
    try {
      return parseUnits(amount, vault.decimals);
    } catch {
      return null;
    }
  }, [amount, vault.decimals]);

  // Max borrowable for the collateral
  const [maxBorrowable, setMaxBorrowable] = useState<bigint>(0n);
  const [maxBorrowableFetching, setMaxBorrowableFetching] = useState(false);

  useEffect(() => {
    let stale = false;
    // Don't reset maxBorrowableLoaded — keep old max visible until new arrives
    // to prevent button flicker between "Create Loan" and "Exceeds max borrowable"
    async function calcMax() {
      if (!publicClient || !estimatedVaultTokenAmount) {
        setMaxBorrowable(0n);
        setMaxBorrowableLoaded(true);
        setMaxBorrowableFetching(false);
        return;
      }
      setMaxBorrowableFetching(true);
      let max = 0n;
      try {
        max = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "max_borrowable",
          args: [estimatedVaultTokenAmount, BigInt(debouncedBands)],
        });
        if (stale) return;
        if (process.env.NODE_ENV === "development") console.log("[NewLoan] max_borrowable:", { max: max.toString(), bands: debouncedBands, collateral: estimatedVaultTokenAmount.toString() });
      } catch (err) {
        if (stale) return;
        if (process.env.NODE_ENV === "development") console.log("[NewLoan] max_borrowable error:", err);
      }
      // Batch: update maxBorrowable AND adjust debt together to avoid
      // a render where old debt > new max (which causes button flicker)
      setMaxBorrowable(max);
      setMaxBorrowableFetching(false);
      const isApprovalInProgress = status === "needsApproval" || status === "approving";
      if (max > 0n && debtRatio.current !== null && !isApprovalInProgress) {
        const ratio = Math.min(debtRatio.current, 1.0);
        // Scale using bigint math then truncate string to 2dp — avoids floating point rounding past max
        const scaled = max * BigInt(Math.floor(ratio * 10000)) / 10000n;
        const str = formatUnits(scaled, 18);
        const dot = str.indexOf(".");
        setDebtInputState(dot === -1 ? str : str.slice(0, dot + 3));
      }
      setMaxBorrowableLoaded(true);
    }
    calcMax();
    return () => { stale = true; };
  }, [publicClient, controllerAddress, estimatedVaultTokenAmount, debouncedBands]); // eslint-disable-line react-hooks/exhaustive-deps

  // Controller's available crvUSD — detects when pool liquidity is the borrowing constraint
  const { data: controllerCrvUsdBalance } = useQuery({
    queryKey: ["controller-crvusd-balance", controllerAddress],
    queryFn: async () => {
      if (!publicClient) throw new Error("No client");
      return publicClient.readContract({
        address: CRVUSD_ADDRESS as `0x${string}`,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [controllerAddress],
      });
    },
    enabled: !!publicClient,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // True when pool liquidity caps borrowing (maxBorrowable ≈ controller balance)
  // Keeps last known value during settling (maxBorrowable may temporarily be 0)
  const isLiquidityConstrainedLive = useMemo(() => {
    if (!controllerCrvUsdBalance || maxBorrowable === 0n) return null; // unknown
    const threshold = controllerCrvUsdBalance * 105n / 100n;
    return maxBorrowable <= threshold;
  }, [controllerCrvUsdBalance, maxBorrowable]);
  const [isLiquidityConstrainedSnapshot, setIsLiquidityConstrainedSnapshot] = useState(false);
  useEffect(() => {
    if (isLiquidityConstrainedLive === null) return;
    const timer = setTimeout(() => {
      setIsLiquidityConstrainedSnapshot(isLiquidityConstrainedLive);
    }, 0);
    return () => clearTimeout(timer);
  }, [isLiquidityConstrainedLive]);
  const isLiquidityConstrained = isLiquidityConstrainedLive ?? isLiquidityConstrainedSnapshot;

  // Track debt ratio: capture when debtInput changes, adjust when maxBorrowable changes
  const prevMaxBorrowable = useRef<bigint>(0n);
  useEffect(() => {
    if (maxBorrowable === 0n) return;
    // If maxBorrowable changed and we have a ratio, adjust the input
    if (prevMaxBorrowable.current !== 0n && prevMaxBorrowable.current !== maxBorrowable && debtRatio.current !== null) {
      const ratio = Math.min(debtRatio.current, 1.0);
      // Scale using bigint math then truncate string to 2dp — avoids floating point rounding past max
      const scaled = maxBorrowable * BigInt(Math.floor(ratio * 10000)) / 10000n;
      const str = formatUnits(scaled, 18);
      const dot = str.indexOf(".");
      setDebtInputState(dot === -1 ? str : str.slice(0, dot + 3));
    }
    // Capture current ratio from debtInput
    if (debtInput && Number(debtInput) > 0) {
      try {
        const debtWei = parseUnits(debtInput, 18);
        debtRatio.current = Number(debtWei) / Number(maxBorrowable);
      } catch {
        debtRatio.current = null;
      }
    } else {
      debtRatio.current = null;
    }
    prevMaxBorrowable.current = maxBorrowable;
  }, [maxBorrowable, debtInput]);

  // Debt amount (wei)
  const debtAmount = (() => {
    if (!debtInput || Number(debtInput) <= 0) return 0n;
    try {
      return parseUnits(debtInput, 18);
    } catch {
      return 0n;
    }
  })();

  const isQuoteSettling = maxBorrowableFetching;

  // Memoize route steps — only update when all data is settled
  const routeSteps = useMemo(() => [
    {
      tokenSymbol: vault.symbol,
      amount: estimatedVaultTokenAmount
        ? Number(formatUnits(estimatedVaultTokenAmount, vault.decimals)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : undefined,
      action: "Deposit as Collateral" as const,
      protocol: "Curve LlamaLend",
    },
    ...(debtAmount > 0n ? [{
      tokenSymbol: "crvUSD",
      amount: Number(formatUnits(debtAmount, 18)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      action: "Borrow" as const,
      protocol: "Curve LlamaLend",
    }] : []),
  ], [vault.symbol, vault.decimals, estimatedVaultTokenAmount, debtAmount]);

  // Lock route display during settling — avoid showing partial/mismatched values
  // Initialize empty so the route panel doesn't open until all data is ready
  const [settledRouteSteps, setSettledRouteSteps] = useState<typeof routeSteps>([]);
  const anySettling = isQuoteSettling;

  // Report settling state to parent (for health bar animation)
  const prevSettling = useRef(false);
  useEffect(() => {
    if (anySettling !== prevSettling.current) {
      prevSettling.current = anySettling;
      onSettlingChange?.(anySettling);
    }
  }, [anySettling, onSettlingChange]);

  useEffect(() => {
    if (anySettling || routeSteps.length === 0) return;
    const timer = setTimeout(() => {
      setSettledRouteSteps(routeSteps);
    }, 0);
    return () => clearTimeout(timer);
  }, [anySettling, routeSteps]);
  // During settling: show previous settled route (or nothing if no previous)
  const displayRouteSteps = anySettling
    ? settledRouteSteps
    : routeSteps;

  // Estimate health — skip during settling to avoid stale intermediate values
  useEffect(() => {
    if (isQuoteSettling) {
      // Don't clear estimatedHealth here — healthToReport returns undefined during settling
      // so the parent keeps the old value. Clearing would cause a "—" flash when settling ends
      // before the async health_calculator call completes.
      return;
    }
    let cancelled = false;
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
            BigInt(debouncedBands),
          ],
        });

        if (!cancelled) {
          const h = Number(health) / 1e16;
          if (process.env.NODE_ENV === "development") console.log("[NewLoan] health_calculator:", { health: h.toFixed(2) + "%", collateral: estimatedVaultTokenAmount.toString(), debt: debtAmount.toString(), bands: debouncedBands });
          setEstimatedHealth(h);
        }
      } catch (err) {
        if (!cancelled) {
          if (process.env.NODE_ENV === "development") console.log("[NewLoan] health_calculator error:", err);
          setEstimatedHealth(null);
        }
      }
    }

    calcHealth();
    return () => { cancelled = true; };
  }, [publicClient, address, controllerAddress, estimatedVaultTokenAmount, debtAmount, debouncedBands, isQuoteSettling]);

  // Report estimated health to parent (null if exceeds max borrowable)
  const exceedsBorrow = debtAmount > 0n && maxBorrowableLoaded && maxBorrowable > 0n && debtAmount > maxBorrowable;
  // When input is cleared, bypass settling guard so position preview fades out immediately
  const inputCleared = !amount || Number(amount) <= 0;
  const healthToReport = inputCleared ? null : isQuoteSettling ? undefined : (exceedsBorrow ? null : estimatedHealth);
  const prevHealthReport = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (healthToReport === undefined) return; // settling — keep parent's old value
    if (healthToReport === prevHealthReport.current) return;
    prevHealthReport.current = healthToReport;
    onEstimatedHealthChange?.(healthToReport);
  }, [healthToReport, onEstimatedHealthChange]);

  // Report collateral amount to parent (for position summary display)
  // undefined = settling (parent keeps old value), null = no collateral, bigint = value
  const collateralToReport = useMemo((): bigint | null | undefined => {
    if (inputCleared) return null; // input cleared — fade out position preview immediately
    if (isQuoteSettling) return undefined; // settling — keep parent's old value
    if (!estimatedVaultTokenAmount) return null;
    return estimatedVaultTokenAmount;
  }, [inputCleared, isQuoteSettling, estimatedVaultTokenAmount]);

  const prevCollateralReport = useRef<bigint | null>(null);
  useEffect(() => {
    if (collateralToReport === undefined) return; // settling — keep parent's old value
    if (collateralToReport === prevCollateralReport.current) return;
    prevCollateralReport.current = collateralToReport;
    onCollateralAmountChange?.(collateralToReport);
  }, [collateralToReport, onCollateralAmountChange]);

  // Report estimated leverage to parent
  // leverage = collateralValue / (collateralValue - debt)
  // undefined = settling (parent keeps old value), null = no leverage, number = value
  const leverageToReport = useMemo((): number | null | undefined => {
    if (inputCleared) return null; // input cleared — fade out immediately
    if (isQuoteSettling) return undefined; // settling — keep parent's old value
    if (!collateralToReport || collateralToReport === undefined || debtAmount === 0n || !oraclePrice || oraclePrice === 0n) return null;
    const collValue = Number(formatUnits(collateralToReport * oraclePrice / (10n ** BigInt(vault.decimals)), 18));
    const debt = Number(formatUnits(debtAmount, 18));
    if (collValue <= 0 || collValue <= debt) return null;
    const lev = collValue / (collValue - debt);
    return lev > 1.005 ? lev : null;
  }, [inputCleared, isQuoteSettling, collateralToReport, debtAmount, oraclePrice, vault.decimals]);

  const prevLeverageReport = useRef<number | null>(null);
  useEffect(() => {
    if (leverageToReport === undefined) return; // settling — keep parent's old value
    if (leverageToReport === prevLeverageReport.current) return;
    prevLeverageReport.current = leverageToReport;
    onEstimatedLeverageChange?.(leverageToReport);
  }, [leverageToReport, onEstimatedLeverageChange]);

  // Report debt delta to parent (for projected borrow APR calculation)
  // undefined = settling (parent keeps old value), null = no debt, bigint = value
  const debtDeltaToReport = useMemo((): bigint | null | undefined => {
    if (inputCleared) return null; // input cleared — fade out immediately
    if (isQuoteSettling) return undefined; // settling — keep parent's old value
    if (debtAmount === 0n) return null;
    return debtAmount;
  }, [inputCleared, isQuoteSettling, debtAmount]);

  const prevDebtDeltaReport = useRef<bigint | null>(null);
  useEffect(() => {
    if (debtDeltaToReport === undefined) return; // settling — keep parent's old value
    if (debtDeltaToReport === prevDebtDeltaReport.current) return;
    prevDebtDeltaReport.current = debtDeltaToReport;
    onDebtDeltaChange?.(debtDeltaToReport);
  }, [debtDeltaToReport, onDebtDeltaChange]);

  // Report tx state to parent for full-screen overlay
  useEffect(() => {
    const isPending = isLendingTxPendingVisible(status);
    if (isPending || ((status === "success" || status === "reverted") && txHash)) {
      const details = amount && Number(amount) > 0 && debtAmount > 0n ? {
        fromAmount: amount,
        fromSymbol: vaultToken.symbol,
        fromLogo: vaultToken.logoURI || "/tokens/unknown.png",
        toAmount: Number(formatUnits(debtAmount, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }),
        toSymbol: "crvUSD",
        toLogo: "/tokens/crvusd.png",
      } : undefined;
      const mapped = isPending ? "pending" : status;
      onTxStateChange?.({ status: mapped as "pending" | "success" | "reverted", action: "Create Loan", hash: txHash, details });
    }
  }, [status, txHash, onTxStateChange, amount, vaultToken, debtAmount]);

  async function fetchEthPrice() {
    if (!publicClient) return;
    try {
      const data = await publicClient.readContract({
        address: CHAINLINK_ETH_USD,
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
  }

  // Handle transaction success — clear all inputs and reset to idle
  useEffect(() => {
    if (status === "success" && txHash) {
      trackLendingBorrowSuccess(vault.id, debtInput || "0", "crvUSD");
      const timer = setTimeout(() => {
        setAmountState("");
        setDebtInputState("");
        debtRatio.current = null;
      }, 0);
      try { sessionStorage.removeItem(amountStorageKey); } catch { /* */ }
      try { sessionStorage.removeItem(debtStorageKey); } catch { /* */ }
      toast.success("Loan created!", {
        action: {
          label: "View Tx",
          onClick: () => window.open(`https://etherscan.io/tx/${txHash}`, "_blank"),
        },
      });
      onTransactionSuccess();
      reset();
      return () => clearTimeout(timer);
    }
  }, [status, txHash, onTransactionSuccess, reset, amountStorageKey, debtStorageKey, vault.id, debtInput]);

  useEffect(() => {
    if ((status === "error" || status === "reverted") && error) {
      if (isUserRejection(error)) {
        trackTransactionCancelled("borrow", vault.id);
        toast("Transaction cancelled", { id: "new-loan-cancelled", duration: 3000 });
        clearError();
      } else {
        trackTransactionError("borrow", vault.id, typeof error === "string" ? error : error, categorizeError(error));
        toast.error(error);
        reset();
      }
    }
  }, [status, error, reset, clearError, vault.id]);

  // Handle approval success
  useEffect(() => {
    if (isApprovalSuccess && status === "approving") {
      const wasPreview = wasApprovalRequested();
      executeAfterApproval().then(() => {
        if (wasPreview) {
          simulationBlock.current = currentBlock ?? 0n;
          setShowSimulationModal(true);
          fetchEthPrice();
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isApprovalSuccess, status]);

  // Reset stale approval state when user changes inputs
  useEffect(() => {
    if (status === "needsApproval") {
      reset();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, debtInput]);

  const handleSubmit = async () => {
    if (!address || !controllerAddress || !amount || Number(amount) <= 0 || debtAmount === 0n) return;

    trackLendingBorrowInitiated(vault.id, debtInput || "0", "crvUSD");

    const preview = showSimulationPreview;

    // Show simulation modal if preview result is available; returns true to bail from handleSubmit
    const openModalIfPreview = (result: unknown): boolean => {
      if (preview) {
        if (result) {
          simulationBlock.current = currentBlock ?? 0n;
          setShowSimulationModal(true);
          fetchEthPrice();
          return true;
        }
        // No simulation data (e.g. Anvil/test network) — fall through to execute directly
        return false;
      }
      return false;
    };

    try {
      // Direct controller create_loan
      if (process.env.NODE_ENV === "development") console.log("[NewLoan] Submit: create_loan (direct)", { collateral: amount, debt: debtAmount.toString(), bands });
      if (preview) {
        const result = await createLoan(vault.address as `0x${string}`, amount, debtAmount.toString(), bands, { previewOnly: true, tokenSymbol: vault.symbol });
        if (openModalIfPreview(result)) return;
        if (wasApprovalRequested()) return;
      }
      await createLoan(vault.address as `0x${string}`, amount, debtAmount.toString(), bands, { tokenSymbol: vault.symbol });
    } catch (err) {
      console.error("Create loan failed:", err);
    }
  };

  const handleExecute = async () => {
    try {
      await executeAfterPreview();
    } catch (err) {
      console.error("Loan execution failed:", err);
    }
  };

  // Validation
  const hasInsufficientBalance = useMemo(() => {
    if (!amount || Number(amount) === 0) return false;
    try {
      const amountWei = parseUnits(amount, vault.decimals);
      return amountWei > currentTokenBalance;
    } catch {
      return false;
    }
  }, [amount, vault.decimals, currentTokenBalance]);

  const exceedsMaxBorrowable = useMemo(() => {
    if (debtAmount === 0n || maxBorrowable === 0n || !maxBorrowableLoaded) return false;
    return debtAmount > maxBorrowable;
  }, [debtAmount, maxBorrowable, maxBorrowableLoaded]);

  const isProcessing =
    status !== "idle" &&
    status !== "success" &&
    status !== "error" &&
    status !== "reverted" &&
    status !== "needsApproval";

  const isFormValid =
    !!amount &&
    Number(amount) > 0 &&
    debtAmount > 0n &&
    !hasInsufficientBalance &&
    !exceedsMaxBorrowable &&
    !isQuoteSettling;

  const getButtonText = () => {
    if (status === "building") return <>Building transaction<LoadingDots /></>;
    if (status === "simulating") return <>Simulating<LoadingDots /></>;
    if (status === "executing") return <>Confirm in wallet<LoadingDots /></>;
    if (status === "waitingTx") return <>Waiting for confirmation<LoadingDots /></>;
    if (hasInsufficientBalance) return "Insufficient balance";
    if (!amount || Number(amount) <= 0) return "Enter amount";
    if (!debtInput || Number(debtInput) <= 0) return "Enter amount";
    if (maxBorrowableFetching || isQuoteSettling) return <><span>Getting quote</span><LoadingDots /></>;
    if (exceedsMaxBorrowable) return "Exceeds max borrowable";
    return "Create Loan";
  };

  return (
    <div className="space-y-4">
      {/* Collateral Input */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-[var(--muted-foreground)]">
            Collateral
          </label>
          <span className="text-xs text-[var(--muted-foreground)]">
            Balance: {formattedBalance}
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
            selectedToken={vaultToken}
            onSelect={() => {}}
            priorityTokens={[vaultToken]}
            excludeDefiTokens
            disabled
          />
          <MaxButton
            balance={maxBalance}
            onSelect={setAmount}
          />
        </div>
      </div>

      {/* Debt Input */}
      <div className={cn((!amount || Number(amount) <= 0) && "opacity-50 pointer-events-none")}>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-[var(--muted-foreground)]">
            Borrow Amount
          </label>
          <span className="text-xs text-[var(--muted-foreground)]">
            Max: {maxBorrowable > 0n ? Number(formatUnits(maxBorrowable, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"} crvUSD
          </span>
        </div>
        <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
          <input
            type="text"
            value={debtInput}
            onChange={(e) => setDebtInput(e.target.value)}
            placeholder="0.0"
            className="flex-1 min-w-0 bg-transparent mono text-sm outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
          />
          <TokenSelector
            selectedToken={crvUsdToken}
            onSelect={() => {}}
            disabled
          />
          {maxBorrowable > 0n ? (
            <MaxButton
              balance={formatUnits(maxBorrowable, 18)}
              onSelect={setDebtInput}
            />
          ) : maxBorrowableFetching ? (
            <MaxButtonSkeleton />
          ) : (
            <MaxButton balance="0" onSelect={setDebtInput} />
          )}
        </div>
      </div>

      {/* Bands Selector */}
      <div className={cn((!amount || Number(amount) <= 0 || debtAmount === 0n) && "opacity-50 pointer-events-none")}>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-[var(--muted-foreground)]">
            Bands
            {bands <= 4 && <span className="text-red-500"> · Max LTV</span>}
            {bands > 4 && bands <= 10 && <span className="text-amber-500"> · Default</span>}
            {bands >= 50 && <span className="text-green-500"> · Safe</span>}
          </label>
          <span className="text-sm mono">{bands}</span>
        </div>
        <div className="relative">
          <input
            type="range"
            min={4}
            max={50}
            value={bands}
            onChange={(e) => setBands(Number(e.target.value))}
            className="w-full relative z-10"
          />
          {/* Notch ticks */}
          <div className="relative h-3 -mt-[10px] pointer-events-none">
            {[4, 10, 50].map((value) => {
              const pct = ((value - 4) / (50 - 4)) * 100;
              return (
                <div
                  key={value}
                  className="absolute -translate-x-1/2 w-1 h-3 rounded-b-full"
                  style={{ left: `calc(8px + (100% - 16px) * ${pct / 100})`, background: "#27272a" }}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Low liquidity warning — keep visible during settling to avoid flicker */}
      {isLiquidityConstrained && controllerCrvUsdBalance && (maxBorrowable > 0n || isQuoteSettling) && (debtAmount > 0n || isQuoteSettling) && (
        <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500 text-xs flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0" />
          <span>
            Only {Number(formatUnits(controllerCrvUsdBalance, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })} crvUSD available in lending market. Max borrow is limited by pool liquidity, not your collateral.
          </span>
        </div>
      )}

      {/* Approval Flow */}
      <ApprovalCard
        show={showApprovalCard}
        pendingApproval={pendingApproval}
        approvalProgress={approvalProgress}
        isApproving={isApproving}
        onApprove={(exact) => approve(exact)}
      />

      {/* Simulation Modal */}
      {showSimulationModal && simulationResult && (() => {
        // Filter asset changes to show net result, hiding intermediates:
        // - "borrow" → always (crvUSD debt created)
        // - "deposit" → always (collateral added to loan / AMM)
        // - "send" → only if symbol isn't in borrow/receive/deposit (net wallet outflow)
        // - "receive" → only if symbol isn't in send/deposit/borrow (net wallet inflow)
        const changes = simulationResult.assetChanges ?? [];
        const symSet = (type: string) => new Set(
          changes.filter((c) => c.type === type).map((c) => c.symbol.toLowerCase())
        );
        const borrowSyms = symSet("borrow");
        const sendSyms = symSet("send");
        const receiveSyms = symSet("receive");
        const depositSyms = symSet("deposit");
        const filteredChanges = changes.filter((c) => {
          const s = c.symbol.toLowerCase();
          if (c.type === "borrow" || c.type === "deposit") return true;
          if (c.type === "send") return !borrowSyms.has(s) && !receiveSyms.has(s) && !depositSyms.has(s);
          if (c.type === "receive") return !sendSyms.has(s) && !depositSyms.has(s) && !borrowSyms.has(s);
          return true;
        });

        return (
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
            simulationResult={{
              ...simulationResult,
              assetChanges: filteredChanges,
            }}
            gasPrice={gasPrice}
            ethPrice={ethPrice}
            confirmText="Confirm & Execute"
            swapTitle="Swap & Deposit as Collateral"
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
                setShowSimulationModal(true);
              } else {
                handleSubmit();
              }
            }}
            disabled={showApprovalCard || isProcessing || (!isFormValid && status === "idle")}
            className={cn(
              "w-full py-3 px-4 rounded-lg font-medium transition-colors flex items-center justify-center gap-2",
              isProcessing || (!isFormValid && status === "idle")
                ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
            )}
          >
            {getButtonText()}
          </button>
        </div>
      </div>

      {/* Settings */}
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

      {/* Route details panel */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{
          gridTemplateRows:
            showRoute && amount && Number(amount) > 0 && debtAmount > 0n && displayRouteSteps.length > 1 ? "1fr" : "0fr",
        }}
      >
        <div className="overflow-hidden">
          <div className="pt-3 mt-3 border-t border-[var(--border)]">
            <div className="text-xs text-[var(--muted-foreground)] mb-2">Route</div>
            <RouteDisplay
              routeInfo={{ steps: displayRouteSteps }}
              isLoading={anySettling}
              completionMessage="Loan created on Curve LlamaLend"
            />
          </div>
        </div>
      </div>

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
          refreshSimulationPreview();
        }}
        slippage={slippage}
        onSlippageChange={updateSlippage}
      />
    </div>
  );
}
