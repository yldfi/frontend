"use client";

import Script from "next/script";
import { useMemo } from "react";

// Cookie utility to check geo region
function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(";").shift() || null;
  return null;
}

/**
 * Get consent status from cookie
 */
function getConsentFromCookie(): "granted" | "denied" | null {
  const consent = getCookie("analytics_consent");
  if (consent === "accepted") return "granted";
  if (consent === "rejected") return "denied";
  return null;
}

/**
 * Check if user is in EEA based on geo_region cookie
 */
function isEEAVisitor(): boolean {
  const geoRegion = getCookie("geo_region");
  return geoRegion === "EEA";
}

/**
 * Compute consent state based on region and cookie
 */
function getConsentState(): "granted" | "denied" {
  if (typeof window === "undefined") return "denied";

  const isEEA = isEEAVisitor();
  const cookieConsent = getConsentFromCookie();

  if (!isEEA) {
    // Non-EEA: consent granted by default
    return "granted";
  } else if (cookieConsent) {
    // EEA with explicit choice
    return cookieConsent;
  } else {
    // EEA without choice: deny by default
    return "denied";
  }
}

/**
 * Google Analytics component with Consent Mode v2
 * - Sets default consent states before initializing gtag
 * - Non-EEA visitors: consent granted by default
 * - EEA visitors: consent denied by default until user accepts
 */
export function GoogleAnalytics({ gaId }: { gaId: string }) {
  // Compute consent script with embedded default state
  // This runs on client hydration when cookies are available
  const consentScript = useMemo(() => {
    const consentState = getConsentState();

    return `
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}

      // Set default consent state BEFORE config
      gtag('consent', 'default', {
        'analytics_storage': '${consentState}',
        'ad_storage': '${consentState}',
        'ad_user_data': '${consentState}',
        'ad_personalization': '${consentState}',
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
 * Update Google consent state - call this when user accepts/rejects
 */
export function updateGoogleConsent(granted: boolean): void {
  if (typeof window === "undefined") return;

  const consentState = granted ? "granted" : "denied";

  gtagConsent("consent", "update", {
    analytics_storage: consentState,
    ad_storage: consentState,
    ad_user_data: consentState,
    ad_personalization: consentState,
  });
}

// Extend Window interface for dataLayer (avoids conflict with analytics.ts gtag type)
declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}
