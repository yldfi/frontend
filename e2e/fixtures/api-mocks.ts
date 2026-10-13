import { test as base, expect, type Page } from "@playwright/test";
import { mockHistoryResponse, mockTokenPrices, mockTokensResponse, mockVaultsResponse } from "./mock-responses";

/**
 * Mock the app's own server routes that need secrets E2E doesn't have (CACHE_WORKER_URL,
 * ENSO_API_KEY). Without these every page load hit 500s and logged
 * "CACHE_WORKER_URL environment variable is required", so specs ran without vault data.
 *
 * The browser only ever talks to these /api/* proxies, never to api.enso.finance directly.
 * Routes registered later in a test take precedence, so specs can still override any of these.
 */
export async function mockProxiedApis(page: Page): Promise<void> {
  await page.route("**/api/vaults", (route) => route.fulfill({ json: mockVaultsResponse }));

  await page.route("**/api/history**", (route) => route.fulfill({ json: mockHistoryResponse }));

  await page.route("**/api/enso/tokens", (route) => route.fulfill({ json: mockTokensResponse }));

  await page.route("**/api/enso/prices", (route) => {
    const { addresses = [] } = (route.request().postDataJSON() ?? {}) as { addresses?: string[] };
    const prices = addresses.flatMap((address) => {
      const known = mockTokenPrices[address.toLowerCase()];
      return known ? [{ chainId: 1, address, ...known }] : [];
    });
    return route.fulfill({ json: prices });
  });
}

/** `test` with the proxied APIs mocked on every page. */
export const test = base.extend<{ proxiedApiMocks: void }>({
  proxiedApiMocks: [
    async ({ page }, use) => {
      await mockProxiedApis(page);
      await use();
    },
    { auto: true },
  ],
});

export { expect };
