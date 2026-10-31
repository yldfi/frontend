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
import {
  AlertTriangle,
  Plus,
  X,
} from "lucide-react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { useAccount, usePublicClient, useGasPrice, useBlockNumber } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { useQuery } from "@tanstack/react-query";
import type { VaultConfig } from "@/config/vaults";
import type { LendingPosition } from "@/hooks/useCurveLendingPosition";
import { useCurveLendingActions } from "@/hooks/useCurveLendingActions";
import { TokenSelector } from "@/components/TokenSelector";
import { MaxButton } from "@/components/MaxButton";
import { cn } from "@/lib/utils";
import { LoadingDots } from "@/components/LoadingDots";
import { sanitizeAmount } from "@/lib/sanitize";
import { useSettings } from "@/hooks/useSettings";
import { CHAINLINK_ETH_USD, CRVUSD_ADDRESS } from "@/config/addresses";
import type { EnsoToken } from "@/types/enso";
import { CONTROLLER_ABI, ERC20_BALANCE_ABI } from "@/lib/abis";
import { CRVUSD_TOKEN } from "@/config/tokens";
import { isLendingTxPendingVisible } from "@/lib/transaction-ui";

interface BorrowTabProps {
  vault: VaultConfig;
  position: LendingPosition | null;
  controllerAddress: `0x${string}`;
  userBalance: string; // Vault token balance in wei
  onTransactionSuccess: () => void;
  onEstimatedHealthChange?: (health: number | null) => void;
  onDebtDeltaChange?: (delta: bigint | null) => void;
  onCollateralDeltaChange?: (delta: bigint | null) => void;
  onTxStateChange?: (state: { status: "pending" | "success" | "reverted"; action: string; hash?: string | null; details?: { fromAmount: string; fromSymbol: string; fromLogo: string; toAmount: string; toSymbol: string; toLogo: string; message?: string } } | null) => void;
  onSwitchTab?: (tab: string) => void;
}

export function BorrowTab({
  vault,
  position,
  controllerAddress,
  userBalance,
  onTransactionSuccess,
  onEstimatedHealthChange,
  onDebtDeltaChange,
  onCollateralDeltaChange,
  onTxStateChange,
  onSwitchTab,
}: BorrowTabProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  // Optional collateral addition (vault token only)
  const vaultToken: EnsoToken = useMemo(() => ({
    address: vault.address,
    chainId: 1,
    name: vault.name,
    symbol: vault.symbol,
    decimals: vault.decimals,
    logoURI: vault.logoSmall,
    type: "defi" as const,
  }), [vault]);

  const [showCollateralInput, setShowCollateralInput] = useState(false);
  const collateralStorageKey = `yldfi-lending-borrow-collateral-${vault.address}`;
  const [collateralAmount, setCollateralAmountState] = useState("");
  const setCollateralAmount = useCallback(
    (v: string) => {
      const sanitized = sanitizeAmount(v);
      setCollateralAmountState(sanitized);
      try {
        if (sanitized) sessionStorage.setItem(collateralStorageKey, sanitized);
        else sessionStorage.removeItem(collateralStorageKey);
      } catch { /* */ }
    },
    [collateralStorageKey]
  );

  const userBalanceBn = (() => {
    try { return BigInt(userBalance); } catch { return 0n; }
  })();

  // Collateral to add (for health calc + maxBorrowable)
  const collateralWei = (() => {
    if (!showCollateralInput || !collateralAmount || Number(collateralAmount) <= 0) return 0n;
    try { return parseUnits(collateralAmount, vault.decimals); } catch { return 0n; }
  })();

  const formattedCollateralBalance = useMemo(() => {
    try {
      return Number(formatUnits(userBalanceBn, vault.decimals))
        .toLocaleString(undefined, { maximumFractionDigits: 4 });
    } catch { return "0"; }
  }, [userBalanceBn, vault.decimals]);

  const hasInsufficientCollateral = useMemo(() => {
    if (!showCollateralInput || !collateralAmount || Number(collateralAmount) <= 0) return false;
    try {
      const inputWei = parseUnits(collateralAmount, vault.decimals);
      return inputWei > userBalanceBn;
    } catch { return false; }
  }, [showCollateralInput, collateralAmount, vault.decimals, userBalanceBn]);

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
        const totalCollateral = position.collateral + collateralWei;
        const maxTotal = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "max_borrowable",
          args: [totalCollateral, N, position.debt],
        });
        const additional = maxTotal > position.debt ? maxTotal - position.debt : 0n;
        setMaxBorrowable(additional);
      } catch {
        setMaxBorrowable(null);
      }
    }

    calculateMaxBorrowable();
  }, [publicClient, controllerAddress, position, collateralWei]);

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

  const isLiquidityConstrained = useMemo(() => {
    if (!controllerCrvUsdBalance || !maxBorrowable || maxBorrowable === 0n) return false;
    // If max borrowable is within 5% of controller balance, liquidity is the bottleneck
    const threshold = controllerCrvUsdBalance * 105n / 100n;
    return maxBorrowable <= threshold;
  }, [controllerCrvUsdBalance, maxBorrowable]);

  // Form state — amount of crvUSD debt to create.
  // Starts empty on mount (the stored value is not restored).
  const borrowStorageKey = `yldfi-lending-borrow-amount-${vault.address}`;
  const [borrowAmount, setBorrowAmountState] = useState("");
  const setBorrowAmount = useCallback(
    (v: string) => {
      const sanitized = sanitizeAmount(v);
      setBorrowAmountState(sanitized);
      try {
        if (sanitized) sessionStorage.setItem(borrowStorageKey, sanitized);
        else sessionStorage.removeItem(borrowStorageKey);
      } catch { /* */ }
    },
    [borrowStorageKey]
  );

  const {
    slippage, updateSlippage, showSlippageModal, setShowSlippageModal,
    showSimulationPreview, refreshSimulationPreview,
    showSimulationModal, setShowSimulationModal,
  } = useSettings();

  // Health estimation
  const [estimatedHealth, setEstimatedHealth] = useState<number | null>(null);
  const [debtTooHigh, setDebtTooHigh] = useState(false);


  // Lending actions
  const {
    borrowMore,
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
  }, [borrowAmount, collateralAmount]);

  // Toast notifications
  useEffect(() => {
    if (status === "success" && txHash) {
      trackLendingBorrowSuccess(vault.id, borrowAmount, CRVUSD_TOKEN.symbol);
      toast.success("Borrow successful!", {
        action: {
          label: "View Tx",
          onClick: () => window.open(`https://etherscan.io/tx/${txHash}`, "_blank"),
        },
      });
      onTransactionSuccess();
    }
  }, [status, txHash, onTransactionSuccess, vault.id, borrowAmount]);

  useEffect(() => {
    if ((status === "error" || status === "reverted") && error) {
      if (isUserRejection(error)) {
        trackTransactionCancelled("borrow", vault.id);
        // Wallet rejection: show toast, clear error but keep simulation cached
        toast("Transaction cancelled", { id: "borrow-cancelled", duration: 3000 });
        clearError();
      } else {
        trackTransactionError("borrow", vault.id, typeof error === "string" ? error : error, categorizeError(error));
        toast.error(error);
        reset();
      }
    }
  }, [status, error, reset, clearError, vault.id]);

  // crvUSD debt amount (wei)
  const estimatedCrvUsdBorrow = useMemo(() => {
    if (!borrowAmount || Number(borrowAmount) <= 0) return null;
    try {
      return parseUnits(borrowAmount, 18);
    } catch {
      return null;
    }
  }, [borrowAmount]);

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
          args: [address, collateralWei, estimatedCrvUsdBorrow, true, 0n],
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
  }, [publicClient, controllerAddress, address, position, estimatedCrvUsdBorrow, collateralWei]);

  // Report estimated health to parent
  useEffect(() => {
    onEstimatedHealthChange?.(estimatedHealth);
  }, [estimatedHealth, onEstimatedHealthChange]);

  // Report debt delta to parent (positive = borrowing more)
  useEffect(() => {
    onDebtDeltaChange?.(estimatedCrvUsdBorrow ?? null);
  }, [estimatedCrvUsdBorrow, onDebtDeltaChange]);

  // Report collateral delta to parent (positive = adding collateral)
  useEffect(() => {
    onCollateralDeltaChange?.(collateralWei > 0n ? collateralWei : null);
  }, [collateralWei, onCollateralDeltaChange]);

  // Report tx state to parent for full-screen overlay
  useEffect(() => {
    const isPending = isLendingTxPendingVisible(status);
    if (isPending || ((status === "success" || status === "reverted") && txHash)) {
      let details: { fromAmount: string; fromSymbol: string; fromLogo: string; toAmount: string; toSymbol: string; toLogo: string } | undefined;
      if (estimatedCrvUsdBorrow) {
        // Direct crvUSD borrow: show crvUSD amount only (no arrow needed, but using same shape)
        const amt = Number(formatUnits(estimatedCrvUsdBorrow, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
        details = {
          fromAmount: amt, fromSymbol: "crvUSD", fromLogo: "/tokens/crvusd.png",
          toAmount: amt, toSymbol: "crvUSD", toLogo: "/tokens/crvusd.png",
        };
      }
      const mapped = isPending ? "pending" : status;
      onTxStateChange?.({ status: mapped as "pending" | "success" | "reverted", action: "Borrow", hash: txHash, details });
    }
  }, [status, txHash, onTxStateChange, estimatedCrvUsdBorrow]);

  // Handle transaction success — clear all inputs and reset to idle
  useEffect(() => {
    if (status === "success") {
      const timer = setTimeout(() => {
        setBorrowAmountState("");
        setCollateralAmountState("");
      }, 0);
      try { sessionStorage.removeItem(borrowStorageKey); } catch { /* */ }
      try { sessionStorage.removeItem(collateralStorageKey); } catch { /* */ }
      onTransactionSuccess();
      reset();
      return () => clearTimeout(timer);
    }
  }, [status, onTransactionSuccess, reset, borrowStorageKey, collateralStorageKey]);

  // Handle approval success -> continue execution (queue handles multi-step)
  useEffect(() => {
    if (isApprovalSuccess && status === "approving") {
      const wasPreview = wasApprovalRequested();
      executeAfterApproval().then(() => {
        if (wasPreview) {
          simulationBlock.current = currentBlock ?? 0n;
          setShowSimulationModal(true);
          if (publicClient) {
            publicClient.readContract({
              address: CHAINLINK_ETH_USD,
              abi: [{ name: "latestRoundData", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "roundId", type: "uint80" }, { name: "answer", type: "int256" }, { name: "startedAt", type: "uint256" }, { name: "updatedAt", type: "uint256" }, { name: "answeredInRound", type: "uint80" }] }],
              functionName: "latestRoundData",
            }).then(data => { setEthPrice(Number(data[1] as bigint) / 1e8); }).catch(() => {});
          }
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isApprovalSuccess, status]);

  const handleSubmit = async () => {
    if (!address || !controllerAddress || !borrowAmount || !position?.hasLoan)
      return;

    trackLendingBorrowInitiated(vault.id, borrowAmount, CRVUSD_TOKEN.symbol);

    try {
      // Direct controller.borrow_more()
      const debtWei = parseUnits(borrowAmount, 18).toString();

      const executeBorrow = async (previewOnly: boolean) => {
        const collateral = collateralWei > 0n ? formatUnits(collateralWei, vault.decimals) : "0";
        return borrowMore(vault.address as `0x${string}`, collateral, debtWei, { previewOnly });
      };

      if (showSimulationPreview) {
        const result = await executeBorrow(true);
        if (result) {
          simulationBlock.current = currentBlock ?? 0n;
          setShowSimulationModal(true);
          if (publicClient) {
            publicClient.readContract({
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
            }).then(data => {
              setEthPrice(Number(data[1] as bigint) / 1e8);
            }).catch(() => {});
          }
        }
        if (result) return; // Modal opened — bail
        // Approval needed — approval card will handle it, auto-execute after approval
        if (wasApprovalRequested()) return;
        // No simulation data (e.g. Anvil) — fall through to execute
      }
      await executeBorrow(false);
    } catch (err) {
      console.error("Borrow action failed:", err);
    }
  };

  const handleExecute = async () => {
    try {
      await executeAfterPreview();
    } catch (err) {
      console.error("Borrow execution failed:", err);
    }
  };

  // Validation: amount exceeds max borrowable
  // Use 0.01% tolerance to handle max_borrowable shifting by a few wei between
  // RPC calls (interest accrual, different blocks) after clicking MAX then adding collateral
  const exceedsMax = useMemo(() => {
    if (!estimatedCrvUsdBorrow || maxBorrowable === null) return false;
    const tolerance = maxBorrowable / 10000n; // 0.01%
    return estimatedCrvUsdBorrow > maxBorrowable + tolerance;
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
    !hasInsufficientCollateral;

  const getButtonText = () => {
    if (status === "building") return <>Building transaction<LoadingDots /></>;
    if (status === "simulating") return <>Simulating<LoadingDots /></>;
    if (status === "executing") return <>Confirm in wallet<LoadingDots /></>;
    if (status === "waitingTx") return <>Waiting for confirmation<LoadingDots /></>;
    if (hasInsufficientCollateral) return "Insufficient collateral balance";
    if (debtTooHigh || exceedsMax) return "Exceeds max borrowable";
    return collateralWei > 0n ? "Add Collateral & Borrow" : "Borrow crvUSD";
  };

  if (position?.inSoftLiquidation) {
    return (
      <div className="py-6 px-2 space-y-2 text-center">
        <AlertTriangle size={20} className="mx-auto text-yellow-500" />
        <div className="text-sm font-medium text-[var(--foreground)]">Borrowing unavailable</div>
        <div className="text-xs text-[var(--muted-foreground)]">
          Your position is in soft-liquidation.{onSwitchTab ? (<> Use <button type="button" onClick={() => onSwitchTab("repay")} className="underline hover:text-[var(--foreground)] transition-colors">Repay</button> to reduce debt or <button type="button" onClick={() => onSwitchTab("liquidate")} className="underline hover:text-[var(--foreground)] transition-colors">Liquidate</button> to close or reduce your position.</>) : " Repay debt to resume borrowing."}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Borrow Amount + Token Selector */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-[var(--muted-foreground)]">
            Borrow Amount
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
            selectedToken={CRVUSD_TOKEN}
            onSelect={() => {}}
            disabled
          />
          {maxBorrowable !== null && maxBorrowable > 0n && (
            <MaxButton
              balance={formatUnits(maxBorrowable, 18)}
              onSelect={setBorrowAmount}
            />
          )}
        </div>
      </div>

      {/* Add Collateral toggle + panel */}
      <div>
        <button
          type="button"
          onClick={() => {
            if (showCollateralInput) {
              setCollateralAmountState("");
              try { sessionStorage.removeItem(collateralStorageKey); } catch {}
            }
            setShowCollateralInput(v => !v);
          }}
          className="flex items-center gap-1 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
        >
          {showCollateralInput ? <X size={12} /> : <Plus size={12} />}
          {showCollateralInput ? "Cancel" : "Add collateral"}
        </button>
        <div
          className="grid transition-[grid-template-rows] duration-300 ease-in-out"
          style={{ gridTemplateRows: showCollateralInput ? "1fr" : "0fr" }}
        >
          <div className={showCollateralInput ? "overflow-visible" : "overflow-hidden"}>
            <div className="pt-3 space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm text-[var(--muted-foreground)]">
                    Add Collateral
                  </label>
                  <span className="text-xs text-[var(--muted-foreground)]">
                    Max: {formattedCollateralBalance} {vaultToken.symbol}
                  </span>
                </div>
              <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-inset focus-within:ring-[var(--accent)] transition-shadow">
                <input
                  type="text"
                  value={collateralAmount}
                  onChange={(e) => setCollateralAmount(e.target.value)}
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
                  balance={formatUnits(userBalanceBn, vault.decimals)}
                  onSelect={setCollateralAmount}
                />
              </div>
              </div>
            </div>
          </div>
        </div>
      </div>

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
        // - "send" → only if symbol isn't in borrow/receive/deposit (net wallet outflow, e.g. swap input token)
        // - "receive" → only if symbol isn't in send/deposit/borrow (net wallet inflow, e.g. swap output token)
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
          Connect your wallet to borrow
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
