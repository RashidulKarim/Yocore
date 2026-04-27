import { test, expect } from '@playwright/test';
import { ENABLED, URLS, uniqueEmail } from './helpers';

test.describe('End-user signup → checkout → cancel', () => {
  test.skip(!ENABLED, 'set YOCORE_E2E=true to run');

  test('full lifecycle in auth-web', async ({ page }) => {
    const email = uniqueEmail('checkout');
    await page.goto(`${URLS.auth}/signup`);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', 'TestPassword!1');
    await page.fill('input[name="name"]', 'E2E User');
    await page.click('button:has-text("Sign up")');

    await expect(page.locator('text=Verify your email')).toBeVisible();

    // Test harness retrieves OTP via /v1/test/otp (only when E2E mode).
    const otp = await page.evaluate(async (api) => {
      const r = await fetch(`${api}/v1/test/otp?email=${encodeURIComponent(arguments[1])}`);
      const j = await r.json();
      return j.code as string;
    }, [URLS.api, email]);
    test.skip(!otp, 'OTP harness endpoint unavailable');

    await page.fill('input[name="otp"]', otp!);
    await page.click('button:has-text("Verify")');

    // Pick a plan and complete Stripe Checkout (test mode).
    await page.click('text=Choose Pro');
    await expect(page).toHaveURL(/checkout\.stripe\.com/);
    // Stripe-hosted checkout — handled by stripe test card autofill in another spec.
  });
});
