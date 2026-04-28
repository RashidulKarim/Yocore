/**
 * User repository — global `users` collection (SUPER_ADMIN credentials live
 * here; END_USER per-product credentials live in `productUsers`).
 *
 * Per ADR-001, this is one of the few collections WITHOUT a productId filter.
 */
import { User, type UserDoc } from '../db/models/User.js';

export type UserLean = UserDoc;

export async function findUserByEmail(email: string): Promise<UserLean | null> {
  const normalized = email.trim().toLowerCase();
  return User.findOne({ email: normalized }).lean<UserLean | null>();
}

export async function findUserById(id: string): Promise<UserLean | null> {
  return User.findById(id).lean<UserLean | null>();
}

export async function findManyByIds(ids: readonly string[]): Promise<UserLean[]> {
  if (ids.length === 0) return [];
  return User.find({ _id: { $in: ids } }).lean<UserLean[]>();
}

export async function findSuperAdmin(): Promise<UserLean | null> {
  return User.findOne({ role: 'SUPER_ADMIN' }).lean<UserLean | null>();
}

export async function createUser(input: {
  email: string;
  passwordHash: string | null;
  role: 'SUPER_ADMIN' | 'END_USER';
  emailVerified?: boolean;
  emailVerifiedMethod?: 'email_link' | 'invitation' | 'oauth_google' | 'oauth_github' | null;
}): Promise<UserLean> {
  const normalized = input.email.trim().toLowerCase();
  const now = new Date();
  const doc = await User.create({
    email: normalized,
    emailNormalized: normalized,
    passwordHash: input.passwordHash,
    passwordUpdatedAt: input.passwordHash ? now : null,
    role: input.role,
    emailVerified: input.emailVerified ?? false,
    emailVerifiedAt: input.emailVerified ? now : null,
    emailVerifiedMethod: input.emailVerifiedMethod ?? null,
  });
  return doc.toObject() as UserLean;
}

export async function recordSigninSuccess(
  userId: string,
  ip: string | null,
): Promise<void> {
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: ip,
      },
    },
  );
}

export async function incrementFailedLogin(
  userId: string,
  lockUntil: Date | null,
): Promise<void> {
  const update: Record<string, unknown> = { $inc: { failedLoginAttempts: 1 } };
  if (lockUntil) (update as { $set?: Record<string, unknown> }).$set = { lockedUntil: lockUntil };
  await User.updateOne({ _id: userId }, update);
}

export async function setPasswordHash(userId: string, passwordHash: string): Promise<void> {
  await User.updateOne(
    { _id: userId },
    { $set: { passwordHash, passwordUpdatedAt: new Date() } },
  );
}

/**
 * Mark a user's email verified (idempotent — repeated calls have no effect
 * once `emailVerified=true`).
 */
export async function markEmailVerified(
  userId: string,
  method: 'email_link' | 'invitation' | 'oauth_google' | 'oauth_github' = 'email_link',
): Promise<void> {
  const now = new Date();
  await User.updateOne(
    { _id: userId, emailVerified: { $ne: true } },
    {
      $set: {
        emailVerified: true,
        emailVerifiedAt: now,
        emailVerifiedMethod: method,
      },
    },
  );
}

/**
 * Update a user's email + mark it verified (Flow P email change confirm).
 * Caller is responsible for revoking sessions afterwards.
 */
export async function updateEmail(userId: string, newEmail: string): Promise<void> {
  const normalized = newEmail.trim().toLowerCase();
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        email: normalized,
        emailNormalized: normalized,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        emailVerifiedMethod: 'email_link',
      },
    },
  );
}

/**
 * Persist Terms of Service + Privacy Policy acceptance versions on the
 * global User document (B-05). Called from signup + finalize-onboarding
 * after the input versions are validated against `tosVersions.isCurrent`.
 */
export async function recordTosAcceptance(
  userId: string,
  input: { tosVersion: string; privacyVersion: string; acceptedAt: Date },
): Promise<void> {
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        tosVersion: input.tosVersion,
        tosAcceptedAt: input.acceptedAt,
        privacyPolicyVersion: input.privacyVersion,
        privacyPolicyAcceptedAt: input.acceptedAt,
      },
    },
  );
}
