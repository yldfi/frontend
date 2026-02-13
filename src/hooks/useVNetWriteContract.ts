"use client";

import { useState, useCallback } from "react";
import { useWriteContract, useAccount } from "wagmi";
import { encodeFunctionData } from "viem";
import { useTenderly } from "@/contexts/TenderlyContext";

/**
 * Drop-in wrapper for wagmi's useWriteContract.
 * When VNet mode is enabled, encodes the call with encodeFunctionData
 * and sends via eth_sendTransaction to VNet RPC (impersonation, no signing).
 * When VNet mode is disabled, delegates to wagmi's useWriteContract unchanged.
 */
export function useVNetWriteContract() {
  const wagmi = useWriteContract();
  const { address: walletAddress } = useAccount();
  const { vnetEnabled, vnetAddress, vnetRpcUrl } = useTenderly();

  // VNet-specific state
  const [vnetHash, setVnetHash] = useState<`0x${string}` | undefined>(undefined);
  const [vnetError, setVnetError] = useState<Error | null>(null);
  const [vnetStatus, setVnetStatus] = useState<"idle" | "pending" | "success" | "error">("idle");

  const fromAddress = vnetAddress ?? walletAddress;

  const writeContractAsync = useCallback(
    async (params: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint }) => {
      if (!vnetEnabled || !vnetRpcUrl) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return wagmi.writeContractAsync(params as any);
      }

      setVnetStatus("pending");
      setVnetError(null);
      setVnetHash(undefined);

      try {
        // Encode the function call
        const data = encodeFunctionData({
          abi: params.abi as readonly unknown[],
          functionName: params.functionName,
          args: params.args as readonly unknown[] | undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        const response = await fetch(vnetRpcUrl, {
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
        setVnetHash(hash);
        setVnetStatus("success");

        if (process.env.NODE_ENV === "development") {
          console.log("[VNet] writeContract", { from: fromAddress, to: params.address, fn: params.functionName, hash });
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

  const writeContract = useCallback(
    (params: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint }) => {
      if (!vnetEnabled || !vnetRpcUrl) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wagmi.writeContract(params as any);
        return;
      }
      writeContractAsync(params).catch(() => {});
    },
    [vnetEnabled, vnetRpcUrl, wagmi, writeContractAsync]
  );

  const reset = useCallback(() => {
    wagmi.reset();
    setVnetHash(undefined);
    setVnetError(null);
    setVnetStatus("idle");
  }, [wagmi]);

  if (vnetEnabled && vnetRpcUrl) {
    return {
      writeContract,
      writeContractAsync,
      data: vnetHash,
      error: vnetError,
      status: vnetStatus,
      reset,
      isError: vnetStatus === "error",
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
