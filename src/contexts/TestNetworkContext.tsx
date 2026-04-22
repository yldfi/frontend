"use client";

import { createContext, useCallback, useContext, useEffect, useState, useMemo, useRef, type ReactNode } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";

type TestNetworkType = "anvil" | "tenderly" | null;

// VNet dev-mode toggle env vars (only active in development)
const VNET_RPC_URL = process.env.NODE_ENV === "development"
  ? (process.env.NEXT_PUBLIC_TENDERLY_VNET_RPC || "")
  : "";
const VNET_ADDRESS = process.env.NODE_ENV === "development"
  ? (process.env.NEXT_PUBLIC_TENDERLY_VNET_ADDRESS || "")
  : "";

interface TestNetworkContextValue {
  /** True when connected to any test network (Anvil fork, Tenderly VNet, chain 1337) */
  isTestNetwork: boolean;
  /** "anvil" | "tenderly" | null — only for display (banner label) */
  testNetworkType: TestNetworkType;
  isDetecting: boolean;
  /** VNet dev-mode toggle: true when user has enabled the in-app VNet mode */
  vnetEnabled: boolean;
  /** True when NEXT_PUBLIC_TENDERLY_VNET_RPC is set and NODE_ENV is development */
  vnetAvailable: boolean;
  /** Override address for impersonation (from NEXT_PUBLIC_TENDERLY_VNET_ADDRESS) */
  vnetAddress: `0x${string}` | null;
  /** VNet RPC URL (from env var) */
  vnetRpcUrl: string | null;
  /** Anvil RPC URL (from NEXT_PUBLIC_ANVIL_RPC) — null when not on Anvil */
  anvilRpcUrl: string | null;
  /** Toggle VNet mode on/off */
  toggleVNet: () => void;
}

const TestNetworkContext = createContext<TestNetworkContextValue>({
  isTestNetwork: false,
  testNetworkType: null,
  isDetecting: false,
  vnetEnabled: false,
  vnetAvailable: false,
  vnetAddress: null,
  vnetRpcUrl: null,
  anvilRpcUrl: null,
  toggleVNet: () => {},
});

export function useTestNetwork() {
  return useContext(TestNetworkContext);
}

// Test network detection:
// - Anvil and Tenderly VNet both support evm_snapshot (succeeds)
// - Mainnet nodes reject evm_snapshot with -32601
// - Tenderly Public RPC rejects with -32004 + "Access forbidden"
// - To distinguish Anvil from Tenderly: probe anvil_nodeInfo (Anvil-only)
// - Both are test networks — skip Tenderly simulation API on either

// Error codes from RPC responses
const ERROR_ACCESS_FORBIDDEN = -32004; // Tenderly Public RPC
export function TestNetworkProvider({ children }: { children: ReactNode }) {
  const { isConnected, connector } = useAccount();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const [testNetworkType, setTestNetworkType] = useState<TestNetworkType>(null);
  const [isDetecting, setIsDetecting] = useState(() => typeof window !== "undefined");
  const [detectTrigger, setDetectTrigger] = useState(0);
  const prevTestNetworkRef = useRef<boolean | null>(null);
  const isInitialDetection = useRef(true);

  // VNet dev-mode toggle state
  // Disabled when Anvil is set (Anvil takes priority — avoids split-brain reads/writes)
  const anvilActive = !!(process.env.NEXT_PUBLIC_ANVIL_RPC);
  const vnetAvailable = !!(VNET_RPC_URL && process.env.NODE_ENV === "development" && !anvilActive);
  const [vnetEnabled, setVnetEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return vnetAvailable && localStorage.getItem("yldfi-vnet-enabled") === "true";
  });

  const vnetAddress: `0x${string}` | null = VNET_ADDRESS ? (VNET_ADDRESS as `0x${string}`) : null;
  const vnetRpcUrl = vnetAvailable ? VNET_RPC_URL : null;
  const anvilRpcUrl = anvilActive ? (process.env.NEXT_PUBLIC_ANVIL_RPC || null) : null;

  // When VNet is enabled, force testNetworkType to "tenderly"
  const effectiveTestNetworkType = vnetEnabled ? "tenderly" : testNetworkType;
  const isTestNetwork = effectiveTestNetworkType !== null;

  // Toggle VNet mode on/off
  const toggleVNet = useCallback(() => {
    setVnetEnabled((prev) => {
      const next = !prev;
      localStorage.setItem("yldfi-vnet-enabled", String(next));
      console.log(`[VNet] Toggle ${next ? "ON" : "OFF"}`);

      // Invalidate cache so reads switch to the new RPC
      setTimeout(() => queryClient.invalidateQueries(), 100);

      // Emit event for components to react
      window.dispatchEvent(new CustomEvent("tenderly-network-change", {
        detail: { isTestNetwork: next || testNetworkType !== null, testNetworkType: next ? "tenderly" : testNetworkType }
      }));

      return next;
    });
  }, [queryClient, testNetworkType]);

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
        detail: { isTestNetwork, testNetworkType: effectiveTestNetworkType }
      }));

      prevTestNetworkRef.current = isTestNetwork;
    }
  }, [isTestNetwork, effectiveTestNetworkType, queryClient]);

  // Detect test network by probing evm_snapshot
  useEffect(() => {
    // Not connected - reset state
    if (!isConnected || !connector) {
      const timer = setTimeout(() => {
        setTestNetworkType(null);
        setIsDetecting(false);
      }, 0);
      return () => clearTimeout(timer);
    }

    // When VNet toggle is on, we force testNetworkType="tenderly" — skip probing
    if (vnetEnabled) {
      const timer = setTimeout(() => {
        setIsDetecting(false);
      }, 0);
      return () => clearTimeout(timer);
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

        // Fast path: when NEXT_PUBLIC_ANVIL_RPC is set, skip evm_snapshot (can hang
        // on Anvil after heavy state modifications) and probe anvil_nodeInfo directly
        // via the wagmi transport which routes to Anvil.
        if (anvilActive && publicClient) {
          try {
            const nodeInfoPromise = publicClient.transport.request({ method: "anvil_nodeInfo", params: [] });
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), 3000)
            );
            await Promise.race([nodeInfoPromise, timeoutPromise]);
            if (cancelled) return;
            setTestNetworkType((prev) => {
              if (prev !== "anvil") console.log("[TestNetwork] Detected Anvil fork");
              return "anvil";
            });
            return;
          } catch {
            // Anvil not reachable — fall through to normal detection
          }
        }

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
          } else if ((err as Error)?.message === "timeout") {
            console.log("[TestNetwork] Detection timed out, keeping previous state");
          } else {
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
  }, [isConnected, connector, publicClient, detectTrigger, vnetEnabled, anvilActive]);

  // Re-run detection periodically when tab is focused
  // This handles cases where user changes RPC without disconnecting
  useEffect(() => {
    if (typeof window === "undefined" || !isConnected) return;

    let intervalId: ReturnType<typeof setInterval>;

    const startPolling = () => {
      intervalId = setInterval(() => {
        setDetectTrigger((t) => t + 1);
      }, 10_000);
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
      testNetworkType: effectiveTestNetworkType,
      isDetecting,
      vnetEnabled,
      vnetAvailable,
      vnetAddress,
      vnetRpcUrl,
      anvilRpcUrl,
      toggleVNet,
    }),
    [isTestNetwork, effectiveTestNetworkType, isDetecting, vnetEnabled, vnetAvailable, vnetAddress, vnetRpcUrl, anvilRpcUrl, toggleVNet]
  );

  return (
    <TestNetworkContext.Provider value={contextValue}>
      {children}
    </TestNetworkContext.Provider>
  );
}
