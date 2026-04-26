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

  if (password.length < 12) {
    // eslint-disable-next-line no-console
    console.error('[bootstrap-superadmin] Password must be at least 12 characters.');
    process.exit(1);
  }

  const { connectMongo, disconnectMongo } = await import('../apps/api/src/config/db.js');
  const { User } = await import('../apps/api/src/db/models/User.js');
  const { AuditLog } = await import('../apps/api/src/db/models/AuditLog.js');
  const { hash } = await import('../apps/api/src/lib/password.js');
  const { computeAuditHash } = await import('../apps/api/src/middleware/audit-log.js');
  const { newId } = await import('../apps/api/src/db/id.js');

  await connectMongo();

  try {
    const existing = await User.findOne({ role: 'SUPER_ADMIN' }).lean();
    if (existing) {
      // eslint-disable-next-line no-console
      console.error(`[bootstrap-superadmin] SUPER_ADMIN already exists (${existing.email}).`);
      process.exit(2);
    }

    const passwordHash = await hash(password);
    const normalized = email.trim().toLowerCase();

    const user = await User.create({
      email: normalized,
      emailNormalized: normalized,
      passwordHash,
      passwordUpdatedAt: new Date(),
      emailVerified: true,
      emailVerifiedAt: new Date(),
      emailVerifiedMethod: 'email_link',
      role: 'SUPER_ADMIN',
    });

    // Audit log entry — start of the global chain (prevHash null).
    const ts = new Date();
    const body = {
      ts,
      productId: null,
      workspaceId: null,
      actor: {
        type: 'system' as const,
        id: null,
        ip: null,
        userAgent: 'bootstrap-superadmin-script',
        apiKeyId: null,
        sessionId: null,
        correlationId: newId('cor'),
      },
      action: 'super_admin.bootstrap',
      resource: { type: 'user', id: user._id },
      outcome: 'success' as const,
      reason: null,
      metadata: { email: normalized },
    };
    await AuditLog.create({
      ...body,
      prevHash: null,
      hash: computeAuditHash(null, body),
    });

    // eslint-disable-next-line no-console
    console.log(`[bootstrap-superadmin] Created SUPER_ADMIN: ${normalized} (id=${user._id})`);
    // eslint-disable-next-line no-console
    console.log('[bootstrap-superadmin] Next step: sign in via /v1/auth/signin and enroll MFA.');
  } finally {
    await disconnectMongo();
  }
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bootstrap-superadmin] Failed:', err);
  process.exit(1);
});
