import { test, expect } from '@playwright/test';
import { ENABLED, URLS } from './helpers';

test.describe('Bundle checkout', () => {
  test.skip(!ENABLED, 'set YOCORE_E2E=true to run');

  test('subscribes to a bundle that activates multiple products', async ({ page }) => {
    await page.goto(`${URLS.auth}/bundles`);
    await page.click('text=Subscribe to Studio Bundle');
    await expect(page).toHaveURL(/checkout\.stripe\.com/);
  });
});
