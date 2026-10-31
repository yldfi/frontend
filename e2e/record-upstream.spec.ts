import { writeFileSync } from "fs";
import { test } from "./fixtures/api-mocks";
import { RECORDING_UPSTREAM, UPSTREAM_FILE, UPSTREAM_ROUTE, type RecordedResponse } from "./fixtures/api-mocks";
import { injectTestWallet } from "./fixtures/wallet";

/**
 * Records the live Kong/Merkl responses the specs' pages request, into upstream-responses.json.
 * Only runs with E2E_RECORD_UPSTREAM=1; normal runs replay that file (see api-mocks.ts).
 */
const PAGES = ["/", "/vaults/ycvxcrv", "/vaults/yscvxcrv", "/vaults/invalid-vault-id", "/vaults/nonexistent"];

test.describe("record upstream API responses", () => {
  test.skip(!RECORDING_UPSTREAM, "set E2E_RECORD_UPSTREAM=1 to re-record");
  test.setTimeout(180_000);

  test("captures Kong and Merkl responses for every spec page", async ({ page }) => {
    const recorded: Record<string, RecordedResponse> = {};
    page.on("response", async (response) => {
      const request = response.request();
      if (!UPSTREAM_ROUTE.test(request.url())) return;
      const url = new URL(request.url());
      try {
        recorded[`${request.method()} ${url.pathname}${url.search}`] = {
          status: response.status(),
          contentType: response.headers()["content-type"] ?? "application/json",
          // Merkl campaign params embed third-party apiKey values; keep them out of the repo
          body: (await response.text()).replace(/"apiKey":"[^"]*"/g, '"apiKey":"redacted"'),
        };
      } catch {
        // response body unavailable (navigation away); it is captured on the next page visit
      }
    });
    // Specs that connect the E2E test wallet also fetch its Merkl rewards
    await injectTestWallet(page);
    for (const path of PAGES) {
      await page.goto(path);
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      // The vault info card fetches Kong pps/tvl history only when its chart tabs open
      for (const tab of ["Performance", "TVL"]) {
        const button = page.getByRole("button", { name: tab, exact: true });
        if (await button.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
          await button.click();
          await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
        }
      }
      await page.waitForTimeout(2_000);
    }
    writeFileSync(UPSTREAM_FILE, JSON.stringify(Object.fromEntries(Object.entries(recorded).sort()), null, 2) + "\n");
    console.log(`recorded ${Object.keys(recorded).length} upstream responses`);
  });
});
