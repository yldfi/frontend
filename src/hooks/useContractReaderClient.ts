"use client";

import { useEffect } from "react";
import { usePublicClient } from "wagmi";
import { setSharedClient } from "@/lib/explorer/contractReader";
import type { PublicClient } from "viem";

/**
 * Hook to sync wagmi's public client with the contract reader module.
 * This allows the Contract Explorer to use the app's configured RPC
 * (and user's wallet RPC when connected) instead of the fallback public RPC.
 *
 * Call this hook once in your component tree where contract reading happens.
 */
export function useContractReaderClient() {
  const publicClient = usePublicClient();

  useEffect(() => {
    if (publicClient) {
      // Cast to PublicClient since wagmi's type is slightly different but compatible
      setSharedClient(publicClient as unknown as PublicClient);
      console.log("[ContractReader] Using wagmi public client");
    }

    return () => {
      // Don't clear on unmount - other components may still need it
      // setSharedClient(null);
    };
  }, [publicClient]);
}
