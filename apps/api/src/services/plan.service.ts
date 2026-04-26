/**
 * Plan service — Phase 3.4 Wave 1 (Flow D / AO).
 *
 * Responsibilities
 *   - Create / update / publish / archive billing plans (SUPER_ADMIN-only).
 *   - On publish: create a Stripe `price` and store it on
 *     `billingPlans.gatewayPriceIds.stripe` (only if a Stripe gateway is
 *     configured + ACTIVE for this product).
 *   - On state-change: invalidate the public plans cache
 *     (`cache:plans:<productId>`).
 *
 * Edit guard (Stripe constraint)
 *   - `amount` and `currency` are immutable on ACTIVE plans. To change them,
 *     archive the plan and create a new one. Free plans (`isFree:true`,
 *     `amount:0`) bypass Stripe price creation.
 *
 * The Stripe price-creation function is injected so tests can run without a
 * network. The default implementation calls `https://api.stripe.com/v1/prices`
 * via `fetch` (Node 20 native).
 */
import type { Redis } from 'ioredis';
import { AppError, ErrorCode } from '../lib/errors.js';
import { decryptToString } from '../lib/encryption.js';
import { createBreaker } from '../lib/circuit-breaker.js';
import * as planRepo from '../repos/billing-plan.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as gatewayRepo from '../repos/payment-gateway.repo.js';
import type {
  CreatePlanRequest,
  PlanSummary,
  UpdatePlanRequest,
} from '@yocore/types';

export type StripePriceCreateFn = (input: {
  secretKey: string;
  amount: number;
  currency: string;
  interval: 'month' | 'year' | 'one_time';
  intervalCount: number;
  productId: string;
  planId: string;
  planName: string;
}) => Promise<{ id: string }>;

export interface CreatePlanServiceOptions {
  redis?: Redis;
  /** Override the Stripe price creator (tests). */
  stripeCreatePrice?: StripePriceCreateFn;
}

export interface PlanService {
  create(productId: string, input: CreatePlanRequest, actorUserId: string): Promise<PlanSummary>;
  list(productId: string, filter?: planRepo.ListPlansFilter): Promise<PlanSummary[]>;
  get(productId: string, planId: string): Promise<PlanSummary>;
  update(productId: string, planId: string, input: UpdatePlanRequest): Promise<PlanSummary>;
  publish(productId: string, planId: string): Promise<PlanSummary>;
  archive(
    productId: string,
    planId: string,
  ): Promise<{ plan: PlanSummary; affectedSubscriptions: number }>;
  /** Public listing (active + visibility:public, cached 5min). */
  listPublic(productSlug: string): Promise<PlanSummary[]>;
}

const PUBLIC_PLAN_CACHE_TTL_SECONDS = 5 * 60;

function planCacheKey(productId: string): string {
  return `cache:plans:${productId}`;
}

function toSummary(p: planRepo.BillingPlanLean): PlanSummary {
  const gpi = (p.gatewayPriceIds ?? {}) as Record<string, string | null>;
  return {
    id: p._id,
    productId: p.productId,
    name: p.name,
    slug: p.slug,
    description: p.description ?? null,
    isFree: p.isFree ?? false,
    amount: p.amount ?? 0,
    currency: p.currency ?? 'usd',
    interval: (p.interval ?? 'month') as PlanSummary['interval'],
    intervalCount: p.intervalCount ?? 1,
    trialDays: p.trialDays ?? 0,
    limits: (p.limits ?? {}) as Record<string, unknown>,
    seatBased: p.seatBased ?? false,
    perSeatAmount: p.perSeatAmount ?? null,
    includedSeats: p.includedSeats ?? null,
    isMetered: p.isMetered ?? false,
    status: (p.status ?? 'DRAFT') as PlanSummary['status'],
    visibility: (p.visibility ?? 'public') as PlanSummary['visibility'],
    gatewayPriceIds: {
      stripe: gpi['stripe'] ?? null,
      sslcommerz: gpi['sslcommerz'] ?? null,
      paypal: gpi['paypal'] ?? null,
      paddle: gpi['paddle'] ?? null,
    },
    createdAt:
      (p as { createdAt?: Date }).createdAt?.toISOString?.() ?? new Date(0).toISOString(),
    updatedAt:
      (p as { updatedAt?: Date }).updatedAt?.toISOString?.() ?? new Date(0).toISOString(),
  };
}

/** Default Stripe price creator — POST /v1/prices with `Bearer secretKey`. */
const defaultStripeCreatePrice: StripePriceCreateFn = async (input) => {
  const body = new URLSearchParams();
  body.set('unit_amount', String(input.amount));
  body.set('currency', input.currency);
  if (input.interval === 'one_time') {
    // Stripe one-time prices have no `recurring`.
  } else {
    body.set('recurring[interval]', input.interval);
    body.set('recurring[interval_count]', String(input.intervalCount));
  }
  // Stripe needs a Product object; embed via product_data so we don't have to
  // pre-create a Product in Stripe for every YoCore plan.
  body.set('product_data[name]', input.planName);
  body.set('metadata[yocoreProductId]', input.productId);
  body.set('metadata[yocorePlanId]', input.planId);

  const res = await fetch('https://api.stripe.com/v1/prices', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
      // Idempotency: re-running publish for the same plan returns the same price.
      'Idempotency-Key': `yocore:plan-publish:${input.planId}`,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError(
      ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
      'Stripe price creation failed',
      { status: res.status, body: text.slice(0, 500) },
    );
  }
  const json = (await res.json()) as { id?: string };
  if (!json.id) {
    throw new AppError(
      ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
      'Stripe response missing price id',
    );
  }
  return { id: json.id };
};

export function createPlanService(opts: CreatePlanServiceOptions = {}): PlanService {
  const stripeCreate = opts.stripeCreatePrice ?? defaultStripeCreatePrice;
  const stripeBreaker = createBreaker(stripeCreate, {
    name: 'stripe.prices.create',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });

  async function invalidatePublicCache(productId: string): Promise<void> {
    if (!opts.redis) return;
    try {
      await opts.redis.del(planCacheKey(productId));
    } catch {
      /* cache failures must not block writes */
    }
  }

  async function loadOr404(productId: string, planId: string): Promise<planRepo.BillingPlanLean> {
    const p = await planRepo.findPlanById(productId, planId);
    if (!p) throw new AppError(ErrorCode.PLAN_NOT_FOUND, 'Plan not found');
    return p;
  }

  async function loadProductOr404(productId: string): Promise<productRepo.ProductLean> {
    const p = await productRepo.findProductById(productId);
    if (!p) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');
    return p;
  }

  return {
    async create(productId, input, actorUserId) {
      await loadProductOr404(productId);
      const slug = input.slug.trim().toLowerCase();
      const existing = await planRepo.findPlanBySlug(productId, slug);
      if (existing) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Plan slug already in use', {
          field: 'slug',
        });
      }
      const created = await planRepo.createPlan({
        productId,
        name: input.name,
        slug,
        description: input.description ?? null,
        isFree: input.isFree,
        amount: input.amount,
        currency: input.currency,
        interval: input.interval,
        intervalCount: input.intervalCount,
        trialDays: input.trialDays,
        limits: input.limits,
        seatBased: input.seatBased,
        ...(input.perSeatAmount !== undefined ? { perSeatAmount: input.perSeatAmount } : {}),
        ...(input.includedSeats !== undefined ? { includedSeats: input.includedSeats } : {}),
        isMetered: input.isMetered,
        ...(input.usageTiers ? { usageTiers: input.usageTiers } : {}),
        ...(input.metricNames ? { metricNames: input.metricNames } : {}),
        ...(input.usageHardCap !== undefined ? { usageHardCap: input.usageHardCap } : {}),
        ...(input.usageHardCapAction !== undefined
          ? { usageHardCapAction: input.usageHardCapAction }
          : {}),
        visibility: input.visibility,
        createdBy: actorUserId,
      });
      // Plan starts DRAFT → not visible publicly; no cache invalidation needed.
      return toSummary(created);
    },

    async list(productId, filter = {}) {
      const rows = await planRepo.listPlans(productId, filter);
      return rows.map(toSummary);
    },

    async get(productId, planId) {
      const p = await loadOr404(productId, planId);
      return toSummary(p);
    },

    async update(productId, planId, input) {
      const current = await loadOr404(productId, planId);

      // Stripe immutability guard — once ACTIVE, amount and currency cannot
      // change (Stripe price objects are immutable). Admin must archive +
      // create a new plan.
      if (current.status === 'ACTIVE') {
        if (input.amount !== undefined && input.amount !== current.amount) {
          throw new AppError(
            ErrorCode.BILLING_PLAN_IMMUTABLE,
            'Cannot change amount on ACTIVE plan — archive and create a new plan',
            { field: 'amount' },
          );
        }
        if (input.currency !== undefined && input.currency !== current.currency) {
          throw new AppError(
            ErrorCode.BILLING_PLAN_IMMUTABLE,
            'Cannot change currency on ACTIVE plan — archive and create a new plan',
            { field: 'currency' },
          );
        }
        if (input.interval !== undefined && input.interval !== current.interval) {
          throw new AppError(
            ErrorCode.BILLING_PLAN_IMMUTABLE,
            'Cannot change interval on ACTIVE plan — archive and create a new plan',
            { field: 'interval' },
          );
        }
      }

      const updated = await planRepo.updatePlan(productId, planId, input);
      if (!updated) throw new AppError(ErrorCode.PLAN_NOT_FOUND, 'Plan not found');
      // Public-facing fields may have changed.
      if (updated.status === 'ACTIVE') await invalidatePublicCache(productId);
      return toSummary(updated);
    },

    async publish(productId, planId) {
      const current = await loadOr404(productId, planId);
      if (current.status === 'ACTIVE') return toSummary(current); // idempotent
      if (current.status === 'ARCHIVED') {
        throw new AppError(
          ErrorCode.BILLING_PLAN_IMMUTABLE,
          'Cannot publish an archived plan',
        );
      }

      // Skip Stripe sync for free plans + plans that already have a price id.
      const gpi = (current.gatewayPriceIds ?? {}) as Record<string, string | null>;
      const needsStripePrice =
        !current.isFree &&
        (current.amount ?? 0) > 0 &&
        !gpi['stripe'] &&
        current.interval !== 'one_time';

      if (needsStripePrice) {
        const stripeGw = await gatewayRepo.findOne(productId, 'stripe', 'live');
        const liveOrTest =
          stripeGw && stripeGw.status === 'ACTIVE'
            ? stripeGw
            : await gatewayRepo.findOne(productId, 'stripe', 'test');
        if (liveOrTest && liveOrTest.status === 'ACTIVE') {
          const enc = liveOrTest.credentialsEncrypted as
            | Record<string, { token: string }>
            | undefined;
          const wrapped = enc?.['secretKey']?.token;
          if (wrapped) {
            const secretKey = decryptToString(wrapped);
            const result = await stripeBreaker.fire({
              secretKey,
              amount: current.amount ?? 0,
              currency: (current.currency ?? 'usd').toLowerCase(),
              interval: (current.interval ?? 'month') as 'month' | 'year' | 'one_time',
              intervalCount: current.intervalCount ?? 1,
              productId,
              planId,
              planName: current.name,
            });
            await planRepo.setStripePriceId(productId, planId, result.id);
          }
        }
        // If no Stripe gateway configured: publish proceeds without a price
        // id; checkout will fail later with BILLING_GATEWAY_CONFIG_MISSING.
      }

      const updated = await planRepo.setPlanStatus(productId, planId, 'ACTIVE');
      if (!updated) throw new AppError(ErrorCode.PLAN_NOT_FOUND, 'Plan not found');
      await invalidatePublicCache(productId);
      return toSummary(updated);
    },

    async archive(productId, planId) {
      const current = await loadOr404(productId, planId);
      if (current.status === 'ARCHIVED') {
        const count = await planRepo.countActiveSubscriptionsForPlan(productId, planId);
        return { plan: toSummary(current), affectedSubscriptions: count };
      }
      const updated = await planRepo.setPlanStatus(productId, planId, 'ARCHIVED');
      if (!updated) throw new AppError(ErrorCode.PLAN_NOT_FOUND, 'Plan not found');
      const affected = await planRepo.countActiveSubscriptionsForPlan(productId, planId);
      await invalidatePublicCache(productId);
      return { plan: toSummary(updated), affectedSubscriptions: affected };
    },

    async listPublic(productSlug) {
      const product = await productRepo.findProductBySlug(productSlug);
      if (!product) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');
      const productId = product._id;

      // Cache lookup
      if (opts.redis) {
        try {
          const hit = await opts.redis.get(planCacheKey(productId));
          if (hit) {
            return JSON.parse(hit) as PlanSummary[];
          }
        } catch {
          /* cache failure → fall through to DB */
        }
      }

      const rows = await planRepo.listPlans(productId, {
        status: 'ACTIVE',
        visibility: 'public',
      });
      const plans = rows.map(toSummary);

      if (opts.redis) {
        try {
          await opts.redis.set(
            planCacheKey(productId),
            JSON.stringify(plans),
            'EX',
            PUBLIC_PLAN_CACHE_TTL_SECONDS,
          );
        } catch {
          /* cache failure non-fatal */
        }
      }
      return plans;
    },
  };
}
