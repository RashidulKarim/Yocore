/**
 * Email-change service — Flow P.
 *
 *   request():  authenticated user provides newEmail + current password.
 *               Issues an `email_change` token to the NEW address. Token
 *               payload carries { newEmail, currentEmail }. TTL = 1 hour.
 *
 *   confirm():  consumes the token, updates `users.email`, marks email
 *               verified, revokes ALL existing sessions for the user.
 *
 * Both legs are scoped to the global `users` collection — the email is the
 * only globally-unique identity, so a change has product-wide blast radius.
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import { verify as verifyPassword } from '../lib/password.js';
import * as authTokenRepo from '../repos/auth-token.repo.js';
import * as userRepo from '../repos/user.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as sessionRepo from '../repos/session.repo.js';
import * as emailQueueRepo from '../repos/email-queue.repo.js';
import { systemClock, type Clock } from '../lib/clock.js';

const EMAIL_CHANGE_TTL_SECONDS = 60 * 60;

export interface EmailChangeServiceDeps {
  defaultFromAddress: string;
  clock?: Clock;
}

export interface EmailChangeRequestInput {
  userId: string;
  productId: string | null;
  newEmail: string;
  password: string;
  ip: string | null;
}

export interface EmailChangeConfirmInput {
  token: string;
}

export function createEmailChangeService(deps: EmailChangeServiceDeps) {
  const clock = deps.clock ?? systemClock;

  async function request(input: EmailChangeRequestInput): Promise<{ status: 'email_change_requested' }> {
    const user = await userRepo.findUserById(input.userId);
    if (!user) throw new AppError(ErrorCode.USER_NOT_FOUND, 'User not found');

    // Re-auth: verify against the credential store appropriate for this session.
    let passwordHash: string | null = null;
    if (input.productId) {
      const pu = await productUserRepo.findByUserAndProduct(input.productId, input.userId);
      passwordHash = pu?.passwordHash ?? null;
    } else {
      passwordHash = user.passwordHash ?? null;
    }
    if (!passwordHash) {
      throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Re-authentication required');
    }
    const ok = await verifyPassword(passwordHash, input.password);
    if (!ok) {
      throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid credentials');
    }

    const normalized = input.newEmail.trim().toLowerCase();
    if (normalized === user.email) {
      throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Email is unchanged');
    }
    const collide = await userRepo.findUserByEmail(normalized);
    if (collide) {
      throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Email already in use');
    }

    const issued = await authTokenRepo.issueToken({
      userId: user._id,
      productId: input.productId,
      type: 'email_change',
      ttlSeconds: EMAIL_CHANGE_TTL_SECONDS,
      ip: input.ip,
      payload: { newEmail: normalized, oldEmail: user.email },
    });

    await emailQueueRepo.enqueueEmail({
      productId: input.productId,
      userId: user._id,
      toAddress: normalized,
      fromAddress: deps.defaultFromAddress,
      fromName: 'YoCore',
      subject: 'Confirm your new email address',
      templateId: 'auth.email_change_confirm',
      category: 'security',
      priority: 'critical',
      templateData: {
        confirmToken: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
        oldEmail: user.email,
        newEmail: normalized,
      },
    });
    return { status: 'email_change_requested' };
  }

  async function confirm(input: EmailChangeConfirmInput): Promise<{ status: 'email_changed'; newEmail: string }> {
    const tokenRow = await authTokenRepo.findByRawToken(input.token, 'email_change');
    if (!tokenRow) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid token');
    if (tokenRow.expiresAt.getTime() < clock.now().getTime()) {
      throw new AppError(ErrorCode.AUTH_TOKEN_EXPIRED, 'Email change link expired');
    }
    const claimed = await authTokenRepo.markUsed(tokenRow._id);
    if (!claimed) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid token');

    const payload = (tokenRow.payload ?? {}) as { newEmail?: string };
    if (!payload.newEmail) {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Malformed token');
    }

    // Re-check uniqueness right before the update — race-safety on a slow link.
    const collide = await userRepo.findUserByEmail(payload.newEmail);
    if (collide && collide._id !== tokenRow.userId) {
      throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Email already in use');
    }

    await userRepo.updateEmail(tokenRow.userId, payload.newEmail);
    await sessionRepo.revokeAllForUser(tokenRow.userId, 'password_change');
    return { status: 'email_changed', newEmail: payload.newEmail };
  }

  return { request, confirm };
}

export type EmailChangeService = ReturnType<typeof createEmailChangeService>;
