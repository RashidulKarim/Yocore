/**
 * JWT sign + verify against the in-memory keyring.
 *
 * Sign: uses the active key. Verify: looks up `kid` in the keyring (active OR
 * verifying). Throws AppError(AUTH_INVALID_TOKEN) on any failure path so call
 * sites get a single, consistent code.
 */
import { SignJWT, jwtVerify, type JWTPayload, type JWTHeaderParameters } from 'jose';
import { AppError, ErrorCode } from './errors.js';
import { env } from '../config/env.js';
import type { JwtKeyring } from './jwt-keyring.js';

export type JwtPurpose = 'access' | 'refresh' | 'hosted-auth' | 'email-verify' | 'password-reset';

export interface SignOptions {
  subject: string;
  ttlSeconds: number;
  purpose: JwtPurpose;
  audience?: string | readonly string[];
  /** Extra non-reserved claims. Avoid clashing with iss/sub/iat/exp/jti/aud/typ. */
  claims?: Record<string, unknown>;
  /** Optional jti — auto-generated if omitted. */
  jti?: string;
}

export interface VerifyOptions {
  purpose: JwtPurpose;
  audience?: string | readonly string[];
}

export interface VerifiedJwt {
  payload: JWTPayload & { typ: JwtPurpose };
  protectedHeader: JWTHeaderParameters;
  kid: string;
}

function newJti(): string {
  // Lightweight 16-byte random; not security-critical, just a unique identifier.
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
}

export async function signJwt(keyring: JwtKeyring, opts: SignOptions): Promise<string> {
  const active = keyring.getActive();
  if (!active) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, 'No active JWT signing key');
  }

  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ ...opts.claims, typ: opts.purpose })
    .setProtectedHeader({ alg: active.alg, kid: active.kid, typ: 'JWT' })
    .setIssuer(env.JWT_ISSUER)
    .setSubject(opts.subject)
    .setIssuedAt(now)
    .setExpirationTime(now + opts.ttlSeconds)
    .setJti(opts.jti ?? newJti());

  if (opts.audience !== undefined) jwt.setAudience(opts.audience as string | string[]);

  return jwt.sign(active.privateKey);
}

export async function verifyJwt(
  keyring: JwtKeyring,
  token: string,
  opts: VerifyOptions,
): Promise<VerifiedJwt> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Missing token');
  }

  // Parse the header to extract the kid before verifying.
  let header: JWTHeaderParameters;
  try {
    const headerSegment = token.split('.')[0];
    if (!headerSegment) throw new Error('no header');
    header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString('utf8')) as JWTHeaderParameters;
  } catch {
    throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Malformed token');
  }

  const kid = header.kid;
  if (!kid) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Missing kid');
  const entry = keyring.getVerify(kid);
  if (!entry) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Unknown kid');

  try {
    const result = await jwtVerify(token, entry.publicKey, {
      issuer: env.JWT_ISSUER,
      ...(opts.audience !== undefined ? { audience: opts.audience as string | string[] } : {}),
      algorithms: [entry.alg],
    });
    if (result.payload['typ'] !== opts.purpose) {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Wrong token purpose');
    }
    return {
      payload: result.payload as VerifiedJwt['payload'],
      protectedHeader: result.protectedHeader,
      kid,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Token verification failed');
  }
}
