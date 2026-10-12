"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/** Zaps at or above this price impact need the user to type CONFIRM first. */
export const PRICE_IMPACT_CONFIRM_THRESHOLD = 5;

export function needsPriceImpactConfirm(priceImpact: number | null | undefined): boolean {
  return (priceImpact ?? 0) >= PRICE_IMPACT_CONFIRM_THRESHOLD;
}

interface PriceImpactConfirmModalProps {
  priceImpact: number | null | undefined;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Typed-CONFIRM gate for high price impact. Render it only while a confirmation is pending. */
export function PriceImpactConfirmModal({ priceImpact, confirmLabel, onCancel, onConfirm }: PriceImpactConfirmModalProps) {
  const [confirmText, setConfirmText] = useState("");
  const confirmed = confirmText === "CONFIRM";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="price-impact-confirm-title"
        className="relative bg-[var(--background)] border border-[var(--border)] rounded-xl w-full max-w-sm p-5 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h3 id="price-impact-confirm-title" className="font-medium text-[var(--destructive)]">High Price Impact Warning</h3>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="p-1 hover:bg-[var(--muted)] rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="bg-[var(--destructive)]/10 border border-[var(--destructive)]/20 rounded-lg p-4">
          <p className="text-sm text-[var(--foreground)]">
            This transaction has a <span className="font-bold text-[var(--destructive)]">{priceImpact?.toFixed(2)}%</span> price impact.
            You may receive significantly less value than expected.
          </p>
        </div>

        <p className="text-sm text-[var(--muted-foreground)]">
          Type <span className="font-mono font-bold text-[var(--foreground)]">CONFIRM</span> below to acknowledge the risk and proceed.
        </p>

        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
          placeholder="Type CONFIRM"
          aria-label="Type CONFIRM to proceed"
          className="w-full bg-[var(--muted)] rounded-lg p-3 mono text-base focus:outline-none focus:ring-2 focus:ring-[var(--destructive)] placeholder:text-[var(--muted-foreground)]/50"
          autoFocus
        />

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-3 rounded-lg font-medium transition-all bg-[var(--muted)] text-[var(--foreground)] hover:bg-[var(--muted)]/80"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (confirmed) onConfirm();
            }}
            disabled={!confirmed}
            className={cn(
              "flex-1 py-3 rounded-lg font-medium transition-all",
              confirmed
                ? "bg-[var(--destructive)] text-white hover:opacity-90 cursor-pointer"
                : "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
