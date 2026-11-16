import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { useQuoteGuards, type QuoteGuardsOptions } from "@/hooks/useQuoteGuards";
import { QUOTE_MAX_AGE_MS } from "@/lib/quote-freshness";

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const freshQuoteAt = () => Date.now();
const staleQuoteAt = () => Date.now() - QUOTE_MAX_AGE_MS - 1_000;

const render = (initialProps: QuoteGuardsOptions) =>
  renderHook((props: QuoteGuardsOptions) => useQuoteGuards(props), { initialProps });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useQuoteGuards", () => {
  it("runs the action for a fresh quote with a low price impact", () => {
    const run = vi.fn();
    const setPendingImpactAction = vi.fn();
    const { result } = render({
      quoteUpdatedAt: freshQuoteAt(),
      refetch: vi.fn(),
      isIdle: false,
      priceImpact: 1,
      setPendingImpactAction,
    });

    result.current.guardHighImpact("Zap", run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(setPendingImpactAction).not.toHaveBeenCalled();
  });

  it("holds the action for a fresh quote with a high price impact", () => {
    const run = vi.fn();
    const setPendingImpactAction = vi.fn();
    const { result } = render({
      quoteUpdatedAt: freshQuoteAt(),
      refetch: vi.fn(),
      isIdle: false,
      priceImpact: 6,
      setPendingImpactAction,
    });

    result.current.guardHighImpact("Zap", run);

    expect(setPendingImpactAction).toHaveBeenCalledWith({ label: "Zap", run });
    expect(run).not.toHaveBeenCalled();
  });

  it("refreshes instead of running when the quote is stale", () => {
    const refetch = vi.fn();
    const run = vi.fn();
    const { result } = render({
      quoteUpdatedAt: staleQuoteAt(),
      refetch,
      isIdle: false,
      priceImpact: 1,
      setPendingImpactAction: vi.fn(),
    });

    result.current.guardHighImpact("Zap", run);

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith("Quote refreshed. Check the new amounts, then try again.");
    expect(run).not.toHaveBeenCalled();
  });

  it("reports an old quote through refreshIfQuoteTooOld", () => {
    const refetch = vi.fn();
    const { result } = render({
      quoteUpdatedAt: staleQuoteAt(),
      refetch,
      isIdle: false,
      priceImpact: 1,
      setPendingImpactAction: vi.fn(),
    });

    expect(result.current.refreshIfQuoteTooOld()).toBe(true);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("explains the approval refresh through handleStaleQuote", () => {
    const refetch = vi.fn();
    const { result } = render({
      quoteUpdatedAt: freshQuoteAt(),
      refetch,
      isIdle: false,
      priceImpact: 1,
      setPendingImpactAction: vi.fn(),
    });

    result.current.handleStaleQuote({ afterApproval: true });

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(
      "Approval confirmed. The quote was refreshed while it was pending — check the new amounts, then zap.",
    );
  });

  it("refetches once when returning from idle with a stale quote", () => {
    const refetch = vi.fn();
    const options: QuoteGuardsOptions = {
      quoteUpdatedAt: staleQuoteAt(),
      refetch,
      isIdle: true,
      priceImpact: 1,
      setPendingImpactAction: vi.fn(),
    };
    const { rerender } = render(options);

    rerender({ ...options, isIdle: false });

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch when returning from idle with a fresh quote", () => {
    const refetch = vi.fn();
    const options: QuoteGuardsOptions = {
      quoteUpdatedAt: freshQuoteAt(),
      refetch,
      isIdle: true,
      priceImpact: 1,
      setPendingImpactAction: vi.fn(),
    };
    const { rerender } = render(options);

    rerender({ ...options, isIdle: false });

    expect(refetch).not.toHaveBeenCalled();
  });
});
