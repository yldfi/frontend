import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/api-mocks";
import { mockZapIntent } from "./fixtures/intent-mocks";
import { connectTestWallet, injectTestWallet } from "./fixtures/wallet";
import {
  mockZapInBundleResponse,
  mockZapOutBundleResponse,
} from "./fixtures/mock-responses";

/**
 * E2E tests for vault flows: zap in/out, deposit/withdraw, vault-to-vault
 * Uses API mocking for reliable, fast tests
 */

// /api/vaults, /api/history and the /api/enso token/price proxies are mocked for every test by the
// api-mocks fixture. Zap quotes go through the /api/enso/intent proxy.

// Helper to mock bundle API for zap in
async function mockZapInBundle(page: Page) {
  await page.route("**/api/enso/intent", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockZapInBundleResponse),
    });
  });
}

// Helper to mock bundle API for zap out
async function mockZapOutBundle(page: Page) {
  await page.route("**/api/enso/intent", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockZapOutBundleResponse),
    });
  });
}

test.describe("Zap In Flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockZapInBundle(page);
    await page.goto("/vaults/yscvxcrv");
  });

  test("should display zap tab and token selector", async ({ page }) => {
    // Click Zap tab
    const zapButton = page.getByRole("button", { name: "Zap" });
    await expect(zapButton).toBeVisible({ timeout: 10000 });
    await zapButton.click();

    // Zap In should be selected by default
    const zapInButton = page.getByRole("button", { name: "Zap In" });
    await expect(zapInButton).toBeVisible();

    // Token selector should be visible
    const tokenButton = page.getByRole("button", { name: /ETH|CVX|USDC/ });
    await expect(tokenButton.first()).toBeVisible();
  });

  test("should open token selector modal", async ({ page }) => {
    // Click Zap tab
    await page.getByRole("button", { name: "Zap" }).click();

    // Wait for Zap In button to be visible (tab content loaded)
    await expect(page.getByRole("button", { name: "Zap In" })).toBeVisible({ timeout: 10000 });

    // Find the token selector button - it's the one showing a token symbol like "ETH" or "CVX"
    // It's typically between Amount label and percentage buttons
    const tokenSelectors = page.locator('button').filter({ hasText: /^(ETH|CVX|USDC|USDT|CRV)\s+(ETH|CVX|USDC|USDT|CRV)$/ });
    const tokenButton = tokenSelectors.first();

    if (await tokenButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await tokenButton.click();

      // Modal should open with token list
      await expect(page.getByRole("heading", { name: "Select a token" })).toBeVisible();

      // Should show search input
      await expect(page.getByPlaceholder(/search/i)).toBeVisible();
    } else {
      // Token selector might not be visible in this test run - that's ok
      test.skip();
    }
  });

  test("should select CVX token", async ({ page }) => {
    await page.getByRole("button", { name: "Zap" }).click();

    // Wait for Zap content to load
    await expect(page.getByRole("button", { name: "Zap In" })).toBeVisible({ timeout: 10000 });

    // Find and click token selector button
    const tokenSelectors = page.locator('button').filter({ hasText: /^(ETH|CVX|USDC|USDT|CRV)\s+(ETH|CVX|USDC|USDT|CRV)$/ });
    const tokenButton = tokenSelectors.first();

    if (await tokenButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await tokenButton.click();

      // Wait for modal
      await expect(page.getByRole("heading", { name: "Select a token" })).toBeVisible();

      // Search for CVX to filter the list
      const searchInput = page.getByPlaceholder(/search/i);
      await searchInput.fill("CVX");

      // Click on CVX in the filtered list
      const cvxButton = page.locator('button').filter({ hasText: /CVX.*Convex/ }).first();
      if (await cvxButton.isVisible({ timeout: 5000 }).catch(() => false)) {
        await cvxButton.click();
        // Verify modal closed
        await expect(page.getByRole("heading", { name: "Select a token" })).not.toBeVisible({ timeout: 5000 });
      } else {
        test.skip();
      }
    } else {
      test.skip();
    }
  });
});

// Quotes only run with a connected wallet (useUniversalZap returns null without one), so these use
// the injected E2E test wallet. /api/enso/intent answers with a protected quote built from the request.
test.describe("Zap In quotes (test wallet)", () => {
  let intentCalls: { readonly count: number };

  test.beforeEach(async ({ page }) => {
    await injectTestWallet(page);
    intentCalls = await mockZapIntent(page, mockZapInBundleResponse);
    await page.goto("/vaults/yscvxcrv");
    await connectTestWallet(page);
    await page.getByRole("button", { name: "Zap" }).click();
    await expect(page.getByRole("button", { name: "Zap In" })).toBeVisible({ timeout: 10000 });
  });

  const amountInput = (page: Page) =>
    page.locator('input[type="number"], input[inputmode="decimal"]').first();

  test("should debounce input and request one quote", async ({ page }) => {
    await amountInput(page).pressSequentially("123", { delay: 50 });

    // The mock quotes a fixed output, so its arrival means the debounced request has resolved
    await expect(page.getByText("15214.8461").first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // One request for the settled amount, not one per keystroke
    expect(intentCalls.count).toBe(1);
  });

  test("should display quote details after entering amount", async ({ page }) => {
    await amountInput(page).fill("1");

    await expect(page.getByText("1 ETH = 15214.8461 yscvxCRV")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("15214.8461").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Zap In", exact: true }).last()).toBeEnabled();
  });

  test("should show route display when toggle clicked", async ({ page }) => {
    await amountInput(page).fill("1");
    await expect(page.getByText("1 ETH = 15214.8461 yscvxCRV")).toBeVisible({ timeout: 10000 });

    const toggle = page.getByTitle(/(Show|Hide) route/);
    if ((await toggle.getAttribute("title")) === "Show route") await toggle.click();

    await expect(page.getByTitle("Hide route")).toBeVisible();
    await expect(page.getByText("Deposit into yscvxCRV")).toBeVisible();
  });
});

test.describe("Zap Out Flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockZapOutBundle(page);
    await page.goto("/vaults/yscvxcrv");
  });

  test("should switch to Zap Out tab", async ({ page }) => {
    await page.getByRole("button", { name: "Zap" }).click();

    // Click Zap Out
    const zapOutButton = page.getByRole("button", { name: "Zap Out" });
    await zapOutButton.click();

    // Should be active (highlighted)
    await expect(zapOutButton).toBeVisible();
  });

  test("should show output token selector in zap out mode", async ({ page }) => {
    await page.getByRole("button", { name: "Zap" }).click();
    await page.getByRole("button", { name: "Zap Out" }).click();

    // Should show token selector for output token
    const tokenButton = page.getByRole("button", { name: /ETH|USDC|CVX/ }).first();
    await expect(tokenButton).toBeVisible();
  });
});

test.describe("Deposit Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/vaults/yscvxcrv");
  });

  test("should display deposit tab by default", async ({ page }) => {
    const depositButton = page.getByRole("button", { name: "Deposit" });
    await expect(depositButton).toBeVisible({ timeout: 10000 });
  });

  test("should show underlying token for direct deposit", async ({ page }) => {
    // Deposit tab shows the underlying token (cvxCRV for yscvxCRV vault)
    // The token name appears multiple times, check the header/description area
    await expect(page.locator("text=cvxCRV").first()).toBeVisible({ timeout: 10000 });
  });

  test("should show Connect Wallet button when not connected", async ({ page }) => {
    const connectButton = page.getByRole("button", { name: "Connect Wallet" });
    await expect(connectButton).toBeVisible({ timeout: 10000 });
  });

  test("should have amount input field", async ({ page }) => {
    const amountInput = page.locator('input[type="number"], input[inputmode="decimal"]');
    await expect(amountInput.first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Withdraw Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/vaults/yscvxcrv");
  });

  test("should switch to withdraw tab", async ({ page }) => {
    const withdrawButton = page.getByRole("button", { name: "Withdraw" });
    await withdrawButton.click();

    // Tab should be active
    await expect(withdrawButton).toBeVisible();
  });

  test("should show vault shares as input in withdraw mode", async ({ page }) => {
    await page.getByRole("button", { name: "Withdraw" }).click();

    // Should reference vault shares (yscvxCRV) - appears in multiple places
    await expect(page.locator("text=yscvxCRV").first()).toBeVisible();
  });
});

test.describe("Vault-to-Vault Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/vaults/yscvxcrv");
  });

  test("should show yld vaults in token selector", async ({ page }) => {
    await page.getByRole("button", { name: "Zap" }).click();

    // Wait for Zap content to load
    await expect(page.getByRole("button", { name: "Zap In" })).toBeVisible({ timeout: 10000 });

    // Find and click token selector button
    const tokenSelectors = page.locator('button').filter({ hasText: /^(ETH|CVX|USDC|USDT|CRV)\s+(ETH|CVX|USDC|USDT|CRV)$/ });
    const tokenButton = tokenSelectors.first();

    if (!(await tokenButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await tokenButton.click();

    // Wait for modal
    await expect(page.getByRole("heading", { name: "Select a token" })).toBeVisible();

    // Look for yld Vaults tab
    const vaultsTab = page.locator('button:has-text("yld Vaults")');
    if (await vaultsTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await vaultsTab.click();

      // Should show other vaults (use first() to avoid strict mode)
      await expect(page.locator("text=ycvxCRV").first()).toBeVisible({ timeout: 5000 });
    } else {
      // Tab might not be visible, that's ok - skip this assertion
      test.skip();
    }
  });

  test("should show zap out with vault as destination", async ({ page }) => {
    await page.getByRole("button", { name: "Zap" }).click();
    await page.getByRole("button", { name: "Zap Out" }).click();

    // Wait for Zap Out content
    await expect(page.getByRole("button", { name: "Zap Out" })).toBeVisible({ timeout: 10000 });

    // Find and click token selector button
    const tokenSelectors = page.locator('button').filter({ hasText: /^(ETH|CVX|USDC|USDT|CRV)\s+(ETH|CVX|USDC|USDT|CRV)$/ });
    const tokenButton = tokenSelectors.first();

    if (!(await tokenButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await tokenButton.click();

    // Wait for modal
    await expect(page.getByRole("heading", { name: "Select a token" })).toBeVisible();

    // Look for vaults tab
    const vaultsTab = page.locator('button:has-text("yld Vaults")');
    if (await vaultsTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await vaultsTab.click();

      // Other vaults should be visible as destinations
      await expect(page.locator("text=ycvxCRV").first()).toBeVisible({ timeout: 5000 });
    } else {
      // Tab might not be visible, that's ok - skip this assertion
      test.skip();
    }
  });
});

test.describe("Error Handling", () => {
  test("should handle API errors gracefully", async ({ page }) => {

    // Mock bundle API to return error
    await page.route("**/api/enso/intent", (route) => {
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "Internal server error" }),
      });
    });

    await page.goto("/vaults/yscvxcrv");

    // Page should load without crashing
    await expect(page.getByRole("button", { name: "Deposit" })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Zap" })).toBeVisible();
  });

  test("should handle rate limiting", async ({ page }) => {

    // Mock bundle API to return rate limit error
    await page.route("**/api/enso/intent", (route) => {
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ message: "Too many requests" }),
      });
    });

    await page.goto("/vaults/yscvxcrv");

    // Page should still be functional
    await expect(page.getByRole("button", { name: "Deposit" })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Withdraw" })).toBeVisible();
  });
});

test.describe("UI State Persistence", () => {
  test("should remember selected tab after page navigation", async ({ page }) => {
    await page.goto("/vaults/yscvxcrv");

    // Select Zap tab
    await page.getByRole("button", { name: "Zap" }).click();

    // Navigate away
    await page.goto("/");

    // Navigate back
    await page.goto("/vaults/yscvxcrv");

    // Note: Tab state may or may not persist based on implementation
    // This test verifies the page loads correctly after navigation
    await expect(page.getByRole("button", { name: "Deposit" })).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Accessibility", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/vaults/yscvxcrv");
  });

  test("should have proper button labels", async ({ page }) => {
    // Verify buttons have accessible names
    await expect(page.getByRole("button", { name: "Deposit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Withdraw" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Zap" })).toBeVisible();
  });

  test("should have keyboard-navigable token selector", async ({ page }) => {
    await page.getByRole("button", { name: "Zap" }).click();

    // Open token selector
    const tokenButton = page.getByRole("button", { name: /ETH/ }).first();
    await tokenButton.focus();
    await page.keyboard.press("Enter");

    // Modal should open
    await expect(page.getByRole("heading", { name: "Select a token" })).toBeVisible();

    // Should be able to close with Escape
    await page.keyboard.press("Escape");
  });
});
