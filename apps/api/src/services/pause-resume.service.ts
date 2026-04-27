/**
 * Pause / Resume service — Phase 3.4 Wave 7 (Flow AC).
 *
 * `POST /v1/billing/subscription/pause`  — pause an ACTIVE/PAST_DUE sub.
 * `POST /v1/billing/subscription/resume` — resume a PAUSED sub.
 *
 * Stripe path:
 *   - pause → POST /v1/subscriptions/:id with `pause_collection[behavior]=
 *     mark_uncollectible` (and optional `resumes_at`).
 *   - resume → POST same endpoint with `pause_collection=` (empty string).
 *
 * SSLCommerz / null-gateway: DB-only state flip (manual unpaused subs).
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import { decryptToString } from '../lib/encryption.js';
import { createBreaker } from '../lib/circuit-breaker.js';
import { logger } from '../lib/logger.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as gatewayRepo from '../repos/payment-gateway.repo.js';
import * as memberRepo from '../repos/workspace-member.repo.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import type {
  PauseSubscriptionRequest,
  ResumeSubscriptionRequest,
  PauseResumeResponse,
  SubscriptionSummary,
} from '@yocore/types';

export interface StripePauseApi {
  pauseSubscription(args: {
    secretKey: string;
    subscriptionId: string;
    resumesAt?: number;
    idempotencyKey: string;
  }): Promise<{ status: string }>;
  resumeSubscription(args: {
    secretKey: string;
    subscriptionId: string;
    idempotencyKey: string;
  }): Promise<{ status: string }>;
}

const STRIPE_BASE = 'https://api.stripe.com/v1';

const defaultStripePauseApi: StripePauseApi = {
  async pauseSubscription({ secretKey, subscriptionId, resumesAt, idempotencyKey }) {
    const body = new URLSearchParams();
    body.set('pause_collection[behavior]', 'mark_uncollectible');
    if (resumesAt) body.set('pause_collection[resumes_at]', String(resumesAt));
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
        'Stripe pause failed',
      );
    }
    const j = (await res.json()) as { status: string };
    return j;
  },
  async resumeSubscription({ secretKey, subscriptionId, idempotencyKey }) {
    const body = new URLSearchParams();
    body.set('pause_collection', '');
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
        'Stripe resume failed',
      );
    }
    return (await res.json()) as { status: string };
  },
};

export interface PauseResumeContext {
  userId: string;
  productId: string;
}

export interface PauseResumeService {
  pause(actor: PauseResumeContext, input: PauseSubscriptionRequest): Promise<PauseResumeResponse>;
  resume(actor: PauseResumeContext, input: ResumeSubscriptionRequest): Promise<PauseResumeResponse>;
}

export interface CreatePauseResumeServiceOptions {
  stripePauseApi?: StripePauseApi;
}

export function createPauseResumeService(
  opts: CreatePauseResumeServiceOptions = {},
): PauseResumeService {
  const stripe = opts.stripePauseApi ?? defaultStripePauseApi;
  const stripePause = createBreaker(stripe.pauseSubscription, {
    name: 'stripe.subscriptions.pause',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });
  const stripeResume = createBreaker(stripe.resumeSubscription, {
    name: 'stripe.subscriptions.resume',
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

  async function resolveSub(
    actor: PauseResumeContext,
    workspaceId: string | undefined,
  ): Promise<{
    sub: subscriptionRepo.SubscriptionLean;
    product: productRepo.ProductLean;
  }> {
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
      subjectWorkspaceId: subjectType === 'workspace' ? (workspaceId ?? null) : null,
    });
    if (!sub) {
      throw new AppError(ErrorCode.SUBSCRIPTION_NOT_FOUND, 'No active subscription');
    }
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
    } else if (subjectType === 'user' && sub.subjectUserId !== actor.userId) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not your subscription');
    }
    return { sub, product };
  }

  return {
    async pause(actor, input) {
      const { sub, product } = await resolveSub(actor, input.workspaceId);
      if (sub.status === 'PAUSED') {
        throw new AppError(
          ErrorCode.BILLING_SUBSCRIPTION_PAUSED,
          'Subscription is already paused',
        );
      }
      if (!['ACTIVE', 'PAST_DUE'].includes(sub.status)) {
        throw new AppError(
          ErrorCode.BILLING_SUBSCRIPTION_NOT_ACTIVE,
          `Cannot pause a ${sub.status} subscription`,
        );
      }
      const resumeAt = input.resumeAt ? new Date(input.resumeAt) : null;

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
        await stripePause.fire({
          secretKey: secret,
          subscriptionId: stripeSubId,
          ...(resumeAt ? { resumesAt: Math.floor(resumeAt.getTime() / 1000) } : {}),
          idempotencyKey: `yocore:pause:${sub._id}:${Date.now()}`,
        });
      }

      const updated = await subscriptionRepo.pauseSubscription({
        productId: actor.productId,
        subscriptionId: sub._id,
        pausedAt: new Date(),
        resumeAt,
        reason: input.reason ?? null,
      });
      if (!updated) {
        throw new AppError(
          ErrorCode.BILLING_SUBSCRIPTION_NOT_ACTIVE,
          'Subscription could not be paused',
        );
      }
      await emitWebhook(product, 'subscription.paused', updated._id);
      logger.info({ subscriptionId: sub._id, gateway: sub.gateway }, 'subscription.paused');
      return { subscription: toSummary(updated) };
    },

    async resume(actor, input) {
      const { sub, product } = await resolveSub(actor, input.workspaceId);
      if (sub.status !== 'PAUSED') {
        throw new AppError(
          ErrorCode.BILLING_SUBSCRIPTION_NOT_PAUSED,
          'Subscription is not paused',
        );
      }

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
        await stripeResume.fire({
          secretKey: secret,
          subscriptionId: stripeSubId,
          idempotencyKey: `yocore:resume:${sub._id}:${Date.now()}`,
        });
      }

      const updated = await subscriptionRepo.resumeSubscription({
        productId: actor.productId,
        subscriptionId: sub._id,
      });
      if (!updated) {
        throw new AppError(
          ErrorCode.BILLING_SUBSCRIPTION_NOT_PAUSED,
          'Subscription could not be resumed',
        );
      }
      await emitWebhook(product, 'subscription.resumed', updated._id);
      logger.info({ subscriptionId: sub._id, gateway: sub.gateway }, 'subscription.resumed');
      return { subscription: toSummary(updated) };
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
      eventId: `evt_${event.replace(/\./g, '_')}_${subscriptionId}_${Date.now()}`,
      url: product.webhookUrl,
      payloadRef: subscriptionId,
    })
    .catch(() => undefined);
}
