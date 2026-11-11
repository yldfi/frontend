import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest.setup.ts mocks this module for the analytics tests; unmock it so the
// consent functions below are the real ones.
vi.unmock("@/components/CookieConsent");

import {
  CookieConsent,
  getConsentStatus,
  isAnalyticsAllowed,
} from "@/components/CookieConsent";

function clearCookies() {
  for (const name of ["geo_region", "analytics_consent"]) {
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

    const { container } = renderBanner();

    expect(container.innerHTML).toBe("");
  });

  it("shows for an EEA visitor without a choice", () => {
    setCookie("geo_region", "EEA");

    renderBanner();

    expect(screen.getByRole("button", { name: "Accept" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reject" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe("/privacy");
  });

  it("records acceptance and grants Google consent", () => {
    setCookie("geo_region", "EEA");
    renderBanner();

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(document.cookie).toContain("analytics_consent=accepted");
    expect(getConsentStatus()).toBe("accepted");
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
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

  it("records rejection and denies Google consent", () => {
    setCookie("geo_region", "EEA");
    renderBanner();

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(document.cookie).toContain("analytics_consent=rejected");
    expect(getConsentStatus()).toBe("rejected");
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
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
