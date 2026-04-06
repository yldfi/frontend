"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWaitForTransactionReceipt } from "wagmi";
import { useDirectWriteContract as useWriteContract } from "@/hooks/useDirectWriteContract";
import { encodeFunctionData, formatUnits, maxUint256, toFunctionSelector } from "viem";
import {
  ZAPPER_ADDRESS,
  ZAPPER_ABI,
  fetchZapperSwapData,
  fetchFromTokenSwapData,
  buildVaultInputSwapBundle,
  getDeadline,
} from "@/lib/zapper";
import { CRVUSD_ADDRESS, WETH_ADDRESS } from "@/config/addresses";
import { ETH_ADDRESS } from "@/lib/enso";
import { CONTROLLER_APPROVE_ABI } from "@/lib/abis";
import { getVaultInfo } from "@/lib/curve-lending";
import { TOKENS, TANGENT } from "@/config/vaults";
import { useSendTx } from "@/hooks/useSendTx";

const isNativeETH = (addr: string) => addr.toLowerCase() === ETH_ADDRESS.toLowerCase();

// ABI for direct controller.liquidate (no Zapper needed)
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

import { ERC20_APPROVAL_ABI, ERC4626_ABI, CURVE_GET_DY_ABI } from "@/lib/abis";
import type { SimulationResult } from "@/types/enso";
import { useTestNetwork } from "@/contexts/TestNetworkContext";
import { runVNetSimulation } from "@/lib/vnet-simulation";
import { snapshotTx, logTxDiff } from "@/lib/dev-logging";
import { parseEnsoError, parseErrorMessage, runTenderlySimulation, checkAllowance, anvilCall } from "@/lib/tx-utils";

export type ZapperStatus =
  | "idle"
  | "building"       // Fetching Enso route + encoding tx
  | "simulating"     // Running Tenderly simulation
  | "needsApproval"  // Waiting for user to approve (ERC20 or controller)
  | "approving"      // Approval tx sent, waiting for confirmation
  | "executing"      // Sending main transaction
  | "waitingTx"      // Waiting for main tx to confirm
  | "success"
  | "reverted"
  | "error";

export type { PendingApproval } from "@/types/approval";
import type { PendingApproval } from "@/types/approval";

interface PendingTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  inputToken: string;
  controller?: `0x${string}`; // For dev-mode position logging
}

async function checkControllerApproval(
  publicClient: ReturnType<typeof usePublicClient>,
  controller: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`
): Promise<boolean> {
  if (!publicClient) return false;
  try {
    const approved = await publicClient.readContract({
      address: controller,
      abi: CONTROLLER_APPROVE_ABI,
      functionName: "approval",
      args: [owner, spender],
    });
    return approved as boolean;
  } catch {
    return false;
  }
}

export interface UseZapperActionsResult {
  // Actions
  createLeveragedLoan: (
    controller: `0x${string}`,
    userCollateral: bigint,
    debt: bigint,
    N: number,
    collateralToken: `0x${string}`,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;
  leverageUp: (
    controller: `0x${string}`,
    additionalCollateral: bigint,
    additionalDebt: bigint,
    collateralToken: `0x${string}`,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;
  deleverage: (
    controller: `0x${string}`,
    collateralToSell: bigint,
    collateralToken: `0x${string}`,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;
  deleverageAndWithdraw: (
    controller: `0x${string}`,
    collateralToSell: bigint,
    withdrawAmount: bigint,
    collateralToken: `0x${string}`,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;
  deleverageAndWithdrawToToken: (
    controller: `0x${string}`,
    collateralToSell: bigint,
    withdrawAmount: bigint,
    collateralToken: `0x${string}`,
    outputToken: `0x${string}`,
    outputTokenSymbol: string,
    collateralSymbol: string,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;
  selfLiquidate: (
    controller: `0x${string}`,
    percentage: bigint,
    collateralToken: `0x${string}`,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;
  directLiquidate: (
    controller: `0x${string}`,
    percentage: bigint,
    previewOnly?: boolean,
    crvUsdGap?: bigint
  ) => Promise<SimulationResult | null>;

  // Zapper FromToken operations
  createLeveragedLoanFromToken: (
    controller: `0x${string}`,
    inputToken: `0x${string}`,
    inputAmount: bigint,
    debt: bigint,
    N: number,
    collateralToken: `0x${string}`,
    tokenSymbol: string,
    slippage?: number,
    previewOnly?: boolean,
    tokenDecimals?: number,
  ) => Promise<SimulationResult | null>;
  leverageUpFromToken: (
    controller: `0x${string}`,
    inputToken: `0x${string}`,
    inputAmount: bigint,
    additionalDebt: bigint,
    collateralToken: `0x${string}`,
    tokenSymbol: string,
    slippage?: number,
    previewOnly?: boolean,
    tokenDecimals?: number,
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
  status: ZapperStatus;
  txHash: `0x${string}` | null;
  error: string | null;
  simulationResult: SimulationResult | null;
  reset: () => void;
  clearError: () => void;
  executeAfterPreview: () => Promise<void>;
}

export function useZapperActions(): UseZapperActionsResult {
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

  const [status, setStatus] = useState<ZapperStatus>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [pendingTx, setPendingTx] = useState<PendingTx | null>(null);
  const [pendingController, setPendingController] = useState<`0x${string}` | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [approvalQueue, setApprovalQueue] = useState<PendingApproval[]>([]);
  const [approvalProgress, setApprovalProgress] = useState<{
    step: number;
    total: number;
    steps: { label: string; description: string; done: boolean; spender?: string }[];
  } | null>(null);
  // Track whether the original call requested previewOnly — set synchronously before returning null
  const pendingPreviewRef = useRef(false);

  // Approval tx
  const {
    writeContract: writeApprove,
    data: approveHash,
    reset: resetApprove,
    isError: isApproveError,
  } = useWriteContract();

  const { isLoading: isApprovalPending, isSuccess: isApprovalSuccess } = useWaitForTransactionReceipt({
    hash: approveHash,
    pollingInterval: 1_000,
  });

  useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    query: { enabled: !!txHash && status === "waitingTx" },
  });

  const isApproving = useMemo(() => {
    return status === "approving" || isApprovalPending;
  }, [status, isApprovalPending]);

  // Reset to needsApproval if user rejects wallet approval
  useEffect(() => {
    if (isApproveError && status === "approving") {
      setStatus("needsApproval");
      resetApprove();
    }
  }, [isApproveError, status, resetApprove]);

  const reset = useCallback(() => {
    setStatus("idle");
    setTxHash(null);
    setError(null);
    setSimulationResult(null);
    setPendingTx(null);
    setPendingController(null);
    setPendingApproval(null);
    setApprovalQueue(q => q.length === 0 ? q : []);
    setApprovalProgress(null);
    pendingPreviewRef.current = false;
    resetApprove();
  }, [resetApprove]);

  const clearError = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  const approve = useCallback((exactAmount?: boolean) => {
    if (!address || !pendingApproval) return;
    setStatus("approving");

    if (pendingApproval.type === "erc20") {
      const amount = exactAmount && pendingApproval.amount ? pendingApproval.amount : maxUint256;
      if (process.env.NODE_ENV === "development") {
        console.log(`[Approve TX] ERC20 ${pendingApproval.tokenSymbol} (${pendingApproval.token}) → spender ${pendingApproval.spender} | amount: ${amount === maxUint256 ? "MAX_UINT256" : amount.toString()} | exact: ${!!exactAmount}`);
      }
      writeApprove({
        address: pendingApproval.token,
        abi: ERC20_APPROVAL_ABI,
        functionName: "approve",
        args: [pendingApproval.spender, amount],
      });
    } else {
      if (process.env.NODE_ENV === "development") {
        console.log(`[Approve TX] Controller ${pendingApproval.token} → spender ${pendingApproval.spender} | approve(${pendingApproval.spender}, true)`);
      }
      // Controller approve(address, bool)
      writeApprove({
        address: pendingApproval.token, // controller address
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approve",
        args: [pendingApproval.spender, true],
      });
    }
  }, [address, pendingApproval, writeApprove]);

  const simulateAndExecute = useCallback(async (
    txData: PendingTx,
    previewOnly: boolean
  ): Promise<SimulationResult | null> => {
    if (!publicClient || !address) return null;

    if (process.env.NODE_ENV === "development") {
      const selector = txData.data.slice(0, 10);
      // Decode function name from known ABIs
      const knownSelectors: Record<string, string> = {};
      for (const entry of [...ZAPPER_ABI, ...CONTROLLER_LIQUIDATE_ABI]) {
        if (entry.type === "function") {
          const sig = `${entry.name}(${entry.inputs.map((i: { type: string }) => i.type).join(",")})`;
          try {
            knownSelectors[toFunctionSelector(sig)] = sig;
          } catch { /* skip malformed */ }
        }
      }
      const fnName = knownSelectors[selector] ?? `unknown(${selector})`;
      console.log(`[TX] ${fnName} → to: ${txData.to} | value: ${txData.value.toString()} wei | inputToken: ${txData.inputToken} | dataLen: ${txData.data.length} | previewOnly: ${previewOnly}`);
      console.log(`[TX data] ${txData.data}`);
    }

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
        (async () => {
          try {
            await anvilCall(publicClient, {
              account: address,
              to: txData.to,
              data: txData.data,
              value: txData.value,
            });
            if (process.env.NODE_ENV === "development") console.log(`[eth_call] OK | to: ${txData.to} | selector: ${txData.data.slice(0, 10)}`);
            return { ok: true as const };
          } catch (err: unknown) {
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
            if (process.env.NODE_ENV === "development") console.log(`[eth_call] FAILED | to: ${txData.to} | selector: ${txData.data.slice(0, 10)} | error: ${msg.slice(0, 300)}`);
            return { ok: false as const, errorMessage: msg };
          }
        })(),
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
        (async () => {
          try {
            await anvilCall(publicClient, { account: address, to: txData.to, data: txData.data, value: txData.value });
            if (process.env.NODE_ENV === "development") console.log(`[eth_call] OK | to: ${txData.to} | selector: ${txData.data.slice(0, 10)}`);
            return { ok: true as const };
          } catch (err: unknown) {
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
            if (process.env.NODE_ENV === "development") console.log(`[eth_call] FAILED | to: ${txData.to} | selector: ${txData.data.slice(0, 10)} | error: ${msg.slice(0, 300)}`);
            return { ok: false as const, errorMessage: msg };
          }
        })(),
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
      try {
        await anvilCall(publicClient, { account: address, to: txData.to, data: txData.data, value: txData.value });
        if (process.env.NODE_ENV === "development") console.log(`[eth_call] OK | to: ${txData.to} | selector: ${txData.data.slice(0, 10)}`);
      } catch (err: unknown) {
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
        if (process.env.NODE_ENV === "development") console.log(`[eth_call] FAILED | to: ${txData.to} | selector: ${txData.data.slice(0, 10)} | error: ${msg.slice(0, 300)}`);
        setError(parseErrorMessage(new Error(msg)));
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
        logTxDiff("Zapper TX", snapBefore, snapAfter);
      }
    }

    return simulationResult;
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult, pendingController]);

  const executeAfterApproval = useCallback(async () => {
    if (!pendingTx) {
      setError("No pending transaction");
      setStatus("error");
      return;
    }

    // If more approvals in queue, show the next one
    if (approvalQueue.length > 0) {
      const [next, ...rest] = approvalQueue;
      setPendingApproval(next);
      setApprovalQueue(rest);
      // Update progress: mark current step done, advance to next
      if (approvalProgress) {
        const updatedSteps = approvalProgress.steps.map((s, i) =>
          i < approvalProgress.step ? { ...s, done: true } : s
        );
        setApprovalProgress({ ...approvalProgress, step: approvalProgress.step + 1, steps: updatedSteps });
      }
      setStatus("needsApproval");
      resetApprove();
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
  }, [pendingTx, approvalQueue, approvalProgress, simulateAndExecute, resetApprove]);

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
          logTxDiff("Zapper TX", snapBefore, snapAfter);
        }
      }
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
    }
  }, [pendingTx, publicClient, sendTx, address, pendingController]);

  // Check both ERC20 and controller approvals, return first missing
  const checkApprovals = useCallback(async (
    collateralToken: `0x${string}`,
    controller: `0x${string}`,
    inputAmount: bigint,
    tokenSymbol: string
  ): Promise<PendingApproval[]> => {
    if (!publicClient || !address) return [];

    // Check all approvals in parallel:
    // - ERC20 allowance for input amount (if > 0)
    // - Controller approval for Zapper
    // - Collateral token maxUint256 allowance for Zapper (pre-approve for future
    //   removeCollateralAndConvert — the Zapper pulls vault tokens back after
    //   controller.remove_collateral sends them to the user)
    const [erc20Allowance, controllerApproved] = await Promise.all([
      checkAllowance(publicClient, address, collateralToken, ZAPPER_ADDRESS as `0x${string}`),
      checkControllerApproval(publicClient, controller, address, ZAPPER_ADDRESS as `0x${string}`),
    ]);

    const erc20Needed = erc20Allowance < maxUint256 / 2n;
    const controllerNeeded = !controllerApproved;

    // Build progress steps for all possible approvals
    const allSteps: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [];

    allSteps.push({
      approval: {
        type: "erc20",
        token: collateralToken,
        tokenSymbol,
        spender: ZAPPER_ADDRESS as `0x${string}`,
        spenderName: "yld Zapper",
      },
      needed: erc20Needed,
      label: tokenSymbol,
      description: `Approve ${tokenSymbol} for yld Zapper`,
      spender: ZAPPER_ADDRESS,
    });

    allSteps.push({
      approval: {
        type: "controller",
        token: controller,
        tokenSymbol: "Controller",
        spender: ZAPPER_ADDRESS as `0x${string}`,
        spenderName: "yld Zapper",
      },
      needed: controllerNeeded,
      label: "yld Zapper",
      description: "Allow yld Zapper to manage position on LlamaLend controller",
      spender: ZAPPER_ADDRESS,
    });

    const missing = allSteps.filter((s) => s.needed).map((s) => s.approval);

    // Set approval progress if any needed
    if (missing.length > 0) {
      const total = allSteps.length;
      const steps = allSteps.map((s) => ({ label: s.label, description: s.description, done: !s.needed, spender: s.spender }));
      const firstNeededIdx = allSteps.findIndex((s) => s.needed);
      setApprovalProgress({ step: firstNeededIdx + 1, total, steps });
    } else {
      setApprovalProgress(null);
    }

    return missing;
  }, [publicClient, address]);

  const createLeveragedLoan = useCallback(async (
    controller: `0x${string}`,
    userCollateral: bigint,
    debt: bigint,
    N: number,
    collateralToken: `0x${string}`,
    slippage: number = 100,
    previewOnly: boolean = false
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

      // Fetch swap route: crvUSD -> collateral token
      const { swapData, expectedOut } = await fetchZapperSwapData({
        tokenIn: CRVUSD_ADDRESS,
        tokenOut: collateralToken,
        amountIn: debt.toString(),
        slippage: String(slippage),
      });

      // Min output with slippage
      const expectedOutBn = BigInt(expectedOut);
      const minCollateralFromSwap = expectedOutBn * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "createLeveragedLoan",
        args: [
          controller,
          userCollateral,
          debt,
          BigInt(N),
          minCollateralFromSwap,
          swapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_ADDRESS as `0x${string}`,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      // Check approvals (may need ERC20 + controller)
      const missingApprovals = await checkApprovals(collateralToken, controller, userCollateral, "ycvxCRV");
      if (missingApprovals.length > 0) {
        setPendingApproval(missingApprovals[0]);
        setApprovalQueue(missingApprovals.slice(1));
        pendingPreviewRef.current = previewOnly;
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, checkApprovals, simulateAndExecute]);

  const leverageUp = useCallback(async (
    controller: `0x${string}`,
    additionalCollateral: bigint,
    additionalDebt: bigint,
    collateralToken: `0x${string}`,
    slippage: number = 100,
    previewOnly: boolean = false
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

      const { swapData, expectedOut } = await fetchZapperSwapData({
        tokenIn: CRVUSD_ADDRESS,
        tokenOut: collateralToken,
        amountIn: additionalDebt.toString(),
        slippage: String(slippage),
      });

      const expectedOutBn = BigInt(expectedOut);
      const minCollateralFromSwap = expectedOutBn * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "leverageUp",
        args: [
          controller,
          additionalCollateral,
          additionalDebt,
          minCollateralFromSwap,
          swapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_ADDRESS as `0x${string}`,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      const missingApprovals = await checkApprovals(collateralToken, controller, additionalCollateral, "ycvxCRV");
      if (missingApprovals.length > 0) {
        setPendingApproval(missingApprovals[0]);
        setApprovalQueue(missingApprovals.slice(1));
        pendingPreviewRef.current = previewOnly;
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, checkApprovals, simulateAndExecute]);

  const deleverage = useCallback(async (
    controller: `0x${string}`,
    collateralToSell: bigint,
    collateralToken: `0x${string}`,
    slippage: number = 100,
    previewOnly: boolean = false
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

      // Swap collateral -> crvUSD
      const { swapData, expectedOut } = await fetchZapperSwapData({
        tokenIn: collateralToken,
        tokenOut: CRVUSD_ADDRESS,
        amountIn: collateralToSell.toString(),
        slippage: String(slippage),
      });

      const expectedOutBn = BigInt(expectedOut);
      const minCrvusdFromSwap = expectedOutBn * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "deleverage",
        args: [
          controller,
          collateralToSell,
          minCrvusdFromSwap,
          swapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_ADDRESS as `0x${string}`,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      // Deleverage doesn't need ERC20 approval (collateral is in the controller)
      // but still needs controller approval
      const controllerApproved = await checkControllerApproval(
        publicClient,
        controller,
        address,
        ZAPPER_ADDRESS as `0x${string}`
      );
      if (!controllerApproved) {
        setPendingApproval({
          type: "controller",
          token: controller,
          tokenSymbol: "Controller",
          spender: ZAPPER_ADDRESS as `0x${string}`,
          spenderName: "yld Zapper",
        });
        pendingPreviewRef.current = previewOnly;
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, simulateAndExecute]);

  const selfLiquidate = useCallback(async (
    controller: `0x${string}`,
    percentage: bigint,
    collateralToken: `0x${string}`,
    slippage: number = 100,
    previewOnly: boolean = false
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

      // For self-liquidate, we need to estimate collateral being sold
      // Use a rough estimate based on position data
      // The zapper handles the actual amounts internally
      const { swapData, expectedOut } = await fetchZapperSwapData({
        tokenIn: collateralToken,
        tokenOut: CRVUSD_ADDRESS,
        // Self-liquidate sells collateral proportional to percentage
        // Use 1 unit as quote to get rate, actual amount handled by zapper
        amountIn: (10n ** 18n).toString(), // 1 token for rate quote
        slippage: String(slippage),
      });

      const expectedOutBn = BigInt(expectedOut);
      const minFromSwap = expectedOutBn * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "selfLiquidate",
        args: [
          controller,
          0n, // minFromAMM — AMM conversion minimum (0 = accept any)
          minFromSwap,
          percentage,
          true, // sellAllCollateral — adapts to actual collateral at execution time
          swapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_ADDRESS as `0x${string}`,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      const controllerApproved = await checkControllerApproval(
        publicClient,
        controller,
        address,
        ZAPPER_ADDRESS as `0x${string}`
      );
      if (!controllerApproved) {
        setPendingApproval({
          type: "controller",
          token: controller,
          tokenSymbol: "Controller",
          spender: ZAPPER_ADDRESS as `0x${string}`,
          spenderName: "yld Zapper",
        });
        pendingPreviewRef.current = previewOnly;
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, simulateAndExecute]);

  // Check approvals for FromToken operations (inputToken → Zapper, optionally controller → Zapper)
  const checkFromTokenApprovals = useCallback(async (
    inputToken: `0x${string}`,
    inputAmount: bigint,
    tokenSymbol: string,
    controller?: `0x${string}`,
    tokenDecimals?: number,
  ): Promise<PendingApproval[]> => {
    if (!publicClient || !address) return [];

    const [erc20Allowance, controllerApproved] = await Promise.all([
      inputAmount > 0n
        ? checkAllowance(publicClient, address, inputToken, ZAPPER_ADDRESS)
        : Promise.resolve(inputAmount),
      controller
        ? checkControllerApproval(publicClient, controller, address, ZAPPER_ADDRESS)
        : Promise.resolve(true),
    ]);

    const erc20Needed = inputAmount > 0n && erc20Allowance < inputAmount;
    const controllerNeeded = controller ? !controllerApproved : false;

    const allSteps: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [];

    if (inputAmount > 0n) {
      allSteps.push({
        approval: {
          type: "erc20",
          token: inputToken,
          tokenSymbol,
          spender: ZAPPER_ADDRESS,
          spenderName: "yld Zapper",
          amount: inputAmount,
          decimals: tokenDecimals,
        },
        needed: erc20Needed,
        label: tokenSymbol,
        description: `Approve ${tokenSymbol} for yld Zapper`,
        spender: ZAPPER_ADDRESS,
      });
    }

    if (controller) {
      allSteps.push({
        approval: {
          type: "controller",
          token: controller,
          tokenSymbol: "Controller",
          spender: ZAPPER_ADDRESS,
          spenderName: "yld Zapper",
        },
        needed: controllerNeeded,
        label: "yld Zapper",
        description: "Allow yld Zapper to manage position on LlamaLend controller",
        spender: ZAPPER_ADDRESS,
      });
    }

    const missing = allSteps.filter((s) => s.needed).map((s) => s.approval);

    if (missing.length > 0) {
      const total = allSteps.length;
      const steps = allSteps.map((s) => ({ label: s.label, description: s.description, done: !s.needed, spender: s.spender }));
      const firstNeededIdx = allSteps.findIndex((s) => s.needed);
      setApprovalProgress({ step: firstNeededIdx + 1, total, steps });
    } else {
      setApprovalProgress(null);
    }

    return missing;
  }, [publicClient, address]);

  // Zapper: Deleverage + withdraw collateral in one tx
  const deleverageAndWithdraw = useCallback(async (
    controller: `0x${string}`,
    collateralToSell: bigint,
    withdrawAmount: bigint,
    collateralToken: `0x${string}`,
    slippage: number = 100,
    previewOnly: boolean = false
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

      // Swap collateral -> crvUSD
      const { swapData, expectedOut } = await fetchZapperSwapData({
        tokenIn: collateralToken,
        tokenOut: CRVUSD_ADDRESS,
        amountIn: collateralToSell.toString(),
        slippage: String(slippage),
      });

      const expectedOutBn = BigInt(expectedOut);
      const minCrvusdFromSwap = expectedOutBn * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "deleverageAndWithdraw",
        args: [
          controller,
          collateralToSell,
          minCrvusdFromSwap,
          withdrawAmount,
          swapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_ADDRESS,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      // Need controller approval for Zapper (no ERC20 approval — collateral is in the controller)
      const missingApprovals = await checkFromTokenApprovals(
        collateralToken, 0n, "", controller
      );
      if (missingApprovals.length > 0) {
        setPendingApproval(missingApprovals[0]);
        setApprovalQueue(missingApprovals.slice(1));
        pendingPreviewRef.current = previewOnly;
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, checkFromTokenApprovals, simulateAndExecute]);

  // Zapper: Deleverage + withdraw collateral as a different token
  const deleverageAndWithdrawToToken = useCallback(async (
    controller: `0x${string}`,
    collateralToSell: bigint,
    withdrawAmount: bigint,
    collateralToken: `0x${string}`,
    outputToken: `0x${string}`,
    outputTokenSymbol: string,
    collateralSymbol: string,
    slippage: number = 100,
    previewOnly: boolean = false
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

      // For native ETH output: route via WETH, contract unwraps to ETH
      const isETHOutput = isNativeETH(outputToken);
      const routeOutputToken = isETHOutput ? WETH_ADDRESS as `0x${string}` : outputToken;

      // Two swap routes in parallel:
      // 1. collateral → crvUSD (deleverage swap)
      // 2. collateral → outputToken (withdrawal swap, WETH for ETH)
      const [deleverageRoute, outputRoute] = await Promise.all([
        fetchZapperSwapData({
          tokenIn: collateralToken,
          tokenOut: CRVUSD_ADDRESS,
          amountIn: collateralToSell.toString(),
          slippage: String(slippage),
        }),
        fetchZapperSwapData({
          tokenIn: collateralToken,
          tokenOut: routeOutputToken,
          amountIn: withdrawAmount.toString(),
          slippage: String(slippage),
        }),
      ]);

      const minCrvusdFromSwap = BigInt(deleverageRoute.expectedOut) * BigInt(10000 - slippage) / 10000n;
      const minOutputFromSwap = BigInt(outputRoute.expectedOut) * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "deleverageAndWithdrawToToken",
        args: [
          {
            controller,
            collateralToSell,
            minCrvUsdOut: minCrvusdFromSwap,
            withdrawAmount,
            outputToken: routeOutputToken,
            minOutputFromSwap,
            deadline: getDeadline(),
          },
          deleverageRoute.swapData as `0x${string}`,
          outputRoute.swapData as `0x${string}`,
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_ADDRESS,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      // Need controller approval + collateral ERC20 approval for Zapper
      // (Zapper calls remove_collateral → user, then transferFrom user → Zapper for the output swap)
      const missingApprovals = await checkFromTokenApprovals(
        collateralToken, withdrawAmount, collateralSymbol, controller
      );
      if (missingApprovals.length > 0) {
        setPendingApproval(missingApprovals[0]);
        setApprovalQueue(missingApprovals.slice(1));
        pendingPreviewRef.current = previewOnly;
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, checkFromTokenApprovals, simulateAndExecute]);

  // Zapper: Create leveraged loan from any input token (pre-swap + loop leverage)
  const createLeveragedLoanFromToken = useCallback(async (
    controller: `0x${string}`,
    inputToken: `0x${string}`,
    inputAmount: bigint,
    debt: bigint,
    N: number,
    collateralToken: `0x${string}`,
    tokenSymbol: string,
    slippage: number = 100,
    previewOnly: boolean = false,
    tokenDecimals?: number,
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

      // Check if inputToken is a vault token (e.g. yscvgCVX) that needs unwrapping
      const inputVaultInfo = getVaultInfo(inputToken);
      const isCvgCvxVault = inputVaultInfo
        ? inputVaultInfo.underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase()
        : false;

      let inputSwapData: string;
      let inputExpectedOut: string;
      let leverageSwapData: string;
      let leverageExpectedOut: string;

      if (inputVaultInfo) {
        // Vault token input: build bundle for vault → collateral conversion
        const estimatedUnderlying = await publicClient.readContract({
          address: inputVaultInfo.address as `0x${string}`,
          abi: ERC4626_ABI,
          functionName: "previewRedeem",
          args: [inputAmount],
        });

        let estimatedCvx1: string | undefined;
        if (isCvgCvxVault) {
          const cvx1Out = await publicClient.readContract({
            address: TANGENT.CVX1_CVGCVX_POOL as `0x${string}`,
            abi: CURVE_GET_DY_ABI,
            functionName: "get_dy",
            args: [1n, 0n, estimatedUnderlying as bigint],
          });
          estimatedCvx1 = (cvx1Out as bigint).toString();
        }

        const [vaultSwap, leverageSwap] = await Promise.all([
          buildVaultInputSwapBundle({
            vaultAddress: inputVaultInfo.address,
            underlying: inputVaultInfo.underlying,
            targetToken: collateralToken,
            amountIn: inputAmount.toString(),
            estimatedUnderlying: (estimatedUnderlying as bigint).toString(),
            isCvgCvx: isCvgCvxVault,
            estimatedCvx1,
            slippage: String(slippage),
          }),
          fetchZapperSwapData({
            tokenIn: CRVUSD_ADDRESS,
            tokenOut: collateralToken,
            amountIn: debt.toString(),
            slippage: String(slippage),
          }),
        ]);
        inputSwapData = vaultSwap.swapData;
        inputExpectedOut = vaultSwap.expectedOut;
        leverageSwapData = leverageSwap.swapData;
        leverageExpectedOut = leverageSwap.expectedOut;
      } else {
        // For native ETH: route with WETH (contract wraps ETH→WETH before swap)
        const routeToken = isNativeETH(inputToken) ? WETH_ADDRESS : inputToken;
        const routes = await fetchFromTokenSwapData({
          inputToken: routeToken,
          collateralToken,
          inputAmount: inputAmount.toString(),
          debtAmount: debt.toString(),
          slippage: String(slippage),
        });
        inputSwapData = routes.inputSwapData;
        inputExpectedOut = routes.inputExpectedOut;
        leverageSwapData = routes.leverageSwapData;
        leverageExpectedOut = routes.leverageExpectedOut;
      }

      const minCollateralFromInput = BigInt(inputExpectedOut) * BigInt(10000 - slippage) / 10000n;
      const minCollateralFromDebt = BigInt(leverageExpectedOut) * BigInt(10000 - slippage) / 10000n;

      // For native ETH: pass WETH address to contract (it wraps atomically), send msg.value
      const isETH = isNativeETH(inputToken);
      const contractToken = isETH ? WETH_ADDRESS as `0x${string}` : inputToken;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "createLeveragedLoanFromToken",
        args: [
          controller,
          contractToken,
          inputAmount,
          debt,
          BigInt(N),
          minCollateralFromInput,
          minCollateralFromDebt,
          inputSwapData as `0x${string}`,
          leverageSwapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_ADDRESS,
        data: data as `0x${string}`,
        value: isETH ? inputAmount : 0n,
        inputToken,
      };
      setPendingTx(tx);

      // Native ETH doesn't need ERC20 approval (sent as msg.value)
      if (!isETH) {
        const missingApprovals = await checkFromTokenApprovals(inputToken, inputAmount, tokenSymbol, undefined, tokenDecimals);
        if (missingApprovals.length > 0) {
          setPendingApproval(missingApprovals[0]);
          setApprovalQueue(missingApprovals.slice(1));
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
  }, [address, publicClient, checkFromTokenApprovals, simulateAndExecute]);

  // Zapper: Leverage up existing position from any input token
  const leverageUpFromToken = useCallback(async (
    controller: `0x${string}`,
    inputToken: `0x${string}`,
    inputAmount: bigint,
    additionalDebt: bigint,
    collateralToken: `0x${string}`,
    tokenSymbol: string,
    slippage: number = 100,
    previewOnly: boolean = false,
    tokenDecimals?: number,
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

      // Check if inputToken is a vault token (e.g. yscvgCVX) that needs unwrapping
      const inputVaultInfo = getVaultInfo(inputToken);
      const isCvgCvxVault = inputVaultInfo
        ? inputVaultInfo.underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase()
        : false;

      let inputSwapData: string;
      let inputExpectedOut: string;
      let leverageSwapData: string;
      let leverageExpectedOut: string;

      if (inputVaultInfo) {
        // Vault token input: build bundle for vault → collateral conversion
        const estimatedUnderlying = await publicClient.readContract({
          address: inputVaultInfo.address as `0x${string}`,
          abi: ERC4626_ABI,
          functionName: "previewRedeem",
          args: [inputAmount],
        });

        let estimatedCvx1: string | undefined;
        if (isCvgCvxVault) {
          const cvx1Out = await publicClient.readContract({
            address: TANGENT.CVX1_CVGCVX_POOL as `0x${string}`,
            abi: CURVE_GET_DY_ABI,
            functionName: "get_dy",
            args: [1n, 0n, estimatedUnderlying as bigint],
          });
          estimatedCvx1 = (cvx1Out as bigint).toString();
        }

        const [vaultSwap, leverageSwap] = await Promise.all([
          buildVaultInputSwapBundle({
            vaultAddress: inputVaultInfo.address,
            underlying: inputVaultInfo.underlying,
            targetToken: collateralToken,
            amountIn: inputAmount.toString(),
            estimatedUnderlying: (estimatedUnderlying as bigint).toString(),
            isCvgCvx: isCvgCvxVault,
            estimatedCvx1,
            slippage: String(slippage),
          }),
          fetchZapperSwapData({
            tokenIn: CRVUSD_ADDRESS,
            tokenOut: collateralToken,
            amountIn: additionalDebt.toString(),
            slippage: String(slippage),
          }),
        ]);
        inputSwapData = vaultSwap.swapData;
        inputExpectedOut = vaultSwap.expectedOut;
        leverageSwapData = leverageSwap.swapData;
        leverageExpectedOut = leverageSwap.expectedOut;
      } else {
        // For native ETH: route with WETH (contract wraps ETH→WETH before swap)
        const routeToken = isNativeETH(inputToken) ? WETH_ADDRESS : inputToken;
        const routes = await fetchFromTokenSwapData({
          inputToken: routeToken,
          collateralToken,
          inputAmount: inputAmount.toString(),
          debtAmount: additionalDebt.toString(),
          slippage: String(slippage),
        });
        inputSwapData = routes.inputSwapData;
        inputExpectedOut = routes.inputExpectedOut;
        leverageSwapData = routes.leverageSwapData;
        leverageExpectedOut = routes.leverageExpectedOut;
      }

      const minCollateralFromInput = BigInt(inputExpectedOut) * BigInt(10000 - slippage) / 10000n;
      const minCollateralFromDebt = BigInt(leverageExpectedOut) * BigInt(10000 - slippage) / 10000n;

      // For native ETH: pass WETH address to contract (it wraps atomically), send msg.value
      const isETH = isNativeETH(inputToken);
      const contractToken = isETH ? WETH_ADDRESS as `0x${string}` : inputToken;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "leverageUpFromToken",
        args: [
          controller,
          contractToken,
          inputAmount,
          additionalDebt,
          minCollateralFromInput,
          minCollateralFromDebt,
          inputSwapData as `0x${string}`,
          leverageSwapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_ADDRESS,
        data: data as `0x${string}`,
        value: isETH ? inputAmount : 0n,
        inputToken,
      };
      setPendingTx(tx);

      // Need controller → Zapper (existing position), skip ERC20 for native ETH
      const missingApprovals = await checkFromTokenApprovals(
        isETH ? inputToken : inputToken, // keep original for display
        isETH ? 0n : inputAmount, // 0n skips ERC20 check for ETH
        tokenSymbol,
        controller,
        tokenDecimals,
      );
      if (missingApprovals.length > 0) {
        setPendingApproval(missingApprovals[0]);
        setApprovalQueue(missingApprovals.slice(1));
        pendingPreviewRef.current = previewOnly;
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, checkFromTokenApprovals, simulateAndExecute]);

  // Direct liquidation — calls controller.liquidate() directly (no Zapper/swap needed)
  // User == msg.sender → no health check, no liquidation discount
  // If crvUsdGap > 0, user needs crvUSD in wallet + ERC20 approval to controller
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
          setApprovalQueue([]);
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
    createLeveragedLoan,
    leverageUp,
    deleverage,
    deleverageAndWithdraw,
    deleverageAndWithdrawToToken,
    selfLiquidate,
    directLiquidate,
    createLeveragedLoanFromToken,
    leverageUpFromToken,
    pendingApproval,
    approvalProgress,
    approve,
    isApproving,
    isApprovalSuccess,
    executeAfterApproval,
    wasApprovalRequested: () => pendingPreviewRef.current,
    status,
    txHash,
    error,
    simulationResult,
    reset,
    clearError,
    executeAfterPreview,
  };
}
