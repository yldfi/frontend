import { describe, it, expect } from "vitest";
import { BRAND, URLS, CONTRACTS } from "@/lib/brand";

describe("brand", () => {
  describe("BRAND constants", () => {
    it("has correct brand name", () => {
      expect(BRAND.name).toBe("yld_fi");
    });

    it("has correct tagline", () => {
      expect(BRAND.tagline).toBe("Automated Yield Optimization");
    });

    it("generates copyright with current year by default", () => {
      const currentYear = new Date().getFullYear();
      expect(BRAND.copyright()).toContain(String(currentYear));
      expect(BRAND.copyright()).toContain("yld_fi");
      expect(BRAND.copyright()).toContain("All rights reserved");
    });

    it("generates copyright with custom year", () => {
      expect(BRAND.copyright(2023)).toBe("© 2023 yld_fi. All rights reserved.");
    });

    it("has user agent string", () => {
      expect(BRAND.userAgent).toBe("yld_fi ENS Avatar Proxy");
    });

    it("has wallet app name", () => {
      expect(BRAND.walletAppName).toBe("yld_fi");
    });
  });

  describe("URLS constants", () => {
    it("has correct domain", () => {
      expect(URLS.domain).toBe("yldfi.co");
    });

    it("has correct website URL", () => {
      expect(URLS.website).toBe("https://yldfi.co");
    });

    it("has correct docs URL", () => {
      expect(URLS.docs).toBe("https://yldfi.gitbook.io/docs");
    });

    it("has correct GitHub URL", () => {
      expect(URLS.github).toBe("https://github.com/yldfi");
    });

    it("has correct Telegram URL", () => {
      expect(URLS.telegram).toBe("https://t.me/yld_fi");
    });

    it("has correct email", () => {
      expect(URLS.email).toBe("contact@yldfi.co");
    });

    it("all URLs are valid", () => {
      expect(() => new URL(URLS.website)).not.toThrow();
      expect(() => new URL(URLS.docs)).not.toThrow();
      expect(() => new URL(URLS.github)).not.toThrow();
      expect(() => new URL(URLS.telegram)).not.toThrow();
    });
  });

  describe("CONTRACTS constants", () => {
    it("has YCVXCRV address", () => {
      expect(CONTRACTS.YCVXCRV).toBe("0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86");
    });

    it("has YSCVXCRV address", () => {
      expect(CONTRACTS.YSCVXCRV).toBe("0xCa960E6DF1150100586c51382f619efCCcF72706");
    });

    it("contract addresses are valid ethereum addresses", () => {
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;
      expect(CONTRACTS.YCVXCRV).toMatch(addressRegex);
      expect(CONTRACTS.YSCVXCRV).toMatch(addressRegex);
    });
  });
});
