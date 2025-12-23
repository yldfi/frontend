"use client";

import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount } from "wagmi";
import { parseUnits, maxUint256 } from "viem";
import { useState, useEffect, useMemo, useCallback } from "react";
import { ERC20_APPROVAL_ABI, VAULT_ABI } from "@/lib/abis";

export type TransactionStatus = "idle" | "approving" | "waitingApproval" | "depositing" | "withdrawing" | "waitingTx" | "success" | "error";

export function useVaultActions(
  vaultAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  decimals: number = 18
) {
  const { address: userAddress } = useAccount();
  const [actionState, setActionState] = useState<"idle" | "approving" | "depositing" | "withdrawing">("idle");

  // Check allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: tokenAddress,
    abi: ERC20_APPROVAL_ABI,
    functionName: "allowance",
    args: userAddress ? [userAddress, vaultAddress] : undefined,
    query: {
      enabled: !!userAddress,
    },
  });

  // Write contracts
  const {
    writeContract: writeApprove,
    data: approveHash,
    reset: resetApprove,
    error: approveError,
  } = useWriteContract();

  const {
    writeContract: writeDeposit,
    data: depositHash,
    reset: resetDeposit,
    error: depositError,
  } = useWriteContract();

  const {
    writeContract: writeWithdraw,
    data: withdrawHash,
    reset: resetWithdraw,
    error: withdrawError,
  } = useWriteContract();

  // Wait for transactions
  const { isLoading: isApprovalPending, isSuccess: isApprovalSuccess } = useWaitForTransactionReceipt({
    hash: approveHash,
  });

  const { isLoading: isDepositPending, isSuccess: isDepositSuccess } = useWaitForTransactionReceipt({
    hash: depositHash,
  });

  const { isLoading: isWithdrawPending, isSuccess: isWithdrawSuccess } = useWaitForTransactionReceipt({
    hash: withdrawHash,
  });

  // Derive status from state (avoids setState in effects)
  const status: TransactionStatus = useMemo(() => {
    // Error states take priority
    if (approveError || depositError || withdrawError) return "error";
    // Success states
    if (isDepositSuccess || isWithdrawSuccess) return "success";
    // Approval success means we go back to idle (ready for deposit/withdraw)
    if (isApprovalSuccess) return "idle";
    // Pending transaction states
    if (isApprovalPending) return "waitingApproval";
    if (isDepositPending || isWithdrawPending) return "waitingTx";
    // User-initiated action states
    if (actionState === "approving") return "approving";
    if (actionState === "depositing") return "depositing";
    if (actionState === "withdrawing") return "withdrawing";
    return "idle";
  }, [
    approveError, depositError, withdrawError,
    isDepositSuccess, isWithdrawSuccess, isApprovalSuccess,
    isApprovalPending, isDepositPending, isWithdrawPending,
    actionState
  ]);

  // Derive error message
  const error = useMemo(() => {
    if (approveError) return approveError.message || "Approval failed";
    if (depositError) return depositError.message || "Deposit failed";
    if (withdrawError) return withdrawError.message || "Withdraw failed";
    return null;
  }, [approveError, depositError, withdrawError]);

  // Refetch allowance after approval success (external side effect only)
  useEffect(() => {
    if (isApprovalSuccess) {
      refetchAllowance();
    }
  }, [isApprovalSuccess, refetchAllowance]);

  // Check if approval is needed for a given amount
  const needsApproval = useCallback((amount: string): boolean => {
    if (!amount || !allowance) return true;
    try {
      const amountWei = parseUnits(amount, decimals);
      return (allowance as bigint) < amountWei;
    } catch {
      return true;
    }
  }, [allowance, decimals]);

  // Approve max
  const approve = useCallback(() => {
    if (!userAddress) return;
    setActionState("approving");

    writeApprove({
      address: tokenAddress,
      abi: ERC20_APPROVAL_ABI,
      functionName: "approve",
      args: [vaultAddress, maxUint256],
    });
  }, [userAddress, tokenAddress, vaultAddress, writeApprove]);

  // Deposit
  const deposit = useCallback((amount: string) => {
    if (!userAddress || !amount) return;
    setActionState("depositing");

    const amountWei = parseUnits(amount, decimals);

    writeDeposit({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: "deposit",
      args: [amountWei, userAddress],
    });
  }, [userAddress, vaultAddress, decimals, writeDeposit]);

  // Withdraw (using redeem for shares)
  const withdraw = useCallback((shares: string) => {
    if (!userAddress || !shares) return;
    setActionState("withdrawing");

    const sharesWei = parseUnits(shares, decimals);

    writeWithdraw({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: "redeem",
      args: [sharesWei, userAddress, userAddress],
    });
  }, [userAddress, vaultAddress, decimals, writeWithdraw]);

  // Reset state
  const reset = useCallback(() => {
    setActionState("idle");
    resetApprove();
    resetDeposit();
    resetWithdraw();
  }, [resetApprove, resetDeposit, resetWithdraw]);

  return {
    allowance: allowance as bigint | undefined,
    needsApproval,
    approve,
    deposit,
    withdraw,
    reset,
    status,
    error,
    isLoading: status !== "idle" && status !== "success" && status !== "error",
    isSuccess: status === "success",
    refetchAllowance,
    // Transaction hashes for tracking
    depositHash,
    withdrawHash,
  };
}
