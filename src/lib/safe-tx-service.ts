/**
 * Safe Transaction Service client.
 *
 * When a Safe is connected (e.g. Safe{Wallet} over WalletConnect),
 * `eth_sendTransaction` returns the Safe's internal safeTxHash, not an
 * on-chain transaction hash. The on-chain transaction only exists once enough
 * owners have signed and someone executes it, and it has a different hash.
 * This client maps a safeTxHash to that on-chain hash.
 */

const SAFE_TX_SERVICE_URLS: Record<number, string> = {
  1: "https://api.safe.global/tx-service/eth",
};

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export type SafeTxLookup =
  /** The service has no multisig tx with this hash: it is an ordinary tx hash. */
  | { kind: "not-found" }
  | {
      kind: "safe";
      /** On-chain hash once executed, otherwise null. */
      transactionHash: `0x${string}` | null;
      isExecuted: boolean;
      /**
       * Whether the inner call succeeded. execTransaction itself does not
       * revert when the inner call fails (it emits ExecutionFailure), so the
       * on-chain receipt says "success" either way. null until executed.
       */
      isSuccessful: boolean | null;
      confirmations: number;
      confirmationsRequired: number | null;
      /**
       * Set when the tx can never execute: the Safe's nonce has moved past it.
       * "rejected" = the owners executed Safe's on-chain rejection (a 0-value,
       * no-data call to the Safe itself) for this nonce; "replaced" = some other
       * tx used it. null while it can still execute.
       */
      outcome: SafeTxOutcome;
    };

export type SafeTxOutcome = "rejected" | "replaced" | null;

export function safeTxServiceUrl(chainId: number | undefined): string | undefined {
  return chainId === undefined ? undefined : SAFE_TX_SERVICE_URLS[chainId];
}

export async function fetchSafeMultisigTx(
  chainId: number,
  safeTxHash: string,
  signal?: AbortSignal,
): Promise<SafeTxLookup> {
  const base = safeTxServiceUrl(chainId);
  if (!base) throw new Error(`No Safe Transaction Service for chain ${chainId}`);
  if (!HASH_RE.test(safeTxHash)) throw new Error("Invalid transaction hash");

  const res = await fetch(`${base}/api/v1/multisig-transactions/${safeTxHash}/`, { signal });
  if (res.status === 404) return { kind: "not-found" };
  if (!res.ok) throw new Error(`Safe Transaction Service returned ${res.status}`);

  const body = (await res.json()) as {
    safe?: string;
    nonce?: number | string;
    transactionHash?: string | null;
    isExecuted?: boolean;
    isSuccessful?: boolean | null;
    confirmations?: unknown[] | null;
    confirmationsRequired?: number | null;
  };
  const txHash = body.transactionHash && HASH_RE.test(body.transactionHash)
    ? (body.transactionHash as `0x${string}`)
    : null;
  const isExecuted = Boolean(body.isExecuted);

  let outcome: SafeTxOutcome = null;
  if (!isExecuted && body.safe && ADDRESS_RE.test(body.safe) && body.nonce !== undefined) {
    // Best effort: a failed check just means "still pending" for another poll.
    outcome = await fetchNonceOutcome(base, body.safe, Number(body.nonce), safeTxHash, signal).catch(() => null);
  }

  return {
    kind: "safe",
    transactionHash: txHash,
    isExecuted,
    isSuccessful: body.isSuccessful ?? null,
    confirmations: Array.isArray(body.confirmations) ? body.confirmations.length : 0,
    confirmationsRequired: body.confirmationsRequired ?? null,
    outcome,
  };
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Whether an unexecuted Safe tx at `nonce` has been superseded. Only asks for
 * the executed tx when the Safe's nonce has actually moved past it.
 */
export async function fetchNonceOutcome(
  base: string,
  safe: string,
  nonce: number,
  ownSafeTxHash: string,
  signal?: AbortSignal,
): Promise<SafeTxOutcome> {
  if (!Number.isInteger(nonce) || nonce < 0) return null;
  const safeRes = await fetch(`${base}/api/v1/safes/${safe}/`, { signal });
  if (!safeRes.ok) return null;
  const safeNonce = Number(((await safeRes.json()) as { nonce?: number | string }).nonce);
  if (!Number.isFinite(safeNonce) || safeNonce <= nonce) return null;

  const execRes = await fetch(
    `${base}/api/v1/safes/${safe}/multisig-transactions/?nonce=${nonce}&executed=true&limit=1`,
    { signal },
  );
  // Not "replaced" on uncertainty: right after our own tx executes, the Safe's
  // nonce can move before the service lists the tx as executed.
  if (!execRes.ok) return null;
  const executed = ((await execRes.json()) as {
    results?: Array<{ safeTxHash?: string; to?: string; value?: string; data?: string | null }>;
  }).results?.[0];
  if (!executed) return null;
  if (executed.safeTxHash?.toLowerCase() === ownSafeTxHash.toLowerCase()) return null;
  const isRejection = Boolean(
    executed &&
      executed.to?.toLowerCase() === safe.toLowerCase() &&
      (executed.value ?? "0") === "0" &&
      (!executed.data || executed.data === "0x"),
  );
  return isRejection ? "rejected" : "replaced";
}

export function safeOutcomeMessage(outcome: Exclude<SafeTxOutcome, null>, action = "Transaction"): string {
  return outcome === "rejected"
    ? `${action} was rejected in your Safe.`
    : `${action} was replaced in your Safe: another transaction used its nonce.`;
}
