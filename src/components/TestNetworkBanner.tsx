"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useTestNetwork } from "@/contexts/TestNetworkContext";

const TEST_CHAIN_ID = 1337;
const BANNER_HEIGHT = "24px";
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function TestNetworkBanner() {
  const { chain, isConnected } = useAccount();
  const { isTestNetwork, testNetworkType } = useTestNetwork();
  const publicClient = usePublicClient();
  const [staleMinutes, setStaleMinutes] = useState<number | null>(null);

  const showBanner = isConnected && (chain?.id === TEST_CHAIN_ID || isTestNetwork);
  const isAnvil = testNetworkType === "anvil";

  // Periodically check fork staleness by fetching fork origin block timestamp
  useEffect(() => {
    if (!showBanner || !isAnvil || !publicClient) {
      setStaleMinutes(null); // eslint-disable-line react-hooks/set-state-in-effect -- cleanup on deps change is intentional
      return;
    }

    let cancelled = false;

    async function check() {
      try {
        const nodeInfo = await publicClient!.transport.request({
          method: "anvil_nodeInfo",
          params: [],
        }) as { forkConfig?: { forkBlockNumber?: number } };

        const forkBlockNum = nodeInfo?.forkConfig?.forkBlockNumber;
        if (!forkBlockNum || cancelled) return;

        const block = await publicClient!.getBlock({ blockNumber: BigInt(forkBlockNum) });
        const forkTimeMs = Number(block.timestamp) * 1000;
        const ageMs = Date.now() - forkTimeMs;

        if (!cancelled) {
          setStaleMinutes(ageMs > STALE_THRESHOLD_MS ? Math.floor(ageMs / 60_000) : null);
        }
      } catch {
        // Can't determine — assume fresh
        if (!cancelled) setStaleMinutes(null);
      }
    }

    check();
    const interval = setInterval(check, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [showBanner, isAnvil, publicClient]);

  // Set CSS variable for header offset when on test network
  useEffect(() => {
    if (!showBanner) return;
    document.documentElement.style.setProperty("--test-banner-height", BANNER_HEIGHT);
    document.documentElement.setAttribute("data-test-network", "true");
    return () => {
      document.documentElement.style.setProperty("--test-banner-height", "0px");
      document.documentElement.removeAttribute("data-test-network");
    };
  }, [showBanner]);

  if (!showBanner) {
    return null;
  }

  const label = testNetworkType === "anvil"
    ? "Anvil Fork"
    : testNetworkType === "tenderly"
      ? "Tenderly VNet"
      : `Chain ${chain?.id}`;

  const isStale = staleMinutes !== null;

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-[100] text-center py-1 text-xs font-medium ${
        isStale ? "bg-red-500 text-white" : "bg-amber-500 text-black"
      }`}
      style={{ height: BANNER_HEIGHT }}
    >
      {isStale
        ? `STALE FORK: ${staleMinutes}m behind mainnet — swap routes will fail. Restart anvil-dev.sh`
        : `TEST MODE: ${label} — Swap routes may diverge from fork state`
      }
    </div>
  );
}
