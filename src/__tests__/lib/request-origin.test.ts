import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_SITE_ORIGINS, isCrossSiteBrowserRequest } from "@/lib/request-origin";

function request(headers: Record<string, string> = {}) {
  return { headers: new Headers(headers) };
}

describe("isCrossSiteBrowserRequest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    ["a cross-site fetch", { "sec-fetch-site": "cross-site" }, true],
    ["a cross-site fetch with an allowed origin", { "sec-fetch-site": "cross-site", origin: "https://yldfi.co" }, true],
    ["a cross-site fetch in mixed case", { "sec-fetch-site": " Cross-Site " }, true],
    ["a same-origin fetch with a foreign origin", { "sec-fetch-site": "same-origin", origin: "https://attacker.example" }, false],
    ["a same-site fetch with a foreign origin", { "sec-fetch-site": "same-site", origin: "https://attacker.example" }, false],
    ["a user-initiated navigation with a foreign origin", { "sec-fetch-site": "none", origin: "https://attacker.example" }, false],
    ["a same-origin fetch in mixed case", { "sec-fetch-site": " Same-Origin " }, false],
    ["no headers at all", {}, false],
    ["an allowed origin without sec-fetch-site", { origin: "https://yldfi.co" }, false],
    ["the www allowed origin without sec-fetch-site", { origin: "https://www.yldfi.co" }, false],
    ["a foreign origin without sec-fetch-site", { origin: "https://attacker.example" }, true],
    ["an opaque null origin", { origin: "null" }, true],
    ["an unrecognised sec-fetch-site with a foreign origin", { "sec-fetch-site": "unexpected", origin: "https://attacker.example" }, true],
    ["an empty origin", { origin: "" }, false],
  ])("treats %s correctly", (_label, headers, expected) => {
    expect(isCrossSiteBrowserRequest(request(headers))).toBe(expected);
  });

  it("allows the local development origins outside production", () => {
    expect(ALLOWED_SITE_ORIGINS).toContain("http://localhost:3000");
    expect(ALLOWED_SITE_ORIGINS).toContain("http://127.0.0.1:3000");
    expect(isCrossSiteBrowserRequest(request({ origin: "http://localhost:3000" }))).toBe(false);
    expect(isCrossSiteBrowserRequest(request({ origin: "http://127.0.0.1:3000" }))).toBe(false);
  });

  it("rejects the local development origins in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const production = await import("@/lib/request-origin");

    expect(production.ALLOWED_SITE_ORIGINS).toEqual(["https://yldfi.co", "https://www.yldfi.co"]);
    expect(production.isCrossSiteBrowserRequest(request({ origin: "http://localhost:3000" }))).toBe(true);
    expect(production.isCrossSiteBrowserRequest(request({ origin: "http://127.0.0.1:3000" }))).toBe(true);
    expect(production.isCrossSiteBrowserRequest(request({ origin: "https://yldfi.co" }))).toBe(false);
  });

  it("does not fall back to the Host header in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const production = await import("@/lib/request-origin");

    // A LAN dev server origin matching the Host is only accepted outside production.
    expect(
      production.isCrossSiteBrowserRequest(
        request({ origin: "http://192.0.2.10:3000", host: "192.0.2.10:3000" }),
      ),
    ).toBe(true);
    // The forwarding header can be forged, so a matching foreign Host is no pass.
    expect(
      production.isCrossSiteBrowserRequest(
        request({ origin: "https://evil.example", host: "evil.example" }),
      ),
    ).toBe(true);
    // The allowlist still counts, whatever the Host says.
    expect(
      production.isCrossSiteBrowserRequest(
        request({ origin: "https://yldfi.co", host: "evil.example" }),
      ),
    ).toBe(false);
    // The Sec-Fetch-Site branch is unchanged.
    expect(
      production.isCrossSiteBrowserRequest(
        request({ "sec-fetch-site": "same-origin", origin: "https://preview.example" }),
      ),
    ).toBe(false);
  });

  it.each([
    ["a LAN dev server origin without sec-fetch-site", "http://192.0.2.10:3000", "192.0.2.10:3000", false],
    ["a localhost origin on another port", "http://localhost:4000", "localhost:4000", false],
    ["a preview origin in mixed-case host", "https://preview.example", "PREVIEW.example", false],
    ["an own-host origin on another port", "http://192.0.2.10:3000", "192.0.2.10:3001", true],
    ["a foreign origin against our host", "https://evil.example", "yldfi.co", true],
    ["a foreign origin without a host header", "https://evil.example", undefined, true],
  ])("falls back to the Host header for %s", (_label, origin, host, expected) => {
    const headers: Record<string, string> = { origin };
    if (host !== undefined) headers.host = host;
    expect(isCrossSiteBrowserRequest(request(headers))).toBe(expected);
  });

  it("treats an opaque or malformed origin as cross-site even with a host header", () => {
    expect(isCrossSiteBrowserRequest(request({ origin: "null", host: "yldfi.co" }))).toBe(true);
    expect(isCrossSiteBrowserRequest(request({ origin: "not a url", host: "yldfi.co" }))).toBe(true);
  });

  it("still refuses a cross-site fetch whose origin and host match", () => {
    expect(
      isCrossSiteBrowserRequest(request({ "sec-fetch-site": "cross-site", origin: "https://yldfi.co", host: "yldfi.co" })),
    ).toBe(true);
  });

  it("keeps the allowlist for an allowed origin sent to a different host", () => {
    expect(isCrossSiteBrowserRequest(request({ origin: "https://yldfi.co", host: "192.0.2.10:3000" }))).toBe(false);
  });
});
