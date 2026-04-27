/**
 * Phase 3.5 — Bundle schemas (Flow AL CRUD + Flow T checkout + Flow AK cancel).
 *
 * See YoCore-System-Design §1.15 (bundles collection), §5.7 (bundles ↔
 * subscriptions), §8.AL (CRUD lifecycle), Flow T (checkout) and §8.AK
 * (cancel cascade cron).
 */
import { z } from 'zod';
import { idSchema } from './common.js';

// ── Common bundle enums ───────────────────────────────────────────────
export const bundlePricingModelSchema = z.enum([
  'fixed',
  'percent_discount',
  'per_component_override',
]);
export type BundlePricingModel = z.infer<typeof bundlePricingModelSchema>;

export const bundleEligibilityPolicySchema = z.enum([
  'block',
  'cancel_and_credit',
  'replace_immediately',
]);
export type BundleEligibilityPolicy = z.infer<typeof bundleEligibilityPolicySchema>;

export const bundleVisibilitySchema = z.enum(['public', 'unlisted', 'private']);
export type BundleVisibility = z.infer<typeof bundleVisibilitySchema>;

export const bundleStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);
export type BundleStatus = z.infer<typeof bundleStatusSchema>;

const bundleSlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'Slug must be lowercase alphanumeric (with hyphens)');

const currencySchema = z
  .string()
  .min(3)
  .max(8)
  .toLowerCase()
  .regex(/^[a-z]+$/, 'Currency must be lowercase letters');

const bundleComponentSchema = z
  .object({
    productId: idSchema,
    planId: idSchema,
  })
  .strict();

const componentPriceOverrideSchema = z
  .object({
    productId: idSchema,
    amount: z.number().int().min(0),
  })
  .strict();

const currencyVariantSchema = z
  .object({
    currency: currencySchema,
    amount: z.number().int().min(0),
  })
  .strict();

// ── Flow AL.1 — Create bundle (DRAFT) ─────────────────────────────────
export const createBundleRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: bundleSlugSchema,
    description: z.string().max(2000).optional(),
    heroImageUrl: z.string().url().max(2048).optional(),
    components: z.array(bundleComponentSchema).min(2).max(10),
    pricingModel: bundlePricingModelSchema.default('fixed'),
    amount: z.number().int().min(0).optional(),
    percentDiscount: z.number().int().min(1).max(100).optional(),
    componentPriceOverrides: z.array(componentPriceOverrideSchema).max(10).optional(),
    currency: currencySchema.default('usd'),
    currencyVariants: z.array(currencyVariantSchema).min(1).max(10),
    interval: z.enum(['month', 'year']).default('month'),
    intervalCount: z.number().int().min(1).max(12).default(1),
    trialDays: z.number().int().min(0).max(365).default(0),
    componentSeats: z.record(z.string(), z.number().int().min(1)).optional(),
    eligibilityPolicy: bundleEligibilityPolicySchema.default('block'),
    visibility: bundleVisibilitySchema.default('public'),
    maxRedemptions: z.number().int().min(1).nullable().optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Pricing model field consistency (V7).
    if (v.pricingModel === 'fixed' && v.amount == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'pricingModel="fixed" requires amount',
      });
    }
    if (v.pricingModel === 'percent_discount' && v.percentDiscount == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['percentDiscount'],
        message: 'pricingModel="percent_discount" requires percentDiscount',
      });
    }
    if (
      v.pricingModel === 'per_component_override' &&
      (!v.componentPriceOverrides || v.componentPriceOverrides.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['componentPriceOverrides'],
        message: 'pricingModel="per_component_override" requires componentPriceOverrides',
      });
    }
    // V6 — no two components for the same productId.
    const seen = new Set<string>();
    for (const [i, c] of v.components.entries()) {
      if (seen.has(c.productId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['components', i, 'productId'],
          message: 'Duplicate productId across components',
        });
      }
      seen.add(c.productId);
    }
    // V9 — currencyVariants currencies unique.
    const cur = new Set<string>();
    for (const [i, v2] of v.currencyVariants.entries()) {
      if (cur.has(v2.currency)) {
        ctx.addIssue({
          code: 'custom',
          path: ['currencyVariants', i, 'currency'],
          message: 'Duplicate currency variant',
        });
      }
      cur.add(v2.currency);
    }
  });
export type CreateBundleRequest = z.infer<typeof createBundleRequestSchema>;

// ── Flow AL.3 — Update (PATCH) ────────────────────────────────────────
export const updateBundleRequestSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
    heroImageUrl: z.string().url().max(2048).nullable().optional(),
    pricingModel: bundlePricingModelSchema.optional(),
    amount: z.number().int().min(0).nullable().optional(),
    percentDiscount: z.number().int().min(1).max(100).nullable().optional(),
    componentPriceOverrides: z.array(componentPriceOverrideSchema).max(10).optional(),
    currencyVariants: z.array(currencyVariantSchema).min(1).max(10).optional(),
    componentSeats: z.record(z.string(), z.number().int().min(1)).optional(),
    eligibilityPolicy: bundleEligibilityPolicySchema.optional(),
    visibility: bundleVisibilitySchema.optional(),
    maxRedemptions: z.number().int().min(1).nullable().optional(),
    startsAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type UpdateBundleRequest = z.infer<typeof updateBundleRequestSchema>;

// ── Bundle summary (admin view) ───────────────────────────────────────
export const bundleSummarySchema = z.object({
  id: idSchema,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  heroImageUrl: z.string().nullable(),
  components: z.array(bundleComponentSchema),
  pricingModel: bundlePricingModelSchema,
  amount: z.number().nullable(),
  percentDiscount: z.number().nullable(),
  componentPriceOverrides: z.array(componentPriceOverrideSchema),
  currency: z.string(),
  currencyVariants: z.array(
    z.object({
      currency: z.string(),
      amount: z.number(),
      gatewayPriceIds: z.record(z.string(), z.string().nullable()).optional(),
    }),
  ),
  interval: z.enum(['month', 'year']),
  intervalCount: z.number(),
  trialDays: z.number(),
  componentSeats: z.record(z.string(), z.number()),
  eligibilityPolicy: bundleEligibilityPolicySchema,
  visibility: bundleVisibilitySchema,
  maxRedemptions: z.number().nullable(),
  redemptionCount: z.number(),
  status: bundleStatusSchema,
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BundleSummary = z.infer<typeof bundleSummarySchema>;

export const listBundlesQuerySchema = z
  .object({
    status: bundleStatusSchema.optional(),
    visibility: bundleVisibilitySchema.optional(),
    productId: idSchema.optional(),
  })
  .strict();
export type ListBundlesQuery = z.infer<typeof listBundlesQuerySchema>;

// ── Flow AL.2 — Preview (read-only) ───────────────────────────────────
export const bundlePreviewResponseSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.object({ code: z.string(), message: z.string() })),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  pricing: z.array(
    z.object({
      currency: z.string(),
      bundleAmount: z.number(),
      sumStandalone: z.number(),
      savings: z.number(),
    }),
  ),
});
export type BundlePreviewResponse = z.infer<typeof bundlePreviewResponseSchema>;

// ── Grant access (private bundles) ────────────────────────────────────
export const grantBundleAccessRequestSchema = z
  .object({
    userId: idSchema.optional(),
    workspaceId: idSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.userId && !v.workspaceId) {
      ctx.addIssue({
        code: 'custom',
        path: ['userId'],
        message: 'Either userId or workspaceId is required',
      });
    }
  });
export type GrantBundleAccessRequest = z.infer<typeof grantBundleAccessRequestSchema>;

// ── Flow T — Bundle checkout ──────────────────────────────────────────
export const bundleCheckoutRequestSchema = z
  .object({
    bundleId: idSchema,
    /** Map of productId → workspaceId for each workspace-scoped component. */
    subjects: z.record(z.string(), idSchema),
    /** Currency to use; must match one of bundle.currencyVariants. */
    currency: currencySchema,
    successUrl: z.string().url().max(2048),
    cancelUrl: z.string().url().max(2048),
  })
  .strict();
export type BundleCheckoutRequest = z.infer<typeof bundleCheckoutRequestSchema>;

export const bundleCheckoutResponseSchema = z.object({
  url: z.string().url(),
  sessionId: z.string(),
  gateway: z.enum(['stripe', 'sslcommerz', 'paypal', 'paddle']),
});
export type BundleCheckoutResponse = z.infer<typeof bundleCheckoutResponseSchema>;

// ── Cancel ────────────────────────────────────────────────────────────
export const bundleCancelResponseSchema = z.object({
  bundleSubscriptionId: idSchema,
  status: z.string(),
  canceledAt: z.string().nullable(),
  cascadeScheduled: z.boolean(),
});
export type BundleCancelResponse = z.infer<typeof bundleCancelResponseSchema>;
