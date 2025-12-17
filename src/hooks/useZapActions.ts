"use client";

import { useState, useEffect } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useSendTransaction,
} from "wagmi";
import { parseUnits, maxUint256 } from "viem";
import { ENSO_ROUTER, ETH_ADDRESS } from "@/lib/enso";
import type { ZapQuote } from "@/types/enso";

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

export type ZapStatus =
  | "idle"
  | "approving"
  | "waitingApproval"
  | "zapping"
  | "waitingTx"
  | "success"
  | "error";

export function useZapActions(quote: ZapQuote | null | undefined) {
  const { address: userAddress } = useAccount();
  const [status, setStatus] = useState<ZapStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const isEth =
    quote?.inputToken.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const tokenAddress = quote?.inputToken.address as `0x${string}` | undefined;

  // Check allowance for non-ETH tokens
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: userAddress ? [userAddress, ENSO_ROUTER as `0x${string}`] : undefined,
    query: {
      enabled: !!userAddress && !isEth && !!tokenAddress,
    },
  });

  // Approve contract
  const {
    writeContract: writeApprove,
    data: approveHash,
    reset: resetApprove,
    error: approveError,
  } = useWriteContract();

  // Send zap transaction (using sendTransaction for raw tx)
  const {
    sendTransaction,
    data: zapHash,
    reset: resetZap,
    error: zapError,
  } = useSendTransaction();

  // Wait for approval
  const { isLoading: isApprovalPending, isSuccess: isApprovalSuccess } =
    useWaitForTransactionReceipt({ hash: approveHash });

  // Wait for zap
  const { isLoading: isZapPending, isSuccess: isZapSuccess } =
    useWaitForTransactionReceipt({ hash: zapHash });

  // Check if approval needed
  const needsApproval = (): boolean => {
    if (isEth || !quote) return false;
    try {
      const amountWei = parseUnits(
        quote.inputAmount,
        quote.inputToken.decimals
      );
      return !allowance || (allowance as bigint) < amountWei;
    } catch {
      return true;
    }
  };

  // Handle approval success
  useEffect(() => {
    if (isApprovalSuccess) {
      refetchAllowance();
      setStatus("idle");
    }
  }, [isApprovalSuccess, refetchAllowance]);

  // Handle zap success
  useEffect(() => {
    if (isZapSuccess) {
      setStatus("success");
    }
  }, [isZapSuccess]);

  // Handle errors
  useEffect(() => {
    if (approveError) {
      setStatus("error");
      const msg = approveError.message || "Approval failed";
      // Check for user rejection
      if (msg.includes("User rejected") || msg.includes("user rejected")) {
        setError("Transaction cancelled");
      } else {
        setError(msg);
      }
    }
  }, [approveError]);

  useEffect(() => {
    if (zapError) {
      setStatus("error");
      const msg = zapError.message || "Zap transaction failed";
      // Check for user rejection
      if (msg.includes("User rejected") || msg.includes("user rejected")) {
        setError("Transaction cancelled");
      } else {
        setError(msg);
      }
    }
  }, [zapError]);

  // Update status for pending states
  useEffect(() => {
    if (isApprovalPending) setStatus("waitingApproval");
    else if (isZapPending) setStatus("waitingTx");
  }, [isApprovalPending, isZapPending]);

  // Approve max tokens
  const approve = async () => {
    if (!userAddress || isEth || !tokenAddress) return;
    setStatus("approving");
    setError(null);

    writeApprove({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ENSO_ROUTER as `0x${string}`, maxUint256],
    });
  };

  // Execute zap transaction
  const executeZap = async () => {
    if (!quote || !userAddress) return;
    setStatus("zapping");
    setError(null);

    // Send the transaction from Enso's route response
    sendTransaction({
      to: quote.tx.to as `0x${string}`,
      data: quote.tx.data as `0x${string}`,
      value: BigInt(quote.tx.value || "0"),
    });
  };

  // Reset state
  const reset = () => {
    setStatus("idle");
    setError(null);
    resetApprove();
    resetZap();
  };

  return {
    needsApproval,
    approve,
    executeZap,
    reset,
    status,
    error,
    isLoading: status !== "idle" && status !== "success" && status !== "error",
    isSuccess: status === "success",
    zapHash,
    refetchAllowance,
  };
}
