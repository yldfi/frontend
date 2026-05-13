"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWaitForTransactionReceipt } from "wagmi";
import { useDirectWriteContract as useWriteContract } from "@/hooks/useDirectWriteContract";
import { maxUint256 } from "viem";
import {
  fetchRepayBundle,
  fetchRepayWithSwapBundle,
  CURVE_CONTROLLERS,
} from "@/lib/curve-lending";
import { TOKENS, getVaultByAddress } from "@/config/vaults";
import { ERC20_APPROVAL_ABI, CONTROLLER_APPROVE_ABI } from "@/lib/abis";
import { ETH_ADDRESS, ENSO_ROUTER_EXECUTOR } from "@/lib/enso";
import { FORBIDDEN_APPROVAL_SPENDER_ERROR, assertSafeApprovalSpender, findForbiddenApproval, isForbiddenApprovalSpender } from "@/lib/approval-safety";
import { ZAPPER_ADDRESS, ZAPPER_ABI, fetchZapperSwapData, buildExoticOutputSwapData, getDeadline } from "@/lib/zapper";
import { CRVUSD_ADDRESS, WETH_ADDRESS } from "@/config/addresses";
import type { EnsoBundleResponse, SimulationResult } from "@/types/enso";
import { useTestNetwork } from "@/contexts/TestNetworkContext";
import { useSendTx } from "@/hooks/useSendTx";
import { runVNetSimulation } from "@/lib/vnet-simulation";
import { snapshotTx, logTxDiff } from "@/lib/dev-logging";
import { parseEnsoError, parseSwapFailedError, parseErrorMessage, runTenderlySimulation, checkAllowance, anvilCall } from "@/lib/tx-utils";

async function devEthCall(
  publicClient: ReturnType<typeof usePublicClient>,
  params: { account: `0x${string}`; to: `0x${string}`; data: `0x${string}`; value?: bigint },
): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
  try {
    await anvilCall(publicClient!, params);
    if (process.env.NODE_ENV === "development") console.log("[eth_call]", { ok: true, to: params.to });
    return { ok: true };
  } catch (err: unknown) {
    // viem puts raw revert data in cause.data for unrecognized custom errors
    const viemErr = err as { shortMessage?: string; message?: string; data?: string; cause?: { reason?: string; data?: string; message?: string } };
    const revertData = viemErr.data || viemErr.cause?.data;
    let msg = viemErr.message || viemErr.shortMessage || viemErr.cause?.reason || "eth_call failed";
    // If we have raw revert data, try structured Enso error parsing first
    if (revertData && typeof revertData === "string" && revertData.startsWith("0x")) {
      const enso = parseEnsoError(revertData.replace(/^0x/, ""));
      if (enso) {
        if (process.env.NODE_ENV === "development") console.log("[eth_call] Enso error", { step: enso.step, target: enso.target, message: enso.message });
        msg = `enso:${enso.message}`; // prefix so parseErrorMessage can match
      } else {
        // Try unwrapping SwapFailed(bytes) → inner Enso ExecutionFailed
        const swapFailed = parseSwapFailedError(revertData.replace(/^0x/, ""));
        if (swapFailed) {
          if (process.env.NODE_ENV === "development") console.log("[eth_call] SwapFailed → Enso error", { step: swapFailed.step, target: swapFailed.target, message: swapFailed.message });
          msg = `enso:${swapFailed.message}`; // prefix so parseErrorMessage can match
        } else {
          // Append raw hex so parseErrorMessage regex can find it
          msg = msg + " custom error " + revertData;
        }
      }
    }
    if (process.env.NODE_ENV === "development") console.log("[eth_call]", { ok: false, to: params.to, error: msg.slice(0, 300), revertData: revertData?.slice(0, 100) });
    return { ok: false, errorMessage: msg };
  }
}

export type LendingStatus =
  | "idle"
  | "building" // Building the transaction bundle
  | "simulating" // Running Tenderly simulation
  | "needsApproval" // Waiting for user to approve
  | "approving" // Approval tx sent, waiting for confirmation
  | "executing" // Sending main transaction
  | "waitingTx" // Waiting for main tx to confirm
  | "success"
  | "reverted"
  | "error";

export type { PendingApproval } from "@/types/approval";
import type { PendingApproval } from "@/types/approval";

export interface UseCurveLendingActionsResult {
  // Action functions - now support previewOnly option
  createLoan: (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    debtAmount: string,
    bands: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  createLoanWithSwap: (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    debtAmount: string,
    bands: number,
    slippage?: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string; decimals?: number }
  ) => Promise<SimulationResult | null>;
  createLoanWithOutputSwap: (
    vaultAddress: `0x${string}`,
    tokenIn: string | undefined,
    amountIn: string,
    debtAmount: string,
    bands: number,
    tokenOut: string,
    slippage?: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string; decimals?: number }
  ) => Promise<SimulationResult | null>;
  addCollateral: (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  removeCollateral: (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    options?: { previewOnly?: boolean }
  ) => Promise<SimulationResult | null>;
  addCollateralWithSwap: (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    slippage?: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string; decimals?: number }
  ) => Promise<SimulationResult | null>;
  removeCollateralAndSwap: (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    tokenOut: string,
    slippage?: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  borrowMore: (
    vaultAddress: `0x${string}`,
    additionalCollateral: string,
    additionalDebt: string,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  borrowMoreWithSwap: (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    additionalDebt: string,
    decimals?: number,
    slippage?: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  repay: (
    vaultAddress: `0x${string}`,
    repayAmount: string,
    options?: { previewOnly?: boolean }
  ) => Promise<SimulationResult | null>;
  repayDirect: (
    controllerAddress: `0x${string}`,
    repayAmount: bigint,
    options?: { previewOnly?: boolean; closeLoan?: boolean }
  ) => Promise<SimulationResult | null>;
  repayWithSwap: (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    decimals?: number,
    slippage?: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string; inSoftLiquidation?: boolean; withdrawAmount?: string; withdrawTokenOut?: string; withdrawTokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  repayAndWithdraw: (
    controllerAddress: `0x${string}`,
    repayAmount: bigint,
    withdrawAmount: bigint,
    vaultAddress: `0x${string}`,
    options?: { previewOnly?: boolean; closeLoan?: boolean; withdrawTokenOut?: string; withdrawTokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  borrowAndSwap: (
    vaultAddress: `0x${string}`,
    tokenOut: string,
    debtAmount: string,
    slippage: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string; estimatedSwapOutput?: bigint; collateralAmount?: string }
  ) => Promise<SimulationResult | null>;
  selfLiquidate: (
    vaultAddress: `0x${string}`,
    slippage?: number,
    options?: { previewOnly?: boolean }
  ) => Promise<SimulationResult | null>;

  // Approval - now based on bundle.tx.to
  pendingApproval: PendingApproval | null;
  approvalProgress: {
    step: number;
    total: number;
    steps: { label: string; description: string; done: boolean; spender?: string }[];
  } | null;
  approve: (exactApproval?: boolean) => void;
  isApproving: boolean;
  isApprovalSuccess: boolean;
  executeAfterApproval: () => Promise<void>;
  wasApprovalRequested: () => boolean;

  // State
  status: LendingStatus;
  txHash: `0x${string}` | null;
  error: string | null;
  simulationResult: SimulationResult | null;
  pendingBundle: EnsoBundleResponse | null;
  reset: () => void;
  clearError: () => void;
  // Execute after preview
  executeAfterPreview: () => Promise<void>;
}


export function useCurveLendingActions(): UseCurveLendingActionsResult {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const { testNetworkType } = useTestNetwork();
  const { sendTx } = useSendTx();

  // Invalidate balance queries after a successful tx so UI updates immediately
  const invalidateBalances = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["onchain-balances"] });
    queryClient.invalidateQueries({ queryKey: ["enso-wallet-balances"] });
    queryClient.invalidateQueries({ queryKey: ["curveLendingPosition"] });
  }, [queryClient]);

  const [status, setStatus] = useState<LendingStatus>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [pendingBundle, setPendingBundle] = useState<EnsoBundleResponse | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [approvalQueue, setApprovalQueue] = useState<PendingApproval[]>([]);
  const [approvalProgress, setApprovalProgress] = useState<{
    step: number;
    total: number;
    steps: { label: string; description: string; done: boolean; spender?: string }[];
  } | null>(null);
  const [pendingInputToken, setPendingInputToken] = useState<string | null>(null);
  const [pendingController, setPendingController] = useState<`0x${string}` | null>(null);
  // Stored action to execute after all approvals in the queue complete
  const pendingActionRef = useRef<(() => Promise<SimulationResult | null>) | null>(null);
  // Track whether the original call requested previewOnly — set synchronously before returning null
  const pendingPreviewRef = useRef(false);

  // Approve contract
  const {
    writeContract: writeApprove,
    data: approveHash,
    reset: resetApprove,
    isError: isApproveError,
  } = useWriteContract();

  // Wait for approval tx
  const { isLoading: isApprovalPending, isSuccess: isApprovalSuccess } = useWaitForTransactionReceipt({
    hash: approveHash,
    pollingInterval: 1_000,
  });

  // Wait for main transaction receipt
  const effectiveStatus: LendingStatus =
    isApproveError && status === "approving" ? "needsApproval" : status;

  useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    query: {
      enabled: !!txHash && effectiveStatus === "waitingTx",
    },
  });

  // Derive isApproving from status and approval pending state
  const isApproving = useMemo(() => {
    return effectiveStatus === "approving" || isApprovalPending;
  }, [effectiveStatus, isApprovalPending]);

  const reset = useCallback(() => {
    setStatus("idle");
    setTxHash(null);
    setError(null);
    setSimulationResult(null);
    setPendingBundle(null);
    setPendingApproval(null);
    setApprovalQueue(q => q.length === 0 ? q : []);
    setApprovalProgress(null);
    setPendingInputToken(null);
    setPendingController(null);
    pendingActionRef.current = null;
    pendingPreviewRef.current = false;
    resetApprove();
  }, [resetApprove]);

  // Light reset: clears error/status but keeps simulation + bundle cached
  const clearError = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  const rejectForbiddenApproval = useCallback(() => {
    setPendingApproval(null);
    setApprovalQueue([]);
    setApprovalProgress(null);
    pendingActionRef.current = null;
    pendingPreviewRef.current = false;
    setError(FORBIDDEN_APPROVAL_SPENDER_ERROR);
    setStatus("error");
  }, []);

  // Queue approvals or run action immediately if all approvals are satisfied.
  // Returns null if approvals are queued (caller should return null too).
  const queueApprovalsOrRun = (
    allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[],
    action: () => Promise<SimulationResult | null>
  ): Promise<SimulationResult | null> | null => {
    const total = allApprovals.length;
    const steps = allApprovals.map((a) => ({ label: a.label, description: a.description, done: !a.needed, spender: a.spender }));
    const missing = allApprovals.filter((a) => a.needed);

    if (missing.length > 0) {
      if (findForbiddenApproval(missing.map((a) => a.approval))) {
        rejectForbiddenApproval();
        return null;
      }

      const firstNeededIdx = allApprovals.findIndex((a) => a.needed);
      setApprovalProgress({ step: firstNeededIdx + 1, total, steps });
      setPendingApproval(missing[0].approval);
      setApprovalQueue(missing.slice(1).map((a) => a.approval));
      pendingActionRef.current = action;
      setStatus("needsApproval");
      return null;
    }

    setApprovalProgress(null);
    return action();
  };

  // Approve using the pending approval info — supports both ERC20 and controller approval
  // When exactApproval is true and amount is available, approve only the needed amount
  const approve = useCallback((exactApproval?: boolean) => {
    if (!address || !pendingApproval) return;

    if (isForbiddenApprovalSpender(pendingApproval.spender)) {
      rejectForbiddenApproval();
      return;
    }

    setStatus("approving");

    if (pendingApproval.type === "controller") {
      // Controller approve(address, bool)
      writeApprove({
        address: pendingApproval.token, // controller address
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approve",
        args: [pendingApproval.spender, true],
      });
    } else {
      const approvalAmount = exactApproval && pendingApproval.amount
        ? pendingApproval.amount
        : maxUint256;
      // ERC20 approve(address, uint256)
      writeApprove({
        address: pendingApproval.token,
        abi: ERC20_APPROVAL_ABI,
        functionName: "approve",
        args: [pendingApproval.spender, approvalAmount],
      });
    }
  }, [address, pendingApproval, rejectForbiddenApproval, writeApprove]);

  // Execute the pending bundle after approval
  const executeAfterApproval = useCallback(async () => {
    // If more approvals in queue, show the next one
    if (approvalQueue.length > 0) {
      const [next, ...rest] = approvalQueue;
      if (isForbiddenApprovalSpender(next.spender)) {
        rejectForbiddenApproval();
        resetApprove();
        return;
      }
      setPendingApproval(next);
      setApprovalQueue(rest);
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

    // All approvals done — if we have a stored action (swap paths), run it
    if (pendingActionRef.current) {
      setPendingApproval(null);
      setApprovalProgress(null);
      const action = pendingActionRef.current;
      pendingActionRef.current = null;
      try {
        await action();
      } catch (err) {
        setError(parseErrorMessage(err));
        setStatus("error");
      }
      return;
    }

    // Fallback: direct bundle execution (non-swap paths like direct create_loan)
    if (!pendingBundle || !publicClient || !address || !pendingInputToken) {
      setError("No pending transaction");
      setStatus("error");
      return;
    }

    // Check if the original call requested previewOnly (Tenderly preview mode)
    const wasPreviewOnly = pendingPreviewRef.current;
    pendingPreviewRef.current = false;

    try {
      // Clear approval state
      setPendingApproval(null);
      setApprovalProgress(null);

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      const bundleTxParams = {
        to: pendingBundle.tx.to as `0x${string}`,
        data: pendingBundle.tx.data as `0x${string}`,
        value: pendingBundle.tx.value ? BigInt(pendingBundle.tx.value) : 0n,
      };

      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(
            address,
            pendingBundle.tx.to,
            pendingBundle.tx.data,
            pendingBundle.tx.value || "0",
            pendingInputToken
          ),
          devEthCall(publicClient, { account: address, ...bundleTxParams }),
        ]);

        if (tenderlyResult.result) {
          setSimulationResult(tenderlyResult.result);
        }

        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return;
        }
        if (!tenderlyResult.ok) {
          if (process.env.NODE_ENV === "development") console.log("[Simulation] Tenderly failed but eth_call passed, proceeding");
        }

        // If original call was previewOnly, stop here — simulation result is set, component will show modal
        if (wasPreviewOnly) {
          setStatus("idle");
          return;
        }
      } else if (testNetworkType === "tenderly") {
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: pendingBundle.tx.to, data: pendingBundle.tx.data, value: `0x${bundleTxParams.value.toString(16)}` },
            address,
          ),
          devEthCall(publicClient, { account: address, ...bundleTxParams }),
        ]);

        if (vnetResult.result) {
          setSimulationResult(vnetResult.result);
        }

        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return;
        }
        if (!vnetResult.ok) {
          if (process.env.NODE_ENV === "development") console.log("[Simulation] VNet sim failed but eth_call passed, proceeding");
        }

        // If original call was previewOnly, stop here
        if (wasPreviewOnly) {
          setStatus("idle");
          return;
        }
      } else {
        const ethCallResult = await devEthCall(publicClient, { account: address, ...bundleTxParams });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return;
        }
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, pendingController, [pendingInputToken]);
      }

      // Execute the transaction
      setStatus("executing");

      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: pendingBundle.tx.to, selector: (pendingBundle.tx.data as string).slice(0, 10), data: pendingBundle.tx.data });
      const hash = await sendTx({
        to: pendingBundle.tx.to as `0x${string}`,
        data: pendingBundle.tx.data as `0x${string}`,
        value: pendingBundle.tx.value ? BigInt(pendingBundle.tx.value) : 0n,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 60_000,
        pollingInterval: 1_000,
      });

      // Set status BEFORE dev snapshot — snapshot is async and yields control,
      // allowing position queries to refetch and unmount the tab component
      if (receipt.status === "success") {
        setStatus("success");
        invalidateBalances();
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }
      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, pendingController, [pendingInputToken]);
          logTxDiff("Lending TX", snapBefore, snapAfter);
        }
      }
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
    }
  }, [pendingBundle, publicClient, address, pendingInputToken, sendTx, testNetworkType, chainId, pendingController, approvalQueue, approvalProgress, rejectForbiddenApproval, resetApprove, invalidateBalances]);

  // Execute a pending bundle after preview confirmation
  const executeAfterPreview = useCallback(async () => {
    if (!pendingBundle || !publicClient) {
      setError("No pending transaction");
      setStatus("error");
      return;
    }

    try {
      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, pendingController, [pendingInputToken ?? ""]);
      }

      setStatus("executing");

      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: pendingBundle.tx.to, selector: (pendingBundle.tx.data as string).slice(0, 10), data: pendingBundle.tx.data });
      const hash = await sendTx({
        to: pendingBundle.tx.to as `0x${string}`,
        data: pendingBundle.tx.data as `0x${string}`,
        value: pendingBundle.tx.value ? BigInt(pendingBundle.tx.value) : 0n,
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
        invalidateBalances();
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }
      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, pendingController, [pendingInputToken ?? ""]);
          logTxDiff("Lending TX", snapBefore, snapAfter);
        }
      }
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
    }
  }, [pendingBundle, publicClient, sendTx, address, pendingController, pendingInputToken, invalidateBalances]);

  const executeBundle = useCallback(async (
    bundleFn: () => Promise<EnsoBundleResponse>,
    inputToken: string,
    inputAmount: bigint,
    options?: { previewOnly?: boolean; tokenSymbol?: string; tokenDecimals?: number }
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
      setPendingBundle(null);
      setPendingApproval(null);

      // Build the bundle
      const bundle = await bundleFn();

      // Store the bundle and input token for potential execution after approval/preview
      setPendingBundle(bundle);
      setPendingInputToken(inputToken);

      // In router mode, the Enso Router pulls tokens from the user via
      // safeTransferFrom(msg.sender, enso, amount) in the tokensIn loop.
      // Users must approve the ROUTER (not ENSO_SHORTCUTS) as the spender.
      // Complex flows that need mid-bundle transferFrom handle their own
      // approvals and pass inputAmount=0n to skip this check.
      const spender = ENSO_ROUTER_EXECUTOR as `0x${string}`;
      assertSafeApprovalSpender(spender);

      // Check allowance against the Router
      // Skip for actions that don't require approval:
      // - ETH (native token, not ERC20)
      // - Remove collateral, self-liquidate (we receive tokens, not send)
      // - Complex flows that pass inputAmount=0n (they handle approvals themselves)
      const isEth = inputToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
      if (inputAmount > 0n && !isEth) {
        const currentAllowance = await checkAllowance(
          publicClient,
          address,
          inputToken as `0x${string}`,
          spender
        );

        if (currentAllowance < inputAmount) {
          // Need approval - set state and return
          setPendingApproval({
            token: inputToken as `0x${string}`,
            tokenSymbol: options?.tokenSymbol ?? "tokens",
            spender,
            spenderName: "Enso Router",
            amount: inputAmount,
            decimals: options?.tokenDecimals,
          });
          pendingPreviewRef.current = !!options?.previewOnly;
          setStatus("needsApproval");
          return null;
        }
      }

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      const bundleTxParams = {
        to: bundle.tx.to as `0x${string}`,
        data: bundle.tx.data as `0x${string}`,
        value: bundle.tx.value ? BigInt(bundle.tx.value) : 0n,
      };

      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, bundle.tx.to, bundle.tx.data, bundle.tx.value || "0", inputToken),
          devEthCall(publicClient, { account: address, ...bundleTxParams }),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return tenderlyResult.result;
        }

        if (options?.previewOnly) {
          setStatus("idle");
          // Return Tenderly result if available, otherwise a minimal marker
          // so the caller knows eth_call passed and doesn't rebuild the bundle
          return tenderlyResult.result ?? { success: true, status: true, gasUsed: 0, errorMessage: null, assetChanges: [], simulationId: null, tenderlyUrl: null } as unknown as SimulationResult;
        }
        if (!tenderlyResult.ok) {
          if (process.env.NODE_ENV === "development") console.log("[Simulation] Tenderly failed but eth_call passed, proceeding");
        }
      } else if (testNetworkType === "tenderly") {
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: bundle.tx.to, data: bundle.tx.data, value: `0x${bundleTxParams.value.toString(16)}` },
            address,
          ),
          devEthCall(publicClient, { account: address, ...bundleTxParams }),
        ]);

        if (vnetResult.result) setSimulationResult(vnetResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }

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
        setStatus("simulating");
        const ethCallResult = await devEthCall(publicClient, { account: address, ...bundleTxParams });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return null;
        }
        if (options?.previewOnly) {
          setStatus("idle");
          return null; // No Tenderly simulation data on test networks
        }
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, pendingController, [inputToken]);
      }

      // Execute the transaction
      setStatus("executing");

      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: bundle.tx.to, selector: (bundle.tx.data as string).slice(0, 10), data: bundle.tx.data });
      const hash = await sendTx({
        to: bundle.tx.to as `0x${string}`,
        data: bundle.tx.data as `0x${string}`,
        value: bundle.tx.value ? BigInt(bundle.tx.value) : 0n,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      // Wait for confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 60_000,
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
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, pendingController, [inputToken]);
          logTxDiff("Lending TX", snapBefore, snapAfter);
        }
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult, pendingController, invalidateBalances]);

  // Direct controller call for create_loan (no Enso bundle needed)
  const createLoan = useCallback(async (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    debtAmount: string,
    bands: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingBundle(null);
      setPendingApproval(null);
      setPendingController(controllerAddress as `0x${string}`);

      const { parseUnits, encodeFunctionData } = await import("viem");
      const amountWei = parseUnits(collateralAmount, 18); // Vault tokens are 18 decimals

      const callData = encodeFunctionData({
        abi: [{
          name: "create_loan",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "collateral", type: "uint256" },
            { name: "debt", type: "uint256" },
            { name: "N", type: "uint256" },
          ],
          outputs: [],
        }],
        functionName: "create_loan",
        args: [amountWei, BigInt(debtAmount), BigInt(bands)],
      });

      // Store pending tx for executeAfterPreview / executeAfterApproval
      setPendingBundle({
        tx: { to: controllerAddress, data: callData, value: "0", from: address },
        gas: "0",
        amountsOut: {},
      });
      setPendingInputToken(vaultAddress);

      // Check vault token allowance to controller
      const currentAllowance = await checkAllowance(
        publicClient, address, vaultAddress, controllerAddress as `0x${string}`
      );
      if (currentAllowance < amountWei) {
        setPendingApproval({
          token: vaultAddress,
          tokenSymbol: options?.tokenSymbol ?? "collateral",
          spender: controllerAddress as `0x${string}`,
          spenderName: "Curve Controller",
          amount: amountWei,
          decimals: 18,
        });
        setStatus("needsApproval");
        return null;
      }

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", vaultAddress),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return tenderlyResult.result;
        }

        if (options?.previewOnly) {
          setStatus("idle");
          // Return Tenderly result if available, otherwise a minimal marker
          // so the caller knows eth_call passed and doesn't rebuild the bundle
          return tenderlyResult.result ?? { success: true, status: true, gasUsed: 0, errorMessage: null, assetChanges: [], simulationId: null, tenderlyUrl: null } as unknown as SimulationResult;
        }
        if (!tenderlyResult.ok) {
          if (process.env.NODE_ENV === "development") console.log("[Simulation] Tenderly failed but eth_call passed, proceeding");
        }
      } else if (testNetworkType === "tenderly") {
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: controllerAddress, data: callData },
            address,
          ),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (vnetResult.result) setSimulationResult(vnetResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }

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
        const ethCallResult = await devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return null;
        }
        if (options?.previewOnly) {
          setStatus("idle");
          return null;
        }
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
      }

      // Execute
      setStatus("executing");
      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: controllerAddress, selector: (callData as string).slice(0, 10), data: callData });
      const hash = await sendTx({
        to: controllerAddress as `0x${string}`,
        data: callData as `0x${string}`,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 });
      if (receipt.status === "success") {
        setStatus("success");
        invalidateBalances();
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }
      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
          logTxDiff("createLoan", snapBefore, snapAfter);
        }
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult, invalidateBalances]);

  // Create loan with swap: tokenIn → collateral → create_loan via Zapper (createLoanFromToken)
  const createLoanWithSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    debtAmount: string,
    bands: number,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string; decimals?: number }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    const decimals = options?.decimals ?? 18;
    const { parseUnits: pu, encodeFunctionData } = await import("viem");
    const amountWei = pu(amountIn, decimals);
    setPendingController(controllerAddress as `0x${string}`);

    setStatus("building");
    setError(null);

    // Check approvals against ZAPPER_ADDRESS
    // For ETH: Zapper wraps ETH→WETH atomically, so pass WETH as tokenIn and ETH as msg.value
    const isEth = tokenIn.toLowerCase() === ETH_ADDRESS.toLowerCase();
    const zapperTokenIn = isEth ? WETH_ADDRESS : tokenIn;
    const isVaultTokenInput = tokenIn.toLowerCase() === vaultAddress.toLowerCase();
    const [controllerApproved, tokenAllowance, vaultTokenAllowance] = await Promise.all([
      publicClient.readContract({
        address: controllerAddress as `0x${string}`,
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approval",
        args: [address, ZAPPER_ADDRESS],
      }).catch(() => true) as Promise<boolean>,
      isEth ? Promise.resolve(amountWei) : checkAllowance(publicClient, address, tokenIn as `0x${string}`, ZAPPER_ADDRESS),
      // Pre-approve vault token for Zapper (needed for future removeCollateralAndConvert)
      isVaultTokenInput ? Promise.resolve(maxUint256) : checkAllowance(publicClient, address, vaultAddress as `0x${string}`, ZAPPER_ADDRESS),
    ]);

    const tokenSymbol = options?.tokenSymbol ?? "token";
    const vaultConfig = getVaultByAddress(vaultAddress);
    const vaultSymbol = vaultConfig?.symbol ?? "Vault Token";
    const allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [
      {
        approval: {
          type: "controller",
          token: controllerAddress as `0x${string}`,
          tokenSymbol: "Controller",
          spender: ZAPPER_ADDRESS,
        },
        needed: !controllerApproved,
        label: "Lending Access",
        description: "Approve yld Zapper to create loan on your behalf",
        spender: ZAPPER_ADDRESS,
      },
      ...(!isEth ? [{
        approval: {
          token: tokenIn as `0x${string}`,
          tokenSymbol,
          spender: ZAPPER_ADDRESS,
          spenderName: "yld Zapper",
          amount: amountWei,
          decimals,
        },
        needed: tokenAllowance < amountWei,
        label: tokenSymbol,
        description: `Approve ${tokenSymbol} for yld Zapper`,
        spender: ZAPPER_ADDRESS,
      }] : []),
      // Pre-approve vault token for future removeCollateralAndConvert (skip if input IS the vault token — already covered above)
      ...(!isVaultTokenInput && vaultTokenAllowance < maxUint256 / 2n ? [{
        approval: {
          token: vaultAddress as `0x${string}`,
          tokenSymbol: vaultSymbol,
          spender: ZAPPER_ADDRESS,
          spenderName: "yld Zapper",
        },
        needed: true,
        label: vaultSymbol,
        description: `Approve ${vaultSymbol} for yld Zapper`,
        spender: ZAPPER_ADDRESS,
      }] : []),
    ];

    // Build-and-execute function for the swap bundle
    const runBundle = () => executeBundle(
      async () => {
        const { swapData, expectedOut } = await fetchZapperSwapData({
          tokenIn: zapperTokenIn,
          tokenOut: vaultAddress,
          amountIn: amountWei.toString(),
          slippage: slippage.toString(),
        });

        const expectedOutBn = BigInt(expectedOut);
        const minCollateral = expectedOutBn * BigInt(10000 - slippage) / 10000n;

        // Cap debt to max_borrowable for worst-case collateral (minCollateral)
        const requestedDebt = BigInt(debtAmount);
        const maxDebtForMin = await publicClient!.readContract({
          address: controllerAddress as `0x${string}`,
          abi: [{ name: "max_borrowable", type: "function", stateMutability: "view", inputs: [{ name: "collateral", type: "uint256" }, { name: "N", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] }] as const,
          functionName: "max_borrowable",
          args: [minCollateral, BigInt(bands)],
        });
        const debtWei = requestedDebt > maxDebtForMin ? maxDebtForMin : requestedDebt;

        const data = encodeFunctionData({
          abi: ZAPPER_ABI,
          functionName: "createLoanFromToken",
          args: [
            controllerAddress as `0x${string}`,
            zapperTokenIn as `0x${string}`,
            amountWei,
            minCollateral,
            debtWei,
            BigInt(bands),
            swapData as `0x${string}`,
            getDeadline(),
          ],
        });

        return {
          tx: { to: ZAPPER_ADDRESS, data, value: isEth ? amountWei.toString() : "0", from: address },
          gas: "0",
          amountsOut: { [CRVUSD_ADDRESS]: debtWei.toString() },
        };
      },
      zapperTokenIn,
      0n, // skip executeBundle's built-in approval check
      options
    );

    return queueApprovalsOrRun(allApprovals, runBundle);
  }, [address, publicClient, executeBundle]);

  // Create loan with output swap via Zapper.
  // Vault token → createLoanAndConvert (create_loan + swap crvUSD → tokenOut)
  // Non-vault token → createLoanFromTokenAndConvert (swap to collateral + create_loan + swap crvUSD → tokenOut)
  const createLoanWithOutputSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenIn: string | undefined, // undefined = vault token directly
    amountIn: string,
    debtAmount: string,
    bands: number,
    tokenOut: string,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string; decimals?: number }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    const isVaultToken = !tokenIn;
    const actualTokenIn = tokenIn ?? vaultAddress;
    const decimals = options?.decimals ?? 18;
    const { parseUnits: pu, encodeFunctionData } = await import("viem");
    const amountWei = pu(amountIn, decimals);
    setPendingController(controllerAddress as `0x${string}`);

    setStatus("building");
    setError(null);

    // Check approvals against ZAPPER_ADDRESS
    // For ETH: Zapper wraps ETH→WETH atomically, so pass WETH as tokenIn and ETH as msg.value
    const isEthInput = !isVaultToken && actualTokenIn.toLowerCase() === ETH_ADDRESS.toLowerCase();
    const zapperTokenIn = isEthInput ? WETH_ADDRESS : actualTokenIn;
    const isVaultTokenInput = actualTokenIn.toLowerCase() === vaultAddress.toLowerCase();
    const [controllerApproved, tokenAllowance, vaultTokenAllowance] = await Promise.all([
      publicClient.readContract({
        address: controllerAddress as `0x${string}`,
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approval",
        args: [address, ZAPPER_ADDRESS],
      }).catch(() => true) as Promise<boolean>,
      isEthInput ? Promise.resolve(amountWei) : checkAllowance(publicClient, address, actualTokenIn as `0x${string}`, ZAPPER_ADDRESS),
      // Pre-approve vault token for future removeCollateralAndConvert
      isVaultTokenInput ? Promise.resolve(maxUint256) : checkAllowance(publicClient, address, vaultAddress as `0x${string}`, ZAPPER_ADDRESS),
    ]);

    const tokenSymbol = options?.tokenSymbol ?? "token";
    const vaultConfig2 = getVaultByAddress(vaultAddress);
    const vaultSymbol2 = vaultConfig2?.symbol ?? "Vault Token";
    const allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [
      {
        approval: {
          type: "controller",
          token: controllerAddress as `0x${string}`,
          tokenSymbol: "Controller",
          spender: ZAPPER_ADDRESS,
        },
        needed: !controllerApproved,
        label: "Lending Access",
        description: "Approve yld Zapper to create loan on your behalf",
        spender: ZAPPER_ADDRESS,
      },
      ...(!isEthInput ? [{
        approval: {
          token: actualTokenIn as `0x${string}`,
          tokenSymbol,
          spender: ZAPPER_ADDRESS,
          spenderName: "yld Zapper",
          amount: amountWei,
          decimals,
        },
        needed: tokenAllowance < amountWei,
        label: tokenSymbol,
        description: `Approve ${tokenSymbol} for yld Zapper`,
        spender: ZAPPER_ADDRESS,
      }] : []),
      // Pre-approve vault token for future removeCollateralAndConvert
      ...(!isVaultTokenInput && vaultTokenAllowance < maxUint256 / 2n ? [{
        approval: {
          token: vaultAddress as `0x${string}`,
          tokenSymbol: vaultSymbol2,
          spender: ZAPPER_ADDRESS,
          spenderName: "yld Zapper",
        },
        needed: true,
        label: vaultSymbol2,
        description: `Approve ${vaultSymbol2} for yld Zapper`,
        spender: ZAPPER_ADDRESS,
      }] : []),
    ];

    const runBundle = isVaultToken
      ? () => executeBundle(
          async () => {
            // For native ETH output: route via WETH, contract unwraps to ETH
            const isETHOut = tokenOut.toLowerCase() === ETH_ADDRESS.toLowerCase();
            const routeTokenOut = isETHOut ? WETH_ADDRESS : tokenOut;
            const { swapData, expectedOut } = await fetchZapperSwapData({
              tokenIn: CRVUSD_ADDRESS,
              tokenOut: routeTokenOut,
              amountIn: debtAmount,
              slippage: slippage.toString(),
            });

            const expectedOutBn = BigInt(expectedOut);
            const minTargetOut = expectedOutBn * BigInt(10000 - slippage) / 10000n;

            const data = encodeFunctionData({
              abi: ZAPPER_ABI,
              functionName: "createLoanAndConvert",
              args: [
                controllerAddress as `0x${string}`,
                amountWei,
                BigInt(debtAmount),
                BigInt(bands),
                tokenOut as `0x${string}`, // Pass original token (ETH_ADDRESS for native ETH → Zapper unwraps WETH)
                minTargetOut,
                swapData as `0x${string}`,
                getDeadline(),
              ],
            });

            return {
              tx: { to: ZAPPER_ADDRESS, data, value: "0", from: address },
              gas: "0",
              amountsOut: { [tokenOut]: expectedOut },
            };
          },
          actualTokenIn,
          0n,
          options
        )
      : () => executeBundle(
          async () => {
            // For native ETH output: route via WETH, contract unwraps to ETH
            const isETHOut = tokenOut.toLowerCase() === ETH_ADDRESS.toLowerCase();
            const routeTokenOut = isETHOut ? WETH_ADDRESS : tokenOut;
            // Fetch both swap routes in parallel:
            //   inputSwap: tokenIn → collateral (vault token)
            //   outputSwap: crvUSD → tokenOut (the user's desired output)
            const [inputRoute, outputRoute] = await Promise.all([
              fetchZapperSwapData({
                tokenIn: zapperTokenIn,
                tokenOut: vaultAddress,
                amountIn: amountWei.toString(),
                slippage: slippage.toString(),
              }),
              fetchZapperSwapData({
                tokenIn: CRVUSD_ADDRESS,
                tokenOut: routeTokenOut,
                amountIn: debtAmount,
                slippage: slippage.toString(),
              }),
            ]);

            const expectedCollateral = BigInt(inputRoute.expectedOut);
            const minCollateral = expectedCollateral * BigInt(10000 - slippage) / 10000n;

            // Cap debt to max_borrowable for worst-case collateral
            const requestedDebt = BigInt(debtAmount);
            const maxDebtForMin = await publicClient!.readContract({
              address: controllerAddress as `0x${string}`,
              abi: [{ name: "max_borrowable", type: "function", stateMutability: "view", inputs: [{ name: "collateral", type: "uint256" }, { name: "N", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] }] as const,
              functionName: "max_borrowable",
              args: [minCollateral, BigInt(bands)],
            });
            const debtWei = requestedDebt > maxDebtForMin ? maxDebtForMin : requestedDebt;

            const expectedOutputBn = BigInt(outputRoute.expectedOut);
            const minTargetOut = expectedOutputBn * BigInt(10000 - slippage) / 10000n;

            const data = encodeFunctionData({
              abi: ZAPPER_ABI,
              functionName: "createLoanFromTokenAndConvert",
              args: [
                controllerAddress as `0x${string}`,
                zapperTokenIn as `0x${string}`,
                amountWei,
                minCollateral,
                debtWei,
                BigInt(bands),
                tokenOut as `0x${string}`, // Pass original token (ETH_ADDRESS for native ETH → Zapper unwraps WETH)
                minTargetOut,
                inputRoute.swapData as `0x${string}`,
                outputRoute.swapData as `0x${string}`,
                getDeadline(),
              ],
            });

            return {
              tx: { to: ZAPPER_ADDRESS, data, value: isEthInput ? amountWei.toString() : "0", from: address },
              gas: "0",
              amountsOut: { [tokenOut]: outputRoute.expectedOut },
            };
          },
          zapperTokenIn,
          0n,
          options
        );

    return queueApprovalsOrRun(allApprovals, runBundle);
  }, [address, publicClient, executeBundle]);

  // Direct controller call for add_collateral (no Enso bundle needed)
  const addCollateral = useCallback(async (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingBundle(null);
      setPendingApproval(null);
      setPendingController(controllerAddress as `0x${string}`);

      const { parseUnits, encodeFunctionData } = await import("viem");
      const amountWei = parseUnits(collateralAmount, 18);

      const callData = encodeFunctionData({
        abi: [{
          name: "add_collateral",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "collateral", type: "uint256" },
            { name: "_for", type: "address" },
          ],
          outputs: [],
        }],
        functionName: "add_collateral",
        args: [amountWei, address],
      });

      // Store pending tx for executeAfterPreview / executeAfterApproval
      setPendingBundle({
        tx: { to: controllerAddress, data: callData, value: "0", from: address },
        gas: "0",
        amountsOut: {},
      });
      setPendingInputToken(vaultAddress);

      // Check vault token allowance to controller
      const currentAllowance = await checkAllowance(
        publicClient, address, vaultAddress, controllerAddress as `0x${string}`
      );
      if (currentAllowance < amountWei) {
        setPendingApproval({
          token: vaultAddress,
          tokenSymbol: options?.tokenSymbol ?? "collateral",
          spender: controllerAddress as `0x${string}`,
          spenderName: "Curve Controller",
          amount: amountWei,
          decimals: 18,
        });
        pendingPreviewRef.current = !!options?.previewOnly;
        setStatus("needsApproval");
        return null;
      }

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", vaultAddress),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return tenderlyResult.result;
        }

        if (options?.previewOnly) {
          setStatus("idle");
          // Return Tenderly result if available, otherwise a minimal marker
          // so the caller knows eth_call passed and doesn't rebuild the bundle
          return tenderlyResult.result ?? { success: true, status: true, gasUsed: 0, errorMessage: null, assetChanges: [], simulationId: null, tenderlyUrl: null } as unknown as SimulationResult;
        }
        if (!tenderlyResult.ok) {
          if (process.env.NODE_ENV === "development") console.log("[Simulation] Tenderly failed but eth_call passed, proceeding");
        }
      } else if (testNetworkType === "tenderly") {
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: controllerAddress, data: callData },
            address,
          ),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (vnetResult.result) setSimulationResult(vnetResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }

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
        const ethCallResult = await devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return null;
        }
        if (options?.previewOnly) {
          setStatus("idle");
          return null;
        }
      }

      // Execute
      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
      }

      setStatus("executing");
      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: controllerAddress, selector: (callData as string).slice(0, 10), data: callData });
      const hash = await sendTx({
        to: controllerAddress as `0x${string}`,
        data: callData as `0x${string}`,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 });
      if (receipt.status === "success") {
        setStatus("success");
        invalidateBalances();
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }
      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
          logTxDiff("addCollateral", snapBefore, snapAfter);
        }
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult, invalidateBalances]);

  // Direct controller call for remove_collateral (no Enso bundle needed)
  const removeCollateral = useCallback(async (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    options?: { previewOnly?: boolean }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingBundle(null);
      setPendingApproval(null);
      setPendingController(controllerAddress as `0x${string}`);

      const { parseUnits, encodeFunctionData } = await import("viem");
      const amountWei = parseUnits(collateralAmount, 18);

      const callData = encodeFunctionData({
        abi: [{
          name: "remove_collateral",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "collateral", type: "uint256" },
          ],
          outputs: [],
        }],
        functionName: "remove_collateral",
        args: [amountWei],
      });

      // Store pending tx for executeAfterPreview
      setPendingBundle({
        tx: { to: controllerAddress, data: callData, value: "0", from: address },
        gas: "0",
        amountsOut: {},
      });
      setPendingInputToken(vaultAddress);

      // No approval needed for removing collateral (we receive tokens)

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", vaultAddress),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return tenderlyResult.result;
        }

        if (options?.previewOnly) {
          setStatus("idle");
          // Return Tenderly result if available, otherwise a minimal marker
          // so the caller knows eth_call passed and doesn't rebuild the bundle
          return tenderlyResult.result ?? { success: true, status: true, gasUsed: 0, errorMessage: null, assetChanges: [], simulationId: null, tenderlyUrl: null } as unknown as SimulationResult;
        }
        if (!tenderlyResult.ok) {
          if (process.env.NODE_ENV === "development") console.log("[Simulation] Tenderly failed but eth_call passed, proceeding");
        }
      } else if (testNetworkType === "tenderly") {
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: controllerAddress, data: callData },
            address,
          ),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (vnetResult.result) setSimulationResult(vnetResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }

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
        const ethCallResult = await devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return null;
        }
        if (options?.previewOnly) {
          setStatus("idle");
          return null;
        }
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
      }

      // Execute
      setStatus("executing");
      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: controllerAddress, selector: (callData as string).slice(0, 10), data: callData });
      const hash = await sendTx({
        to: controllerAddress as `0x${string}`,
        data: callData as `0x${string}`,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 });
      if (receipt.status === "success") {
        setStatus("success");
        invalidateBalances();
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }
      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
          logTxDiff("removeCollateral", snapBefore, snapAfter);
        }
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult, invalidateBalances]);

  // Add collateral with swap: tokenIn → collateral via Zapper (addCollateralFromToken)
  const addCollateralWithSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string; decimals?: number }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    const decimals = options?.decimals ?? 18;
    const { parseUnits: pu, encodeFunctionData } = await import("viem");
    const amountWei = pu(amountIn, decimals);
    setPendingController(controllerAddress as `0x${string}`);

    setStatus("building");
    setError(null);

    // Check approvals against ZAPPER_ADDRESS
    // For ETH: Zapper wraps ETH→WETH atomically, so pass WETH as tokenIn and ETH as msg.value
    const isEth = tokenIn.toLowerCase() === ETH_ADDRESS.toLowerCase();
    const zapperTokenIn = isEth ? WETH_ADDRESS : tokenIn;
    const isVaultTokenInput = tokenIn.toLowerCase() === vaultAddress.toLowerCase();
    const [controllerApproved, tokenAllowance, vaultTokenAllowance] = await Promise.all([
      publicClient.readContract({
        address: controllerAddress as `0x${string}`,
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approval",
        args: [address, ZAPPER_ADDRESS],
      }).catch(() => true) as Promise<boolean>,
      isEth ? Promise.resolve(amountWei) : checkAllowance(publicClient, address, tokenIn as `0x${string}`, ZAPPER_ADDRESS),
      // Pre-approve vault token for future removeCollateralAndConvert
      isVaultTokenInput ? Promise.resolve(maxUint256) : checkAllowance(publicClient, address, vaultAddress as `0x${string}`, ZAPPER_ADDRESS),
    ]);

    const tokenSymbol = options?.tokenSymbol ?? "token";
    const vaultConfig3 = getVaultByAddress(vaultAddress);
    const vaultSymbol3 = vaultConfig3?.symbol ?? "Vault Token";
    const allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [
      {
        approval: {
          type: "controller",
          token: controllerAddress as `0x${string}`,
          tokenSymbol: "Controller",
          spender: ZAPPER_ADDRESS,
        },
        needed: !controllerApproved,
        label: "Lending Access",
        description: "Approve yld Zapper to manage collateral on your behalf",
        spender: ZAPPER_ADDRESS,
      },
      ...(!isEth ? [{
        approval: {
          token: tokenIn as `0x${string}`,
          tokenSymbol,
          spender: ZAPPER_ADDRESS,
          spenderName: "yld Zapper",
          amount: amountWei,
          decimals,
        },
        needed: tokenAllowance < amountWei,
        label: tokenSymbol,
        description: `Approve ${tokenSymbol} for yld Zapper`,
        spender: ZAPPER_ADDRESS,
      }] : []),
      // Pre-approve vault token for future removeCollateralAndConvert
      ...(!isVaultTokenInput && vaultTokenAllowance < maxUint256 / 2n ? [{
        approval: {
          token: vaultAddress as `0x${string}`,
          tokenSymbol: vaultSymbol3,
          spender: ZAPPER_ADDRESS,
          spenderName: "yld Zapper",
        },
        needed: true,
        label: vaultSymbol3,
        description: `Approve ${vaultSymbol3} for yld Zapper`,
        spender: ZAPPER_ADDRESS,
      }] : []),
    ];

    const runBundle = () => executeBundle(
      async () => {
        const { swapData, expectedOut } = await fetchZapperSwapData({
          tokenIn: zapperTokenIn,
          tokenOut: vaultAddress,
          amountIn: amountWei.toString(),
          slippage: slippage.toString(),
        });

        const expectedOutBn = BigInt(expectedOut);
        const minCollateral = expectedOutBn * BigInt(10000 - slippage) / 10000n;

        const data = encodeFunctionData({
          abi: ZAPPER_ABI,
          functionName: "addCollateralFromToken",
          args: [
            controllerAddress as `0x${string}`,
            zapperTokenIn as `0x${string}`,
            amountWei,
            minCollateral,
            swapData as `0x${string}`,
            getDeadline(),
          ],
        });

        return {
          tx: { to: ZAPPER_ADDRESS, data, value: isEth ? amountWei.toString() : "0", from: address },
          gas: "0",
          amountsOut: {},
        };
      },
      zapperTokenIn,
      0n,
      options
    );

    return queueApprovalsOrRun(allApprovals, runBundle);
  }, [address, publicClient, executeBundle]);

  // Remove collateral + swap to any token via Zapper's removeCollateralAndConvert.
  // Approvals are checked against ZAPPER_ADDRESS (not ENSO_SHORTCUTS).
  const removeCollateralAndSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    tokenOut: string,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    const { parseUnits } = await import("viem");
    const amountWei = parseUnits(collateralAmount, 18);
    setPendingController(controllerAddress as `0x${string}`);

    // Check approvals against ZAPPER_ADDRESS (controller + collateral token)
    setStatus("building");
    setError(null);

    const [controllerApproved, vaultTokenAllowance] = await Promise.all([
      publicClient.readContract({
        address: controllerAddress as `0x${string}`,
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approval",
        args: [address, ZAPPER_ADDRESS],
      }).catch(() => true) as Promise<boolean>,
      checkAllowance(publicClient, address, vaultAddress, ZAPPER_ADDRESS),
    ]);

    const tokenSymbol = options?.tokenSymbol ?? "token";
    const allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [
      {
        approval: {
          type: "controller",
          token: controllerAddress as `0x${string}`,
          tokenSymbol: "Controller",
          spender: ZAPPER_ADDRESS,
        },
        needed: !controllerApproved,
        label: "Lending Access",
        description: "Approve yld Zapper to manage collateral on your behalf",
        spender: ZAPPER_ADDRESS,
      },
      {
        approval: {
          token: vaultAddress,
          tokenSymbol: tokenSymbol,
          spender: ZAPPER_ADDRESS,
          spenderName: "yld Zapper",
          amount: amountWei,
          decimals: 18,
        },
        needed: vaultTokenAllowance < amountWei,
        label: tokenSymbol,
        description: `Approve ${tokenSymbol} for yld Zapper`,
        spender: ZAPPER_ADDRESS,
      },
    ];

    const runBundle = () => executeBundle(
      async () => {
        const { encodeFunctionData } = await import("viem");

        // For native ETH output: route via WETH, contract unwraps to ETH
        const isETHOutput = tokenOut.toLowerCase() === ETH_ADDRESS.toLowerCase();
        const routeTokenOut = isETHOutput ? WETH_ADDRESS : tokenOut;

        // Fetch swap route: collateral token → target token
        const { swapData, expectedOut } = await fetchZapperSwapData({
          tokenIn: vaultAddress,
          tokenOut: routeTokenOut,
          amountIn: amountWei.toString(),
          slippage: slippage.toString(),
        });

        const expectedOutBn = BigInt(expectedOut);
        const minTargetOut = expectedOutBn * BigInt(10000 - slippage) / 10000n;

        const data = encodeFunctionData({
          abi: ZAPPER_ABI,
          functionName: "removeCollateralAndConvert",
          args: [
            controllerAddress as `0x${string}`,
            amountWei,
            tokenOut as `0x${string}`, // Pass original token (ETH_ADDRESS for native ETH → Zapper unwraps WETH)
            minTargetOut,
            swapData as `0x${string}`,
            getDeadline(),
          ],
        });

        return {
          tx: { to: ZAPPER_ADDRESS, data, value: "0", from: address },
          gas: "0",
          amountsOut: { [tokenOut]: expectedOut },
        };
      },
      vaultAddress,
      0n,
      options
    );

    return queueApprovalsOrRun(allApprovals, runBundle);
  }, [address, publicClient, executeBundle]);

  // Direct contract call to controller.borrow_more(collateral, debt)
  // User IS msg.sender — no Enso bundle needed, no controller approval needed.
  const borrowMore = useCallback(async (
    vaultAddress: `0x${string}`,
    additionalCollateral: string,
    additionalDebt: string,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingBundle(null);
      setPendingApproval(null);
      setPendingController(controllerAddress as `0x${string}`);

      const { parseUnits, encodeFunctionData } = await import("viem");
      const collateralWei = additionalCollateral ? parseUnits(additionalCollateral, 18) : 0n;
      const debtWei = BigInt(additionalDebt);

      const callData = encodeFunctionData({
        abi: [{
          name: "borrow_more",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "collateral", type: "uint256" },
            { name: "debt", type: "uint256" },
          ],
          outputs: [],
        }],
        functionName: "borrow_more",
        args: [collateralWei, debtWei],
      });

      // Store pending tx for executeAfterPreview / executeAfterApproval
      setPendingBundle({
        tx: { to: controllerAddress, data: callData, value: "0", from: address },
        gas: "0",
        amountsOut: {},
      });
      setPendingInputToken(vaultAddress);

      // Check collateral token allowance to controller (only if adding collateral)
      if (collateralWei > 0n) {
        const currentAllowance = await checkAllowance(
          publicClient, address, vaultAddress, controllerAddress as `0x${string}`
        );
        if (currentAllowance < collateralWei) {
          setPendingApproval({
            token: vaultAddress,
            tokenSymbol: options?.tokenSymbol ?? "collateral",
            spender: controllerAddress as `0x${string}`,
            spenderName: "Curve Controller",
            amount: collateralWei,
            decimals: 18,
          });
          pendingPreviewRef.current = !!options?.previewOnly;
          setStatus("needsApproval");
          return null;
        }
      }

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", vaultAddress),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return tenderlyResult.result;
        }

        if (options?.previewOnly) {
          setStatus("idle");
          // Return Tenderly result if available, otherwise a minimal marker
          // so the caller knows eth_call passed and doesn't rebuild the bundle
          return tenderlyResult.result ?? { success: true, status: true, gasUsed: 0, errorMessage: null, assetChanges: [], simulationId: null, tenderlyUrl: null } as unknown as SimulationResult;
        }
        if (!tenderlyResult.ok) {
          if (process.env.NODE_ENV === "development") console.log("[Simulation] Tenderly failed but eth_call passed, proceeding");
        }
      } else if (testNetworkType === "tenderly") {
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: controllerAddress, data: callData },
            address,
          ),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (vnetResult.result) setSimulationResult(vnetResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }

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
        const ethCallResult = await devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return null;
        }
        if (options?.previewOnly) {
          setStatus("idle");
          return null;
        }
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
      }

      // Execute
      setStatus("executing");
      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: controllerAddress, selector: (callData as string).slice(0, 10), data: callData });
      const hash = await sendTx({
        to: controllerAddress as `0x${string}`,
        data: callData as `0x${string}`,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 });
      if (receipt.status === "success") {
        setStatus("success");
        invalidateBalances();
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }
      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
          logTxDiff("borrowMore", snapBefore, snapAfter);
        }
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult, invalidateBalances]);

  // Swap any token to vault collateral + borrow_more via Zapper (borrowMoreFromToken).
  // User provides tokenIn (e.g., ETH, USDC) which gets swapped to collateral, then
  // borrow_more_extended adds collateral and borrows crvUSD to user atomically.
  const borrowMoreWithSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    additionalDebt: string,
    decimals: number = 18,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    const { parseUnits: pu, encodeFunctionData } = await import("viem");
    const amountWei = pu(amountIn, decimals);
    setPendingController(controllerAddress as `0x${string}`);

    setStatus("building");
    setError(null);

    // Check approvals against ZAPPER_ADDRESS
    // For ETH: Zapper wraps ETH→WETH atomically, so pass WETH as tokenIn and ETH as msg.value
    const isEth = tokenIn.toLowerCase() === ETH_ADDRESS.toLowerCase();
    const zapperTokenIn = isEth ? WETH_ADDRESS : tokenIn;
    const [controllerApproved, tokenAllowance] = await Promise.all([
      publicClient.readContract({
        address: controllerAddress as `0x${string}`,
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approval",
        args: [address, ZAPPER_ADDRESS],
      }).catch(() => true) as Promise<boolean>,
      isEth ? Promise.resolve(amountWei) : checkAllowance(publicClient, address, tokenIn as `0x${string}`, ZAPPER_ADDRESS),
    ]);

    const tokenSymbol = options?.tokenSymbol ?? "token";
    const allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [
      {
        approval: {
          type: "controller",
          token: controllerAddress as `0x${string}`,
          tokenSymbol: "Controller",
          spender: ZAPPER_ADDRESS,
        },
        needed: !controllerApproved,
        label: "Lending Access",
        description: "Approve yld Zapper to borrow on your behalf",
        spender: ZAPPER_ADDRESS,
      },
      ...(!isEth ? [{
        approval: {
          token: tokenIn as `0x${string}`,
          tokenSymbol,
          spender: ZAPPER_ADDRESS,
          spenderName: "yld Zapper",
          amount: amountWei,
          decimals,
        },
        needed: tokenAllowance < amountWei,
        label: tokenSymbol,
        description: `Approve ${tokenSymbol} for yld Zapper`,
        spender: ZAPPER_ADDRESS,
      }] : []),
    ];

    const runBundle = () => executeBundle(
      async () => {
        // Fetch swap route: tokenIn → collateral (vault token)
        const { swapData, expectedOut } = await fetchZapperSwapData({
          tokenIn: zapperTokenIn,
          tokenOut: vaultAddress,
          amountIn: amountWei.toString(),
          slippage: slippage.toString(),
        });

        const expectedOutBn = BigInt(expectedOut);
        const minCollateral = expectedOutBn * BigInt(10000 - slippage) / 10000n;

        // Cap debt: read current position, compute max_borrowable for (existing + minCollateral)
        const requestedDebt = BigInt(additionalDebt);
        const userState = await publicClient!.readContract({
          address: controllerAddress as `0x${string}`,
          abi: [{ name: "user_state", type: "function", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "collateral", type: "uint256" }, { name: "stablecoin", type: "uint256" }, { name: "debt", type: "uint256" }, { name: "N", type: "uint256" }] }] as const,
          functionName: "user_state",
          args: [address],
        });
        const existingCollateral = (userState as [bigint, bigint, bigint, bigint])[0];
        const existingDebt = (userState as [bigint, bigint, bigint, bigint])[2];
        const existingN = (userState as [bigint, bigint, bigint, bigint])[3];
        const maxForTotal = await publicClient!.readContract({
          address: controllerAddress as `0x${string}`,
          abi: [{ name: "max_borrowable", type: "function", stateMutability: "view", inputs: [{ name: "collateral", type: "uint256" }, { name: "N", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] }] as const,
          functionName: "max_borrowable",
          args: [existingCollateral + minCollateral, existingN],
        });
        const maxAdditionalDebt = maxForTotal > existingDebt ? maxForTotal - existingDebt : 0n;
        const debtWei = requestedDebt > maxAdditionalDebt ? maxAdditionalDebt : requestedDebt;

        const data = encodeFunctionData({
          abi: ZAPPER_ABI,
          functionName: "borrowMoreFromToken",
          args: [
            controllerAddress as `0x${string}`,
            zapperTokenIn as `0x${string}`,
            amountWei,
            minCollateral,
            debtWei,
            swapData as `0x${string}`,
            getDeadline(),
          ],
        });

        return {
          tx: { to: ZAPPER_ADDRESS, data, value: isEth ? amountWei.toString() : "0", from: address },
          gas: "0",
          amountsOut: { [CRVUSD_ADDRESS]: debtWei.toString() },
        };
      },
      zapperTokenIn,
      0n,
      options
    );

    return queueApprovalsOrRun(allApprovals, runBundle);
  }, [address, publicClient, executeBundle]);

  const repay = useCallback(async (
    vaultAddress: `0x${string}`,
    repayAmount: string,
    options?: { previewOnly?: boolean }
  ): Promise<SimulationResult | null> => {
    if (!address) return null;
    const { parseUnits } = await import("viem");
    const amountWei = parseUnits(repayAmount, 18);
    const ctrl = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (ctrl) setPendingController(ctrl as `0x${string}`);
    return executeBundle(
      () => fetchRepayBundle({
        fromAddress: address,
        vaultAddress,
        repayAmount: amountWei.toString(),
      }),
      CRVUSD_ADDRESS,
      amountWei,
      { ...options, tokenSymbol: "crvUSD" }
    );
  }, [address, executeBundle]);

  // Direct controller repay - bypasses Enso, calls controller.repay() with crvUSD
  const repayDirect = useCallback(async (
    controllerAddress: `0x${string}`,
    repayAmount: bigint,
    options?: { previewOnly?: boolean; closeLoan?: boolean }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const CRVUSD = CRVUSD_ADDRESS;

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingBundle(null);
      setPendingApproval(null);
      setPendingController(controllerAddress);

      // Encode controller.repay(_d_debt, _for, max_active_band)
      // When closing loan, pass maxUint256 as _d_debt so interest accrual
      // between quote and TX confirmation can't prevent closure.
      // The controller caps at actual debt: d_debt = min(debt, _d_debt)
      const { encodeFunctionData, maxUint256 } = await import("viem");
      const isClosing = options?.closeLoan;
      const contractRepayAmount = isClosing ? maxUint256 : repayAmount;
      const callData = encodeFunctionData({
        abi: [{
          name: "repay",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "_d_debt", type: "uint256" },
            { name: "_for", type: "address" },
            { name: "max_active_band", type: "int256" },
          ],
          outputs: [],
        }],
        functionName: "repay",
        args: [contractRepayAmount, address, 2n ** 255n - 1n],
      });

      // Store as pseudo-bundle so executeAfterPreview / executeAfterApproval can find it
      setPendingBundle({
        tx: { to: controllerAddress, data: callData, value: "0" },
        gas: "0",
        createdAt: Date.now(),
      } as unknown as EnsoBundleResponse);
      setPendingInputToken(CRVUSD);

      // Check crvUSD allowance to controller.
      // When closing, add 0.1% buffer to account for interest accrual between
      // approval and execution — the controller transfers actual debt which keeps growing.
      const currentAllowance = await checkAllowance(
        publicClient,
        address,
        CRVUSD,
        controllerAddress
      );
      const requiredAllowance = isClosing
        ? repayAmount + (repayAmount / 1000n) // +0.1% buffer for interest
        : repayAmount;

      if (currentAllowance < requiredAllowance) {
        setPendingApproval({
          token: CRVUSD,
          tokenSymbol: "crvUSD",
          spender: controllerAddress,
          spenderName: "Curve Controller",
          amount: requiredAllowance,
          decimals: 18,
        });
        pendingPreviewRef.current = !!options?.previewOnly;
        setStatus("needsApproval");
        return null;
      }

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", CRVUSD),
          devEthCall(publicClient, { account: address, to: controllerAddress, data: callData as `0x${string}` }),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return tenderlyResult.result;
        }

        if (options?.previewOnly) {
          setStatus("idle");
          // Return Tenderly result if available, otherwise a minimal marker
          // so the caller knows eth_call passed and doesn't rebuild the bundle
          return tenderlyResult.result ?? { success: true, status: true, gasUsed: 0, errorMessage: null, assetChanges: [], simulationId: null, tenderlyUrl: null } as unknown as SimulationResult;
        }
        if (!tenderlyResult.ok) {
          if (process.env.NODE_ENV === "development") console.log("[Simulation] Tenderly failed but eth_call passed, proceeding");
        }
      } else if (testNetworkType === "tenderly") {
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: controllerAddress, data: callData },
            address,
          ),
          devEthCall(publicClient, { account: address, to: controllerAddress, data: callData as `0x${string}` }),
        ]);

        if (vnetResult.result) setSimulationResult(vnetResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }

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
        const ethCallResult = await devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return null;
        }
        if (options?.previewOnly) {
          setStatus("idle");
          return null;
        }
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, controllerAddress, [CRVUSD]);
      }

      // Execute the transaction
      setStatus("executing");
      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: controllerAddress, selector: (callData as string).slice(0, 10), data: callData });

      const hash = await sendTx({
        to: controllerAddress,
        data: callData as `0x${string}`,
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
        invalidateBalances();
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }
      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, controllerAddress, [CRVUSD]);
          logTxDiff("repayDirect", snapBefore, snapAfter);
        }
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult, invalidateBalances]);

  // Repay crvUSD debt + withdraw collateral via RepayZapper.
  // If withdrawTokenOut is set, swaps collateral to target token via repayAndConvert.
  // Approvals are checked against ZAPPER_ADDRESS (not ENSO_SHORTCUTS).
  const repayAndWithdraw = useCallback(async (
    controllerAddress: `0x${string}`,
    repayAmount: bigint,
    withdrawAmount: bigint,
    vaultAddress: `0x${string}`,
    options?: { previewOnly?: boolean; closeLoan?: boolean; withdrawTokenOut?: string; withdrawTokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    setPendingController(controllerAddress);
    setStatus("building");
    setError(null);

    const isWithdrawSwap = options?.withdrawTokenOut &&
      options.withdrawTokenOut.toLowerCase() !== vaultAddress.toLowerCase();

    // Check approvals against ZAPPER_ADDRESS:
    // 1. Controller approval (always needed)
    // 2. crvUSD allowance (if repaying)
    // 3. Collateral token allowance (only for repayAndConvert — pull-back after withdraw)
    const approvalChecks = [
      publicClient.readContract({
        address: controllerAddress,
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approval",
        args: [address, ZAPPER_ADDRESS],
      }).catch(() => true) as Promise<boolean>,
      repayAmount > 0n
        ? checkAllowance(publicClient, address, CRVUSD_ADDRESS as `0x${string}`, ZAPPER_ADDRESS)
        : Promise.resolve(maxUint256),
      isWithdrawSwap && withdrawAmount > 0n
        ? checkAllowance(publicClient, address, vaultAddress, ZAPPER_ADDRESS)
        : Promise.resolve(maxUint256),
    ] as const;

    const [controllerApproved, crvusdAllowance, collateralAllowance] = await Promise.all(approvalChecks);

    const vaultConfig = getVaultByAddress(vaultAddress);
    const vaultSymbol = vaultConfig?.symbol ?? "Collateral";

    const allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [
      {
        approval: {
          type: "controller",
          token: controllerAddress,
          tokenSymbol: "Controller",
          spender: ZAPPER_ADDRESS,
        },
        needed: !controllerApproved,
        label: "Lending Access",
        description: "Approve yld Zapper to manage your position",
        spender: ZAPPER_ADDRESS,
      },
    ];
    if (repayAmount > 0n) {
      allApprovals.push({
        approval: {
          token: CRVUSD_ADDRESS as `0x${string}`,
          tokenSymbol: "crvUSD",
          spender: ZAPPER_ADDRESS,
          spenderName: "yld Zapper",
          amount: repayAmount,
          decimals: 18,
        },
        needed: crvusdAllowance < repayAmount,
        label: "crvUSD",
        description: "Approve crvUSD for yld Zapper",
        spender: ZAPPER_ADDRESS,
      });
    }
    if (isWithdrawSwap && withdrawAmount > 0n) {
      allApprovals.push({
        approval: {
          token: vaultAddress,
          tokenSymbol: vaultSymbol,
          spender: ZAPPER_ADDRESS,
          spenderName: "yld Zapper",
          amount: withdrawAmount,
          decimals: 18,
        },
        needed: collateralAllowance < withdrawAmount,
        label: vaultSymbol,
        description: `Approve ${vaultSymbol} for yld Zapper`,
        spender: ZAPPER_ADDRESS,
      });
    }

    const runBundle = () => executeBundle(
      async () => {
        const { encodeFunctionData } = await import("viem");

        if (isWithdrawSwap) {
          // repayAndConvert: repay crvUSD + withdraw collateral + swap to target
          const targetToken = options!.withdrawTokenOut!;
          // For native ETH output: route via WETH, contract unwraps to ETH
          const isETHTarget = targetToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
          const routeTarget = isETHTarget ? WETH_ADDRESS : targetToken;
          const { swapData, expectedOut } = await fetchZapperSwapData({
            tokenIn: vaultAddress,
            tokenOut: routeTarget,
            amountIn: withdrawAmount.toString(),
            slippage: "100",
          });

          const expectedOutBn = BigInt(expectedOut);
          const minTargetOut = expectedOutBn * 9900n / 10000n; // 1% slippage

          const data = encodeFunctionData({
            abi: ZAPPER_ABI,
            functionName: "repayAndConvert",
            args: [
              controllerAddress,
              repayAmount,
              withdrawAmount,
              targetToken as `0x${string}`, // Pass original token (ETH_ADDRESS for native ETH → Zapper unwraps WETH)
              minTargetOut,
              swapData as `0x${string}`,
              getDeadline(),
            ],
          });

          return {
            tx: { to: ZAPPER_ADDRESS, data, value: "0", from: address },
            gas: "0",
            amountsOut: { [targetToken]: expectedOut },
          };
        } else {
          // repayAndWithdraw: repay crvUSD + withdraw collateral (no swap)
          const data = encodeFunctionData({
            abi: ZAPPER_ABI,
            functionName: "repayAndWithdraw",
            args: [
              controllerAddress,
              repayAmount,
              withdrawAmount,
              getDeadline(),
            ],
          });

          return {
            tx: { to: ZAPPER_ADDRESS, data, value: "0", from: address },
            gas: "0",
            amountsOut: {},
          };
        }
      },
      CRVUSD_ADDRESS,
      0n,
      { ...options, tokenSymbol: "crvUSD" }
    );

    return queueApprovalsOrRun(allApprovals, runBundle);
  }, [address, publicClient, executeBundle]);

  const repayWithSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    decimals: number = 18,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string; inSoftLiquidation?: boolean; withdrawAmount?: string; withdrawTokenOut?: string; withdrawTokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) return null;
    const { parseUnits } = await import("viem");
    const amountWei = parseUnits(amountIn, decimals);
    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (controllerAddress) setPendingController(controllerAddress as `0x${string}`);

    const hasWithdrawal = options?.withdrawAmount && options.withdrawAmount !== "0";
    const isWithdrawSwap = options?.withdrawTokenOut && options.withdrawTokenOut.toLowerCase() !== vaultAddress.toLowerCase();
    const withdrawAmountWei = hasWithdrawal ? BigInt(options!.withdrawAmount!) : 0n;

    // Withdrawal branch: route through RepayZapper (not ENSO_SHORTCUTS)
    if (hasWithdrawal) {
      if (!controllerAddress) {
        setError("Controller not found for this vault");
        setStatus("error");
        return null;
      }

      setStatus("building");
      setError(null);

      // Check approvals against ZAPPER_ADDRESS:
      // 1. Controller approval (always)
      // 2. tokenIn allowance (zapper pulls tokenIn for swap) — skip for ETH
      // 3. Collateral allowance (only for repayFromTokenAndConvert — pull-back after withdraw)
      // For ETH: Zapper wraps ETH→WETH atomically, so pass WETH as tokenIn and ETH as msg.value
      const isEth = tokenIn.toLowerCase() === ETH_ADDRESS.toLowerCase();
      const zapperTokenIn = isEth ? WETH_ADDRESS : tokenIn;
      const approvalChecks = [
        publicClient.readContract({
          address: controllerAddress as `0x${string}`,
          abi: CONTROLLER_APPROVE_ABI,
          functionName: "approval",
          args: [address, ZAPPER_ADDRESS],
        }).catch(() => true) as Promise<boolean>,
        isEth ? Promise.resolve(amountWei) : checkAllowance(publicClient, address, tokenIn as `0x${string}`, ZAPPER_ADDRESS),
        isWithdrawSwap
          ? checkAllowance(publicClient, address, vaultAddress, ZAPPER_ADDRESS)
          : Promise.resolve(maxUint256),
      ] as const;

      const [controllerApproved, tokenInAllowance, collateralAllowance] = await Promise.all(approvalChecks);

      const tokenSymbol = options?.tokenSymbol ?? "token";
      const vaultConfig = getVaultByAddress(vaultAddress);
      const vaultSymbol = vaultConfig?.symbol ?? "Collateral";

      const allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [
        {
          approval: {
            type: "controller",
            token: controllerAddress as `0x${string}`,
            tokenSymbol: "Controller",
            spender: ZAPPER_ADDRESS,
          },
          needed: !controllerApproved,
          label: "Lending Access",
          description: "Approve yld Zapper to manage your position",
          spender: ZAPPER_ADDRESS,
        },
        ...(!isEth ? [{
          approval: {
            token: tokenIn as `0x${string}`,
            tokenSymbol: tokenSymbol,
            spender: ZAPPER_ADDRESS,
            spenderName: "yld Zapper",
            amount: amountWei,
            decimals,
          },
          needed: tokenInAllowance < amountWei,
          label: tokenSymbol,
          description: `Approve ${tokenSymbol} for yld Zapper`,
          spender: ZAPPER_ADDRESS,
        }] : []),
      ];
      if (isWithdrawSwap) {
        allApprovals.push({
          approval: {
            token: vaultAddress,
            tokenSymbol: vaultSymbol,
            spender: ZAPPER_ADDRESS,
            spenderName: "yld Zapper",
            amount: withdrawAmountWei,
            decimals: 18,
          },
          needed: collateralAllowance < withdrawAmountWei,
          label: vaultSymbol,
          description: `Approve ${vaultSymbol} for yld Zapper`,
          spender: ZAPPER_ADDRESS,
        });
      }

      const runBundle = () => executeBundle(
        async () => {
          const { encodeFunctionData } = await import("viem");

          // Fetch input swap: tokenIn → crvUSD
          const inputRoute = await fetchZapperSwapData({
            tokenIn: zapperTokenIn,
            tokenOut: CRVUSD_ADDRESS,
            amountIn: amountWei.toString(),
            slippage: slippage.toString(),
          });
          const minCrvusd = BigInt(inputRoute.expectedOut) * BigInt(10000 - slippage) / 10000n;

          if (isWithdrawSwap) {
            // repayFromTokenAndConvert: swap tokenIn→crvUSD, repay, withdraw, swap collateral→target
            const targetToken = options!.withdrawTokenOut!;
            // For native ETH output: route via WETH, contract unwraps to ETH
            const isETHTarget = targetToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
            const routeTarget = isETHTarget ? WETH_ADDRESS : targetToken;
            const outputRoute = await fetchZapperSwapData({
              tokenIn: vaultAddress,
              tokenOut: routeTarget,
              amountIn: withdrawAmountWei.toString(),
              slippage: slippage.toString(),
            });
            const minTargetOut = BigInt(outputRoute.expectedOut) * BigInt(10000 - slippage) / 10000n;

            const data = encodeFunctionData({
              abi: ZAPPER_ABI,
              functionName: "repayFromTokenAndConvert",
              args: [
                {
                  controller: controllerAddress as `0x${string}`,
                  tokenIn: zapperTokenIn as `0x${string}`,
                  amountIn: amountWei,
                  minCrvusd,
                  withdrawAmount: withdrawAmountWei,
                  targetToken: targetToken as `0x${string}`, // Pass original token (ETH_ADDRESS for native ETH → Zapper unwraps WETH)
                  minTargetOut,
                  deadline: getDeadline(),
                },
                inputRoute.swapData as `0x${string}`,
                outputRoute.swapData as `0x${string}`,
              ],
            });

            return {
              tx: { to: ZAPPER_ADDRESS, data, value: isEth ? amountWei.toString() : "0", from: address },
              gas: "0",
              amountsOut: { [targetToken]: outputRoute.expectedOut },
            };
          } else {
            // repayFromTokenAndWithdraw: swap tokenIn→crvUSD, repay, withdraw collateral
            const data = encodeFunctionData({
              abi: ZAPPER_ABI,
              functionName: "repayFromTokenAndWithdraw",
              args: [
                controllerAddress as `0x${string}`,
                zapperTokenIn as `0x${string}`,
                amountWei,
                minCrvusd,
                withdrawAmountWei,
                inputRoute.swapData as `0x${string}`,
                getDeadline(),
              ],
            });

            return {
              tx: { to: ZAPPER_ADDRESS, data, value: isEth ? amountWei.toString() : "0", from: address },
              gas: "0",
              amountsOut: {},
            };
          }
        },
        zapperTokenIn,
        0n,
        { ...options, tokenDecimals: decimals }
      );

      return queueApprovalsOrRun(allApprovals, runBundle);
    }

    // Repay-only path (no withdrawal) — safe via ENSO_ROUTER_EXECUTOR
    return executeBundle(
      () => fetchRepayWithSwapBundle({
        fromAddress: address,
        vaultAddress,
        tokenIn,
        amountIn: amountWei.toString(),
        slippage,
        inSoftLiquidation: options?.inSoftLiquidation,
      }),
      tokenIn, // The token being swapped is the input
      amountWei,
      { ...options, tokenDecimals: decimals }
    );
  }, [address, publicClient, executeBundle]);

  // Borrow crvUSD + swap to any token via Zapper (borrowAndConvert).
  // Falls back to Enso bundle for exotic vaults (cvgCVX, pxCVX, non-ERC4626).
  // Approvals are checked against ZAPPER_ADDRESS (not ENSO_SHORTCUTS).
  const borrowAndSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenOut: string,
    debtAmount: string, // crvUSD amount (human readable)
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string; estimatedSwapOutput?: bigint; collateralAmount?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    const { parseUnits } = await import("viem");
    const debtWei = parseUnits(debtAmount, 18);
    setPendingController(controllerAddress as `0x${string}`);

    // Collateral: vault token amount (wei string) to include in borrow_more
    const collateralWei = options?.collateralAmount
      ? BigInt(options.collateralAmount)
      : 0n;

    // --- Zapper path: all outputs use borrowAndConvert (Enso handles vault deposits) ---
    setStatus("building");
    setError(null);

    // Check approvals against ZAPPER_ADDRESS (controller + collateral if adding)
    const approvalChecks = [
      publicClient.readContract({
        address: controllerAddress as `0x${string}`,
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approval",
        args: [address, ZAPPER_ADDRESS],
      }).catch(() => true) as Promise<boolean>,
      collateralWei > 0n
        ? checkAllowance(publicClient, address, vaultAddress, ZAPPER_ADDRESS)
        : Promise.resolve(maxUint256),
    ] as const;

    const [controllerApproved, vaultTokenAllowance] = await Promise.all(approvalChecks);

    const allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [
      {
        approval: {
          type: "controller",
          token: controllerAddress as `0x${string}`,
          tokenSymbol: "Controller",
          spender: ZAPPER_ADDRESS,
        },
        needed: !controllerApproved,
        label: "Lending Access",
        description: "Approve yld Zapper to borrow on your behalf",
        spender: ZAPPER_ADDRESS,
      },
    ];
    if (collateralWei > 0n) {
      const vaultConfig = getVaultByAddress(vaultAddress);
      const vaultSymbol = vaultConfig?.symbol ?? "Collateral";
      allApprovals.push({
        approval: {
          token: vaultAddress,
          tokenSymbol: vaultSymbol,
          spender: ZAPPER_ADDRESS,
          spenderName: "yld Zapper",
          amount: collateralWei,
          decimals: 18,
        },
        needed: vaultTokenAllowance < collateralWei,
        label: vaultSymbol,
        description: `Approve ${vaultSymbol} for yld Zapper`,
        spender: ZAPPER_ADDRESS,
      });
    }

    const runBundle = () => executeBundle(
      async () => {
        const { encodeFunctionData } = await import("viem");

        // All outputs use borrowAndConvert — Enso handles vault deposits natively
        // Exotic tokens (cvgCVX, pxCVX) need custom Curve/Pirex bundles since Enso can't route directly
        const isETHOut = tokenOut.toLowerCase() === ETH_ADDRESS.toLowerCase();
        const isExoticToken = tokenOut.toLowerCase() === TOKENS.CVGCVX.toLowerCase()
          || tokenOut.toLowerCase() === TOKENS.PXCVX.toLowerCase();

        let swapData: string;
        let expectedOut: string;

        if (isExoticToken) {
          const exoticType = tokenOut.toLowerCase() === TOKENS.CVGCVX.toLowerCase() ? "cvgCvx" as const : "pxCvx" as const;
          const route = await buildExoticOutputSwapData({
            amountIn: debtWei.toString(),
            type: exoticType,
            slippage,
          });
          swapData = route.swapData;
          expectedOut = route.expectedOut;
        } else {
          const routeTokenOut = isETHOut ? WETH_ADDRESS : tokenOut;
          const route = await fetchZapperSwapData({
            tokenIn: CRVUSD_ADDRESS,
            tokenOut: routeTokenOut,
            amountIn: debtWei.toString(),
            slippage: slippage.toString(),
          });
          swapData = route.swapData;
          expectedOut = route.expectedOut;
        }

        const expectedOutBn = BigInt(expectedOut);
        const minTargetOut = expectedOutBn * BigInt(10000 - slippage) / 10000n;

        const data = encodeFunctionData({
          abi: ZAPPER_ABI,
          functionName: "borrowAndConvert",
          args: [
            controllerAddress as `0x${string}`,
            collateralWei,
            debtWei,
            tokenOut as `0x${string}`, // vault share token or plain ERC20 (ETH_ADDRESS for native ETH)
            minTargetOut,
            swapData as `0x${string}`,
            getDeadline(),
          ],
        });

        return {
          tx: { to: ZAPPER_ADDRESS, data, value: "0", from: address },
          gas: "0",
          amountsOut: { [tokenOut]: expectedOut },
        };
      },
      CRVUSD_ADDRESS,
      0n,
      { ...options, tokenSymbol: options?.tokenSymbol ?? "crvUSD" }
    );

    return queueApprovalsOrRun(allApprovals, runBundle);
  }, [address, publicClient, executeBundle]);

  const selfLiquidate = useCallback(async (
    vaultAddress: `0x${string}`,
    slippage: number = 0.5,
    options?: { previewOnly?: boolean }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingController(controllerAddress as `0x${string}`);

      // Get user state to calculate min_x
      const userState = await publicClient.readContract({
        address: controllerAddress as `0x${string}`,
        abi: [
          {
            type: "function",
            name: "user_state",
            inputs: [{ name: "user", type: "address" }],
            outputs: [{ name: "", type: "uint256[4]" }],
            stateMutability: "view",
          },
        ],
        functionName: "user_state",
        args: [address],
      }) as readonly [bigint, bigint, bigint, bigint];

      const stablecoinInAmm = userState[1];
      const minX = (stablecoinInAmm * BigInt(Math.floor((100 - slippage) * 100))) / 10000n;

      // For self-liquidate, we need to encode the call data for simulation
      const { encodeFunctionData } = await import("viem");
      const callData = encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "liquidate",
            inputs: [
              { name: "user", type: "address" },
              { name: "min_x", type: "uint256" },
            ],
            outputs: [],
            stateMutability: "nonpayable",
          },
        ],
        functionName: "liquidate",
        args: [address, minX],
      });

      // Store as pseudo-bundle so executeAfterPreview can find it
      setPendingBundle({
        tx: { to: controllerAddress, data: callData, value: "0" },
        gas: "0",
        createdAt: Date.now(),
      } as unknown as EnsoBundleResponse);
      setPendingInputToken(vaultAddress);

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const simResult = await runTenderlySimulation(
          address,
          controllerAddress,
          callData,
          "0",
          vaultAddress // collateral is what we're getting back
        );

        if (simResult.result) {
          setSimulationResult(simResult.result);
        }

        if (options?.previewOnly) {
          setStatus("idle");
          return simResult.result;
        }
      } else if (testNetworkType === "tenderly") {
        setStatus("simulating");

        const vnetResult = await runVNetSimulation(
          publicClient.transport,
          { from: address, to: controllerAddress, data: callData },
          address,
        );

        if (vnetResult.result) {
          setSimulationResult(vnetResult.result);
        }

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }
      } else {
        if (process.env.NODE_ENV === "development") {
          await devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
        }
        if (options?.previewOnly) {
          setStatus("idle");
          return null;
        }
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
      }

      setStatus("executing");
      if (process.env.NODE_ENV === "development") console.log("[TX]", { fn: "liquidate", to: controllerAddress });

      const liquidateCalldata = encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "liquidate",
            inputs: [
              { name: "user", type: "address" },
              { name: "min_x", type: "uint256" },
            ],
            outputs: [],
            stateMutability: "nonpayable",
          },
        ],
        functionName: "liquidate",
        args: [address, minX],
      });
      const hash = await sendTx({
        to: controllerAddress as `0x${string}`,
        data: liquidateCalldata,
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
        invalidateBalances();
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }
      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
          logTxDiff("selfLiquidate", snapBefore, snapAfter);
        }
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult, invalidateBalances]);

  return {
    createLoan,
    createLoanWithSwap,
    createLoanWithOutputSwap,
    addCollateral,
    removeCollateral,
    addCollateralWithSwap,
    removeCollateralAndSwap,
    borrowMore,
    borrowMoreWithSwap,
    repay,
    repayDirect,
    repayAndWithdraw,
    repayWithSwap,
    borrowAndSwap,
    selfLiquidate,
    // Approval - based on bundle.tx.to
    pendingApproval,
    approvalProgress,
    approve,
    isApproving,
    isApprovalSuccess,
    executeAfterApproval,
    // Synchronous check: was approval triggered by a previewOnly call?
    // Use after an action with previewOnly returns null to distinguish "needs approval" from "no simulation data"
    wasApprovalRequested: () => pendingPreviewRef.current,
    // State
    status: effectiveStatus,
    txHash,
    error,
    simulationResult,
    pendingBundle,
    reset,
    clearError,
    executeAfterPreview,
  };
}
