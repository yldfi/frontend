"use client";

import { useEffect } from "react";
import { useRpcHealth } from "@/hooks/useRpcHealth";

const BANNER_HEIGHT = "28px";

export function RpcStatusBanner() {
  const { isRpcDown } = useRpcHealth();

  // Claim the shared banner-height offset while shown; on hide, hand it back to
  // whichever banner is still active (TestNetworkBanner: 24px, BetaBanner: 28px)
  useEffect(() => {
    if (!isRpcDown) return;
    document.documentElement.style.setProperty("--test-banner-height", BANNER_HEIGHT);
    return () => {
      const hasTestBanner = document.documentElement.hasAttribute("data-test-network");
      const betaDismissed = localStorage.getItem("yldfi-beta-banner-dismissed") === "1";
      document.documentElement.style.setProperty(
        "--test-banner-height",
        hasTestBanner ? "24px" : betaDismissed ? "0px" : "28px"
      );
    };
  }, [isRpcDown]);

  if (!isRpcDown) {
    return null;
  }

  const anvilRpc = process.env.NEXT_PUBLIC_ANVIL_RPC;
  const vnetEnabled = typeof window !== "undefined"
    && localStorage.getItem("yldfi-vnet-enabled") === "true";
  const label = anvilRpc ? "local Anvil fork" : vnetEnabled ? "Tenderly VNet" : "Ethereum RPC";

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[102] bg-red-500 text-white text-center py-1 text-xs font-medium"
      style={{ height: BANNER_HEIGHT }}
    >
      {`RPC CONNECTION LOST: Cannot reach the ${label} — data may be stale and transactions will fail`}
    </div>
  );
}
