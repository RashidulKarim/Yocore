import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.16 `webhookEventsProcessed` — Inbound dedup (FIX-G1). */
const webhookEventProcessedSchema = new Schema(
  {
    _id: { type: String, default: idDefault('wep') },
    provider: { type: String, enum: ['stripe', 'sslcommerz', 'paypal', 'paddle'], required: true },
    eventId: { type: String, required: true },
    productId: { type: String, default: null },
    processedAt: { type: Date, default: () => new Date() },
    handlerAction: { type: String, default: null },
  },
  { collection: 'webhookEventsProcessed' },
);

webhookEventProcessedSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventProcessedSchema.index({ processedAt: 1 }, { expireAfterSeconds: 7_776_000 });

export type WebhookEventProcessedDoc = InferSchemaType<typeof webhookEventProcessedSchema> & {
  _id: string;
};
export const WebhookEventProcessed: Model<WebhookEventProcessedDoc> = model<WebhookEventProcessedDoc>(
  'WebhookEventProcessed',
  webhookEventProcessedSchema,
);
