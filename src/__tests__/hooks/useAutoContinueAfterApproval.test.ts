import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAutoContinueAfterApproval } from "@/hooks/useAutoContinueAfterApproval";

describe("useAutoContinueAfterApproval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const render = (initial: { txStatus: string; awaiting: boolean; onApproved: () => void }) =>
    renderHook(
      ({ txStatus, awaiting, onApproved }) => useAutoContinueAfterApproval(txStatus, awaiting, onApproved),
      { initialProps: initial },
    );

  it("continues once when the approval confirms", () => {
    const onApproved = vi.fn();
    const { rerender } = render({ txStatus: "waitingApproval", awaiting: true, onApproved });

    rerender({ txStatus: "idle", awaiting: true, onApproved });
    vi.runAllTimers();
    rerender({ txStatus: "idle", awaiting: true, onApproved });
    vi.runAllTimers();

    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it("still continues when re-renders land before the deferred timer fires", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render({ txStatus: "waitingApproval", awaiting: true, onApproved: first });

    rerender({ txStatus: "idle", awaiting: true, onApproved: first });
    // New block / balance refetch re-renders with fresh callbacks before the timer runs
    rerender({ txStatus: "idle", awaiting: true, onApproved: vi.fn() });
    rerender({ txStatus: "idle", awaiting: true, onApproved: latest });
    vi.runAllTimers();

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it("does not continue without a waitingApproval → idle transition", () => {
    const onApproved = vi.fn();
    const { rerender } = render({ txStatus: "approving", awaiting: true, onApproved });

    rerender({ txStatus: "idle", awaiting: true, onApproved });
    vi.runAllTimers();

    expect(onApproved).not.toHaveBeenCalled();
  });

  it("drops the continuation if the flow is cleared or errors first", () => {
    const onApproved = vi.fn();
    const { rerender } = render({ txStatus: "waitingApproval", awaiting: true, onApproved });

    rerender({ txStatus: "idle", awaiting: true, onApproved });
    rerender({ txStatus: "idle", awaiting: false, onApproved });
    vi.runAllTimers();
    rerender({ txStatus: "idle", awaiting: true, onApproved });
    vi.runAllTimers();

    expect(onApproved).not.toHaveBeenCalled();
  });
});
