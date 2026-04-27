/**
 * Phase 3.5 — Bundle service (Flow AL CRUD + lifecycle).
 *
 * Owns the admin-facing CRUD + publish + archive + preview surface for
 * bundles. Bundles are GLOBAL (cross-product) per System-Design §1.15 / §5.7.
 *
 * Pricing: a bundle has one or more `currencyVariants`. On publish we create
 * a Stripe price per variant on the FIRST component product's Stripe gateway
 * (v1.0 simplification — central Stripe account is a v1.5 follow-up).
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import { decryptToString } from '../lib/encryption.js';
import { logger } from '../lib/logger.js';
import * as bundleRepo from '../repos/bundle.repo.js';
import * as planRepo from '../repos/billing-plan.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as gatewayRepo from '../repos/payment-gateway.repo.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import { Subscription } from '../db/models/Subscription.js';
import type {
  CreateBundleRequest,
  UpdateBundleRequest,
  BundleSummary,
  BundlePreviewResponse,
} from '@yocore/types';

// ── Stripe-bundle-price API (injectable for tests) ────────────────────
export interface StripeBundlePriceApi {
  createBundleProductAndPrice(args: {
    secretKey: string;
    bundleId: string;
    bundleName: string;
    amount: number;
    currency: string;
    interval: 'month' | 'year';
    intervalCount: number;
  }): Promise<{ productId: string; priceId: string }>;
  archivePrice?(args: { secretKey: string; priceId: string }): Promise<void>;
}

const STRIPE_BASE = 'https://api.stripe.com/v1';

async function stripePost(
  path: string,
  secretKey: string,
  body: string,
  idempotencyKey?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': '2024-06-20',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${STRIPE_BASE}${path}`, { method: 'POST', headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError(
      ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
      `Stripe ${path} failed`,
      { status: res.status, body: text.slice(0, 500) },
    );
  }
  return res.json();
}

const defaultStripeBundlePriceApi: StripeBundlePriceApi = {
  async createBundleProductAndPrice(args) {
    const productBody = new URLSearchParams();
    productBody.set('name', args.bundleName);
    productBody.set('metadata[yocoreBundleId]', args.bundleId);
    const product = (await stripePost(
      '/products',
      args.secretKey,
      productBody.toString(),
      `yocore:bdl:prod:${args.bundleId}`,
    )) as { id: string };

    const priceBody = new URLSearchParams();
    priceBody.set('product', product.id);
    priceBody.set('unit_amount', String(args.amount));
    priceBody.set('currency', args.currency);
    priceBody.set('recurring[interval]', args.interval);
    priceBody.set('recurring[interval_count]', String(args.intervalCount));
    priceBody.set('metadata[yocoreBundleId]', args.bundleId);
    const price = (await stripePost(
      '/prices',
      args.secretKey,
      priceBody.toString(),
      `yocore:bdl:price:${args.bundleId}:${args.currency}`,
    )) as { id: string };

    return { productId: product.id, priceId: price.id };
  },
  async archivePrice({ secretKey, priceId }) {
    await stripePost(`/prices/${priceId}`, secretKey, 'active=false');
  },
};

// ── Service ───────────────────────────────────────────────────────────

export interface BundleService {
  create(input: CreateBundleRequest, actor: { id: string }): Promise<BundleSummary>;
  list(filter: {
    status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
    visibility?: 'public' | 'unlisted' | 'private';
    productId?: string;
  }): Promise<BundleSummary[]>;
  get(bundleId: string): Promise<BundleSummary>;
  update(
    bundleId: string,
    patch: UpdateBundleRequest,
    actor: { id: string },
  ): Promise<BundleSummary>;
  publish(bundleId: string, actor: { id: string }): Promise<BundleSummary>;
  archive(bundleId: string, actor: { id: string }): Promise<BundleSummary>;
  hardDelete(bundleId: string, actor: { id: string }): Promise<{ deleted: boolean }>;
  preview(bundleId: string): Promise<BundlePreviewResponse>;
  grantAccess(
    bundleId: string,
    entry: { userId?: string | null; workspaceId?: string | null },
    actor: { id: string },
  ): Promise<BundleSummary>;
}

export interface CreateBundleServiceOptions {
  stripeBundlePriceApi?: StripeBundlePriceApi;
}

export function createBundleService(
  opts: CreateBundleServiceOptions = {},
): BundleService {
  const stripeApi = opts.stripeBundlePriceApi ?? defaultStripeBundlePriceApi;

  // Mongoose's InferSchemaType returns optional/nullable fields too liberally
  // for nested-array elements. We narrow them once in this helper to keep the
  // call sites clean.
  type BundleView = {
    _id: string;
    name: string;
    slug: string;
    description: string | null;
    heroImageUrl: string | null;
    components: Array<{ productId: string; planId: string }>;
    pricingModel: 'fixed' | 'percent_discount' | 'per_component_override';
    amount: number | null;
    percentDiscount: number | null;
    componentPriceOverrides: Array<{ productId: string; amount: number }>;
    currency: string;
    currencyVariants: Array<{
      currency: string;
      amount: number;
      gatewayPriceIds?: Record<string, string | null>;
    }>;
    interval: 'month' | 'year';
    intervalCount: number;
    trialDays: number;
    componentSeats: Record<string, number>;
    eligibilityPolicy: 'block' | 'cancel_and_credit' | 'replace_immediately';
    visibility: 'public' | 'unlisted' | 'private';
    maxRedemptions: number | null;
    redemptionCount: number;
    status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
    startsAt: Date | null;
    endsAt: Date | null;
    publishedAt: Date | null;
    archivedAt: Date | null;
    grantedAccess: Array<{ userId: string | null; workspaceId: string | null }>;
    createdAt?: Date;
    updatedAt?: Date;
  };

  function view(b: bundleRepo.BundleLean): BundleView {
    return b as unknown as BundleView;
  }

  function toSummary(raw: bundleRepo.BundleLean): BundleSummary {
    const b = view(raw);
    return {
      id: b._id,
      name: b.name,
      slug: b.slug,
      description: b.description ?? null,
      heroImageUrl: b.heroImageUrl ?? null,
      components: b.components,
      pricingModel: b.pricingModel,
      amount: b.amount ?? null,
      percentDiscount: b.percentDiscount ?? null,
      componentPriceOverrides: b.componentPriceOverrides,
      currency: b.currency,
      currencyVariants: b.currencyVariants.map((v) => ({
        currency: v.currency,
        amount: v.amount,
        gatewayPriceIds: v.gatewayPriceIds ?? {},
      })),
      interval: b.interval,
      intervalCount: b.intervalCount,
      trialDays: b.trialDays,
      componentSeats: b.componentSeats,
      eligibilityPolicy: b.eligibilityPolicy,
      visibility: b.visibility,
      maxRedemptions: b.maxRedemptions ?? null,
      redemptionCount: b.redemptionCount,
      status: b.status,
      startsAt: b.startsAt ? new Date(b.startsAt).toISOString() : null,
      endsAt: b.endsAt ? new Date(b.endsAt).toISOString() : null,
      publishedAt: b.publishedAt ? new Date(b.publishedAt).toISOString() : null,
      archivedAt: b.archivedAt ? new Date(b.archivedAt).toISOString() : null,
      createdAt: new Date(b.createdAt ?? new Date()).toISOString(),
      updatedAt: new Date(b.updatedAt ?? new Date()).toISOString(),
    };
  }

  /** Validate a bundle's component graph + pricing. Returns errors[]. */
  async function validateBundle(raw: bundleRepo.BundleLean): Promise<{
    errors: Array<{ code: string; message: string }>;
    warnings: Array<{ code: string; message: string }>;
    pricing: Array<{
      currency: string;
      bundleAmount: number;
      sumStandalone: number;
      savings: number;
    }>;
  }> {
    const b = view(raw);
    const errors: Array<{ code: string; message: string }> = [];
    const warnings: Array<{ code: string; message: string }> = [];

    // V1 — components ≥2 (also enforced in Zod, but defensive).
    if (b.components.length < 2) {
      errors.push({ code: 'V1', message: 'Bundle must have at least 2 components' });
    }

    // V2 — every component product exists + ACTIVE.
    const productIds = b.components.map((c) => c.productId);
    const products = await Promise.all(productIds.map((id) => productRepo.findProductById(id)));
    products.forEach((p, i) => {
      if (!p) errors.push({ code: 'V2', message: `Component product ${productIds[i]} not found` });
      else if (p.status !== 'ACTIVE')
        errors.push({ code: 'V2', message: `Component product ${productIds[i]} is not ACTIVE` });
    });

    // V3 — every plan exists + ACTIVE + same interval/intervalCount as bundle.
    const plans = await Promise.all(
      b.components.map((c) => planRepo.findPlanById(c.productId, c.planId)),
    );
    plans.forEach((p, i) => {
      const c = b.components[i];
      if (!c) return;
      if (!p) {
        errors.push({ code: 'V3', message: `Component plan ${c.planId} not found` });
        return;
      }
      if (p.status !== 'ACTIVE') {
        errors.push({ code: 'V3', message: `Component plan ${c.planId} is not ACTIVE` });
      }
      if (p.interval !== b.interval || p.intervalCount !== b.intervalCount) {
        errors.push({
          code: 'V4',
          message: `Component plan ${c.planId} interval does not match bundle (${b.interval}/${b.intervalCount})`,
        });
      }
      if (p.isFree) {
        errors.push({
          code: 'V5',
          message: `Component plan ${c.planId} is free; cannot be bundled`,
        });
      }
    });

    // V8 — pricing sanity per variant.
    const pricing: Array<{
      currency: string;
      bundleAmount: number;
      sumStandalone: number;
      savings: number;
    }> = [];
    for (const variant of b.currencyVariants) {
      let sumStandalone = 0;
      for (let i = 0; i < b.components.length; i++) {
        const plan = plans[i];
        if (!plan) continue;
        // Resolve component cost in this currency: prefer plan's own currency
        // match or its currencyVariants if present; else assume plan.amount.
        let amt = plan.amount ?? 0;
        const planVariants = (plan as { currencyVariants?: Array<{ currency: string; amount: number }> })
          .currencyVariants ?? [];
        const planVariant = planVariants.find((pv) => pv.currency === variant.currency);
        if (planVariant) amt = planVariant.amount;
        sumStandalone += amt;
      }
      let bundleAmount = variant.amount;
      if (b.pricingModel === 'percent_discount' && b.percentDiscount != null) {
        bundleAmount = Math.floor((sumStandalone * (100 - b.percentDiscount)) / 100);
      }
      const savings = sumStandalone - bundleAmount;
      if (savings < 0) {
        warnings.push({
          code: 'V8',
          message: `Bundle priced higher than standalone sum in ${variant.currency} (${bundleAmount} > ${sumStandalone})`,
        });
      }
      pricing.push({
        currency: variant.currency,
        bundleAmount,
        sumStandalone,
        savings,
      });
    }

    return { errors, warnings, pricing };
  }

  return {
    async create(input, actor) {
      // V6 — slug uniqueness.
      const existing = await bundleRepo.findBundleBySlug(input.slug);
      if (existing) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Bundle slug already in use', {
          slug: input.slug,
        });
      }
      const created = await bundleRepo.createBundle({
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        heroImageUrl: input.heroImageUrl ?? null,
        components: input.components,
        pricingModel: input.pricingModel,
        amount: input.amount ?? null,
        percentDiscount: input.percentDiscount ?? null,
        componentPriceOverrides: input.componentPriceOverrides,
        currency: input.currency,
        currencyVariants: input.currencyVariants,
        interval: input.interval,
        intervalCount: input.intervalCount,
        trialDays: input.trialDays,
        componentSeats: input.componentSeats,
        eligibilityPolicy: input.eligibilityPolicy,
        visibility: input.visibility,
        maxRedemptions: input.maxRedemptions ?? null,
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        metadata: input.metadata,
        createdBy: actor.id,
      });
      logger.info(
        { bundleId: created._id, slug: created.slug, actor: actor.id },
        'bundle.created',
      );
      return toSummary(created);
    },

    async list(filter) {
      const rows = await bundleRepo.listBundles(filter);
      return rows.map(toSummary);
    },

    async get(bundleId) {
      const b = await bundleRepo.findBundleById(bundleId);
      if (!b) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle not found');
      return toSummary(b);
    },

    async update(bundleId, patch, actor) {
      const raw = await bundleRepo.findBundleById(bundleId);
      if (!raw) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle not found');
      const b = view(raw);

      // §5.7.4 edit rules — block component add/remove on ACTIVE bundles.
      // (Components themselves are immutable in the update schema; only fields
      //  below are editable. So this is mostly a defensive note.)
      const set: Record<string, unknown> = {};
      const editable: (keyof UpdateBundleRequest)[] = [
        'name',
        'description',
        'heroImageUrl',
        'pricingModel',
        'amount',
        'percentDiscount',
        'componentPriceOverrides',
        'currencyVariants',
        'componentSeats',
        'eligibilityPolicy',
        'visibility',
        'maxRedemptions',
        'startsAt',
        'endsAt',
        'metadata',
      ];
      for (const k of editable) {
        if (patch[k] === undefined) continue;
        let v: unknown = patch[k];
        if ((k === 'startsAt' || k === 'endsAt') && typeof v === 'string') v = new Date(v);
        set[k] = v;
      }

      // §5.7.4 — currencyVariants change on ACTIVE: cannot remove a variant
      // that's referenced by an active subscription.
      if (b.status === 'ACTIVE' && patch.currencyVariants) {
        const newCurrencies = new Set(patch.currencyVariants.map((v) => v.currency.toLowerCase()));
        const removed = b.currencyVariants
          .map((v) => v.currency)
          .filter((c) => !newCurrencies.has(c));
        if (removed.length > 0) {
          const inUse = await Subscription.countDocuments({
            bundleId,
            currency: { $in: removed },
            status: { $in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED'] },
          });
          if (inUse > 0) {
            throw new AppError(
              ErrorCode.RESOURCE_CONFLICT,
              `Cannot remove currency variant(s) in use: ${removed.join(', ')}`,
              { removed },
            );
          }
        }
      }

      const updated = await bundleRepo.updateBundleFields(bundleId, set);
      if (!updated) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle not found');
      await bundleRepo.appendBundleChangeHistory(bundleId, {
        changedAt: new Date(),
        changedBy: actor.id,
        type: 'updated',
        before: Object.fromEntries(Object.keys(set).map((k) => [k, (b as Record<string, unknown>)[k]])),
        after: set,
      });
      return toSummary(updated);
    },

    async publish(bundleId, actor) {
      const raw = await bundleRepo.findBundleById(bundleId);
      if (!raw) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle not found');
      const b = view(raw);
      if (b.status === 'ARCHIVED') {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          'Cannot publish an archived bundle',
        );
      }
      // Validate (V1-V8). Errors block; warnings allowed.
      const report = await validateBundle(raw);
      if (report.errors.length > 0) {
        throw new AppError(
          ErrorCode.BILLING_BUNDLE_VALIDATION_FAILED,
          'Bundle validation failed',
          { errors: report.errors, warnings: report.warnings },
        );
      }

      // Resolve Stripe credentials from the FIRST component product.
      const firstComponent = b.components[0];
      if (!firstComponent) {
        throw new AppError(
          ErrorCode.BILLING_BUNDLE_VALIDATION_FAILED,
          'Bundle has no components',
        );
      }
      const stripeGw =
        (await gatewayRepo.findOne(firstComponent.productId, 'stripe', 'live')) ??
        (await gatewayRepo.findOne(firstComponent.productId, 'stripe', 'test'));
      if (!stripeGw || stripeGw.status !== 'ACTIVE') {
        throw new AppError(
          ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
          'Stripe gateway not configured for first component product',
        );
      }
      const enc = stripeGw.credentialsEncrypted as
        | Record<string, { token: string }>
        | undefined;
      const wrapped = enc?.['secretKey']?.token;
      if (!wrapped) {
        throw new AppError(
          ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
          'Stripe credentials missing',
        );
      }
      const secretKey = decryptToString(wrapped);

      // Create a Stripe price per currency variant (idempotent).
      for (const variant of b.currencyVariants) {
        const existingId = variant.gatewayPriceIds?.['stripe'];
        if (existingId) continue;
        const { priceId } = await stripeApi.createBundleProductAndPrice({
          secretKey,
          bundleId: b._id,
          bundleName: b.name,
          amount: variant.amount,
          currency: variant.currency,
          interval: b.interval as 'month' | 'year',
          intervalCount: b.intervalCount,
        });
        await bundleRepo.setBundleCurrencyVariantGatewayId(b._id, variant.currency, 'stripe', priceId);
      }

      const updated = await bundleRepo.setBundleStatus(b._id, 'ACTIVE', {
        publishedAt: new Date(),
      });
      if (!updated) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle disappeared');
      await bundleRepo.appendBundleChangeHistory(b._id, {
        changedAt: new Date(),
        changedBy: actor.id,
        type: 'published',
      });

      // Outbound webhook to every component product.
      for (const c of b.components) {
        const product = await productRepo.findProductById(c.productId);
        if (!product?.webhookUrl) continue;
        await deliveryRepo
          .enqueueDelivery({
            productId: c.productId,
            event: 'bundle.published',
            eventId: `evt_bdl_pub_${b._id}_${c.productId}`,
            url: product.webhookUrl,
            payloadRef: b._id,
          })
          .catch(() => undefined);
      }

      logger.info({ bundleId: b._id, actor: actor.id }, 'bundle.published');
      return toSummary(updated);
    },

    async archive(bundleId, actor) {
      const raw = await bundleRepo.findBundleById(bundleId);
      if (!raw) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle not found');
      const b = view(raw);
      if (b.status === 'ARCHIVED') return toSummary(raw);
      const updated = await bundleRepo.setBundleStatus(b._id, 'ARCHIVED', {
        archivedAt: new Date(),
      });
      if (!updated) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle disappeared');
      await bundleRepo.appendBundleChangeHistory(b._id, {
        changedAt: new Date(),
        changedBy: actor.id,
        type: 'archived',
      });
      // Notify component products.
      for (const c of b.components) {
        const product = await productRepo.findProductById(c.productId);
        if (!product?.webhookUrl) continue;
        await deliveryRepo
          .enqueueDelivery({
            productId: c.productId,
            event: 'bundle.archived',
            eventId: `evt_bdl_arch_${b._id}_${c.productId}`,
            url: product.webhookUrl,
            payloadRef: b._id,
          })
          .catch(() => undefined);
      }
      logger.info({ bundleId: b._id, actor: actor.id }, 'bundle.archived');
      return toSummary(updated);
    },

    async hardDelete(bundleId, _actor) {
      const b = await bundleRepo.findBundleById(bundleId);
      if (!b) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle not found');
      const refs = await Subscription.countDocuments({ bundleId });
      if (refs > 0) {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          'Bundle is referenced by existing subscriptions; archive instead',
          { subscriptionCount: refs },
        );
      }
      const ok = await bundleRepo.hardDeleteBundle(bundleId);
      return { deleted: ok };
    },

    async preview(bundleId) {
      const b = await bundleRepo.findBundleById(bundleId);
      if (!b) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle not found');
      const report = await validateBundle(b);
      return { ok: report.errors.length === 0, ...report };
    },

    async grantAccess(bundleId, entry, actor) {
      const b = await bundleRepo.findBundleById(bundleId);
      if (!b) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle not found');
      const updated = await bundleRepo.addBundleGrantedAccess(bundleId, {
        ...(entry.userId !== undefined ? { userId: entry.userId } : {}),
        ...(entry.workspaceId !== undefined ? { workspaceId: entry.workspaceId } : {}),
        grantedBy: actor.id,
      });
      if (!updated) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle disappeared');
      return toSummary(updated);
    },
  };
}
