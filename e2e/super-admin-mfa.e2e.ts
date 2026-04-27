import { test, expect } from '@playwright/test';
import { ENABLED, URLS, TEST_SUPER_ADMIN } from './helpers';

test.describe('Super Admin login + MFA', () => {
  test.skip(!ENABLED, 'set YOCORE_E2E=true to run');

  test('signs in with TOTP MFA', async ({ page }) => {
    await page.goto(`${URLS.admin}/login`);
    await page.fill('input[name="email"]', TEST_SUPER_ADMIN.email);
    await page.fill('input[name="password"]', TEST_SUPER_ADMIN.password);
    await page.click('button[type="submit"]');

    // MFA challenge expected for super admins.
    await expect(page.locator('input[name="mfaCode"]')).toBeVisible({ timeout: 10_000 });

    // The fixture seed should set TOTP secret; tests inject it via env or seed script.
    const code = process.env['YOCORE_E2E_TOTP_CODE'];
    test.skip(!code, 'set YOCORE_E2E_TOTP_CODE generated from seeded secret');
    await page.fill('input[name="mfaCode"]', code!);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/products$/);
  });
});
