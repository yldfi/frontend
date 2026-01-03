"use client";

import { useEffect } from "react";
import { useAccount } from "wagmi";

const TEST_CHAIN_ID = 1337;
const BANNER_HEIGHT = "24px";

export function TestNetworkBanner() {
  const { chain, isConnected } = useAccount();
  const isTestNetwork = isConnected && chain?.id === TEST_CHAIN_ID;

  // Set CSS variable for header offset when on test network
  useEffect(() => {
    if (isTestNetwork) {
      document.documentElement.style.setProperty("--test-banner-height", BANNER_HEIGHT);
      document.documentElement.setAttribute("data-test-network", "true");
    } else {
      document.documentElement.style.setProperty("--test-banner-height", "0px");
      document.documentElement.removeAttribute("data-test-network");
    }
  }, [isTestNetwork]);

  if (!isTestNetwork) {
    return null;
  }

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[100] bg-amber-500 text-black text-center py-1 text-xs font-medium"
      style={{ height: BANNER_HEIGHT }}
    >
      TEST MODE: Tenderly Fork (Chain {TEST_CHAIN_ID}) - Transactions are simulated
    </div>
  );
}
