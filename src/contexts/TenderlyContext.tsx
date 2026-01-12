"use client";

import { createContext, useContext, useEffect, useState, useMemo, useRef, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";

interface TenderlyContextValue {
  isTenderlyVNet: boolean;
  isDetecting: boolean;
}

const TenderlyContext = createContext<TenderlyContextValue>({
  isTenderlyVNet: false,
  isDetecting: false,
});

export function useTenderly() {
  return useContext(TenderlyContext);
}

// Why we need Tenderly VNet detection:
// - Enso API requires chainId 1 for quotes/routing (won't work with 1337)
// - We configure Tenderly VNet with chainId 1 so Enso works
// - But this means we can't detect VNet by chainId alone
// - Solution: probe evm_snapshot which returns different error codes:
//   - Tenderly Public RPC: -32004 (Access forbidden)
//   - Real mainnet nodes: -32601 (Method not found)
// - This lets us show TEST MODE banner and skip Tenderly simulation API
//   (which simulates against mainnet state, not VNet state)

// Error codes from RPC responses
const ERROR_ACCESS_FORBIDDEN = -32004; // Tenderly Public RPC
const ERROR_METHOD_NOT_FOUND = -32601; // Standard mainnet nodes

export function TenderlyProvider({ children }: { children: ReactNode }) {
  const { isConnected, connector } = useAccount();
  const queryClient = useQueryClient();
  const [isTenderlyVNet, setIsTenderlyVNet] = useState(false);
  const [isDetecting, setIsDetecting] = useState(true);
  const [detectTrigger, setDetectTrigger] = useState(0);
  const prevTenderlyRef = useRef<boolean | null>(null);
  const isInitialDetection = useRef(true);

  // Invalidate queries and emit event when Tenderly detection changes
  useEffect(() => {
    // Skip on initial mount (when prevRef is null)
    if (prevTenderlyRef.current === null) {
      prevTenderlyRef.current = isTenderlyVNet;
      return;
    }

    // Only act if the value actually changed
    if (prevTenderlyRef.current !== isTenderlyVNet) {
      console.log("[Tenderly] Network changed, refreshing queries");

      // Small delay to let current queries complete before invalidating
      setTimeout(() => {
        // Invalidate ALL queries - wagmi uses its own query keys for balances
        // This ensures both custom queries and wagmi queries are refreshed
        queryClient.invalidateQueries();
      }, 100);

      // Emit custom event for components to reset local state (like input amounts)
      window.dispatchEvent(new CustomEvent("tenderly-network-change", {
        detail: { isTenderlyVNet }
      }));

      prevTenderlyRef.current = isTenderlyVNet;
    }
  }, [isTenderlyVNet, queryClient]);

  // Detect Tenderly VNet by probing evm_snapshot error code
  // - Tenderly Public RPC returns -32004 (Access forbidden)
  // - Mainnet nodes return -32601 (Method not found)
  useEffect(() => {
    if (typeof window === "undefined") {
      setIsDetecting(false);
      return;
    }

    // Not connected - reset state
    if (!isConnected || !connector) {
      setIsTenderlyVNet(false);
      setIsDetecting(false);
      return;
    }

    let cancelled = false;

    // Only show detecting state on initial detection, not during polling
    if (isInitialDetection.current) {
      setIsDetecting(true);
    }

    async function detectTenderly() {
      try {
        // Probe evm_snapshot for automatic detection
        const provider = await connector!.getProvider();
        if (!provider || cancelled) {
          return;
        }

        try {
          // Call evm_snapshot with timeout - we expect it to fail
          // HOW it fails tells us where we are
          const rpcPromise = (provider as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }).request({
            method: "evm_snapshot",
            params: [],
          });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 1500)
          );
          await Promise.race([rpcPromise, timeoutPromise]);

          // If it succeeds, we're on Tenderly Admin RPC
          if (!cancelled) {
            setIsTenderlyVNet((prev) => {
              if (!prev) console.log("[Tenderly] Detected via evm_snapshot success (Admin RPC)");
              return true;
            });
          }
        } catch (err: unknown) {
          const error = err as { code?: number; error?: { code?: number } };
          const errorCode = error?.code || error?.error?.code;

          if (!cancelled) {
            if (errorCode === ERROR_ACCESS_FORBIDDEN) {
              // -32004 = "Access forbidden" = Tenderly Public RPC
              setIsTenderlyVNet((prev) => {
                if (!prev) console.log("[Tenderly] Detected via evm_snapshot error -32004 (Public RPC)");
                return true;
              });
            } else if (errorCode === ERROR_METHOD_NOT_FOUND) {
              // -32601 = "Method not found" = Real mainnet
              setIsTenderlyVNet((prev) => {
                if (prev) console.log("[Tenderly] Not detected - mainnet (error -32601)");
                return false;
              });
            } else if ((err as Error)?.message === "timeout") {
              // Timeout - keep previous state, don't change detection
              console.log("[Tenderly] Detection timed out, keeping previous state");
            } else {
              // Unknown error - default to not Tenderly
              setIsTenderlyVNet((prev) => {
                if (prev) console.log("[Tenderly] Unknown error code:", errorCode);
                return false;
              });
            }
          }
        }
      } catch (err) {
        console.log("[Tenderly] Detection error:", err);
        if (!cancelled) {
          setIsTenderlyVNet((prev) => {
            if (prev) console.log("[Tenderly] Detection error, resetting to mainnet");
            return false;
          });
        }
      } finally {
        if (!cancelled) {
          // Only update isDetecting on initial detection
          if (isInitialDetection.current) {
            setIsDetecting(false);
            isInitialDetection.current = false;
          }
        }
      }
    }

    detectTenderly();

    return () => {
      cancelled = true;
    };
  }, [isConnected, connector, detectTrigger]);

  // Re-run detection periodically when tab is focused
  // This handles cases where user changes RPC in Frame without disconnecting
  useEffect(() => {
    if (typeof window === "undefined" || !isConnected) return;

    let intervalId: ReturnType<typeof setInterval>;

    const startPolling = () => {
      intervalId = setInterval(() => {
        setDetectTrigger((t) => t + 1);
      }, 1_000); // Re-check every 1 second
    };

    const stopPolling = () => {
      if (intervalId) clearInterval(intervalId);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Re-check immediately when tab becomes visible
        setDetectTrigger((t) => t + 1);
        startPolling();
      } else {
        stopPolling();
      }
    };

    // Start polling if tab is visible
    if (document.visibilityState === "visible") {
      startPolling();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isConnected]);

  // Memoize context value to ensure proper update propagation
  const contextValue = useMemo(
    () => ({ isTenderlyVNet, isDetecting }),
    [isTenderlyVNet, isDetecting]
  );

  return (
    <TenderlyContext.Provider value={contextValue}>
      {children}
    </TenderlyContext.Provider>
  );
}
