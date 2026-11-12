"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useReadContract, usePublicClient, useWalletClient } from "wagmi";
import { useTxReceipt } from "@/hooks/useTxReceipt";
import { safeOutcomeMessage } from "@/lib/safe-tx-service";
import { useSafeBatch } from "@/hooks/useSafeBatch";
import { useDirectWriteContract as useWriteContract } from "@/hooks/useDirectWriteContract";
import { parseSignature, parseUnits, maxUint256 } from "viem";
import type { Hash, Hex, ReplacementReturnType } from "viem";
import { buildLegacyMorphoPermitTransaction, ENSO_ROUTER_V2, ETH_ADDRESS, LEGACY_MORPHO_ADDRESS } from "@/lib/enso";
import { FORBIDDEN_APPROVAL_SPENDER_ERROR, assertSafeApprovalSpender, isForbiddenApprovalSpender } from "@/lib/approval-safety";
import { ERC20_APPROVAL_ABI, ERC20_PERMIT_ABI } from "@/lib/abis";
import { readZapAllowance } from "@/lib/zap-allowance";
import { isQuoteOlderThan } from "@/lib/quote-freshness";
import { shouldResetApprovalToZeroFirst } from "@/lib/approval-reset";
import { useTestNetwork } from "@/contexts/TestNetworkContext";
import { useFlashbotsProtect } from "@/hooks/useFlashbotsProtect";
import { useSendTx } from "@/hooks/useSendTx";
import type { ZapQuote, SimulationResult } from "@/types/enso";
import type { PendingApproval, ApprovalProgress } from "@/types/approval";
import { parseErrorMessage } from "@/lib/tx-utils";
import { buildUnavailableSimulationResult, getSimulationErrorText, runTxPreflight } from "@/lib/tx-preflight";
import {
  buildApprovalSimulationTransaction,
  type ApprovalSimulationTransaction,
} from "@/lib/tenderly-simulation-bundle";

const ZAP_APPROVAL_SPENDER = ENSO_ROUTER_V2 as `0x${string}`;

type Call = { to: string; data: string };

/** Same calls, in the same order; addresses compare case-insensitively. */
function sameCalls(a: readonly Call[], b: readonly Call[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((call, index) => {
    const other = b[index];
    return call.data === other.data && call.to.toLowerCase() === other.to.toLowerCase();
  });
}

export type ZapStatus =
  | "idle"
  | "needsApproval"
  | "approving"
  | "checkingApproval"
  | "waitingApproval"
  | "zapping"
  | "waitingTx"
  | "success"
  | "reverted"
  | "error";

export function useZapActions(
  quote: ZapQuote | null | undefined,
  freshness?: {
    /** When the on-screen quote was fetched (ms epoch). 0 or omitted = unknown, never treated as stale. */
    quoteUpdatedAt?: number;
    /** Called when an execute is refused because the quote is too old. */
    onStaleQuote?: (info: { afterApproval: boolean }) => void;
  },
) {
  const { address: userAddress, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const queryClient = useQueryClient();
  const { testNetworkType } = useTestNetwork();
  const { isFlashbotsEnabled, isFlashbotsSupported, toggleFlashbots } = useFlashbotsProtect();
  const { sendTx } = useSendTx();
  const { canBatch, sendBatch } = useSafeBatch();
  const [actionState, setActionState] = useState<"idle" | "needsApproval" | "approving" | "checkingApproval" | "simulating" | "zapping">("idle");
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [zapHash, setZapHash] = useState<Hash | undefined>(undefined);
  const [txError, setTxError] = useState<Error | null>(null);
  const [replacementError, setReplacementError] = useState<Error | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const autoExecuteRef = useRef(false);
  const pendingOptionsRef = useRef<{ skipSimulation?: boolean; previewOnly?: boolean } | undefined>(undefined);
  /** The exact transaction and approval calls the stored simulationResult was produced for. */
  const simulatedTxRef = useRef<{
    to: string;
    data: string;
    value: bigint;
    /** Approval calls passed to the simulation, in order; empty when none. */
    approvals: Call[];
    /** Whether batch approvals were armed (Safe batch) when the simulation ran. */
    batch: boolean;
  } | null>(null);
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
  // Safe only: approval call(s) to send in the same atomic batch as the zap,
  // set when the user approves on a Safe that supports wallet_sendCalls.
  const batchApprovalsRef = useRef<ApprovalSimulationTransaction[] | null>(null);
  const executeZapInternalRef = useRef<(options?: { skipSimulation?: boolean; previewOnly?: boolean }, signal?: AbortSignal) => Promise<SimulationResult | null>>(async () => null);
  // Read at execute time, so a long approval wait sees the current age/handler
  // without `executeZap` taking new dependencies.
  const quoteUpdatedAtRef = useRef(freshness?.quoteUpdatedAt ?? 0);
  const onStaleQuoteRef = useRef(freshness?.onStaleQuote);
  useEffect(() => {
    quoteUpdatedAtRef.current = freshness?.quoteUpdatedAt ?? 0;
    onStaleQuoteRef.current = freshness?.onStaleQuote;
  });

  const invalidateBalances = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["onchain-balances"] });
    queryClient.invalidateQueries({ queryKey: ["enso-wallet-balances"] });
  }, [queryClient]);

  const isEth =
    quote?.inputToken.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const usesLegacyMorphoPermit = !!quote?.legacyMorphoPermit;
  const tokenAddress = quote?.inputToken.address as `0x${string}` | undefined;

  // Direct vault deposits/withdraws (quote.directVault) target the vault contract
  // directly instead of the Enso router, so the token approval spender is the vault
  // (deposit) — and withdraws need no approval at all (owner == msg.sender).
  const approvalSpender = quote?.directVault?.vaultAddress
    ? (quote.directVault.vaultAddress as `0x${string}`)
    : ZAP_APPROVAL_SPENDER;
  const approvalSpenderName = quote?.directVault?.symbol
    ?? "Enso Router";

  // User ERC20 approvals must target the tx entry point's spender — Enso Router
  // V2 for zaps, the vault itself for a direct deposit.
  const { data: allowance, refetch: refetchAllowance, queryKey: allowanceQueryKey } = useReadContract({
    address: tokenAddress,
    abi: ERC20_APPROVAL_ABI,
    functionName: "allowance",
    args: userAddress ? [userAddress, approvalSpender] : undefined,
    chainId, // Use connected chain
    query: {
      enabled: !!userAddress && !isEth && !usesLegacyMorphoPermit && !!tokenAddress,
    },
  });

  const approvalScope = [chainId, userAddress?.toLowerCase(), tokenAddress?.toLowerCase(), approvalSpender.toLowerCase(), quote?.inputAmount].join(":");
  const allowanceCheckRef = useRef<AbortController | null>(null);
  const confirmedApprovalRef = useRef<{ scope: string; block: bigint } | null>(null);
  const submittedApprovalScopeRef = useRef<string | null>(null);

  const previousScopeRef = useRef(approvalScope);

  // A read for a previous wallet/token/amount must never continue a new zap.
  useEffect(() => {
    if (previousScopeRef.current !== approvalScope) {
      previousScopeRef.current = approvalScope;
      // The armed batch and the stored preview were built for the previous
      // scope (wallet, token, spender or amount): drop them here, not later, so
      // nothing can send or confirm them for the new one.
      batchApprovalsRef.current = null;
      preparedApprovalSimulationRef.current = null;
      simulatedTxRef.current = null;
      queueMicrotask(() => {
        setActionState("idle");
        setPendingApproval(null);
        setApprovalResetFlow(null);
      });
    }
    return () => {
      allowanceCheckRef.current?.abort();
      allowanceCheckRef.current = null;
      autoExecuteRef.current = false;
      confirmedApprovalRef.current = null;
    };
  }, [approvalScope]);

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
  const { isLoading: isApprovalPending, isSuccess: isApprovalSuccess, data: approvalReceipt, safe: approvalSafe } =
    useTxReceipt({
      hash: approvalHash,
      checkReplacement: true,
      onReplaced: handleApprovalReplaced,
      pollingInterval: 1_000,
    });

  // Wait for zap - poll every 1 second until confirmed
  const { isLoading: isZapPending, isSuccess: isZapSuccess, data: zapReceipt, safe: zapSafe } =
    useTxReceipt({
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

  // Check if approval needed
  const needsApproval = useCallback((): boolean => {
    if (isEth || !quote || quote.legacyMorphoPermit) {
      return false;
    }
    // Withdrawing shares back into the underlying requires no approval — the
    // vault only pulls from msg.sender when owner != msg.sender (ERC4626).
    if (quote.directVault?.action === "withdraw") {
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

  // A Safe tx rejected/replaced in the Safe never executes (see useTxReceipt).
  const safeOutcomeError = useMemo(() => {
    if (zapSafe?.outcome) return safeOutcomeMessage(zapSafe.outcome, "Zap");
    if (approvalSafe?.outcome) return safeOutcomeMessage(approvalSafe.outcome, "Approval");
    return null;
  }, [zapSafe, approvalSafe]);

  // Derive status from state (avoids setState in effects)
  const status: ZapStatus = useMemo(() => {
    // Terminal on-chain states (receipt exists and shows final result)
    if (replacementError || safeOutcomeError) return "error";
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
    if (actionState === "checkingApproval") return "checkingApproval";
    if (actionState === "needsApproval" && needsApproval()) return "needsApproval";
    if (actionState === "simulating") return "zapping";
    if (actionState === "zapping") return "zapping";
    return "idle";
  }, [approveError, txError, simulationError, replacementError, safeOutcomeError, isZapReverted, isApprovalReverted, isZapSuccess, isApprovalPending, isApprovalSuccess, isZapPending, actionState, approvalResetFlow, needsApproval]);

  // Derive error message from errors or reverts
  const error = useMemo(() => {
    if (safeOutcomeError) return safeOutcomeError;
    if (simulationError) return simulationError;
    if (replacementError) return replacementError.message;
    if (approveError) return parseErrorMessage(approveError, "Approval failed");
    if (txError) return parseErrorMessage(txError, "Zap transaction failed");
    if (isApprovalReverted) return "Approval transaction reverted";
    if (isZapReverted) return "Zap transaction reverted";
    return null;
  }, [safeOutcomeError, simulationError, replacementError, approveError, txError, isApprovalReverted, isZapReverted]);

  useEffect(() => {
    if (actionState === "needsApproval" && !needsApproval()) {
      queueMicrotask(() => {
        setPendingApproval(null);
        setActionState(current => current === "needsApproval" ? "idle" : current);
      });
    }
  }, [actionState, needsApproval]);

  // Derive approvalProgress and isApproving for ApprovalCard
  const approvalProgress: ApprovalProgress | null = useMemo(() => {
    if (!pendingApproval) return null;
    return {
      step: 1,
      total: 1,
      steps: [{
        label: pendingApproval.tokenSymbol,
        description: `Approve ${pendingApproval.tokenSymbol} for ${approvalSpenderName}`,
        done: false,
        spender: approvalSpender,
      }],
    };
  }, [pendingApproval, approvalSpenderName, approvalSpender]);

  const isApproving = status === "approving" || status === "waitingApproval";

  useEffect(() => {
    if (isZapSuccess) {
      preparedApprovalSimulationRef.current = null;
      invalidateBalances();
      refetchAllowance();
    }
  }, [invalidateBalances, isZapSuccess, refetchAllowance]);

  // Auto-continuation uses the same fresh allowance check as manual execution.
  const executeZapRef = useRef<(options?: { skipSimulation?: boolean; previewOnly?: boolean }) => Promise<SimulationResult | null>>(async () => null);

  useEffect(() => {
    if (status === "error" || approveError) {
      autoExecuteRef.current = false;
      preparedApprovalSimulationRef.current = null;
      batchApprovalsRef.current = null;
    }
  }, [status, approveError]);

  useEffect(() => {
    preparedPermitTxRef.current = null;
  }, [quote]);

  const quoteInputAddress = quote?.inputToken.address;
  const quoteInputAmount = quote?.inputAmount;
  useEffect(() => {
    preparedApprovalSimulationRef.current = null;
    batchApprovalsRef.current = null;
  }, [quoteInputAddress, quoteInputAmount]);

  const rejectForbiddenApproval = useCallback(() => {
    setPendingApproval(null);
    setTxError(new Error(FORBIDDEN_APPROVAL_SPENDER_ERROR));
    setActionState("idle");
    autoExecuteRef.current = false;
    pendingOptionsRef.current = undefined;
  }, []);

  // Builds the approval call(s) for `amount` (approve(0) first when the token
  // requires a reset) and records them for the bundled simulation.
  const prepareApprovalTransactions = useCallback(async (amount: bigint): Promise<ApprovalSimulationTransaction[] | null> => {
    if (!userAddress || !tokenAddress) return null;
    const needsZeroReset = await shouldResetApprovalToZeroFirst({
      publicClient,
      owner: userAddress,
      token: tokenAddress,
      spender: approvalSpender,
      amount,
      currentAllowance: allowance as bigint | undefined,
    });
    const transactions = needsZeroReset
      ? [
          buildApprovalSimulationTransaction(tokenAddress, approvalSpender, 0n),
          buildApprovalSimulationTransaction(tokenAddress, approvalSpender, amount),
        ]
      : [buildApprovalSimulationTransaction(tokenAddress, approvalSpender, amount)];
    preparedApprovalSimulationRef.current = { owner: userAddress, token: tokenAddress, amount, transactions };
    return transactions;
  }, [userAddress, tokenAddress, publicClient, approvalSpender, allowance]);

  // Approve tokens — exact=true uses the quote amount, exact=false uses unlimited
  const approve = useCallback(async (exact: boolean) => {
    if (!userAddress || isEth || !tokenAddress || !quote) return;

    if (isForbiddenApprovalSpender(approvalSpender)) {
      rejectForbiddenApproval();
      return;
    }

    submittedApprovalScopeRef.current = approvalScope;
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
        spender: approvalSpender,
        amount: amount.toString(),
        exact,
      });
    }

    const approvalTransactions = await prepareApprovalTransactions(amount);
    if (!approvalTransactions) return;
    const needsZeroReset = approvalTransactions.length > 1;

    if (canBatch) {
      // Safe: no separate approval tx. Go straight to the zap; the approval
      // call(s) are simulated with it and sent in the same atomic batch.
      batchApprovalsRef.current = approvalTransactions;
      autoExecuteRef.current = false;
      setApprovalResetFlow(null);
      setPendingApproval(null);
      const options = pendingOptionsRef.current;
      pendingOptionsRef.current = undefined;
      void executeZapInternalRef.current(options);
      return;
    }

    if (needsZeroReset) {
      setApprovalResetFlow({
        stage: "reset",
        token: tokenAddress,
        spender: approvalSpender,
        amount,
      });
      writeApprove({
        address: tokenAddress,
        abi: ERC20_APPROVAL_ABI,
        functionName: "approve",
        args: [approvalSpender, 0n],
      });
      return;
    }

    setApprovalResetFlow(null);
    writeApprove({
      address: tokenAddress,
      abi: ERC20_APPROVAL_ABI,
      functionName: "approve",
      args: [approvalSpender, amount],
    });
  }, [userAddress, isEth, tokenAddress, quote, approvalSpender, rejectForbiddenApproval, writeApprove, approvalScope, canBatch, prepareApprovalTransactions]);

  useEffect(() => {
    if (!isApprovalSuccess || approvalReceipt?.status !== "success" || replacementError || submittedApprovalScopeRef.current !== approvalScope || !approvalHash || !approvalResetFlow || handledApprovalHashRef.current === approvalHash) return;

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
  }, [isApprovalSuccess, approvalReceipt, replacementError, approvalScope, approvalHash, approvalResetFlow, resetApprove, writeApprove]);

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

  // Sends the zap, prefixed with the approval call(s) as one atomic Safe batch
  // when the user approved on a Safe; otherwise a normal transaction. The
  // approvals are the ones the caller captured and simulated, never a ref read
  // at send time.
  const sendZapTx = useCallback(async (
    txParams: { to: `0x${string}`; data: `0x${string}`; value: bigint },
    approvals: ApprovalSimulationTransaction[] | null,
  ): Promise<Hash> => {
    if (!approvals) return sendTx(txParams);
    const id = await sendBatch([...approvals.map((t) => ({ to: t.to, data: t.data })), txParams]);
    batchApprovalsRef.current = null;
    return id;
  }, [sendTx, sendBatch]);

  // Internal execute — skips approval check, used directly and after auto-approval
  // Options:
  //   - skipSimulation: skip simulation and send tx directly (used after preview confirmation)
  //   - previewOnly: run simulation but don't send tx (for preview mode)
  // Returns the simulation result when previewOnly is true, otherwise returns null
  const executeZapInternal = useCallback(async (options?: { skipSimulation?: boolean; previewOnly?: boolean }, signal?: AbortSignal): Promise<SimulationResult | null> => {
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

    if (signal?.aborted) return null;

    // Safe batch: the approval calls armed for this send.
    const batchApprovals = batchApprovalsRef.current;

    const approvalTransactions = (() => {
      if (quote.legacyMorphoPermit) return undefined;
      // On a Safe the batch that will be sent is the batch that is simulated:
      // one source, so the approvals the user previewed are the ones sent.
      if (batchApprovals) return batchApprovals;
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

    // If skipSimulation is true, go straight to sending (used after preview mode
    // confirmation) — but only when the preview belongs to this exact transaction
    // and, for a batch, to the same approval calls that will be sent with it.
    // Anything else re-simulates below and returns a fresh preview instead.
    const simulated = simulatedTxRef.current;
    const simulatedApprovals = (approvalTransactions ?? []).map((t) => ({ to: t.to, data: t.data }));
    const simulatedThisTx = !!simulated
      && simulated.data === txParams.data
      && simulated.to.toLowerCase() === txParams.to.toLowerCase()
      && simulated.value === txParams.value
      // An EOA sends only the zap, so its approvals only matter when the
      // simulation or this send is a batch.
      && (!simulated.batch && !batchApprovals
        ? true
        : sameCalls(simulated.approvals, batchApprovals ?? []));
    // Confirm path: only send the exact transaction the user previewed.
    const confirmMismatch = !!options?.skipSimulation && !(simulationResult?.success && simulatedThisTx);
    if (options?.skipSimulation && !confirmMismatch) {
      setActionState("zapping");
      try {
        const hash = await sendZapTx(txParams, batchApprovals);
        setZapHash(hash);
      } catch (err) {
        setTxError(err instanceof Error ? err : new Error(String(err)));
        setActionState("idle");
      }
      return null;
    }
    // The quote changed since the preview: simulate the new one and return it
    // for a fresh preview instead of sending something the user never saw.
    const previewOnly = !!options?.previewOnly || confirmMismatch;

    const { simResult, ethCallResult } = await runTxPreflight({
      publicClient,
      userAddress,
      tx: { to: txParams.to, data: txParams.data, value: txParams.value },
      ethCall: { account: userAddress, ...txParams },
      simulateBodyExtra: {
        inputToken: quote.inputToken.address,
        // Non-Enso entry points (direct vault deposits) approve the
        // vault, not the Enso router — the API validates this too.
        spender: approvalSpender,
        // Tenderly can lag the block containing a just-confirmed
        // approval. Re-run the exact approval call(s) immediately
        // before the zap in a bundled simulation so every token's own
        // storage layout and approval behavior are respected.
        approvalTransactions,
      },
      vnetValue: `0x${txParams.value.toString(16)}`,
      testNetworkType,
      chainId,
      logTag: "[Tenderly Simulation]",
    });

    if (signal?.aborted) return null;

    // Store the simulation result for preview mode
    if (simResult.result) {
      simulatedTxRef.current = {
        to: txParams.to,
        data: txParams.data,
        value: txParams.value,
        approvals: simulatedApprovals,
        batch: !!batchApprovals,
      };
      setSimulationResult(simResult.result);
    }

    // If Tenderly/VNet is unavailable but the chain-level eth_call passed,
    // keep preview mode in the modal flow instead of falling through to send.
    if (!simResult.ok && ethCallResult.ok) {
      const unavailableReason = getSimulationErrorText(simResult.errorMessage) ?? "Simulation unavailable for this transaction type";
      const unavailableResult = buildUnavailableSimulationResult(simResult.result, unavailableReason);
      simulatedTxRef.current = {
        to: txParams.to,
        data: txParams.data,
        value: txParams.value,
        approvals: simulatedApprovals,
        batch: !!batchApprovals,
      };
      setSimulationResult(unavailableResult);
      if (previewOnly) {
        setActionState("idle");
        return unavailableResult;
      }
    }

    if (!simResult.ok && !ethCallResult.ok) {
      const rawMsg = (simResult as { retryable?: boolean }).retryable
        ? ethCallResult.errorMessage ?? simResult.errorMessage
        : simResult.errorMessage;
      const errorMsg = getSimulationErrorText(rawMsg) ?? "Simulation failed";
      setSimulationError(
        parseErrorMessage(new Error(errorMsg), "Transaction would fail")
      );
      setActionState("idle");
      return simResult.result ?? null;
    }

    // If previewOnly mode, stop here without sending tx and return simulation result
    if (previewOnly) {
      setActionState("idle");
      return simResult.result ?? null;
    }

    // Simulation passed - send the actual transaction (gas + Flashbots handled by useSendTx)
    // The armed batch can change while the simulation runs (the amount, token or
    // spender changed), and the page re-quotes on input change: never send a
    // batch whose approvals are not the ones just simulated.
    if (batchApprovalsRef.current !== batchApprovals) {
      setActionState("idle");
      return null;
    }
    setActionState("zapping");
    try {
      const hash = await sendZapTx(txParams, batchApprovals);
      setZapHash(hash);
    } catch (err) {
      setTxError(err instanceof Error ? err : new Error(String(err)));
      setActionState("idle");
    }
    return null;
  }, [quote, userAddress, publicClient, prepareTxParams, sendZapTx, chainId, testNetworkType, simulationResult, approvalSpender]);

  useEffect(() => {
    executeZapInternalRef.current = executeZapInternal;
  }, [executeZapInternal]);

  // Public executeZap — checks approval before executing.
  // If approval is needed, sets pendingApproval and shows the approval card.
  // The zap auto-executes after approval via the effect above.
  const executeZap = useCallback(async (options?: { skipSimulation?: boolean; previewOnly?: boolean }): Promise<SimulationResult | null> => {
    if (!quote || !userAddress || allowanceCheckRef.current) return null;
    const controller = new AbortController();
    allowanceCheckRef.current = controller;

    // Clear stale state from previous attempts (e.g., wallet rejection)
    resetApprove();
    setReplacementApprovalHash(undefined);
    setZapHash(undefined);
    setTxError(null);
    setReplacementError(null);
    setPendingApproval(null);

    setSimulationError(null);

    // Executing sends this quote's calldata as-is. The pages check its age at
    // click time; this covers the paths they can't (auto-execute after an
    // approval mines, which can be minutes later).
    if (isQuoteOlderThan(quoteUpdatedAtRef.current)) {
      allowanceCheckRef.current = null;
      setActionState("idle");
      onStaleQuoteRef.current?.({
        // True when this execute is the auto-continuation after an approval
        // just mined: the page can say the approval went through.
        afterApproval: confirmedApprovalRef.current?.scope === approvalScope,
      });
      return null;
    }

    // Safe batch armed: the approval rides in the same transaction, so the
    // on-chain allowance is expected to be short. Don't re-ask for approval.
    if (batchApprovalsRef.current) {
      try {
        return await executeZapInternal(options, controller.signal);
      } finally {
        if (allowanceCheckRef.current === controller) allowanceCheckRef.current = null;
      }
    }

    setActionState("checkingApproval");
    try {
      const requiresAllowance = !isEth && !quote.legacyMorphoPermit && quote.directVault?.action !== "withdraw";
      let insufficient = false;
      if (requiresAllowance) {
        if (!publicClient || !tokenAddress) throw new Error("Wallet is not ready to check token approval. Please try again.");
        const confirmed = confirmedApprovalRef.current;
        const freshAllowance = await readZapAllowance({
          client: publicClient, owner: userAddress, token: tokenAddress, spender: approvalSpender,
          minimumBlock: confirmed?.scope === approvalScope ? confirmed.block : undefined,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return null;
        queryClient.setQueryData(allowanceQueryKey, freshAllowance);
        insufficient = freshAllowance < parseUnits(quote.inputAmount, quote.inputToken.decimals);
      }

      // Only a successful read can lead to another approval request.
      if (insufficient) {
        if (isForbiddenApprovalSpender(approvalSpender)) {
          rejectForbiddenApproval();
          return null;
        }

        // Safe batch: the approval rides in the zap's transaction, so there's
        // no separate approval step or exact/unlimited choice. Approve the
        // exact amount: a fresh approval per batch costs nothing extra.
        if (canBatch) {
          const exactAmount = parseUnits(quote.inputAmount, quote.inputToken.decimals);
          const approvals = await prepareApprovalTransactions(exactAmount);
          if (controller.signal.aborted || !approvals) return null;
          batchApprovalsRef.current = approvals;
          return await executeZapInternal(options, controller.signal);
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
          spender: approvalSpender,
          spenderName: approvalSpenderName,
          amount: amountWei,
        });
        setActionState("needsApproval");
        return null;
      }

      // No approval needed — execute directly
      return await executeZapInternal(options, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) {
        setTxError(err instanceof Error ? err : new Error("Unable to verify token approval. Please try again."));
        setActionState("idle");
      }
      return null;
    } finally {
      if (allowanceCheckRef.current === controller) allowanceCheckRef.current = null;
    }
  }, [quote, userAddress, isEth, publicClient, tokenAddress, approvalSpender, approvalSpenderName, approvalScope, queryClient, allowanceQueryKey, executeZapInternal, rejectForbiddenApproval, resetApprove, canBatch, prepareApprovalTransactions]);

  useEffect(() => {
    executeZapRef.current = executeZap;
  }, [executeZap]);

  useEffect(() => {
    if (!autoExecuteRef.current || approvalResetFlow || !isApprovalSuccess || approvalReceipt?.status !== "success" || replacementError) return;
    autoExecuteRef.current = false;
    if (submittedApprovalScopeRef.current !== approvalScope) return;
    confirmedApprovalRef.current = { scope: approvalScope, block: approvalReceipt.blockNumber };
    const options = pendingOptionsRef.current;
    pendingOptionsRef.current = undefined;
    // Defer state updates out of the effect; no timing assumption about RPC sync.
    queueMicrotask(() => {
      if (confirmedApprovalRef.current?.scope === approvalScope) void executeZapRef.current(options);
    });
  }, [isApprovalSuccess, approvalReceipt, approvalResetFlow, replacementError, approvalScope]);

  /** True when the stored simulationResult is for the current quote's transaction. */
  const isSimulationForCurrentQuote = useCallback((): boolean => {
    const simulated = simulatedTxRef.current;
    if (!quote || !simulated) return false;
    // A batch sends its approval calls with the zap, so the preview only covers
    // this quote while the armed approvals are the ones it simulated.
    const batchApprovals = batchApprovalsRef.current;
    if ((simulated.batch || batchApprovals)
      && !sameCalls(simulated.approvals, batchApprovals ?? [])) return false;
    const current = quote.legacyMorphoPermit
      ? preparedPermitTxRef.current?.txParams
      : { to: quote.tx.to, data: quote.tx.data, value: quote.tx.value };
    if (!current
      || current.data !== simulated.data
      || current.to.toLowerCase() !== simulated.to.toLowerCase()) return false;
    try {
      return BigInt(current.value || "0") === simulated.value;
    } catch {
      // A malformed value is not the transaction that was simulated.
      return false;
    }
  }, [quote]);

  // Reset state
  const reset = useCallback(() => {
    batchApprovalsRef.current = null;
    simulatedTxRef.current = null;
    allowanceCheckRef.current?.abort();
    allowanceCheckRef.current = null;
    confirmedApprovalRef.current = null;
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
    /** Set while a Safe transaction (approval or zap) waits for signatures/execution. */
    safePending: [zapSafe, approvalSafe].find((s) => s?.isAwaitingExecution) ?? null,
    /** Approval and zap go out as one Safe transaction. */
    batchesApproval: canBatch,
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
    /** True when the stored simulationResult is for the current quote's transaction. */
    isSimulationForCurrentQuote,
  };
}
