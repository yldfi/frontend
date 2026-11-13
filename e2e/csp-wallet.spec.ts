import { devices, type Locator, type Page } from "@playwright/test";
import { expect, test, mockProxiedApis, replayUpstreamApis } from "./fixtures/api-mocks";
import {
  ACCEPTED_FONT_VIOLATION,
  CSP_WALLET_ADDRESS,
  recordCspViolations,
  violationsOf,
} from "./fixtures/csp-violations";
import { injectTestWallet } from "./fixtures/wallet";

/**
 * The content security policy has to hold with a wallet in play, not only on pages loaded
 * with no wallet: the hosts a connection talks to are chosen by the wallet libraries, so a
 * library upgrade can add one the policy blocks.
 */

const WALLET_OPTIONS = ["WalletConnect", "MetaMask", "Rainbow", "Base"] as const;

/** The same readiness locators e2e/csp.spec.ts uses for these pages. */
const PAGES: ReadonlyArray<{ path: string; ready: (page: Page) => Locator }> = [
  { path: "/zap", ready: (page) => page.getByRole("heading", { name: "Zap" }) },
  { path: "/", ready: (page) => page.locator("main") },
  { path: "/vaults/ycvxcrv", ready: (page) => page.getByText("ycvxCRV").first() },
];

/** Opens the wallet dialog on /zap, picks one option and waits for what it loads. */
async function openWalletOption(page: Page, option: string): Promise<void> {
  await recordCspViolations(page);

  await page.goto("/zap");
  await page.getByRole("button", { name: /connect/i }).first().click();

  // Fails when the option is missing, which is the point: a wallet disappearing from the
  // dialog would silently stop being tested otherwise.
  const optionButton = page.getByRole("dialog").getByRole("button", { name: option }).first();
  await expect(optionButton).toBeVisible({ timeout: 10_000 });
  await optionButton.click();

  await page.waitForTimeout(6000);

  expect((await violationsOf(page)).filter((v) => !ACCEPTED_FONT_VIOLATION.test(v))).toEqual([]);
}

test.describe("Content security policy with a connected wallet", () => {
  test("connected pages load with no policy violation", async ({ page }) => {
    await recordCspViolations(page);
    await injectTestWallet(page, CSP_WALLET_ADDRESS);

    await page.goto("/zap");
    // The header shows the account's short address once the app has connected to the wallet.
    await expect(page.getByRole("button", { name: /0x10…0001/i }).first()).toBeVisible({
      timeout: 20_000,
    });

    const violations: string[] = [];
    for (const { path, ready } of PAGES) {
      await page.goto(path);
      await expect(ready(page)).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(3000);
      violations.push(...(await violationsOf(page)));
    }

    expect(violations).toEqual([]);
  });
});

for (const option of WALLET_OPTIONS) {
  test(`wallet dialog: ${option} loads with no policy violation`, async ({ page }) => {
    await openWalletOption(page, option);
  });
}

for (const option of WALLET_OPTIONS) {
  test(`phone wallet dialog: ${option} loads with no policy violation`, async ({ browser }) => {
    // A phone profile needs the viewport and user agent the Chromium project cannot give it.
    const { defaultBrowserType: _ignored, ...phone } = devices["Pixel 7"];
    const context = await browser.newContext(phone);
    try {
      const page = await context.newPage();
      // A hand-made context does not get the api-mocks fixture's automatic mocks.
      await mockProxiedApis(page);
      await replayUpstreamApis(page);

      // MetaMask chosen in a phone browser opens a websocket to the MetaMask SDK relay, which
      // proves the phone code path ran. A library change of that host must fail here, so the
      // policy can be updated deliberately rather than silently blocking the relay.
      const websocketOrigins: string[] = [];
      if (option === "MetaMask") {
        page.on("websocket", (websocket) => {
          websocketOrigins.push(new URL(websocket.url()).origin);
        });
      }

      await openWalletOption(page, option);

      if (option === "MetaMask") {
        expect(websocketOrigins).toContain("wss://metamask-sdk.api.cx.metamask.io");
      }
    } finally {
      await context.close();
    }
  });
}
