import { test, expect } from '@playwright/test';
import { ENABLED, URLS } from './helpers';

test.describe('Super admin → product create + plan publish', () => {
  test.skip(!ENABLED, 'set YOCORE_E2E=true to run');

  test('creates product, adds plan, publishes', async ({ page }) => {
    // Assumes admin session already established by global setup or prior test.
    await page.goto(`${URLS.admin}/products`);
    await page.click('text=New Product');
    await page.fill('input[name="name"]', `e2e-product-${Date.now()}`);
    await page.fill('input[name="slug"]', `e2e-${Date.now()}`);
    await page.click('button:has-text("Create")');

    await expect(page.locator('text=Product created')).toBeVisible({ timeout: 10_000 });

    await page.click('text=Plans');
    await page.click('text=New Plan');
    await page.fill('input[name="name"]', 'Pro');
    await page.fill('input[name="priceCents"]', '1900');
    await page.click('button:has-text("Save")');
    await page.click('button:has-text("Publish")');

    await expect(page.locator('text=Published')).toBeVisible();
  });
});
