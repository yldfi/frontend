"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";

const HEALTHY_INTERVAL_MS = 15_000;
const UNHEALTHY_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 8_000;
// Two consecutive failures before flagging, so a single transient blip doesn't flash the banner
const FAILURES_TO_FLAG = 2;

/**
 * Periodically probes the active wagmi transport (mainnet fallback chain,
 * Anvil fork, or VNet — whichever is routing requests) and reports whether
 * the RPC is reachable.
 */
export function useRpcHealth(): { isRpcDown: boolean } {
  const publicClient = usePublicClient();
  const [isRpcDown, setIsRpcDown] = useState(false);

  useEffect(() => {
    if (!publicClient) return;

    let cancelled = false;
    let failures = 0;
    let nextProbe: ReturnType<typeof setTimeout> | undefined;

    async function probe() {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const request = publicClient!.getBlockNumber({ cacheTime: 0 });
        // Bound the probe: the fallback transport's internal retries can hang longer than the timeout
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("rpc probe timeout")), PROBE_TIMEOUT_MS);
        });
        request.catch(() => {});
        timeout.catch(() => {});
        await Promise.race([request, timeout]);
        if (cancelled) return;
        failures = 0;
        setIsRpcDown(false);
      } catch {
        if (cancelled) return;
        failures += 1;
        if (failures >= FAILURES_TO_FLAG) setIsRpcDown(true);
      } finally {
        clearTimeout(timeoutId);
        if (!cancelled) {
          nextProbe = setTimeout(probe, failures > 0 ? UNHEALTHY_INTERVAL_MS : HEALTHY_INTERVAL_MS);
        }
      }
    }

    probe();
    return () => {
      cancelled = true;
      clearTimeout(nextProbe);
    };
  }, [publicClient]);

  return { isRpcDown };
}
