/**
 * Phase 3.3 — Products & Gateway schemas (Flow B / AJ / C1–C5).
 *
 * All endpoints under `/v1/admin/products` require a SUPER_ADMIN session.
 * Admin authority is enforced in the handler layer; schemas only model the
 * request/response payloads.
 */
import { z } from 'zod';
import { idSchema } from './common.js';

// ── Product slug ───────────────────────────────────────────────────────
export const productSlugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z][a-z0-9-]*$/, 'Slug must be lowercase alphanumeric (with hyphens)');

const billingScopeSchema = z.enum(['user', 'workspace']);

const billingConfigInputSchema = z
  .object({
    gatewayRouting: z.record(z.string(), z.string()).optional(),
    gracePeriodDays: z.number().int().min(0).max(60).optional(),
    gracePeriodEmailSchedule: z.array(z.number().int().min(0)).max(10).optional(),
    holdPeriodDays: z.number().int().min(1).max(365).optional(),
    holdPeriodWarningDays: z.array(z.number().int().min(0)).max(10).optional(),
    canReactivateDuringHold: z.boolean().optional(),
    trialDefaultDays: z.number().int().min(0).max(365).optional(),
    trialWarningDays: z.array(z.number().int().min(0)).max(10).optional(),
  })
  .strict();

// ── Flow B — Create product ────────────────────────────────────────────
export const createProductRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: productSlugSchema,
    domain: z.string().url().optional(),
    allowedOrigins: z.array(z.string().url()).max(20).optional(),
    allowedRedirectUris: z.array(z.string().url()).max(20).optional(),
    logoUrl: z.string().url().optional(),
    description: z.string().max(2000).optional(),
    billingScope: billingScopeSchema.default('workspace'),
    billingConfig: billingConfigInputSchema.optional(),
    webhookUrl: z.string().url().optional(),
    webhookEvents: z.array(z.string()).max(100).optional(),
  })
  .strict();
export type CreateProductRequest = z.infer<typeof createProductRequestSchema>;

export const productSummarySchema = z.object({
  id: idSchema,
  name: z.string(),
  slug: z.string(),
  status: z.enum(['INACTIVE', 'ACTIVE', 'MAINTENANCE', 'ABANDONED']),
  apiKey: z.string(),
  billingScope: billingScopeSchema,
  webhookUrl: z.string().nullable(),
  createdAt: z.string(),
});
export type ProductSummary = z.infer<typeof productSummarySchema>;

export const createProductResponseSchema = z.object({
  product: productSummarySchema,
  /** Plaintext secret — shown ONCE only. */
  apiSecret: z.string(),
  /** Plaintext webhook signing secret — shown ONCE only. */
  webhookSecret: z.string(),
});
export type CreateProductResponse = z.infer<typeof createProductResponseSchema>;

// ── Update / activate product ──────────────────────────────────────────
export const updateProductStatusRequestSchema = z
  .object({
    status: z.enum(['ACTIVE', 'INACTIVE', 'MAINTENANCE', 'ABANDONED']),
  })
  .strict();
export type UpdateProductStatusRequest = z.infer<typeof updateProductStatusRequestSchema>;

export const updateProductRequestSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    domain: z.string().url().optional(),
    allowedOrigins: z.array(z.string().url()).max(20).optional(),
    allowedRedirectUris: z.array(z.string().url()).max(20).optional(),
    logoUrl: z.string().url().optional(),
    description: z.string().max(2000).optional(),
    webhookUrl: z.string().url().optional(),
    webhookEvents: z.array(z.string()).max(100).optional(),
  })
  .strict();
export type UpdateProductRequest = z.infer<typeof updateProductRequestSchema>;

// ── Flow B — Rotate API secret ─────────────────────────────────────────
export const rotateApiSecretResponseSchema = z.object({
  apiSecret: z.string(),
  rotatedAt: z.string(),
});
export type RotateApiSecretResponse = z.infer<typeof rotateApiSecretResponseSchema>;

// ── Flow AJ — Rotate webhook secret (24h grace) ────────────────────────
export const rotateWebhookSecretResponseSchema = z.object({
  webhookSecret: z.string(),
  rotatedAt: z.string(),
  /** Old secret remains valid until this timestamp (now + 24h). */
  previousSecretExpiresAt: z.string(),
});
export type RotateWebhookSecretResponse = z.infer<typeof rotateWebhookSecretResponseSchema>;

// ── Flow C5 — Update billing config (gateway routing) ──────────────────
export const updateBillingConfigRequestSchema = billingConfigInputSchema;
export type UpdateBillingConfigRequest = z.infer<typeof updateBillingConfigRequestSchema>;

// ── Flow C1–C4 — Add gateway ───────────────────────────────────────────
const stripeCredentialsSchema = z
  .object({
    secretKey: z.string().min(8),
    webhookSecret: z.string().min(8),
  })
  .strict();

const sslcommerzCredentialsSchema = z
  .object({
    storeId: z.string().min(1),
    storePassword: z.string().min(1),
    webhookSecret: z.string().min(1).optional(),
  })
  .strict();

const paypalCredentialsSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    webhookId: z.string().min(1).optional(),
  })
  .strict();

const paddleCredentialsSchema = z
  .object({
    vendorId: z.string().min(1),
    vendorAuthCode: z.string().min(1),
    publicKey: z.string().min(1).optional(),
    webhookSecret: z.string().min(1).optional(),
  })
  .strict();

export const addGatewayRequestSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('stripe'),
    mode: z.enum(['live', 'test']).default('test'),
    displayName: z.string().max(80).optional(),
    credentials: stripeCredentialsSchema,
  }),
  z.object({
    provider: z.literal('sslcommerz'),
    mode: z.enum(['live', 'test']).default('test'),
    displayName: z.string().max(80).optional(),
    credentials: sslcommerzCredentialsSchema,
  }),
  z.object({
    provider: z.literal('paypal'),
    mode: z.enum(['live', 'test']).default('test'),
    displayName: z.string().max(80).optional(),
    credentials: paypalCredentialsSchema,
  }),
  z.object({
    provider: z.literal('paddle'),
    mode: z.enum(['live', 'test']).default('test'),
    displayName: z.string().max(80).optional(),
    credentials: paddleCredentialsSchema,
  }),
]);
export type AddGatewayRequest = z.infer<typeof addGatewayRequestSchema>;

export const gatewaySummarySchema = z.object({
  id: idSchema,
  productId: idSchema,
  provider: z.enum(['stripe', 'sslcommerz', 'paypal', 'paddle']),
  mode: z.enum(['live', 'test']),
  status: z.enum(['ACTIVE', 'DISABLED', 'INVALID_CREDENTIALS']),
  displayName: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  lastVerificationStatus: z.enum(['ok', 'failed']).nullable(),
  lastVerificationError: z.string().nullable(),
  createdAt: z.string(),
});
export type GatewaySummary = z.infer<typeof gatewaySummarySchema>;

export const addGatewayResponseSchema = z.object({
  gateway: gatewaySummarySchema,
});
export type AddGatewayResponse = z.infer<typeof addGatewayResponseSchema>;

export const listGatewaysResponseSchema = z.object({
  gateways: z.array(gatewaySummarySchema),
});

export const verifyGatewayResponseSchema = z.object({
  gateway: gatewaySummarySchema,
});

export const listProductsResponseSchema = z.object({
  products: z.array(productSummarySchema),
});

export const getProductResponseSchema = z.object({
  product: productSummarySchema.extend({
    domain: z.string().nullable(),
    description: z.string().nullable(),
    allowedOrigins: z.array(z.string()),
    allowedRedirectUris: z.array(z.string()),
    webhookEvents: z.array(z.string()),
    billingConfig: z.record(z.string(), z.unknown()),
    updatedAt: z.string(),
  }),
});
