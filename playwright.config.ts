/**
 * Playwright config — YoCore E2E suites.
 *
 * These tests are GATED on `process.env.YOCORE_E2E === 'true'` and require:
 *   - YoCore API running at YOCORE_E2E_API_URL (default http://localhost:4000)
 *   - admin-web at YOCORE_E2E_ADMIN_URL  (default http://localhost:5173)
 *   - auth-web at YOCORE_E2E_AUTH_URL    (default http://localhost:5174)
 *   - demo-yopm at YOCORE_E2E_DEMO_URL   (default http://localhost:5175)
 *
 * Run locally: `pnpm test:e2e` after `pnpm dev` is up.
 * In CI: launched only on the `e2e` workflow (nightly + manual dispatch).
 */
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env['YOCORE_E2E_AUTH_URL'] ?? 'http://localhost:5174';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // serial — flows mutate shared DB state
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
