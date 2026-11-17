import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest.setup.ts mocks this module for the analytics tests; unmock it so the
// consent functions below are the real ones.
vi.unmock("@/components/CookieConsent");

import {
  CookieConsent,
  getAdsConsentStatus,
  getConsentStatus,
  isAdsAllowed,
  isAnalyticsAllowed,
} from "@/components/CookieConsent";
import { currentGoogleConsentState } from "@/lib/consent";

function clearCookies() {
  for (const name of ["geo_region", "analytics_consent", "ads_consent"]) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/`;
}

function renderBanner() {
  return render(createElement(CookieConsent));
}

beforeEach(() => {
  clearCookies();
});

afterEach(() => {
  clearCookies();
  vi.clearAllMocks();
});

describe("getConsentStatus", () => {
  it("accepts non-EEA visitors without a cookie", () => {
    setCookie("geo_region", "OTHER");

    expect(getConsentStatus()).toBe("accepted");
    expect(isAnalyticsAllowed()).toBe(true);
  });

  it("accepts non-EEA visitors even after they rejected", () => {
    setCookie("geo_region", "OTHER");
    setCookie("analytics_consent", "rejected");

    expect(getConsentStatus()).toBe("accepted");
  });

  it("accepts an EEA visitor who accepted", () => {
    setCookie("geo_region", "EEA");
    setCookie("analytics_consent", "accepted");

    expect(getConsentStatus()).toBe("accepted");
    expect(isAnalyticsAllowed()).toBe(true);
  });

  it("rejects an EEA visitor who rejected", () => {
    setCookie("geo_region", "EEA");
    setCookie("analytics_consent", "rejected");

    expect(getConsentStatus()).toBe("rejected");
    expect(isAnalyticsAllowed()).toBe(false);
  });

  it("stays pending for an EEA visitor who has not chosen", () => {
    setCookie("geo_region", "EEA");

    expect(getConsentStatus()).toBe("pending");
    expect(isAnalyticsAllowed()).toBe(false);
  });

  it("stays pending for an unclassified visitor who has not chosen", () => {
    expect(getConsentStatus()).toBe("pending");
    expect(isAnalyticsAllowed()).toBe(false);
  });

  it("accepted consent applies when the region is not classified", () => {
    setCookie("analytics_consent", "accepted");

    expect(getConsentStatus()).toBe("accepted");
  });
});

describe("CookieConsent banner", () => {
  it("stays hidden for non-EEA visitors", () => {
    setCookie("geo_region", "OTHER");

    const { container } = renderBanner();

    expect(container.innerHTML).toBe("");
  });

  it("stays hidden once the visitor has chosen", () => {
    setCookie("geo_region", "EEA");
    setCookie("analytics_consent", "accepted");
    setCookie("ads_consent", "rejected");

    const { container } = renderBanner();

    expect(container.innerHTML).toBe("");
  });

  it("shows for an EEA visitor without a choice", () => {
    setCookie("geo_region", "EEA");

    renderBanner();

    expect(screen.getByRole("button", { name: "Accept all" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Analytics only" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reject all" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe("/privacy");
  });

  it("records Accept all and grants analytics and advertising", () => {
    setCookie("geo_region", "EEA");
    renderBanner();

    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));

    expect(document.cookie).toContain("analytics_consent=accepted");
    expect(document.cookie).toContain("ads_consent=accepted");
    expect(getConsentStatus()).toBe("accepted");
    expect(isAdsAllowed()).toBe(true);
    expect(screen.queryByRole("button", { name: "Accept all" })).toBeNull();
    expect(window.dataLayer?.at(-1)).toEqual([
      "consent",
      "update",
      {
        analytics_storage: "granted",
        ad_storage: "granted",
        ad_user_data: "granted",
        ad_personalization: "granted",
      },
    ]);
  });

  it("records Analytics only and keeps advertising denied", () => {
    setCookie("geo_region", "EEA");
    renderBanner();

    fireEvent.click(screen.getByRole("button", { name: "Analytics only" }));

    expect(document.cookie).toContain("analytics_consent=accepted");
    expect(document.cookie).toContain("ads_consent=rejected");
    expect(isAnalyticsAllowed()).toBe(true);
    expect(isAdsAllowed()).toBe(false);
    expect(window.dataLayer?.at(-1)).toEqual([
      "consent",
      "update",
      {
        analytics_storage: "granted",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      },
    ]);
  });

  it("records Reject all and denies Google consent", () => {
    setCookie("geo_region", "EEA");
    renderBanner();

    fireEvent.click(screen.getByRole("button", { name: "Reject all" }));

    expect(document.cookie).toContain("analytics_consent=rejected");
    expect(document.cookie).toContain("ads_consent=rejected");
    expect(getConsentStatus()).toBe("rejected");
    expect(screen.queryByRole("button", { name: "Reject all" })).toBeNull();
    expect(window.dataLayer?.at(-1)).toEqual([
      "consent",
      "update",
      {
        analytics_storage: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      },
    ]);
  });
});

describe("advertising consent (Google signals)", () => {
  it("denies advertising to an EEA visitor who accepted analytics before the choice existed", () => {
    setCookie("geo_region", "EEA");
    setCookie("analytics_consent", "accepted");

    expect(getAdsConsentStatus()).toBe("pending");
    expect(currentGoogleConsentState()).toEqual({
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  });

  it("asks that visitor the advertising question again", () => {
    setCookie("geo_region", "EEA");
    setCookie("analytics_consent", "accepted");

    renderBanner();

    expect(screen.getByRole("button", { name: "Accept all" })).not.toBeNull();
  });

  it("does not ask again after analytics was rejected", () => {
    setCookie("geo_region", "EEA");
    setCookie("analytics_consent", "rejected");

    const { container } = renderBanner();

    expect(container.innerHTML).toBe("");
  });

  it("never grants advertising without analytics", () => {
    setCookie("geo_region", "EEA");
    setCookie("analytics_consent", "rejected");
    setCookie("ads_consent", "accepted");

    expect(isAdsAllowed()).toBe(false);
    expect(currentGoogleConsentState().ad_storage).toBe("denied");
  });

  it("denies everything when the region is not classified", () => {
    expect(currentGoogleConsentState()).toEqual({
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  });

  it("grants everything outside the EEA", () => {
    setCookie("geo_region", "OTHER");

    expect(isAdsAllowed()).toBe(true);
    expect(currentGoogleConsentState().ad_storage).toBe("granted");
  });
});
