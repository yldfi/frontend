"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWaitForTransactionReceipt } from "wagmi";
import { useDirectWriteContract as useWriteContract } from "@/hooks/useDirectWriteContract";
import { maxUint256 } from "viem";
import {
  fetchRepayBundle,
  fetchRepayWithSwapBundle,
  CURVE_CONTROLLERS,
} from "@/lib/curve-lending";
import { ERC20_APPROVAL_ABI } from "@/lib/abis";
import { shouldResetApprovalToZeroFirst } from "@/lib/approval-reset";
import { ETH_ADDRESS, ENSO_ROUTER_V2 } from "@/lib/enso";
import { FORBIDDEN_APPROVAL_SPENDER_ERROR, assertSafeApprovalSpender, isForbiddenApprovalSpender } from "@/lib/approval-safety";
import { CRVUSD_ADDRESS } from "@/config/addresses";
import type { EnsoBundleResponse, SimulationResult } from "@/types/enso";
import { useTestNetwork } from "@/contexts/TestNetworkContext";
import { useSendTx } from "@/hooks/useSendTx";
import { runVNetSimulation } from "@/lib/vnet-simulation";
import { snapshotTx, logTxDiff } from "@/lib/dev-logging";
import { parseEnsoError, parseErrorMessage, runTenderlySimulation, checkAllowance, anvilCall } from "@/lib/tx-utils";

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
        // Append raw hex so parseErrorMessage regex can find it
        msg = msg + " custom error " + revertData;
      }
    }
    if (process.env.NODE_ENV === "development") console.log("[eth_call]", { ok: false, to: params.to, error: msg.slice(0, 300), revertData: revertData?.slice(0, 100) });
    return { ok: false, errorMessage: msg };
  }
}

function getSimulationErrorMessage(
  ethCallError: string | undefined,
  richerResult?: { ok: boolean; errorMessage?: string; result?: SimulationResult | null },
): string {
  const resultError = richerResult?.result?.errorMessage;
  const richerMessage = richerResult && !richerResult.ok
    ? richerResult.errorMessage ?? (typeof resultError === "string" ? resultError : resultError?.message)
    : undefined;
  const lowerEthCallError = ethCallError?.toLowerCase().trim();
  const ethCallIsGeneric =
    !lowerEthCallError ||
    lowerEthCallError === "execution reverted" ||
    lowerEthCallError.includes("execution reverted") ||
    lowerEthCallError.includes("eth_call failed") ||
    lowerEthCallError === "enso:unknown";

  if (richerMessage && ethCallIsGeneric) return richerMessage;
  return ethCallError || richerMessage || "Simulation failed";
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
  borrowMore: (
    vaultAddress: `0x${string}`,
    additionalCollateral: string,
    additionalDebt: string,
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
    options?: { previewOnly?: boolean; tokenSymbol?: string; inSoftLiquidation?: boolean; closeLoan?: boolean; maxRepayAmount?: string }
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
  const [pendingInputToken, setPendingInputToken] = useState<string | null>(null);
  const [pendingController, setPendingController] = useState<`0x${string}` | null>(null);
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
  const { isLoading: isApprovalPending, isSuccess: isRawApprovalSuccess } = useWaitForTransactionReceipt({
    hash: approveHash,
    pollingInterval: 1_000,
  });
  const isApprovalSuccess = isRawApprovalSuccess && !approvalResetFlow;

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
    setApprovalProgress(null);
    setApprovalResetFlow(null);
    setPendingInputToken(null);
    setPendingController(null);
    pendingPreviewRef.current = false;
    handledApprovalHashRef.current = undefined;
    resetApprove();
  }, [resetApprove]);

  // Light reset: clears error/status but keeps simulation + bundle cached
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

  // Approve using the pending approval info (ERC20)
  // When exactApproval is true and amount is available, approve only the needed amount
  const approve = useCallback(async (exactApproval?: boolean) => {
    if (!address || !pendingApproval) return;

    if (isForbiddenApprovalSpender(pendingApproval.spender)) {
      rejectForbiddenApproval();
      return;
    }

    setStatus("approving");

    const approvalAmount = exactApproval && pendingApproval.amount
      ? pendingApproval.amount
      : maxUint256;

    const needsZeroReset = await shouldResetApprovalToZeroFirst({
      publicClient,
      owner: address,
      token: pendingApproval.token,
      spender: pendingApproval.spender,
      amount: approvalAmount,
    });

    if (needsZeroReset) {
      setApprovalResetFlow({
        stage: "reset",
        token: pendingApproval.token,
        spender: pendingApproval.spender,
        amount: approvalAmount,
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
    // ERC20 approve(address, uint256)
    writeApprove({
      address: pendingApproval.token,
      abi: ERC20_APPROVAL_ABI,
      functionName: "approve",
      args: [pendingApproval.spender, approvalAmount],
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

  // Execute the pending bundle after approval
  const executeAfterApproval = useCallback(async () => {
    // Direct bundle execution (e.g. direct create_loan)
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, tenderlyResult);
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, vnetResult);
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
  }, [pendingBundle, publicClient, address, pendingInputToken, sendTx, testNetworkType, chainId, pendingController, invalidateBalances]);

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
      const spender = ENSO_ROUTER_V2 as `0x${string}`;
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, tenderlyResult);
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, vnetResult);
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, tenderlyResult);
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, vnetResult);
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, tenderlyResult);
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, vnetResult);
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, tenderlyResult);
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, vnetResult);
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, tenderlyResult);
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, vnetResult);
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, tenderlyResult);
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
          const errorMsg = getSimulationErrorMessage(ethCallResult.errorMessage, vnetResult);
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

  const repayWithSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    decimals: number = 18,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string; inSoftLiquidation?: boolean; closeLoan?: boolean; maxRepayAmount?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) return null;
    const { parseUnits } = await import("viem");
    const amountWei = parseUnits(amountIn, decimals);
    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (controllerAddress) setPendingController(controllerAddress as `0x${string}`);

    // Swap tokenIn → crvUSD and repay via an Enso bundle (ENSO_ROUTER_V2)
    return executeBundle(
      () => fetchRepayWithSwapBundle({
        fromAddress: address,
        vaultAddress,
        tokenIn,
        amountIn: amountWei.toString(),
        slippage,
        inSoftLiquidation: options?.inSoftLiquidation,
        closeLoan: options?.closeLoan,
        maxRepayAmount: options?.maxRepayAmount,
      }),
      tokenIn, // The token being swapped is the input
      amountWei,
      { ...options, tokenDecimals: decimals }
    );
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
    addCollateral,
    removeCollateral,
    borrowMore,
    repay,
    repayDirect,
    repayWithSwap,
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
