"use client";

import { useSyncExternalStore } from "react";
import { updateGoogleConsent } from "./GoogleAnalytics";
import { clearConsentCookies, isEEAVisitor } from "@/lib/consent";

// The region cookie does not change while the page is open.
const subscribeNever = () => () => {};

/**
 * Lets an EEA visitor change their cookie choices: withdraws consent at once,
 * forgets the stored answers and reloads so the banner asks again.
 * Renders nothing for other visitors (they are never shown the banner).
 */
export function CookieSettingsButton() {
  // The region cookie is only readable in the browser; the server renders nothing.
  const eea = useSyncExternalStore(subscribeNever, isEEAVisitor, () => false);

  if (!eea) return null;

  return (
    <button
      type="button"
      onClick={() => {
        updateGoogleConsent(false, false);
        clearConsentCookies();
        window.location.reload();
      }}
      className="mt-4 px-4 py-2 text-sm font-medium border border-[var(--border)] text-[var(--foreground)] rounded-md hover:opacity-90 transition-opacity"
    >
      Cookie settings
    </button>
  );
}
