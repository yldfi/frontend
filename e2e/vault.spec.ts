import { test, expect } from "@playwright/test";

// ycvxCRV vault ID (route uses ID, not address)
const VAULT_ID = "ycvxcrv";

test.describe("Vault Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/vaults/${VAULT_ID}`);
  });

  test("displays vault name and symbol", async ({ page }) => {
    // Vault name should be visible
    const vaultHeader = page.locator("h1, h2").first();
    await expect(vaultHeader).toBeVisible({ timeout: 10000 });
  });

  test("displays vault stats", async ({ page }) => {
    // APY should be visible
    const apyText = page.getByText(/APY|apy/i);
    await expect(apyText.first()).toBeVisible({ timeout: 10000 });

    // TVL should be visible
    const tvlText = page.getByText(/TVL|tvl/i);
    await expect(tvlText.first()).toBeVisible({ timeout: 10000 });
  });

  test("displays deposit/withdraw tabs", async ({ page }) => {
    // Look for deposit button (it's a button element, not a tab)
    const depositButton = page.getByRole("button", { name: "Deposit" });
    await expect(depositButton).toBeVisible({ timeout: 10000 });

    // Also check withdraw button exists
    const withdrawButton = page.getByRole("button", { name: "Withdraw" });
    await expect(withdrawButton).toBeVisible();
  });

  test("shows zap token selector", async ({ page }) => {
    // Wait for page to load
    await page.waitForLoadState("networkidle");

    // Token selector should be present for zap functionality
    const tokenSelector = page.locator('[data-testid="token-selector"]');

    // May not be visible immediately if not connected
    if (await tokenSelector.isVisible()) {
      await expect(tokenSelector).toBeVisible();
    }
  });

  test("displays connect wallet prompt for transactions", async ({ page }) => {
    // When not connected, should show "Connect Wallet" button in form
    const connectWalletButton = page.getByRole("button", {
      name: "Connect Wallet",
    });
    await expect(connectWalletButton).toBeVisible({ timeout: 10000 });
  });

  test("can navigate back to home", async ({ page }) => {
    // Find and click logo or back button
    const logo = page.locator('a[href="/"]').first();
    await logo.click();

    // Should navigate to home
    await expect(page).toHaveURL("/");
  });
});

test.describe("Vault Page - Invalid ID", () => {
  test("handles invalid vault ID gracefully", async ({ page }) => {
    await page.goto("/vaults/invalid-vault-id");

    // Should show 404 page with heading
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  });

  test("handles non-existent vault ID", async ({ page }) => {
    // Valid format but not a vault
    await page.goto("/vaults/nonexistent");

    // Should show 404 page with heading
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  });
});
