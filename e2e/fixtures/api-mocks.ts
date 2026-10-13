import { existsSync, readFileSync } from "fs";
import { join } from "path";
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

export type RecordedResponse = { status: number; contentType: string; body: string };

// Kong (Yearn) and Merkl responses recorded from the live APIs, keyed by method + path + query.
// Re-record with: E2E_RECORD_UPSTREAM=1 pnpm exec playwright test e2e/record-upstream.spec.ts
export const UPSTREAM_FILE = join(__dirname, "upstream-responses.json");
export const UPSTREAM_ROUTE = /\/api\/(kong|merkl)\//;
export const RECORDING_UPSTREAM = process.env.E2E_RECORD_UPSTREAM === "1";

/**
 * Serve /api/kong/* and /api/merkl/* from recorded responses so E2E doesn't depend on Yearn's
 * and Merkl's live APIs. Unrecorded requests fall back to the live call with a warning.
 */
export async function replayUpstreamApis(page: Page): Promise<void> {
  if (RECORDING_UPSTREAM) return; // the recording spec captures live responses passively
  const recorded: Record<string, RecordedResponse> = existsSync(UPSTREAM_FILE)
    ? JSON.parse(readFileSync(UPSTREAM_FILE, "utf-8"))
    : {};
  await page.route(UPSTREAM_ROUTE, async (route) => {
    const url = new URL(route.request().url());
    const key = `${route.request().method()} ${url.pathname}${url.search}`;
    const hit = recorded[key];
    if (hit) return route.fulfill({ status: hit.status, contentType: hit.contentType, body: hit.body });
    console.warn(`[e2e] no recorded response for ${key}; calling it live (re-record: E2E_RECORD_UPSTREAM=1)`);
    return route.continue();
  });
}

/** `test` with the proxied APIs mocked on every page. */
export const test = base.extend<{ proxiedApiMocks: void }>({
  proxiedApiMocks: [
    async ({ page }, use) => {
      await mockProxiedApis(page);
      await replayUpstreamApis(page);
      await use();
    },
    { auto: true },
  ],
});

export { expect };
