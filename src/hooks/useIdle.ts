"use client";

import { useEffect, useState } from "react";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * True once `timeoutMs` passes with no click, key press, scroll or touch.
 * Returning to the tab (visibilitychange → visible, or window focus) counts as
 * activity. Mouse movement deliberately does not: a pointer resting over the
 * page should not keep a background quote loop alive.
 */
export function useIdle(timeoutMs: number): boolean {
  const [isIdle, setIsIdle] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setIsIdle(true), timeoutMs);
    };
    const onActivity = () => {
      setIsIdle(false);
      arm();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onActivity();
    };

    arm();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    window.addEventListener("focus", onActivity);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      if (timer) clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity);
      }
      window.removeEventListener("focus", onActivity);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [timeoutMs]);

  return isIdle;
}
