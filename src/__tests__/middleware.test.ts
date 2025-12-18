import { describe, it, expect } from "vitest";

// Test the middleware logic by extracting testable functions
// Since Next.js server components are hard to test directly, we test the business logic

describe("middleware geo-blocking logic", () => {
  // Replicate the blocked countries set from middleware.ts
  const BLOCKED_COUNTRIES = new Set([
    "GB", "US", "CA", // Regulatory
    "KP", "IR", "SY", "CU", "RU", // OFAC
    "AF", "BY", "MM", "VE", "ZW", "CD", "SD", "SS",
  ]);

  const EEA_COUNTRIES = new Set([
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
    "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
    "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO",
  ]);

  describe("country blocking", () => {
    it("blocks US", () => {
      expect(BLOCKED_COUNTRIES.has("US")).toBe(true);
    });

    it("blocks UK (GB)", () => {
      expect(BLOCKED_COUNTRIES.has("GB")).toBe(true);
    });

    it("blocks Canada", () => {
      expect(BLOCKED_COUNTRIES.has("CA")).toBe(true);
    });

    it("blocks North Korea", () => {
      expect(BLOCKED_COUNTRIES.has("KP")).toBe(true);
    });

    it("blocks Iran", () => {
      expect(BLOCKED_COUNTRIES.has("IR")).toBe(true);
    });

    it("blocks Syria", () => {
      expect(BLOCKED_COUNTRIES.has("SY")).toBe(true);
    });

    it("blocks Cuba", () => {
      expect(BLOCKED_COUNTRIES.has("CU")).toBe(true);
    });

    it("blocks Russia", () => {
      expect(BLOCKED_COUNTRIES.has("RU")).toBe(true);
    });

    it("blocks Belarus", () => {
      expect(BLOCKED_COUNTRIES.has("BY")).toBe(true);
    });

    it("does not block Germany", () => {
      expect(BLOCKED_COUNTRIES.has("DE")).toBe(false);
    });

    it("does not block Brazil", () => {
      expect(BLOCKED_COUNTRIES.has("BR")).toBe(false);
    });

    it("does not block Australia", () => {
      expect(BLOCKED_COUNTRIES.has("AU")).toBe(false);
    });

    it("does not block Japan", () => {
      expect(BLOCKED_COUNTRIES.has("JP")).toBe(false);
    });

    it("does not block Switzerland", () => {
      expect(BLOCKED_COUNTRIES.has("CH")).toBe(false);
    });

    it("does not block Singapore", () => {
      expect(BLOCKED_COUNTRIES.has("SG")).toBe(false);
    });
  });

  describe("EEA detection", () => {
    it("identifies Germany as EEA", () => {
      expect(EEA_COUNTRIES.has("DE")).toBe(true);
    });

    it("identifies France as EEA", () => {
      expect(EEA_COUNTRIES.has("FR")).toBe(true);
    });

    it("identifies Netherlands as EEA", () => {
      expect(EEA_COUNTRIES.has("NL")).toBe(true);
    });

    it("identifies Norway as EEA (non-EU EEA)", () => {
      expect(EEA_COUNTRIES.has("NO")).toBe(true);
    });

    it("identifies Iceland as EEA (non-EU EEA)", () => {
      expect(EEA_COUNTRIES.has("IS")).toBe(true);
    });

    it("identifies Liechtenstein as EEA (non-EU EEA)", () => {
      expect(EEA_COUNTRIES.has("LI")).toBe(true);
    });

    it("does not identify US as EEA", () => {
      expect(EEA_COUNTRIES.has("US")).toBe(false);
    });

    it("does not identify Australia as EEA", () => {
      expect(EEA_COUNTRIES.has("AU")).toBe(false);
    });

    it("does not identify UK as EEA (post-Brexit)", () => {
      expect(EEA_COUNTRIES.has("GB")).toBe(false);
    });

    it("does not identify Switzerland as EEA", () => {
      expect(EEA_COUNTRIES.has("CH")).toBe(false);
    });
  });

  describe("static asset bypass logic", () => {
    function shouldBypassGeoBlock(pathname: string): boolean {
      if (
        pathname.startsWith("/_next/") ||
        pathname.startsWith("/favicon") ||
        pathname.endsWith(".ico") ||
        pathname.endsWith(".png") ||
        pathname.endsWith(".svg") ||
        pathname.endsWith(".jpg") ||
        pathname.endsWith(".css") ||
        pathname.endsWith(".js")
      ) {
        return true;
      }
      return false;
    }

    it("bypasses _next/static paths", () => {
      expect(shouldBypassGeoBlock("/_next/static/chunk.js")).toBe(true);
    });

    it("bypasses _next/image paths", () => {
      expect(shouldBypassGeoBlock("/_next/image")).toBe(true);
    });

    it("bypasses favicon.ico", () => {
      expect(shouldBypassGeoBlock("/favicon.ico")).toBe(true);
    });

    it("bypasses favicon paths", () => {
      expect(shouldBypassGeoBlock("/favicon-32x32.png")).toBe(true);
    });

    it("bypasses PNG files", () => {
      expect(shouldBypassGeoBlock("/logo.png")).toBe(true);
    });

    it("bypasses SVG files", () => {
      expect(shouldBypassGeoBlock("/icon.svg")).toBe(true);
    });

    it("bypasses JPG files", () => {
      expect(shouldBypassGeoBlock("/image.jpg")).toBe(true);
    });

    it("bypasses CSS files", () => {
      expect(shouldBypassGeoBlock("/styles.css")).toBe(true);
    });

    it("bypasses JS files", () => {
      expect(shouldBypassGeoBlock("/script.js")).toBe(true);
    });

    it("bypasses ICO files", () => {
      expect(shouldBypassGeoBlock("/apple-touch-icon.ico")).toBe(true);
    });

    it("does not bypass root path", () => {
      expect(shouldBypassGeoBlock("/")).toBe(false);
    });

    it("does not bypass vault path", () => {
      expect(shouldBypassGeoBlock("/vault/ycvxcrv")).toBe(false);
    });

    it("does not bypass API paths", () => {
      expect(shouldBypassGeoBlock("/api/avatar/test.eth")).toBe(false);
    });
  });

  describe("middleware decision logic", () => {
    function getMiddlewareDecision(
      country: string,
      pathname: string
    ): "block" | "pass" | "bypass" {
      // Check static asset bypass first
      if (
        pathname.startsWith("/_next/") ||
        pathname.startsWith("/favicon") ||
        pathname.endsWith(".ico") ||
        pathname.endsWith(".png") ||
        pathname.endsWith(".svg") ||
        pathname.endsWith(".jpg") ||
        pathname.endsWith(".css") ||
        pathname.endsWith(".js")
      ) {
        return "bypass";
      }

      // Check blocked countries
      if (BLOCKED_COUNTRIES.has(country)) {
        return "block";
      }

      return "pass";
    }

    it("blocks US user on main page", () => {
      expect(getMiddlewareDecision("US", "/")).toBe("block");
    });

    it("blocks US user on vault page", () => {
      expect(getMiddlewareDecision("US", "/vault/ycvxcrv")).toBe("block");
    });

    it("bypasses US user for static assets", () => {
      expect(getMiddlewareDecision("US", "/_next/static/chunk.js")).toBe("bypass");
    });

    it("bypasses US user for images", () => {
      expect(getMiddlewareDecision("US", "/logo.png")).toBe("bypass");
    });

    it("passes German user on main page", () => {
      expect(getMiddlewareDecision("DE", "/")).toBe("pass");
    });

    it("passes Japanese user on vault page", () => {
      expect(getMiddlewareDecision("JP", "/vault/ycvxcrv")).toBe("pass");
    });

    it("handles empty country (no header)", () => {
      expect(getMiddlewareDecision("", "/")).toBe("pass");
    });

    it("handles unknown country code", () => {
      expect(getMiddlewareDecision("XX", "/")).toBe("pass");
    });
  });
});
