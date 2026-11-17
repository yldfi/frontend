"use client";

import { useState } from "react";
import { updateGoogleConsent } from "./GoogleAnalytics";
import {
  ADS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_COOKIE,
  setConsentCookie,
  shouldShowConsentBanner,
} from "@/lib/consent";

export type { ConsentStatus } from "@/lib/consent";
export { getAdsConsentStatus, getConsentStatus, isAdsAllowed, isAnalyticsAllowed } from "@/lib/consent";

/**
 * Cookie consent banner - only shows for EEA visitors.
 * Analytics and advertising (Google signals) are separate choices; advertising
 * is only offered together with analytics. Implements Google Consent Mode v2.
 */
export function CookieConsent() {
  const [showBanner, setShowBanner] = useState(() => shouldShowConsentBanner());

  const choose = (analytics: boolean, ads: boolean) => {
    setConsentCookie(ANALYTICS_CONSENT_COOKIE, analytics);
    setConsentCookie(ADS_CONSENT_COOKIE, ads);
    setShowBanner(false);
    updateGoogleConsent(analytics, ads);
  };

  if (!showBanner) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 p-4 bg-[var(--background)]/95 backdrop-blur-sm border-t border-[var(--border)]">
      <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="text-sm text-[var(--muted-foreground)]">
          <p>
            We use analytics cookies to understand how you use our site. If you accept all, Google
            Analytics also shares this data with Google&apos;s advertising services (Google signals)
            for audience and cross-device reports.{" "}
            <a
              href="/privacy"
              className="text-[var(--foreground)] hover:underline"
            >
              Privacy Policy
            </a>
          </p>
        </div>
        <div className="flex flex-wrap gap-3 shrink-0">
          <button
            onClick={() => choose(false, false)}
            className="px-4 py-2 text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            Reject all
          </button>
          <button
            onClick={() => choose(true, false)}
            className="px-4 py-2 text-sm font-medium border border-[var(--border)] text-[var(--foreground)] rounded-md hover:opacity-90 transition-opacity"
          >
            Analytics only
          </button>
          <button
            onClick={() => choose(true, true)}
            className="px-4 py-2 text-sm font-medium bg-[var(--foreground)] text-[var(--background)] rounded-md hover:opacity-90 transition-opacity"
          >
            Accept all
          </button>
        </div>
      </div>
    </div>
  );
}
