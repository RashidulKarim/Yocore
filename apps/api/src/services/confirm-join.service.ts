/**
 * Confirm-join service — Flow I.
 *
 * Consumes a `product_join_confirm` token issued during signup when the
 * email already exists as a global user but does NOT have a productUser row
 * for the requested product. The token payload carries the per-product
 * password hash (already Argon2id-hashed in the signup handler) so we don't
 * have to re-prompt the user.
 *
 * Behaviour:
 *   - 404/AUTH_INVALID_TOKEN when missing or wrong type.
 *   - 410 AUTH_TOKEN_EXPIRED when past expiry.
 *   - Idempotent re-click: if the token is used AND a productUser already
 *     exists, re-issue a session and return alreadyJoined:true.
 *   - First successful confirmation creates the productUser row, marks user
 *     emailVerified (cross-product join doesn't require a separate verify),
 *     activates the productUser, then issues a session.
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import * as authTokenRepo from '../repos/auth-token.repo.js';
import * as userRepo from '../repos/user.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import type { AuthService } from './auth.service.js';
import { systemClock, type Clock } from '../lib/clock.js';

export interface ConfirmJoinServiceDeps {
  auth: AuthService;
  clock?: Clock;
}

export interface ConfirmJoinInput {
  token: string;
  device: { ip: string | null; userAgent: string | null };
}

export interface ConfirmJoinOutcome {
  alreadyJoined: boolean;
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

interface JoinTokenPayload {
  passwordHash: string;
  name?: { first?: string | null; last?: string | null } | undefined;
  marketingOptIn?: boolean;
}

export function createConfirmJoinService(deps: ConfirmJoinServiceDeps) {
  const clock = deps.clock ?? systemClock;

  async function confirmJoin(input: ConfirmJoinInput): Promise<ConfirmJoinOutcome> {
    const tokenRow = await authTokenRepo.findByRawToken(input.token, 'product_join_confirm');
    if (!tokenRow || !tokenRow.productId) {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid join token');
    }
    if (tokenRow.expiresAt.getTime() < clock.now().getTime()) {
      throw new AppError(ErrorCode.AUTH_TOKEN_EXPIRED, 'Join link expired');
    }

    const productId = tokenRow.productId;
    const userId = tokenRow.userId;

    // Branch A — already used (idempotent re-click).
    if (tokenRow.usedAt) {
      const pu = await productUserRepo.findByUserAndProduct(productId, userId);
      if (!pu) {
        throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid join token');
      }
      const issued = await deps.auth.issueSession({
        userId,
        role: 'END_USER',
        productId,
        rememberMe: false,
        device: input.device,
      });
      return {
        alreadyJoined: true,
        userId,
        productId,
        onboarded: pu.onboarded ?? false,
        tokens: issued.tokens,
      };
    }

    // Branch B — first confirmation.
    const claimed = await authTokenRepo.markUsed(tokenRow._id);
    if (!claimed) {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid join token');
    }

    const payload = (tokenRow.payload ?? {}) as Partial<JoinTokenPayload>;
    if (!payload.passwordHash) {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Malformed join token');
    }

    // Email is globally verified once (the user already verified for product A).
    await userRepo.markEmailVerified(userId, 'email_link');

    // Create the productUser row only if one wasn't created racy elsewhere.
    const existing = await productUserRepo.findByUserAndProduct(productId, userId);
    if (!existing) {
      await productUserRepo.createProductUser({
        productId,
        userId,
        passwordHash: payload.passwordHash,
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        marketingOptIn: payload.marketingOptIn ?? false,
      });
    }
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
      alreadyJoined: false,
      userId,
      productId,
      onboarded: pu?.onboarded ?? false,
      tokens: issued.tokens,
    };
  }

  return { confirmJoin };
}

export type ConfirmJoinService = ReturnType<typeof createConfirmJoinService>;
