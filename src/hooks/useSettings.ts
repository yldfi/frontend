"use client";

import { useState, useCallback } from "react";
import { useAccount } from "wagmi";
import { useIsSafeWallet } from "@/hooks/useIsSafeWallet";
import {
  readStoredSimulationPreview,
  resolveSimulationPreview,
  writeStoredSimulationPreview,
} from "@/lib/simulation-preview-setting";

/**
 * Shared settings hook for slippage, simulation preview, and route display.
 * Reads/writes the same localStorage keys across all components:
 *   - yldfi-slippage (default "50", basis points)
 *   - yldfi-show-simulation (default false; true for Safe accounts)
 *   - yldfi-lending-show-route (default true)
 */
export function useSettings() {
  // --- Slippage (basis points) ---
  const [slippage, setSlippage] = useState(() => {
    if (typeof window === "undefined") return "50";
    try {
      return localStorage.getItem("yldfi-slippage") || "50";
    } catch {
      return "50";
    }
  });
  const [showSlippageModal, setShowSlippageModal] = useState(false);

  const updateSlippage = useCallback((value: string) => {
    setSlippage(value);
    try {
      localStorage.setItem("yldfi-slippage", value);
    } catch { /* ignore */ }
  }, []);

  // --- Simulation preview ---
  const { address, chainId } = useAccount();
  const isSafe = useIsSafeWallet(address, chainId);
  const [storedSimulationPreview, setStoredSimulationPreview] = useState<boolean | null>(readStoredSimulationPreview);
  const showSimulationPreview = resolveSimulationPreview(storedSimulationPreview, isSafe);
  const [showSimulationModal, setShowSimulationModal] = useState(false);

  const setShowSimulationPreview = useCallback((value: boolean) => {
    setStoredSimulationPreview(value);
    writeStoredSimulationPreview(value);
  }, []);

  /** Re-read simulation preview from localStorage (call after SlippageModal closes) */
  const refreshSimulationPreview = useCallback(() => {
    setStoredSimulationPreview(readStoredSimulationPreview());
  }, []);

  // --- Route display toggle ---
  const [showRoute, setShowRoute] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      return localStorage.getItem("yldfi-lending-show-route") !== "false";
    } catch {
      return true;
    }
  });

  const toggleRoute = useCallback(() => {
    setShowRoute((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("yldfi-lending-show-route", String(next));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  return {
    slippage,
    updateSlippage,
    showSlippageModal,
    setShowSlippageModal,
    showSimulationPreview,
    setShowSimulationPreview,
    refreshSimulationPreview,
    showSimulationModal,
    setShowSimulationModal,
    showRoute,
    toggleRoute,
  };
}
