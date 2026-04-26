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
    signatureHeader: { type: String, default: null },
    status: {
      type: String,
      enum: ['PENDING', 'DELIVERED', 'FAILED', 'DEAD'],
      default: 'PENDING',
    },
    attempts: {
      type: [
        {
          _id: false,
          at: Date,
          statusCode: Number,
          durationMs: Number,
          error: String,
        },
      ],
      default: [],
    },
    attemptCount: { type: Number, default: 0 },
    nextRetryAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'webhookDeliveries' },
);

webhookDeliverySchema.index({ productId: 1, status: 1, nextRetryAt: 1 });
webhookDeliverySchema.index({ eventId: 1 }, { unique: true });
webhookDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 7_776_000 }); // 90d

export type WebhookDeliveryDoc = InferSchemaType<typeof webhookDeliverySchema> & { _id: string };
export const WebhookDelivery: Model<WebhookDeliveryDoc> = model<WebhookDeliveryDoc>(
  'WebhookDelivery',
  webhookDeliverySchema,
);
