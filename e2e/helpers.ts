/**
 * Shared helpers for E2E suites.
 *
 * Every spec begins with `test.skip(!ENABLED)` so that `pnpm test:e2e` is a
 * no-op unless `YOCORE_E2E=true`. Real CI sets this only on the dedicated
 * nightly workflow.
 */
export const ENABLED = process.env['YOCORE_E2E'] === 'true';

export const URLS = {
  api: process.env['YOCORE_E2E_API_URL'] ?? 'http://localhost:4000',
  admin: process.env['YOCORE_E2E_ADMIN_URL'] ?? 'http://localhost:5173',
  auth: process.env['YOCORE_E2E_AUTH_URL'] ?? 'http://localhost:5174',
  demo: process.env['YOCORE_E2E_DEMO_URL'] ?? 'http://localhost:5175',
};

export const TEST_SUPER_ADMIN = {
  email: process.env['YOCORE_E2E_SUPER_ADMIN_EMAIL'] ?? 'super-admin@yocore.local',
  password: process.env['YOCORE_E2E_SUPER_ADMIN_PASSWORD'] ?? 'ChangeMe!Demo123',
};

export function uniqueEmail(prefix = 'e2e-user'): string {
  return `${prefix}+${Date.now()}@example.com`;
}
