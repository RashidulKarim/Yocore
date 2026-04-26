/**
 * Token primitives: generate cryptographically random opaque tokens and hash
 * them for at-rest storage. Refresh tokens, email verification tokens,
 * password reset tokens, MFA recovery codes, etc. all flow through here.
 *
 * Constant-time comparison helpers also live here.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Generate a base64url-encoded random token. Default 32 bytes ≈ 256 bits of entropy
 * → 43 chars after b64url with no padding.
 */
export function generateToken(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 256) {
    throw new RangeError('generateToken: byteLength must be an integer in [16, 256]');
  }
  return randomBytes(byteLength).toString('base64url');
}

/** SHA-256 of a token, hex-encoded. Use this for at-rest storage. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison. Use for hashed-token lookups, signatures, etc.
 * Returns false (without throwing) when lengths differ to keep callers simple.
 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Convenience: generate a fresh token AND its sha256 hash in one call.
 */
export function generateTokenWithHash(byteLength = 32): { token: string; tokenHash: string } {
  const token = generateToken(byteLength);
  return { token, tokenHash: hashToken(token) };
}
