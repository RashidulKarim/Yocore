import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.31 v1.7 `usageRecords` — Metered billing events. */
const usageRecordSchema = new Schema(
  {
    _id: { type: String, default: idDefault('ur') },
    subscriptionId: { type: String, required: true },
    productId: { type: String, required: true },
    workspaceId: { type: String, default: null },
    userId: { type: String, default: null },

    metricName: { type: String, required: true },
    unit: { type: String, default: 'unit' },
    quantity: { type: Number, required: true },

    reportingMode: { type: String, enum: ['delta', 'total'], default: 'delta' },

    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },

    reportedAt: { type: Date, default: () => new Date() },
    reportedBy: { type: String, default: null },
    idempotencyKey: { type: String, required: true },

    processedAt: { type: Date, default: null },
    invoiceItemId: { type: String, default: null },
    lateSubmission: { type: Boolean, default: false },

    _v: { type: Number, default: 1 },
  },
  { collection: 'usageRecords' },
);

usageRecordSchema.index({ subscriptionId: 1, metricName: 1, periodStart: 1 });
// YC-004: idempotency unique key scoped to periodStart so same key may legitimately repeat across periods
usageRecordSchema.index(
  { subscriptionId: 1, metricName: 1, periodStart: 1, idempotencyKey: 1 },
  { unique: true },
);
usageRecordSchema.index({ processedAt: 1, periodEnd: 1 }, { sparse: true });
usageRecordSchema.index({ productId: 1, reportedAt: 1 });

export type UsageRecordDoc = InferSchemaType<typeof usageRecordSchema> & { _id: string };
export const UsageRecord: Model<UsageRecordDoc> = model<UsageRecordDoc>(
  'UsageRecord',
  usageRecordSchema,
);
