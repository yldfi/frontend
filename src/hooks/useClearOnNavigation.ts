import { useEffect, useRef } from "react";

/**
 * Clears specified sessionStorage keys when navigating away (SPA navigation),
 * but preserves them on page refresh.
 *
 * How it works:
 * - On refresh: beforeunload fires, sets a sessionStorage flag, cleanup sees flag and skips clear
 * - On navigation: cleanup runs without flag, clears the sessionStorage keys
 *
 * @param keys - Array of sessionStorage keys to clear on navigation
 * @param refreshKey - Unique key for the sessionStorage refresh flag (default: "yldfi-is-refresh")
 */
export function useClearOnNavigation(keys: string[], refreshKey = "yldfi-is-refresh") {
  // Use ref to avoid re-running effect when keys array reference changes
  const keysRef = useRef(keys);
  useEffect(() => {
    keysRef.current = keys;
  });

  useEffect(() => {
    const handleBeforeUnload = () => {
      try {
        sessionStorage.setItem(refreshKey, "true");
      } catch {
        // sessionStorage unavailable
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      try {
        // Only clear if not a refresh (SPA navigation)
        if (!sessionStorage.getItem(refreshKey)) {
          for (const key of keysRef.current) {
            sessionStorage.removeItem(key);
          }
        }
        sessionStorage.removeItem(refreshKey);
      } catch {
        // storage unavailable
      }
    };
  }, [refreshKey]);
}
