/**
 * Bootstrap the platform Super Admin (one-time).
 *
 * Pre-conditions:
 *   - Mongo + Redis running
 *   - `BOOTSTRAP_SECRET` env set (generated via `openssl rand -hex 64`)
 *
 * Behaviour:
 *   - Verifies no SUPER_ADMIN exists (partial unique index enforces this)
 *   - Hashes the password via Argon2id worker pool
 *   - Inserts user with role=SUPER_ADMIN, mfaEnrolledAt=null (forces MFA enroll on first login)
 *   - Audit-logs the bootstrap event
 *
 * Usage:
 *   pnpm tsx scripts/bootstrap-superadmin.ts \
 *     --email admin@yocore.test \
 *     --password 'StrongP@ssw0rd!'
 */
import { config } from 'dotenv';
config();

function parseArgs() {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (k && args[i + 1]) out[k] = args[i + 1] as string;
  }
  return out;
}

async function main() {
  const { email, password } = parseArgs();
  if (!email || !password) {
    // eslint-disable-next-line no-console
    console.error('Usage: --email <email> --password <password>');
    process.exit(1);
  }
  // TODO Phase 2: import from @yocore/api once models + password lib exist.
  // eslint-disable-next-line no-console
  console.log('[bootstrap-superadmin] Skeleton — waiting for Phase 2 to be implemented.');
  // eslint-disable-next-line no-console
  console.log(`Would create SUPER_ADMIN: ${email}`);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bootstrap-superadmin] Failed:', err);
  process.exit(1);
});
