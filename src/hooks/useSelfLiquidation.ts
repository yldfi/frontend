"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";
import { useTxReceipt } from "@/hooks/useTxReceipt";
import { useDirectWriteContract as useWriteContract } from "@/hooks/useDirectWriteContract";
import { encodeFunctionData, maxUint256, toFunctionSelector } from "viem";
import { CRVUSD_ADDRESS } from "@/config/addresses";
import { ERC20_APPROVAL_ABI } from "@/lib/abis";
import { shouldResetApprovalToZeroFirst } from "@/lib/approval-reset";
import { FORBIDDEN_APPROVAL_SPENDER_ERROR, isForbiddenApprovalSpender } from "@/lib/approval-safety";
import { useSendTx } from "@/hooks/useSendTx";
import type { SimulationResult } from "@/types/enso";
import { useTestNetwork } from "@/contexts/TestNetworkContext";
import { runVNetSimulation } from "@/lib/vnet-simulation";
import { snapshotTx, logTxDiff } from "@/lib/dev-logging";
import { parseEnsoError, parseErrorMessage, runTenderlySimulation, checkAllowance, anvilCall } from "@/lib/tx-utils";
import type { PendingApproval } from "@/types/approval";

// ABI for direct controller.liquidate (user == msg.sender → self-liquidation)
const CONTROLLER_LIQUIDATE_ABI = [
  {
    name: "liquidate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "min_x", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "liquidate_extended",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "min_x", type: "uint256" },
      { name: "frac", type: "uint256" },
      { name: "callbacker", type: "address" },
      { name: "callback_args", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

export type SelfLiquidationStatus =
  | "idle"
  | "building"       // Encoding tx
  | "simulating"     // Running Tenderly simulation
  | "needsApproval"  // Waiting for user to approve crvUSD
  | "approving"      // Approval tx sent, waiting for confirmation
  | "executing"      // Sending main transaction
  | "waitingTx"      // Waiting for main tx to confirm
  | "success"
  | "reverted"
  | "error";

interface PendingTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  inputToken: string;
}

export interface UseSelfLiquidationResult {
  /**
   * Self-liquidate via controller.liquidate / liquidate_extended called directly by the user.
   * If crvUsdGap > 0, the user provides the shortfall from their wallet (ERC20 approval to controller).
   */
  directLiquidate: (
    controller: `0x${string}`,
    percentage: bigint, // 1e18 scale (100% = 10n**18n)
    previewOnly?: boolean,
    crvUsdGap?: bigint
  ) => Promise<SimulationResult | null>;

  // Approval
  pendingApproval: PendingApproval | null;
  approvalProgress: {
    step: number;
    total: number;
    steps: { label: string; description: string; done: boolean; spender?: string }[];
  } | null;
  approve: (exactAmount?: boolean) => void;
  isApproving: boolean;
  isApprovalSuccess: boolean;
  executeAfterApproval: () => Promise<void>;
  wasApprovalRequested: () => boolean;

  // State
  status: SelfLiquidationStatus;
  txHash: `0x${string}` | null;
  error: string | null;
  simulationResult: SimulationResult | null;
  reset: () => void;
  clearError: () => void;
  executeAfterPreview: () => Promise<void>;
}

function ethCallErrorMessage(err: unknown): string {
  const viemErr = err as { shortMessage?: string; message?: string; data?: string; cause?: { reason?: string; data?: string } };
  const revertData = viemErr.data || viemErr.cause?.data;
  let msg = viemErr.message || viemErr.shortMessage || viemErr.cause?.reason || "eth_call failed";
  if (revertData && typeof revertData === "string" && revertData.startsWith("0x")) {
    const enso = parseEnsoError(revertData.replace(/^0x/, ""));
    if (enso) {
      if (process.env.NODE_ENV === "development") console.log(`[eth_call] Enso error | step: ${enso.step} | target: ${enso.target} | message: ${enso.message}`);
      msg = `enso:${enso.message}`;
    } else {
      msg = msg + " custom error " + revertData;
    }
  }
  return msg;
}

export function useSelfLiquidation(): UseSelfLiquidationResult {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const { testNetworkType } = useTestNetwork();
  const { sendTx } = useSendTx();

  const invalidateBalances = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["onchain-balances"] });
    queryClient.invalidateQueries({ queryKey: ["enso-wallet-balances"] });
    queryClient.invalidateQueries({ queryKey: ["curveLendingPosition"] });
  }, [queryClient]);

  const [status, setStatus] = useState<SelfLiquidationStatus>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [pendingTx, setPendingTx] = useState<PendingTx | null>(null);
  const [pendingController, setPendingController] = useState<`0x${string}` | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [approvalProgress, setApprovalProgress] = useState<{
    step: number;
    total: number;
    steps: { label: string; description: string; done: boolean; spender?: string }[];
  } | null>(null);
  const [approvalResetFlow, setApprovalResetFlow] = useState<{
    stage: "reset" | "approve";
    token: `0x${string}`;
    spender: `0x${string}`;
    amount: bigint;
  } | null>(null);
  const handledApprovalHashRef = useRef<`0x${string}` | undefined>(undefined);
  // Track whether the original call requested previewOnly — set synchronously before returning null
  const pendingPreviewRef = useRef(false);

  // Approval tx
  const {
    writeContract: writeApprove,
    data: approveHash,
    reset: resetApprove,
    isError: isApproveError,
  } = useWriteContract();

  const { isLoading: isApprovalPending, isSuccess: isRawApprovalSuccess } = useTxReceipt({
    hash: approveHash,
    pollingInterval: 1_000,
  });
  const isApprovalSuccess = isRawApprovalSuccess && !approvalResetFlow;

  const effectiveStatus: SelfLiquidationStatus =
    isApproveError && status === "approving" ? "needsApproval" : status;

  useTxReceipt({
    hash: txHash ?? undefined,
    query: { enabled: !!txHash && effectiveStatus === "waitingTx" },
  });

  const isApproving = useMemo(() => {
    return effectiveStatus === "approving" || isApprovalPending;
  }, [effectiveStatus, isApprovalPending]);

  const reset = useCallback(() => {
    setStatus("idle");
    setTxHash(null);
    setError(null);
    setSimulationResult(null);
    setPendingTx(null);
    setPendingController(null);
    setPendingApproval(null);
    setApprovalProgress(null);
    setApprovalResetFlow(null);
    pendingPreviewRef.current = false;
    handledApprovalHashRef.current = undefined;
    resetApprove();
  }, [resetApprove]);

  const clearError = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  const rejectForbiddenApproval = useCallback(() => {
    setPendingApproval(null);
    setApprovalProgress(null);
    setApprovalResetFlow(null);
    pendingPreviewRef.current = false;
    setError(FORBIDDEN_APPROVAL_SPENDER_ERROR);
    setStatus("error");
  }, []);

  // ERC20 approval (crvUSD → controller for the repay shortfall)
  const approve = useCallback(async (exactAmount?: boolean) => {
    if (!address || !pendingApproval) return;

    if (isForbiddenApprovalSpender(pendingApproval.spender)) {
      rejectForbiddenApproval();
      return;
    }

    setStatus("approving");

    const amount = exactAmount && pendingApproval.amount ? pendingApproval.amount : maxUint256;
    if (process.env.NODE_ENV === "development") {
      console.log(`[Approve TX] ERC20 ${pendingApproval.tokenSymbol} (${pendingApproval.token}) → spender ${pendingApproval.spender} | amount: ${amount === maxUint256 ? "MAX_UINT256" : amount.toString()} | exact: ${!!exactAmount}`);
    }
    const needsZeroReset = await shouldResetApprovalToZeroFirst({
      publicClient,
      owner: address,
      token: pendingApproval.token,
      spender: pendingApproval.spender,
      amount,
    });

    if (needsZeroReset) {
      setApprovalResetFlow({
        stage: "reset",
        token: pendingApproval.token,
        spender: pendingApproval.spender,
        amount,
      });
      writeApprove({
        address: pendingApproval.token,
        abi: ERC20_APPROVAL_ABI,
        functionName: "approve",
        args: [pendingApproval.spender, 0n],
      });
      return;
    }

    setApprovalResetFlow(null);
    writeApprove({
      address: pendingApproval.token,
      abi: ERC20_APPROVAL_ABI,
      functionName: "approve",
      args: [pendingApproval.spender, amount],
    });
  }, [address, pendingApproval, publicClient, rejectForbiddenApproval, writeApprove]);

  useEffect(() => {
    if (!isRawApprovalSuccess || !approveHash || !approvalResetFlow || handledApprovalHashRef.current === approveHash) return;

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
  }, [isRawApprovalSuccess, approveHash, approvalResetFlow, resetApprove, writeApprove]);

  const simulateAndExecute = useCallback(async (
    txData: PendingTx,
    previewOnly: boolean
  ): Promise<SimulationResult | null> => {
    if (!publicClient || !address) return null;

    if (process.env.NODE_ENV === "development") {
      const selector = txData.data.slice(0, 10);
      const knownSelectors: Record<string, string> = {};
      for (const entry of CONTROLLER_LIQUIDATE_ABI) {
        const sig = `${entry.name}(${entry.inputs.map((i: { type: string }) => i.type).join(",")})`;
        try {
          knownSelectors[toFunctionSelector(sig)] = sig;
        } catch { /* skip malformed */ }
      }
      const fnName = knownSelectors[selector] ?? `unknown(${selector})`;
      console.log(`[TX] ${fnName} → to: ${txData.to} | value: ${txData.value.toString()} wei | inputToken: ${txData.inputToken} | dataLen: ${txData.data.length} | previewOnly: ${previewOnly}`);
      console.log(`[TX data] ${txData.data}`);
    }

    const runEthCall = async (): Promise<{ ok: true } | { ok: false; errorMessage: string }> => {
      try {
        await anvilCall(publicClient, { account: address, to: txData.to, data: txData.data, value: txData.value });
        if (process.env.NODE_ENV === "development") console.log(`[eth_call] OK | to: ${txData.to} | selector: ${txData.data.slice(0, 10)}`);
        return { ok: true };
      } catch (err: unknown) {
        const msg = ethCallErrorMessage(err);
        if (process.env.NODE_ENV === "development") console.log(`[eth_call] FAILED | to: ${txData.to} | selector: ${txData.data.slice(0, 10)} | error: ${msg.slice(0, 300)}`);
        return { ok: false, errorMessage: msg };
      }
    };

    // Three-way simulation:
    // 1. Mainnet (testNetworkType === null, chainId !== 1337) → Tenderly REST API + eth_call
    // 2. Tenderly VNet (testNetworkType === "tenderly") → VNet RPC simulation + eth_call
    // 3. Anvil (testNetworkType === "anvil" or chainId === 1337) → eth_call only
    if (testNetworkType === null && chainId !== 1337) {
      // --- Mainnet: Tenderly REST API + eth_call ---
      setStatus("simulating");

      const [tenderlyResult, ethCallResult] = await Promise.all([
        runTenderlySimulation(
          address,
          txData.to,
          txData.data,
          String(txData.value),
          txData.inputToken
        ),
        runEthCall(),
      ]);

      // When Tenderly fails (e.g. delegate mode "Unsupported simulation target")
      // but eth_call passes, mark as simulation unavailable rather than failure
      if (!tenderlyResult.ok && ethCallResult.ok && tenderlyResult.result) {
        const unavailableResult: SimulationResult = {
          ...tenderlyResult.result,
          success: true,
          simulationUnavailable: true,
          simulationUnavailableReason: tenderlyResult.errorMessage ?? "Simulation unavailable for this transaction type",
          errorMessage: null,
        };
        setSimulationResult(unavailableResult);
        if (previewOnly) {
          setStatus("idle");
          return unavailableResult;
        }
      } else {
        if (tenderlyResult.result) {
          setSimulationResult(tenderlyResult.result);
        }

        if (previewOnly) {
          setStatus("idle");
          // If eth_call failed, report it even for preview
          if (!ethCallResult.ok) {
            const errorResult: SimulationResult = {
              success: false,
              gasUsed: null,
              simulationId: null,
              tenderlyUrl: null,
              assetChanges: [],
              errorMessage: ethCallResult.errorMessage || "Transaction would revert",
            };
            setSimulationResult(errorResult);
            return errorResult;
          }
          return tenderlyResult.result;
        }
      }

      // eth_call is the ground truth for the chain we're submitting to
      if (!ethCallResult.ok) {
        const errorMsg = ethCallResult.errorMessage || "Simulation failed";
        setError(parseErrorMessage(new Error(errorMsg)));
        setStatus("error");
        return tenderlyResult.result;
      }
      if (!tenderlyResult.ok) {
        if (process.env.NODE_ENV === "development") console.log("[Simulation] Tenderly failed but eth_call passed, proceeding");
      }
    } else if (testNetworkType === "tenderly") {
      // --- Tenderly VNet: RPC simulation + eth_call ---
      setStatus("simulating");

      const [vnetResult, ethCallResult] = await Promise.all([
        runVNetSimulation(
          publicClient.transport,
          { from: address, to: txData.to, data: txData.data, value: `0x${txData.value.toString(16)}` },
          address,
        ),
        runEthCall(),
      ]);

      if (vnetResult.result) {
        setSimulationResult(vnetResult.result);
      }

      if (previewOnly) {
        setStatus("idle");
        return vnetResult.result;
      }

      // eth_call is ground truth
      if (!ethCallResult.ok) {
        const errorMsg = ethCallResult.errorMessage || "Simulation failed";
        setError(parseErrorMessage(new Error(errorMsg)));
        setStatus("error");
        return vnetResult.result;
      }
      if (!vnetResult.ok) {
        if (process.env.NODE_ENV === "development") console.log("[Simulation] VNet sim failed but eth_call passed, proceeding");
      }
    } else {
      // --- Anvil / local: eth_call preflight only ---
      setStatus("simulating");
      const ethCallResult = await runEthCall();
      if (!ethCallResult.ok) {
        setError(parseErrorMessage(new Error(ethCallResult.errorMessage)));
        setStatus("error");
        return null;
      }
      if (previewOnly) {
        setStatus("idle");
        return null; // No Tenderly simulation data on test networks
      }
    }

    // Snapshot position + balances before TX
    let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
    if (process.env.NODE_ENV === "development" && address) {
      snapBefore = await snapshotTx(publicClient, address, pendingController, [txData.inputToken]);
    }

    // Execute (gas estimation + Flashbots handled by useSendTx)
    setStatus("executing");
    const hash = await sendTx({
      to: txData.to,
      data: txData.data,
      value: txData.value,
    });

    setTxHash(hash);
    setStatus("waitingTx");

    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: 60_000, // 60s timeout (Anvil auto-mine can hang on block polling)
      pollingInterval: 1_000,
    });

    if (receipt.status === "success") {
      setStatus("success");
      invalidateBalances();
    } else {
      setStatus("reverted");
      setError("Transaction reverted");
    }
    if (process.env.NODE_ENV === "development") {
      console.log(`[TX Receipt] hash: ${hash} | status: ${receipt.status} | gasUsed: ${receipt.gasUsed.toString()} | blockNumber: ${receipt.blockNumber.toString()}`);
      if (snapBefore && address) {
        const snapAfter = await snapshotTx(publicClient, address, pendingController, [txData.inputToken]);
        logTxDiff("Self-liquidate TX", snapBefore, snapAfter);
      }
    }

    return simulationResult;
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult, pendingController, invalidateBalances]);

  const executeAfterApproval = useCallback(async () => {
    if (!pendingTx) {
      setError("No pending transaction");
      setStatus("error");
      return;
    }

    setPendingApproval(null);
    setApprovalProgress(null);
    // Respect previewOnly from the original call
    const wasPreviewOnly = pendingPreviewRef.current;
    pendingPreviewRef.current = false;
    try {
      await simulateAndExecute(pendingTx, wasPreviewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
    }
  }, [pendingTx, simulateAndExecute]);

  const executeAfterPreview = useCallback(async () => {
    if (!pendingTx || !publicClient) {
      setError("No pending transaction");
      setStatus("error");
      return;
    }

    try {
      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, pendingController, [pendingTx.inputToken]);
      }

      // Execute (gas estimation + Flashbots handled by useSendTx)
      setStatus("executing");
      const hash = await sendTx({
        to: pendingTx.to,
        data: pendingTx.data,
        value: pendingTx.value,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 60_000,
        pollingInterval: 1_000,
      });

      if (receipt.status === "success") {
        setStatus("success");
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }
      if (process.env.NODE_ENV === "development") {
        console.log(`[TX Receipt] hash: ${hash} | status: ${receipt.status} | gasUsed: ${receipt.gasUsed.toString()} | blockNumber: ${receipt.blockNumber.toString()}`);
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, pendingController, [pendingTx.inputToken]);
          logTxDiff("Self-liquidate TX", snapBefore, snapAfter);
        }
      }
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
    }
  }, [pendingTx, publicClient, sendTx, address, pendingController]);

  // Direct self-liquidation: user calls controller.liquidate / liquidate_extended.
  // User == msg.sender → no health check, no liquidation discount.
  // If crvUsdGap > 0, user needs crvUSD in wallet + ERC20 approval to controller.
  const directLiquidate = useCallback(async (
    controller: `0x${string}`,
    percentage: bigint, // 1e18 scale (100% = 10n**18n)
    previewOnly: boolean = false,
    crvUsdGap: bigint = 0n, // crvUSD user needs to provide from wallet
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingTx(null);
      setPendingApproval(null);
      setPendingController(controller);

      const isFullLiquidation = percentage >= 10n ** 18n;

      const data = isFullLiquidation
        ? encodeFunctionData({
            abi: CONTROLLER_LIQUIDATE_ABI,
            functionName: "liquidate",
            args: [address, 0n],
          })
        : encodeFunctionData({
            abi: CONTROLLER_LIQUIDATE_ABI,
            functionName: "liquidate_extended",
            args: [
              address,
              0n, // min_x
              percentage,
              "0x0000000000000000000000000000000000000000" as `0x${string}`, // no callbacker
              [], // no callback_args
            ],
          });

      const tx: PendingTx = {
        to: controller,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: CRVUSD_ADDRESS,
      };
      setPendingTx(tx);

      // If user needs to provide crvUSD for the gap (debt > AMM stablecoin), check approval
      if (crvUsdGap > 0n) {
        const allowance = await checkAllowance(publicClient, address, CRVUSD_ADDRESS, controller);
        if (allowance < crvUsdGap) {
          const approval: PendingApproval = {
            type: "erc20",
            token: CRVUSD_ADDRESS,
            tokenSymbol: "crvUSD",
            spender: controller,
            amount: crvUsdGap,
            decimals: 18,
          };
          setPendingApproval(approval);
          setApprovalProgress({
            step: 1,
            total: 1,
            steps: [{
              label: "crvUSD",
              description: "Approve crvUSD for Curve controller (repay shortfall)",
              spender: controller,
              done: false,
            }],
          });
          pendingPreviewRef.current = previewOnly;
          setStatus("needsApproval");
          return null;
        }
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, simulateAndExecute]);

  return {
    directLiquidate,
    pendingApproval,
    approvalProgress,
    approve,
    isApproving,
    isApprovalSuccess,
    executeAfterApproval,
    wasApprovalRequested: () => pendingPreviewRef.current,
    status: effectiveStatus,
    txHash,
    error,
    simulationResult,
    reset,
    clearError,
    executeAfterPreview,
  };
}
