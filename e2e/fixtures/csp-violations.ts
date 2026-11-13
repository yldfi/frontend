import type { Page } from "@playwright/test";

/**
 * Helpers for the content security policy tests: violation recording and the one violation
 * the policy accepts. The wallet those tests connect with comes from ./wallet.
 */

/** The connected-wallet pages are loaded with an address that has no ENS name, so no avatar lookup happens. */
export const CSP_WALLET_ADDRESS = "0x1000000000000000000000000000000000000001";

/** Records every CSP violation in the page; installed before any navigation. */
export async function recordCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as unknown as { __cspViolations: string[] };
    state.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      // A blocked request's URI can carry a path with a key in it; only the origin is kept.
      let blockedURI = event.blockedURI;
      try {
        blockedURI = new URL(event.blockedURI).origin;
      } catch {
        // Not a URL ("inline", "eval", "data:"): keep it as it is.
      }
      state.__cspViolations.push(
        `${event.effectiveDirective} ${blockedURI} ${event.disposition}`,
      );
    });
  });
}

export async function violationsOf(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
  );
}

/**
 * The WalletConnect dialog asks for a third-party web font, which the policy blocks on
 * purpose; the dialog falls back to a system font.
 */
export const ACCEPTED_FONT_VIOLATION =
  /^(style-src-elem|font-src) https:\/\/fonts\.(googleapis|gstatic)\.com /;
