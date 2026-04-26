/**
 * Seed development data for local YoCore.
 * Idempotent — safe to re-run.
 *
 * Creates:
 *   - Demo product "YoPM Demo" with API key + secret
 *   - Sample plans (Free, Pro Monthly, Pro Annual)
 *   - Test workspace + member
 *
 * Usage:  pnpm tsx scripts/seed-dev.ts
 */
import { config } from 'dotenv';
config();

async function main() {
  // TODO Phase 2: import from @yocore/api once models exist.
  // eslint-disable-next-line no-console
  console.log('[seed-dev] Skeleton — waiting for Phase 2 models to be implemented.');
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[seed-dev] Failed:', err);
  process.exit(1);
});
