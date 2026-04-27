import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.10 + §7.1 + §3.2 v1.7 `subscriptions`. */
const subscriptionSchema = new Schema(
  {
    _id: { type: String, default: idDefault('sub') },
    // Bundle parents have productId=bundleId (sentinel) and planId=bundleId
    // (sentinel; never resolved as a plan). See §5.7.
    productId: { type: String, required: true },
    planId: { type: String, required: true },

    subjectType: { type: String, enum: ['user', 'workspace'], required: true },
    subjectUserId: { type: String, default: null },
    subjectWorkspaceId: { type: String, default: null },

    gateway: {
      type: String,
      enum: ['stripe', 'sslcommerz', 'paypal', 'paddle', null],
      default: null,
    },
    gatewayRefs: { type: Schema.Types.Mixed, default: {} },

    status: {
      type: String,
      enum: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE', 'PAUSED'],
      required: true,
    },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    canceledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },

    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    trialStartsAt: { type: Date, default: null },
    trialEndsAt: { type: Date, default: null },

    quantity: { type: Number, default: 1 },

    paymentFailedAt: { type: Date, default: null },
    graceEmailsSent: {
      day1: { type: Boolean, default: false },
      day5: { type: Boolean, default: false },
      day7: { type: Boolean, default: false },
    },

    amount: { type: Number, default: 0 },
    currency: { type: String, default: 'usd', lowercase: true },

    // grandfathering (v1.7)
    planVersion: { type: Number, default: 1 },
    planSnapshotAt: { type: Date, default: null },
    planLimitsSnapshot: { type: Schema.Types.Mixed, default: null },

    lastWebhookEventId: { type: String, default: null },
    lastWebhookProcessedAt: { type: Date, default: null },

    // v1.5 additions
    renewalLinkSentAt: { type: Date, default: null },
    renewalLinkExpiresAt: { type: Date, default: null },
    renewalLinkRequestCount: { type: Number, default: 0 },

    pausedAt: { type: Date, default: null },
    resumeAt: { type: Date, default: null },

    refundedAt: { type: Date, default: null },
    refundAmount: { type: Number, default: 0 },
    refundReason: { type: String, default: null },
    refundPending: { type: Boolean, default: false },

    couponId: { type: String, default: null },
    creditBalance: { type: Number, default: 0 },

    isBundleParent: { type: Boolean, default: false },
    bundleSubscriptionId: { type: String, default: null },
    bundleId: { type: String, default: null },
    bundleComponentMeta: {
      type: new Schema(
        {
          gracePolicy: { type: String, default: 'bundle' },
          originalStandaloneSubId: { type: String, default: null },
        },
        { _id: false },
      ),
      default: null,
    },

    // Wave 5 — scheduled plan change (used for SSLCommerz next-renewal swaps
    // and for Flow AO grace-period auto-downgrades).
    pendingPlanChange: {
      type: new Schema(
        {
          newPlanId: { type: String, required: true },
          newAmount: { type: Number, required: true },
          newCurrency: { type: String, required: true, lowercase: true },
          scheduledFor: { type: Date, required: true },
          requestedAt: { type: Date, required: true },
          requestedBy: { type: String, default: null },
          reason: { type: String, default: null },
        },
        { _id: false },
      ),
      default: null,
    },

    changeHistory: {
      type: [
        new Schema(
          {
            changedAt: { type: Date, required: true },
            changedBy: { type: String, required: true },
            type: { type: String, required: true },
            before: { type: Schema.Types.Mixed, default: null },
            after: { type: Schema.Types.Mixed, default: null },
            reason: { type: String, default: null },
            correlationId: { type: String, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true, collection: 'subscriptions' },
);

subscriptionSchema.index({ productId: 1, subjectWorkspaceId: 1, status: 1 });
subscriptionSchema.index({ productId: 1, subjectUserId: 1, status: 1 });
subscriptionSchema.index(
  { 'gatewayRefs.stripeSubscriptionId': 1 },
  { sparse: true, unique: true },
);
subscriptionSchema.index(
  { 'gatewayRefs.paypalSubscriptionId': 1 },
  { sparse: true, unique: true },
);
subscriptionSchema.index(
  { 'gatewayRefs.paddleSubscriptionId': 1 },
  { sparse: true, unique: true },
);
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });
subscriptionSchema.index({ status: 1, trialEndsAt: 1 });
subscriptionSchema.index({ status: 1, paymentFailedAt: 1 });
subscriptionSchema.index({ status: 1, renewalLinkExpiresAt: 1 }, { sparse: true });
subscriptionSchema.index({ status: 1, resumeAt: 1 }, { sparse: true });
subscriptionSchema.index({ isBundleParent: 1, status: 1 });
subscriptionSchema.index({ bundleSubscriptionId: 1 }, { sparse: true });
subscriptionSchema.index({ bundleId: 1, status: 1 }, { sparse: true });

export type SubscriptionDoc = InferSchemaType<typeof subscriptionSchema> & { _id: string };
export const Subscription: Model<SubscriptionDoc> = model<SubscriptionDoc>(
  'Subscription',
  subscriptionSchema,
);
