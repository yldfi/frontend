"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { useAccount, usePublicClient, useGasPrice, useBlockNumber } from "wagmi";
import { SimulationModal } from "@/components/SimulationModal";
import { toast } from "sonner";
import {
  isUserRejection,
  trackLendingSelfLiquidateInitiated,
  trackLendingSelfLiquidateSuccess,
  trackTransactionError,
  trackTransactionCancelled,
  categorizeError,
} from "@/lib/analytics";
import { formatUnits } from "viem";
import type { VaultConfig } from "@/config/vaults";
import type { LendingPosition } from "@/hooks/useCurveLendingPosition";
import { useSelfLiquidation } from "@/hooks/useSelfLiquidation";
import { CRVUSD_ADDRESS, CHAINLINK_ETH_USD } from "@/config/addresses";
import { MaxButton } from "@/components/MaxButton";
import { SlippageModal } from "@/components/SlippageModal";
import { cn } from "@/lib/utils";
import { LoadingDots } from "@/components/LoadingDots";
import { useSettings } from "@/hooks/useSettings";
import { CONTROLLER_ABI } from "@/lib/abis";
import { isLendingTxPendingVisible } from "@/lib/transaction-ui";

interface SelfLiquidateTabProps {
  vault: VaultConfig;
  position: LendingPosition | null;
  controllerAddress: `0x${string}`;
  onTransactionSuccess: () => void;
  onEstimatedHealthChange?: (health: number | null) => void;
  onEstimatedLeverageChange?: (leverage: number | null) => void;
  onDebtDeltaChange?: (delta: bigint | null) => void;
  onCollateralDeltaChange?: (delta: bigint | null) => void;
  onTxStateChange?: (state: { status: "pending" | "success" | "reverted"; action: string; hash?: string | null; details?: { fromAmount: string; fromSymbol: string; fromLogo: string; toAmount: string; toSymbol: string; toLogo: string; message?: string } } | null) => void;
  onSwitchTab?: (tab: string) => void;
}

/**
 * Self-liquidation for positions in soft liquidation (or underwater).
 * The user calls controller.liquidate / liquidate_extended directly
 * (msg.sender == user → no health check, no liquidation discount),
 * covering any crvUSD shortfall from their wallet.
 */
export function SelfLiquidateTab({
  vault,
  position,
  controllerAddress,
  onTransactionSuccess,
  onEstimatedHealthChange,
  onEstimatedLeverageChange,
  onDebtDeltaChange,
  onCollateralDeltaChange,
  onTxStateChange,
  onSwitchTab,
}: SelfLiquidateTabProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  // Underwater confirmation for self-liquidation (user must acknowledge paying gap with no collateral returned)
  const [underwaterConfirmed, setUnderwaterConfirmed] = useState(false);
  const isUnderwater = position?.health !== undefined && position.health <= 0 && position.collateral === 0n;
  // When collateral is fully converted (0), partial liquidation_extended reverts — only full close works
  const forceFullLiquidation = position?.collateral === 0n;

  const [selfLiqPercent, setSelfLiqPercentRaw] = useState(100);
  // Force 100% when collateral fully converted (partial reverts on-chain)
  const effectiveSelfLiqPercent = forceFullLiquidation ? 100 : selfLiqPercent;
  const setSelfLiqPercent = useCallback((v: number) => {
    if (!forceFullLiquidation) setSelfLiqPercentRaw(v);
  }, [forceFullLiquidation]);
  const [canDirectLiquidate, setCanDirectLiquidate] = useState(false);

  const {
    slippage, updateSlippage, showSlippageModal, setShowSlippageModal,
    showSimulationPreview, refreshSimulationPreview,
    showSimulationModal, setShowSimulationModal,
  } = useSettings();
  const simulationBlock = useRef<bigint>(0n);
  const [ethPrice, setEthPrice] = useState<number | null>(null);

  // Block number + gas price for cached simulation re-open
  const { data: currentBlock } = useBlockNumber({ watch: true });
  const { data: gasPrice } = useGasPrice({ query: { refetchInterval: 12_000 } });

  const {
    directLiquidate: directLiquidateAction,
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
  } = useSelfLiquidation();

  const showApprovalCard = !!(pendingApproval && (status === "needsApproval" || status === "approving"));

  // This tab never projects health/leverage/debt/collateral changes
  useEffect(() => {
    onEstimatedHealthChange?.(null);
  }, [onEstimatedHealthChange]);
  useEffect(() => {
    onDebtDeltaChange?.(null);
  }, [onDebtDeltaChange]);
  useEffect(() => {
    onCollateralDeltaChange?.(null);
  }, [onCollateralDeltaChange]);
  useEffect(() => {
    onEstimatedLeverageChange?.(null);
  }, [onEstimatedLeverageChange]);

  // Report tx state to parent for full-screen overlay
  useEffect(() => {
    const isPending = isLendingTxPendingVisible(status);
    if (isPending || ((status === "success" || status === "reverted") && txHash)) {
      const details = {
        fromAmount: `${effectiveSelfLiqPercent}%`,
        fromSymbol: "Position",
        fromLogo: vault.logo,
        toAmount: "crvUSD",
        toSymbol: "recovered",
        toLogo: "/tokens/crvusd.png",
      };
      const mapped = isPending ? "pending" : status;
      onTxStateChange?.({ status: mapped as "pending" | "success" | "reverted", action: "Self Liquidate", hash: txHash, details });
    }
  }, [status, txHash, onTxStateChange, effectiveSelfLiqPercent, vault]);

  // Check crvUSD gap for direct self-liquidation
  // tokens_to_liquidate with account=user → msg.sender=user → health_limit=0, f_remove=frac
  const [crvUsdGap, setCrvUsdGap] = useState(0n);
  const [userCrvUsdBalance, setUserCrvUsdBalance] = useState(0n);
  useEffect(() => {
    if (!publicClient || !address) {
      const timer = setTimeout(() => {
        setCanDirectLiquidate(false);
        setCrvUsdGap(0n);
      }, 0);
      return () => clearTimeout(timer);
    }
    // Reset while fetching to avoid stale enabled state
    const resetTimer = setTimeout(() => {
      setCanDirectLiquidate(false);
    }, 0);
    let stale = false;
    async function check() {
      try {
        const frac = BigInt(effectiveSelfLiqPercent) * 10n ** 16n;
        const [tokensNeeded, crvUsdBal] = await Promise.all([
          publicClient!.readContract({
            address: controllerAddress,
            abi: CONTROLLER_ABI,
            functionName: "tokens_to_liquidate",
            args: [address!, frac],
            account: address!, // msg.sender = user → health_limit=0, no discount
          }),
          publicClient!.readContract({
            address: CRVUSD_ADDRESS as `0x${string}`,
            abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const,
            functionName: "balanceOf",
            args: [address!],
          }),
        ]);
        if (stale) return;
        setCrvUsdGap(tokensNeeded as bigint);
        setUserCrvUsdBalance(crvUsdBal as bigint);
        // Can always direct-liquidate if user has enough crvUSD (or gap is 0)
        setCanDirectLiquidate((tokensNeeded as bigint) <= (crvUsdBal as bigint));
      } catch {
        if (!stale) {
          setCanDirectLiquidate(false);
          setCrvUsdGap(0n);
        }
      }
    }
    check();
    return () => { stale = true; clearTimeout(resetTimer); };
  }, [publicClient, address, controllerAddress, effectiveSelfLiqPercent]);

  // Handle transaction success — reset to idle
  useEffect(() => {
    if (status === "success") {
      trackLendingSelfLiquidateSuccess(vault.id);
      onTransactionSuccess();
      reset();
    }
  }, [status, onTransactionSuccess, reset, vault.id]);

  // Toast error messages to user
  useEffect(() => {
    if ((status === "error" || status === "reverted") && error) {
      if (isUserRejection(error)) {
        trackTransactionCancelled("self_liquidate", vault.id);
        toast("Transaction cancelled", { id: "leverage-cancelled", duration: 3000 });
        clearError();
      } else {
        trackTransactionError("self_liquidate", vault.id, typeof error === "string" ? error : error, categorizeError(error));
        toast.error(error);
        reset();
      }
    }
  }, [status, error, reset, clearError, vault.id]);

  const fetchEthPrice = useCallback(() => {
    if (!publicClient) return;
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
  }, [publicClient]);

  // Handle approval success -> continue execution
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

  const handleSubmit = async () => {
    if (!address || !controllerAddress) return;

    trackLendingSelfLiquidateInitiated(vault.id);

    const preview = showSimulationPreview;

    const openModalIfPreview = (result: unknown): boolean => {
      if (preview && result) {
        simulationBlock.current = currentBlock ?? 0n;
        setShowSimulationModal(true);
        fetchEthPrice();
        // Modal opened — bail from handleSubmit
        return true;
      }
      // No simulation data (e.g. Anvil/test network) — fall through to execute directly
      return false;
    };

    try {
      const percentage = BigInt(effectiveSelfLiqPercent) * 10n ** 16n;
      // Direct self-liquidation: user calls controller.liquidate directly
      // No health check, no liquidation fee (msg.sender == user)
      if (preview) {
        const result = await directLiquidateAction(controllerAddress, percentage, true, crvUsdGap);
        if (openModalIfPreview(result)) return;
        if (wasApprovalRequested()) return;
      }
      await directLiquidateAction(controllerAddress, percentage, false, crvUsdGap);
    } catch (err) {
      console.error("Self-liquidation failed:", err);
    }
  };

  const handleExecute = async () => {
    try {
      await executeAfterPreview();
    } catch (err) {
      console.error("Self-liquidation execution failed:", err);
    }
  };

  const isProcessing = status !== "idle" && status !== "success" && status !== "error" && status !== "reverted" && status !== "needsApproval";

  const getButtonText = () => {
    if (status === "building") return <>Building transaction<LoadingDots /></>;
    if (status === "simulating") return <>Simulating<LoadingDots /></>;
    if (status === "executing") return <>Confirm in wallet<LoadingDots /></>;
    if (status === "waitingTx") return <>Waiting for confirmation<LoadingDots /></>;
    if (!canDirectLiquidate && effectiveSelfLiqPercent > 0) return "Insufficient crvUSD";
    if (effectiveSelfLiqPercent === 100) return "Close Position";
    return `Self Liquidate ${effectiveSelfLiqPercent}%`;
  };

  const isFormValid = () => {
    if (isUnderwater && !underwaterConfirmed) return false;
    if (!canDirectLiquidate) return false;
    return effectiveSelfLiqPercent > 0;
  };

  const isPositionUnderwater = position?.health !== undefined && position.health <= 0;

  return (
    <div className="space-y-4">
      <div className={cn(
        "p-3 rounded-lg text-sm flex items-center gap-2",
        isPositionUnderwater
          ? "bg-red-500/10 border border-red-500/30 text-red-500"
          : "bg-yellow-500/10 border border-yellow-500/30 text-yellow-500"
      )}>
        <AlertTriangle size={16} className="shrink-0" />
        <div>
          <div className="font-medium">
            {isPositionUnderwater ? "Position Underwater" : "Soft Liquidation"}
          </div>
          <div className="text-xs mt-0.5">
            Close all or part of your position using wallet crvUSD.{onSwitchTab && (
              <> Use <button type="button" onClick={() => onSwitchTab("repay")} className="underline hover:text-yellow-300 transition-colors">Repay</button> instead to reduce debt while keeping your position open.</>
            )}
          </div>
        </div>
      </div>

      {/* AMM Breakdown */}
      {position?.hasLoan && (
        <div className="space-y-1.5 text-xs">
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">Collateral in AMM</span>
            <span className="mono">{Number(formatUnits(position.collateral, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {vault.symbol}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">crvUSD in AMM</span>
            <span className="mono">{Number(formatUnits(position.stablecoin, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--muted-foreground)]">Debt</span>
            <span className="mono">{Number(formatUnits(position.debt, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD</span>
          </div>
          {crvUsdGap > 0n && (
            <>
              <div className="border-t border-[var(--border)] my-1" />
              <div className="flex justify-between">
                <span className="text-[var(--muted-foreground)]">crvUSD gap</span>
                <span className="mono text-yellow-500">{Number(formatUnits(crvUsdGap, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--muted-foreground)]">Your crvUSD balance</span>
                <span className={cn("mono", canDirectLiquidate ? "text-green-500" : "text-red-500")}>
                  {Number(formatUnits(userCrvUsdBalance, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD
                </span>
              </div>
              {!canDirectLiquidate && (
                <div className="mt-1 text-red-500">
                  Need {Number(formatUnits(crvUsdGap > userCrvUsdBalance ? crvUsdGap - userCrvUsdBalance : 0n, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} more crvUSD
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-[var(--muted-foreground)]">
            Liquidation Amount
          </label>
        </div>
        {forceFullLiquidation ? (
          <div className="p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)]">
            <div className="mono text-lg">100%</div>
            <div className="text-xs text-[var(--muted-foreground)] mt-1">Full close required — no collateral remaining for partial liquidation.</div>
          </div>
        ) : (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
            <input
              type="text"
              inputMode="decimal"
              value={selfLiqPercent || ""}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9]/g, "");
                if (raw === "") { setSelfLiqPercent(0); return; }
                const v = Math.min(parseInt(raw, 10), 100);
                setSelfLiqPercent(v);
              }}
              placeholder="0"
              className="flex-1 min-w-0 bg-transparent mono text-lg outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
            />
            <span className="text-sm text-[var(--muted-foreground)] shrink-0 mr-1">%</span>
            <MaxButton
              balance="100"
              onSelect={(v) => {
                const n = Math.round(parseFloat(v) || 0);
                setSelfLiqPercent(Math.min(n, 100));
              }}
            />
          </div>
        )}
      </div>

      {/* Underwater confirmation checkbox */}
      {isUnderwater && (
        <label className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={underwaterConfirmed}
            onChange={(e) => setUnderwaterConfirmed(e.target.checked)}
            className="mt-0.5 accent-red-500"
          />
          <span className="text-xs text-red-500">
            I understand I am paying to close a losing position and will not receive any collateral back.
          </span>
        </label>
      )}

      {/* Approval Flow */}
      <ApprovalCard
        show={showApprovalCard}
        pendingApproval={pendingApproval}
        approvalProgress={approvalProgress}
        decimals={vault.decimals}
        isApproving={isApproving}
        onApprove={(exact) => approve(exact)}
      />

      {/* Simulation Modal */}
      {showSimulationModal && simulationResult && (
        <SimulationModal
          isOpen={showSimulationModal}
          onClose={() => {
            setShowSimulationModal(false);
            toast("Transaction cancelled", { id: "leverage-cancelled", duration: 3000 });
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
            disabled={showApprovalCard || isProcessing || (!isFormValid() && status === "idle")}
            className={cn(
              "w-full py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
              isProcessing || (!isFormValid() && status === "idle")
                ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
            )}
          >
            {getButtonText()}
          </button>
        </div>
      </div>

      {/* Settings */}
      <div className="flex items-center justify-between pt-2">
        <div />
        <div className="flex items-center gap-1">
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

      {/* Connect wallet prompt */}
      {!address && (
        <div className="text-center text-sm text-[var(--muted-foreground)] py-4">
          Connect your wallet to self-liquidate
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
