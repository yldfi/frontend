"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import {
  trackWalletConnect,
  trackWalletDisconnect,
  setUserProperty,
} from "@/lib/analytics";

/**
 * Analytics Provider that tracks wallet connection state changes
 */
export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const { address, connector, isConnected } = useAccount();
  const wasConnected = useRef(false);
  const lastAddress = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Track wallet connect
    if (isConnected && address && !wasConnected.current) {
      const walletType = connector?.name || "unknown";
      trackWalletConnect(walletType);
      wasConnected.current = true;
      lastAddress.current = address;
    }

    // Track wallet disconnect
    if (!isConnected && wasConnected.current) {
      trackWalletDisconnect();
      wasConnected.current = false;
      lastAddress.current = undefined;
    }

    // Track wallet change (different address)
    if (isConnected && address && lastAddress.current && address !== lastAddress.current) {
      const walletType = connector?.name || "unknown";
      trackWalletConnect(walletType);
      lastAddress.current = address;
    }

    // Set user property for connected state
    setUserProperty("wallet_connected", isConnected);
  }, [isConnected, address, connector]);

  return <>{children}</>;
}
