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
    };

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
    transactionHash?: string | null;
    isExecuted?: boolean;
    isSuccessful?: boolean | null;
    confirmations?: unknown[] | null;
    confirmationsRequired?: number | null;
  };
  const txHash = body.transactionHash && HASH_RE.test(body.transactionHash)
    ? (body.transactionHash as `0x${string}`)
    : null;

  return {
    kind: "safe",
    transactionHash: txHash,
    isExecuted: Boolean(body.isExecuted),
    isSuccessful: body.isSuccessful ?? null,
    confirmations: Array.isArray(body.confirmations) ? body.confirmations.length : 0,
    confirmationsRequired: body.confirmationsRequired ?? null,
  };
}
