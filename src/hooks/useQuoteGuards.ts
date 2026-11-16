"use client";

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

import { needsPriceImpactConfirm } from "@/components/PriceImpactConfirmModal";
import { isQuoteOlderThan } from "@/lib/quote-freshness";
import type { ZapQuote } from "@/types/enso";

export interface QuoteGuardsOptions {
  /** When the on-screen quote was fetched (ms epoch); matches the quote hooks' `quoteUpdatedAt`. */
  quoteUpdatedAt: number;
  refetch: () => unknown;
  isIdle: boolean;
  /** The gated quote's price impact; matches `ZapQuote["priceImpact"]`. */
  priceImpact: ZapQuote["priceImpact"] | undefined;
  setPendingImpactAction: (action: { label: string; run: () => void } | null) => void;
}

export interface QuoteGuards {
  isQuoteTooOld: () => boolean;
  refreshIfQuoteTooOld: () => boolean;
  handleStaleQuote: (info: { afterApproval: boolean }) => void;
  guardHighImpact: (label: string, run: () => void) => void;
}

/**
 * Quote-freshness and price-impact guards shared by /zap and the vault-page zap tab.
 * Both pages had byte-identical copies of this logic; keep their behaviour identical.
 */
export function useQuoteGuards({
  quoteUpdatedAt,
  refetch,
  isIdle,
  priceImpact,
  setPendingImpactAction,
}: QuoteGuardsOptions): QuoteGuards {
  const isQuoteTooOld = useCallback(() => isQuoteOlderThan(quoteUpdatedAt), [quoteUpdatedAt]);

  // The hook refuses to execute an old quote (e.g. when an approval took minutes to mine).
  const handleStaleQuote = useCallback(({ afterApproval }: { afterApproval: boolean }) => {
    void refetch();
    toast.info(
      afterApproval
        ? "Approval confirmed. The quote was refreshed while it was pending — check the new amounts, then zap."
        : "Quote refreshed. Check the new amounts, then try again.",
    );
  }, [refetch]);

  // Back from idle: re-quote right away if the one on screen has aged.
  const wasIdleRef = useRef(false);
  useEffect(() => {
    if (wasIdleRef.current && !isIdle && isQuoteTooOld()) void refetch();
    wasIdleRef.current = isIdle;
  }, [isIdle, isQuoteTooOld, refetch]);

  const refreshIfQuoteTooOld = (): boolean => {
    if (!isQuoteTooOld()) return false;
    void refetch();
    toast.info("Quote refreshed. Check the new amounts, then try again.");
    return true;
  };

  const guardHighImpact = (label: string, run: () => void) => {
    if (refreshIfQuoteTooOld()) return;
    if (needsPriceImpactConfirm(priceImpact)) setPendingImpactAction({ label, run });
    else run();
  };

  return { isQuoteTooOld, refreshIfQuoteTooOld, handleStaleQuote, guardHighImpact };
}
