import { test, expect } from "@playwright/test";

test.describe("Homepage", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("displays the homepage", async ({ page }) => {
    // Check page title
    await expect(page).toHaveTitle(/YLD\.fi/);
  });

  test("displays vault cards", async ({ page }) => {
    // Wait for vault cards to load
    const vaultCards = page.locator('[data-testid="vault-card"]');

    // Should have at least one vault card (may need to wait for data)
    await expect(vaultCards.first()).toBeVisible({ timeout: 10000 });
  });

  test("can navigate to vault page", async ({ page }) => {
    // Click on first vault card
    const firstVault = page.locator('[data-testid="vault-card"]').first();
    await expect(firstVault).toBeVisible({ timeout: 10000 });
    await firstVault.click();

    // Should navigate to vault page
    await expect(page).toHaveURL(/\/vault\//);
  });

  test("displays connect wallet button when not connected", async ({
    page,
  }) => {
    // Connect wallet button should be visible
    const connectButton = page.getByRole("button", { name: /connect/i });
    await expect(connectButton).toBeVisible();
  });

  test("has responsive layout", async ({ page }) => {
    // Test mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    // Page should still render
    await expect(page.locator("main")).toBeVisible();

    // Test tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.locator("main")).toBeVisible();

    // Test desktop viewport
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator("main")).toBeVisible();
  });
});
