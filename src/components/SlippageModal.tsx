"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { useChainId } from "wagmi";
import { useFlashbotsProtect } from "@/hooks/useFlashbotsProtect";
import { useSettings } from "@/hooks/useSettings";
import { cn } from "@/lib/utils";

const SIMULATION_STORAGE_KEY = "yldfi-show-simulation";

interface SlippageModalProps {
  open: boolean;
  onClose: () => void;
  slippage: string;           // basis points, e.g. "100" = 1%
  onSlippageChange: (bps: string) => void;
  title?: string;
}

export function SlippageModal({
  open,
  onClose,
  slippage,
  onSlippageChange,
  title = "Settings",
}: SlippageModalProps) {
  const chainId = useChainId();
  const { isFlashbotsEnabled, isFlashbotsSupported, toggleFlashbots } = useFlashbotsProtect();

  // Tenderly simulation toggle (localStorage-backed)
  const [showSimulationPreview, setShowSimulationPreviewState] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(SIMULATION_STORAGE_KEY) === "true";
    }
    return false;
  });

  // Zappers toggle (synced across all components via useSyncExternalStore)
  const { zappersEnabled, setZappersEnabled } = useSettings();

  // Re-read from localStorage when modal opens (React "adjust state from props" pattern)
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && typeof window !== "undefined") {
      const stored = localStorage.getItem(SIMULATION_STORAGE_KEY) === "true";
      if (stored !== showSimulationPreview) {
        setShowSimulationPreviewState(stored);
      }
    }
  }

  const setShowSimulationPreview = (value: boolean) => {
    setShowSimulationPreviewState(value);
    if (typeof window !== "undefined") {
      localStorage.setItem(SIMULATION_STORAGE_KEY, String(value));
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative bg-[var(--background)] border border-[var(--border)] rounded-xl w-full max-w-sm p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-[var(--muted)] rounded transition-colors"
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

        {/* Slippage Section */}
        <div>
          <h4 className="text-sm font-medium mb-2">Slippage Tolerance</h4>
          <p className="text-xs text-[var(--muted-foreground)] mb-3">
            Maximum price change you&apos;re willing to accept.
          </p>

          {/* Preset buttons */}
          <div className="flex gap-2 mb-3">
            {["10", "50", "100", "300"].map((value) => (
              <button
                key={value}
                onClick={() => onSlippageChange(value)}
                className={cn(
                  "flex-1 py-2 text-sm rounded-lg transition-colors",
                  slippage === value
                    ? "bg-[var(--foreground)] text-[var(--background)]"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                {(Number(value) / 100).toFixed(1)}%
              </button>
            ))}
          </div>

          {/* Custom input */}
          <div>
            <label className="text-xs text-[var(--muted-foreground)] mb-1.5 block">
              Custom
            </label>
            <div className="relative">
              <input
                type="number"
                value={(Number(slippage) / 100).toString()}
                onChange={(e) => {
                  const percent = parseFloat(e.target.value) || 0;
                  const bps = Math.round(percent * 100).toString();
                  onSlippageChange(bps);
                }}
                onWheel={(e) => e.currentTarget.blur()}
                step="0.1"
                min="0.01"
                max="50"
                className="w-full bg-[var(--muted)] rounded-lg p-3 pr-8 mono text-base focus:outline-none focus:ring-1 focus:ring-[var(--border-hover)]"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]">
                %
              </span>
            </div>
          </div>

          {/* Warning for high slippage */}
          {Number(slippage) > 300 && (
            <p className="text-xs text-[var(--warning)] flex items-center gap-1.5 mt-2">
              <AlertTriangle size={14} />
              High slippage increases risk of unfavorable trades
            </p>
          )}
        </div>

        <div className="border-t border-[var(--border)]" />

        {/* Tenderly Simulation Toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://docs.tenderly.co/logos/tenderly/tenderly-symbol.svg"
              alt="Tenderly"
              width={20}
              height={20}
            />
            <span className="text-sm font-medium">Tenderly Simulation</span>
          </div>
          <button
            onClick={() => setShowSimulationPreview(!showSimulationPreview)}
            className={cn(
              "relative w-11 h-6 rounded-full transition-colors",
              showSimulationPreview ? "bg-[var(--accent)]" : "bg-[var(--muted)]"
            )}
          >
            <span
              className={cn(
                "absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform",
                showSimulationPreview && "translate-x-5"
              )}
            />
          </button>
        </div>
        <p className="text-xs text-[var(--muted-foreground)]">
          Preview transaction results before executing.
        </p>

        {/* Flashbots Protect Toggle - only show on mainnet when wallet supports it */}
        {chainId === 1 && isFlashbotsSupported && (
          <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="https://docs.flashbots.net/img/brand-assets/flashbots_icon.svg"
                  alt="Flashbots"
                  width={20}
                  height={20}
                />
                <span className="text-sm font-medium">Flashbots Protect</span>
              </div>
              <button
                onClick={() => toggleFlashbots(!isFlashbotsEnabled)}
                className={cn(
                  "relative w-11 h-6 rounded-full transition-colors",
                  isFlashbotsEnabled ? "bg-[#FFA800]" : "bg-[var(--muted)]"
                )}
              >
                <span
                  className={cn(
                    "absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform",
                    isFlashbotsEnabled && "translate-x-5"
                  )}
                />
              </button>
            </div>
            <p className="text-xs text-[var(--muted-foreground)]">
              Protects transactions from frontrunning and sandwich attacks via private mempool.
            </p>
          </>
        )}

        {/* Zappers Toggle — only in development */}
        {process.env.NODE_ENV !== "production" && (<>
        <div className="border-t border-[var(--border)]" />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-red-500" />
            <span className="text-sm font-medium">Zapper Contract</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-500 font-medium uppercase tracking-wider">UNAUDITED</span>
          </div>
          <button
            onClick={() => setZappersEnabled(!zappersEnabled)}
            className={cn(
              "relative w-11 h-6 rounded-full transition-colors",
              zappersEnabled ? "bg-red-500" : "bg-[var(--muted)]"
            )}
          >
            <span
              className={cn(
                "absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform",
                zappersEnabled && "translate-x-5"
              )}
            />
          </button>
        </div>
        <p className="text-xs text-red-400/80">
          Enable leveraged loans, deleverage, and collateral swaps via yld zapper contract. This contract has not been audited. <span className="font-bold text-red-500">USE AT OWN RISK</span>
        </p>
        </>)}
      </div>
    </div>,
    document.body
  );
}
