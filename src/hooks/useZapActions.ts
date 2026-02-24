"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  useAccount,
  useWaitForTransactionReceipt,
  useReadContract,
  usePublicClient,
} from "wagmi";
import { useVNetSendTransaction as useSendTransaction } from "@/hooks/useVNetSendTransaction";
import { useVNetWriteContract as useWriteContract } from "@/hooks/useVNetWriteContract";
import { parseUnits, maxUint256 } from "viem";
import type { Hash } from "viem";
import { ETH_ADDRESS } from "@/lib/enso";
import { ERC20_APPROVAL_ABI } from "@/lib/abis";
import { useTenderly } from "@/contexts/TenderlyContext";
import { useFlashbotsProtect } from "@/hooks/useFlashbotsProtect";
import type { ZapQuote, SimulationResult } from "@/types/enso";
import type { PendingApproval, ApprovalProgress } from "@/types/approval";
import { runVNetSimulation } from "@/lib/vnet-simulation";

export type ZapStatus =
  | "idle"
  | "needsApproval"
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
  const { isTenderlyVNet, testNetworkType } = useTenderly();
  const { isFlashbotsEnabled, isFlashbotsSupported, toggleFlashbots, sendViaFlashbots } = useFlashbotsProtect();
  const [actionState, setActionState] = useState<"idle" | "needsApproval" | "approving" | "simulating" | "zapping">("idle");
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [flashbotsHash, setFlashbotsHash] = useState<Hash | undefined>(undefined);
  const [flashbotsError, setFlashbotsError] = useState<Error | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const autoExecuteRef = useRef(false);
  const pendingOptionsRef = useRef<{ skipSimulation?: boolean; previewOnly?: boolean } | undefined>(undefined);

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
  // Use either wagmi's zapHash or our flashbotsHash depending on which was used
  const activeZapHash = zapHash || flashbotsHash;
  const { isLoading: isZapPending, isSuccess: isZapSuccess, data: zapReceipt } =
    useWaitForTransactionReceipt({
      hash: activeZapHash,
      pollingInterval: 1_000,
    });

  // Check if transactions reverted (mined but failed)
  const isApprovalReverted = approvalReceipt?.status === "reverted";
  const isZapReverted = zapReceipt?.status === "reverted";

  // Log transaction receipts to browser console in dev
  useEffect(() => {
    if (approvalReceipt && process.env.NODE_ENV === "development") {
      console.log("[Approve Receipt]", {
        hash: approvalReceipt.transactionHash,
        status: approvalReceipt.status,
        blockNumber: Number(approvalReceipt.blockNumber),
        gasUsed: approvalReceipt.gasUsed.toString(),
      });
    }
  }, [approvalReceipt]);

  useEffect(() => {
    if (zapReceipt && process.env.NODE_ENV === "development") {
      console.log("[TX Receipt]", {
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
    // Terminal on-chain states (receipt exists and shows final result)
    if (isZapReverted || isApprovalReverted) return "reverted";
    if (isZapSuccess) return "success";
    // Error states for pre-send failures (wallet rejection, simulation failure, RPC errors)
    if (approveError || zapError || flashbotsError || simulationError) return "error";
    // Active on-chain pending states
    if (isZapPending) return "waitingTx";
    if (isApprovalPending) return "waitingApproval";
    // Active action states (pre-send) — must be checked AFTER on-chain states
    // but BEFORE isApprovalSuccess, which stays true after approval and would
    // mask the simulating/zapping states during the approve→zap transition
    if (actionState === "approving") return "approving";
    if (actionState === "needsApproval") return "needsApproval";
    if (actionState === "simulating") return "zapping";
    if (actionState === "zapping") return "zapping";
    return "idle";
  }, [approveError, zapError, flashbotsError, simulationError, isZapReverted, isApprovalReverted, isZapSuccess, isApprovalSuccess, isApprovalPending, isZapPending, actionState]);

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
    if (isEth || !quote) {
      return false;
    }
    try {
      const amountWei = parseUnits(
        quote.inputAmount,
        quote.inputToken.decimals
      );
      // Check allowance - treat any falsy value as needing approval
      // This handles undefined (query not run), null, 0n, and any other falsy values
      if (!allowance) {
        return true;
      }
      return (allowance as bigint) < amountWei;
    } catch {
      return true;
    }
  }, [isEth, quote, allowance]);

  // Derive approvalProgress and isApproving for ApprovalCard
  const approvalProgress: ApprovalProgress | null = useMemo(() => {
    if (!pendingApproval) return null;
    return {
      step: 1,
      total: 1,
      steps: [{
        label: pendingApproval.tokenSymbol,
        description: "Approve for swap routing",
        done: false,
        spender: routerAddress,
      }],
    };
  }, [pendingApproval, routerAddress]);

  const isApproving = status === "approving" || status === "waitingApproval";

  // Refetch allowance after approval success (external side effect only)
  useEffect(() => {
    if (isApprovalSuccess) {
      refetchAllowance();
    }
  }, [isApprovalSuccess, refetchAllowance]);

  // Ref to hold latest executeZapInternal for use in auto-execute effect
  const executeZapInternalRef = useRef<(options?: { skipSimulation?: boolean; previewOnly?: boolean }) => Promise<SimulationResult | null>>(async () => null);

  // Clear pendingApproval on error
  useEffect(() => {
    if (status === "error" || approveError) {
      setPendingApproval(null);
      autoExecuteRef.current = false;
      if (actionState === "needsApproval") setActionState("idle");
    }
  }, [status, approveError, actionState, resetApprove]);

  // Clear pendingApproval when quote changes (user changed amount/token/direction)
  useEffect(() => {
    if (actionState === "needsApproval") {
      setPendingApproval(null);
      setActionState("idle");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote]);

  // Approve tokens — exact=true uses the quote amount, exact=false uses unlimited
  const approve = useCallback((exact: boolean) => {
    if (!userAddress || isEth || !tokenAddress || !routerAddress || !quote) return;
    setActionState("approving");
    autoExecuteRef.current = true;

    let amount: bigint;
    if (exact) {
      try {
        amount = parseUnits(quote.inputAmount, quote.inputToken.decimals);
      } catch {
        amount = maxUint256;
      }
    } else {
      amount = maxUint256;
    }
    if (process.env.NODE_ENV === "development") {
      console.log("[Approve TX]", {
        type: "erc20",
        token: tokenAddress,
        spender: routerAddress,
        amount: amount.toString(),
        exact,
      });
    }
    writeApprove({
      address: tokenAddress,
      abi: ERC20_APPROVAL_ABI,
      functionName: "approve",
      args: [routerAddress, amount],
    });
  }, [userAddress, isEth, tokenAddress, routerAddress, quote, writeApprove]);

  // Internal execute — skips approval check, used directly and after auto-approval
  // Options:
  //   - skipSimulation: skip simulation and send tx directly (used after preview confirmation)
  //   - previewOnly: run simulation but don't send tx (for preview mode)
  // Returns the simulation result when previewOnly is true, otherwise returns null
  const executeZapInternal = useCallback(async (options?: { skipSimulation?: boolean; previewOnly?: boolean }): Promise<SimulationResult | null> => {
    if (!quote || !userAddress || !publicClient) return null;

    // Clear any previous simulation error
    setSimulationError(null);
    setSimulationResult(null);
    setActionState("simulating");

    const txParams = {
      to: quote.tx.to as `0x${string}`,
      data: quote.tx.data as `0x${string}`,
      value: BigInt(quote.tx.value || "0"),
    };

    if (process.env.NODE_ENV === "development") {
      console.log("[TX]", {
        fn: "zap",
        to: txParams.to,
        selector: txParams.data.slice(0, 10),
        value: txParams.value.toString(),
        dataLength: txParams.data.length,
        data: txParams.data,
        previewOnly: !!options?.previewOnly,
        skipSimulation: !!options?.skipSimulation,
      });
    }

    // If skipSimulation is true, go straight to sending (used after preview mode confirmation)
    if (options?.skipSimulation && simulationResult?.success) {
      setActionState("zapping");
      if (isFlashbotsEnabled && !isTenderlyVNet && chainId === 1) {
        try {
          const hash = await sendViaFlashbots(txParams);
          setFlashbotsHash(hash);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const isUnsupportedMethod = errorMsg.includes("eth_signTransaction") &&
            (errorMsg.includes("not supported") || errorMsg.includes("does not exist"));
          if (isUnsupportedMethod) {
            sendTransaction(txParams);
          } else {
            setFlashbotsError(err instanceof Error ? err : new Error(errorMsg));
            setActionState("idle");
          }
        }
      } else {
        sendTransaction(txParams);
      }
      return null;
    }

    // Three-way simulation:
    // 1. Mainnet → Tenderly REST API
    // 2. Tenderly VNet → VNet RPC simulation
    // 3. Anvil / chainId 1337 → skip (eth_call only below)
    const simPromise = (testNetworkType === null && chainId !== 1337)
      ? (async () => {
          try {
            const nonceResponse = await fetch("/api/simulate/nonce", {
              method: "GET",
              headers: { "Content-Type": "application/json" },
              signal: AbortSignal.timeout(5_000), // 5s timeout
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
              signal: AbortSignal.timeout(20_000), // 20s timeout
            });

            const result = (await response.json()) as SimulationResult & { retryable?: boolean };

            if (process.env.NODE_ENV === "development") {
              console.log("[Tenderly Simulation]", {
                success: result.success,
                simulationId: result.simulationId,
                tenderlyUrl: result.tenderlyUrl,
                gasUsed: result.gasUsed,
                errorMessage: result.errorMessage,
                assetChanges: result.assetChanges?.length ?? 0,
              });
            }

            if (result.success) return { ok: true as const, result };
            return {
              ok: false as const,
              result,
              errorMessage: result.errorMessage ?? "Tenderly simulation failed",
              retryable: Boolean(result.retryable),
            };
          } catch (error) {
            return {
              ok: false as const,
              result: null,
              errorMessage: error instanceof Error ? error.message : "Tenderly simulation failed",
              retryable: true,
            };
          }
        })()
      : (testNetworkType === "tenderly" && publicClient)
        ? runVNetSimulation(
            publicClient.transport,
            { from: userAddress, to: quote.tx.to, data: quote.tx.data, value: quote.tx.value ?? "0x0" },
            userAddress,
          )
        : Promise.resolve({ ok: true as const, result: null });

    const ethCallPromise = (async () => {
      try {
        await publicClient.call({
          account: userAddress,
          ...txParams,
        });
        if (process.env.NODE_ENV === "development") console.log("[eth_call]", { ok: true, to: txParams.to });
        return { ok: true as const };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        if (process.env.NODE_ENV === "development") console.log("[eth_call]", { ok: false, to: txParams.to, error: msg });
        return {
          ok: false as const,
          errorMessage: msg,
        };
      }
    })();

    const [simResult, ethCallResult] = await Promise.all([
      simPromise,
      ethCallPromise,
    ]);

    // Store the simulation result for preview mode
    if (simResult.result) {
      setSimulationResult(simResult.result);
    }

    if (!simResult.ok && !ethCallResult.ok) {
      const rawMsg = (simResult as { retryable?: boolean }).retryable
        ? ethCallResult.errorMessage ?? simResult.errorMessage
        : simResult.errorMessage;
      const errorMsg = typeof rawMsg === "string" ? rawMsg : (rawMsg as { message?: string })?.message ?? "Simulation failed";
      setSimulationError(
        parseErrorMessage(new Error(errorMsg), "Transaction would fail")
      );
      setActionState("idle");
      return simResult.result ?? null;
    }

    // If previewOnly mode, stop here without sending tx and return simulation result
    if (options?.previewOnly) {
      setActionState("idle");
      return simResult.result ?? null;
    }

    // Simulation passed - send the actual transaction
    setActionState("zapping");
    console.log("[Zap] Simulation passed, sending tx", { isFlashbotsEnabled, isTenderlyVNet, chainId });

    // Use Flashbots Protect for MEV protection (unless disabled or on VNet)
    if (isFlashbotsEnabled && !isTenderlyVNet && chainId === 1) {
      console.log("[Zap] Using Flashbots Protect");
      try {
        const hash = await sendViaFlashbots(txParams);
        setFlashbotsHash(hash);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.warn("[Zap] Flashbots error:", errorMsg);

        // If wallet doesn't support eth_signTransaction, fall back to regular tx
        // Frame, some hardware wallets, and older wallets don't support signing without broadcasting
        const isUnsupportedMethod = errorMsg.includes("eth_signTransaction") &&
          (errorMsg.includes("not supported") || errorMsg.includes("does not exist"));

        if (isUnsupportedMethod) {
          console.log("[Zap] Wallet doesn't support eth_signTransaction, falling back to regular tx");
          sendTransaction(txParams);
        } else {
          // Other errors - don't fall back, show error to user
          setFlashbotsError(err instanceof Error ? err : new Error(errorMsg));
          setActionState("idle");
        }
      }
    } else {
      // Use wallet's default RPC (user preference or VNet/testnet)
      console.log("[Zap] Using wallet sendTransaction");
      sendTransaction(txParams);
    }
    return null;
  }, [quote, userAddress, publicClient, sendTransaction, sendViaFlashbots, isFlashbotsEnabled, chainId, isTenderlyVNet, testNetworkType, simulationResult]);

  // Keep ref in sync with latest executeZapInternal
  executeZapInternalRef.current = executeZapInternal;

  // Auto-execute zap after approval succeeds
  // After approval confirms, isApprovalPending goes false but actionState stays "approving",
  // so status transitions from "waitingApproval" → "approving" (not "idle").
  const prevStatus = useRef<ZapStatus>("idle");
  useEffect(() => {
    if (
      autoExecuteRef.current &&
      prevStatus.current === "waitingApproval" &&
      (status === "idle" || status === "needsApproval" || status === "approving")
    ) {
      // Approval completed — clear approval state and execute zap
      autoExecuteRef.current = false;
      setPendingApproval(null);
      setActionState("idle");
      // Preserve original options (e.g. previewOnly) from before approval
      const options = pendingOptionsRef.current;
      pendingOptionsRef.current = undefined;
      // Small delay to ensure allowance is refetched
      setTimeout(() => {
        executeZapInternalRef.current(options);
      }, 100);
    }
    prevStatus.current = status;
  }, [status]);

  // Public executeZap — checks approval before executing.
  // If approval is needed, sets pendingApproval and shows the approval card.
  // The zap auto-executes after approval via the effect above.
  const executeZap = useCallback(async (options?: { skipSimulation?: boolean; previewOnly?: boolean }): Promise<SimulationResult | null> => {
    if (!quote || !userAddress) return null;

    // Clear stale wagmi error state from previous attempts (e.g., wallet rejection)
    resetApprove();
    resetZap();

    // Check if approval is needed
    if (needsApproval()) {
      // Store options so auto-execute after approval preserves intent (e.g. previewOnly)
      pendingOptionsRef.current = options;
      // Set pending approval state to show the approval card
      const tokenSymbol = quote.inputToken.symbol;
      let amountWei: bigint | undefined;
      try {
        amountWei = parseUnits(quote.inputAmount, quote.inputToken.decimals);
      } catch {
        // fallback: don't show exact amount
      }
      setPendingApproval({
        type: "erc20",
        token: tokenAddress!,
        tokenSymbol,
        spender: routerAddress!,
        spenderName: "Enso Router",
        amount: amountWei,
      });
      setActionState("needsApproval");
      return null;
    }

    // No approval needed — execute directly
    return executeZapInternal(options);
  }, [quote, userAddress, needsApproval, tokenAddress, routerAddress, executeZapInternal, resetApprove, resetZap]);

  // Reset state
  const reset = useCallback(() => {
    setActionState("idle");
    setSimulationError(null);
    setSimulationResult(null);
    setFlashbotsHash(undefined);
    setFlashbotsError(null);
    setPendingApproval(null);
    autoExecuteRef.current = false;
    pendingOptionsRef.current = undefined;
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
    isLoading: status !== "idle" && status !== "needsApproval" && status !== "success" && status !== "error" && status !== "reverted",
    isSuccess: status === "success",
    isReverted: status === "reverted",
    zapHash: activeZapHash,
    refetchAllowance,
    // Approval state for ApprovalCard
    pendingApproval,
    approvalProgress,
    isApproving,
    // Flashbots Protect settings
    isFlashbotsEnabled,
    isFlashbotsSupported,
    toggleFlashbots,
    // Simulation result for preview mode
    simulationResult,
  };
}
