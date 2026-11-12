/**
 * Cross-site browser request detection for API routes.
 *
 * Browsers set `Origin` and `Sec-Fetch-Site` themselves, so a page script
 * cannot forge them. Refusing requests that these headers mark as coming from
 * another website stops other sites from spending this site's paid upstream
 * quota from their visitors' browsers. It does not stop scripts or servers:
 * they send whatever headers they like, or none, and are bounded by the rate
 * limit instead. Requests without either header pass on purpose, because
 * server-side callers and the nightly integration tests send neither.
 * In the Origin fallback, outside production, a request whose Origin host is the
 * host it was sent to is also not cross-site: that is the page's own host,
 * whatever it is.
 */

export const ALLOWED_SITE_ORIGINS = [
  "https://yldfi.co",
  "https://www.yldfi.co",
  ...(process.env.NODE_ENV !== "production"
    ? ["http://localhost:3000", "http://127.0.0.1:3000"]
    : []),
];

// The own-host rule exists for local development only.
const OWN_HOST_FALLBACK = process.env.NODE_ENV !== "production";

// Sec-Fetch-Site values that mean the request did not come from another site.
const NON_CROSS_SITE = new Set(["same-origin", "same-site", "none"]);

export function isCrossSiteBrowserRequest(request: {
  headers: { get(name: string): string | null };
}): boolean {
  const site = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site === "cross-site") return true;
  if (site && NON_CROSS_SITE.has(site)) return false;

  // No usable Sec-Fetch-Site (absent, empty or unrecognised): fall back to Origin.
  const origin = request.headers.get("origin")?.trim();
  if (!origin) return false;
  if (ALLOWED_SITE_ORIGINS.includes(origin)) return false;
  if (!OWN_HOST_FALLBACK) return true;
  // Outside production the page's own host is accepted (dev server on a LAN
  // address or another port). In production the Host seen by a route can be
  // derived from a client-supplied forwarding header, so only the allowlist
  // counts.
  const host = request.headers.get("host")?.trim().toLowerCase();
  if (!host) return true;
  try {
    return new URL(origin).host.toLowerCase() !== host;
  } catch {
    return true; // "null" or malformed Origin
  }
}
