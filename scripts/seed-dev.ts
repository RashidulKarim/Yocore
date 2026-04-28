/**
 * Seed development data for local YoCore.
 * Idempotent — safe to re-run.
 *
 * Creates / ensures:
 *   1. Product  — "YoPM Demo"  (slug: yopm-demo, billingScope: workspace)
 *   2. Roles    — OWNER / ADMIN / MEMBER / VIEWER (platform roles for the product)
 *   3. Plans    — Free, Pro Monthly ($19/mo), Pro Annual ($190/yr), Seat-based Team ($29/seat/mo)
 *   4. Coupons  — SAVE20 (20% off, 3 uses), FIXED10 ($10 off once)
 *   5. Users    — alice@demo.test (owner) + bob@demo.test (member)
 *   6. Workspace — "Demo Workspace" owned by Alice
 *   7. Member   — Bob added to workspace as MEMBER
 *   8. Announcement — Welcome banner (global)
 *
 * Usage: pnpm tsx scripts/seed-dev.ts
 */
import { config } from 'dotenv';
config();

const PRODUCT_SLUG = 'yopm-demo';
const PRODUCT_NAME = 'YoPM Demo';
const ALICE_EMAIL = 'alice@demo.test';
const BOB_EMAIL = 'bob@demo.test';
const DEMO_PASSWORD = 'DemoP@ssw0rd1!';

// Hex token helpers (no crypto import needed — Buffer is global in Node)
function hexToken(bytes = 32): string {
  return Buffer.from(
    Array.from({ length: bytes }, () => Math.floor(Math.random() * 256)),
  ).toString('hex');
}

async function main() {
  const log = (...args: unknown[]) => console.log('[seed-dev]', ...args); // eslint-disable-line no-console

  const { connectMongo, disconnectMongo } = await import('../apps/api/src/config/db.js');
  const { newId } = await import('../apps/api/src/db/id.js');
  const { hash } = await import('../apps/api/src/lib/password.js');
  const { Product } = await import('../apps/api/src/db/models/Product.js');
  const { BillingPlan } = await import('../apps/api/src/db/models/BillingPlan.js');
  const { Coupon } = await import('../apps/api/src/db/models/Coupon.js');
  const { Role } = await import('../apps/api/src/db/models/Role.js');
  const { User } = await import('../apps/api/src/db/models/User.js');
  const { ProductUser } = await import('../apps/api/src/db/models/ProductUser.js');
  const { Workspace } = await import('../apps/api/src/db/models/Workspace.js');
  const { WorkspaceMember } = await import('../apps/api/src/db/models/WorkspaceMember.js');
  const { Announcement } = await import('../apps/api/src/db/models/Announcement.js');

  await connectMongo();
  log('Connected to MongoDB.');

  try {
    // ─── 1. Product ──────────────────────────────────────────────────────────
    let product = await Product.findOne({ slug: PRODUCT_SLUG }).lean();
    if (!product) {
      const apiKey = `yc_test_pk_${hexToken(16)}`;
      const rawSecret = hexToken(32);
      const apiSecretHash = await hash(rawSecret);
      const webhookSecret = hexToken(24);
      product = await Product.create({
        name: PRODUCT_NAME,
        slug: PRODUCT_SLUG,
        status: 'ACTIVE',
        billingScope: 'workspace',
        apiKey,
        apiSecretHash,
        webhookSecret,
        webhookEvents: [
          'subscription.activated',
          'subscription.canceled',
          'subscription.past_due',
          'subscription.trial_ended',
          'workspace.deleted',
        ],
        billingConfig: {
          gracePeriodDays: 7,
          gracePeriodEmailSchedule: [1, 5, 7],
          trialDefaultDays: 14,
        },
      });
      log(`Product created: ${PRODUCT_NAME} (id=${product._id})`);
      log(`  apiKey: ${apiKey}`);
      log(`  apiSecret (raw, save now): ${rawSecret}`);
      log(`  webhookSecret: ${webhookSecret}`);
    } else {
      log(`Product exists: ${PRODUCT_NAME} (id=${product._id})`);
    }
    const productId = product._id as string;

    // ─── 2. Platform roles ───────────────────────────────────────────────────
    const roleDefs = [
      { slug: 'OWNER', name: 'Owner', permissions: ['*'], isDefault: false },
      {
        slug: 'ADMIN',
        name: 'Admin',
        permissions: ['workspace.manage', 'members.invite', 'members.remove', 'billing.read'],
        isDefault: false,
      },
      {
        slug: 'MEMBER',
        name: 'Member',
        permissions: ['workspace.read', 'workspace.write'],
        isDefault: true,
      },
      { slug: 'VIEWER', name: 'Viewer', permissions: ['workspace.read'], isDefault: false },
    ];
    const roleMap: Record<string, string> = {};
    for (const def of roleDefs) {
      let role = await Role.findOne({ productId, slug: def.slug }).lean();
      if (!role) {
        role = await Role.create({
          productId,
          slug: def.slug,
          name: def.name,
          isPlatform: true,
          isDefault: def.isDefault,
          permissions: def.permissions,
        });
        log(`  Role created: ${def.slug}`);
      }
      roleMap[def.slug] = role._id as string;
    }

    // ─── 3. Plans ────────────────────────────────────────────────────────────
    const planDefs = [
      {
        slug: 'free',
        name: 'Free',
        isFree: true,
        amount: 0,
        currency: 'usd',
        interval: 'month' as const,
        trialDays: 0,
        status: 'ACTIVE' as const,
        limits: { projects: 3, members: 1, storageGb: 1 },
      },
      {
        slug: 'pro-monthly',
        name: 'Pro Monthly',
        isFree: false,
        amount: 1900, // $19.00 in cents
        currency: 'usd',
        interval: 'month' as const,
        trialDays: 14,
        status: 'ACTIVE' as const,
        limits: { projects: -1, members: 10, storageGb: 50 },
      },
      {
        slug: 'pro-annual',
        name: 'Pro Annual',
        isFree: false,
        amount: 19000, // $190.00 in cents
        currency: 'usd',
        interval: 'year' as const,
        trialDays: 14,
        status: 'ACTIVE' as const,
        limits: { projects: -1, members: 10, storageGb: 50 },
      },
      {
        slug: 'team-monthly',
        name: 'Team (seat-based)',
        isFree: false,
        amount: 2900, // $29/seat base
        currency: 'usd',
        interval: 'month' as const,
        trialDays: 7,
        status: 'ACTIVE' as const,
        seatBased: true,
        perSeatAmount: 2900,
        includedSeats: 1,
        limits: { projects: -1, members: -1, storageGb: 100 },
      },
    ];
    const planMap: Record<string, string> = {};
    for (const def of planDefs) {
      let plan = await BillingPlan.findOne({ productId, slug: def.slug }).lean();
      if (!plan) {
        plan = await BillingPlan.create({ productId, ...def });
        log(`  Plan created: ${def.name} (${def.slug})`);
      }
      planMap[def.slug] = plan._id as string;
    }

    // ─── 4. Coupons ──────────────────────────────────────────────────────────
    const couponDefs = [
      {
        code: 'SAVE20',
        codeNormalized: 'save20',
        discountType: 'percent' as const,
        amount: 20,
        duration: 'once' as const,
        maxUses: 3,
        status: 'ACTIVE' as const,
      },
      {
        code: 'FIXED10',
        codeNormalized: 'fixed10',
        discountType: 'fixed' as const,
        amount: 1000, // $10.00 in cents
        currency: 'usd',
        duration: 'once' as const,
        maxUses: null,
        status: 'ACTIVE' as const,
      },
    ];
    for (const def of couponDefs) {
      const existing = await Coupon.findOne({ productId, codeNormalized: def.codeNormalized }).lean();
      if (!existing) {
        await Coupon.create({ productId, ...def });
        log(`  Coupon created: ${def.code}`);
      }
    }

    // ─── 5. Users (global anchor + productUser) ──────────────────────────────
    async function ensureUser(
      email: string,
      displayName: string,
    ): Promise<{ userId: string; productUserId: string }> {
      const normalized = email.toLowerCase();
      let user = await User.findOne({ email: normalized }).lean();
      if (!user) {
        user = await User.create({
          email: normalized,
          emailNormalized: normalized,
          role: 'END_USER',
          emailVerified: true,
          emailVerifiedAt: new Date(),
          emailVerifiedMethod: 'email_link',
        });
        log(`  User created: ${email}`);
      }
      const userId = user._id as string;

      let pu = await ProductUser.findOne({ userId, productId }).lean();
      if (!pu) {
        const passwordHash = await hash(DEMO_PASSWORD);
        const [firstName = '', ...rest] = displayName.split(' ');
        pu = await ProductUser.create({
          userId,
          productId,
          passwordHash,
          passwordUpdatedAt: new Date(),
          name: { first: firstName, last: rest.join(' '), display: displayName },
          status: 'ACTIVE',
          onboarded: true,
        });
        log(`  ProductUser created: ${email} for product ${productId}`);
      }
      return { userId, productUserId: pu._id as string };
    }

    const alice = await ensureUser(ALICE_EMAIL, 'Alice Demo');
    const bob = await ensureUser(BOB_EMAIL, 'Bob Demo');

    // ─── 6. Workspace ────────────────────────────────────────────────────────
    let workspace = await Workspace.findOne({ productId, slug: 'demo-workspace' }).lean();
    if (!workspace) {
      workspace = await Workspace.create({
        productId,
        name: 'Demo Workspace',
        slug: 'demo-workspace',
        ownerUserId: alice.userId,
        billingContactUserId: alice.userId,
        status: 'ACTIVE',
      });
      log(`  Workspace created: Demo Workspace (id=${workspace._id})`);
    }
    const workspaceId = workspace._id as string;

    // ─── 7. Workspace members ────────────────────────────────────────────────
    const ownerRoleId = roleMap['OWNER'] ?? newId('role');
    const memberRoleId = roleMap['MEMBER'] ?? newId('role');

    const aliceMember = await WorkspaceMember.findOne({
      workspaceId,
      userId: alice.userId,
    }).lean();
    if (!aliceMember) {
      await WorkspaceMember.create({
        workspaceId,
        productId,
        userId: alice.userId,
        roleId: ownerRoleId,
        roleSlug: 'OWNER',
        status: 'ACTIVE',
        addedBy: alice.userId,
      });
      log(`  Alice added to workspace as OWNER`);
    }

    const bobMember = await WorkspaceMember.findOne({
      workspaceId,
      userId: bob.userId,
    }).lean();
    if (!bobMember) {
      await WorkspaceMember.create({
        workspaceId,
        productId,
        userId: bob.userId,
        roleId: memberRoleId,
        roleSlug: 'MEMBER',
        status: 'ACTIVE',
        addedBy: alice.userId,
      });
      log(`  Bob added to workspace as MEMBER`);
    }

    // ─── 8. Announcement ─────────────────────────────────────────────────────
    const existingAnn = await Announcement.findOne({ title: 'Welcome to YoPM Demo' }).lean();
    if (!existingAnn) {
      await Announcement.create({
        productId: null, // global
        title: 'Welcome to YoPM Demo',
        body: 'This is a seeded development environment. All data is for testing only.',
        severity: 'info',
        audience: 'all_users',
        publishedAt: new Date(),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      });
      log(`  Announcement created: Welcome to YoPM Demo`);
    }

    // ─── Summary ─────────────────────────────────────────────────────────────
    log('');
    log('─── Seed complete ───────────────────────────────────────');
    log(`  Product slug : ${PRODUCT_SLUG}`);
    log(`  Product id   : ${productId}`);
    log(`  Plans        : free, pro-monthly, pro-annual, team-monthly`);
    log(`  Coupons      : SAVE20 (20% off), FIXED10 ($10 off)`);
    log(`  Alice        : ${ALICE_EMAIL}  password: ${DEMO_PASSWORD}`);
    log(`  Bob          : ${BOB_EMAIL}    password: ${DEMO_PASSWORD}`);
    log(`  Workspace    : Demo Workspace (id=${workspaceId})`);
    log('─────────────────────────────────────────────────────────');
    log('');
    log('Next steps:');
    log('  1. Sign into admin-web (http://localhost:5173) as Super Admin');
    log('  2. Verify product "YoPM Demo" is ACTIVE');
    log(`  3. Set YOCORE_PRODUCT_API_KEY / _API_SECRET / _WEBHOOK_SECRET in apps/demo-yopm/.env`);
    log('     (printed above on first run; or rotate via admin-web → Product Detail)');
    log('  4. pnpm --filter @yocore/demo-yopm dev → http://localhost:5175');
    log('  5. Sign in as alice@demo.test / DemoP@ssw0rd1!');

  } finally {
    await disconnectMongo();
  }
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[seed-dev] Failed:', err);
  process.exit(1);
});
