"use client";

import { createContext, useContext, useEffect, useState, useMemo, useRef, type ReactNode } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";

type TestNetworkType = "anvil" | "tenderly" | null;

interface TenderlyContextValue {
  /** True when connected to any test network (Anvil fork, Tenderly VNet, chain 1337) */
  isTestNetwork: boolean;
  /** @deprecated Use isTestNetwork instead */
  isTenderlyVNet: boolean;
  /** "anvil" | "tenderly" | null — only for display (banner label) */
  testNetworkType: TestNetworkType;
  isDetecting: boolean;
}

const TenderlyContext = createContext<TenderlyContextValue>({
  isTestNetwork: false,
  isTenderlyVNet: false,
  testNetworkType: null,
  isDetecting: false,
});

export function useTenderly() {
  return useContext(TenderlyContext);
}

// Test network detection:
// - Anvil and Tenderly VNet both support evm_snapshot (succeeds)
// - Mainnet nodes reject evm_snapshot with -32601
// - Tenderly Public RPC rejects with -32004 + "Access forbidden"
// - To distinguish Anvil from Tenderly: probe anvil_nodeInfo (Anvil-only)
// - Both are test networks — skip Tenderly simulation API on either

// Error codes from RPC responses
const ERROR_ACCESS_FORBIDDEN = -32004; // Tenderly Public RPC
const ERROR_METHOD_NOT_FOUND = -32601; // Standard mainnet nodes

export function TenderlyProvider({ children }: { children: ReactNode }) {
  const { isConnected, connector } = useAccount();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const [testNetworkType, setTestNetworkType] = useState<TestNetworkType>(null);
  const [isDetecting, setIsDetecting] = useState(true);
  const [detectTrigger, setDetectTrigger] = useState(0);
  const prevTestNetworkRef = useRef<boolean | null>(null);
  const isInitialDetection = useRef(true);

  const isTestNetwork = testNetworkType !== null;

  // Invalidate queries and emit event when test network detection changes
  useEffect(() => {
    // Skip on initial mount (when prevRef is null)
    if (prevTestNetworkRef.current === null) {
      prevTestNetworkRef.current = isTestNetwork;
      return;
    }

    // Only act if the value actually changed
    if (prevTestNetworkRef.current !== isTestNetwork) {
      console.log("[TestNetwork] Network changed, refreshing queries");

      // Small delay to let current queries complete before invalidating
      setTimeout(() => {
        queryClient.invalidateQueries();
      }, 100);

      // Emit custom event for components to reset local state (like input amounts)
      window.dispatchEvent(new CustomEvent("tenderly-network-change", {
        detail: { isTestNetwork, testNetworkType }
      }));

      prevTestNetworkRef.current = isTestNetwork;
    }
  }, [isTestNetwork, testNetworkType, queryClient]);

  // Detect test network by probing evm_snapshot
  useEffect(() => {
    if (typeof window === "undefined") {
      setIsDetecting(false);
      return;
    }

    // Not connected - reset state
    if (!isConnected || !connector) {
      setTestNetworkType(null);
      setIsDetecting(false);
      return;
    }

    let cancelled = false;

    // Only show detecting state on initial detection, not during polling
    if (isInitialDetection.current) {
      setIsDetecting(true);
    }

    async function detect() {
      try {
        const provider = await connector!.getProvider();
        if (!provider || cancelled) return;

        const rpc = (provider as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }).request.bind(provider);

        try {
          // evm_snapshot: succeeds on Anvil/Tenderly, fails on mainnet
          const rpcPromise = rpc({ method: "evm_snapshot", params: [] });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 1500)
          );
          await Promise.race([rpcPromise, timeoutPromise]);

          if (cancelled) return;

          // Succeeded — distinguish Anvil from Tenderly via anvil_nodeInfo
          try {
            await rpc({ method: "anvil_nodeInfo", params: [] });
            setTestNetworkType((prev) => {
              if (prev !== "anvil") console.log("[TestNetwork] Detected Anvil fork");
              return "anvil";
            });
          } catch {
            setTestNetworkType((prev) => {
              if (prev !== "tenderly") console.log("[TestNetwork] Detected Tenderly VNet (Admin RPC)");
              return "tenderly";
            });
          }
        } catch (err: unknown) {
          if (cancelled) return;

          const error = err as { code?: number; error?: { code?: number } };
          const errorCode = error?.code || error?.error?.code;
          const errorMsg = (err as { message?: string })?.message?.toLowerCase() || "";

          if (errorCode === ERROR_ACCESS_FORBIDDEN && errorMsg.includes("forbidden")) {
            // Tenderly Public RPC
            setTestNetworkType((prev) => {
              if (prev !== "tenderly") console.log("[TestNetwork] Detected Tenderly VNet (Public RPC)");
              return "tenderly";
            });
          } else if (errorCode === ERROR_METHOD_NOT_FOUND || errorCode === ERROR_ACCESS_FORBIDDEN) {
            // Real mainnet
            setTestNetworkType((prev) => {
              if (prev !== null) console.log("[TestNetwork] Mainnet detected (error code:", errorCode, ")");
              return null;
            });
          } else if ((err as Error)?.message === "timeout") {
            console.log("[TestNetwork] Detection timed out, keeping previous state");
          } else {
            // Wallet provider says mainnet — but check wagmi transport too
            // (MetaMask may use real mainnet RPC while wagmi uses NEXT_PUBLIC_ANVIL_RPC)
            if (publicClient) {
              try {
                await publicClient.transport.request({ method: "evm_snapshot", params: [] });
                if (cancelled) return;
                try {
                  await publicClient.transport.request({ method: "anvil_nodeInfo", params: [] });
                  setTestNetworkType((prev) => {
                    if (prev !== "anvil") console.log("[TestNetwork] Detected Anvil fork via wagmi transport");
                    return "anvil";
                  });
                } catch {
                  setTestNetworkType((prev) => {
                    if (prev !== "tenderly") console.log("[TestNetwork] Detected Tenderly VNet via wagmi transport");
                    return "tenderly";
                  });
                }
                // Skip the null fallback below
                return;
              } catch {
                // wagmi transport also not a test network
              }
            }
            setTestNetworkType((prev) => {
              if (prev !== null) console.log("[TestNetwork] Mainnet detected (error code:", errorCode, ")");
              return null;
            });
          }
        }
      } catch (err) {
        console.log("[TestNetwork] Detection error:", err);
        if (!cancelled) {
          setTestNetworkType(null);
        }
      } finally {
        if (!cancelled && isInitialDetection.current) {
          setIsDetecting(false);
          isInitialDetection.current = false;
        }
      }
    }

    detect();

    return () => { cancelled = true; };
  }, [isConnected, connector, publicClient, detectTrigger]);

  // Re-run detection periodically when tab is focused
  // This handles cases where user changes RPC without disconnecting
  useEffect(() => {
    if (typeof window === "undefined" || !isConnected) return;

    let intervalId: ReturnType<typeof setInterval>;

    const startPolling = () => {
      intervalId = setInterval(() => {
        setDetectTrigger((t) => t + 1);
      }, 1_000);
    };

    const stopPolling = () => {
      if (intervalId) clearInterval(intervalId);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        setDetectTrigger((t) => t + 1);
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (document.visibilityState === "visible") {
      startPolling();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isConnected]);

  const contextValue = useMemo(
    () => ({
      isTestNetwork,
      isTenderlyVNet: isTestNetwork, // backwards compat — all consumers just need "am I on a test network?"
      testNetworkType,
      isDetecting,
    }),
    [isTestNetwork, testNetworkType, isDetecting]
  );

  return (
    <TenderlyContext.Provider value={contextValue}>
      {children}
    </TenderlyContext.Provider>
  );
}
