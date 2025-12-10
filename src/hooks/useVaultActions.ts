"use client";

import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount } from "wagmi";
import { parseUnits, maxUint256 } from "viem";
import { useState, useEffect } from "react";

const ERC20_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const VAULT_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "redeem",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "assets", type: "uint256" }],
  },
] as const;

export type TransactionStatus = "idle" | "approving" | "waitingApproval" | "depositing" | "withdrawing" | "waitingTx" | "success" | "error";

export function useVaultActions(
  vaultAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  decimals: number = 18
) {
  const { address: userAddress } = useAccount();
  const [status, setStatus] = useState<TransactionStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  // Check allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: tokenAddress,
    abi: ERC20_ABI,
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

  // Handle approval success
  useEffect(() => {
    if (isApprovalSuccess) {
      refetchAllowance();
      setStatus("idle");
    }
  }, [isApprovalSuccess, refetchAllowance]);

  // Handle deposit success
  useEffect(() => {
    if (isDepositSuccess) {
      setStatus("success");
    }
  }, [isDepositSuccess]);

  // Handle withdraw success
  useEffect(() => {
    if (isWithdrawSuccess) {
      setStatus("success");
    }
  }, [isWithdrawSuccess]);

  // Handle errors
  useEffect(() => {
    if (approveError) {
      setStatus("error");
      setError(approveError.message || "Approval failed");
    }
  }, [approveError]);

  useEffect(() => {
    if (depositError) {
      setStatus("error");
      setError(depositError.message || "Deposit failed");
    }
  }, [depositError]);

  useEffect(() => {
    if (withdrawError) {
      setStatus("error");
      setError(withdrawError.message || "Withdraw failed");
    }
  }, [withdrawError]);

  // Update status based on pending states
  useEffect(() => {
    if (isApprovalPending) setStatus("waitingApproval");
    else if (isDepositPending) setStatus("waitingTx");
    else if (isWithdrawPending) setStatus("waitingTx");
  }, [isApprovalPending, isDepositPending, isWithdrawPending]);

  // Check if approval is needed for a given amount
  const needsApproval = (amount: string): boolean => {
    if (!amount || !allowance) return true;
    try {
      const amountWei = parseUnits(amount, decimals);
      return (allowance as bigint) < amountWei;
    } catch {
      return true;
    }
  };

  // Approve max
  const approve = async () => {
    if (!userAddress) return;
    setStatus("approving");
    setError(null);

    writeApprove({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [vaultAddress, maxUint256],
    });
  };

  // Deposit
  const deposit = async (amount: string) => {
    if (!userAddress || !amount) return;
    setStatus("depositing");
    setError(null);

    const amountWei = parseUnits(amount, decimals);

    writeDeposit({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: "deposit",
      args: [amountWei, userAddress],
    });
  };

  // Withdraw (using redeem for shares)
  const withdraw = async (shares: string) => {
    if (!userAddress || !shares) return;
    setStatus("withdrawing");
    setError(null);

    const sharesWei = parseUnits(shares, decimals);

    writeWithdraw({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: "redeem",
      args: [sharesWei, userAddress, userAddress],
    });
  };

  // Reset state
  const reset = () => {
    setStatus("idle");
    setError(null);
    resetApprove();
    resetDeposit();
    resetWithdraw();
  };

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
