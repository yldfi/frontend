"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useSendTransaction,
  usePublicClient,
} from "wagmi";
import { parseUnits, maxUint256 } from "viem";
import { ETH_ADDRESS } from "@/lib/enso";
import { ERC20_APPROVAL_ABI } from "@/lib/abis";
import { useTenderly } from "@/contexts/TenderlyContext";
import type { ZapQuote } from "@/types/enso";

export type ZapStatus =
  | "idle"
  | "approving"
  | "waitingApproval"
  | "zapping"
  | "waitingTx"
  | "success"
  | "reverted"
  | "error";

// Known custom error selectors from Enso router and common DeFi contracts
const CUSTOM_ERROR_SELECTORS: Record<string, string> = {
  "0x97a6f3b9": "Slippage too high - price moved, try increasing slippage tolerance",
  "0x8baa579f": "Insufficient output amount",
  "0x39d35496": "Excessive input amount",
  "0x13be252b": "Insufficient balance",
  "0x756688fe": "Deadline expired - transaction took too long",
  "0x675cae38": "Invalid path",
  "0x7939f424": "Transfer failed",
};

// Helper to parse error messages into user-friendly format
function parseErrorMessage(error: Error | null, defaultMsg: string): string | null {
  if (!error) return null;
  const msg = error.message || defaultMsg;

  // User rejection
  if (msg.includes("User rejected") || msg.includes("user rejected")) {
    return "Transaction cancelled";
  }

  // Check for custom error selectors (0x + 8 hex chars)
  const customErrorMatch = msg.match(/custom error (0x[a-fA-F0-9]{8})/i)
    || msg.match(/reverted with (0x[a-fA-F0-9]{8})/i)
    || msg.match(/error (0x[a-fA-F0-9]{8})/i);
  if (customErrorMatch) {
    const selector = customErrorMatch[1].toLowerCase();
    const friendlyMessage = CUSTOM_ERROR_SELECTORS[selector];
    if (friendlyMessage) {
      return friendlyMessage;
    }
    // Unknown custom error - still show the selector
    return `Transaction failed: custom error ${selector}`;
  }

  // Extract revert reason from viem errors
  // Format: 'reverted with the following reason:\n<reason>'
  const revertMatch = msg.match(/reverted with the following reason:\s*\n?\s*(.+?)(?:\n|$)/i);
  if (revertMatch) {
    const reason = revertMatch[1].trim();
    // If reason is just "execution reverted" with no details, make it friendlier
    if (reason.toLowerCase() === "execution reverted") {
      return "Transaction failed: execution reverted";
    }
    return `Transaction failed: ${reason}`;
  }

  // Check for simulation/estimation errors
  if (msg.includes("EstimateGasExecutionError") || msg.includes("simulateContract")) {
    // Try to extract a short reason
    const shortReason = msg.match(/reason:\s*(.+?)(?:\n|Contract Call:|$)/i);
    if (shortReason) {
      return `Simulation failed: ${shortReason[1].trim()}`;
    }
    return "Transaction simulation failed";
  }

  // Insufficient ETH for gas
  if (msg.includes("insufficient funds")) {
    return "Insufficient funds for gas";
  }

  // ERC20 transfer failures (slippage, stale quote, or swap conditions changed)
  if (msg.includes("transfer amount exceeds balance") || msg.includes("ERC20: transfer amount exceeds")) {
    return "Transaction would fail: swap conditions changed, try refreshing the quote";
  }

  // Gas estimation failed
  if (msg.includes("gas required exceeds") || msg.includes("out of gas")) {
    return "Transaction would fail: out of gas";
  }

  // Slippage/price errors (text-based)
  if (msg.includes("slippage") || msg.includes("INSUFFICIENT_OUTPUT")) {
    return "Transaction failed: slippage too high";
  }

  // Fallback: truncate very long messages
  if (msg.length > 100) {
    // Try to get just the first line or meaningful part
    const firstLine = msg.split('\n')[0];
    if (firstLine.length <= 100) {
      return firstLine;
    }
    return msg.slice(0, 97) + "...";
  }

  return msg;
}

export function useZapActions(quote: ZapQuote | null | undefined) {
  const { address: userAddress, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { isTenderlyVNet } = useTenderly();
  const [actionState, setActionState] = useState<"idle" | "approving" | "simulating" | "zapping">("idle");
  const [simulationError, setSimulationError] = useState<string | null>(null);

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
    chainId, // Use connected chain
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

  // Wait for approval - poll every 1 second until confirmed
  const { isLoading: isApprovalPending, isSuccess: isApprovalSuccess, data: approvalReceipt } =
    useWaitForTransactionReceipt({
      hash: approveHash,
      pollingInterval: 1_000,
    });

  // Wait for zap - poll every 1 second until confirmed
  const { isLoading: isZapPending, isSuccess: isZapSuccess, data: zapReceipt } =
    useWaitForTransactionReceipt({
      hash: zapHash,
      pollingInterval: 1_000,
    });

  // Check if transactions reverted (mined but failed)
  const isApprovalReverted = approvalReceipt?.status === "reverted";
  const isZapReverted = zapReceipt?.status === "reverted";

  // Log transaction receipts to browser console in dev
  useEffect(() => {
    if (approvalReceipt && process.env.NODE_ENV === "development") {
      console.log("[Approval Transaction]", {
        hash: approvalReceipt.transactionHash,
        status: approvalReceipt.status,
        blockNumber: Number(approvalReceipt.blockNumber),
        gasUsed: approvalReceipt.gasUsed.toString(),
      });
    }
  }, [approvalReceipt]);

  useEffect(() => {
    if (zapReceipt && process.env.NODE_ENV === "development") {
      console.log("[Zap Transaction]", {
        hash: zapReceipt.transactionHash,
        status: zapReceipt.status,
        blockNumber: Number(zapReceipt.blockNumber),
        gasUsed: zapReceipt.gasUsed.toString(),
        effectiveGasPrice: zapReceipt.effectiveGasPrice?.toString(),
        logsCount: zapReceipt.logs.length,
      });
    }
  }, [zapReceipt]);

  // Derive status from state (avoids setState in effects)
  const status: ZapStatus = useMemo(() => {
    // On-chain state takes priority - if we have a receipt, respect its status
    // This handles the case where a tx is mined but reverts on-chain
    if (isZapReverted || isApprovalReverted) return "reverted";
    if (isZapSuccess) return "success";
    if (isApprovalSuccess) return "idle";
    // Error states for pre-send failures (wallet rejection, simulation failure, RPC errors)
    if (approveError || zapError || simulationError) return "error";
    // Pending transaction states
    if (isApprovalPending) return "waitingApproval";
    if (isZapPending) return "waitingTx";
    // User-initiated action states
    if (actionState === "approving") return "approving";
    if (actionState === "simulating") return "zapping"; // Show as "zapping" to user (simulating is quick)
    if (actionState === "zapping") return "zapping";
    return "idle";
  }, [approveError, zapError, simulationError, isZapReverted, isApprovalReverted, isZapSuccess, isApprovalSuccess, isApprovalPending, isZapPending, actionState]);

  // Derive error message from errors or reverts
  const error = useMemo(() => {
    if (simulationError) return simulationError;
    if (approveError) return parseErrorMessage(approveError, "Approval failed");
    if (zapError) return parseErrorMessage(zapError, "Zap transaction failed");
    if (isApprovalReverted) return "Approval transaction reverted";
    if (isZapReverted) return "Zap transaction reverted";
    return null;
  }, [simulationError, approveError, zapError, isApprovalReverted, isZapReverted]);

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

  // Execute zap transaction with pre-flight simulation
  const executeZap = useCallback(async () => {
    if (!quote || !userAddress || !publicClient) return;

    // Clear any previous simulation error
    setSimulationError(null);
    setActionState("simulating");

    const txParams = {
      to: quote.tx.to as `0x${string}`,
      data: quote.tx.data as `0x${string}`,
      value: BigInt(quote.tx.value || "0"),
    };

    // Skip Tenderly simulation on VNet - it simulates against mainnet, not VNet state
    const tenderlyPromise = (isTenderlyVNet || chainId === 1337)
      ? Promise.resolve({ ok: true as const })
      : (async () => {
          try {
            const nonceResponse = await fetch("/api/simulate/nonce", {
              method: "GET",
              headers: { "Content-Type": "application/json" },
            });
            const nonceResult = (await nonceResponse.json()) as {
              success: boolean;
              nonce?: string;
              expires?: number;
              sig?: string;
            };

            if (!nonceResult.success || !nonceResult.nonce || !nonceResult.expires || !nonceResult.sig) {
              return {
                ok: false as const,
                errorMessage: "Failed to obtain simulation nonce",
                retryable: true,
              };
            }

            const response = await fetch("/api/simulate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                from: userAddress,
                to: quote.tx.to,
                data: quote.tx.data,
                value: quote.tx.value,
                inputToken: quote.inputToken.address,
                nonce: nonceResult.nonce,
                expires: nonceResult.expires,
                sig: nonceResult.sig,
              }),
            });

            const result = (await response.json()) as {
              success: boolean;
              errorMessage?: string | null;
              retryable?: boolean;
              simulationId?: string;
              tenderlyUrl?: string;
              gasUsed?: number;
            };

            // Log simulation result to browser console in dev
            if (process.env.NODE_ENV === "development") {
              console.log("[Tenderly Simulation]", {
                success: result.success,
                simulationId: result.simulationId,
                tenderlyUrl: result.tenderlyUrl,
                gasUsed: result.gasUsed,
                errorMessage: result.errorMessage,
              });
            }

            if (result.success) return { ok: true as const };
            return {
              ok: false as const,
              errorMessage: result.errorMessage ?? "Tenderly simulation failed",
              retryable: Boolean(result.retryable),
            };
          } catch (error) {
            return {
              ok: false as const,
              errorMessage: error instanceof Error ? error.message : "Tenderly simulation failed",
              retryable: true,
            };
          }
        })();

    const ethCallPromise = (async () => {
      try {
        await publicClient.call({
          account: userAddress,
          ...txParams,
        });
        return { ok: true as const };
      } catch (error) {
        return {
          ok: false as const,
          errorMessage: error instanceof Error ? error.message : "Unknown error",
        };
      }
    })();

    const [tenderlyResult, ethCallResult] = await Promise.all([
      tenderlyPromise,
      ethCallPromise,
    ]);

    if (!tenderlyResult.ok && !ethCallResult.ok) {
      const errorMsg = tenderlyResult.retryable
        ? ethCallResult.errorMessage ?? tenderlyResult.errorMessage
        : tenderlyResult.errorMessage;
      setSimulationError(
        parseErrorMessage(new Error(errorMsg), "Transaction would fail")
      );
      setActionState("idle");
      return;
    }

    // Simulation passed - send the actual transaction
    setActionState("zapping");
    sendTransaction(txParams);
  }, [quote, userAddress, publicClient, sendTransaction, chainId, isTenderlyVNet]);

  // Reset state
  const reset = useCallback(() => {
    setActionState("idle");
    setSimulationError(null);
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
    isLoading: status !== "idle" && status !== "success" && status !== "error" && status !== "reverted",
    isSuccess: status === "success",
    isReverted: status === "reverted",
    zapHash,
    refetchAllowance,
  };
}
