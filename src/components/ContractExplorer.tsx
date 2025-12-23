"use client";

import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ContractView } from "./ContractView";

// Hook to safely check if we're mounted on client
function useIsMounted() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

interface ContractExplorerProps {
  address: string;
  isOpen: boolean;
  onClose: () => void;
  title?: string;
}

export function ContractExplorer({
  address,
  isOpen,
  onClose,
  title,
}: ContractExplorerProps) {
  const mounted = useIsMounted();

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
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
  }, [isOpen, onClose]);

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
            <div className="w-2 h-2 rounded-full bg-[var(--success)] animate-pulse" />
            <h2 className="font-medium text-lg">
              {title || "Contract Explorer"}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {/* Address badge */}
            <a
              href={`https://etherscan.io/address/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mono text-xs px-2 py-1 bg-[var(--muted)] rounded hover:text-[var(--accent)] transition-colors"
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

        {/* Content - scrollable */}
        <div className="flex-1 overflow-y-auto p-4">
          <ContractView address={address} />
        </div>
      </div>
    </div>,
    document.body
  );
}

// Hook for managing explorer state
export function useContractExplorer() {
  const [explorerState, setExplorerState] = useState<{
    isOpen: boolean;
    address: string;
    title?: string;
  }>({
    isOpen: false,
    address: "",
  });

  const openExplorer = useCallback((address: string, title?: string) => {
    setExplorerState({
      isOpen: true,
      address,
      title,
    });
  }, []);

  const closeExplorer = useCallback(() => {
    setExplorerState((prev) => ({
      ...prev,
      isOpen: false,
    }));
  }, []);

  return {
    ...explorerState,
    openExplorer,
    closeExplorer,
  };
}
