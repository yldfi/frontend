"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, X } from "lucide-react";
import Image from "next/image";
import { formatUnits } from "viem";
import type { VaultConfig } from "@/config/vaults";

// localStorage key for preference
const COLLATERAL_UI_PREFERENCE_KEY = "yldfi-collateral-ui-preference";

export type CollateralUIPreference = "curve" | "integrated" | null;

export function getCollateralUIPreference(): CollateralUIPreference {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(COLLATERAL_UI_PREFERENCE_KEY);
  if (stored === "curve" || stored === "integrated") return stored;
  return null;
}

export function setCollateralUIPreference(preference: CollateralUIPreference) {
  if (typeof window === "undefined") return;
  if (preference) {
    localStorage.setItem(COLLATERAL_UI_PREFERENCE_KEY, preference);
  } else {
    localStorage.removeItem(COLLATERAL_UI_PREFERENCE_KEY);
  }
}

export function clearCollateralUIPreference() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(COLLATERAL_UI_PREFERENCE_KEY);
}

interface CollateralModalProps {
  vault: VaultConfig;
  userBalance: string;
  onClose: () => void;
  onSelectIntegrated: () => void;
}

export function CollateralModal({
  vault,
  userBalance,
  onClose,
  onSelectIntegrated,
}: CollateralModalProps) {
  const [rememberChoice, setRememberChoice] = useState(false);

  const handleCurveClick = () => {
    if (rememberChoice) {
      setCollateralUIPreference("curve");
    }
    // Let the link navigate naturally
  };

  const handleIntegratedClick = () => {
    if (rememberChoice) {
      setCollateralUIPreference("integrated");
    }
    onSelectIntegrated();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-[var(--background)] border border-[var(--border)] rounded-xl w-full max-w-md p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Use as Collateral</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-[var(--muted)] transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Balance display */}
        <div className="p-4 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)]">
          <div className="text-sm text-[var(--muted-foreground)] mb-1">
            Your {vault.symbol} balance
          </div>
          <div className="text-xl font-semibold mono">
            {Number(formatUnits(BigInt(userBalance), vault.decimals)).toLocaleString(undefined, {
              maximumFractionDigits: 4,
            })}{" "}
            <span className="text-base text-[var(--muted-foreground)]">
              {vault.symbol}
            </span>
          </div>
        </div>

        {/* Options */}
        <div className="space-y-3">
          {/* External Curve UI option */}
          <a
            href={vault.links?.curve}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleCurveClick}
            className="flex items-center gap-4 p-4 rounded-lg border border-[var(--border)] hover:border-[var(--foreground)]/30 hover:bg-[var(--muted)]/30 transition-all group"
          >
            <div className="w-10 h-10 rounded-full bg-[var(--muted)] flex items-center justify-center shrink-0">
              <Image
                src="/curve-logo.png"
                alt="Curve"
                width={24}
                height={24}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium flex items-center gap-1">
                Use Curve.finance UI
                <ArrowUpRight
                  size={14}
                  className="text-[var(--muted-foreground)] group-hover:text-[var(--foreground)] transition-colors"
                />
              </div>
              <div className="text-sm text-[var(--muted-foreground)]">
                Opens in new tab
              </div>
            </div>
          </a>

          {/* Integrated UI option */}
          <button
            onClick={handleIntegratedClick}
            className="w-full flex items-center gap-4 p-4 rounded-lg border border-[var(--border)] hover:border-[var(--accent)]/50 hover:bg-[var(--accent)]/5 transition-all group text-left"
          >
            <div className="w-10 h-10 rounded-full overflow-hidden shrink-0">
              <Image
                src="/logo-128.png"
                alt="yld"
                width={40}
                height={40}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium">Use integrated UI</div>
              <div className="text-sm text-[var(--muted-foreground)]">
                Deposit, borrow, and manage positions without leaving
              </div>
            </div>
          </button>
        </div>

        {/* Remember choice checkbox */}
        <label className="flex items-center gap-2 cursor-pointer group">
          <input
            type="checkbox"
            checked={rememberChoice}
            onChange={(e) => setRememberChoice(e.target.checked)}
            className="w-4 h-4 rounded border-[var(--border)] bg-transparent text-[var(--accent)] focus:ring-[var(--accent)] focus:ring-offset-0 cursor-pointer"
          />
          <span className="text-sm text-[var(--muted-foreground)] group-hover:text-[var(--foreground)] transition-colors">
            Remember my choice
          </span>
        </label>

        {/* Info text */}
        <p className="text-xs text-[var(--muted-foreground)] text-center">
          Deposit {vault.symbol} as collateral on Curve LlamaLend to borrow
          crvUSD
        </p>
      </div>
    </div>,
    document.body
  );
}
