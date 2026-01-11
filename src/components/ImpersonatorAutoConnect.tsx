"use client";

import { useEffect, useRef } from "react";
import { useConnect, useAccount, useDisconnect } from "wagmi";
import { IMPERSONATE_STORAGE_KEY } from "@/config/wagmi";

/**
 * Component that auto-connects with the Impersonator wallet if localStorage has an address.
 * Place this inside WagmiProvider/RainbowKitProvider.
 *
 * Usage:
 * 1. Set localStorage.setItem('impersonate', '0x...address...')
 * 2. Reload the page
 * 3. The app will auto-connect as that address
 *
 * To disconnect: localStorage.removeItem('impersonate') and reload
 */
export function ImpersonatorAutoConnect() {
  const { connect, connectors } = useConnect();
  const { isConnected, address } = useAccount();
  const { disconnect } = useDisconnect();
  const attemptedRef = useRef(false);

  // Suppress WalletConnect errors when impersonating
  // WalletConnect tries to connect even when using mock connector
  useEffect(() => {
    if (typeof window === "undefined") return;

    const impersonateAddress = localStorage.getItem(IMPERSONATE_STORAGE_KEY);
    if (!impersonateAddress) return;

    // Suppress console.error for WalletConnect messages
    const originalError = console.error;
    console.error = (...args) => {
      const msg = args[0]?.toString?.() || "";
      if (
        msg.includes("Connection interrupted") ||
        msg.includes("WebSocket") ||
        msg.includes("WalletConnect") ||
        msg.includes("subscribe")
      ) {
        return; // Suppress
      }
      originalError.apply(console, args);
    };

    // Suppress unhandled promise rejections from WalletConnect
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const msg = event.reason?.message || event.reason?.toString?.() || "";
      if (
        msg.includes("Connection interrupted") ||
        msg.includes("WebSocket") ||
        msg.includes("WalletConnect") ||
        msg.includes("subscribe")
      ) {
        event.preventDefault(); // Prevent the error from being logged/shown
      }
    };

    // Suppress window errors from WalletConnect (for Next.js dev overlay)
    const handleError = (event: ErrorEvent) => {
      const msg = event.message || "";
      if (
        msg.includes("Connection interrupted") ||
        msg.includes("WebSocket") ||
        msg.includes("WalletConnect") ||
        msg.includes("subscribe")
      ) {
        event.preventDefault();
        return true; // Suppress the error
      }
      return false;
    };

    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener("error", handleError);

    return () => {
      console.error = originalError;
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      window.removeEventListener("error", handleError);
    };
  }, []);

  useEffect(() => {
    // Only run on client, once
    if (typeof window === "undefined" || attemptedRef.current) return;

    const impersonateAddress = localStorage.getItem(IMPERSONATE_STORAGE_KEY);

    // If no impersonate address, do nothing
    if (!impersonateAddress || !/^0x[a-fA-F0-9]{40}$/.test(impersonateAddress)) {
      return;
    }

    // Find the mock connector (from our Impersonator wallet)
    const mockConnector = connectors.find(c => c.id === "mock");

    if (!mockConnector) {
      console.warn("[ImpersonatorAutoConnect] Mock connector not found in config");
      return;
    }

    // If already connected with correct address, nothing to do
    if (isConnected && address?.toLowerCase() === impersonateAddress.toLowerCase()) {
      console.log("[ImpersonatorAutoConnect] Already connected as:", address);
      return;
    }

    // If connected to different address, disconnect first
    if (isConnected && address?.toLowerCase() !== impersonateAddress.toLowerCase()) {
      console.log("[ImpersonatorAutoConnect] Wrong address connected, disconnecting first...");
      disconnect();
      // Don't set attempted yet - will retry after disconnect
      return;
    }

    // Not connected - connect with mock connector
    console.log("[ImpersonatorAutoConnect] Auto-connecting as:", impersonateAddress);
    attemptedRef.current = true;
    connect({ connector: mockConnector });
  }, [connect, connectors, isConnected, address, disconnect]);

  // This component renders nothing
  return null;
}
