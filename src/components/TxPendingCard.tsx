"use client";

import { ExternalLink } from "lucide-react";
import { LoadingDots } from "@/components/LoadingDots";
import { TxAssetDetailsPill } from "@/components/TxAssetDetailsPill";
import type { TxAssetDetails } from "@/lib/transaction-ui";

interface TxPendingCardProps {
  /** From getPendingTxCopy: "Preparing Transaction" / "Awaiting Confirmation" / "Waiting for Safe". */
  title: string;
  message: string;
  details?: TxAssetDetails | null;
  /** Label for the asset pill, e.g. "Deposit", "Withdraw", "Zap". */
  actionLabel?: string;
  /** e.g. "Step 1 of 2 · Approve CVX". Shown under the title for multi-step flows. */
  stepLabel?: string;
  /** Shows a "View on Etherscan" link once the tx is sent. */
  hash?: string | null;
}

/**
 * The one pending-transaction card for every step (approve, deposit, withdraw,
 * zap), so the vault page and /zap read the same (tracker item 41).
 */
export function TxPendingCard({ title, message, details, actionLabel, stepLabel, hash }: TxPendingCardProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center animate-in fade-in duration-300">
      <div className="w-16 h-16 rounded-full bg-[var(--muted)] flex items-center justify-center mb-4">
        <LoadingDots />
      </div>
      <h3 className="text-lg font-medium mb-2">{title}</h3>
      {stepLabel && (
        <p className="text-xs mono text-[var(--muted-foreground)] mb-3">{stepLabel}</p>
      )}
      {details && <TxAssetDetailsPill details={details} actionLabel={actionLabel} />}
      <p className="text-sm text-[var(--muted-foreground)] max-w-xs mb-4">{message}</p>
      {hash && (
        <a
          href={`https://etherscan.io/tx/${hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--foreground)] hover:text-[var(--accent)] transition-colors mono"
        >
          View on Etherscan
          <ExternalLink size={14} />
        </a>
      )}
    </div>
  );
}
