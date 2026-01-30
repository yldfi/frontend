"use client";

import { ArrowUpRight, X } from "lucide-react";
import Image from "next/image";
import type { VaultConfig } from "@/config/vaults";

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
  return (
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
            {parseFloat(userBalance).toLocaleString(undefined, {
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
            onClick={onSelectIntegrated}
            className="w-full flex items-center gap-4 p-4 rounded-lg border border-[var(--border)] hover:border-[var(--accent)]/50 hover:bg-[var(--accent)]/5 transition-all group text-left"
          >
            <div className="w-10 h-10 rounded-full bg-[var(--accent)]/10 flex items-center justify-center shrink-0">
              <svg
                className="w-5 h-5 text-[var(--accent)]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium">Use integrated UI</div>
              <div className="text-sm text-[var(--muted-foreground)]">
                Deposit, borrow, and manage positions without leaving
              </div>
            </div>
          </button>
        </div>

        {/* Info text */}
        <p className="text-xs text-[var(--muted-foreground)] text-center">
          Deposit {vault.symbol} as collateral on Curve LlamaLend to borrow
          crvUSD
        </p>
      </div>
    </div>
  );
}
