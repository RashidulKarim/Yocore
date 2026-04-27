/**
 * Coupon service — Phase 3.4 Wave 8 (Flow AF).
 *
 * Admin CRUD on `coupons` (super-admin only — `productId === null` for
 * platform-wide, or product-scoped via the calling super admin's selection).
 * Customer-facing `validate()` is hit during checkout to compute discounts.
 *
 * Stripe sync (best-effort): when a coupon is created with the gateway, we
 * also create a Stripe coupon (via REST `/v1/coupons`) so it can be applied
 * to gateway-side checkout sessions. SSLCommerz has no native coupon model
 * — discounts are applied client-side at checkout-amount calculation time.
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import { decryptToString } from '../lib/encryption.js';
import { createBreaker } from '../lib/circuit-breaker.js';
import { logger } from '../lib/logger.js';
import * as couponRepo from '../repos/coupon.repo.js';
import * as redemptionRepo from '../repos/coupon-redemption.repo.js';
import * as planRepo from '../repos/billing-plan.repo.js';
import * as gatewayRepo from '../repos/payment-gateway.repo.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';
import type {
  CreateCouponRequest,
  CouponSummary,
  ValidateCouponQuery,
  ValidateCouponResponse,
} from '@yocore/types';

export interface StripeCouponApi {
  createCoupon(args: {
    secretKey: string;
    discountType: 'percent' | 'fixed';
    amount: number;
    currency?: string | null;
    duration: 'once' | 'repeating' | 'forever';
    durationInMonths?: number | null;
    name?: string | null;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  deleteCoupon(args: { secretKey: string; couponId: string }): Promise<void>;
}

const STRIPE_BASE = 'https://api.stripe.com/v1';

const defaultStripeCouponApi: StripeCouponApi = {
  async createCoupon({ secretKey, discountType, amount, currency, duration, durationInMonths, name, idempotencyKey }) {
    const body = new URLSearchParams();
    if (discountType === 'percent') body.set('percent_off', String(amount));
    else {
      body.set('amount_off', String(amount));
      if (currency) body.set('currency', currency.toLowerCase());
    }
    body.set('duration', duration);
    if (duration === 'repeating' && durationInMonths) {
      body.set('duration_in_months', String(durationInMonths));
    }
    if (name) body.set('name', name);
    const res = await fetch(`${STRIPE_BASE}/coupons`, {
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
        'Stripe coupon create failed',
      );
    }
    const j = (await res.json()) as { id: string };
    return j;
  },
  async deleteCoupon({ secretKey, couponId }) {
    await fetch(`${STRIPE_BASE}/coupons/${couponId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': '2024-06-20' },
    }).catch(() => undefined);
  },
};

export interface CouponAdminContext {
  userId: string; // super-admin user id
}

export interface CouponService {
  createCoupon(
    actor: CouponAdminContext,
    productId: string | null,
    input: CreateCouponRequest,
  ): Promise<CouponSummary>;
  listCoupons(productId: string): Promise<CouponSummary[]>;
  disableCoupon(productId: string, couponId: string): Promise<CouponSummary>;
  deleteCoupon(productId: string, couponId: string): Promise<void>;
  validate(
    productId: string,
    input: ValidateCouponQuery & { userId?: string },
    planAmount: number,
    planCurrency: string,
  ): Promise<ValidateCouponResponse>;
  /** Record a successful redemption + increment `usedCount`. Idempotent on (couponId,subscriptionId). */
  recordRedemption(args: {
    couponId: string;
    productId: string;
    userId: string;
    workspaceId?: string | null;
    subscriptionId: string;
    discountAmount: number;
    currency: string;
  }): Promise<void>;
}

export interface CreateCouponServiceOptions {
  stripeCouponApi?: StripeCouponApi;
}

export function createCouponService(opts: CreateCouponServiceOptions = {}): CouponService {
  const stripe = opts.stripeCouponApi ?? defaultStripeCouponApi;
  const stripeCreate = createBreaker(stripe.createCoupon, {
    name: 'stripe.coupons.create',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });

  function toSummary(c: couponRepo.CouponLean): CouponSummary {
    const created = (c as { createdAt?: Date }).createdAt ?? new Date();
    return {
      id: c._id,
      productId: c.productId ?? null,
      code: c.code,
      discountType: c.discountType,
      amount: c.amount,
      currency: c.currency ?? null,
      duration: c.duration,
      durationInMonths: c.durationInMonths ?? null,
      maxUses: c.maxUses ?? null,
      usedCount: c.usedCount ?? 0,
      maxUsesPerCustomer: c.maxUsesPerCustomer ?? 1,
      planIds: c.planIds ?? null,
      expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
      status: c.status as CouponSummary['status'],
      createdAt: new Date(created).toISOString(),
    };
  }

  async function loadStripeSecretIfAny(productId: string | null): Promise<string | null> {
    if (!productId) return null;
    const gw =
      (await gatewayRepo.findOne(productId, 'stripe', 'live')) ??
      (await gatewayRepo.findOne(productId, 'stripe', 'test'));
    if (!gw || gw.status !== 'ACTIVE') return null;
    const enc = gw.credentialsEncrypted as Record<string, { token: string }> | undefined;
    const wrapped = enc?.['secretKey']?.token;
    if (!wrapped) return null;
    return decryptToString(wrapped);
  }

  return {
    async createCoupon(actor, productId, input) {
      const existing = await couponRepo.findByCode(productId ?? '', input.code);
      if (existing) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Coupon code already in use', {
          code: input.code,
        });
      }

      // Best-effort Stripe sync.
      let stripeCouponId: string | null = null;
      const secret = await loadStripeSecretIfAny(productId);
      if (secret) {
        try {
          const res = await stripeCreate.fire({
            secretKey: secret,
            discountType: input.discountType,
            amount: input.amount,
            currency: input.currency ?? null,
            duration: input.duration,
            durationInMonths: input.durationInMonths ?? null,
            name: input.code,
            idempotencyKey: `yocore:coupon:${input.code}`,
          });
          stripeCouponId = res.id;
        } catch (err) {
          logger.warn({ err, code: input.code }, 'coupon.stripe.create.failed');
        }
      }

      const created = await couponRepo.createCoupon({
        productId: productId ?? null,
        code: input.code,
        discountType: input.discountType,
        amount: input.amount,
        currency: input.currency ?? null,
        duration: input.duration,
        durationInMonths: input.durationInMonths ?? null,
        maxUses: input.maxUses ?? null,
        maxUsesPerCustomer: input.maxUsesPerCustomer ?? 1,
        planIds: input.planIds ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: actor.userId,
        gatewayRefs: { stripeCouponId },
      });
      return toSummary(created);
    },

    async listCoupons(productId) {
      const rows = await couponRepo.listForProduct(productId);
      return rows.map(toSummary);
    },

    async disableCoupon(productId, couponId) {
      const existing = await couponRepo.findById(couponId);
      if (!existing || (existing.productId !== null && existing.productId !== productId)) {
        throw new AppError(ErrorCode.COUPON_NOT_FOUND, 'Coupon not found');
      }
      const updated = await couponRepo.setStatus(couponId, 'DISABLED');
      if (!updated) throw new AppError(ErrorCode.COUPON_NOT_FOUND, 'Coupon not found');
      return toSummary(updated);
    },

    async deleteCoupon(productId, couponId) {
      const existing = await couponRepo.findById(couponId);
      if (!existing || (existing.productId !== null && existing.productId !== productId)) {
        throw new AppError(ErrorCode.COUPON_NOT_FOUND, 'Coupon not found');
      }
      await couponRepo.deleteCoupon(couponId);
    },

    async validate(productId, input, planAmount, planCurrency) {
      const fail = (reason: string): ValidateCouponResponse => ({
        valid: false,
        reason,
        coupon: null,
        discountAmount: null,
      });
      const coupon = await couponRepo.findByCode(productId, input.code);
      if (!coupon) return fail('not_found');
      if (coupon.status !== 'ACTIVE') {
        return fail(coupon.status === 'EXPIRED' ? 'expired' : 'disabled');
      }
      if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) {
        return fail('expired');
      }
      if (coupon.maxUses != null && coupon.usedCount >= coupon.maxUses) {
        return fail('max_uses_reached');
      }
      if (coupon.planIds && coupon.planIds.length > 0) {
        if (!input.planId || !coupon.planIds.includes(input.planId)) {
          return fail('plan_not_eligible');
        }
      }
      if (coupon.currency && coupon.currency.toLowerCase() !== planCurrency.toLowerCase()) {
        return fail('currency_mismatch');
      }
      if (input.userId && coupon.maxUsesPerCustomer > 0) {
        const count = await redemptionRepo.countForCustomer(coupon._id, input.userId);
        if (count >= coupon.maxUsesPerCustomer) {
          return fail('per_customer_limit_reached');
        }
      }
      // Optional: ensure plan exists for product (defensive).
      if (input.planId) {
        const plan = await planRepo.findPlanById(productId, input.planId);
        if (!plan) return fail('plan_not_found');
      }

      const discountAmount =
        coupon.discountType === 'percent'
          ? Math.round((planAmount * coupon.amount) / 100)
          : Math.min(planAmount, coupon.amount);

      // (planCurrency unused on positive return — caller already knows currency.)
      void planCurrency;
      return {
        valid: true,
        reason: null,
        coupon: toSummary(coupon),
        discountAmount,
      };
    },

    async recordRedemption(args) {
      // Idempotency: if a redemption already exists for this (coupon, sub),
      // skip.
      const existing = await redemptionRepo.listForSubscription(args.subscriptionId);
      if (existing.some((r) => r.couponId === args.couponId)) return;

      await redemptionRepo.recordRedemption(args);
      await couponRepo.incrementUsedCount(args.couponId);
      await subscriptionRepo.attachCoupon({
        productId: args.productId,
        subscriptionId: args.subscriptionId,
        couponId: args.couponId,
      });
    },
  };
}
