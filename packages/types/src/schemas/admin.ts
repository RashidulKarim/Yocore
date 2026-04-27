/**
 * Admin operations schemas — Super-Admin endpoints for v1.0:
 *  - Subscription force-status & credit adjustment (V1.0-D)
 *  - Cron status / force-run (V1.0-D)
 *  - Webhook delivery list & retry (V1.0-D)
 *  - JWT key rotation (V1.0-C / Flow Y)
 *  - Super-Admin IP allowlist config (V1.0-C / YC-010)
 *  - ToS / Privacy version publish (V1.0-B / B-05)
 */
import { z } from 'zod';

// ── Subscription force-status (V1.0-D) ───────────────────────────────
export const forceSubscriptionStatusRequestSchema = z.object({
  status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE', 'PAUSED']),
  reason: z.string().trim().min(2).max(500),
});
export type ForceSubscriptionStatusRequest = z.infer<typeof forceSubscriptionStatusRequestSchema>;

// ── Subscription credit adjustment (V1.0-D) ───────────────────────────
export const applySubscriptionCreditRequestSchema = z.object({
  /** Minor units (e.g. cents). Positive = credit, negative = debit. Non-zero. */
  deltaMinor: z.number().int(),
  reason: z.string().trim().min(2).max(500),
});
export type ApplySubscriptionCreditRequest = z.infer<typeof applySubscriptionCreditRequestSchema>;

// ── Cron force-run (V1.0-D) ──────────────────────────────────────────
export const forceCronRunRequestSchema = z.object({
  jobName: z.enum(['billing.trial.tick', 'billing.grace.tick', 'bundle.cancel.cascade', 'gdpr.deletion.tick', 'jwt.key.retire', 'webhook.delivery.tick']),
});
export type ForceCronRunRequest = z.infer<typeof forceCronRunRequestSchema>;

// ── Webhook delivery list (V1.0-D) ───────────────────────────────────
export const listWebhookDeliveriesQuerySchema = z.object({
  productId: z.string().optional(),
  status: z.enum(['PENDING', 'DELIVERED', 'FAILED', 'DEAD']).optional(),
  event: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});
export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveriesQuerySchema>;

// ── Super-Admin IP allowlist (V1.0-C / B-18) ─────────────────────────
const cidrRegex = /^([0-9]{1,3}\.){3}[0-9]{1,3}(\/(3[0-2]|[1-2]?[0-9]))?$|^([0-9a-fA-F:]+)(\/[0-9]{1,3})?$/;

export const updateSuperAdminConfigRequestSchema = z.object({
  adminIpAllowlist: z
    .array(z.string().regex(cidrRegex, 'invalid CIDR'))
    .max(50)
    .optional(),
  adminIpAllowlistEnabled: z.boolean().optional(),
});
export type UpdateSuperAdminConfigRequest = z.infer<typeof updateSuperAdminConfigRequestSchema>;

// ── JWT rotation (V1.0-C / Flow Y) ───────────────────────────────────
export const rotateJwtKeyResponseSchema = z.object({
  newKid: z.string(),
  oldKid: z.string().nullable(),
  verifyUntil: z.string(),
});
export type RotateJwtKeyResponse = z.infer<typeof rotateJwtKeyResponseSchema>;

// ── ToS publish (V1.0-B / B-05) ──────────────────────────────────────
export const publishTosVersionRequestSchema = z.object({
  type: z.enum(['terms_of_service', 'privacy_policy']),
  version: z.string().trim().min(1).max(20),
  effectiveAt: z.string().datetime(),
  contentUrl: z.string().url(),
  contentHash: z.string().min(8).max(128),
  changeSummary: z.string().max(2000).optional(),
});
export type PublishTosVersionRequest = z.infer<typeof publishTosVersionRequestSchema>;

// ── User self-deletion (V1.0-B / Flow X) ─────────────────────────────
export const requestSelfDeletionRequestSchema = z.object({
  scope: z.enum(['account', 'product']),
  productId: z.string().optional(),
  password: z.string().min(1),
});
export type RequestSelfDeletionRequest = z.infer<typeof requestSelfDeletionRequestSchema>;

export const cancelSelfDeletionRequestSchema = z.object({
  requestId: z.string().min(1),
  token: z.string().min(1),
});
export type CancelSelfDeletionRequest = z.infer<typeof cancelSelfDeletionRequestSchema>;
