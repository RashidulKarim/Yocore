/**
 * Outbound webhook payload schemas (V1.0-E / V1.0-F).
 *
 * Every outbound webhook envelope is:
 *   {
 *     id:        string  (unique event id; matches WebhookDelivery._id),
 *     type:      string  (event name; see WebhookEventType),
 *     createdAt: string  (ISO timestamp),
 *     apiVersion: string (per-product webhookPayloadVersion, see PRD \u00a73.8),
 *     data:      <event-specific payload>,
 *   }
 *
 * The signature header is `t=<unix>,v1=<hex>` over the raw JSON body.
 * SDK consumers verify with `verifyWebhookSignature()` from `@yocore/sdk`.
 */
import { z } from 'zod';

// ── Event type catalog (PRD \u00a73.8) ────────────────────────────────────
export const WebhookEventTypes = {
  // Auth lifecycle
  USER_CREATED: 'user.created',
  USER_DELETED: 'user.deleted',
  USER_EMAIL_CHANGED: 'user.email_changed',

  // Workspace lifecycle
  WORKSPACE_CREATED: 'workspace.created',
  WORKSPACE_DELETED: 'workspace.deleted',
  WORKSPACE_OWNERSHIP_TRANSFERRED: 'workspace.ownership_transferred',
  WORKSPACE_MEMBER_ROLE_CHANGED: 'workspace.member_role_changed',

  // Subscription lifecycle (standalone)
  SUBSCRIPTION_ACTIVATED: 'subscription.activated',
  SUBSCRIPTION_TRIAL_STARTED: 'subscription.trial_started',
  SUBSCRIPTION_TRIAL_EXPIRED: 'subscription.trial_expired',
  SUBSCRIPTION_PLAN_CHANGED: 'subscription.plan_changed',
  SUBSCRIPTION_SEATS_CHANGED: 'subscription.seats_changed',
  SUBSCRIPTION_PAUSED: 'subscription.paused',
  SUBSCRIPTION_RESUMED: 'subscription.resumed',
  SUBSCRIPTION_CANCELED: 'subscription.canceled',
  SUBSCRIPTION_PAYMENT_FAILED: 'subscription.payment_failed',
  SUBSCRIPTION_PAYMENT_RECOVERED: 'subscription.payment_recovered',
  SUBSCRIPTION_GRACE_STARTED: 'subscription.grace_started',
  SUBSCRIPTION_GRACE_ENDED: 'subscription.grace_ended',
  SUBSCRIPTION_REFUNDED: 'subscription.refunded',

  // Bundle lifecycle
  BUNDLE_SUBSCRIPTION_ACTIVATED: 'bundle.subscription.activated',
  BUNDLE_SUBSCRIPTION_CANCELED: 'bundle.subscription.canceled',
  BUNDLE_ARCHIVED: 'bundle.archived',
} as const;
export type WebhookEventType =
  (typeof WebhookEventTypes)[keyof typeof WebhookEventTypes];

// ── Common subjects ─────────────────────────────────────────────────────
const subjectSchema = z.object({
  type: z.enum(['user', 'workspace']),
  userId: z.string().nullable(),
  workspaceId: z.string().nullable(),
});

const subscriptionPayloadSchema = z.object({
  subscriptionId: z.string(),
  productId: z.string(),
  planId: z.string(),
  status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE', 'PAUSED']),
  subject: subjectSchema,
  quantity: z.number().int().positive(),
  currentPeriodStart: z.string().datetime().nullable(),
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  trialEndsAt: z.string().datetime().nullable(),
});

const bundleSubscriptionPayloadSchema = z.object({
  bundleId: z.string(),
  parentSubscriptionId: z.string(),
  componentSubscriptionIds: z.array(z.string()),
  subject: subjectSchema,
  status: z.enum(['TRIALING', 'ACTIVE', 'CANCELED', 'PAUSED']),
  currentPeriodStart: z.string().datetime().nullable(),
  currentPeriodEnd: z.string().datetime().nullable(),
});

// ── Generic envelope ────────────────────────────────────────────────────
export function webhookEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    id: z.string(),
    type: z.string(),
    createdAt: z.string().datetime(),
    apiVersion: z.string(),
    data: dataSchema,
  });
}

// ── Per-event envelopes ────────────────────────────────────────────────
export const subscriptionWebhookEnvelopeSchema = webhookEnvelopeSchema(
  subscriptionPayloadSchema,
);
export type SubscriptionWebhookEnvelope = z.infer<
  typeof subscriptionWebhookEnvelopeSchema
>;

export const bundleSubscriptionWebhookEnvelopeSchema = webhookEnvelopeSchema(
  bundleSubscriptionPayloadSchema,
);
export type BundleSubscriptionWebhookEnvelope = z.infer<
  typeof bundleSubscriptionWebhookEnvelopeSchema
>;

export const userWebhookEnvelopeSchema = webhookEnvelopeSchema(
  z.object({
    userId: z.string(),
    productId: z.string(),
    email: z.string().email(),
    previousEmail: z.string().email().optional(),
  }),
);
export type UserWebhookEnvelope = z.infer<typeof userWebhookEnvelopeSchema>;

export const workspaceWebhookEnvelopeSchema = webhookEnvelopeSchema(
  z.object({
    workspaceId: z.string(),
    productId: z.string(),
    ownerUserId: z.string(),
    previousOwnerUserId: z.string().optional(),
    name: z.string(),
    slug: z.string(),
  }),
);
export type WorkspaceWebhookEnvelope = z.infer<typeof workspaceWebhookEnvelopeSchema>;

/**
 * `workspace.member_role_changed` — emitted whenever a workspace member's
 * role assignment is updated via `PATCH /v1/workspaces/:id/members/:userId`.
 * Subscribers (e.g. EasyStock) should use this to invalidate any cached
 * permissions/role data they hold for the affected user.
 */
export const workspaceMemberRoleChangedWebhookEnvelopeSchema = webhookEnvelopeSchema(
  z.object({
    workspaceId: z.string(),
    productId: z.string(),
    userId: z.string(),
    previousRoleSlug: z.string(),
    newRoleSlug: z.string(),
    changedByUserId: z.string(),
    changedAt: z.string().datetime(),
  }),
);
export type WorkspaceMemberRoleChangedWebhookEnvelope = z.infer<
  typeof workspaceMemberRoleChangedWebhookEnvelopeSchema
>;

// ── Status enums (round-trip) ──────────────────────────────────────────
export const WebhookDeliveryStatuses = {
  PENDING: 'PENDING',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  DEAD: 'DEAD',
} as const;
export type WebhookDeliveryStatus =
  (typeof WebhookDeliveryStatuses)[keyof typeof WebhookDeliveryStatuses];
