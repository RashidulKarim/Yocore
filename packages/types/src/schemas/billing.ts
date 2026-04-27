/**
 * Phase 3.4 — Billing schemas (Plans, Subscriptions, Checkout).
 *
 * Wave 1 covers Plan CRUD (Flow D), publish + archive (Flow AO) and the
 * public plans endpoint. Subsequent waves extend with checkout / change-plan /
 * coupon / refund schemas.
 */
import { z } from 'zod';
import { idSchema } from './common.js';

// ── Common ─────────────────────────────────────────────────────────────
const intervalSchema = z.enum(['month', 'year', 'one_time']);
const planStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);
const planVisibilitySchema = z.enum(['public', 'private', 'grandfathered']);
const currencySchema = z
  .string()
  .min(3)
  .max(8)
  .toLowerCase()
  .regex(/^[a-z]+$/, 'Currency must be lowercase letters');

const planSlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'Slug must be lowercase alphanumeric (with hyphens)');

const planLimitsSchema = z
  .object({
    maxWorkspaces: z.number().int().min(-1).optional(),
    maxMembers: z.number().int().min(-1).optional(),
    maxProjects: z.number().int().min(-1).optional(),
    storageMb: z.number().int().min(-1).optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .partial();

const usageTierSchema = z
  .object({
    upTo: z.number().int().min(1).nullable(),
    unitPrice: z.number().min(0),
  })
  .strict();

// ── Flow D — Create plan ───────────────────────────────────────────────
export const createPlanRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: planSlugSchema,
    description: z.string().max(2000).optional(),
    isFree: z.boolean().default(false),
    amount: z.number().int().min(0).default(0),
    currency: currencySchema.default('usd'),
    interval: intervalSchema.default('month'),
    intervalCount: z.number().int().min(1).max(12).default(1),
    trialDays: z.number().int().min(0).max(365).default(0),
    limits: planLimitsSchema.default({}),
    seatBased: z.boolean().default(false),
    perSeatAmount: z.number().int().min(0).optional(),
    includedSeats: z.number().int().min(0).optional(),
    isMetered: z.boolean().default(false),
    usageTiers: z.array(usageTierSchema).max(20).optional(),
    metricNames: z.array(z.string().min(1).max(64)).max(10).optional(),
    usageHardCap: z.number().int().min(0).nullable().optional(),
    usageHardCapAction: z.enum(['block', 'alert_only']).nullable().optional(),
    visibility: planVisibilitySchema.default('public'),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.isFree && v.amount === 0 && v.interval !== 'one_time') {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Paid plans must have amount > 0 (set isFree:true for free plans)',
      });
    }
    if (v.seatBased && v.perSeatAmount == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['perSeatAmount'],
        message: 'Seat-based plans require perSeatAmount',
      });
    }
  });
export type CreatePlanRequest = z.infer<typeof createPlanRequestSchema>;

export const planSummarySchema = z.object({
  id: idSchema,
  productId: idSchema,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  isFree: z.boolean(),
  amount: z.number(),
  currency: z.string(),
  interval: intervalSchema,
  intervalCount: z.number(),
  trialDays: z.number(),
  limits: z.record(z.string(), z.unknown()),
  seatBased: z.boolean(),
  perSeatAmount: z.number().nullable(),
  includedSeats: z.number().nullable(),
  isMetered: z.boolean(),
  status: planStatusSchema,
  visibility: planVisibilitySchema,
  gatewayPriceIds: z.object({
    stripe: z.string().nullable(),
    sslcommerz: z.string().nullable(),
    paypal: z.string().nullable(),
    paddle: z.string().nullable(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PlanSummary = z.infer<typeof planSummarySchema>;

export const createPlanResponseSchema = z.object({
  plan: planSummarySchema,
});

// ── Update plan (DRAFT only for amount/currency) ───────────────────────
export const updatePlanRequestSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    amount: z.number().int().min(0).optional(),
    currency: currencySchema.optional(),
    interval: intervalSchema.optional(),
    intervalCount: z.number().int().min(1).max(12).optional(),
    trialDays: z.number().int().min(0).max(365).optional(),
    limits: planLimitsSchema.optional(),
    seatBased: z.boolean().optional(),
    perSeatAmount: z.number().int().min(0).nullable().optional(),
    includedSeats: z.number().int().min(0).nullable().optional(),
    visibility: planVisibilitySchema.optional(),
  })
  .strict();
export type UpdatePlanRequest = z.infer<typeof updatePlanRequestSchema>;

// ── Flow D — Publish ───────────────────────────────────────────────────
export const publishPlanResponseSchema = z.object({
  plan: planSummarySchema,
});

// ── Flow AO — Archive ──────────────────────────────────────────────────
export const archivePlanResponseSchema = z.object({
  plan: planSummarySchema,
  /** Number of subscriptions that remain on this plan (grandfathered). */
  affectedSubscriptions: z.number().int().min(0),
});

// ── List plans ─────────────────────────────────────────────────────────
export const listPlansQuerySchema = z
  .object({
    status: planStatusSchema.optional(),
    visibility: planVisibilitySchema.optional(),
  })
  .strict();
export type ListPlansQuery = z.infer<typeof listPlansQuerySchema>;

export const listPlansResponseSchema = z.object({
  plans: z.array(planSummarySchema),
});

// ── Public plans endpoint (`GET /v1/products/:slug/plans`) ─────────────
export const publicPlanSchema = z.object({
  id: idSchema,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  isFree: z.boolean(),
  amount: z.number(),
  currency: z.string(),
  interval: intervalSchema,
  intervalCount: z.number(),
  trialDays: z.number(),
  limits: z.record(z.string(), z.unknown()),
  seatBased: z.boolean(),
  perSeatAmount: z.number().nullable(),
  includedSeats: z.number().nullable(),
});
export type PublicPlan = z.infer<typeof publicPlanSchema>;

export const publicPlansResponseSchema = z.object({
  plans: z.array(publicPlanSchema),
});

// ──────────────────────────────────────────────────────────────────────
// Wave 2 — Checkout (Flow J1 Stripe)
// ──────────────────────────────────────────────────────────────────────

const subscriptionStatusSchema = z.enum([
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'INCOMPLETE',
  'PAUSED',
]);

/**
 * `POST /v1/billing/checkout` — initiate a subscribe flow.
 * `subjectWorkspaceId` is required when the product's `billingScope === 'workspace'`
 * (the common case). `subjectUserId` is taken from the authenticated user.
 */
export const checkoutRequestSchema = z
  .object({
    planId: idSchema,
    workspaceId: idSchema.optional(),
    quantity: z.number().int().min(1).max(1000).default(1),
    successUrl: z.string().url().max(2048),
    cancelUrl: z.string().url().max(2048),
  })
  .strict();
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

export const checkoutSessionResponseSchema = z.object({
  url: z.string().url(),
  sessionId: z.string(),
  gateway: z.enum(['stripe', 'sslcommerz', 'paypal', 'paddle']),
});
export type CheckoutSessionResponse = z.infer<typeof checkoutSessionResponseSchema>;

// ──────────────────────────────────────────────────────────────────────
// Wave 4 — Trial flow (Flow G — Path 2: Free trial)
// ──────────────────────────────────────────────────────────────────────

/**
 * `POST /v1/billing/trial/start` — start a free trial on a paid plan.
 *
 * Creates a TRIALING subscription with `gateway:null` (no payment method
 * collected upfront). The `billing.trial.tick` cron will later send 3-day /
 * 1-day warning emails and, on `trialEndsAt`, either convert (Scenario A —
 * if a PM has since been attached) or cancel + suspend the workspace
 * (Scenario B). Plan must have `trialDays > 0`.
 */
export const startTrialRequestSchema = z
  .object({
    planId: idSchema,
    workspaceId: idSchema.optional(),
  })
  .strict();
export type StartTrialRequest = z.infer<typeof startTrialRequestSchema>;

export const startTrialResponseSchema = z.object({
  subscriptionId: idSchema,
  status: subscriptionStatusSchema,
  trialEndsAt: z.string(),
});
export type StartTrialResponse = z.infer<typeof startTrialResponseSchema>;

export const subscriptionSummarySchema = z.object({
  id: idSchema,
  productId: idSchema,
  planId: idSchema,
  subjectType: z.enum(['user', 'workspace']),
  subjectUserId: idSchema.nullable(),
  subjectWorkspaceId: idSchema.nullable(),
  gateway: z.enum(['stripe', 'sslcommerz', 'paypal', 'paddle']).nullable(),
  status: subscriptionStatusSchema,
  amount: z.number(),
  currency: z.string(),
  quantity: z.number(),
  currentPeriodStart: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SubscriptionSummary = z.infer<typeof subscriptionSummarySchema>;

// ──────────────────────────────────────────────────────────────────────
// Wave 5 — Plan change (Flow R / AE)
// ──────────────────────────────────────────────────────────────────────

/**
 * `GET /v1/billing/subscription/change-plan/preview` — dry-run a plan
 * change. Returns proration math (Stripe) or the next-renewal note
 * (SSLCommerz). Subject to the seat-overflow guard.
 */
export const changePlanPreviewQuerySchema = z
  .object({
    newPlanId: idSchema,
    workspaceId: idSchema.optional(),
  })
  .strict();
export type ChangePlanPreviewQuery = z.infer<typeof changePlanPreviewQuerySchema>;

export const changePlanPreviewResponseSchema = z.object({
  subscriptionId: idSchema,
  fromPlanId: idSchema,
  toPlanId: idSchema,
  gateway: z.enum(['stripe', 'sslcommerz', 'paypal', 'paddle']).nullable(),
  prorationAmount: z.number().int(),
  creditApplied: z.number().int().min(0),
  nextChargeAmount: z.number().int().min(0),
  nextChargeDate: z.string().nullable(),
  currency: z.string(),
  note: z.string().optional(),
});
export type ChangePlanPreviewResponse = z.infer<typeof changePlanPreviewResponseSchema>;

/**
 * `POST /v1/billing/subscription/change-plan` — apply a plan change.
 *
 * Re-runs the seat-overflow guard (defence in depth) and dispatches to
 * the gateway adapter. SSLCommerz subscriptions schedule the change for
 * the next renewal cycle (gateway cannot proration mid-cycle).
 */
export const changePlanRequestSchema = z
  .object({
    newPlanId: idSchema,
    workspaceId: idSchema.optional(),
  })
  .strict();
export type ChangePlanRequest = z.infer<typeof changePlanRequestSchema>;

export const changePlanResponseSchema = z.object({
  subscription: subscriptionSummarySchema,
  scheduled: z.boolean(),
  effectiveAt: z.string(),
  prorationAmount: z.number().int(),
  currency: z.string(),
});
export type ChangePlanResponse = z.infer<typeof changePlanResponseSchema>;

// ──────────────────────────────────────────────────────────────────────
// Wave 6 — Seat change (Flow S)
// ──────────────────────────────────────────────────────────────────────

export const changeSeatsRequestSchema = z
  .object({
    quantity: z.number().int().min(1).max(1000),
    workspaceId: idSchema.optional(),
  })
  .strict();
export type ChangeSeatsRequest = z.infer<typeof changeSeatsRequestSchema>;

export const changeSeatsResponseSchema = z.object({
  subscription: subscriptionSummarySchema,
  scheduled: z.boolean(),
  effectiveAt: z.string(),
  prorationAmount: z.number().int(),
  currency: z.string(),
});
export type ChangeSeatsResponse = z.infer<typeof changeSeatsResponseSchema>;

// ──────────────────────────────────────────────────────────────────────
// Wave 7 — Pause / Resume (Flow AC)
// ──────────────────────────────────────────────────────────────────────

export const pauseSubscriptionRequestSchema = z
  .object({
    workspaceId: idSchema.optional(),
    resumeAt: z.string().datetime().optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type PauseSubscriptionRequest = z.infer<typeof pauseSubscriptionRequestSchema>;

export const resumeSubscriptionRequestSchema = z
  .object({
    workspaceId: idSchema.optional(),
  })
  .strict();
export type ResumeSubscriptionRequest = z.infer<typeof resumeSubscriptionRequestSchema>;

export const pauseResumeResponseSchema = z.object({
  subscription: subscriptionSummarySchema,
});
export type PauseResumeResponse = z.infer<typeof pauseResumeResponseSchema>;

// ──────────────────────────────────────────────────────────────────────
// Wave 8 — Coupons (Flow AF)
// ──────────────────────────────────────────────────────────────────────

const couponCodeSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Z0-9_-]+$/, 'Coupon code must be uppercase alphanumeric');
const couponDurationSchema = z.enum(['once', 'repeating', 'forever']);
const couponDiscountTypeSchema = z.enum(['percent', 'fixed']);

export const createCouponRequestSchema = z
  .object({
    code: couponCodeSchema,
    discountType: couponDiscountTypeSchema,
    amount: z.number().int().min(1),
    currency: currencySchema.optional(),
    duration: couponDurationSchema.default('once'),
    durationInMonths: z.number().int().min(1).max(36).optional(),
    maxUses: z.number().int().min(1).optional(),
    maxUsesPerCustomer: z.number().int().min(1).default(1),
    planIds: z.array(idSchema).max(50).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.discountType === 'percent' && v.amount > 100) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Percent discount cannot exceed 100',
      });
    }
    if (v.discountType === 'fixed' && !v.currency) {
      ctx.addIssue({
        code: 'custom',
        path: ['currency'],
        message: 'Fixed-amount coupons require currency',
      });
    }
    if (v.duration === 'repeating' && !v.durationInMonths) {
      ctx.addIssue({
        code: 'custom',
        path: ['durationInMonths'],
        message: 'Repeating duration requires durationInMonths',
      });
    }
  });
export type CreateCouponRequest = z.infer<typeof createCouponRequestSchema>;

export const couponSummarySchema = z.object({
  id: idSchema,
  productId: idSchema.nullable(),
  code: z.string(),
  discountType: couponDiscountTypeSchema,
  amount: z.number(),
  currency: z.string().nullable(),
  duration: couponDurationSchema,
  durationInMonths: z.number().nullable(),
  maxUses: z.number().nullable(),
  usedCount: z.number(),
  maxUsesPerCustomer: z.number(),
  planIds: z.array(idSchema).nullable(),
  expiresAt: z.string().nullable(),
  status: z.enum(['ACTIVE', 'DISABLED', 'EXPIRED']),
  createdAt: z.string(),
});
export type CouponSummary = z.infer<typeof couponSummarySchema>;

export const validateCouponQuerySchema = z
  .object({
    code: couponCodeSchema,
    planId: idSchema.optional(),
  })
  .strict();
export type ValidateCouponQuery = z.infer<typeof validateCouponQuerySchema>;

export const validateCouponResponseSchema = z.object({
  valid: z.boolean(),
  reason: z.string().nullable(),
  coupon: couponSummarySchema.nullable(),
  discountAmount: z.number().int().min(0).nullable(),
});
export type ValidateCouponResponse = z.infer<typeof validateCouponResponseSchema>;

// ──────────────────────────────────────────────────────────────────────
// Wave 9 — Refund (Flow AD — admin)
// ──────────────────────────────────────────────────────────────────────

export const refundRequestSchema = z
  .object({
    subscriptionId: idSchema,
    amount: z.number().int().min(1).optional(),
    reason: z.enum(['requested_by_customer', 'duplicate', 'fraudulent', 'other']).default(
      'requested_by_customer',
    ),
    note: z.string().max(500).optional(),
  })
  .strict();
export type RefundRequest = z.infer<typeof refundRequestSchema>;

export const refundResponseSchema = z.object({
  subscriptionId: idSchema,
  refundId: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  status: z.enum(['succeeded', 'pending', 'failed']),
});
export type RefundResponse = z.infer<typeof refundResponseSchema>;

// ──────────────────────────────────────────────────────────────────────
// Wave 10 — Gateway migration (Flow AG)
// ──────────────────────────────────────────────────────────────────────

export const gatewayMigrateRequestSchema = z
  .object({
    workspaceId: idSchema.optional(),
    targetGateway: z.enum(['stripe', 'sslcommerz']),
    successUrl: z.string().url().max(2048),
    cancelUrl: z.string().url().max(2048),
  })
  .strict();
export type GatewayMigrateRequest = z.infer<typeof gatewayMigrateRequestSchema>;

export const gatewayMigrateResponseSchema = z.object({
  url: z.string().url(),
  sessionId: z.string(),
  targetGateway: z.enum(['stripe', 'sslcommerz']),
  oldSubscriptionId: idSchema,
});
export type GatewayMigrateResponse = z.infer<typeof gatewayMigrateResponseSchema>;

// ──────────────────────────────────────────────────────────────────────
// Wave 12 — Invoices (B-10 cache + sync)
// ──────────────────────────────────────────────────────────────────────

export const invoiceSummarySchema = z.object({
  id: idSchema,
  productId: idSchema,
  subscriptionId: idSchema,
  gateway: z.enum(['stripe', 'sslcommerz', 'paypal', 'paddle']),
  gatewayInvoiceId: z.string(),
  invoiceNumber: z.string().nullable(),
  status: z.enum(['draft', 'open', 'paid', 'void', 'uncollectible', 'refunded']),
  amountSubtotal: z.number(),
  amountTax: z.number(),
  amountTotal: z.number(),
  amountPaid: z.number(),
  currency: z.string(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  issuedAt: z.string(),
  paidAt: z.string().nullable(),
  downloadUrl: z.string().nullable(),
});
export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;

export const listInvoicesQuerySchema = z
  .object({
    workspaceId: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

export const listInvoicesResponseSchema = z.object({
  invoices: z.array(invoiceSummarySchema),
});

// ──────────────────────────────────────────────────────────────────────
// Wave 13 — Tax profile (YC-005)
// ──────────────────────────────────────────────────────────────────────

const taxIdTypeSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9_]+$/, 'taxIdType must be lowercase alphanumeric');

export const upsertTaxProfileRequestSchema = z
  .object({
    workspaceId: idSchema.optional(),
    taxIdType: taxIdTypeSchema,
    taxIdValue: z.string().min(2).max(64),
    billingName: z.string().max(200).optional(),
    billingAddressLine1: z.string().max(200).optional(),
    billingAddressLine2: z.string().max(200).optional(),
    billingCity: z.string().max(100).optional(),
    billingPostalCode: z.string().max(32).optional(),
    billingState: z.string().max(100).optional(),
    billingCountry: z.string().length(2).optional(),
  })
  .strict();
export type UpsertTaxProfileRequest = z.infer<typeof upsertTaxProfileRequestSchema>;

export const taxProfileSchema = z.object({
  id: idSchema,
  productId: idSchema,
  userId: idSchema,
  workspaceId: idSchema.nullable(),
  taxIdType: z.string(),
  taxIdValue: z.string(),
  verificationStatus: z.enum(['unverified', 'pending', 'verified', 'invalid']),
  billingName: z.string().nullable(),
  billingAddressLine1: z.string().nullable(),
  billingAddressLine2: z.string().nullable(),
  billingCity: z.string().nullable(),
  billingPostalCode: z.string().nullable(),
  billingState: z.string().nullable(),
  billingCountry: z.string().nullable(),
});
export type TaxProfile = z.infer<typeof taxProfileSchema>;
