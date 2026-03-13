"use client";

import { useState, useCallback, useSyncExternalStore } from "react";

// ============================================================================
// Zappers toggle — shared across all components via useSyncExternalStore
// ============================================================================

const ZAPPERS_KEY = "yldfi-zappers-enabled";
const zappersListeners = new Set<() => void>();

function subscribeZappers(callback: () => void) {
  zappersListeners.add(callback);
  return () => zappersListeners.delete(callback);
}

function getZappersSnapshot(): boolean {
  try {
    return localStorage.getItem(ZAPPERS_KEY) === "true";
  } catch {
    return false;
  }
}

function getZappersServerSnapshot(): boolean {
  return false;
}

function setZappersValue(value: boolean) {
  try {
    localStorage.setItem(ZAPPERS_KEY, String(value));
  } catch { /* ignore */ }
  // Notify all subscribers (every useSettings() consumer re-renders)
  zappersListeners.forEach((cb) => cb());
}

// ============================================================================

/**
 * Shared settings hook for slippage, simulation preview, and route display.
 * Reads/writes the same localStorage keys across all components:
 *   - yldfi-slippage (default "50", basis points)
 *   - yldfi-show-simulation (default false)
 *   - yldfi-lending-show-route (default true)
 *   - yldfi-zappers-enabled (default false) — synced across all consumers
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
  const [showSimulationPreview, setShowSimulationPreviewState] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("yldfi-show-simulation") === "true";
    } catch {
      return false;
    }
  });
  const [showSimulationModal, setShowSimulationModal] = useState(false);

  const setShowSimulationPreview = useCallback((value: boolean) => {
    setShowSimulationPreviewState(value);
    try {
      localStorage.setItem("yldfi-show-simulation", String(value));
    } catch { /* ignore */ }
  }, []);

  /** Re-read simulation preview from localStorage (call after SlippageModal closes) */
  const refreshSimulationPreview = useCallback(() => {
    try {
      setShowSimulationPreviewState(
        localStorage.getItem("yldfi-show-simulation") === "true"
      );
    } catch { /* ignore */ }
  }, []);

  // --- Zappers toggle (synced via useSyncExternalStore) ---
  const zappersEnabled = useSyncExternalStore(
    subscribeZappers,
    getZappersSnapshot,
    getZappersServerSnapshot,
  );

  const setZappersEnabled = useCallback((value: boolean) => {
    setZappersValue(value);
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
    zappersEnabled,
    setZappersEnabled,
  };
}
