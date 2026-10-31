"use client";

import { useAccount, useWaitForTransactionReceipt } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import type { TransactionReceipt } from "viem";
import { useIsSafeWallet } from "@/hooks/useIsSafeWallet";
import { fetchSafeMultisigTx, safeTxServiceUrl, type SafeTxLookup } from "@/lib/safe-tx-service";

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

  const lookup = useQuery<SafeTxLookup>({
    queryKey: ["safeMultisigTx", chainId, hash],
    enabled: lookupEnabled,
    queryFn: ({ signal }) => fetchSafeMultisigTx(chainId!, hash!, signal),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.kind === "safe") return data.transactionHash ? false : SAFE_POLL_MS;
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

  const safe: SafeTxStatus = {
    isAwaitingExecution: !executedHash,
    confirmations: safeTx.confirmations,
    confirmationsRequired: safeTx.confirmationsRequired,
    executedHash,
  };

  if (!executedHash) {
    // Still collecting signatures / waiting for someone to execute.
    return { ...(executed as ReceiptResult), isLoading: true, isPending: true, isFetching: true, safe } as ReceiptResult & { safe: SafeTxStatus };
  }

  // execTransaction succeeds on-chain even when the inner call reverts, so
  // surface the Safe's own verdict as a reverted receipt.
  const executedResult = executed as ReceiptResult;
  if (executedResult.data && safeTx.isSuccessful === false) {
    return {
      ...executedResult,
      data: { ...executedResult.data, status: "reverted" as const },
      safe,
    } as ReceiptResult & { safe: SafeTxStatus };
  }

  return { ...executedResult, safe };
}
