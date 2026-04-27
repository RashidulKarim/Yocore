/**
 * Seat-change service — Phase 3.4 Wave 6 (Flow S).
 *
 * `POST /v1/billing/subscription/seats` — change a workspace subscription's
 * seat count (`quantity` on the gateway sub item).
 *
 * Gateway dispatch (mirrors change-plan.service):
 *   - **Stripe** → `subscriptions.update({items:[{id, quantity}]},
 *     proration_behavior:'create_prorations')`. Persist `quantity` + push
 *     `seat_change` history. Enqueue `subscription.seats_changed`.
 *   - **SSLCommerz** → schedule for next renewal (gateway has no mid-cycle
 *     proration). Persists `pendingPlanChange`-like blob via
 *     `applySeatChange` history only (live qty unchanged until rebill).
 *   - **TRIALING / null gateway** → DB-only swap.
 *
 * Seat-overflow is the *opposite* of change-plan: we set the new quantity,
 * so the only validation is `1 ≤ quantity ≤ plan.limits.maxMembers` (when
 * a cap is set). Decreases below current active member count are blocked
 * with `BILLING_PLAN_MEMBER_OVERFLOW`.
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import { decryptToString } from '../lib/encryption.js';
import { createBreaker } from '../lib/circuit-breaker.js';
import { logger } from '../lib/logger.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';
import * as planRepo from '../repos/billing-plan.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as gatewayRepo from '../repos/payment-gateway.repo.js';
import * as memberRepo from '../repos/workspace-member.repo.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import type {
  ChangeSeatsRequest,
  ChangeSeatsResponse,
  SubscriptionSummary,
} from '@yocore/types';

export interface StripeSeatApi {
  retrieveSubscription(args: {
    secretKey: string;
    subscriptionId: string;
  }): Promise<{
    items: Array<{ id: string; quantity: number; priceId: string }>;
    currentPeriodEnd: number;
  }>;
  updateSubscriptionQuantity(args: {
    secretKey: string;
    subscriptionId: string;
    subscriptionItemId: string;
    quantity: number;
    idempotencyKey: string;
  }): Promise<{ currentPeriodEnd: number }>;
}

const STRIPE_BASE = 'https://api.stripe.com/v1';

const defaultStripeSeatApi: StripeSeatApi = {
  async retrieveSubscription({ secretKey, subscriptionId }) {
    const res = await fetch(`${STRIPE_BASE}/subscriptions/${subscriptionId}`, {
      headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': '2024-06-20' },
    });
    if (!res.ok) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
        'Stripe subscriptions.retrieve failed',
      );
    }
    const j = (await res.json()) as {
      current_period_end: number;
      items: { data: Array<{ id: string; quantity?: number; price: { id: string } }> };
    };
    return {
      currentPeriodEnd: j.current_period_end,
      items: j.items.data.map((i) => ({
        id: i.id,
        quantity: i.quantity ?? 1,
        priceId: i.price.id,
      })),
    };
  },
  async updateSubscriptionQuantity({
    secretKey,
    subscriptionId,
    subscriptionItemId,
    quantity,
    idempotencyKey,
  }) {
    const body = new URLSearchParams();
    body.set('items[0][id]', subscriptionItemId);
    body.set('items[0][quantity]', String(quantity));
    body.set('proration_behavior', 'create_prorations');
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
        'Stripe subscriptions.update (seats) failed',
      );
    }
    const j = (await res.json()) as { current_period_end: number };
    return { currentPeriodEnd: j.current_period_end };
  },
};

export interface SeatChangeContext {
  userId: string;
  productId: string;
}

export interface SeatChangeService {
  changeSeats(actor: SeatChangeContext, input: ChangeSeatsRequest): Promise<ChangeSeatsResponse>;
}

export interface CreateSeatChangeServiceOptions {
  stripeSeatApi?: StripeSeatApi;
}

export function createSeatChangeService(
  opts: CreateSeatChangeServiceOptions = {},
): SeatChangeService {
  const stripe = opts.stripeSeatApi ?? defaultStripeSeatApi;
  const stripeRetrieve = createBreaker(stripe.retrieveSubscription, {
    name: 'stripe.subscriptions.retrieve.seats',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });
  const stripeUpdateQty = createBreaker(stripe.updateSubscriptionQuantity, {
    name: 'stripe.subscriptions.update.seats',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });

  function toSummary(s: subscriptionRepo.SubscriptionLean): SubscriptionSummary {
    const created = (s as { createdAt?: Date }).createdAt ?? new Date();
    const updated = (s as { updatedAt?: Date }).updatedAt ?? created;
    return {
      id: s._id,
      productId: s.productId,
      planId: s.planId,
      subjectType: s.subjectType,
      subjectUserId: s.subjectUserId ?? null,
      subjectWorkspaceId: s.subjectWorkspaceId ?? null,
      gateway: (s.gateway ?? null) as SubscriptionSummary['gateway'],
      status: s.status as SubscriptionSummary['status'],
      amount: s.amount ?? 0,
      currency: s.currency ?? 'usd',
      quantity: s.quantity ?? 1,
      currentPeriodStart: s.currentPeriodStart
        ? new Date(s.currentPeriodStart).toISOString()
        : null,
      currentPeriodEnd: s.currentPeriodEnd
        ? new Date(s.currentPeriodEnd).toISOString()
        : null,
      trialEndsAt: s.trialEndsAt ? new Date(s.trialEndsAt).toISOString() : null,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd ?? false,
      createdAt: new Date(created).toISOString(),
      updatedAt: new Date(updated).toISOString(),
    };
  }

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
    async changeSeats(actor, input) {
      const product = await productRepo.findProductById(actor.productId);
      if (!product || product.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found or inactive');
      }
      const subjectType: 'user' | 'workspace' =
        product.billingScope === 'user' ? 'user' : 'workspace';
      if (subjectType !== 'workspace') {
        throw new AppError(
          ErrorCode.BILLING_SEAT_INVALID,
          'Seat changes are only supported on workspace-scoped subscriptions',
        );
      }
      if (!input.workspaceId) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'workspaceId required for workspace-scoped products',
          { field: 'workspaceId' },
        );
      }

      const sub = await subscriptionRepo.findActiveBySubject({
        productId: actor.productId,
        subjectType: 'workspace',
        subjectWorkspaceId: input.workspaceId,
      });
      if (!sub) {
        throw new AppError(ErrorCode.SUBSCRIPTION_NOT_FOUND, 'No active subscription');
      }
      if (!['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(sub.status)) {
        throw new AppError(
          ErrorCode.BILLING_SUBSCRIPTION_NOT_ACTIVE,
          `Cannot change seats on a ${sub.status} subscription`,
        );
      }

      // Authorization: workspace OWNER or ADMIN.
      const member = await memberRepo.findMember(
        actor.productId,
        input.workspaceId,
        actor.userId,
      );
      if (!member || member.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not a workspace member');
      }
      if (member.roleSlug !== 'OWNER' && member.roleSlug !== 'ADMIN') {
        throw new AppError(ErrorCode.PERMISSION_DENIED, 'OWNER or ADMIN required');
      }

      const plan = await planRepo.findPlanById(actor.productId, sub.planId);
      if (!plan) throw new AppError(ErrorCode.PLAN_NOT_FOUND, 'Plan not found');

      // Plan-cap check.
      const limits = (plan.limits ?? {}) as { maxMembers?: number };
      if (typeof limits.maxMembers === 'number' && limits.maxMembers >= 0) {
        if (input.quantity > limits.maxMembers) {
          throw new AppError(
            ErrorCode.BILLING_PLAN_MEMBER_OVERFLOW,
            'Quantity exceeds plan member cap',
            { allowedMembers: limits.maxMembers, requestedSeats: input.quantity },
          );
        }
      }

      // Decrease below current active members blocked.
      const currentMembers = await memberRepo.countActive(
        actor.productId,
        input.workspaceId,
      );
      if (input.quantity < currentMembers) {
        throw new AppError(
          ErrorCode.BILLING_PLAN_MEMBER_OVERFLOW,
          'Cannot reduce seats below current active members',
          {
            currentMembers,
            requestedSeats: input.quantity,
            mustRemove: currentMembers - input.quantity,
          },
        );
      }

      if (input.quantity === (sub.quantity ?? 1)) {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          'Subscription already has this quantity',
        );
      }

      const beforeMeta = { quantity: sub.quantity ?? 1 };
      const afterMeta = { quantity: input.quantity };

      // ── Stripe path ─────────────────────────────────────────────
      if (sub.gateway === 'stripe') {
        const refs = (sub.gatewayRefs ?? {}) as { stripeSubscriptionId?: string };
        const stripeSubId = refs.stripeSubscriptionId;
        if (!stripeSubId) {
          throw new AppError(
            ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
            'Stripe subscription id missing',
          );
        }
        const secret = await loadStripeSecret(actor.productId);
        const stripeSub = await stripeRetrieve.fire({
          secretKey: secret,
          subscriptionId: stripeSubId,
        });
        const item = stripeSub.items[0];
        if (!item) {
          throw new AppError(
            ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
            'Stripe subscription has no items',
          );
        }
        const idemKey = `yocore:seats:${sub._id}:${input.quantity}`;
        const result = await stripeUpdateQty.fire({
          secretKey: secret,
          subscriptionId: stripeSubId,
          subscriptionItemId: item.id,
          quantity: input.quantity,
          idempotencyKey: idemKey,
        });
        const updated = await subscriptionRepo.applySeatChange({
          productId: actor.productId,
          subscriptionId: sub._id,
          newQuantity: input.quantity,
          history: {
            changedAt: new Date(),
            changedBy: actor.userId,
            type: 'plan_change',
            before: beforeMeta,
            after: afterMeta,
            reason: 'user_seat_change',
          },
        });
        if (!updated) {
          throw new AppError(
            ErrorCode.SUBSCRIPTION_NOT_FOUND,
            'Subscription disappeared during update',
          );
        }
        await emitWebhook(product, 'subscription.seats_changed', updated._id);
        logger.info(
          { subscriptionId: updated._id, quantity: input.quantity },
          'seats.applied.stripe',
        );
        const summary = toSummary(updated);
        if (result.currentPeriodEnd) {
          summary.currentPeriodEnd = new Date(result.currentPeriodEnd * 1000).toISOString();
        }
        return {
          subscription: summary,
          scheduled: false,
          effectiveAt: new Date().toISOString(),
          prorationAmount: 0,
          currency: sub.currency ?? 'usd',
        };
      }

      // ── SSLCommerz / TRIALING / null gateway: DB swap only ─────
      const updated = await subscriptionRepo.applySeatChange({
        productId: actor.productId,
        subscriptionId: sub._id,
        newQuantity: input.quantity,
        history: {
          changedAt: new Date(),
          changedBy: actor.userId,
          type: 'plan_change',
          before: beforeMeta,
          after: afterMeta,
          reason:
            sub.gateway === 'sslcommerz' ? 'user_seat_change_sslc' : 'user_seat_change_trial',
        },
      });
      if (!updated) {
        throw new AppError(
          ErrorCode.SUBSCRIPTION_NOT_FOUND,
          'Subscription disappeared during update',
        );
      }
      await emitWebhook(product, 'subscription.seats_changed', updated._id);
      return {
        subscription: toSummary(updated),
        scheduled: sub.gateway === 'sslcommerz',
        effectiveAt: new Date().toISOString(),
        prorationAmount: 0,
        currency: sub.currency ?? 'usd',
      };
    },
  };
}

async function emitWebhook(
  product: productRepo.ProductLean,
  event: string,
  subscriptionId: string,
): Promise<void> {
  if (!product.webhookUrl) return;
  await deliveryRepo
    .enqueueDelivery({
      productId: product._id,
      event,
      eventId: `evt_seats_${subscriptionId}_${Date.now()}`,
      url: product.webhookUrl,
      payloadRef: subscriptionId,
    })
    .catch(() => undefined);
}
