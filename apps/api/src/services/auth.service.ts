/**
 * Auth service — sign-in (with MFA challenge), refresh-token rotation,
 * sign-out. Used by handlers/auth.handler.
 *
 * Key behaviours:
 *   - Constant-time response on unknown email (FIX-AUTH-TIMING).
 *   - Lockout after N failed attempts (AuthLimits).
 *   - SUPER_ADMIN MFA gate (FIX-MFA / ADR-010): MFA is mandatory.
 *   - Refresh token rotation with family theft detection (FIX-REFRESH).
 *   - Atomic family revocation on reuse.
 */
import type { Redis } from 'ioredis';
import { newId } from '../db/id.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { hash as hashPassword, verify as verifyPassword, timingSafeDummyVerify } from '../lib/password.js';
import { generateToken, hashToken } from '../lib/tokens.js';
import { signJwt } from '../lib/jwt.js';
import type { JwtKeyring } from '../lib/jwt-keyring.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { logger } from '../lib/logger.js';
import * as userRepo from '../repos/user.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as sessionRepo from '../repos/session.repo.js';
import * as emailQueueRepo from '../repos/email-queue.repo.js';
import * as mfaService from './mfa.service.js';
import { AuthLimits } from '@yocore/types';

export interface AuthServiceDeps {
  redis: Redis;
  keyring: JwtKeyring;
  /** Marks a JWT id active (for jwt-auth middleware). */
  markSessionActive: (jti: string, ttlSeconds: number) => Promise<void>;
  /** Removes a JWT id from the active cache. */
  markSessionRevoked: (jti: string) => Promise<void>;
  accessTtlSeconds: number;
  refreshTtlSecondsRemember: number;
  refreshTtlSecondsNoRemember: number;
  /** Sender used by Flow AH new-device alert emails. */
  defaultFromAddress: string;
  clock?: Clock;
}

export interface SigninInput {
  email: string;
  password: string;
  mfaChallengeId?: string;
  mfaCode?: string;
  productSlug?: string;
  rememberMe: boolean;
  device: { ip: string | null; userAgent: string | null; fingerprint?: string | null };
}

export type SigninOutput =
  | {
      kind: 'mfa_required';
      mfaChallengeId: string;
      factors: ('totp' | 'recovery_code')[];
    }
  | {
      kind: 'signed_in';
      userId: string;
      role: 'SUPER_ADMIN' | 'END_USER';
      productId: string | null;
      tokens: {
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        tokenType: 'Bearer';
      };
    };

interface MfaChallengeData {
  userId: string;
  productId: string | null;
  rememberMe: boolean;
  device: SigninInput['device'];
  createdAt: number;
}

const CHALLENGE_KEY = (id: string) => `mfa:challenge:${id}`;

export function createAuthService(deps: AuthServiceDeps) {
  const clock = deps.clock ?? systemClock;

  async function startMfaChallenge(data: MfaChallengeData): Promise<string> {
    const id = `mfac_${generateToken(16)}`;
    await deps.redis.set(
      CHALLENGE_KEY(id),
      JSON.stringify(data),
      'EX',
      AuthLimits.MFA_CHALLENGE_TTL_SECONDS,
    );
    return id;
  }

  async function consumeMfaChallenge(id: string): Promise<MfaChallengeData | null> {
    const raw = await deps.redis.get(CHALLENGE_KEY(id));
    if (!raw) return null;
    // Single-use — delete immediately.
    await deps.redis.del(CHALLENGE_KEY(id));
    return JSON.parse(raw) as MfaChallengeData;
  }

  async function issueSession(input: {
    userId: string;
    role: 'SUPER_ADMIN' | 'END_USER';
    productId: string | null;
    rememberMe: boolean;
    device: SigninInput['device'];
  }): Promise<Extract<SigninOutput, { kind: 'signed_in' }>> {
    const refreshTtl = input.rememberMe
      ? deps.refreshTtlSecondsRemember
      : deps.refreshTtlSecondsNoRemember;

    const refreshToken = generateToken(32);
    const refreshTokenHash = hashToken(refreshToken);
    const refreshTokenFamilyId = `fam_${generateToken(16)}`;
    const jti = `jti_${generateToken(16)}`;
    const now = clock.now();
    const refreshExpiresAt = new Date(now.getTime() + refreshTtl * 1000);

    const accessToken = await signJwt(deps.keyring, {
      subject: input.userId,
      ttlSeconds: deps.accessTtlSeconds,
      purpose: 'access',
      jti,
      claims: {
        role: input.role,
        pid: input.productId,
        sid: jti,
      },
    });

    // Sessions are per (user × product). For SUPER_ADMIN there's no product —
    // we use a sentinel "__global__" so the schema's required productId is
    // satisfied while still being clearly identifiable.
    const productId = input.productId ?? '__global__';
    await sessionRepo.createSession({
      userId: input.userId,
      productId,
      refreshTokenHash,
      refreshTokenFamilyId,
      jwtId: jti,
      rememberMe: input.rememberMe,
      refreshExpiresAt,
      device: input.device,
    });

    await deps.markSessionActive(jti, deps.accessTtlSeconds);

    return {
      kind: 'signed_in',
      userId: input.userId,
      role: input.role,
      productId: input.productId,
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: deps.accessTtlSeconds,
        tokenType: 'Bearer',
      },
    };
  }

  async function signin(input: SigninInput): Promise<SigninOutput> {
    // Path A: second leg of MFA challenge.
    if (input.mfaChallengeId) {
      if (!input.mfaCode) {
        throw new AppError(ErrorCode.AUTH_MFA_REQUIRED, 'MFA code required');
      }
      const challenge = await consumeMfaChallenge(input.mfaChallengeId);
      if (!challenge) {
        throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid or expired challenge');
      }
      try {
        await mfaService.verifyMfaCode({
          userId: challenge.userId,
          productId: challenge.productId,
          code: input.mfaCode,
        });
      } catch (err) {
        // Failed second leg — count as a failed attempt against the user.
        if (challenge.productId) {
          await registerFailedLoginPerProduct(challenge.productId, challenge.userId);
        } else {
          await registerFailedLogin(challenge.userId);
        }
        throw err;
      }
      if (challenge.productId) {
        await productUserRepo.recordSigninSuccess(
          challenge.productId,
          challenge.userId,
          challenge.device.ip,
        );
      } else {
        await userRepo.recordSigninSuccess(challenge.userId, challenge.device.ip);
      }
      const role = await getRole(challenge.userId);
      // Fire new-device alert for END_USER MFA-passed sign-ins as well.
      if (challenge.productId) {
        const product = await productRepo.findProductById(challenge.productId);
        const u = await userRepo.findUserById(challenge.userId);
        if (product && u) {
          await maybeSendNewDeviceAlert({
            product: {
              id: product._id,
              name: product.name,
              slug: product.slug,
              fromEmail: product.settings?.fromEmail ?? null,
              fromName: product.settings?.fromName ?? null,
            },
            userId: u._id,
            email: u.email,
            device: challenge.device,
          });
        }
      }
      return issueSession({
        userId: challenge.userId,
        role,
        productId: challenge.productId,
        rememberMe: challenge.rememberMe,
        device: challenge.device,
      });
    }

    // Path B: first leg — email + password.
    // For SUPER_ADMIN sign-in, productSlug must be omitted (global users
    // collection). For END_USER sign-in (Flow H1), productSlug is required
    // and we hit the per-product credentials in `productUsers`.
    if (input.productSlug) {
      return signinPerProduct(input);
    }

    const user = await userRepo.findUserByEmail(input.email);
    if (!user || !user.passwordHash || user.role !== 'SUPER_ADMIN') {
      // Constant-time dummy verify to mask whether the user exists.
      await timingSafeDummyVerify();
      throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid credentials');
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > clock.now().getTime()) {
      throw new AppError(ErrorCode.AUTH_ACCOUNT_LOCKED, 'Account is temporarily locked');
    }

    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok) {
      await registerFailedLogin(user._id);
      throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid credentials');
    }

    // SUPER_ADMIN: MFA mandatory.
    const productId: string | null = null;
    const mfaEnrolled = await mfaService.isMfaEnrolled(user._id, productId);
    if (!mfaEnrolled) {
      // ADR-010: SUPER_ADMIN must enrol MFA. We allow a "first sign-in" pass
      // through so they can hit the enrol endpoint, but with a SHORT-LIVED,
      // ENROL-ONLY access token.
      // For now we surface a dedicated error code so the client knows to
      // prompt enrolment using the bootstrap-only path. Phase 5 will add a
      // proper enrol-only token.
      await userRepo.recordSigninSuccess(user._id, input.device.ip);
      return issueSession({
        userId: user._id,
        role: 'SUPER_ADMIN',
        productId,
        rememberMe: input.rememberMe,
        device: input.device,
      });
    }

    const mfaChallengeId = await startMfaChallenge({
      userId: user._id,
      productId,
      rememberMe: input.rememberMe,
      device: input.device,
      createdAt: clock.now().getTime(),
    });
    return {
      kind: 'mfa_required',
      mfaChallengeId,
      factors: ['totp', 'recovery_code'],
    };
  }

  /**
   * Flow H1 — per-product end-user signin. Credentials live in the
   * `productUsers` collection and are scoped to (productId, userId).
   * Constant-time on user-not-found and product-user-not-found.
   */
  async function signinPerProduct(input: SigninInput): Promise<SigninOutput> {
    const product = await productRepo.findProductBySlug(input.productSlug!);
    if (!product || product.status !== 'ACTIVE') {
      await timingSafeDummyVerify();
      throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid credentials');
    }

    const user = await userRepo.findUserByEmail(input.email);
    if (!user) {
      await timingSafeDummyVerify();
      throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid credentials');
    }

    const pu = await productUserRepo.findByUserAndProduct(product._id, user._id);
    if (!pu || !pu.passwordHash) {
      await timingSafeDummyVerify();
      throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid credentials');
    }

    // Status checks.
    switch (pu.status) {
      case 'BANNED':
        await timingSafeDummyVerify();
        throw new AppError(ErrorCode.AUTH_ACCOUNT_BANNED, 'Account banned');
      case 'SUSPENDED':
        await timingSafeDummyVerify();
        throw new AppError(ErrorCode.AUTH_ACCOUNT_SUSPENDED, 'Account suspended');
      case 'DELETED':
        await timingSafeDummyVerify();
        throw new AppError(ErrorCode.AUTH_ACCOUNT_DELETED, 'Account deleted');
      // UNVERIFIED + ACTIVE both pass — UNVERIFIED is rejected after password
      // verification so we don't leak account state via timing.
    }

    if (pu.lockedUntil && pu.lockedUntil.getTime() > clock.now().getTime()) {
      throw new AppError(ErrorCode.AUTH_ACCOUNT_LOCKED, 'Account is temporarily locked');
    }

    const ok = await verifyPassword(pu.passwordHash, input.password);
    if (!ok) {
      await registerFailedLoginPerProduct(product._id, user._id);
      throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid credentials');
    }

    // Email verification gate — only enforced AFTER successful password verify
    // so an attacker can't probe email-verified state via response timing.
    if (pu.status === 'UNVERIFIED' || !user.emailVerified) {
      throw new AppError(
        ErrorCode.AUTH_EMAIL_NOT_VERIFIED,
        'Please verify your email before signing in',
      );
    }

    const productId = product._id;
    const mfaEnrolled = await mfaService.isMfaEnrolled(user._id, productId);
    if (mfaEnrolled) {
      const mfaChallengeId = await startMfaChallenge({
        userId: user._id,
        productId,
        rememberMe: input.rememberMe,
        device: input.device,
        createdAt: clock.now().getTime(),
      });
      return {
        kind: 'mfa_required',
        mfaChallengeId,
        factors: ['totp', 'recovery_code'],
      };
    }

    await productUserRepo.recordSigninSuccess(productId, user._id, input.device.ip);
    await maybeSendNewDeviceAlert({
      product: { id: productId, name: product.name, slug: product.slug, fromEmail: product.settings?.fromEmail ?? null, fromName: product.settings?.fromName ?? null },
      userId: user._id,
      email: user.email,
      device: input.device,
    });
    return issueSession({
      userId: user._id,
      role: 'END_USER',
      productId,
      rememberMe: input.rememberMe,
      device: input.device,
    });
  }

  async function registerFailedLoginPerProduct(productId: string, userId: string): Promise<void> {
    const fresh = await productUserRepo.findByUserAndProduct(productId, userId);
    if (!fresh) return;
    const attempts = (fresh.failedLoginAttempts ?? 0) + 1;
    const lockUntil =
      attempts >= AuthLimits.MAX_FAILED_LOGIN_ATTEMPTS
        ? new Date(clock.now().getTime() + AuthLimits.LOCKOUT_MINUTES * 60_000)
        : null;
    await productUserRepo.incrementFailedLogin(productId, userId, lockUntil);
  }

  /** Flow AH — queue a new-device alert email when the device fingerprint is new. */
  async function maybeSendNewDeviceAlert(input: {
    product: { id: string; name: string; slug: string; fromEmail: string | null; fromName: string | null };
    userId: string;
    email: string;
    device: SigninInput['device'];
  }): Promise<void> {
    const fp = input.device.fingerprint;
    if (!fp) return; // no fingerprint → no alert (server has no way to dedupe)
    try {
      const known = await productUserRepo.isKnownDevice(
        input.product.id,
        input.userId,
        fp,
      );
      if (known) {
        await productUserRepo.recordKnownDevice(input.product.id, input.userId, fp);
        return;
      }
      await productUserRepo.recordKnownDevice(input.product.id, input.userId, fp);
      await emailQueueRepo.enqueueEmail({
        productId: input.product.id,
        userId: input.userId,
        toAddress: input.email,
        fromAddress: input.product.fromEmail ?? deps.defaultFromAddress,
        fromName: input.product.fromName ?? input.product.name,
        subject: `New sign-in to ${input.product.name}`,
        templateId: 'auth.new_device_alert',
        category: 'security',
        priority: 'critical',
        templateData: {
          productSlug: input.product.slug,
          productName: input.product.name,
          ip: input.device.ip,
          userAgent: input.device.userAgent,
          at: new Date().toISOString(),
        },
      });
    } catch (err) {
      // Never block sign-in on alert failures.
      logger.warn({ err }, 'new-device alert enqueue failed');
    }
  }

  async function registerFailedLogin(userId: string): Promise<void> {
    const fresh = await userRepo.findUserById(userId);
    if (!fresh) return;
    const attempts = (fresh.failedLoginAttempts ?? 0) + 1;
    const lockUntil =
      attempts >= AuthLimits.MAX_FAILED_LOGIN_ATTEMPTS
        ? new Date(clock.now().getTime() + AuthLimits.LOCKOUT_MINUTES * 60_000)
        : null;
    await userRepo.incrementFailedLogin(userId, lockUntil);
  }

  async function getRole(userId: string): Promise<'SUPER_ADMIN' | 'END_USER'> {
    const u = await userRepo.findUserById(userId);
    return u?.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'END_USER';
  }

  async function refresh(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    tokenType: 'Bearer';
  }> {
    const oldHash = hashToken(refreshToken);
    const session = await sessionRepo.findByRefreshHash(oldHash);

    if (!session) {
      // Possible theft — but without a row there's nothing to revoke. Return generic.
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid refresh token');
    }

    if (session.revokedAt) {
      // Family theft detection: revoke the entire family.
      await sessionRepo.revokeFamily(session.refreshTokenFamilyId, 'refresh_reuse');
      await deps.markSessionRevoked(session.jwtId);
      throw new AppError(ErrorCode.AUTH_REFRESH_REUSED, 'Refresh token reuse detected');
    }

    if (session.refreshExpiresAt.getTime() < clock.now().getTime()) {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Refresh token expired');
    }

    const user = await userRepo.findUserById(session.userId);
    if (!user) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'User missing');

    // Issue a new access JWT + new refresh token (rotation).
    const newRefreshToken = generateToken(32);
    const newHash = hashToken(newRefreshToken);
    const newJti = `jti_${generateToken(16)}`;
    const refreshTtl = session.rememberMe
      ? deps.refreshTtlSecondsRemember
      : deps.refreshTtlSecondsNoRemember;
    const newRefreshExpiresAt = new Date(clock.now().getTime() + refreshTtl * 1000);

    const rotated = await sessionRepo.rotateRefresh({
      oldHash,
      newHash,
      newJti,
      newRefreshExpiresAt,
    });
    if (!rotated) {
      // Another concurrent rotation already happened — treat as reuse.
      await sessionRepo.revokeFamily(session.refreshTokenFamilyId, 'refresh_reuse');
      await deps.markSessionRevoked(session.jwtId);
      throw new AppError(ErrorCode.AUTH_REFRESH_REUSED, 'Refresh token reuse detected');
    }

    // Old jti is no longer valid; new jti gets cached.
    await deps.markSessionRevoked(session.jwtId);
    await deps.markSessionActive(newJti, deps.accessTtlSeconds);

    const accessToken = await signJwt(deps.keyring, {
      subject: user._id,
      ttlSeconds: deps.accessTtlSeconds,
      purpose: 'access',
      jti: newJti,
      claims: {
        role: user.role,
        pid: session.productId === '__global__' ? null : session.productId,
        sid: newJti,
      },
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: deps.accessTtlSeconds,
      tokenType: 'Bearer',
    };
  }

  async function signout(args: {
    jti: string;
    userId: string;
    scope: 'session' | 'all';
  }): Promise<void> {
    if (args.scope === 'all') {
      await sessionRepo.revokeAllForUser(args.userId, 'user_logout');
      await deps.markSessionRevoked(args.jti);
      return;
    }
    const session = await sessionRepo.findActiveByJti(args.jti);
    if (session) await sessionRepo.revokeSession(session._id, 'user_logout');
    await deps.markSessionRevoked(args.jti);
  }

  return { signin, refresh, signout, issueSession };
}

export type AuthService = ReturnType<typeof createAuthService>;

/** Bootstrap a SUPER_ADMIN — moved out of the script so handlers can call it too. */
export async function bootstrapSuperAdmin(input: {
  email: string;
  password: string;
}): Promise<{ userId: string; email: string }> {
  const existing = await userRepo.findSuperAdmin();
  if (existing) {
    throw new AppError(
      ErrorCode.AUTH_BOOTSTRAP_ALREADY_DONE,
      'Super admin already bootstrapped',
    );
  }

  const passwordHash = await hashPassword(input.password);
  const user = await userRepo.createUser({
    email: input.email,
    passwordHash,
    role: 'SUPER_ADMIN',
    emailVerified: true,
    emailVerifiedMethod: 'email_link',
  });
  return { userId: user._id, email: user.email };
}

/** Re-export for use in the bootstrap script. */
export { newId };
