/**
 * MFA factor repository.
 *
 * Two factor types:
 *   - 'totp'           — one verified row per (user, product). Until verified,
 *                        the row stays pending.
 *   - 'recovery_code'  — N rows per (user, product); each is single-use.
 */
import { MfaFactor, type MfaFactorDoc } from '../db/models/MfaFactor.js';
import { newId } from '../db/id.js';

export type MfaFactorLean = MfaFactorDoc;

/** Pending TOTP enrolment row (verifiedAt=null). */
export async function createPendingTotp(input: {
  userId: string;
  productId: string | null;
  secretEncrypted: string;
  accountLabel: string;
}): Promise<MfaFactorLean> {
  const doc = await MfaFactor.create({
    _id: newId('mfa'),
    userId: input.userId,
    productId: input.productId,
    type: 'totp',
    secretEncrypted: input.secretEncrypted,
    accountLabel: input.accountLabel,
    verifiedAt: null,
  });
  return doc.toObject() as MfaFactorLean;
}

export async function findPendingTotp(
  enrolmentId: string,
  userId: string,
): Promise<MfaFactorLean | null> {
  return MfaFactor.findOne({
    _id: enrolmentId,
    userId,
    type: 'totp',
    verifiedAt: null,
  }).lean<MfaFactorLean | null>();
}

export async function findVerifiedTotp(
  userId: string,
  productId: string | null,
): Promise<MfaFactorLean | null> {
  return MfaFactor.findOne({
    userId,
    productId,
    type: 'totp',
    verifiedAt: { $ne: null },
  }).lean<MfaFactorLean | null>();
}

/**
 * Mark a pending TOTP row verified. Returns true on success, false if the row
 * either does not exist or was already verified.
 *
 * NOTE: This will FAIL with a duplicate-key error if another verified TOTP
 * already exists for (user, product) — the unique partial index enforces
 * "one verified TOTP per (user, product)". The caller must handle this.
 */
export async function markTotpVerified(
  enrolmentId: string,
  counter: number,
): Promise<boolean> {
  const now = new Date();
  const res = await MfaFactor.updateOne(
    { _id: enrolmentId, verifiedAt: null },
    {
      $set: {
        verifiedAt: now,
        lastUsedAt: now,
        lastUsedCounter: counter,
      },
    },
  );
  return res.modifiedCount === 1;
}

export async function recordTotpUse(
  factorId: string,
  counter: number,
): Promise<void> {
  await MfaFactor.updateOne(
    { _id: factorId },
    { $set: { lastUsedAt: new Date(), lastUsedCounter: counter } },
  );
}

/** Wipe ALL MFA rows for (user, product). Used by enrol restart + reset flows. */
export async function deleteAllForUserProduct(
  userId: string,
  productId: string | null,
): Promise<void> {
  await MfaFactor.deleteMany({ userId, productId });
}

// ─── Recovery codes ──────────────────────────────────────────────────────────

export async function insertRecoveryCodes(input: {
  userId: string;
  productId: string | null;
  codeHashes: readonly string[];
}): Promise<void> {
  if (input.codeHashes.length === 0) return;
  await MfaFactor.insertMany(
    input.codeHashes.map((codeHash) => ({
      _id: newId('mfa'),
      userId: input.userId,
      productId: input.productId,
      type: 'recovery_code',
      codeHash,
    })),
  );
}

/** Returns the matching unused row, or null. */
export async function findUnusedRecoveryByHash(input: {
  userId: string;
  productId: string | null;
  codeHash: string;
}): Promise<MfaFactorLean | null> {
  return MfaFactor.findOne({
    userId: input.userId,
    productId: input.productId,
    type: 'recovery_code',
    codeHash: input.codeHash,
    usedAt: null,
  }).lean<MfaFactorLean | null>();
}

export async function markRecoveryUsed(factorId: string): Promise<boolean> {
  const res = await MfaFactor.updateOne(
    { _id: factorId, type: 'recovery_code', usedAt: null },
    { $set: { usedAt: new Date() } },
  );
  return res.modifiedCount === 1;
}

export async function countUnusedRecovery(
  userId: string,
  productId: string | null,
): Promise<number> {
  return MfaFactor.countDocuments({
    userId,
    productId,
    type: 'recovery_code',
    usedAt: null,
  });
}

export async function deleteAllRecovery(
  userId: string,
  productId: string | null,
): Promise<void> {
  await MfaFactor.deleteMany({ userId, productId, type: 'recovery_code' });
}
