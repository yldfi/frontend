import { useEffect, useRef } from "react";

/**
 * Runs `onApproved` once after an approval confirms (status waitingApproval → idle)
 * while a multi-step flow is waiting on it.
 *
 * The continuation is deferred to a timer so it runs outside the effect. The pending
 * flag survives effect re-runs, so a re-render before the timer fires (e.g. a new block
 * while the tab is backgrounded and timers are throttled) reschedules it instead of
 * dropping it and leaving the flow stuck on the approval step.
 */
export function useAutoContinueAfterApproval(
  txStatus: string,
  awaitingApproval: boolean,
  onApproved: () => void,
) {
  const onApprovedRef = useRef(onApproved);
  const prevTxStatusRef = useRef<string | null>(null);
  const continuePendingRef = useRef(false);

  useEffect(() => {
    onApprovedRef.current = onApproved;
  });

  useEffect(() => {
    if (awaitingApproval && prevTxStatusRef.current === "waitingApproval" && txStatus === "idle") {
      continuePendingRef.current = true;
    }
    prevTxStatusRef.current = txStatus;

    if (!continuePendingRef.current) return;
    if (!awaitingApproval || txStatus !== "idle") {
      continuePendingRef.current = false;
      return;
    }

    const timer = setTimeout(() => {
      continuePendingRef.current = false;
      onApprovedRef.current();
    }, 0);
    return () => clearTimeout(timer);
  }, [txStatus, awaitingApproval]);
}
