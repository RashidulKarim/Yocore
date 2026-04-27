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

// ── Cron force-run (V1.0-D, extended in V1.1-A) ─────────────────────
export const forceCronRunRequestSchema = z.object({
  jobName: z.enum([
    'billing.trial.tick',
    'billing.grace.tick',
    'bundle.cancel.cascade',
    'gdpr.deletion.tick',
    'gdpr.dataExport.tick',
    'jwt.key.retire',
    'webhook.delivery.tick',
    'email.deliverability.review',
    'webhook.archive.tick',
  ]),
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

// ── Data export (V1.1-A / Flow W) ─────────────────────────────────────
export const requestDataExportRequestSchema = z.object({
  /** "all" or an array of productIds the caller belongs to. */
  scope: z.union([z.literal('all'), z.array(z.string().min(1)).min(1).max(50)]).default('all'),
});
export type RequestDataExportRequest = z.infer<typeof requestDataExportRequestSchema>;

export const dataExportListItemSchema = z.object({
  id: z.string(),
  status: z.enum(['PENDING', 'RUNNING', 'COMPLETE', 'FAILED']),
  scope: z.union([z.literal('all'), z.array(z.string())]),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  downloadUrl: z.string().url().nullable(),
  errorMessage: z.string().nullable(),
});
export type DataExportListItem = z.infer<typeof dataExportListItemSchema>;

export const listDataExportsResponseSchema = z.object({
  exports: z.array(dataExportListItemSchema),
});
export type ListDataExportsResponse = z.infer<typeof listDataExportsResponseSchema>;

// ── Email deliverability admin reset (V1.1-A / addendum #8) ──────────
export const resetEmailDeliverabilityRequestSchema = z.object({
  productId: z.string().min(1),
  reason: z.string().trim().min(2).max(500).optional(),
});
export type ResetEmailDeliverabilityRequest = z.infer<typeof resetEmailDeliverabilityRequestSchema>;

// -- V1.1-C Admin extended ops -----------------------------------------
export const extendTrialRequestSchema = z
  .object({
    additionalDays: z.number().int().min(1).max(365),
    reason: z.string().min(3).max(500),
  })
  .strict();
export type ExtendTrialRequest = z.infer<typeof extendTrialRequestSchema>;

export const extendGraceRequestSchema = z
  .object({
    additionalDays: z.number().int().min(1).max(60),
    reason: z.string().min(3).max(500),
  })
  .strict();
export type ExtendGraceRequest = z.infer<typeof extendGraceRequestSchema>;

export const exportAuditLogQuerySchema = z
  .object({
    productId: z.string().optional(),
    actorId: z.string().optional(),
    action: z.string().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    format: z.enum(['json', 'ndjson']).default('json'),
    limit: z.coerce.number().int().min(1).max(10_000).default(1000),
  })
  .strict();
export type ExportAuditLogQuery = z.infer<typeof exportAuditLogQuerySchema>;

// -- V1.1-D Admin listings (paginated lookups for admin-web) -----------
export const adminListQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    q: z.string().trim().min(1).max(200).optional(),
    status: z.string().min(1).max(40).optional(),
  })
  .strict();
export type AdminListQuery = z.infer<typeof adminListQuerySchema>;

export const searchAllUsersQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type SearchAllUsersQuery = z.infer<typeof searchAllUsersQuerySchema>;

// -- V1.1-D Announcements (Screen 12) ----------------------------------
const announcementBase = {
  productId: z.string().min(1).nullable().optional(),
  title: z.string().trim().min(2).max(200),
  body: z.string().trim().min(2).max(5000),
  severity: z.enum(['info', 'warning', 'critical']).default('info'),
  audience: z
    .enum(['all_users', 'product_admins', 'super_admin_only'])
    .default('all_users'),
  expiresAt: z.string().datetime().nullable().optional(),
};

export const createAnnouncementRequestSchema = z.object(announcementBase).strict();
export type CreateAnnouncementRequest = z.infer<typeof createAnnouncementRequestSchema>;

export const updateAnnouncementRequestSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    body: z.string().trim().min(2).max(5000).optional(),
    severity: z.enum(['info', 'warning', 'critical']).optional(),
    audience: z
      .enum(['all_users', 'product_admins', 'super_admin_only'])
      .optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict();
export type UpdateAnnouncementRequest = z.infer<typeof updateAnnouncementRequestSchema>;

export const listAnnouncementsQuerySchema = z
  .object({
    productId: z.string().optional(),
    includeArchived: z.coerce.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ListAnnouncementsQuery = z.infer<typeof listAnnouncementsQuerySchema>;
