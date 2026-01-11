"use client";

import { useEffect } from "react";
import { useConnect, useAccount, useDisconnect } from "wagmi";
import { IMPERSONATE_STORAGE_KEY } from "@/config/wagmi";

/**
 * Hook that auto-connects with the Impersonator wallet if localStorage has an address.
 * Use this in your app layout to enable impersonation mode.
 *
 * Usage:
 * 1. Set localStorage.setItem('impersonate', '0x...address...')
 * 2. Reload the page
 * 3. The app will auto-connect as that address
 *
 * To disconnect: localStorage.removeItem('impersonate') and reload
 */
export function useImpersonator() {
  const { connect, connectors } = useConnect();
  const { isConnected, address } = useAccount();
  const { disconnect } = useDisconnect();

  useEffect(() => {
    // Only run on client
    if (typeof window === "undefined") return;

    const impersonateAddress = localStorage.getItem(IMPERSONATE_STORAGE_KEY);

    // If no impersonate address, do nothing
    if (!impersonateAddress || !/^0x[a-fA-F0-9]{40}$/.test(impersonateAddress)) {
      return;
    }

    // Find the impersonator connector
    const impersonatorConnector = connectors.find(c => c.id === "mock");

    if (!impersonatorConnector) {
      console.warn("[useImpersonator] Mock connector not found in config");
      return;
    }

    // If already connected with wrong address, disconnect first
    if (isConnected && address?.toLowerCase() !== impersonateAddress.toLowerCase()) {
      console.log("[useImpersonator] Connected to different address, disconnecting...");
      disconnect();
      return; // Will re-run after disconnect
    }

    // If not connected, connect with impersonator
    if (!isConnected) {
      console.log("[useImpersonator] Auto-connecting as:", impersonateAddress);
      connect({ connector: impersonatorConnector });
    }
  }, [connect, connectors, isConnected, address, disconnect]);

  return {
    isImpersonating: typeof window !== "undefined" && !!localStorage.getItem(IMPERSONATE_STORAGE_KEY),
  };
}
