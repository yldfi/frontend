"use client";

import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount } from "wagmi";
import { parseUnits, maxUint256 } from "viem";
import { useState, useEffect, useMemo, useCallback } from "react";
import { ERC20_APPROVAL_ABI, VAULT_ABI } from "@/lib/abis";

export type TransactionStatus = "idle" | "approving" | "waitingApproval" | "depositing" | "withdrawing" | "waitingTx" | "success" | "reverted" | "error";

// Helper to parse error messages into user-friendly format
function parseErrorMessage(error: Error | null, defaultMsg: string): string | null {
  if (!error) return null;
  const msg = error.message || defaultMsg;

  // User rejection
  if (msg.includes("User rejected") || msg.includes("user rejected") || msg.includes("User declined")) {
    return "Transaction cancelled";
  }

  // Insufficient funds
  if (msg.includes("insufficient funds") || msg.includes("exceeds balance")) {
    return "Insufficient funds for transaction";
  }

  // Gas estimation failed
  if (msg.includes("gas required exceeds") || msg.includes("out of gas")) {
    return "Transaction would fail: out of gas";
  }

  // Extract revert reason
  const revertMatch = msg.match(/reverted with the following reason:\s*\n?\s*(.+?)(?:\n|$)/i);
  if (revertMatch) {
    const reason = revertMatch[1].trim();
    if (reason.toLowerCase() === "execution reverted") {
      return "Transaction failed: execution reverted";
    }
    return `Transaction failed: ${reason}`;
  }

  // Fallback: truncate very long messages
  if (msg.length > 100) {
    const firstLine = msg.split('\n')[0];
    if (firstLine.length <= 100) {
      return firstLine;
    }
    return msg.slice(0, 97) + "...";
  }

  return msg;
}

export function useVaultActions(
  vaultAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  decimals: number = 18
) {
  const { address: userAddress, chainId } = useAccount();
  const [actionState, setActionState] = useState<"idle" | "approving" | "depositing" | "withdrawing">("idle");

  // Check allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: tokenAddress,
    abi: ERC20_APPROVAL_ABI,
    functionName: "allowance",
    args: userAddress ? [userAddress, vaultAddress] : undefined,
    chainId, // Use connected chain
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

  // Wait for transactions - poll every 1 second until confirmed
  const { isLoading: isApprovalPending, isSuccess: isApprovalSuccess, data: approvalReceipt } = useWaitForTransactionReceipt({
    hash: approveHash,
    pollingInterval: 1_000,
  });

  const { isLoading: isDepositPending, isSuccess: isDepositSuccess, data: depositReceipt } = useWaitForTransactionReceipt({
    hash: depositHash,
    pollingInterval: 1_000,
  });

  const { isLoading: isWithdrawPending, isSuccess: isWithdrawSuccess, data: withdrawReceipt } = useWaitForTransactionReceipt({
    hash: withdrawHash,
    pollingInterval: 1_000,
  });

  // Check if transactions reverted (mined but failed on-chain)
  const isApprovalReverted = approvalReceipt?.status === "reverted";
  const isDepositReverted = depositReceipt?.status === "reverted";
  const isWithdrawReverted = withdrawReceipt?.status === "reverted";

  // Derive status from state (avoids setState in effects)
  const status: TransactionStatus = useMemo(() => {
    // On-chain state takes priority - if we have a receipt, respect its status
    // This handles the case where a tx is mined but reverts on-chain
    if (isApprovalReverted || isDepositReverted || isWithdrawReverted) return "reverted";
    if (isDepositSuccess || isWithdrawSuccess) return "success";
    if (isApprovalSuccess) return "idle";
    // Error states for pre-send failures (wallet rejection, simulation failure, RPC errors)
    if (approveError || depositError || withdrawError) return "error";
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
    isApprovalReverted, isDepositReverted, isWithdrawReverted,
    isDepositSuccess, isWithdrawSuccess, isApprovalSuccess,
    isApprovalPending, isDepositPending, isWithdrawPending,
    actionState
  ]);

  // Derive error message from errors or reverts
  const error = useMemo(() => {
    if (approveError) return parseErrorMessage(approveError, "Approval failed");
    if (depositError) return parseErrorMessage(depositError, "Deposit failed");
    if (withdrawError) return parseErrorMessage(withdrawError, "Withdraw failed");
    if (isApprovalReverted) return "Approval transaction reverted";
    if (isDepositReverted) return "Deposit transaction reverted";
    if (isWithdrawReverted) return "Withdraw transaction reverted";
    return null;
  }, [approveError, depositError, withdrawError, isApprovalReverted, isDepositReverted, isWithdrawReverted]);

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
    isLoading: status !== "idle" && status !== "success" && status !== "error" && status !== "reverted",
    isSuccess: status === "success",
    isReverted: status === "reverted",
    refetchAllowance,
    // Transaction hashes for tracking
    depositHash,
    withdrawHash,
  };
}
