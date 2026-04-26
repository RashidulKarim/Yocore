/**
 * AuthToken repository — `authTokens` collection.
 *
 * Single-use tokens (email verify, password reset, magic link, PKCE codes).
 * Stored as sha256 hashes only — the raw token is returned ONCE to the caller
 * for embedding in an outbound email/link.
 */
import { AuthToken, type AuthTokenDoc } from '../db/models/AuthToken.js';
import { generateTokenWithHash, hashToken } from '../lib/tokens.js';

export type AuthTokenLean = AuthTokenDoc;

export type AuthTokenType =
  | 'email_verify'
  | 'password_reset'
  | 'email_change'
  | 'product_join_confirm'
  | 'magic_link'
  | 'pkce_code';

export interface IssueTokenInput {
  userId: string;
  productId: string | null;
  type: AuthTokenType;
  ttlSeconds: number;
  payload?: Record<string, unknown>;
  ip?: string | null;
}

export async function issueToken(
  input: IssueTokenInput,
): Promise<{ token: string; tokenHash: string; expiresAt: Date }> {
  const { token, tokenHash } = generateTokenWithHash(32);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  await AuthToken.create({
    userId: input.userId,
    productId: input.productId,
    type: input.type,
    tokenHash,
    payload: input.payload ?? {},
    expiresAt,
    ip: input.ip ?? null,
  });
  return { token, tokenHash, expiresAt };
}

/** Find by raw token (callers do NOT need to hash themselves). */
export async function findByRawToken(
  rawToken: string,
  type: AuthTokenType,
): Promise<AuthTokenLean | null> {
  return AuthToken.findOne({ tokenHash: hashToken(rawToken), type }).lean<AuthTokenLean | null>();
}

/**
 * Atomically mark a token row as used. Returns the document only when the
 * transition `usedAt:null → usedAt:now` succeeded. A subsequent call returns
 * `null` (idempotent: caller distinguishes "already used" from "not found").
 */
export async function markUsed(tokenId: string): Promise<AuthTokenLean | null> {
  const updated = await AuthToken.findOneAndUpdate(
    { _id: tokenId, usedAt: null },
    { $set: { usedAt: new Date() } },
    { new: true },
  ).lean<AuthTokenLean | null>();
  return updated;
}
