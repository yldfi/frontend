"use client";

import { useState, useMemo, useEffect } from "react";
import { X, Loader2, Check, AlertTriangle, ExternalLink } from "lucide-react";
import { useAccount, usePublicClient } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import type { VaultConfig } from "@/config/vaults";
import { CURVE_CONTROLLERS } from "@/config/vaults";
import { useCurveLendingPosition, formatHealth } from "@/hooks/useCurveLendingPosition";
import { useCurveLendingActions } from "@/hooks/useCurveLendingActions";
import { cn } from "@/lib/utils";

interface LendingInterfaceProps {
  vault: VaultConfig;
  userBalance: string; // Vault token balance in wei
  onClose: () => void;
}

type Tab = "deposit" | "borrow" | "repay" | "manage";

// Controller ABI for calculations
const CONTROLLER_ABI = [
  {
    name: "max_borrowable",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "collateral", type: "uint256" },
      { name: "N", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
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

export function LendingInterface({
  vault,
  userBalance,
  onClose,
}: LendingInterfaceProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [activeTab, setActiveTab] = useState<Tab>("deposit");

  // Form state
  const [collateralAmount, setCollateralAmount] = useState("");
  const [borrowAmount, setBorrowAmount] = useState("");
  const [repayAmount, setRepayAmount] = useState("");
  const [bands, setBands] = useState(10);

  // Calculations state
  const [maxBorrowable, setMaxBorrowable] = useState<bigint>(0n);
  const [estimatedHealth, setEstimatedHealth] = useState<number | null>(null);

  // Get controller address
  const controllerAddress = CURVE_CONTROLLERS[vault.address as keyof typeof CURVE_CONTROLLERS] as `0x${string}` | undefined;

  // Get user's existing position
  const { position, refetch: refetchPosition } = useCurveLendingPosition(
    vault.address as `0x${string}`,
    address
  );

  // Lending actions
  const {
    createLoan,
    addCollateral,
    borrowMore,
    repay,
    status,
    txHash,
    error,
    reset,
  } = useCurveLendingActions();

  // Calculate max borrowable when collateral amount changes
  useEffect(() => {
    async function calculateMaxBorrowable() {
      if (!publicClient || !controllerAddress || !collateralAmount) {
        setMaxBorrowable(0n);
        return;
      }

      try {
        const collateralWei = parseUnits(collateralAmount, vault.decimals);
        const max = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "max_borrowable",
          args: [collateralWei, BigInt(bands)],
        });
        setMaxBorrowable(max);
      } catch (err) {
        console.error("Error calculating max borrowable:", err);
        setMaxBorrowable(0n);
      }
    }

    calculateMaxBorrowable();
  }, [publicClient, controllerAddress, collateralAmount, bands, vault.decimals]);

  // Calculate estimated health when amounts change
  useEffect(() => {
    async function calculateHealth() {
      if (!publicClient || !controllerAddress || !address) {
        setEstimatedHealth(null);
        return;
      }

      try {
        const dCollateral = collateralAmount
          ? parseUnits(collateralAmount, vault.decimals)
          : 0n;
        const dDebt = borrowAmount ? parseUnits(borrowAmount, 18) : 0n;

        if (dCollateral === 0n && dDebt === 0n) {
          setEstimatedHealth(null);
          return;
        }

        const health = await publicClient.readContract({
          address: controllerAddress,
          abi: CONTROLLER_ABI,
          functionName: "health_calculator",
          args: [
            address,
            BigInt(dCollateral),
            BigInt(dDebt),
            false,
            BigInt(bands),
          ],
        });

        setEstimatedHealth(Number(health) / 1e18);
      } catch (err) {
        console.error("Error calculating health:", err);
        setEstimatedHealth(null);
      }
    }

    calculateHealth();
  }, [publicClient, controllerAddress, address, collateralAmount, borrowAmount, bands, vault.decimals]);

  // Format balance for display
  const formattedBalance = useMemo(() => {
    const value = Number(formatUnits(BigInt(userBalance), vault.decimals));
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }, [userBalance, vault.decimals]);

  // Handle form submission
  const handleSubmit = async () => {
    if (!address || !controllerAddress) return;

    try {
      if (activeTab === "deposit") {
        const collateralWei = parseUnits(collateralAmount, vault.decimals).toString();
        const debtWei = borrowAmount ? parseUnits(borrowAmount, 18).toString() : "0";

        if (position?.hasLoan) {
          // Add collateral to existing loan
          await addCollateral(vault.address as `0x${string}`, collateralWei);
          if (borrowAmount) {
            await borrowMore(vault.address as `0x${string}`, "0", debtWei);
          }
        } else {
          // Create new loan
          await createLoan(
            vault.address as `0x${string}`,
            collateralWei,
            debtWei,
            bands
          );
        }
      } else if (activeTab === "borrow") {
        const debtWei = parseUnits(borrowAmount, 18).toString();
        await borrowMore(vault.address as `0x${string}`, "0", debtWei);
      } else if (activeTab === "repay") {
        const repayWei = parseUnits(repayAmount, 18).toString();
        await repay(vault.address as `0x${string}`, repayWei);
      }

      // Refetch position after successful action
      if (status === "success") {
        refetchPosition();
        setCollateralAmount("");
        setBorrowAmount("");
        setRepayAmount("");
      }
    } catch (err) {
      console.error("Lending action failed:", err);
    }
  };

  // Health indicator component
  const HealthIndicator = ({ health }: { health: number }) => {
    const { status: healthStatus, color } = formatHealth(health);
    return (
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "w-2 h-2 rounded-full",
            healthStatus === "healthy" && "bg-green-500",
            healthStatus === "warning" && "bg-yellow-500",
            healthStatus === "danger" && "bg-red-500"
          )}
        />
        <span className={color}>{health.toFixed(1)}%</span>
      </div>
    );
  };

  const isProcessing = status !== "idle" && status !== "success" && status !== "error";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-[var(--background)] border border-[var(--border)] rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-[var(--background)] border-b border-[var(--border)] p-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">Curve LlamaLend</h2>
            <span className="px-2 py-0.5 text-xs rounded-full bg-[var(--muted)] text-[var(--muted-foreground)]">
              {vault.symbol}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-[var(--muted)] transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Position Summary */}
        {position?.hasLoan && (
          <div className="p-4 border-b border-[var(--border)] bg-[var(--muted)]/30">
            <div className="text-sm text-[var(--muted-foreground)] mb-2">Your Position</div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-[var(--muted-foreground)]">Collateral</div>
                <div className="font-medium mono">
                  {Number(formatUnits(position.collateral, vault.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {vault.symbol}
                </div>
              </div>
              <div>
                <div className="text-xs text-[var(--muted-foreground)]">Debt</div>
                <div className="font-medium mono">
                  {Number(formatUnits(position.debt, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} crvUSD
                </div>
              </div>
              <div>
                <div className="text-xs text-[var(--muted-foreground)]">Health</div>
                <HealthIndicator health={position.health} />
              </div>
              <div>
                <div className="text-xs text-[var(--muted-foreground)]">Bands</div>
                <div className="font-medium">{position.n1} - {position.n2}</div>
              </div>
            </div>
            {position.inSoftLiquidation && (
              <div className="mt-3 p-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 flex items-center gap-2 text-yellow-500 text-sm">
                <AlertTriangle size={16} />
                Position in soft-liquidation
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="p-4 pb-0">
          <div className="flex border-b border-[var(--border)]">
            {(["deposit", "borrow", "repay", "manage"] as const).map((tab) => {
              const disabled = tab === "borrow" && !position?.hasLoan;
              const disabledRepay = tab === "repay" && !position?.hasLoan;
              const isDisabled = disabled || disabledRepay;

              return (
                <button
                  key={tab}
                  disabled={isDisabled}
                  onClick={() => {
                    if (!isDisabled) {
                      setActiveTab(tab);
                      reset();
                    }
                  }}
                  className={cn(
                    "flex-1 pb-3 text-sm font-medium transition-all capitalize relative",
                    isDisabled && "opacity-50 cursor-not-allowed",
                    !isDisabled && activeTab === tab
                      ? "text-[var(--foreground)]"
                      : !isDisabled && "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  )}
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

        {/* Form Content */}
        <div className="p-4 space-y-4">
          {/* Deposit Tab */}
          {activeTab === "deposit" && (
            <>
              {/* Collateral Input */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm text-[var(--muted-foreground)]">
                    Collateral Amount
                  </label>
                  <button
                    onClick={() => setCollateralAmount(formatUnits(BigInt(userBalance), vault.decimals))}
                    className="text-xs text-[var(--accent)] hover:underline"
                  >
                    Max: {formattedBalance}
                  </button>
                </div>
                <div className="relative">
                  <input
                    type="text"
                    value={collateralAmount}
                    onChange={(e) => setCollateralAmount(e.target.value)}
                    placeholder="0.0"
                    className="w-full p-3 pr-20 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus:border-[var(--foreground)] outline-none mono"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--muted-foreground)]">
                    {vault.symbol}
                  </span>
                </div>
              </div>

              {/* Borrow Amount Input */}
              {!position?.hasLoan && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-[var(--muted-foreground)]">
                      Borrow Amount (optional)
                    </label>
                    {maxBorrowable > 0n && (
                      <button
                        onClick={() => setBorrowAmount(formatUnits(maxBorrowable * 80n / 100n, 18))}
                        className="text-xs text-[var(--accent)] hover:underline"
                      >
                        Max: {Number(formatUnits(maxBorrowable, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type="text"
                      value={borrowAmount}
                      onChange={(e) => setBorrowAmount(e.target.value)}
                      placeholder="0.0"
                      className="w-full p-3 pr-20 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus:border-[var(--foreground)] outline-none mono"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--muted-foreground)]">
                      crvUSD
                    </span>
                  </div>
                </div>
              )}

              {/* Bands Selector */}
              {!position?.hasLoan && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-[var(--muted-foreground)]">
                      Number of Bands
                    </label>
                    <span className="text-sm mono">{bands}</span>
                  </div>
                  <input
                    type="range"
                    min={4}
                    max={50}
                    value={bands}
                    onChange={(e) => setBands(Number(e.target.value))}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-[var(--muted-foreground)]">
                    <span>4 (higher liquidation risk)</span>
                    <span>50 (more gradual)</span>
                  </div>
                </div>
              )}

              {/* Estimated Health */}
              {estimatedHealth !== null && (
                <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)]">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-[var(--muted-foreground)]">
                      Estimated Health
                    </span>
                    <HealthIndicator health={estimatedHealth} />
                  </div>
                </div>
              )}
            </>
          )}

          {/* Borrow Tab */}
          {activeTab === "borrow" && position?.hasLoan && (
            <>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm text-[var(--muted-foreground)]">
                    Borrow Amount
                  </label>
                </div>
                <div className="relative">
                  <input
                    type="text"
                    value={borrowAmount}
                    onChange={(e) => setBorrowAmount(e.target.value)}
                    placeholder="0.0"
                    className="w-full p-3 pr-20 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus:border-[var(--foreground)] outline-none mono"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--muted-foreground)]">
                    crvUSD
                  </span>
                </div>
              </div>

              {/* Health warning */}
              {estimatedHealth !== null && estimatedHealth < 20 && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center gap-2 text-red-500 text-sm">
                  <AlertTriangle size={16} />
                  This borrow would put your position at risk
                </div>
              )}
            </>
          )}

          {/* Repay Tab */}
          {activeTab === "repay" && position?.hasLoan && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-[var(--muted-foreground)]">
                  Repay Amount
                </label>
                <button
                  onClick={() => setRepayAmount(formatUnits(position.debt, 18))}
                  className="text-xs text-[var(--accent)] hover:underline"
                >
                  Max: {Number(formatUnits(position.debt, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </button>
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={repayAmount}
                  onChange={(e) => setRepayAmount(e.target.value)}
                  placeholder="0.0"
                  className="w-full p-3 pr-20 rounded-lg bg-[var(--muted)] border border-[var(--border)] focus:border-[var(--foreground)] outline-none mono"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--muted-foreground)]">
                  crvUSD
                </span>
              </div>
            </div>
          )}

          {/* Manage Tab */}
          {activeTab === "manage" && (
            <div className="space-y-4">
              <p className="text-sm text-[var(--muted-foreground)]">
                Additional management options coming soon:
              </p>
              <ul className="text-sm text-[var(--muted-foreground)] space-y-2">
                <li>• Add/Remove collateral</li>
                <li>• Self-liquidate</li>
                <li>• Leverage positions</li>
              </ul>
              <a
                href={vault.links?.curve}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-[var(--accent)] hover:underline"
              >
                Use Curve.finance for advanced options
                <ExternalLink size={14} />
              </a>
            </div>
          )}

          {/* Error Display */}
          {error && (
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

          {/* Action Button */}
          {activeTab !== "manage" && (
            <button
              onClick={handleSubmit}
              disabled={isProcessing || (!collateralAmount && !borrowAmount && !repayAmount)}
              className={cn(
                "w-full py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
                isProcessing || (!collateralAmount && !borrowAmount && !repayAmount)
                  ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                  : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
              )}
            >
              {isProcessing && <Loader2 className="w-4 h-4 animate-spin" />}
              {status === "building" && "Building transaction..."}
              {status === "executing" && "Confirm in wallet..."}
              {status === "waitingTx" && "Waiting for confirmation..."}
              {status === "idle" && activeTab === "deposit" && (position?.hasLoan ? "Add Collateral" : "Create Loan")}
              {status === "idle" && activeTab === "borrow" && "Borrow crvUSD"}
              {status === "idle" && activeTab === "repay" && "Repay Debt"}
              {status === "success" && "Done!"}
              {status === "error" && "Try Again"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
