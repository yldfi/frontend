"use client";

import Script from "next/script";
import { useEffect, useState } from "react";
import { getConsentStatus } from "@/components/CookieConsent";

/**
 * Google Analytics component that respects user consent
 * - Non-EEA visitors: GA loads immediately (no consent needed)
 * - EEA visitors: GA only loads after explicit consent
 */
export function GoogleAnalytics({ gaId }: { gaId: string }) {
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    // Check consent status on mount and when it might change
    const checkConsent = () => {
      const status = getConsentStatus();
      setShouldLoad(status === "accepted");
    };

    checkConsent();

    // Re-check when storage changes (for cross-tab consent sync)
    const handleStorageChange = () => checkConsent();
    window.addEventListener("storage", handleStorageChange);

    // Also check periodically for consent changes within same tab
    const interval = setInterval(checkConsent, 1000);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      clearInterval(interval);
    };
  }, []);

  if (!shouldLoad) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${gaId}');
        `}
      </Script>
    </>
  );
}
