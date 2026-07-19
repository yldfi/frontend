"use client";

import { useReadContract, useWaitForTransactionReceipt, useAccount, usePublicClient } from "wagmi";
import { useDirectWriteContract as useWriteContract } from "@/hooks/useDirectWriteContract";
import { parseUnits, maxUint256, encodeFunctionData } from "viem";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { ERC20_APPROVAL_ABI, VAULT_ABI } from "@/lib/abis";
import { shouldResetApprovalToZeroFirst } from "@/lib/approval-reset";
import type { SimulationResult } from "@/types/enso";
import { useTestNetwork } from "@/contexts/TestNetworkContext";
import { useSendTx } from "@/hooks/useSendTx";
import { runVNetSimulation } from "@/lib/vnet-simulation";
import { parseErrorMessage, anvilCall } from "@/lib/tx-utils";

export type TransactionStatus = "idle" | "approving" | "waitingApproval" | "depositing" | "withdrawing" | "waitingTx" | "success" | "reverted" | "error";

export function useVaultActions(
  vaultAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  decimals: number = 18
) {
  const { address: userAddress, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { testNetworkType } = useTestNetwork();
  const { sendTx } = useSendTx();
  const [actionState, setActionState] = useState<"idle" | "approving" | "simulating" | "depositing" | "withdrawing">("idle");
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);

  // Stored pending tx for executeAfterPreview
  const pendingTx = useRef<{
    type: "deposit" | "withdraw";
    args: readonly [bigint, `0x${string}`] | readonly [bigint, `0x${string}`, `0x${string}`];
  } | null>(null);

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

  // Approval via writeContract (no MEV risk)
  const {
    writeContract: writeApprove,
    data: approveHash,
    reset: resetApprove,
    error: approveError,
  } = useWriteContract();

  const [depositHash, setDepositHash] = useState<`0x${string}` | undefined>();
  const [withdrawHash, setWithdrawHash] = useState<`0x${string}` | undefined>();
  const [txError, setTxError] = useState<Error | null>(null);
  const [approvalResetFlow, setApprovalResetFlow] = useState<{
    stage: "reset" | "approve";
    token: `0x${string}`;
    spender: `0x${string}`;
    amount: bigint;
  } | null>(null);
  const handledApprovalHashRef = useRef<`0x${string}` | undefined>(undefined);

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

  // Log receipts in dev mode
  useEffect(() => {
    if (process.env.NODE_ENV === "development" && approvalReceipt) {
      console.log("[Approve Receipt]", { hash: approveHash, status: approvalReceipt.status, gasUsed: approvalReceipt.gasUsed.toString(), blockNumber: approvalReceipt.blockNumber.toString() });
    }
  }, [approvalReceipt, approveHash]);

  useEffect(() => {
    if (process.env.NODE_ENV === "development" && depositReceipt) {
      console.log("[TX Receipt]", { hash: depositHash, status: depositReceipt.status, gasUsed: depositReceipt.gasUsed.toString(), blockNumber: depositReceipt.blockNumber.toString() });
    }
  }, [depositReceipt, depositHash]);

  useEffect(() => {
    if (process.env.NODE_ENV === "development" && withdrawReceipt) {
      console.log("[TX Receipt]", { hash: withdrawHash, status: withdrawReceipt.status, gasUsed: withdrawReceipt.gasUsed.toString(), blockNumber: withdrawReceipt.blockNumber.toString() });
    }
  }, [withdrawReceipt, withdrawHash]);

  // Derive status from state (avoids setState in effects)
  const status: TransactionStatus = useMemo(() => {
    // On-chain state takes priority - if we have a receipt, respect its status
    // This handles the case where a tx is mined but reverts on-chain
    if (isApprovalReverted || isDepositReverted || isWithdrawReverted) return "reverted";
    if (isDepositSuccess || isWithdrawSuccess) return "success";
    if (approvalResetFlow && (isApprovalPending || isApprovalSuccess)) return "waitingApproval";
    if (isApprovalSuccess) return "idle";
    // Error states for pre-send failures (wallet rejection, simulation failure, RPC errors)
    if (approveError || txError || simulationError) return "error";
    // Pending transaction states
    if (isApprovalPending) return "waitingApproval";
    if (isDepositPending || isWithdrawPending) return "waitingTx";
    // User-initiated action states
    if (actionState === "approving") return "approving";
    if (actionState === "simulating") return "depositing"; // Show as depositing/withdrawing to user
    if (actionState === "depositing") return "depositing";
    if (actionState === "withdrawing") return "withdrawing";
    return "idle";
  }, [
    approveError, txError, simulationError,
    isApprovalReverted, isDepositReverted, isWithdrawReverted,
    isDepositSuccess, isWithdrawSuccess, isApprovalSuccess, approvalResetFlow,
    isApprovalPending, isDepositPending, isWithdrawPending,
    actionState
  ]);

  // Derive error message from errors or reverts
  const error = useMemo(() => {
    if (simulationError) return simulationError;
    if (approveError) return parseErrorMessage(approveError, "Approval failed");
    if (txError) return parseErrorMessage(txError, "Transaction failed");
    if (isApprovalReverted) return "Approval transaction reverted";
    if (isDepositReverted) return "Deposit transaction reverted";
    if (isWithdrawReverted) return "Withdraw transaction reverted";
    return null;
  }, [simulationError, approveError, txError, isApprovalReverted, isDepositReverted, isWithdrawReverted]);

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

  // Approve (exact or unlimited)
  const approve = useCallback(async (exactAmount?: bigint) => {
    if (!userAddress) return;
    setActionState("approving");

    const amount = exactAmount ?? maxUint256;
    if (process.env.NODE_ENV === "development") {
      console.log("[Approve TX]", {
        type: "erc20",
        token: tokenAddress,
        spender: vaultAddress,
        amount: amount.toString(),
        exact: !!exactAmount,
      });
    }

    const needsZeroReset = await shouldResetApprovalToZeroFirst({
      publicClient,
      owner: userAddress,
      token: tokenAddress,
      spender: vaultAddress,
      amount,
      currentAllowance: allowance as bigint | undefined,
    });

    if (needsZeroReset) {
      setApprovalResetFlow({
        stage: "reset",
        token: tokenAddress,
        spender: vaultAddress,
        amount,
      });
      writeApprove({
        address: tokenAddress,
        abi: ERC20_APPROVAL_ABI,
        functionName: "approve",
        args: [vaultAddress, 0n],
      });
      return;
    }

    setApprovalResetFlow(null);
    writeApprove({
      address: tokenAddress,
      abi: ERC20_APPROVAL_ABI,
      functionName: "approve",
      args: [vaultAddress, amount],
    });
  }, [userAddress, tokenAddress, vaultAddress, publicClient, allowance, writeApprove]);

  useEffect(() => {
    if (!isApprovalSuccess || !approveHash || !approvalResetFlow || handledApprovalHashRef.current === approveHash) return;

    handledApprovalHashRef.current = approveHash;

    if (approvalResetFlow.stage === "reset") {
      const nextFlow = { ...approvalResetFlow, stage: "approve" as const };
      queueMicrotask(() => setApprovalResetFlow(nextFlow));
      resetApprove();
      writeApprove({
        address: nextFlow.token,
        abi: ERC20_APPROVAL_ABI,
        functionName: "approve",
        args: [nextFlow.spender, nextFlow.amount],
      });
      return;
    }

    queueMicrotask(() => setApprovalResetFlow(null));
  }, [isApprovalSuccess, approveHash, approvalResetFlow, resetApprove, writeApprove]);

  // Run simulation + eth_call in parallel for a vault call
  // Three-way: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
  const runSimulation = useCallback(async (
    calldata: `0x${string}`,
    value: bigint = 0n,
  ): Promise<SimulationResult | null> => {
    if (!userAddress || !publicClient) return null;

    // Build simulation promise based on network type
    const simPromise = (testNetworkType === null && chainId !== 1337)
      ? (async () => {
          try {
            const nonceResponse = await fetch("/api/simulate/nonce", {
              signal: AbortSignal.timeout(5_000), // 5s timeout
            });
            const nonceResult = (await nonceResponse.json()) as {
              success: boolean;
              nonce?: string;
              expires?: number;
              sig?: string;
            };

            if (!nonceResult.success || !nonceResult.nonce || !nonceResult.expires || !nonceResult.sig) {
              return { ok: false as const, errorMessage: "Failed to obtain simulation nonce", retryable: true };
            }

            const response = await fetch("/api/simulate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                from: userAddress,
                to: vaultAddress,
                data: calldata,
                value: value.toString(),
                nonce: nonceResult.nonce,
                expires: nonceResult.expires,
                sig: nonceResult.sig,
              }),
              signal: AbortSignal.timeout(20_000), // 20s timeout
            });

            const result = (await response.json()) as SimulationResult & { retryable?: boolean };

            if (process.env.NODE_ENV === "development") {
              console.log("[Tenderly Vault Simulation]", {
                success: result.success,
                simulationId: result.simulationId,
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
          } catch (err) {
            return {
              ok: false as const,
              result: null,
              errorMessage: err instanceof Error ? err.message : "Tenderly simulation failed",
              retryable: true,
            };
          }
        })()
      : (testNetworkType === "tenderly")
        ? runVNetSimulation(
            publicClient.transport,
            { from: userAddress, to: vaultAddress, data: calldata, value: `0x${value.toString(16)}` },
            userAddress,
          )
        : Promise.resolve({ ok: true as const, result: null });

    const ethCallPromise = (async () => {
      try {
        await anvilCall(publicClient, {
          account: userAddress,
          to: vaultAddress,
          data: calldata,
          value,
        });
        if (process.env.NODE_ENV === "development") console.log("[eth_call]", { ok: true, to: vaultAddress });
        return { ok: true as const };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        if (process.env.NODE_ENV === "development") console.log("[eth_call]", { ok: false, to: vaultAddress, error: msg });
        return {
          ok: false as const,
          errorMessage: err instanceof Error ? err.message : "Unknown error",
        };
      }
    })();

    const [simResult, ethCallResult] = await Promise.all([simPromise, ethCallPromise]);

    // Store the simulation result
    if (simResult.result) {
      setSimulationResult(simResult.result);
    }

    if (!simResult.ok && !ethCallResult.ok) {
      const rawMsg = (simResult as { retryable?: boolean }).retryable
        ? ethCallResult.errorMessage ?? simResult.errorMessage
        : simResult.errorMessage;
      const errorMsg = typeof rawMsg === "string" ? rawMsg : (rawMsg as { message?: string })?.message ?? "Simulation failed";
      setSimulationError(parseErrorMessage(new Error(errorMsg), "Transaction would fail"));
      setActionState("idle");
      return simResult.result ?? null;
    }

    // Tenderly is unavailable (network error/timeout — e.g. its first look at a
    // freshly deployed contract runs slow) but the chain-level eth_call passed.
    // Surface the "simulation unavailable" modal state instead of silently
    // falling through to a real wallet signature with no preview at all.
    // Mirrors the same fallback in useZapActions.
    if (!simResult.ok && ethCallResult.ok) {
      const rawMsg = simResult.errorMessage;
      const unavailableReason = typeof rawMsg === "string"
        ? rawMsg
        : (rawMsg as { message?: string; slug?: string } | null)?.message
          ?? (rawMsg as { message?: string; slug?: string } | null)?.slug
          ?? "Simulation temporarily unavailable";
      const unavailableResult: SimulationResult = simResult.result
        ? {
            ...simResult.result,
            success: true,
            simulationUnavailable: true,
            simulationUnavailableReason: unavailableReason,
            errorMessage: null,
          }
        : {
            success: true,
            gasUsed: null,
            simulationId: null,
            tenderlyUrl: null,
            assetChanges: [],
            errorMessage: null,
            simulationUnavailable: true,
            simulationUnavailableReason: unavailableReason,
          };
      setSimulationResult(unavailableResult);
      setActionState("idle");
      return unavailableResult;
    }

    return simResult.result ?? null;
  }, [userAddress, vaultAddress, publicClient, testNetworkType, chainId]);

  // Deposit with pre-flight simulation
  // Options: previewOnly — when true, run Tenderly simulation and return result without sending tx
  const deposit = useCallback(async (amount: string, options?: { previewOnly?: boolean }): Promise<SimulationResult | null> => {
    if (!userAddress || !amount || !publicClient) return null;

    setSimulationError(null);
    setSimulationResult(null);
    setTxError(null);
    setDepositHash(undefined);
    setActionState("simulating");

    const amountWei = parseUnits(amount, decimals);

    if (options?.previewOnly) {
      // Tenderly preview mode: encode calldata, run Tenderly + eth_call
      const calldata = encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "deposit",
        args: [amountWei, userAddress],
      });

      // Store pending tx for executeAfterPreview
      pendingTx.current = { type: "deposit", args: [amountWei, userAddress] };

      const result = await runSimulation(calldata);
      // If simulation succeeded (or was previewOnly), stay idle so modal can show
      if (result) {
        setActionState("idle");
      }
      return result;
    }

    // Standard path: viem simulateContract + send
    try {
      await publicClient.simulateContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: "deposit",
        args: [amountWei, userAddress],
        account: userAddress,
      });
    } catch (simError: unknown) {
      const errorMsg = simError instanceof Error ? simError.message : "Unknown error";
      setSimulationError(parseErrorMessage(new Error(errorMsg), "Deposit would fail"));
      setActionState("idle");
      return null;
    }

    // Simulation passed - send transaction
    setActionState("depositing");
    if (process.env.NODE_ENV === "development") {
      console.log("[TX]", { fn: "deposit", to: vaultAddress, amount: amountWei.toString(), receiver: userAddress });
    }
    try {
      const calldata = encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "deposit",
        args: [amountWei, userAddress],
      });
      const hash = await sendTx({ to: vaultAddress, data: calldata });
      setDepositHash(hash);
    } catch (err) {
      setTxError(err instanceof Error ? err : new Error(String(err)));
      setActionState("idle");
    }
    return null;
  }, [userAddress, vaultAddress, decimals, publicClient, sendTx, runSimulation]);

  // Withdraw with pre-flight simulation (using redeem for shares)
  // Options: previewOnly — when true, run Tenderly simulation and return result without sending tx
  const withdraw = useCallback(async (shares: string, options?: { previewOnly?: boolean }): Promise<SimulationResult | null> => {
    if (!userAddress || !shares || !publicClient) return null;

    setSimulationError(null);
    setSimulationResult(null);
    setTxError(null);
    setWithdrawHash(undefined);
    setActionState("simulating");

    const sharesWei = parseUnits(shares, decimals);

    if (options?.previewOnly) {
      // Tenderly preview mode
      const calldata = encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "redeem",
        args: [sharesWei, userAddress, userAddress],
      });

      pendingTx.current = { type: "withdraw", args: [sharesWei, userAddress, userAddress] };

      const result = await runSimulation(calldata);
      if (result) {
        setActionState("idle");
      }
      return result;
    }

    // Standard path: viem simulateContract + send
    try {
      await publicClient.simulateContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: "redeem",
        args: [sharesWei, userAddress, userAddress],
        account: userAddress,
      });
    } catch (simError: unknown) {
      const errorMsg = simError instanceof Error ? simError.message : "Unknown error";
      setSimulationError(parseErrorMessage(new Error(errorMsg), "Withdraw would fail"));
      setActionState("idle");
      return null;
    }

    // Simulation passed - send transaction
    setActionState("withdrawing");
    if (process.env.NODE_ENV === "development") {
      console.log("[TX]", { fn: "redeem", to: vaultAddress, shares: sharesWei.toString(), receiver: userAddress });
    }
    try {
      const calldata = encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "redeem",
        args: [sharesWei, userAddress, userAddress],
      });
      const hash = await sendTx({ to: vaultAddress, data: calldata });
      setWithdrawHash(hash);
    } catch (err) {
      setTxError(err instanceof Error ? err : new Error(String(err)));
      setActionState("idle");
    }
    return null;
  }, [userAddress, vaultAddress, decimals, publicClient, sendTx, runSimulation]);

  // Execute stored pending tx after user confirms simulation preview
  const executeAfterPreview = useCallback(async () => {
    if (!pendingTx.current) return;

    const { type, args } = pendingTx.current;
    pendingTx.current = null;

    try {
      if (type === "deposit") {
        setActionState("depositing");
        const calldata = encodeFunctionData({
          abi: VAULT_ABI,
          functionName: "deposit",
          args: args as readonly [bigint, `0x${string}`],
        });
        const hash = await sendTx({ to: vaultAddress, data: calldata });
        setDepositHash(hash);
      } else {
        setActionState("withdrawing");
        const calldata = encodeFunctionData({
          abi: VAULT_ABI,
          functionName: "redeem",
          args: args as readonly [bigint, `0x${string}`, `0x${string}`],
        });
        const hash = await sendTx({ to: vaultAddress, data: calldata });
        setWithdrawHash(hash);
      }
    } catch (err) {
      setTxError(err instanceof Error ? err : new Error(String(err)));
      setActionState("idle");
    }
  }, [vaultAddress, sendTx]);

  // Reset state
  const reset = useCallback(() => {
    setActionState("idle");
    setSimulationError(null);
    setSimulationResult(null);
    setTxError(null);
    setDepositHash(undefined);
    setWithdrawHash(undefined);
    pendingTx.current = null;
    setApprovalResetFlow(null);
    handledApprovalHashRef.current = undefined;
    resetApprove();
  }, [resetApprove]);

  return {
    allowance: allowance as bigint | undefined,
    needsApproval,
    approve,
    deposit,
    withdraw,
    executeAfterPreview,
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
    // Simulation result for preview mode
    simulationResult,
  };
}
