"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

const STORAGE_KEY = "yldfi-beta-banner-dismissed";
const BANNER_HEIGHT = "28px";

export function BetaBanner() {
  const [dismissed, setDismissed] = useState(
    () => typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1"
  );

  const show = !dismissed;

  // Set CSS variable for header offset (same as TestNetworkBanner)
  useEffect(() => {
    // Only set if test banner isn't already showing
    const hasTestBanner = document.documentElement.hasAttribute("data-test-network");
    if (show && !hasTestBanner) {
      document.documentElement.style.setProperty("--test-banner-height", BANNER_HEIGHT);
    } else if (!show && !hasTestBanner) {
      document.documentElement.style.setProperty("--test-banner-height", "0px");
    }
  }, [show]);

  if (!show) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[100] bg-[var(--foreground)] text-[var(--background)] text-center py-1 text-xs font-medium flex items-center justify-center"
      style={{ height: BANNER_HEIGHT }}
    >
      <span className="px-8">
        Always ensure you are on <span className="font-semibold">yldfi.co</span>
        <span className="mx-1.5 opacity-40">|</span>
        In beta — use at own risk
      </span>
      <button
        onClick={() => {
          setDismissed(true);
          localStorage.setItem(STORAGE_KEY, "1");
        }}
        className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:opacity-70 transition-opacity"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}
