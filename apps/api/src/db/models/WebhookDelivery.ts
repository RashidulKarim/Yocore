import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.13 `webhookDeliveries` — YoCore → Product event log. */
const webhookDeliverySchema = new Schema(
  {
    _id: { type: String, default: idDefault('whd') },
    productId: { type: String, required: true },
    event: { type: String, required: true },
    eventId: { type: String, required: true },
    url: { type: String, required: true },
    payloadRef: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: null },
    /** Webhook envelope version (FIX YC-016). Stamped from product.webhookPayloadVersion at enqueue time. */
    payloadVersion: { type: String, default: '2026-04-23' },
    /** Once archived, the inline `payload` is cleared and the gzipped JSON lives in S3 at this key. */
    payloadS3Key: { type: String, default: null },
    payloadS3Bucket: { type: String, default: null },
    payloadArchivedAt: { type: Date, default: null },
    signatureHeader: { type: String, default: null },
    status: {
      type: String,
      enum: ['PENDING', 'DELIVERED', 'FAILED', 'DEAD'],
      default: 'PENDING',
    },
    attempts: {
      type: [
        new Schema(
          {
            at: { type: Date, required: true },
            statusCode: { type: Number, default: null },
            durationMs: { type: Number, default: null },
            error: { type: String, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    attemptCount: { type: Number, default: 0 },
    nextRetryAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: true }, collection: 'webhookDeliveries' },
);

webhookDeliverySchema.index({ status: 1, nextRetryAt: 1 });
webhookDeliverySchema.index({ productId: 1, status: 1, nextRetryAt: 1 });
webhookDeliverySchema.index({ productId: 1, createdAt: -1 });
webhookDeliverySchema.index({ eventId: 1 }, { unique: true });
// V1.1-E archive scan: find DELIVERED/DEAD rows older than N days that still carry inline payloads.
webhookDeliverySchema.index({ status: 1, payloadArchivedAt: 1, deliveredAt: 1 });
webhookDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 7_776_000 }); // 90d

export type WebhookDeliveryDoc = InferSchemaType<typeof webhookDeliverySchema> & { _id: string };
export const WebhookDelivery: Model<WebhookDeliveryDoc> = model<WebhookDeliveryDoc>(
  'WebhookDelivery',
  webhookDeliverySchema,
);
