"use client";

import { useCallback } from "react";
import { useAccount, useCapabilities, useWalletClient } from "wagmi";
import type { Hash } from "viem";
import { useIsSafeWallet } from "@/hooks/useIsSafeWallet";

export type BatchCall = { to: `0x${string}`; data: `0x${string}`; value?: bigint };

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Atomic batching (EIP-5792 `wallet_sendCalls`) for Safe accounts, so
 * "approve + action" is one Safe transaction (one set of signatures) instead
 * of two.
 *
 * Only Safes use this path. Safe{Wallet} returns the safeTxHash as the batch
 * id (safe-wallet-monorepo apps/web/src/services/safe-wallet-provider:
 * `return { id: safeTxHash }`), so the id is tracked like any other Safe
 * transaction by useTxReceipt. Other wallets can advertise atomic support
 * too, but their batch ids aren't transaction hashes, and an EOA reporting
 * "ready" would prompt an EIP-7702 account upgrade, so they keep the
 * two-step flow.
 */
export function useSafeBatch() {
  const { address, chainId } = useAccount();
  const isSafe = useIsSafeWallet(address, chainId);
  const { data: walletClient } = useWalletClient();
  const { data: capabilities } = useCapabilities({
    query: { enabled: isSafe, staleTime: Infinity, retry: false },
  });

  const chainCapabilities = chainId !== undefined
    ? (capabilities as Record<number, { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } }> | undefined)?.[chainId]
    : undefined;
  // Safe{Wallet} over WalletConnect reports `atomic.status`; the Safe Apps
  // provider (dapp opened inside Safe{Wallet}) only reports the older
  // `atomicBatch.supported`, which viem passes through unchanged.
  const supportsAtomic = chainCapabilities?.atomic?.status === "supported"
    || chainCapabilities?.atomicBatch?.supported === true;
  const canBatch = isSafe && supportsAtomic && Boolean(walletClient);

  const sendBatch = useCallback(async (calls: BatchCall[]): Promise<Hash> => {
    if (!walletClient || !address) throw new Error("Wallet is not ready");
    const { id } = await walletClient.sendCalls({
      account: address,
      calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })),
      forceAtomic: true,
    });
    if (!HASH_RE.test(id)) {
      // Can't track a non-hash id through the Safe Transaction Service.
      throw new Error("Wallet returned an unexpected batch id; check your Safe queue");
    }
    return id as Hash;
  }, [walletClient, address]);

  return { canBatch, sendBatch };
}
