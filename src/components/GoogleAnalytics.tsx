"use client";

import Script from "next/script";
import { useMemo } from "react";

import { currentGoogleConsentState, googleConsentState } from "@/lib/consent";

/**
 * Google Analytics component with Consent Mode v2
 * - Sets default consent states before initializing gtag
 * - Non-EEA visitors: analytics and advertising granted by default
 * - EEA visitors and unclassified visitors: denied until they choose; the
 *   advertising switches (Google signals) follow their own choice
 */
export function GoogleAnalytics({ gaId }: { gaId: string }) {
  // Compute consent script with embedded default state
  // This runs on client hydration when cookies are available
  const consentScript = useMemo(() => {
    const consent = currentGoogleConsentState();

    return `
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}

      // Set default consent state BEFORE config
      gtag('consent', 'default', {
        'analytics_storage': '${consent.analytics_storage}',
        'ad_storage': '${consent.ad_storage}',
        'ad_user_data': '${consent.ad_user_data}',
        'ad_personalization': '${consent.ad_personalization}',
        'wait_for_update': 500
      });

      gtag('js', new Date());
      gtag('config', '${gaId}');
    `;
  }, [gaId]);

  return (
    <>
      <Script id="google-analytics-consent" strategy="afterInteractive">
        {consentScript}
      </Script>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
        strategy="afterInteractive"
      />
    </>
  );
}

/**
 * Helper to call gtag - pushes arguments array to dataLayer
 * This is how gtag is defined: function gtag(){dataLayer.push(arguments);}
 */
function gtagConsent(...args: unknown[]): void {
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push(args);
}

/**
 * Update Google consent state when the visitor chooses. Advertising (Google
 * signals) is granted only together with analytics.
 */
export function updateGoogleConsent(analytics: boolean, ads: boolean): void {
  if (typeof window === "undefined") return;
  gtagConsent("consent", "update", { ...googleConsentState(analytics, ads) });
}

// Extend Window interface for dataLayer (avoids conflict with analytics.ts gtag type)
declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}
