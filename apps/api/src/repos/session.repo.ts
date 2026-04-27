/**
 * Session repository — refresh-token sessions, one per user × product × device.
 *
 * Refresh tokens are stored ONLY as sha256 hashes (`refreshTokenHash`). A
 * refresh-token "family" tracks all rotations originating from a single
 * sign-in; the family is revoked atomically on theft detection.
 */
import { Session, type SessionDoc } from '../db/models/Session.js';
import { newId } from '../db/id.js';

export type SessionLean = SessionDoc;

export interface CreateSessionInput {
  userId: string;
  productId: string;
  workspaceId?: string | null;
  refreshTokenHash: string;
  refreshTokenFamilyId: string;
  jwtId: string;
  rememberMe: boolean;
  refreshExpiresAt: Date;
  device: {
    userAgent: string | null;
    ip: string | null;
    fingerprint?: string | null;
  };
}

export async function createSession(input: CreateSessionInput): Promise<SessionLean> {
  const doc = await Session.create({
    _id: newId('ses'),
    userId: input.userId,
    productId: input.productId,
    workspaceId: input.workspaceId ?? null,
    refreshTokenHash: input.refreshTokenHash,
    refreshTokenFamilyId: input.refreshTokenFamilyId,
    jwtId: input.jwtId,
    rememberMe: input.rememberMe,
    refreshExpiresAt: input.refreshExpiresAt,
    device: {
      userAgent: input.device.userAgent,
      ip: input.device.ip,
      fingerprint: input.device.fingerprint ?? null,
    },
  });
  return doc.toObject() as SessionLean;
}

export async function findByRefreshHash(refreshTokenHash: string): Promise<SessionLean | null> {
  return Session.findOne({ refreshTokenHash }).lean<SessionLean | null>();
}

export async function findActiveByJti(jti: string): Promise<SessionLean | null> {
  return Session.findOne({ jwtId: jti, revokedAt: null }).lean<SessionLean | null>();
}

export async function rotateRefresh(input: {
  oldHash: string;
  newHash: string;
  newJti: string;
  newRefreshExpiresAt: Date;
}): Promise<SessionLean | null> {
  // Strategy: revoke the old session row (kept for theft-detection lookups)
  // and insert a new session row sharing the family. Re-using the old refresh
  // token finds a revoked row → triggers family revocation.
  const old = await Session.findOneAndUpdate(
    { refreshTokenHash: input.oldHash, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'rotated' } },
    { new: false },
  ).lean<SessionLean | null>();
  if (!old) return null;

  const created = await Session.create({
    _id: newId('ses'),
    userId: old.userId,
    productId: old.productId,
    workspaceId: old.workspaceId,
    refreshTokenHash: input.newHash,
    refreshTokenFamilyId: old.refreshTokenFamilyId,
    jwtId: input.newJti,
    rememberMe: old.rememberMe,
    refreshExpiresAt: input.newRefreshExpiresAt,
    device: old.device,
  });
  return created.toObject() as SessionLean;
}

export async function revokeSession(
  sessionId: string,
  reason: 'user_logout' | 'admin' | 'refresh_reuse' | 'password_change' | 'mfa_reset',
): Promise<void> {
  await Session.updateOne(
    { _id: sessionId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

export async function revokeFamily(
  familyId: string,
  reason: 'user_logout' | 'admin' | 'refresh_reuse' | 'password_change' | 'mfa_reset',
): Promise<number> {
  const res = await Session.updateMany(
    { refreshTokenFamilyId: familyId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return res.modifiedCount;
}

export async function revokeAllForUser(
  userId: string,
  reason: 'user_logout' | 'admin' | 'refresh_reuse' | 'password_change' | 'mfa_reset',
): Promise<number> {
  const res = await Session.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return res.modifiedCount;
}

/**
 * Atomically swap an active session's `jwtId` (and optionally `workspaceId`)
 * — used by Flow L3 workspace switching so the new access token is bound to
 * the chosen workspace and the previous jti is no longer accepted by the
 * Redis session-store check.
 */
export async function swapJti(input: {
  oldJti: string;
  newJti: string;
  workspaceId: string | null;
}): Promise<boolean> {
  const res = await Session.updateOne(
    { jwtId: input.oldJti, revokedAt: null },
    {
      $set: {
        jwtId: input.newJti,
        workspaceId: input.workspaceId,
        lastUsedAt: new Date(),
      },
    },
  );
  return res.modifiedCount === 1;
}

/** List active (non-revoked, not-expired) sessions for a user. */
export async function listActiveByUser(userId: string): Promise<SessionLean[]> {
  return Session.find({
    userId,
    revokedAt: null,
    refreshExpiresAt: { $gt: new Date() },
  })
    .sort({ lastUsedAt: -1 })
    .lean<SessionLean[]>();
}

/** Find a session by id (no productId scoping; userId check enforces ownership). */
export async function findById(sessionId: string): Promise<SessionLean | null> {
  return Session.findById(sessionId).lean<SessionLean | null>();
}
