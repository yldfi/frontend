"use client";

import { useState } from "react";

// Cookie utility functions
function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(";").shift() || null;
  return null;
}

function setCookie(name: string, value: string, days: number): void {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${name}=${value}; expires=${expires}; path=/; SameSite=Lax`;
}

export type ConsentStatus = "pending" | "accepted" | "rejected";

/**
 * Get current consent status
 * - Returns "accepted" for non-EEA visitors (no consent needed)
 * - Returns cookie value for EEA visitors
 */
export function getConsentStatus(): ConsentStatus {
  if (typeof window === "undefined") return "pending";

  const geoRegion = getCookie("geo_region");
  const consentCookie = getCookie("analytics_consent");

  // Non-EEA visitors don't need consent
  if (geoRegion === "OTHER") return "accepted";

  // EEA visitors need explicit consent
  if (consentCookie === "accepted") return "accepted";
  if (consentCookie === "rejected") return "rejected";

  return "pending";
}

/**
 * Check if analytics should be enabled
 */
export function isAnalyticsAllowed(): boolean {
  return getConsentStatus() === "accepted";
}

/**
 * Check if banner should be shown (EEA visitor without consent choice)
 */
function shouldShowConsentBanner(): boolean {
  if (typeof document === "undefined") return false;
  const geoRegion = getCookie("geo_region");
  const consentCookie = getCookie("analytics_consent");
  return geoRegion === "EEA" && !consentCookie;
}

/**
 * Cookie consent banner - only shows for EEA visitors
 */
export function CookieConsent() {
  const [showBanner, setShowBanner] = useState(() => shouldShowConsentBanner());

  const handleAccept = () => {
    setCookie("analytics_consent", "accepted", 365);
    setShowBanner(false);

    // Reload to enable analytics with consent
    window.location.reload();
  };

  const handleReject = () => {
    setCookie("analytics_consent", "rejected", 365);
    setShowBanner(false);
  };

  if (!showBanner) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 p-4 bg-[var(--background)]/95 backdrop-blur-sm border-t border-[var(--border)]">
      <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="text-sm text-[var(--muted-foreground)]">
          <p>
            We use analytics cookies to understand how you use our site and improve your experience.{" "}
            <a
              href="/privacy"
              className="text-[var(--foreground)] hover:underline"
            >
              Privacy Policy
            </a>
          </p>
        </div>
        <div className="flex gap-3 shrink-0">
          <button
            onClick={handleReject}
            className="px-4 py-2 text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            Reject
          </button>
          <button
            onClick={handleAccept}
            className="px-4 py-2 text-sm font-medium bg-[var(--foreground)] text-[var(--background)] rounded-md hover:opacity-90 transition-opacity"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
