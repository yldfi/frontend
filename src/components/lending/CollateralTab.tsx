"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { SlippageModal } from "@/components/SlippageModal";
import { SimulationModal } from "@/components/SimulationModal";
import { toast } from "sonner";
import {
  isUserRejection,
  trackLendingCollateralAddInitiated,
  trackLendingCollateralAddSuccess,
  trackTransactionError,
  trackTransactionCancelled,
  categorizeError,
} from "@/lib/analytics";
import {
  AlertTriangle,
  Plus,
  Minus,
} from "lucide-react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { useAccount, usePublicClient, useGasPrice, useBlockNumber } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import type { VaultConfig } from "@/config/vaults";
import type { LendingPosition } from "@/hooks/useCurveLendingPosition";
import { useCurveLendingActions } from "@/hooks/useCurveLendingActions";
import { TokenSelector } from "@/components/TokenSelector";
import { MaxButton } from "@/components/MaxButton";
import { cn } from "@/lib/utils";
import { LoadingDots } from "@/components/LoadingDots";
import { sanitizeAmount } from "@/lib/sanitize";
import { useSettings } from "@/hooks/useSettings";
import { CHAINLINK_ETH_USD } from "@/config/addresses";
import type { EnsoToken } from "@/types/enso";
import { CONTROLLER_ABI } from "@/lib/abis";
import { isLendingTxPendingVisible } from "@/lib/transaction-ui";

type CollateralMode = "add" | "remove";

interface CollateralTabProps {
  vault: VaultConfig;
  userBalance: string; // Vault token balance in wei
  position: LendingPosition | null;
  controllerAddress: `0x${string}`;
  onTransactionSuccess: () => void;
  onEstimatedHealthChange?: (health: number | null) => void;
  onCollateralDeltaChange?: (delta: bigint | null) => void;
  onTxStateChange?: (state: { status: "pending" | "success" | "reverted"; action: string; hash?: string | null; details?: { fromAmount: string; fromSymbol: string; fromLogo: string; toAmount: string; toSymbol: string; toLogo: string; message?: string } } | null) => void;
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

  // Collateral is always the vault token
  const vaultToken: EnsoToken = useMemo(() => ({
    address: vault.address,
    chainId: 1,
    name: vault.name,
    symbol: vault.symbol,
    decimals: vault.decimals,
    logoURI: vault.logoSmall,
    type: "defi" as const,
  }), [vault]);

  // Form state — persisted across refresh
  const storageKey = `yldfi-lending-collateral-${vault.address}`;
  const [amount, setAmountState] = useState(() => {
    if (typeof window === "undefined") return "";
    try { return sanitizeAmount(sessionStorage.getItem(storageKey) ?? ""); } catch { return ""; }
  });
  const setAmount = useCallback((v: string) => {
    const sanitized = sanitizeAmount(v);
    setAmountState(sanitized);
    try {
      if (sanitized) sessionStorage.setItem(storageKey, sanitized);
      else sessionStorage.removeItem(storageKey);
    } catch { /* */ }
  }, [storageKey]);

  const {
    slippage, updateSlippage, showSlippageModal, setShowSlippageModal,
    showSimulationPreview, refreshSimulationPreview,
    showSimulationModal, setShowSimulationModal,
  } = useSettings();

  // Health estimation
  const [estimatedHealth, setEstimatedHealth] = useState<number | null>(null);
  const [ethPrice, setEthPrice] = useState<number | null>(null);
  const { data: gasPrice } = useGasPrice();
  const { data: currentBlock } = useBlockNumber({ watch: true });
  const simulationBlock = useRef<bigint>(0n);


  // Lending actions
  const {
    addCollateral,
    removeCollateral,
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

  // Max balance for add mode
  const addMaxBalance = useMemo(
    () => formatUnits(BigInt(userBalance), vault.decimals),
    [userBalance, vault.decimals]
  );

  // Max balance for remove mode (max withdrawable without breaking health)
  const removeMaxBalance = useMemo(() => {
    if (!position?.hasLoan) return "0";
    return formatUnits(position.maxWithdrawable, vault.decimals);
  }, [position, vault.decimals]);

  const maxBalance = mode === "add" ? addMaxBalance : removeMaxBalance;
  const currentTokenBalance = BigInt(userBalance);

  const formattedBalance = useMemo(() => {
    const value = parseFloat(maxBalance) || 0;
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }, [maxBalance]);

  // Vault token amount (for health calculation)
  const estimatedVaultTokenAmount = useMemo(() => {
    if (!amount || Number(amount) <= 0) return null;
    try {
      return parseUnits(amount, vault.decimals);
    } catch {
      return null;
    }
  }, [amount, vault.decimals]);

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
    const isPending = isLendingTxPendingVisible(status);
    if (isPending || ((status === "success" || status === "reverted") && txHash)) {
      const action = mode === "add" ? "Add Collateral" : "Remove Collateral";
      const details = amount && Number(amount) > 0 ? (mode === "add" ? {
        fromAmount: amount,
        fromSymbol: vaultToken.symbol,
        fromLogo: vaultToken.logoURI || "/tokens/unknown.png",
        toAmount: amount,
        toSymbol: vault.symbol,
        toLogo: vault.logo,
      } : {
        fromAmount: amount,
        fromSymbol: vault.symbol,
        fromLogo: vault.logo,
        toAmount: amount,
        toSymbol: vaultToken.symbol,
        toLogo: vaultToken.logoURI || "/tokens/unknown.png",
      }) : undefined;
      const mapped = isPending ? "pending" : status;
      onTxStateChange?.({ status: mapped as "pending" | "success" | "reverted", action, hash: txHash, details });
    }
  }, [status, txHash, mode, onTxStateChange, amount, vaultToken, vault]);

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
  }, [amount, mode]);

  // Handle transaction success — clear all inputs and reset to idle
  useEffect(() => {
    if (status === "success" && txHash) {
      if (mode === "add") {
        trackLendingCollateralAddSuccess(vault.id, amount, vaultToken.symbol);
      }
      const timer = setTimeout(() => {
        setAmountState("");
      }, 0);
      try { sessionStorage.removeItem(storageKey); } catch { /* */ }
      toast.success(mode === "add" ? "Collateral added!" : "Collateral removed!", {
        action: {
          label: "View Tx",
          onClick: () => window.open(`https://etherscan.io/tx/${txHash}`, "_blank"),
        },
      });
      onTransactionSuccess();
      reset();
      return () => clearTimeout(timer);
    }
  }, [status, txHash, mode, onTransactionSuccess, reset, storageKey, vault.id, amount, vaultToken.symbol]);

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

  useEffect(() => {
    if ((status === "error" || status === "reverted") && error) {
      if (isUserRejection(error)) {
        trackTransactionCancelled("collateral", vault.id);
        toast("Transaction cancelled", { id: "collateral-cancelled", duration: 3000 });
        clearError();
      } else {
        trackTransactionError("collateral", vault.id, typeof error === "string" ? error : error, categorizeError(error));
        toast.error(error);
        reset();
      }
    }
  }, [status, error, reset, clearError, vault.id]);

  // Handle approval success -> continue execution
  useEffect(() => {
    if (isApprovalSuccess && status === "approving") {
      const wasPreview = wasApprovalRequested();
      executeAfterApproval().then(() => {
        // If the original call was previewOnly, the simulation result is now set — open the modal
        if (wasPreview) {
          simulationBlock.current = currentBlock ?? 0n;
          setShowSimulationModal(true);
          fetchEthPrice();
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isApprovalSuccess, status]);

  // Clear amount and reset when switching mode
  useEffect(() => {
    const timer = setTimeout(() => {
      setAmountState("");
      reset();
    }, 0);
    return () => clearTimeout(timer);
  }, [mode, reset]);

  const handleSubmit = async () => {
    if (!address || !controllerAddress || !amount || Number(amount) <= 0) return;

    if (mode === "add") {
      trackLendingCollateralAddInitiated(vault.id, amount, vaultToken.symbol);
    }

    try {
      if (mode === "add") {
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
          // Approval needed — approval card will handle it, auto-execute after approval
          if (wasApprovalRequested()) return;
          // No simulation data (e.g. Anvil) — fall through to execute
        }
        await addCollateral(
          vault.address as `0x${string}`,
          amount,
          { tokenSymbol: vault.symbol }
        );
      } else {
        // Remove mode
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
          // Approval needed — approval card will handle it, auto-execute after approval
          if (wasApprovalRequested()) return;
          // No simulation data (e.g. Anvil) — fall through to execute
        }
        await removeCollateral(
          vault.address as `0x${string}`,
          amount,
        );
      }
    } catch (err) {
      console.error("Collateral action failed:", err);
    }
  };

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
      const amountWei = parseUnits(amount, vault.decimals);
      return amountWei > currentTokenBalance;
    } catch {
      return false;
    }
  }, [mode, amount, vault.decimals, currentTokenBalance]);

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
    !healthTooLow;

  const getButtonText = () => {
    if (status === "building") return <>Building transaction<LoadingDots /></>;
    if (status === "simulating") return <>Simulating<LoadingDots /></>;
    if (status === "executing") return <>Confirm in wallet<LoadingDots /></>;
    if (status === "waitingTx") return <>Waiting for confirmation<LoadingDots /></>;
    if (hasInsufficientBalance) return "Insufficient balance";
    if (exceedsCollateral) return "Exceeds collateral";
    if (healthTooLow) return "Position would be unhealthy";

    return mode === "add" ? "Add Collateral" : "Remove Collateral";
  };

  if (position?.inSoftLiquidation) {
    return (
      <div className="py-6 px-2 space-y-2 text-center">
        <AlertTriangle size={20} className="mx-auto text-yellow-500" />
        <div className="text-sm font-medium text-[var(--foreground)]">Collateral management unavailable</div>
        <div className="text-xs text-[var(--muted-foreground)]">
          Your position is in soft-liquidation.{onSwitchTab ? (<> Use <button type="button" onClick={() => onSwitchTab("repay")} className="underline hover:text-[var(--foreground)] transition-colors">Repay</button> to reduce debt or <button type="button" onClick={() => onSwitchTab("liquidate")} className="underline hover:text-[var(--foreground)] transition-colors">Liquidate</button> to close your position.</>) : " Repay debt or close your position."}
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
            selectedToken={vaultToken}
            onSelect={() => {}}
            priorityTokens={[vaultToken]}
            excludeDefiTokens={mode === "add"}
            disabled
          />
          <MaxButton
            balance={maxBalance}
            onSelect={setAmount}
          />
        </div>
      </div>

      {/* Approval Flow */}
      <ApprovalCard
        show={showApprovalCard}
        pendingApproval={pendingApproval}
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
              } else {
                handleSubmit();
              }
            }}
            disabled={showApprovalCard || isProcessing || (!isFormValid && status === "idle")}
            className={cn(
              "w-full py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
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
          refreshSimulationPreview();
        }}
        slippage={slippage}
        onSlippageChange={updateSlippage}
      />
    </div>
  );
}
