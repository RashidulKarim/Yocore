/**
 * Hosted Auth (PKCE) — Flow U.
 *
 * Surface area covered here is the *server-side* leg only — the hosted-UI in
 * `apps/auth-web` performs the actual sign-in and then calls `issueCode()`
 * to mint the one-time auth code. The relying-party SDK then calls
 * `exchange()` with the original `code_verifier`.
 *
 *   issueCode(): create an `authTokens` row of type `pkce_code` whose
 *                payload carries { codeChallenge, codeChallengeMethod,
 *                redirectUri, productId, userId }. TTL = 60s.
 *
 *   exchange(): consume the row, verify SHA256(code_verifier) ===
 *               codeChallenge, ensure redirectUri matches, then issue a
 *               brand new session via `auth.issueSession`.
 *
 * Multi-tenancy: codes are scoped to a specific (productId, userId).
 */
import crypto from 'node:crypto';
import { AppError, ErrorCode } from '../lib/errors.js';
import * as authTokenRepo from '../repos/auth-token.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import type { AuthService } from './auth.service.js';
import { systemClock, type Clock } from '../lib/clock.js';

const PKCE_CODE_TTL_SECONDS = 60;

export interface PkceServiceDeps {
  auth: AuthService;
  clock?: Clock;
}

export interface IssueCodeInput {
  userId: string;
  productId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export interface ExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  device: { ip: string | null; userAgent: string | null };
}

export interface ExchangeOutcome {
  userId: string;
  productId: string;
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    tokenType: 'Bearer';
  };
}

export function createPkceService(deps: PkceServiceDeps) {
  const clock = deps.clock ?? systemClock;

  async function issueCode(input: IssueCodeInput): Promise<{ code: string; expiresAt: Date }> {
    const product = await productRepo.findProductById(input.productId);
    if (!product || product.status !== 'ACTIVE') {
      throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
    }
    // Validate redirect URI against the product allowlist.
    const allow = (product.authConfig?.allowedRedirectUris ?? []).concat(
      product.allowedRedirectUris ?? [],
    );
    if (!allow.includes(input.redirectUri)) {
      throw new AppError(
        ErrorCode.AUTH_HOSTED_REDIRECT_NOT_ALLOWED,
        'redirect_uri not in product allowlist',
      );
    }
    const issued = await authTokenRepo.issueToken({
      userId: input.userId,
      productId: input.productId,
      type: 'pkce_code',
      ttlSeconds: PKCE_CODE_TTL_SECONDS,
      payload: {
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: input.codeChallengeMethod,
        redirectUri: input.redirectUri,
      },
    });
    return { code: issued.token, expiresAt: issued.expiresAt };
  }

  async function exchange(input: ExchangeInput): Promise<ExchangeOutcome> {
    const tokenRow = await authTokenRepo.findByRawToken(input.code, 'pkce_code');
    if (!tokenRow || !tokenRow.productId) {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid auth code');
    }
    if (tokenRow.expiresAt.getTime() < clock.now().getTime()) {
      throw new AppError(ErrorCode.AUTH_TOKEN_EXPIRED, 'Auth code expired');
    }
    const claimed = await authTokenRepo.markUsed(tokenRow._id);
    if (!claimed) {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Auth code already used');
    }
    const payload = (tokenRow.payload ?? {}) as {
      codeChallenge?: string;
      codeChallengeMethod?: string;
      redirectUri?: string;
    };
    if (
      !payload.codeChallenge ||
      payload.codeChallengeMethod !== 'S256' ||
      !payload.redirectUri
    ) {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Malformed auth code');
    }
    if (payload.redirectUri !== input.redirectUri) {
      throw new AppError(
        ErrorCode.AUTH_HOSTED_REDIRECT_NOT_ALLOWED,
        'redirect_uri mismatch',
      );
    }
    // S256: BASE64URL(SHA256(verifier)) === codeChallenge.
    const computed = crypto
      .createHash('sha256')
      .update(input.codeVerifier)
      .digest('base64url');
    const a = Buffer.from(computed, 'utf8');
    const b = Buffer.from(payload.codeChallenge, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new AppError(
        ErrorCode.AUTH_PKCE_VERIFIER_MISMATCH,
        'PKCE verifier mismatch',
      );
    }

    // Sanity: productUser must exist (defensive — issueCode would normally guarantee).
    const pu = await productUserRepo.findByUserAndProduct(tokenRow.productId, tokenRow.userId);
    if (!pu) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid auth code');

    const issued = await deps.auth.issueSession({
      userId: tokenRow.userId,
      role: 'END_USER',
      productId: tokenRow.productId,
      rememberMe: false,
      device: input.device,
    });
    return {
      userId: tokenRow.userId,
      productId: tokenRow.productId,
      tokens: issued.tokens,
    };
  }

  return { issueCode, exchange };
}

export type PkceService = ReturnType<typeof createPkceService>;
