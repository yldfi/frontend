"use client";

import { useState, useCallback } from "react";
import { useSendTransaction, useAccount } from "wagmi";
import { useTenderly } from "@/contexts/TenderlyContext";

/**
 * Drop-in wrapper for wagmi's useSendTransaction.
 * When VNet mode is enabled, sends via eth_sendTransaction to VNet RPC
 * with impersonation (no wallet signing needed).
 * When VNet mode is disabled, delegates to wagmi's useSendTransaction unchanged.
 */
export function useVNetSendTransaction() {
  const wagmi = useSendTransaction();
  const { address: walletAddress } = useAccount();
  const { vnetEnabled, vnetAddress, vnetRpcUrl } = useTenderly();

  // VNet-specific state
  const [vnetHash, setVnetHash] = useState<`0x${string}` | undefined>(undefined);
  const [vnetError, setVnetError] = useState<Error | null>(null);
  const [vnetStatus, setVnetStatus] = useState<"idle" | "pending" | "success" | "error">("idle");

  const fromAddress = vnetAddress ?? walletAddress;

  const sendTransactionAsync = useCallback(
    async (params: { to: `0x${string}`; data?: `0x${string}`; value?: bigint; gas?: bigint }) => {
      if (!vnetEnabled || !vnetRpcUrl) {
        return wagmi.sendTransactionAsync(params);
      }

      // VNet impersonation: send eth_sendTransaction directly via fetch
      setVnetStatus("pending");
      setVnetError(null);
      setVnetHash(undefined);

      try {
        const response = await fetch(vnetRpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "eth_sendTransaction",
            params: [{
              from: fromAddress,
              to: params.to,
              data: params.data ?? "0x",
              value: params.value ? `0x${params.value.toString(16)}` : "0x0",
              ...(params.gas ? { gas: `0x${params.gas.toString(16)}` } : {}),
            }],
          }),
        });

        const json = await response.json() as { result?: string; error?: { message: string } };
        if (json.error) {
          throw new Error(json.error.message);
        }

        const hash = json.result as `0x${string}`;
        setVnetHash(hash);
        setVnetStatus("success");

        if (process.env.NODE_ENV === "development") {
          console.log("[VNet] eth_sendTransaction", { from: fromAddress, to: params.to, hash });
        }

        return hash;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setVnetError(error);
        setVnetStatus("error");
        throw error;
      }
    },
    [vnetEnabled, vnetRpcUrl, fromAddress, wagmi]
  );

  const sendTransaction = useCallback(
    (params: { to: `0x${string}`; data?: `0x${string}`; value?: bigint; gas?: bigint }) => {
      if (!vnetEnabled || !vnetRpcUrl) {
        wagmi.sendTransaction(params);
        return;
      }
      // Fire-and-forget async version for sync API compatibility
      sendTransactionAsync(params).catch(() => {});
    },
    [vnetEnabled, vnetRpcUrl, wagmi, sendTransactionAsync]
  );

  const reset = useCallback(() => {
    wagmi.reset();
    setVnetHash(undefined);
    setVnetError(null);
    setVnetStatus("idle");
  }, [wagmi]);

  if (vnetEnabled && vnetRpcUrl) {
    return {
      sendTransaction,
      sendTransactionAsync,
      data: vnetHash,
      error: vnetError,
      status: vnetStatus,
      reset,
    };
  }

  return {
    sendTransaction: wagmi.sendTransaction,
    sendTransactionAsync: wagmi.sendTransactionAsync,
    data: wagmi.data,
    error: wagmi.error,
    status: wagmi.status,
    reset: wagmi.reset,
  };
}
