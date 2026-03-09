"use client";

import { useState, useCallback } from "react";
import { useSendTransaction, useAccount } from "wagmi";
import { useTestNetwork } from "@/contexts/TestNetworkContext";

/**
 * Drop-in wrapper for wagmi's useSendTransaction.
 * When VNet or Anvil mode is detected, sends via eth_sendTransaction directly
 * to the test RPC (impersonation, no wallet signing needed).
 * Otherwise, delegates to wagmi's useSendTransaction unchanged.
 */
export function useDirectSendTransaction() {
  const wagmi = useSendTransaction();
  const { address: walletAddress } = useAccount();
  const { vnetEnabled, vnetAddress, vnetRpcUrl, testNetworkType, anvilRpcUrl } = useTestNetwork();

  // Direct-send RPC: VNet takes priority, then Anvil
  const directRpcUrl = (vnetEnabled && vnetRpcUrl) ? vnetRpcUrl
    : (testNetworkType === "anvil" && anvilRpcUrl) ? anvilRpcUrl
    : null;
  const directLabel = vnetEnabled ? "VNet" : "Anvil";

  // Direct-send state (used for both VNet and Anvil)
  const [directHash, setDirectHash] = useState<`0x${string}` | undefined>(undefined);
  const [directError, setDirectError] = useState<Error | null>(null);
  const [directStatus, setDirectStatus] = useState<"idle" | "pending" | "success" | "error">("idle");

  const fromAddress = vnetAddress ?? walletAddress;

  // Destructure stable function references from wagmi to avoid depending on the
  // entire return object (which is a new reference every render).
  const {
    sendTransactionAsync: wagmiSendTransactionAsync,
    sendTransaction: wagmiSendTransaction,
    reset: wagmiReset,
  } = wagmi;

  const sendTransactionAsync = useCallback(
    async (params: { to: `0x${string}`; data?: `0x${string}`; value?: bigint; gas?: bigint }) => {
      if (!directRpcUrl) {
        return wagmiSendTransactionAsync(params);
      }

      // Direct impersonation: send eth_sendTransaction directly via fetch
      setDirectStatus("pending");
      setDirectError(null);
      setDirectHash(undefined);

      try {
        const response = await fetch(directRpcUrl, {
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
        setDirectHash(hash);
        setDirectStatus("success");

        if (process.env.NODE_ENV === "development") {
          console.log(`[${directLabel}] eth_sendTransaction`, { from: fromAddress, to: params.to, hash });
        }

        return hash;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setDirectError(error);
        setDirectStatus("error");
        throw error;
      }
    },
    [directRpcUrl, directLabel, fromAddress, wagmiSendTransactionAsync]
  );

  const sendTransaction = useCallback(
    (params: { to: `0x${string}`; data?: `0x${string}`; value?: bigint; gas?: bigint }) => {
      if (!directRpcUrl) {
        wagmiSendTransaction(params);
        return;
      }
      // Fire-and-forget async version for sync API compatibility
      sendTransactionAsync(params).catch(() => {});
    },
    [directRpcUrl, wagmiSendTransaction, sendTransactionAsync]
  );

  const reset = useCallback(() => {
    wagmiReset();
    setDirectHash(undefined);
    setDirectError(null);
    setDirectStatus("idle");
  }, [wagmiReset]);

  if (directRpcUrl) {
    return {
      sendTransaction,
      sendTransactionAsync,
      data: directHash,
      error: directError,
      status: directStatus,
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
