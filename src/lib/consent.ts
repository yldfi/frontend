/**
 * Visitor consent, shared by the cookie banner and the Google tag setup.
 *
 * Two separate choices, each stored in its own first-party cookie:
 * - analytics (`analytics_consent`): Google Analytics measurement.
 * - advertising (`ads_consent`): Google signals, which shares analytics data
 *   with Google's advertising services (demographics, cross-device reports).
 *
 * The middleware sets `geo_region` to "EEA" or "OTHER". Visitors outside the
 * EEA are opted in by default. EEA visitors, and anyone whose region is not
 * known, are opted out until they choose.
 */

export const ANALYTICS_CONSENT_COOKIE = "analytics_consent";
export const ADS_CONSENT_COOKIE = "ads_consent";
const GEO_REGION_COOKIE = "geo_region";
const CONSENT_COOKIE_DAYS = 365;

export type ConsentStatus = "pending" | "accepted" | "rejected";
type GoogleConsentValue = "granted" | "denied";

export interface GoogleConsentState {
  analytics_storage: GoogleConsentValue;
  ad_storage: GoogleConsentValue;
  ad_user_data: GoogleConsentValue;
  ad_personalization: GoogleConsentValue;
}

export function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(";").shift() || null;
  return null;
}

export function setConsentCookie(name: string, accepted: boolean): void {
  const expires = new Date(Date.now() + CONSENT_COOKIE_DAYS * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${name}=${accepted ? "accepted" : "rejected"}; expires=${expires}; path=/; SameSite=Lax`;
}

export function clearConsentCookies(): void {
  for (const name of [ANALYTICS_CONSENT_COOKIE, ADS_CONSENT_COOKIE]) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
  }
}

function cookieStatus(name: string): ConsentStatus {
  const value = getCookie(name);
  if (value === "accepted") return "accepted";
  if (value === "rejected") return "rejected";
  return "pending";
}

export function isEEAVisitor(): boolean {
  return getCookie(GEO_REGION_COOKIE) === "EEA";
}

function isOutsideEEA(): boolean {
  return getCookie(GEO_REGION_COOKIE) === "OTHER";
}

/** Analytics consent: accepted outside the EEA, otherwise the visitor's choice. */
export function getConsentStatus(): ConsentStatus {
  if (typeof window === "undefined") return "pending";
  if (isOutsideEEA()) return "accepted";
  return cookieStatus(ANALYTICS_CONSENT_COOKIE);
}

/**
 * Advertising (Google signals) consent. It is never granted without analytics
 * consent, and an EEA visitor who accepted analytics before this choice existed
 * stays opted out until they answer it.
 */
export function getAdsConsentStatus(): ConsentStatus {
  if (typeof window === "undefined") return "pending";
  if (isOutsideEEA()) return "accepted";
  if (getConsentStatus() !== "accepted") return getConsentStatus();
  return cookieStatus(ADS_CONSENT_COOKIE);
}

export function isAnalyticsAllowed(): boolean {
  return getConsentStatus() === "accepted";
}

export function isAdsAllowed(): boolean {
  return getAdsConsentStatus() === "accepted";
}

/**
 * Show the banner to an EEA visitor who has not chosen, or who accepted
 * analytics but has not yet answered the advertising question.
 */
export function shouldShowConsentBanner(): boolean {
  if (typeof document === "undefined" || !isEEAVisitor()) return false;
  const analytics = cookieStatus(ANALYTICS_CONSENT_COOKIE);
  if (analytics === "pending") return true;
  return analytics === "accepted" && cookieStatus(ADS_CONSENT_COOKIE) === "pending";
}

/** Google Consent Mode v2 state for the given choices. */
export function googleConsentState(analytics: boolean, ads: boolean): GoogleConsentState {
  const value = (granted: boolean): GoogleConsentValue => (granted ? "granted" : "denied");
  const adsGranted = analytics && ads;
  return {
    analytics_storage: value(analytics),
    ad_storage: value(adsGranted),
    ad_user_data: value(adsGranted),
    ad_personalization: value(adsGranted),
  };
}

/** Google consent state for the current visitor (denied on the server). */
export function currentGoogleConsentState(): GoogleConsentState {
  if (typeof window === "undefined") return googleConsentState(false, false);
  return googleConsentState(isAnalyticsAllowed(), isAdsAllowed());
}
