import { test, expect } from '@playwright/test';
import { ENABLED, URLS } from './helpers';

test.describe('MFA recovery', () => {
  test.skip(!ENABLED, 'set YOCORE_E2E=true to run');

  test('uses recovery code when authenticator unavailable', async ({ page }) => {
    await page.goto(`${URLS.auth}/login`);
    await page.fill('input[name="email"]', process.env['YOCORE_E2E_MFA_USER']!);
    await page.fill('input[name="password"]', process.env['YOCORE_E2E_MFA_PASSWORD']!);
    await page.click('button[type="submit"]');

    await expect(page.locator('input[name="mfaCode"]')).toBeVisible();
    await page.click('text=Use recovery code');
    await page.fill('input[name="recoveryCode"]', process.env['YOCORE_E2E_RECOVERY_CODE']!);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/dashboard/);
  });
});
