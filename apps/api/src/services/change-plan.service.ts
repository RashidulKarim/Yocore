/**
 * Change-plan service — Phase 3.4 Wave 5 (Flow R + GAP-13/B-14 → Flow AE).
 *
 * Two endpoints back this service:
 *   - `GET  /v1/billing/subscription/change-plan/preview` — dry-run.
 *   - `POST /v1/billing/subscription/change-plan` — apply.
 *
 * Both validate:
 *   1. The caller owns/admins the subject (workspace OWNER/ADMIN, or the
 *      authenticated user when subscription is user-scoped).
 *   2. Target plan exists, is ACTIVE, and shares the same `currency` and
 *      `interval` as the live subscription.
 *   3. **Seat-overflow guard** — if the workspace has more active members
 *      than `targetPlan.limits.maxMembers`, returns
 *      `BILLING_PLAN_MEMBER_OVERFLOW` (402) with `{currentMembers,
 *      allowedMembers, mustRemove}` in `details`.
 *
 * Gateway dispatch:
 *   - **Stripe** → call `subscriptions.update({items, proration_behavior:
 *     "create_prorations"})`. Persist `planId/amount/currency` + push a
 *     `plan_change` history entry. Enqueue outbound `subscription.plan_changed`.
 *   - **SSLCommerz** → cannot mutate mid-cycle; record a
 *     `pendingPlanChange` blob (consumed by Flow J4 next-renewal worker)
 *     and push a `plan_change_scheduled` entry. Enqueue outbound
 *     `subscription.plan_change_scheduled`.
 *   - **TRIALING / null gateway** → swap planId immediately in DB only
 *     (no money in flight). Push `plan_change` entry.
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
  ChangePlanRequest,
  ChangePlanResponse,
  ChangePlanPreviewQuery,
  ChangePlanPreviewResponse,
  SubscriptionSummary,
} from '@yocore/types';

// ── Stripe API surface (injectable for tests) ──────────────────────────
export interface StripePlanApi {
  /** Pull the current Stripe subscription state — needed to find the
   *  `subscription_item.id` we must mutate (priceId is per-item). */
  retrieveSubscription(args: {
    secretKey: string;
    subscriptionId: string;
  }): Promise<{
    customerId: string;
    items: Array<{ id: string; priceId: string; quantity: number }>;
    currentPeriodEnd: number;
  }>;

  /** Returns the upcoming invoice if we were to swap to `newPriceId`. */
  retrieveUpcomingInvoice(args: {
    secretKey: string;
    customerId: string;
    subscriptionId: string;
    subscriptionItemId: string;
    newPriceId: string;
  }): Promise<{
    amountDue: number;
    currency: string;
    periodEnd: number;
  }>;

  /** Apply the price swap (`proration_behavior:"create_prorations"`). */
  updateSubscription(args: {
    secretKey: string;
    subscriptionId: string;
    subscriptionItemId: string;
    newPriceId: string;
    idempotencyKey: string;
  }): Promise<{
    currentPeriodEnd: number;
    latestInvoiceId: string | null;
  }>;
}

// ── Default Stripe HTTP client ────────────────────────────────────────
const STRIPE_BASE = 'https://api.stripe.com/v1';

async function stripeRequest(
  method: 'GET' | 'POST',
  path: string,
  secretKey: string,
  body?: string,
  idempotencyKey?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    'Stripe-Version': '2024-06-20',
  };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const init: RequestInit = { method, headers };
  if (body) init.body = body;
  const res = await fetch(`${STRIPE_BASE}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError(
      ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
      `Stripe ${method} ${path} failed`,
      { status: res.status, body: text.slice(0, 500) },
    );
  }
  return res.json();
}

interface StripeSubResponse {
  customer: string;
  current_period_end: number;
  items: { data: Array<{ id: string; quantity?: number; price: { id: string } }> };
}

interface StripeUpcomingInvoiceResponse {
  amount_due: number;
  currency: string;
  period_end: number;
}

interface StripeSubUpdateResponse {
  current_period_end: number;
  latest_invoice: string | null;
}

const defaultStripePlanApi: StripePlanApi = {
  async retrieveSubscription({ secretKey, subscriptionId }) {
    const j = (await stripeRequest(
      'GET',
      `/subscriptions/${subscriptionId}`,
      secretKey,
    )) as StripeSubResponse;
    return {
      customerId: j.customer,
      currentPeriodEnd: j.current_period_end,
      items: j.items.data.map((i) => ({
        id: i.id,
        priceId: i.price.id,
        quantity: i.quantity ?? 1,
      })),
    };
  },
  async retrieveUpcomingInvoice({
    secretKey,
    customerId,
    subscriptionId,
    subscriptionItemId,
    newPriceId,
  }) {
    const u = new URL(`${STRIPE_BASE}/invoices/upcoming`);
    u.searchParams.set('customer', customerId);
    u.searchParams.set('subscription', subscriptionId);
    u.searchParams.set('subscription_items[0][id]', subscriptionItemId);
    u.searchParams.set('subscription_items[0][price]', newPriceId);
    const res = await fetch(u.toString(), {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Stripe-Version': '2024-06-20',
      },
    });
    if (!res.ok) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
        'Stripe invoices.retrieveUpcoming failed',
      );
    }
    const j = (await res.json()) as StripeUpcomingInvoiceResponse;
    return { amountDue: j.amount_due, currency: j.currency, periodEnd: j.period_end };
  },
  async updateSubscription({
    secretKey,
    subscriptionId,
    subscriptionItemId,
    newPriceId,
    idempotencyKey,
  }) {
    const body = new URLSearchParams();
    body.set('items[0][id]', subscriptionItemId);
    body.set('items[0][price]', newPriceId);
    body.set('proration_behavior', 'create_prorations');
    const j = (await stripeRequest(
      'POST',
      `/subscriptions/${subscriptionId}`,
      secretKey,
      body.toString(),
      idempotencyKey,
    )) as StripeSubUpdateResponse;
    return {
      currentPeriodEnd: j.current_period_end,
      latestInvoiceId: j.latest_invoice ?? null,
    };
  },
};

// ── Service surface ───────────────────────────────────────────────────

export interface ChangePlanContext {
  userId: string;
  productId: string;
}

export interface ChangePlanService {
  preview(
    actor: ChangePlanContext,
    input: ChangePlanPreviewQuery,
  ): Promise<ChangePlanPreviewResponse>;
  apply(actor: ChangePlanContext, input: ChangePlanRequest): Promise<ChangePlanResponse>;
}

export interface CreateChangePlanServiceOptions {
  stripePlanApi?: StripePlanApi;
}

interface ResolvedChange {
  sub: subscriptionRepo.SubscriptionLean;
  fromPlan: planRepo.BillingPlanLean;
  toPlan: planRepo.BillingPlanLean;
  product: productRepo.ProductLean;
}

export function createChangePlanService(
  opts: CreateChangePlanServiceOptions = {},
): ChangePlanService {
  const stripeApi = opts.stripePlanApi ?? defaultStripePlanApi;

  const stripeRetrieve = createBreaker(stripeApi.retrieveSubscription, {
    name: 'stripe.subscriptions.retrieve',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });
  const stripeUpcoming = createBreaker(stripeApi.retrieveUpcomingInvoice, {
    name: 'stripe.invoices.upcoming',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });
  const stripeUpdate = createBreaker(stripeApi.updateSubscription, {
    name: 'stripe.subscriptions.update',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });

  /** Load + validate sub/plans/product/membership; run seat-overflow guard. */
  async function resolveAndGuard(
    actor: ChangePlanContext,
    newPlanId: string,
    workspaceIdHint: string | undefined,
  ): Promise<ResolvedChange> {
    const product = await productRepo.findProductById(actor.productId);
    if (!product) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');
    if (product.status !== 'ACTIVE') {
      throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not active');
    }

    const subjectType: 'user' | 'workspace' =
      product.billingScope === 'user' ? 'user' : 'workspace';

    const sub = await subscriptionRepo.findActiveBySubject({
      productId: actor.productId,
      subjectType,
      subjectUserId: subjectType === 'user' ? actor.userId : null,
      subjectWorkspaceId: subjectType === 'workspace' ? (workspaceIdHint ?? null) : null,
    });
    if (!sub) {
      throw new AppError(
        ErrorCode.SUBSCRIPTION_NOT_FOUND,
        'No active subscription found for this subject',
      );
    }
    // Only allow plan changes on healthy subs.
    if (!['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(sub.status)) {
      throw new AppError(
        ErrorCode.BILLING_SUBSCRIPTION_NOT_ACTIVE,
        `Cannot change plan on a ${sub.status} subscription`,
      );
    }

    // Authorization — workspace OWNER/ADMIN is required for workspace subs.
    if (subjectType === 'workspace' && sub.subjectWorkspaceId) {
      const member = await memberRepo.findMember(
        actor.productId,
        sub.subjectWorkspaceId,
        actor.userId,
      );
      if (!member || member.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not a member of this workspace');
      }
      if (member.roleSlug !== 'OWNER' && member.roleSlug !== 'ADMIN') {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'Only OWNER or ADMIN can change a workspace plan',
        );
      }
    } else if (subjectType === 'user' && sub.subjectUserId !== actor.userId) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not your subscription');
    }

    const fromPlan = await planRepo.findPlanById(actor.productId, sub.planId);
    if (!fromPlan) {
      throw new AppError(ErrorCode.PLAN_NOT_FOUND, 'Current plan no longer exists');
    }
    const toPlan = await planRepo.findPlanById(actor.productId, newPlanId);
    if (!toPlan) throw new AppError(ErrorCode.PLAN_NOT_FOUND, 'Target plan not found');
    if (toPlan.status !== 'ACTIVE') {
      throw new AppError(ErrorCode.BILLING_PLAN_NOT_PUBLISHED, 'Target plan not published');
    }
    if (toPlan._id === fromPlan._id) {
      throw new AppError(
        ErrorCode.RESOURCE_CONFLICT,
        'Subscription is already on this plan',
        { planId: toPlan._id },
      );
    }
    if ((toPlan.currency ?? 'usd') !== (fromPlan.currency ?? 'usd')) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Cannot change plan across currencies — use gateway migration instead',
        { from: fromPlan.currency, to: toPlan.currency },
      );
    }
    if (toPlan.interval !== fromPlan.interval) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Cannot change plan across billing intervals',
        { from: fromPlan.interval, to: toPlan.interval },
      );
    }
    // Disallow downgrade to a free plan via this endpoint — use cancel.
    if (toPlan.isFree || (toPlan.amount ?? 0) === 0) {
      throw new AppError(
        ErrorCode.BILLING_DOWNGRADE_BLOCKED,
        'Downgrade to a free plan via cancel + re-subscribe',
      );
    }

    // ── Seat-overflow guard (workspace-scoped only) ──────────────────
    if (subjectType === 'workspace' && sub.subjectWorkspaceId) {
      const limits = (toPlan.limits ?? {}) as { maxMembers?: number };
      const max = limits.maxMembers;
      if (typeof max === 'number' && max >= 0) {
        const current = await memberRepo.countActive(
          actor.productId,
          sub.subjectWorkspaceId,
        );
        if (current > max) {
          throw new AppError(
            ErrorCode.BILLING_PLAN_MEMBER_OVERFLOW,
            'Target plan does not allow this many members',
            {
              currentMembers: current,
              allowedMembers: max,
              mustRemove: current - max,
            },
          );
        }
      }
    }

    return { sub, fromPlan, toPlan, product };
  }

  function toSummary(
    s: subscriptionRepo.SubscriptionLean,
  ): SubscriptionSummary {
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
        'Stripe gateway not configured for this product',
      );
    }
    const enc = gw.credentialsEncrypted as
      | Record<string, { token: string }>
      | undefined;
    const wrapped = enc?.['secretKey']?.token;
    if (!wrapped) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        'Stripe credentials missing',
      );
    }
    return decryptToString(wrapped);
  }

  function getStripePriceId(plan: planRepo.BillingPlanLean): string {
    const ids = plan.gatewayPriceIds as Record<string, string | null> | undefined;
    const id = ids?.['stripe'];
    if (!id) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        'Plan has no Stripe price id — re-publish the plan to sync',
      );
    }
    return id;
  }

  return {
    async preview(actor, input) {
      const { sub, fromPlan, toPlan } = await resolveAndGuard(
        actor,
        input.newPlanId,
        input.workspaceId,
      );
      const currency = toPlan.currency ?? 'usd';
      const periodEnd = sub.currentPeriodEnd
        ? new Date(sub.currentPeriodEnd).toISOString()
        : null;

      // ── Stripe path: ask Stripe for upcoming invoice math ────────
      if (sub.gateway === 'stripe') {
        const refs = (sub.gatewayRefs ?? {}) as { stripeSubscriptionId?: string };
        const stripeSubId = refs.stripeSubscriptionId;
        if (!stripeSubId) {
          throw new AppError(
            ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
            'Subscription is missing its Stripe id',
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
        const newPriceId = getStripePriceId(toPlan);
        const upcoming = await stripeUpcoming.fire({
          secretKey: secret,
          customerId: stripeSub.customerId,
          subscriptionId: stripeSubId,
          subscriptionItemId: item.id,
          newPriceId,
        });
        const proration = upcoming.amountDue;
        return {
          subscriptionId: sub._id,
          fromPlanId: fromPlan._id,
          toPlanId: toPlan._id,
          gateway: 'stripe',
          prorationAmount: proration,
          creditApplied: proration < 0 ? Math.abs(proration) : 0,
          nextChargeAmount: Math.max(proration, 0),
          nextChargeDate: new Date(upcoming.periodEnd * 1000).toISOString(),
          currency: upcoming.currency.toLowerCase(),
        };
      }

      // ── SSLCommerz: no mid-cycle proration; bill at next renewal ──
      if (sub.gateway === 'sslcommerz') {
        return {
          subscriptionId: sub._id,
          fromPlanId: fromPlan._id,
          toPlanId: toPlan._id,
          gateway: 'sslcommerz',
          prorationAmount: 0,
          creditApplied: 0,
          nextChargeAmount: toPlan.amount ?? 0,
          nextChargeDate: periodEnd,
          currency,
          note: 'SSLCommerz cannot proration mid-cycle — full new-plan amount at next renewal.',
        };
      }

      // ── TRIALING / no gateway: instant swap, no money ─────────────
      return {
        subscriptionId: sub._id,
        fromPlanId: fromPlan._id,
        toPlanId: toPlan._id,
        gateway: sub.gateway ?? null,
        prorationAmount: 0,
        creditApplied: 0,
        nextChargeAmount: toPlan.amount ?? 0,
        nextChargeDate: periodEnd,
        currency,
        note: 'Trial subscription — plan swap takes effect immediately at no cost.',
      };
    },

    async apply(actor, input) {
      const { sub, fromPlan, toPlan, product } = await resolveAndGuard(
        actor,
        input.newPlanId,
        input.workspaceId,
      );
      const newAmount = toPlan.amount ?? 0;
      const newCurrency = toPlan.currency ?? 'usd';
      const periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;

      const beforeMeta = {
        planId: fromPlan._id,
        amount: fromPlan.amount ?? 0,
        currency: fromPlan.currency ?? 'usd',
      };
      const afterMeta = { planId: toPlan._id, amount: newAmount, currency: newCurrency };

      // ── Stripe path: live update + proration ─────────────────────
      if (sub.gateway === 'stripe') {
        const refs = (sub.gatewayRefs ?? {}) as { stripeSubscriptionId?: string };
        const stripeSubId = refs.stripeSubscriptionId;
        if (!stripeSubId) {
          throw new AppError(
            ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
            'Subscription is missing its Stripe id',
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
        const newPriceId = getStripePriceId(toPlan);
        const idemKey = `yocore:planchg:${sub._id}:${toPlan._id}`;
        const result = await stripeUpdate.fire({
          secretKey: secret,
          subscriptionId: stripeSubId,
          subscriptionItemId: item.id,
          newPriceId,
          idempotencyKey: idemKey,
        });
        const newPeriodEnd = result.currentPeriodEnd
          ? new Date(result.currentPeriodEnd * 1000)
          : periodEnd;

        const updated = await subscriptionRepo.applyPlanChange({
          productId: actor.productId,
          subscriptionId: sub._id,
          newPlanId: toPlan._id,
          newAmount,
          newCurrency,
          currentPeriodEnd: newPeriodEnd,
          gatewayRefsPatch: result.latestInvoiceId
            ? { stripeLatestInvoiceId: result.latestInvoiceId }
            : {},
          history: {
            changedAt: new Date(),
            changedBy: actor.userId,
            type: 'plan_change',
            before: beforeMeta,
            after: afterMeta,
            reason: 'user_change_plan',
          },
        });
        if (!updated) {
          throw new AppError(
            ErrorCode.SUBSCRIPTION_NOT_FOUND,
            'Subscription disappeared during update',
          );
        }
        await emitWebhook(product, 'subscription.plan_changed', updated._id);
        logger.info(
          { subscriptionId: updated._id, from: fromPlan._id, to: toPlan._id },
          'change_plan.applied.stripe',
        );
        return {
          subscription: toSummary(updated),
          scheduled: false,
          effectiveAt: new Date().toISOString(),
          prorationAmount: 0, // Stripe handles invoice; UI fetches via preview
          currency: newCurrency,
        };
      }

      // ── SSLCommerz: schedule for next renewal ────────────────────
      if (sub.gateway === 'sslcommerz') {
        const scheduledFor = periodEnd ?? new Date();
        const updated = await subscriptionRepo.setPendingPlanChange({
          productId: actor.productId,
          subscriptionId: sub._id,
          newPlanId: toPlan._id,
          newAmount,
          newCurrency,
          scheduledFor,
          requestedBy: actor.userId,
          reason: 'user_change_plan',
          history: {
            changedAt: new Date(),
            changedBy: actor.userId,
            type: 'plan_change_scheduled',
            before: beforeMeta,
            after: afterMeta,
            reason: 'user_change_plan',
          },
        });
        if (!updated) {
          throw new AppError(
            ErrorCode.SUBSCRIPTION_NOT_FOUND,
            'Subscription disappeared during update',
          );
        }
        await emitWebhook(product, 'subscription.plan_change_scheduled', updated._id);
        logger.info(
          {
            subscriptionId: updated._id,
            from: fromPlan._id,
            to: toPlan._id,
            scheduledFor,
          },
          'change_plan.scheduled.sslcommerz',
        );
        return {
          subscription: toSummary(updated),
          scheduled: true,
          effectiveAt: scheduledFor.toISOString(),
          prorationAmount: 0,
          currency: newCurrency,
        };
      }

      // ── TRIALING / null gateway: in-DB swap ──────────────────────
      const updated = await subscriptionRepo.applyPlanChange({
        productId: actor.productId,
        subscriptionId: sub._id,
        newPlanId: toPlan._id,
        newAmount,
        newCurrency,
        history: {
          changedAt: new Date(),
          changedBy: actor.userId,
          type: 'plan_change',
          before: beforeMeta,
          after: afterMeta,
          reason: 'user_change_plan_trial',
        },
      });
      if (!updated) {
        throw new AppError(
          ErrorCode.SUBSCRIPTION_NOT_FOUND,
          'Subscription disappeared during update',
        );
      }
      await emitWebhook(product, 'subscription.plan_changed', updated._id);
      return {
        subscription: toSummary(updated),
        scheduled: false,
        effectiveAt: new Date().toISOString(),
        prorationAmount: 0,
        currency: newCurrency,
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
      eventId: `evt_planchg_${subscriptionId}_${Date.now()}`,
      url: product.webhookUrl,
      payloadRef: subscriptionId,
    })
    .catch(() => undefined);
}
