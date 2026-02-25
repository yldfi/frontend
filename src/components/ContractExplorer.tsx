"use client";

import { useState, useEffect, useCallback, useSyncExternalStore, useRef } from "react";
import { createPortal } from "react-dom";
import { ContractView } from "./ContractView";
import { StrategyFlowViewer } from "./StrategyFlowViewer";
import { ContractSourceViewer } from "./ContractSourceViewer";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// Hook to safely check if we're mounted on client
function useIsMounted() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

export type ExplorerTab = "state" | "flow" | "source";

export interface ExplorerContract {
  address: string;
  title: string;
  icon?: string;
  showFlowTab?: boolean;
}

interface ContractExplorerProps {
  address: string;
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  lastUpdated?: Date;
  icon?: string;
  /** Show strategy flow tab (default: true for strategy contracts) */
  showFlowTab?: boolean;
  /** Controlled active tab */
  activeTab?: ExplorerTab;
  /** Callback when tab changes */
  onTabChange?: (tab: ExplorerTab) => void;
  /** List of available contracts to switch between */
  availableContracts?: ExplorerContract[];
  /** Callback when a different contract is selected */
  onContractChange?: (contract: ExplorerContract) => void;
}

export function ContractExplorer({
  address,
  isOpen,
  onClose,
  title,
  lastUpdated,
  icon,
  showFlowTab = true,
  activeTab: controlledTab,
  onTabChange,
  availableContracts,
  onContractChange,
}: ContractExplorerProps) {
  const mounted = useIsMounted();
  const [internalTab, setInternalTab] = useState<ExplorerTab>("state");
  const [selectorOpen, setSelectorOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);

  // Use controlled tab if provided, otherwise use internal state
  const activeTab = controlledTab ?? internalTab;
  const setActiveTab = onTabChange ?? setInternalTab;

  // Format the last updated timestamp
  const formatTimestamp = (date: Date) => {
    return date.toLocaleString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectorOpen) {
          setSelectorOpen(false);
        } else {
          onClose();
        }
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      // Prevent body scroll when modal is open
      document.body.style.overflow = "hidden";
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [isOpen, onClose, selectorOpen]);

  // Close selector when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (selectorRef.current && !selectorRef.current.contains(event.target as Node)) {
        setSelectorOpen(false);
      }
    }
    if (selectorOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [selectorOpen]);

  if (!isOpen || !mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:items-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-[var(--background)] border border-[var(--border)] rounded-xl w-full max-w-5xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--border)] shrink-0">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- External token icons from various sources */}
            {icon && <img src={icon} alt="" className="w-6 h-6 rounded-full" />}
            {!icon && <div className="w-2 h-2 rounded-full bg-[var(--success)] animate-pulse" />}
            <div>
              {availableContracts && availableContracts.length > 1 && onContractChange ? (
                <div className="relative" ref={selectorRef}>
                  <button
                    onClick={() => setSelectorOpen(!selectorOpen)}
                    className="flex items-center gap-2 font-medium text-lg hover:text-[var(--accent)] transition-colors"
                  >
                    {title ? `${title}` : "Contract"} Explorer
                    <ChevronDown
                      size={18}
                      className={cn(
                        "transition-transform text-[var(--muted-foreground)]",
                        selectorOpen && "rotate-180"
                      )}
                    />
                  </button>
                  {selectorOpen && (
                    <div className="absolute top-full left-0 mt-2 bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg z-50 min-w-[220px] py-1 max-h-[300px] overflow-y-auto">
                      {availableContracts.map((contract) => {
                        const isSelected = contract.address.toLowerCase() === address.toLowerCase();
                        return (
                          <button
                            key={contract.address}
                            onClick={() => {
                              setSelectorOpen(false);
                              if (!isSelected) {
                                onContractChange(contract);
                              }
                            }}
                            className={cn(
                              "w-full px-4 py-2.5 text-left flex items-center gap-3 hover:bg-[var(--muted)] transition-colors",
                              isSelected && "bg-[var(--muted)] border-l-2 border-l-[var(--accent)]"
                            )}
                          >
                            {contract.icon && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={contract.icon} alt="" className="w-5 h-5 rounded-full" />
                            )}
                            <span className={cn("text-sm", isSelected && "font-medium")}>
                              {contract.title}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <h2 className="font-medium text-lg">
                  {title ? `${title} Contract Explorer` : "Contract Explorer"}
                </h2>
              )}
              {lastUpdated && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  last updated: {formatTimestamp(lastUpdated)}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Address badge */}
            <a
              href={`https://etherscan.io/address/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mono text-xs px-2 py-1 bg-[var(--muted)] rounded text-[var(--foreground)] hover:text-[var(--accent)] transition-colors"
            >
              {address.slice(0, 6)}...{address.slice(-4)}
            </a>
            {/* Close button */}
            <button
              onClick={onClose}
              className="p-2 hover:bg-[var(--muted)] rounded-lg transition-colors"
              aria-label="Close"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Tabs - Contract State, Contract Source, then Strategy Flow (if applicable) */}
        <div className="flex px-4 shrink-0 border-b border-[var(--border)]">
          <button
            onClick={() => setActiveTab("state")}
            className="px-4 py-2 text-sm font-medium transition-colors border-b -mb-px"
            style={{
              color: activeTab === "state" ? "var(--accent)" : "var(--muted-foreground)",
              borderBottomColor: activeTab === "state" ? "var(--accent)" : "transparent",
            }}
          >
            Contract State
          </button>
          <button
            onClick={() => setActiveTab("source")}
            className="px-4 py-2 text-sm font-medium transition-colors border-b -mb-px"
            style={{
              color: activeTab === "source" ? "var(--accent)" : "var(--muted-foreground)",
              borderBottomColor: activeTab === "source" ? "var(--accent)" : "transparent",
            }}
          >
            Contract Source
          </button>
          {showFlowTab && (
            <button
              onClick={() => setActiveTab("flow")}
              className="px-4 py-2 text-sm font-medium transition-colors border-b -mb-px"
              style={{
                color: activeTab === "flow" ? "var(--accent)" : "var(--muted-foreground)",
                borderBottomColor: activeTab === "flow" ? "var(--accent)" : "transparent",
              }}
            >
              Strategy Flow
            </button>
          )}
        </div>

        {/* Content - scrollable, min-h prevents collapse during loading transitions */}
        <div className="flex-1 overflow-y-auto p-4 min-h-[60vh]">
          {activeTab === "state" && <ContractView address={address} />}
          {activeTab === "flow" && <StrategyFlowViewer address={address} />}
          {activeTab === "source" && <ContractSourceViewer address={address} />}
        </div>
      </div>
    </div>,
    document.body
  );
}

const EXPLORER_STORAGE_KEY = "yldfi-explorer-state";

interface ExplorerStorageState {
  isOpen: boolean;
  address: string;
  title?: string;
  icon?: string;
  showFlowTab?: boolean;
  activeTab?: ExplorerTab;
  /** Page path when the explorer was opened — only restore on same page (refresh) */
  path?: string;
}

function loadExplorerState(): ExplorerStorageState {
  if (typeof window === "undefined") {
    return { isOpen: false, address: "" };
  }
  try {
    const saved = sessionStorage.getItem(EXPLORER_STORAGE_KEY);
    if (saved) {
      const parsed: ExplorerStorageState = JSON.parse(saved);
      // Only restore open state on same-page refresh, not cross-page navigation
      if (parsed.isOpen && parsed.path !== window.location.pathname) {
        return { isOpen: false, address: "" };
      }
      return parsed;
    }
  } catch {
    // sessionStorage unavailable or invalid JSON
  }
  return { isOpen: false, address: "" };
}

function saveExplorerState(state: ExplorerStorageState) {
  try {
    sessionStorage.setItem(EXPLORER_STORAGE_KEY, JSON.stringify({
      ...state,
      path: typeof window !== "undefined" ? window.location.pathname : undefined,
    }));
  } catch {
    // sessionStorage unavailable
  }
}

function clearExplorerState() {
  try {
    sessionStorage.removeItem(EXPLORER_STORAGE_KEY);
  } catch {
    // sessionStorage unavailable
  }
}

// Hook for managing explorer state with sessionStorage persistence
// Persists across page refresh (same URL) but not across navigation or tab close
export function useContractExplorer() {
  const [explorerState, setExplorerState] = useState<{
    isOpen: boolean;
    address: string;
    title?: string;
    lastUpdated?: Date;
    icon?: string;
    showFlowTab?: boolean;
    activeTab?: ExplorerTab;
  }>(() => {
    const saved = loadExplorerState();
    return {
      ...saved,
      lastUpdated: saved.isOpen ? new Date() : undefined,
    };
  });

  const openExplorer = useCallback(
    (address: string, title?: string, icon?: string, showFlowTab: boolean = true) => {
      const newState = {
        isOpen: true,
        address,
        title,
        icon,
        showFlowTab,
        activeTab: "state" as ExplorerTab,
      };
      saveExplorerState(newState);
      setExplorerState({
        ...newState,
        lastUpdated: new Date(),
      });
    },
    []
  );

  // Switch to a different contract while preserving the current tab
  const switchContract = useCallback(
    (address: string, title?: string, icon?: string, showFlowTab: boolean = true) => {
      setExplorerState((prev) => {
        // If switching to a contract without flow tab and we're on flow tab, go to state
        const currentTab = prev.activeTab || "state";
        const newTab = (!showFlowTab && currentTab === "flow") ? "state" : currentTab;

        const newState = {
          isOpen: true,
          address,
          title,
          icon,
          showFlowTab,
          activeTab: newTab,
        };
        saveExplorerState(newState);
        return {
          ...newState,
          lastUpdated: new Date(),
        };
      });
    },
    []
  );

  const setActiveTab = useCallback((tab: ExplorerTab) => {
    setExplorerState((prev) => {
      const newState = { ...prev, activeTab: tab };
      saveExplorerState({
        isOpen: newState.isOpen,
        address: newState.address,
        title: newState.title,
        icon: newState.icon,
        showFlowTab: newState.showFlowTab,
        activeTab: tab,
      });
      return newState;
    });
  }, []);

  const closeExplorer = useCallback(() => {
    clearExplorerState();
    setExplorerState((prev) => ({
      ...prev,
      isOpen: false,
    }));
  }, []);

  return {
    ...explorerState,
    openExplorer,
    switchContract,
    closeExplorer,
    setActiveTab,
  };
}
