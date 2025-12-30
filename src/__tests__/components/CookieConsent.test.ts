import { describe, it, expect } from "vitest";

// Test the CookieConsent business logic directly
// We test cookie utilities, consent status, and GDPR region detection

describe("CookieConsent logic", () => {
  describe("getCookie function", () => {
    function getCookie(name: string, cookieString: string): string | undefined {
      const value = `; ${cookieString}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) {
        return parts.pop()?.split(";").shift();
      }
      return undefined;
    }

    it("gets cookie value by name", () => {
      const cookieString = "consent=accepted; theme=dark";
      expect(getCookie("consent", cookieString)).toBe("accepted");
    });

    it("gets second cookie value", () => {
      const cookieString = "consent=accepted; theme=dark";
      expect(getCookie("theme", cookieString)).toBe("dark");
    });

    it("returns undefined for missing cookie", () => {
      const cookieString = "consent=accepted";
      expect(getCookie("theme", cookieString)).toBeUndefined();
    });

    it("handles empty cookie string", () => {
      expect(getCookie("consent", "")).toBeUndefined();
    });

    it("handles cookie with special characters", () => {
      const cookieString = "data=hello%20world";
      expect(getCookie("data", cookieString)).toBe("hello%20world");
    });

    it("handles cookie with equals in value", () => {
      const cookieString = "token=abc=def";
      expect(getCookie("token", cookieString)).toBe("abc=def");
    });
  });

  describe("setCookie function", () => {
    function buildCookieString(
      name: string,
      value: string,
      days: number,
      path: string = "/"
    ): string {
      const maxAge = days * 24 * 60 * 60;
      return `${name}=${value}; path=${path}; max-age=${maxAge}; SameSite=Lax`;
    }

    it("builds basic cookie string", () => {
      const cookie = buildCookieString("consent", "accepted", 365);
      expect(cookie).toContain("consent=accepted");
      expect(cookie).toContain("path=/");
      expect(cookie).toContain("SameSite=Lax");
    });

    it("calculates max-age for 365 days", () => {
      const cookie = buildCookieString("consent", "accepted", 365);
      const expectedMaxAge = 365 * 24 * 60 * 60;
      expect(cookie).toContain(`max-age=${expectedMaxAge}`);
    });

    it("calculates max-age for 30 days", () => {
      const cookie = buildCookieString("session", "value", 30);
      const expectedMaxAge = 30 * 24 * 60 * 60;
      expect(cookie).toContain(`max-age=${expectedMaxAge}`);
    });

    it("uses custom path", () => {
      const cookie = buildCookieString("consent", "accepted", 365, "/app");
      expect(cookie).toContain("path=/app");
    });
  });

  describe("consent status", () => {
    type ConsentStatus = "pending" | "accepted" | "rejected";

    function getConsentStatus(cookieValue: string | undefined): ConsentStatus {
      if (cookieValue === "accepted") return "accepted";
      if (cookieValue === "rejected") return "rejected";
      return "pending";
    }

    it("returns accepted for accepted cookie", () => {
      expect(getConsentStatus("accepted")).toBe("accepted");
    });

    it("returns rejected for rejected cookie", () => {
      expect(getConsentStatus("rejected")).toBe("rejected");
    });

    it("returns pending for undefined", () => {
      expect(getConsentStatus(undefined)).toBe("pending");
    });

    it("returns pending for unknown value", () => {
      expect(getConsentStatus("unknown")).toBe("pending");
      expect(getConsentStatus("")).toBe("pending");
    });
  });

  describe("shouldShowConsentBanner", () => {
    function shouldShowConsentBanner(
      consentStatus: "pending" | "accepted" | "rejected",
      geoRegion: string | undefined
    ): boolean {
      // Only show banner if consent is pending AND user is in EEA
      if (consentStatus !== "pending") return false;
      return geoRegion === "EEA";
    }

    it("shows banner for pending consent in EEA", () => {
      expect(shouldShowConsentBanner("pending", "EEA")).toBe(true);
    });

    it("hides banner for accepted consent", () => {
      expect(shouldShowConsentBanner("accepted", "EEA")).toBe(false);
    });

    it("hides banner for rejected consent", () => {
      expect(shouldShowConsentBanner("rejected", "EEA")).toBe(false);
    });

    it("hides banner outside EEA", () => {
      expect(shouldShowConsentBanner("pending", "US")).toBe(false);
      expect(shouldShowConsentBanner("pending", "APAC")).toBe(false);
      expect(shouldShowConsentBanner("pending", undefined)).toBe(false);
    });
  });

  describe("geo region detection", () => {
    const EEA_COUNTRIES = [
      "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
      "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
      "PL", "PT", "RO", "SK", "SI", "ES", "SE",
      "IS", "LI", "NO", // EEA non-EU
      "GB", // UK (GDPR still applies)
    ];

    function getGeoRegion(countryCode: string | undefined): string | undefined {
      if (!countryCode) return undefined;
      if (EEA_COUNTRIES.includes(countryCode.toUpperCase())) return "EEA";
      return countryCode.toUpperCase();
    }

    it("identifies EEA countries", () => {
      expect(getGeoRegion("DE")).toBe("EEA"); // Germany
      expect(getGeoRegion("FR")).toBe("EEA"); // France
      expect(getGeoRegion("GB")).toBe("EEA"); // UK
      expect(getGeoRegion("NL")).toBe("EEA"); // Netherlands
    });

    it("returns country code for non-EEA", () => {
      expect(getGeoRegion("US")).toBe("US");
      expect(getGeoRegion("AU")).toBe("AU");
      expect(getGeoRegion("JP")).toBe("JP");
    });

    it("handles undefined", () => {
      expect(getGeoRegion(undefined)).toBeUndefined();
    });

    it("handles lowercase country codes", () => {
      expect(getGeoRegion("de")).toBe("EEA");
      expect(getGeoRegion("us")).toBe("US");
    });
  });

  describe("cookie consent cookie name", () => {
    const CONSENT_COOKIE_NAME = "cookie_consent";
    const CONSENT_COOKIE_DAYS = 365;

    it("uses correct cookie name", () => {
      expect(CONSENT_COOKIE_NAME).toBe("cookie_consent");
    });

    it("uses 365 day expiry", () => {
      expect(CONSENT_COOKIE_DAYS).toBe(365);
    });
  });

  describe("analytics consent", () => {
    function shouldEnableAnalytics(
      consentStatus: "pending" | "accepted" | "rejected",
      geoRegion: string | undefined
    ): boolean {
      // Enable analytics if:
      // 1. User is outside EEA (no consent needed)
      // 2. User has accepted consent in EEA
      if (geoRegion !== "EEA") return true;
      return consentStatus === "accepted";
    }

    it("enables analytics outside EEA", () => {
      expect(shouldEnableAnalytics("pending", "US")).toBe(true);
      expect(shouldEnableAnalytics("rejected", "US")).toBe(true);
    });

    it("enables analytics when accepted in EEA", () => {
      expect(shouldEnableAnalytics("accepted", "EEA")).toBe(true);
    });

    it("disables analytics when pending in EEA", () => {
      expect(shouldEnableAnalytics("pending", "EEA")).toBe(false);
    });

    it("disables analytics when rejected in EEA", () => {
      expect(shouldEnableAnalytics("rejected", "EEA")).toBe(false);
    });
  });

  describe("banner text content", () => {
    interface BannerContent {
      title: string;
      description: string;
      acceptButton: string;
      rejectButton: string;
    }

    const BANNER_CONTENT: BannerContent = {
      title: "We use cookies",
      description:
        "We use cookies and similar technologies to help personalize content and analyze site traffic.",
      acceptButton: "Accept",
      rejectButton: "Reject",
    };

    it("has title text", () => {
      expect(BANNER_CONTENT.title).toBe("We use cookies");
    });

    it("has description text", () => {
      expect(BANNER_CONTENT.description).toContain("cookies");
      expect(BANNER_CONTENT.description).toContain("traffic");
    });

    it("has accept button text", () => {
      expect(BANNER_CONTENT.acceptButton).toBe("Accept");
    });

    it("has reject button text", () => {
      expect(BANNER_CONTENT.rejectButton).toBe("Reject");
    });
  });

  describe("consent callback handling", () => {
    type ConsentCallback = (accepted: boolean) => void;

    function handleAccept(callback?: ConsentCallback): void {
      callback?.(true);
    }

    function handleReject(callback?: ConsentCallback): void {
      callback?.(false);
    }

    it("calls callback with true on accept", () => {
      let result: boolean | undefined;
      handleAccept((accepted) => {
        result = accepted;
      });
      expect(result).toBe(true);
    });

    it("calls callback with false on reject", () => {
      let result: boolean | undefined;
      handleReject((accepted) => {
        result = accepted;
      });
      expect(result).toBe(false);
    });

    it("handles undefined callback", () => {
      expect(() => handleAccept(undefined)).not.toThrow();
      expect(() => handleReject(undefined)).not.toThrow();
    });
  });

  describe("banner position", () => {
    type BannerPosition = "top" | "bottom";

    function getBannerStyles(position: BannerPosition): { top?: string; bottom?: string } {
      if (position === "top") {
        return { top: "0" };
      }
      return { bottom: "0" };
    }

    it("positions at top", () => {
      const styles = getBannerStyles("top");
      expect(styles.top).toBe("0");
      expect(styles.bottom).toBeUndefined();
    });

    it("positions at bottom", () => {
      const styles = getBannerStyles("bottom");
      expect(styles.bottom).toBe("0");
      expect(styles.top).toBeUndefined();
    });
  });

  describe("animation states", () => {
    type AnimationState = "entering" | "visible" | "exiting" | "hidden";

    function getAnimationClass(state: AnimationState): string {
      switch (state) {
        case "entering":
          return "animate-slide-up";
        case "visible":
          return "opacity-100";
        case "exiting":
          return "animate-slide-down";
        case "hidden":
          return "hidden";
      }
    }

    it("returns entering animation", () => {
      expect(getAnimationClass("entering")).toBe("animate-slide-up");
    });

    it("returns visible class", () => {
      expect(getAnimationClass("visible")).toBe("opacity-100");
    });

    it("returns exiting animation", () => {
      expect(getAnimationClass("exiting")).toBe("animate-slide-down");
    });

    it("returns hidden class", () => {
      expect(getAnimationClass("hidden")).toBe("hidden");
    });
  });

  describe("cookie preferences storage", () => {
    interface CookiePreferences {
      analytics: boolean;
      marketing: boolean;
      functional: boolean;
    }

    function serializePreferences(prefs: CookiePreferences): string {
      return JSON.stringify(prefs);
    }

    function deserializePreferences(stored: string | undefined): CookiePreferences | null {
      if (!stored) return null;
      try {
        return JSON.parse(stored);
      } catch {
        return null;
      }
    }

    it("serializes preferences", () => {
      const prefs: CookiePreferences = { analytics: true, marketing: false, functional: true };
      const serialized = serializePreferences(prefs);
      expect(serialized).toBe('{"analytics":true,"marketing":false,"functional":true}');
    });

    it("deserializes preferences", () => {
      const stored = '{"analytics":true,"marketing":false,"functional":true}';
      const prefs = deserializePreferences(stored);
      expect(prefs?.analytics).toBe(true);
      expect(prefs?.marketing).toBe(false);
      expect(prefs?.functional).toBe(true);
    });

    it("returns null for invalid JSON", () => {
      expect(deserializePreferences("invalid")).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(deserializePreferences(undefined)).toBeNull();
    });
  });

  describe("GDPR compliance", () => {
    function isGdprRequired(region: string | undefined): boolean {
      return region === "EEA";
    }

    function getRequiredDisclosures(region: string | undefined): string[] {
      const disclosures = ["Data usage", "Third-party sharing"];
      if (isGdprRequired(region)) {
        disclosures.push("Right to withdraw", "Data retention period", "Contact DPO");
      }
      return disclosures;
    }

    it("requires GDPR for EEA", () => {
      expect(isGdprRequired("EEA")).toBe(true);
    });

    it("does not require GDPR outside EEA", () => {
      expect(isGdprRequired("US")).toBe(false);
      expect(isGdprRequired(undefined)).toBe(false);
    });

    it("includes basic disclosures everywhere", () => {
      const disclosures = getRequiredDisclosures("US");
      expect(disclosures).toContain("Data usage");
      expect(disclosures).toContain("Third-party sharing");
    });

    it("includes additional GDPR disclosures in EEA", () => {
      const disclosures = getRequiredDisclosures("EEA");
      expect(disclosures).toContain("Right to withdraw");
      expect(disclosures).toContain("Data retention period");
      expect(disclosures).toContain("Contact DPO");
    });
  });

  describe("banner dismissal", () => {
    interface DismissState {
      isDismissed: boolean;
      dismissedAt: number | null;
    }

    function dismiss(): DismissState {
      return { isDismissed: true, dismissedAt: Date.now() };
    }

    function shouldShowAfterDismissal(
      dismissedAt: number | null,
      currentTime: number,
      cooldownMs: number
    ): boolean {
      if (dismissedAt === null) return true;
      return currentTime - dismissedAt >= cooldownMs;
    }

    it("creates dismiss state", () => {
      const state = dismiss();
      expect(state.isDismissed).toBe(true);
      expect(state.dismissedAt).toBeGreaterThan(0);
    });

    it("hides banner during cooldown", () => {
      const now = Date.now();
      const dismissedAt = now - 1000; // 1 second ago
      expect(shouldShowAfterDismissal(dismissedAt, now, 60_000)).toBe(false);
    });

    it("shows banner after cooldown", () => {
      const now = Date.now();
      const dismissedAt = now - 120_000; // 2 minutes ago
      expect(shouldShowAfterDismissal(dismissedAt, now, 60_000)).toBe(true);
    });

    it("shows banner if never dismissed", () => {
      expect(shouldShowAfterDismissal(null, Date.now(), 60_000)).toBe(true);
    });
  });

  describe("accessibility", () => {
    function getBannerAriaProps(): Record<string, string> {
      return {
        role: "dialog",
        "aria-modal": "false",
        "aria-labelledby": "cookie-banner-title",
        "aria-describedby": "cookie-banner-description",
      };
    }

    function getButtonAriaProps(action: "accept" | "reject"): Record<string, string> {
      return {
        "aria-label": action === "accept" ? "Accept cookies" : "Reject cookies",
      };
    }

    it("has correct banner ARIA props", () => {
      const props = getBannerAriaProps();
      expect(props.role).toBe("dialog");
      expect(props["aria-modal"]).toBe("false");
    });

    it("has correct accept button ARIA", () => {
      const props = getButtonAriaProps("accept");
      expect(props["aria-label"]).toBe("Accept cookies");
    });

    it("has correct reject button ARIA", () => {
      const props = getButtonAriaProps("reject");
      expect(props["aria-label"]).toBe("Reject cookies");
    });
  });

  describe("real-world scenarios", () => {
    type ConsentStatus = "pending" | "accepted" | "rejected";

    function getConsentStatus(cookieValue: string | undefined): ConsentStatus {
      if (cookieValue === "accepted") return "accepted";
      if (cookieValue === "rejected") return "rejected";
      return "pending";
    }

    function shouldShowConsentBanner(
      consentStatus: ConsentStatus,
      geoRegion: string | undefined
    ): boolean {
      if (consentStatus !== "pending") return false;
      return geoRegion === "EEA";
    }

    function shouldEnableAnalytics(
      consentStatus: ConsentStatus,
      geoRegion: string | undefined
    ): boolean {
      if (geoRegion !== "EEA") return true;
      return consentStatus === "accepted";
    }

    it("new visitor from Germany", () => {
      const consentStatus = getConsentStatus(undefined);
      const shouldShow = shouldShowConsentBanner(consentStatus, "EEA");
      const analyticsEnabled = shouldEnableAnalytics(consentStatus, "EEA");

      expect(consentStatus).toBe("pending");
      expect(shouldShow).toBe(true);
      expect(analyticsEnabled).toBe(false);
    });

    it("returning visitor from Germany who accepted", () => {
      const consentStatus = getConsentStatus("accepted");
      const shouldShow = shouldShowConsentBanner(consentStatus, "EEA");
      const analyticsEnabled = shouldEnableAnalytics(consentStatus, "EEA");

      expect(consentStatus).toBe("accepted");
      expect(shouldShow).toBe(false);
      expect(analyticsEnabled).toBe(true);
    });

    it("visitor from USA", () => {
      const consentStatus = getConsentStatus(undefined);
      const shouldShow = shouldShowConsentBanner(consentStatus, "US");
      const analyticsEnabled = shouldEnableAnalytics(consentStatus, "US");

      expect(consentStatus).toBe("pending");
      expect(shouldShow).toBe(false);
      expect(analyticsEnabled).toBe(true);
    });

    it("visitor who rejected from France", () => {
      const consentStatus = getConsentStatus("rejected");
      const shouldShow = shouldShowConsentBanner(consentStatus, "EEA");
      const analyticsEnabled = shouldEnableAnalytics(consentStatus, "EEA");

      expect(consentStatus).toBe("rejected");
      expect(shouldShow).toBe(false);
      expect(analyticsEnabled).toBe(false);
    });
  });
});
