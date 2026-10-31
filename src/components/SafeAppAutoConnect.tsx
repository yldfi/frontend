"use client";

import { useEffect, useRef } from "react";
import { useAccount, useConnect } from "wagmi";

/** RainbowKit's safeWallet uses wagmi's `safe()` connector, whose id is "safe". */
export const SAFE_CONNECTOR_ID = "safe";

/**
 * The site may only be framed by itself or Safe{Wallet} (CSP frame-ancestors),
 * so running in a cross-document frame means we were opened as a Safe App.
 */
export function isFramed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

/**
 * Inside Safe{Wallet}, connect the Safe connector automatically. wagmi's
 * reconnect usually picks it already, but a browser extension (MetaMask etc.)
 * also injects into iframes and can win the race, which would send
 * transactions from the signer's own account instead of the Safe.
 */
export function SafeAppAutoConnect() {
  const { connector, status } = useAccount();
  const { connect, connectors } = useConnect();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current || !isFramed()) return;
    if (status === "connecting" || status === "reconnecting") return;
    if (connector?.id === SAFE_CONNECTOR_ID) return;

    const safe = connectors.find((c) => c.id === SAFE_CONNECTOR_ID);
    if (!safe) return;

    attempted.current = true;
    // Outside a real Safe frame the connector's getProvider() resolves to
    // nothing and connect fails quietly; there's nothing to fall back to.
    connect({ connector: safe }, { onError: () => undefined });
  }, [connector, status, connect, connectors]);

  return null;
}
