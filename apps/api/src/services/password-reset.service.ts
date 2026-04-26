/**
 * Password reset service — Flow O (forgot + reset).
 *
 * Two endpoints back this:
 *   - request():  POST /v1/auth/forgot-password — public, constant-time.
 *                 Always returns the same shape; queues a reset email only
 *                 when the (email × productSlug?) actually resolves to a
 *                 credential row.
 *   - reset():    POST /v1/auth/reset-password — consumes the token, sets
 *                 the new password hash, revokes ALL existing sessions for
 *                 the user (FIX-AUTH-RESET).
 *
 * Per ADR-002, credentials live in `users` for SUPER_ADMIN and in
 * `productUsers` for END_USER. The token's `productId` distinguishes the
 * two paths.
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import { hash as hashPassword } from '../lib/password.js';
import { logger } from '../lib/logger.js';
import * as authTokenRepo from '../repos/auth-token.repo.js';
import * as userRepo from '../repos/user.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as sessionRepo from '../repos/session.repo.js';
import * as emailQueueRepo from '../repos/email-queue.repo.js';
import { systemClock, type Clock } from '../lib/clock.js';

/** 1 hour TTL per Sys-Design Flow O. */
const PASSWORD_RESET_TTL_SECONDS = 60 * 60;

export interface PasswordResetServiceDeps {
  defaultFromAddress: string;
  clock?: Clock;
}

export interface ForgotPasswordInput {
  email: string;
  productSlug?: string | undefined;
  ip: string | null;
}

export interface ResetPasswordInput {
  token: string;
  password: string;
}

export function createPasswordResetService(deps: PasswordResetServiceDeps) {
  const clock = deps.clock ?? systemClock;

  async function request(input: ForgotPasswordInput): Promise<{ status: 'reset_email_sent' }> {
    // Always run the same sequence regardless of whether we send an email,
    // to keep timing comparable.
    try {
      const user = await userRepo.findUserByEmail(input.email);
      if (!user) return { status: 'reset_email_sent' };

      if (input.productSlug) {
        const product = await productRepo.findProductBySlug(input.productSlug);
        if (!product || product.status !== 'ACTIVE') return { status: 'reset_email_sent' };
        const pu = await productUserRepo.findByUserAndProduct(product._id, user._id);
        if (!pu || !pu.passwordHash) return { status: 'reset_email_sent' };

        const issued = await authTokenRepo.issueToken({
          userId: user._id,
          productId: product._id,
          type: 'password_reset',
          ttlSeconds: PASSWORD_RESET_TTL_SECONDS,
          ip: input.ip,
        });
        const fromAddress = product.settings?.fromEmail ?? deps.defaultFromAddress;
        const fromName = product.settings?.fromName ?? product.name;
        await emailQueueRepo.enqueueEmail({
          productId: product._id,
          userId: user._id,
          toAddress: input.email,
          fromAddress,
          fromName,
          subject: `Reset your password for ${product.name}`,
          templateId: 'auth.password_reset',
          category: 'security',
          priority: 'critical',
          templateData: {
            productSlug: product.slug,
            productName: product.name,
            resetToken: issued.token,
            expiresAt: issued.expiresAt.toISOString(),
          },
        });
      } else {
        // Global SUPER_ADMIN flow — only meaningful when the user actually
        // has a password hash (END_USERs without productSlug should not get
        // a reset email).
        if (!user.passwordHash || user.role !== 'SUPER_ADMIN') {
          return { status: 'reset_email_sent' };
        }
        const issued = await authTokenRepo.issueToken({
          userId: user._id,
          productId: null,
          type: 'password_reset',
          ttlSeconds: PASSWORD_RESET_TTL_SECONDS,
          ip: input.ip,
        });
        await emailQueueRepo.enqueueEmail({
          productId: null,
          userId: user._id,
          toAddress: input.email,
          fromAddress: deps.defaultFromAddress,
          fromName: 'YoCore',
          subject: 'Reset your YoCore Super Admin password',
          templateId: 'auth.password_reset',
          category: 'security',
          priority: 'critical',
          templateData: {
            resetToken: issued.token,
            expiresAt: issued.expiresAt.toISOString(),
          },
        });
      }
    } catch (err) {
      // Never leak — log and return the same shape.
      logger.warn({ err }, 'forgot-password: emit failed');
    }
    return { status: 'reset_email_sent' };
  }

  async function reset(input: ResetPasswordInput): Promise<{ status: 'password_reset' }> {
    const tokenRow = await authTokenRepo.findByRawToken(input.token, 'password_reset');
    if (!tokenRow) {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid reset token');
    }
    if (tokenRow.expiresAt.getTime() < clock.now().getTime()) {
      throw new AppError(ErrorCode.AUTH_TOKEN_EXPIRED, 'Reset link expired');
    }
    const claimed = await authTokenRepo.markUsed(tokenRow._id);
    if (!claimed) {
      // Already used → invalid.
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid reset token');
    }

    const newHash = await hashPassword(input.password);

    if (tokenRow.productId) {
      await productUserRepo.setPasswordHash(tokenRow.productId, tokenRow.userId, newHash);
    } else {
      await userRepo.setPasswordHash(tokenRow.userId, newHash);
    }

    // Revoke all sessions to invalidate any stolen access/refresh pairs.
    await sessionRepo.revokeAllForUser(tokenRow.userId, 'password_change');
    return { status: 'password_reset' };
  }

  return { request, reset };
}

export type PasswordResetService = ReturnType<typeof createPasswordResetService>;
