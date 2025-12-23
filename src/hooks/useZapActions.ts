"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useSendTransaction,
} from "wagmi";
import { parseUnits, maxUint256 } from "viem";
import { ETH_ADDRESS } from "@/lib/enso";
import { ERC20_APPROVAL_ABI } from "@/lib/abis";
import type { ZapQuote } from "@/types/enso";

export type ZapStatus =
  | "idle"
  | "approving"
  | "waitingApproval"
  | "zapping"
  | "waitingTx"
  | "success"
  | "error";

// Helper to parse error messages
function parseErrorMessage(error: Error | null, defaultMsg: string): string | null {
  if (!error) return null;
  const msg = error.message || defaultMsg;
  if (msg.includes("User rejected") || msg.includes("user rejected")) {
    return "Transaction cancelled";
  }
  return msg;
}

export function useZapActions(quote: ZapQuote | null | undefined) {
  const { address: userAddress } = useAccount();
  const [actionState, setActionState] = useState<"idle" | "approving" | "zapping">("idle");

  const isEth =
    quote?.inputToken.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const tokenAddress = quote?.inputToken.address as `0x${string}` | undefined;

  // Get the router address from the quote (Enso may use different routers)
  const routerAddress = quote?.tx?.to as `0x${string}` | undefined;

  // Check allowance for non-ETH tokens
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: tokenAddress,
    abi: ERC20_APPROVAL_ABI,
    functionName: "allowance",
    args: userAddress && routerAddress ? [userAddress, routerAddress] : undefined,
    query: {
      enabled: !!userAddress && !isEth && !!tokenAddress && !!routerAddress,
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

  // Derive status from state (avoids setState in effects)
  const status: ZapStatus = useMemo(() => {
    // Error states take priority
    if (approveError || zapError) return "error";
    // Success state
    if (isZapSuccess) return "success";
    // Approval success means we go back to idle (ready for zap)
    if (isApprovalSuccess) return "idle";
    // Pending transaction states
    if (isApprovalPending) return "waitingApproval";
    if (isZapPending) return "waitingTx";
    // User-initiated action states
    if (actionState === "approving") return "approving";
    if (actionState === "zapping") return "zapping";
    return "idle";
  }, [approveError, zapError, isZapSuccess, isApprovalSuccess, isApprovalPending, isZapPending, actionState]);

  // Derive error message from errors
  const error = useMemo(() => {
    if (approveError) return parseErrorMessage(approveError, "Approval failed");
    if (zapError) return parseErrorMessage(zapError, "Zap transaction failed");
    return null;
  }, [approveError, zapError]);

  // Check if approval needed
  const needsApproval = useCallback((): boolean => {
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
  }, [isEth, quote, allowance]);

  // Refetch allowance after approval success (external side effect only)
  useEffect(() => {
    if (isApprovalSuccess) {
      refetchAllowance();
    }
  }, [isApprovalSuccess, refetchAllowance]);

  // Approve max tokens
  const approve = useCallback(() => {
    if (!userAddress || isEth || !tokenAddress || !routerAddress) return;
    setActionState("approving");

    writeApprove({
      address: tokenAddress,
      abi: ERC20_APPROVAL_ABI,
      functionName: "approve",
      args: [routerAddress, maxUint256],
    });
  }, [userAddress, isEth, tokenAddress, routerAddress, writeApprove]);

  // Execute zap transaction
  const executeZap = useCallback(() => {
    if (!quote || !userAddress) return;
    setActionState("zapping");

    // Send the transaction from Enso's route response
    sendTransaction({
      to: quote.tx.to as `0x${string}`,
      data: quote.tx.data as `0x${string}`,
      value: BigInt(quote.tx.value || "0"),
    });
  }, [quote, userAddress, sendTransaction]);

  // Reset state
  const reset = useCallback(() => {
    setActionState("idle");
    resetApprove();
    resetZap();
  }, [resetApprove, resetZap]);

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
