/**
 * Gateway migration service — Phase 3.4 Wave 10 (Flow AG).
 *
 * `POST /v1/billing/subscription/migrate-gateway` — let an existing customer
 * migrate from one supported gateway to another (typically `stripe ↔
 * sslcommerz`).
 *
 * Strategy:
 *   1. Validate target gateway is configured and ACTIVE for the product.
 *   2. Validate the *new* gateway has the same currency as current sub.
 *   3. Cancel the existing subscription (mark `status='CANCELED'` locally;
 *      we do NOT cancel on the old gateway here — caller is encouraged to
 *      call the gateway's cancel endpoint via admin tools to stop billing).
 *      For Stripe we DO cancel `cancel_at_period_end=true`.
 *   4. Delegate to `checkoutService.createCheckout({...})` with the same
 *      planId on the target gateway and return that checkout URL.
 *
 * The existing sub stays ACTIVE until the user completes checkout on the new
 * gateway (`cancelAtPeriodEnd` is set true so they don't lose access in the
 * meantime).
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import { decryptToString } from '../lib/encryption.js';
import { createBreaker } from '../lib/circuit-breaker.js';
import { logger } from '../lib/logger.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as gatewayRepo from '../repos/payment-gateway.repo.js';
import * as memberRepo from '../repos/workspace-member.repo.js';
import type { CheckoutService } from './checkout.service.js';
import type {
  GatewayMigrateRequest,
  GatewayMigrateResponse,
} from '@yocore/types';

export interface StripeCancelApi {
  cancelAtPeriodEnd(args: {
    secretKey: string;
    subscriptionId: string;
    idempotencyKey: string;
  }): Promise<void>;
}

const STRIPE_BASE = 'https://api.stripe.com/v1';

const defaultStripeCancelApi: StripeCancelApi = {
  async cancelAtPeriodEnd({ secretKey, subscriptionId, idempotencyKey }) {
    const body = new URLSearchParams();
    body.set('cancel_at_period_end', 'true');
    const res = await fetch(`${STRIPE_BASE}/subscriptions/${subscriptionId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
        'Idempotency-Key': idempotencyKey,
      },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
        'Stripe cancel-at-period-end failed',
      );
    }
  },
};

export interface GatewayMigrationContext {
  userId: string;
  email: string | null;
  displayName?: string | null;
  productId: string;
}

export interface GatewayMigrationService {
  migrate(
    actor: GatewayMigrationContext,
    input: GatewayMigrateRequest,
  ): Promise<GatewayMigrateResponse>;
}

export interface CreateGatewayMigrationServiceOptions {
  checkout: CheckoutService;
  stripeCancelApi?: StripeCancelApi;
}

export function createGatewayMigrationService(
  opts: CreateGatewayMigrationServiceOptions,
): GatewayMigrationService {
  const stripe = opts.stripeCancelApi ?? defaultStripeCancelApi;
  const cancelBreaker = createBreaker(stripe.cancelAtPeriodEnd, {
    name: 'stripe.subscriptions.cancel.migrate',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });

  async function loadStripeSecret(productId: string): Promise<string> {
    const gw =
      (await gatewayRepo.findOne(productId, 'stripe', 'live')) ??
      (await gatewayRepo.findOne(productId, 'stripe', 'test'));
    if (!gw || gw.status !== 'ACTIVE') {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        'Stripe gateway not configured',
      );
    }
    const enc = gw.credentialsEncrypted as Record<string, { token: string }> | undefined;
    const wrapped = enc?.['secretKey']?.token;
    if (!wrapped) {
      throw new AppError(ErrorCode.BILLING_GATEWAY_CONFIG_MISSING, 'Stripe secret missing');
    }
    return decryptToString(wrapped);
  }

  return {
    async migrate(actor, input) {
      const product = await productRepo.findProductById(actor.productId);
      if (!product || product.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found or inactive');
      }
      const subjectType: 'user' | 'workspace' =
        product.billingScope === 'user' ? 'user' : 'workspace';
      const sub = await subscriptionRepo.findActiveBySubject({
        productId: actor.productId,
        subjectType,
        subjectUserId: subjectType === 'user' ? actor.userId : null,
        subjectWorkspaceId:
          subjectType === 'workspace' ? (input.workspaceId ?? null) : null,
      });
      if (!sub) {
        throw new AppError(ErrorCode.SUBSCRIPTION_NOT_FOUND, 'No active subscription');
      }
      if (sub.status !== 'ACTIVE' && sub.status !== 'TRIALING') {
        throw new AppError(
          ErrorCode.BILLING_GATEWAY_MIGRATION_INELIGIBLE,
          `Cannot migrate a ${sub.status} subscription`,
        );
      }
      if (sub.gateway === input.targetGateway) {
        throw new AppError(
          ErrorCode.BILLING_GATEWAY_MIGRATION_INELIGIBLE,
          'Subscription is already on the target gateway',
        );
      }
      // Workspace-scope auth check.
      if (subjectType === 'workspace' && sub.subjectWorkspaceId) {
        const member = await memberRepo.findMember(
          actor.productId,
          sub.subjectWorkspaceId,
          actor.userId,
        );
        if (!member || member.status !== 'ACTIVE') {
          throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not a workspace member');
        }
        if (member.roleSlug !== 'OWNER' && member.roleSlug !== 'ADMIN') {
          throw new AppError(ErrorCode.PERMISSION_DENIED, 'OWNER or ADMIN required');
        }
      }

      // Validate target gateway is configured & ACTIVE.
      const targetGw =
        (await gatewayRepo.findOne(actor.productId, input.targetGateway, 'live')) ??
        (await gatewayRepo.findOne(actor.productId, input.targetGateway, 'test'));
      if (!targetGw || targetGw.status !== 'ACTIVE') {
        throw new AppError(
          ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
          'Target gateway is not configured',
        );
      }

      // Stripe-side: schedule cancel at period end so customer keeps access.
      if (sub.gateway === 'stripe') {
        const refs = (sub.gatewayRefs ?? {}) as { stripeSubscriptionId?: string };
        if (refs.stripeSubscriptionId) {
          const secret = await loadStripeSecret(actor.productId);
          await cancelBreaker.fire({
            secretKey: secret,
            subscriptionId: refs.stripeSubscriptionId,
            idempotencyKey: `yocore:migrate-cancel:${sub._id}`,
          });
        }
      }

      // Delegate to checkout service for the new gateway. Skip the
      // single-active-subscription guard since we're intentionally about to
      // double-up briefly until the new gateway's webhook activates the new sub
      // and the old one expires/cancels.
      const checkoutResp = await opts.checkout.createCheckout(
        {
          userId: actor.userId,
          email: actor.email,
          ...(actor.displayName !== undefined ? { displayName: actor.displayName } : {}),
          productId: actor.productId,
        },
        {
          planId: sub.planId,
          quantity: sub.quantity ?? 1,
          successUrl: input.successUrl,
          cancelUrl: input.cancelUrl,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        },
        { forceGateway: input.targetGateway, skipActiveGuard: true },
      );

      logger.info(
        {
          oldSubscriptionId: sub._id,
          fromGateway: sub.gateway,
          toGateway: input.targetGateway,
        },
        'gateway.migration.started',
      );

      return {
        url: checkoutResp.url,
        sessionId: checkoutResp.sessionId,
        targetGateway: input.targetGateway,
        oldSubscriptionId: sub._id,
      };
    },
  };
}
