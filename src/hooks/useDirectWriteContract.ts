"use client";

import { useState, useCallback } from "react";
import { useWriteContract, useAccount } from "wagmi";
import { encodeFunctionData } from "viem";
import { useTestNetwork } from "@/contexts/TestNetworkContext";

/**
 * Drop-in wrapper for wagmi's useWriteContract.
 * When VNet or Anvil mode is detected, encodes the call with encodeFunctionData
 * and sends via eth_sendTransaction directly to the test RPC (no signing).
 * Otherwise, delegates to wagmi's useWriteContract unchanged.
 */
export function useDirectWriteContract() {
  const wagmi = useWriteContract();
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
    writeContractAsync: wagmiWriteContractAsync,
    writeContract: wagmiWriteContract,
    reset: wagmiReset,
  } = wagmi;

  const writeContractAsync = useCallback(
    async (params: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint }) => {
      if (!directRpcUrl) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return wagmiWriteContractAsync(params as any);
      }

      setDirectStatus("pending");
      setDirectError(null);
      setDirectHash(undefined);

      try {
        // Encode the function call
        const data = encodeFunctionData({
          abi: params.abi as readonly unknown[],
          functionName: params.functionName,
          args: params.args as readonly unknown[] | undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        const response = await fetch(directRpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "eth_sendTransaction",
            params: [{
              from: fromAddress,
              to: params.address,
              data,
              value: params.value ? `0x${params.value.toString(16)}` : "0x0",
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
          console.log(`[${directLabel}] writeContract`, { from: fromAddress, to: params.address, fn: params.functionName, hash });
        }

        return hash;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setDirectError(error);
        setDirectStatus("error");
        throw error;
      }
    },
    [directRpcUrl, directLabel, fromAddress, wagmiWriteContractAsync]
  );

  const writeContract = useCallback(
    (params: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint }) => {
      if (!directRpcUrl) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wagmiWriteContract(params as any);
        return;
      }
      writeContractAsync(params).catch(() => {});
    },
    [directRpcUrl, wagmiWriteContract, writeContractAsync]
  );

  const reset = useCallback(() => {
    wagmiReset();
    setDirectHash(undefined);
    setDirectError(null);
    setDirectStatus("idle");
  }, [wagmiReset]);

  if (directRpcUrl) {
    return {
      writeContract,
      writeContractAsync,
      data: directHash,
      error: directError,
      status: directStatus,
      reset,
      isError: directStatus === "error",
    };
  }

  return {
    writeContract: wagmi.writeContract,
    writeContractAsync: wagmi.writeContractAsync,
    data: wagmi.data,
    error: wagmi.error,
    status: wagmi.status,
    reset: wagmi.reset,
    isError: wagmi.isError,
  };
}
