import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/api-mocks";

/**
 * The site sends its content security policy report-only on the dev server and enforces it
 * on a production build. These tests make sure the pages that matter load under either with
 * no violation at all.
 */

/** Records every CSP violation in the page; installed before any navigation. */
async function recordCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as unknown as { __cspViolations: string[] };
    state.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      state.__cspViolations.push(
        `${event.effectiveDirective} ${event.blockedURI} ${event.disposition}`,
      );
    });
  });
}

async function violationsOf(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
  );
}

/**
 * The single header carrying the full policy: `Content-Security-Policy-Report-Only` on the
 * dev server, `Content-Security-Policy` on a production build.
 */
function fullPolicyOf(headers: Record<string, string>): string {
  const candidates = [
    headers["content-security-policy"],
    headers["content-security-policy-report-only"],
  ].filter((value): value is string => Boolean(value?.includes("script-src")));

  expect(candidates).toHaveLength(1);
  return candidates[0];
}

test.describe("Content security policy", () => {
  test("home page loads with no policy violation", async ({ page }) => {
    await recordCspViolations(page);

    const response = await page.goto("/");
    await expect(page.locator("main")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    expect(await violationsOf(page)).toEqual([]);
    expect(fullPolicyOf(response?.headers() ?? {})).toContain("connect-src");
  });

  test("zap page loads with no policy violation", async ({ page }) => {
    await recordCspViolations(page);

    const response = await page.goto("/zap");
    await expect(page.getByRole("heading", { name: "Zap" })).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    expect(await violationsOf(page)).toEqual([]);
    expect(fullPolicyOf(response?.headers() ?? {})).toContain("connect-src");
  });

  test("vault page loads with no policy violation", async ({ page }) => {
    await recordCspViolations(page);

    const response = await page.goto("/vaults/ycvxcrv");
    await expect(page.getByText("ycvxCRV").first()).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    expect(await violationsOf(page)).toEqual([]);
    expect(fullPolicyOf(response?.headers() ?? {})).toContain("connect-src");
  });
});
