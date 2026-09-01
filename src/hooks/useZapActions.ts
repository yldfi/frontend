"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  useWaitForTransactionReceipt,
  useReadContract,
  usePublicClient,
  useWalletClient,
} from "wagmi";
import { useDirectWriteContract as useWriteContract } from "@/hooks/useDirectWriteContract";
import { parseSignature, parseUnits, maxUint256 } from "viem";
import type { Hash, Hex, ReplacementReturnType } from "viem";
import { buildLegacyMorphoPermitTransaction, ENSO_ROUTER_V2, ETH_ADDRESS, LEGACY_MORPHO_ADDRESS } from "@/lib/enso";
import { FORBIDDEN_APPROVAL_SPENDER_ERROR, assertSafeApprovalSpender, isForbiddenApprovalSpender } from "@/lib/approval-safety";
import { ERC20_APPROVAL_ABI, ERC20_PERMIT_ABI } from "@/lib/abis";
import { shouldResetApprovalToZeroFirst } from "@/lib/approval-reset";
import { useTestNetwork } from "@/contexts/TestNetworkContext";
import { useFlashbotsProtect } from "@/hooks/useFlashbotsProtect";
import { useSendTx } from "@/hooks/useSendTx";
import type { ZapQuote, SimulationResult } from "@/types/enso";
import type { PendingApproval, ApprovalProgress } from "@/types/approval";
import { runVNetSimulation } from "@/lib/vnet-simulation";
import { parseErrorMessage, anvilCall } from "@/lib/tx-utils";
import {
  buildApprovalSimulationTransaction,
  type ApprovalSimulationTransaction,
} from "@/lib/tenderly-simulation-bundle";

const ZAP_APPROVAL_SPENDER = ENSO_ROUTER_V2 as `0x${string}`;

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

export function useZapActions(quote: ZapQuote | null | undefined) {
  const { address: userAddress, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const queryClient = useQueryClient();
  const { testNetworkType } = useTestNetwork();
  const { isFlashbotsEnabled, isFlashbotsSupported, toggleFlashbots } = useFlashbotsProtect();
  const { sendTx } = useSendTx();
  const [actionState, setActionState] = useState<"idle" | "needsApproval" | "approving" | "simulating" | "zapping">("idle");
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [zapHash, setZapHash] = useState<Hash | undefined>(undefined);
  const [txError, setTxError] = useState<Error | null>(null);
  const [replacementError, setReplacementError] = useState<Error | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const autoExecuteRef = useRef(false);
  const pendingOptionsRef = useRef<{ skipSimulation?: boolean; previewOnly?: boolean } | undefined>(undefined);
  const [approvalResetFlow, setApprovalResetFlow] = useState<{
    stage: "reset" | "approve";
    token: `0x${string}`;
    spender: `0x${string}`;
    amount: bigint;
  } | null>(null);
  const handledApprovalHashRef = useRef<Hash | undefined>(undefined);
  const [replacementApprovalHash, setReplacementApprovalHash] = useState<Hash | undefined>(undefined);
  const preparedPermitTxRef = useRef<{
    key: string;
    txParams: { to: `0x${string}`; data: `0x${string}`; value: bigint };
  } | null>(null);
  const preparedApprovalSimulationRef = useRef<{
    owner: `0x${string}`;
    token: `0x${string}`;
    amount: bigint;
    transactions: ApprovalSimulationTransaction[];
  } | null>(null);

  const invalidateBalances = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["onchain-balances"] });
    queryClient.invalidateQueries({ queryKey: ["enso-wallet-balances"] });
  }, [queryClient]);

  const isEth =
    quote?.inputToken.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const usesLegacyMorphoPermit = !!quote?.legacyMorphoPermit;
  const tokenAddress = quote?.inputToken.address as `0x${string}` | undefined;

  // User ERC20 approvals must target Enso Router V2. quote.tx.to is the
  // transaction entry point and may differ from the token spender.
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: tokenAddress,
    abi: ERC20_APPROVAL_ABI,
    functionName: "allowance",
    args: userAddress ? [userAddress, ZAP_APPROVAL_SPENDER] : undefined,
    chainId, // Use connected chain
    query: {
      enabled: !!userAddress && !isEth && !usesLegacyMorphoPermit && !!tokenAddress,
    },
  });

  // Approve contract
  const {
    writeContract: writeApprove,
    data: approveHash,
    reset: resetApprove,
    error: approveError,
  } = useWriteContract();

  const approvalHash = replacementApprovalHash ?? approveHash;

  const handleApprovalReplaced = useCallback((replacement: ReplacementReturnType) => {
    setReplacementApprovalHash(replacement.transaction.hash);
    if (replacement.reason !== "repriced") {
      autoExecuteRef.current = false;
      setApprovalResetFlow(null);
      setReplacementError(new Error(
        replacement.reason === "cancelled"
          ? "Approval transaction was cancelled"
          : "Approval transaction was replaced by a different transaction"
      ));
    }
  }, []);

  const handleZapReplaced = useCallback((replacement: ReplacementReturnType) => {
    setZapHash(replacement.transaction.hash);
    if (replacement.reason !== "repriced") {
      setReplacementError(new Error(
        replacement.reason === "cancelled"
          ? "Zap transaction was cancelled"
          : "Zap transaction was replaced by a different transaction"
      ));
    }
  }, []);

  // Wait for approval - poll every 1 second until confirmed
  const { isLoading: isApprovalPending, isSuccess: isApprovalSuccess, data: approvalReceipt } =
    useWaitForTransactionReceipt({
      hash: approvalHash,
      checkReplacement: true,
      onReplaced: handleApprovalReplaced,
      pollingInterval: 1_000,
    });

  // Wait for zap - poll every 1 second until confirmed
  const { isLoading: isZapPending, isSuccess: isZapSuccess, data: zapReceipt } =
    useWaitForTransactionReceipt({
      hash: zapHash,
      checkReplacement: true,
      onReplaced: handleZapReplaced,
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
    if (replacementError) return "error";
    if (isZapReverted || isApprovalReverted) return "reverted";
    if (isZapSuccess) return "success";
    // Error states for pre-send failures (wallet rejection, simulation failure, RPC errors)
    if (approveError || txError || simulationError) return "error";
    // Active on-chain pending states
    if (approvalResetFlow && (isApprovalPending || isApprovalSuccess)) return "waitingApproval";
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
  }, [approveError, txError, simulationError, replacementError, isZapReverted, isApprovalReverted, isZapSuccess, isApprovalPending, isApprovalSuccess, isZapPending, actionState, approvalResetFlow]);

  // Derive error message from errors or reverts
  const error = useMemo(() => {
    if (simulationError) return simulationError;
    if (replacementError) return replacementError.message;
    if (approveError) return parseErrorMessage(approveError, "Approval failed");
    if (txError) return parseErrorMessage(txError, "Zap transaction failed");
    if (isApprovalReverted) return "Approval transaction reverted";
    if (isZapReverted) return "Zap transaction reverted";
    return null;
  }, [simulationError, replacementError, approveError, txError, isApprovalReverted, isZapReverted]);

  // Check if approval needed
  const needsApproval = useCallback((): boolean => {
    if (isEth || !quote || quote.legacyMorphoPermit) {
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
        description: `Approve ${pendingApproval.tokenSymbol} for Enso Router`,
        done: false,
        spender: ZAP_APPROVAL_SPENDER,
      }],
    };
  }, [pendingApproval]);

  const isApproving = status === "approving" || status === "waitingApproval";

  // Refetch allowance after approval success (external side effect only)
  useEffect(() => {
    if (isApprovalSuccess) {
      refetchAllowance();
    }
  }, [isApprovalSuccess, refetchAllowance]);

  useEffect(() => {
    if (isZapSuccess) {
      preparedApprovalSimulationRef.current = null;
      invalidateBalances();
      refetchAllowance();
    }
  }, [invalidateBalances, isZapSuccess, refetchAllowance]);

  // Ref to hold latest executeZapInternal for use in auto-execute effect
  const executeZapInternalRef = useRef<(options?: { skipSimulation?: boolean; previewOnly?: boolean }) => Promise<SimulationResult | null>>(async () => null);

  useEffect(() => {
    if (status === "error" || approveError) {
      autoExecuteRef.current = false;
      preparedApprovalSimulationRef.current = null;
    }
  }, [status, approveError]);

  useEffect(() => {
    preparedPermitTxRef.current = null;
  }, [quote]);

  const quoteInputAddress = quote?.inputToken.address;
  const quoteInputAmount = quote?.inputAmount;
  useEffect(() => {
    preparedApprovalSimulationRef.current = null;
  }, [quoteInputAddress, quoteInputAmount]);

  const rejectForbiddenApproval = useCallback(() => {
    setPendingApproval(null);
    setTxError(new Error(FORBIDDEN_APPROVAL_SPENDER_ERROR));
    setActionState("idle");
    autoExecuteRef.current = false;
    pendingOptionsRef.current = undefined;
  }, []);

  // Approve tokens — exact=true uses the quote amount, exact=false uses unlimited
  const approve = useCallback(async (exact: boolean) => {
    if (!userAddress || isEth || !tokenAddress || !quote) return;

    if (isForbiddenApprovalSpender(ZAP_APPROVAL_SPENDER)) {
      rejectForbiddenApproval();
      return;
    }

    setActionState("approving");
    setReplacementError(null);
    setReplacementApprovalHash(undefined);
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
        spender: ZAP_APPROVAL_SPENDER,
        amount: amount.toString(),
        exact,
      });
    }

    const needsZeroReset = await shouldResetApprovalToZeroFirst({
      publicClient,
      owner: userAddress,
      token: tokenAddress,
      spender: ZAP_APPROVAL_SPENDER,
      amount,
      currentAllowance: allowance as bigint | undefined,
    });

    if (needsZeroReset) {
      preparedApprovalSimulationRef.current = {
        owner: userAddress,
        token: tokenAddress,
        amount,
        transactions: [
          buildApprovalSimulationTransaction(tokenAddress, ZAP_APPROVAL_SPENDER, 0n),
          buildApprovalSimulationTransaction(tokenAddress, ZAP_APPROVAL_SPENDER, amount),
        ],
      };
      setApprovalResetFlow({
        stage: "reset",
        token: tokenAddress,
        spender: ZAP_APPROVAL_SPENDER,
        amount,
      });
      writeApprove({
        address: tokenAddress,
        abi: ERC20_APPROVAL_ABI,
        functionName: "approve",
        args: [ZAP_APPROVAL_SPENDER, 0n],
      });
      return;
    }

    preparedApprovalSimulationRef.current = {
      owner: userAddress,
      token: tokenAddress,
      amount,
      transactions: [
        buildApprovalSimulationTransaction(tokenAddress, ZAP_APPROVAL_SPENDER, amount),
      ],
    };
    setApprovalResetFlow(null);
    writeApprove({
      address: tokenAddress,
      abi: ERC20_APPROVAL_ABI,
      functionName: "approve",
      args: [ZAP_APPROVAL_SPENDER, amount],
    });
  }, [userAddress, isEth, tokenAddress, quote, publicClient, allowance, rejectForbiddenApproval, writeApprove]);

  useEffect(() => {
    if (!isApprovalSuccess || !approvalHash || !approvalResetFlow || handledApprovalHashRef.current === approvalHash) return;

    handledApprovalHashRef.current = approvalHash;

    if (approvalResetFlow.stage === "reset") {
      const nextFlow = { ...approvalResetFlow, stage: "approve" as const };
      queueMicrotask(() => {
        setApprovalResetFlow(nextFlow);
        setReplacementApprovalHash(undefined);
      });
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
  }, [isApprovalSuccess, approvalHash, approvalResetFlow, resetApprove, writeApprove]);

  const prepareTxParams = useCallback(async (): Promise<{ to: `0x${string}`; data: `0x${string}`; value: bigint }> => {
    if (!quote || !userAddress || !publicClient) {
      throw new Error("Missing wallet or quote");
    }

    if (!quote.legacyMorphoPermit) {
      return {
        to: quote.tx.to as `0x${string}`,
        data: quote.tx.data as `0x${string}`,
        value: BigInt(quote.tx.value || "0"),
      };
    }

    if (!walletClient) {
      throw new Error("Wallet is not ready to sign the legacy MORPHO permit");
    }

    const permit = quote.legacyMorphoPermit;
    assertSafeApprovalSpender(permit.spender);
    const key = [
      userAddress.toLowerCase(),
      permit.amount,
      permit.spender.toLowerCase(),
      permit.postPermitCalls.map((call) => call.data).join(":"),
    ].join("|");
    if (preparedPermitTxRef.current?.key === key) {
      return preparedPermitTxRef.current.txParams;
    }

    const nonce = await publicClient.readContract({
      address: permit.token as `0x${string}`,
      abi: ERC20_PERMIT_ABI,
      functionName: "nonces",
      args: [userAddress],
    });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    const signature = await walletClient.signTypedData({
      account: userAddress,
      domain: {
        name: "Morpho Token",
        version: "1",
        chainId: 1,
        verifyingContract: LEGACY_MORPHO_ADDRESS as `0x${string}`,
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: userAddress,
        spender: permit.spender as `0x${string}`,
        value: BigInt(permit.amount),
        nonce,
        deadline,
      },
    });
    const parsed = parseSignature(signature);
    const v = Number(parsed.v ?? BigInt(27 + parsed.yParity));
    const tx = buildLegacyMorphoPermitTransaction({
      permit,
      owner: userAddress,
      deadline,
      v,
      r: parsed.r as Hex,
      s: parsed.s as Hex,
    });
    const txParams = {
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
      value: BigInt(tx.value || "0"),
    };
    preparedPermitTxRef.current = { key, txParams };
    return txParams;
  }, [quote, userAddress, publicClient, walletClient]);

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

    let txParams: { to: `0x${string}`; data: `0x${string}`; value: bigint };
    try {
      txParams = await prepareTxParams();
    } catch (err) {
      setTxError(err instanceof Error ? err : new Error(String(err)));
      setActionState("idle");
      return null;
    }

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

    const approvalTransactions = (() => {
      if (quote.legacyMorphoPermit) return undefined;
      const prepared = preparedApprovalSimulationRef.current;
      if (
        !prepared ||
        prepared.owner.toLowerCase() !== userAddress.toLowerCase() ||
        prepared.token.toLowerCase() !== quote.inputToken.address.toLowerCase()
      ) {
        return undefined;
      }
      try {
        const requiredAmount = parseUnits(quote.inputAmount, quote.inputToken.decimals);
        return prepared.amount >= requiredAmount ? prepared.transactions : undefined;
      } catch {
        return undefined;
      }
    })();

    // If skipSimulation is true, go straight to sending (used after preview mode confirmation)
    if (options?.skipSimulation && simulationResult?.success) {
      setActionState("zapping");
      try {
        const hash = await sendTx(txParams);
        setZapHash(hash);
      } catch (err) {
        setTxError(err instanceof Error ? err : new Error(String(err)));
        setActionState("idle");
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
                to: txParams.to,
                data: txParams.data,
                value: txParams.value.toString(),
                inputToken: quote.inputToken.address,
                // Tenderly can lag the block containing a just-confirmed
                // approval. Re-run the exact approval call(s) immediately
                // before the zap in a bundled simulation so every token's own
                // storage layout and approval behavior are respected.
                approvalTransactions,
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
            { from: userAddress, to: txParams.to, data: txParams.data, value: txParams.value.toString() },
            userAddress,
          )
        : Promise.resolve({ ok: true as const, result: null });

    const ethCallPromise = (async () => {
      try {
        await anvilCall(publicClient, {
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

    // If Tenderly/VNet is unavailable but the chain-level eth_call passed,
    // keep preview mode in the modal flow instead of falling through to send.
    if (!simResult.ok && ethCallResult.ok) {
      const unavailableReason = typeof simResult.errorMessage === "string"
        ? simResult.errorMessage
        : simResult.errorMessage?.message
          ?? simResult.errorMessage?.slug
          ?? "Simulation unavailable for this transaction type";
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
      if (options?.previewOnly) {
        setActionState("idle");
        return unavailableResult;
      }
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

    // Simulation passed - send the actual transaction (gas + Flashbots handled by useSendTx)
    setActionState("zapping");
    try {
      const hash = await sendTx(txParams);
      setZapHash(hash);
    } catch (err) {
      setTxError(err instanceof Error ? err : new Error(String(err)));
      setActionState("idle");
    }
    return null;
  }, [quote, userAddress, publicClient, prepareTxParams, sendTx, chainId, testNetworkType, simulationResult]);

  // Keep ref in sync with latest executeZapInternal
  useEffect(() => {
    executeZapInternalRef.current = executeZapInternal;
  }, [executeZapInternal]);

  // Auto-execute zap after approval succeeds
  // After approval confirms, isApprovalPending goes false but actionState stays "approving",
  // so status transitions from "waitingApproval" → "approving" (not "idle").
  const prevStatus = useRef<ZapStatus>("idle");
  useEffect(() => {
    if (
      autoExecuteRef.current &&
      prevStatus.current === "waitingApproval" &&
      !approvalResetFlow &&
      (status === "idle" || status === "needsApproval" || status === "approving")
    ) {
      // Approval completed — preserve original options and continue into execution.
      autoExecuteRef.current = false;
      const options = pendingOptionsRef.current;
      pendingOptionsRef.current = undefined;
      setTimeout(() => {
        executeZapInternalRef.current(options);
      }, 100);
    }
    prevStatus.current = status;
  }, [status, approvalResetFlow]);

  // Public executeZap — checks approval before executing.
  // If approval is needed, sets pendingApproval and shows the approval card.
  // The zap auto-executes after approval via the effect above.
  const executeZap = useCallback(async (options?: { skipSimulation?: boolean; previewOnly?: boolean }): Promise<SimulationResult | null> => {
    if (!quote || !userAddress) return null;

    // Clear stale state from previous attempts (e.g., wallet rejection)
    resetApprove();
    setReplacementApprovalHash(undefined);
    setZapHash(undefined);
    setTxError(null);
    setReplacementError(null);
    setPendingApproval(null);

    // Check if approval is needed
    if (needsApproval()) {
      if (isForbiddenApprovalSpender(ZAP_APPROVAL_SPENDER)) {
        rejectForbiddenApproval();
        return null;
      }

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
        spender: ZAP_APPROVAL_SPENDER,
        spenderName: "Enso Router",
        amount: amountWei,
      });
      setActionState("needsApproval");
      return null;
    }

    // No approval needed — execute directly
    return executeZapInternal(options);
  }, [quote, userAddress, needsApproval, tokenAddress, executeZapInternal, rejectForbiddenApproval, resetApprove]);

  // Reset state
  const reset = useCallback(() => {
    setActionState("idle");
    setSimulationError(null);
    setSimulationResult(null);
    setZapHash(undefined);
    setTxError(null);
    setReplacementError(null);
    setPendingApproval(null);
    autoExecuteRef.current = false;
    pendingOptionsRef.current = undefined;
    preparedPermitTxRef.current = null;
    preparedApprovalSimulationRef.current = null;
    setReplacementApprovalHash(undefined);
    setApprovalResetFlow(null);
    handledApprovalHashRef.current = undefined;
    resetApprove();
  }, [resetApprove]);

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
    // Prefer the mined receipt hash as a final guard against replacement races.
    // viem returns the replacement receipt when a repriced transaction wins.
    zapHash: zapReceipt?.transactionHash ?? zapHash,
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
