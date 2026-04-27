import { test, expect } from '@playwright/test';
import { ENABLED, URLS } from './helpers';

test.describe('GDPR data export', () => {
  test.skip(!ENABLED, 'set YOCORE_E2E=true to run');

  test('user requests export and gets emailed link', async ({ page }) => {
    await page.goto(`${URLS.auth}/account/privacy`);
    await page.click('button:has-text("Request data export")');
    await expect(page.locator('text=We are preparing your export')).toBeVisible();

    // The export job runs async — poll the test harness for completion.
    const status = await page.evaluate(async (api) => {
      for (let i = 0; i < 30; i++) {
        const r = await fetch(`${api}/v1/test/last-export-status`);
        const j = await r.json();
        if (j.status === 'ready') return j;
        await new Promise((r) => setTimeout(r, 2000));
      }
      return { status: 'timeout' };
    }, URLS.api);
    expect(status.status).toBe('ready');
  });
});
