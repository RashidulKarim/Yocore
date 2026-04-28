/**
 * ProductUser repository — `productUsers` (User × Product junction).
 *
 * Every query is multi-tenant: filtered by `productId` (FIX-MT / ADR-001).
 */
import { ProductUser, type ProductUserDoc } from '../db/models/ProductUser.js';

export type ProductUserLean = ProductUserDoc;

export async function findByUserAndProduct(
  productId: string,
  userId: string,
): Promise<ProductUserLean | null> {
  return ProductUser.findOne({ productId, userId }).lean<ProductUserLean | null>();
}

export interface CreateProductUserInput {
  productId: string;
  userId: string;
  passwordHash: string | null;
  name?: { first?: string | null; last?: string | null; display?: string | null };
  marketingOptIn?: boolean;
  productRole?: 'END_USER' | 'PRODUCT_ADMIN';
  /** When true, productUser is created in ACTIVE status (admin-provisioned). */
  active?: boolean;
}

export async function createProductUser(
  input: CreateProductUserInput,
): Promise<ProductUserLean> {
  const now = new Date();
  const doc = await ProductUser.create({
    productId: input.productId,
    userId: input.userId,
    passwordHash: input.passwordHash,
    passwordUpdatedAt: input.passwordHash ? now : null,
    name: {
      first: input.name?.first ?? null,
      last: input.name?.last ?? null,
      display: input.name?.display ?? null,
    },
    marketingOptIn: input.marketingOptIn ?? false,
    productRole: input.productRole ?? 'END_USER',
    status: input.active ? 'ACTIVE' : 'UNVERIFIED',
    joinedAt: now,
  });
  return doc.toObject() as ProductUserLean;
}

/** Mark productUser ACTIVE — used by Flow F10 after email verification. */
export async function activate(productId: string, userId: string): Promise<void> {
  await ProductUser.updateOne(
    { productId, userId, status: 'UNVERIFIED' },
    { $set: { status: 'ACTIVE' } },
  );
}

/** Atomically flip `onboarded:false → true` and bump `lastActiveAt`. */
export async function markOnboarded(productId: string, userId: string): Promise<boolean> {
  const res = await ProductUser.updateOne(
    { productId, userId, onboarded: false },
    { $set: { onboarded: true, lastActiveAt: new Date() } },
  );
  return res.modifiedCount === 1;
}

/** Patch optional profile preferences during onboarding. */
export async function updateProfile(
  productId: string,
  userId: string,
  patch: {
    timezone?: string;
    locale?: string;
    dateFormat?: string;
    timeFormat?: '12h' | '24h';
    displayName?: string;
  },
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.timezone) set['timezone'] = patch.timezone;
  if (patch.locale) set['locale'] = patch.locale;
  if (patch.dateFormat) set['dateFormat'] = patch.dateFormat;
  if (patch.timeFormat) set['timeFormat'] = patch.timeFormat;
  if (patch.displayName) set['name.display'] = patch.displayName;
  if (Object.keys(set).length === 0) return;
  await ProductUser.updateOne({ productId, userId }, { $set: set });
}

/** Per-product signin success — clears lock + records lastLogin on the productUser row. */
export async function recordSigninSuccess(
  productId: string,
  userId: string,
  ip: string | null,
): Promise<void> {
  await ProductUser.updateOne(
    { productId, userId },
    {
      $set: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: ip,
        lastActiveAt: new Date(),
      },
    },
  );
}

export async function incrementFailedLogin(
  productId: string,
  userId: string,
  lockUntil: Date | null,
): Promise<void> {
  const update: Record<string, unknown> = { $inc: { failedLoginAttempts: 1 } };
  if (lockUntil) (update as { $set?: Record<string, unknown> }).$set = { lockedUntil: lockUntil };
  await ProductUser.updateOne({ productId, userId }, update);
}

/** Update the per-product password hash (Flow O reset / future change-password). */
export async function setPasswordHash(
  productId: string,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await ProductUser.updateOne(
    { productId, userId },
    {
      $set: {
        passwordHash,
        passwordUpdatedAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    },
  );
}

/**
 * Patch a user's email preferences (Flow AI). Caller passes only the fields
 * being changed. `productId === null` is reserved for global SUPER_ADMIN
 * preferences (currently unused — SUPER_ADMIN gets all transactional mail).
 */
export async function patchEmailPreferences(
  productId: string,
  userId: string,
  patch: Partial<{
    marketing: boolean;
    productUpdates: boolean;
    billing: boolean;
    security: boolean;
  }>,
): Promise<void> {
  const set: Record<string, unknown> = {};
  for (const k of ['marketing', 'productUpdates', 'billing', 'security'] as const) {
    if (patch[k] !== undefined) set[`emailPreferences.${k}`] = patch[k];
  }
  if (Object.keys(set).length === 0) return;
  await ProductUser.updateOne({ productId, userId }, { $set: set });
}

/** Append a device fingerprint to `lastKnownDevices` (capped at 10 entries, MRU). */
export async function recordKnownDevice(
  productId: string,
  userId: string,
  fingerprint: string,
): Promise<void> {
  const now = new Date();
  // Try to update an existing entry; if nothing matched, push a new one.
  const updated = await ProductUser.updateOne(
    { productId, userId, 'lastKnownDevices.fingerprint': fingerprint },
    { $set: { 'lastKnownDevices.$.lastSeenAt': now } },
  );
  if (updated.modifiedCount === 0) {
    await ProductUser.updateOne(
      { productId, userId },
      {
        $push: {
          lastKnownDevices: {
            $each: [{ fingerprint, lastSeenAt: now }],
            $slice: -10,
          },
        },
      },
    );
  }
}

export async function isKnownDevice(
  productId: string,
  userId: string,
  fingerprint: string,
): Promise<boolean> {
  const found = await ProductUser.exists({
    productId,
    userId,
    'lastKnownDevices.fingerprint': fingerprint,
  });
  return found !== null;
}

// ── V1.2-C: PRODUCT_ADMIN management (System Design §5.15 / GAP-03) ──

/**
 * Sets `productRole` to either END_USER or PRODUCT_ADMIN. Caller is the
 * SUPER_ADMIN; pre-check that the productUser exists.
 *
 * Returns `true` if a row was updated, `false` if no matching row.
 */
export async function setProductRole(
  productId: string,
  userId: string,
  role: 'END_USER' | 'PRODUCT_ADMIN',
): Promise<boolean> {
  const res = await ProductUser.updateOne(
    { productId, userId },
    { $set: { productRole: role } },
  );
  return res.matchedCount === 1;
}

export async function listByProductRole(
  productId: string,
  role: 'END_USER' | 'PRODUCT_ADMIN',
): Promise<ProductUserLean[]> {
  return ProductUser.find({ productId, productRole: role })
    .sort({ joinedAt: -1 })
    .lean<ProductUserLean[]>();
}
