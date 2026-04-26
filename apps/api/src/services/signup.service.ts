/**
 * Signup service — Flow F (end-user first signup).
 *
 * Constant-time response (FIX-AUTH-TIMING):
 *   - Always run a single Argon2 password hash, regardless of branch.
 *   - Always return `{ status: 'verification_sent' }` on the success path,
 *     so an attacker cannot enumerate existing accounts via response shape
 *     or response time.
 *   - The only distinguishable error is `NOT_FOUND` when the product slug
 *     itself is invalid — product slugs are public, so no enumeration risk.
 *
 * Branches:
 *   1. New global user      → create users + productUsers + email_verify token + queue email.
 *   2. Existing user, no productUser yet (cross-product join, Flow I)
 *                           → NOT created here; Flow I owns this. We still
 *                              hash for timing parity and return the same
 *                              response. The user will see no email; this is
 *                              acceptable until Flow I lands.
 *   3. Existing user + existing productUser
 *                           → no DB writes, hash for timing, same response.
 *
 * Audit + email are emitted only on branch 1 (real creation).
 */
import type { Clock } from '../lib/clock.js';
import { systemClock } from '../lib/clock.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { hash as hashPassword } from '../lib/password.js';
import { logger } from '../lib/logger.js';
import * as productRepo from '../repos/product.repo.js';
import * as userRepo from '../repos/user.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as authTokenRepo from '../repos/auth-token.repo.js';
import * as emailQueueRepo from '../repos/email-queue.repo.js';

/** 24 hours, per Flow F (`expiresAt:now+24h`). */
const EMAIL_VERIFY_TTL_SECONDS = 24 * 60 * 60;

export interface SignupServiceDeps {
  clock?: Clock;
  /** Default sender if the product has no `settings.fromEmail` configured. */
  defaultFromAddress: string;
}

export interface SignupInput {
  email: string;
  password: string;
  productSlug: string;
  name?: { first?: string | undefined; last?: string | undefined } | undefined;
  marketingOptIn?: boolean | undefined;
  ip: string | null;
}

export interface SignupOutcome {
  status: 'verification_sent';
  /** Set only on real creation (branch 1) — used by the handler for audit log scoping. */
  created?: {
    productId: string;
    userId: string;
  };
}

export function createSignupService(deps: SignupServiceDeps) {
  const clock = deps.clock ?? systemClock;

  async function signup(input: SignupInput): Promise<SignupOutcome> {
    // 1) Resolve product by slug.
    const product = await productRepo.findProductBySlug(input.productSlug);
    if (!product || product.status !== 'ACTIVE') {
      // Always hash to keep timing comparable to the success path.
      await hashPassword(input.password);
      throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
    }

    // 2) Argon2 hash — runs in every remaining branch (FIX-AUTH-TIMING).
    const passwordHash = await hashPassword(input.password);

    // 3) Look up global user.
    const existing = await userRepo.findUserByEmail(input.email);

    if (existing) {
      // Existing global user — Flow I cross-product join path.
      const existingPu = await productUserRepo.findByUserAndProduct(product._id, existing._id);
      if (existingPu) {
        // Branch 3 — already a member of this product. No state change.
        // Logging at debug; client gets the same response shape.
        logger.debug(
          { userId: existing._id, productId: product._id },
          'signup: user already a product member',
        );
        return { status: 'verification_sent' };
      }

      // Branch 2 — global user exists, no productUser yet → issue a
      // `product_join_confirm` token whose payload carries the freshly hashed
      // password (so we don't need to re-prompt on confirmation).
      const issued = await authTokenRepo.issueToken({
        userId: existing._id,
        productId: product._id,
        type: 'product_join_confirm',
        ttlSeconds: EMAIL_VERIFY_TTL_SECONDS,
        ip: input.ip,
        payload: {
          passwordHash,
          ...(input.name !== undefined ? { name: input.name } : {}),
          marketingOptIn: input.marketingOptIn ?? false,
        },
      });

      const fromAddress = product.settings?.fromEmail ?? deps.defaultFromAddress;
      const fromName = product.settings?.fromName ?? product.name;
      await emailQueueRepo.enqueueEmail({
        productId: product._id,
        userId: existing._id,
        toAddress: input.email,
        fromAddress,
        fromName,
        subject: `Confirm joining ${product.name}`,
        templateId: 'auth.product_join_confirm',
        category: 'security',
        priority: 'critical',
        templateData: {
          productSlug: product.slug,
          productName: product.name,
          joinToken: issued.token,
          expiresAt: issued.expiresAt.toISOString(),
          firstName: input.name?.first ?? null,
        },
      });

      return {
        status: 'verification_sent',
        created: { productId: product._id, userId: existing._id },
      };
    }

    // Branch 1 — brand-new user.
    const now = clock.now();
    const user = await userRepo.createUser({
      email: input.email,
      passwordHash: null, // END_USERs keep credentials in productUsers, not users.
      role: 'END_USER',
      emailVerified: false,
      emailVerifiedMethod: null,
    });

    await productUserRepo.createProductUser({
      productId: product._id,
      userId: user._id,
      passwordHash,
      ...(input.name !== undefined ? { name: input.name } : {}),
      marketingOptIn: input.marketingOptIn ?? false,
    });

    const issued = await authTokenRepo.issueToken({
      userId: user._id,
      productId: product._id,
      type: 'email_verify',
      ttlSeconds: EMAIL_VERIFY_TTL_SECONDS,
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
      subject: `Verify your email for ${product.name}`,
      templateId: 'auth.email_verify',
      category: 'security',
      priority: 'critical',
      templateData: {
        productSlug: product.slug,
        productName: product.name,
        verifyToken: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
        firstName: input.name?.first ?? null,
      },
    });

    void now;
    return {
      status: 'verification_sent',
      created: { productId: product._id, userId: user._id },
    };
  }

  return { signup };
}

export type SignupService = ReturnType<typeof createSignupService>;
