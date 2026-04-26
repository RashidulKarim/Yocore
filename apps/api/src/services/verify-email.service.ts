/**
 * Verify-email service — Flow F10 (mark email verified) + F11 (auto-login).
 *
 * Behaviour:
 *   - Look up the auth_token by raw token (sha256-hashed in storage).
 *   - 404 NOT_FOUND when missing or wrong type.
 *   - 410 AUTH_TOKEN_EXPIRED when past expiry.
 *   - Idempotent re-click after success: when the token is already used AND
 *     the user is already verified → still issue a fresh session and return
 *     `alreadyVerified:true` (matches Sys-Design Flow F error-paths note).
 *     A used token whose user is NOT verified is treated as invalid (401).
 *   - On the first successful verification: mark token used, mark user
 *     emailVerified, flip productUser status UNVERIFIED → ACTIVE, then issue
 *     a brand-new session (refresh family + JWT) — F11.
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import * as authTokenRepo from '../repos/auth-token.repo.js';
import * as userRepo from '../repos/user.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import type { AuthService } from './auth.service.js';
import { systemClock, type Clock } from '../lib/clock.js';

export interface VerifyEmailServiceDeps {
  auth: AuthService;
  clock?: Clock;
}

export interface VerifyEmailInput {
  token: string;
  device: { ip: string | null; userAgent: string | null };
}

export interface VerifyEmailOutcome {
  alreadyVerified: boolean;
  userId: string;
  productId: string;
  onboarded: boolean;
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    tokenType: 'Bearer';
  };
}

export function createVerifyEmailService(deps: VerifyEmailServiceDeps) {
  const clock = deps.clock ?? systemClock;

  async function verifyEmail(input: VerifyEmailInput): Promise<VerifyEmailOutcome> {
    const tokenRow = await authTokenRepo.findByRawToken(input.token, 'email_verify');
    if (!tokenRow || !tokenRow.productId) {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid verification token');
    }
    if (tokenRow.expiresAt.getTime() < clock.now().getTime()) {
      throw new AppError(ErrorCode.AUTH_TOKEN_EXPIRED, 'Verification link expired');
    }

    const productId = tokenRow.productId;
    const userId = tokenRow.userId;

    // Branch A — token already used. Allow idempotent re-click ONLY when the
    // user's email is in fact verified; otherwise the token is suspicious.
    if (tokenRow.usedAt) {
      const u = await userRepo.findUserById(userId);
      if (!u || !u.emailVerified) {
        throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid verification token');
      }
      const pu = await productUserRepo.findByUserAndProduct(productId, userId);
      const tokens = await deps.auth.issueSession({
        userId,
        role: 'END_USER',
        productId,
        rememberMe: false,
        device: input.device,
      });
      return {
        alreadyVerified: true,
        userId,
        productId,
        onboarded: pu?.onboarded ?? false,
        tokens: tokens.tokens,
      };
    }

    // Branch B — first successful verification. Atomic single-use mark.
    const claimed = await authTokenRepo.markUsed(tokenRow._id);
    if (!claimed) {
      // Lost a race with a concurrent request — treat as invalid.
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid verification token');
    }

    await userRepo.markEmailVerified(userId, 'email_link');
    await productUserRepo.activate(productId, userId);

    const pu = await productUserRepo.findByUserAndProduct(productId, userId);
    const issued = await deps.auth.issueSession({
      userId,
      role: 'END_USER',
      productId,
      rememberMe: false,
      device: input.device,
    });

    return {
      alreadyVerified: false,
      userId,
      productId,
      onboarded: pu?.onboarded ?? false,
      tokens: issued.tokens,
    };
  }

  return { verifyEmail };
}

export type VerifyEmailService = ReturnType<typeof createVerifyEmailService>;
