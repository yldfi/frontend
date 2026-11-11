"use client";

import { useRef, useState } from "react";
import { useAccount, useWaitForTransactionReceipt } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import type { TransactionReceipt } from "viem";
import { useIsSafeWallet } from "@/hooks/useIsSafeWallet";
import {
  fetchSafeMultisigTx,
  safeExecutionVerdict,
  safeOutcomeMessage,
  safeTxServiceUrl,
  type SafeTxLookup,
  type SafeTxOutcome,
} from "@/lib/safe-tx-service";

type ReceiptParams = Parameters<typeof useWaitForTransactionReceipt>[0];
type ReceiptResult = Omit<ReturnType<typeof useWaitForTransactionReceipt>, "data"> & {
  data: TransactionReceipt | undefined;
};

export type SafeTxStatus = {
  /** The hash we were given is a safeTxHash still waiting for signatures/execution. */
  isAwaitingExecution: boolean;
  confirmations: number;
  confirmationsRequired: number | null;
  /** On-chain hash once the Safe executed the transaction. */
  executedHash: `0x${string}` | null;
  /** Rejected / replaced in the Safe: it will never execute. */
  outcome: SafeTxOutcome;
};

const SAFE_POLL_MS = 5_000;
/**
 * The Safe app may answer WalletConnect a moment before the service has
 * indexed the proposal, so a 404 is only trusted after a few polls. Until
 * then (and after), the plain receipt wait keeps running in parallel, so an
 * ordinary tx hash still confirms immediately.
 */
const NOT_FOUND_POLLS_BEFORE_GIVING_UP = 3;
/**
 * The service can report the executed hash before it has indexed whether the
 * inner call succeeded (`isSuccessful: null`). Keep asking for this long after
 * the hash first appears; after that, accept the on-chain receipt status so a
 * service that never fills the field cannot hang the UI.
 */
const VERDICT_POLLS_BEFORE_ACCEPTING = 10;
const VERDICT_WAIT_MS = VERDICT_POLLS_BEFORE_ACCEPTING * SAFE_POLL_MS;

/**
 * Drop-in replacement for wagmi's `useWaitForTransactionReceipt` that also
 * works when the connected account is a Safe.
 *
 * A Safe returns its safeTxHash from `eth_sendTransaction`. No transaction with
 * that hash is ever mined, so the plain hook waits until viem's 180 s timeout
 * and errors, even after the Safe executes. For Safe accounts this hook asks
 * the Safe Transaction Service for the on-chain hash and waits on that instead.
 * For any other account it behaves exactly like the wagmi hook.
 */
export function useTxReceipt(params: ReceiptParams = {}): ReceiptResult & { safe: SafeTxStatus | null } {
  const { address, chainId } = useAccount();
  const isSafe = useIsSafeWallet(address, chainId);
  const hash = params.hash;
  const callerEnabled = params.query?.enabled ?? true;
  const lookupEnabled = Boolean(isSafe && hash && callerEnabled && safeTxServiceUrl(chainId));

  // When the service first reported this safeTxHash as executed, so the verdict
  // wait can be bounded to VERDICT_WAIT_MS of wall-clock time. Keyed by the
  // hash, and time-based rather than poll-counted, so a service that starts
  // failing cannot keep the receipt pending forever.
  const verdictWait = useRef<{ safeTxHash: string | undefined; since: number }>({
    safeTxHash: undefined,
    since: 0,
  });

  // Bounded wait for the service to publish the inner-call verdict: which
  // safeTxHash it belongs to, and whether the wait is over. State, not just the
  // ref, because the return value below has to observe it.
  const [verdictWaitOver, setVerdictWaitOver] = useState<{ safeTxHash: string | undefined; over: boolean }>({
    safeTxHash: undefined,
    over: false,
  });
  const markVerdictWait = (over: boolean) =>
    setVerdictWaitOver((prev) => (prev.safeTxHash === hash && prev.over === over ? prev : { safeTxHash: hash, over }));

  const lookup = useQuery<SafeTxLookup>({
    queryKey: ["safeMultisigTx", chainId, hash],
    enabled: lookupEnabled,
    queryFn: ({ signal }) => fetchSafeMultisigTx(chainId!, hash!, signal),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.kind === "safe") {
        // A tx that can never execute, or that already has a verdict, is settled.
        if (data.outcome) return false;
        if (!data.transactionHash) return SAFE_POLL_MS;
        if (data.isSuccessful !== null) return false;
        // Executed but the verdict isn't indexed yet: keep polling for a while,
        // because "not known yet" must not be reported as success.
        const tracked = verdictWait.current;
        if (tracked.safeTxHash !== hash) {
          verdictWait.current = { safeTxHash: hash, since: Date.now() };
          markVerdictWait(false);
          return SAFE_POLL_MS;
        }
        // Wall clock, not the data's timestamp: a service that starts failing
        // would otherwise freeze `dataUpdatedAt` and keep the wait alive forever.
        // Keep returning a number (polling) for as long as the wait lasts, even
        // when the latest fetch errored.
        const waitOver = Date.now() - tracked.since >= VERDICT_WAIT_MS;
        markVerdictWait(waitOver);
        return waitOver ? false : SAFE_POLL_MS;
      }
      // The query key includes the hash, so this counts fetches for this hash only.
      if (data?.kind === "not-found" && query.state.dataUpdateCount >= NOT_FOUND_POLLS_BEFORE_GIVING_UP) return false;
      return SAFE_POLL_MS;
    },
    retry: 2,
  });

  const safeTx = lookupEnabled && lookup.data?.kind === "safe" ? lookup.data : null;
  const executedHash = safeTx?.transactionHash ?? null;

  // Plain wait on the given hash: the only path for non-Safe accounts, and
  // the fallback while a Safe lookup hasn't identified the hash as a safeTxHash.
  const direct = useWaitForTransactionReceipt({
    ...params,
    query: { ...params.query, enabled: callerEnabled && Boolean(hash) && !safeTx },
  } as ReceiptParams);

  // Wait on the executed on-chain hash. Replacement tracking doesn't apply:
  // the executor's tx is already mined by the time the service reports it.
  const executed = useWaitForTransactionReceipt({
    ...params,
    hash: executedHash ?? undefined,
    checkReplacement: false,
    onReplaced: undefined,
    query: { ...params.query, enabled: callerEnabled && Boolean(executedHash) },
  } as ReceiptParams);

  if (!safeTx) return { ...(direct as ReceiptResult), safe: null };

  const outcome = executedHash ? null : safeTx.outcome;
  const safe: SafeTxStatus = {
    isAwaitingExecution: !executedHash && !outcome,
    confirmations: safeTx.confirmations,
    confirmationsRequired: safeTx.confirmationsRequired,
    executedHash,
    outcome,
  };

  if (outcome) {
    // It will never execute: stop "Waiting for Safe" and surface why.
    return {
      ...(executed as ReceiptResult),
      data: undefined,
      isLoading: false,
      isPending: false,
      isFetching: false,
      isSuccess: false,
      isError: true,
      error: new Error(safeOutcomeMessage(outcome)),
      safe,
    } as unknown as ReceiptResult & { safe: SafeTxStatus };
  }

  if (!executedHash) {
    // Still collecting signatures / waiting for someone to execute.
    return { ...(executed as ReceiptResult), isLoading: true, isPending: true, isFetching: true, safe } as ReceiptResult & { safe: SafeTxStatus };
  }

  // execTransaction succeeds on-chain even when the inner call reverts, so the
  // receipt's own status cannot be trusted. Two sources decide it: the Safe's
  // ExecutionSuccess/ExecutionFailure logs in that receipt (immediate), then the
  // service's isSuccessful field (which can lag behind the hash). While both are
  // inconclusive, keep reporting the tx as pending rather than as success.
  const executedResult = executed as ReceiptResult;
  if (executedResult.data) {
    const verdict = safeExecutionVerdict({
      safe: safeTx.safe,
      logs: executedResult.data.logs,
      isSuccessful: safeTx.isSuccessful,
      safeTxHash: hash ?? "",
    });
    if (verdict === "failed") {
      return {
        ...executedResult,
        data: { ...executedResult.data, status: "reverted" as const },
        safe,
      } as ReceiptResult & { safe: SafeTxStatus };
    }
    // After the bounded wait, accept the on-chain receipt status as before.
    const waitOver = verdictWaitOver.safeTxHash === hash && verdictWaitOver.over;
    if (verdict === "unknown" && !waitOver) {
      return {
        ...executedResult,
        data: undefined,
        isLoading: true,
        isPending: true,
        isSuccess: false,
        safe,
      } as ReceiptResult & { safe: SafeTxStatus };
    }
  }

  return { ...executedResult, safe };
}
