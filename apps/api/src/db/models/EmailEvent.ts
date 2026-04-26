import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.23 `emailEvents` — Inbound delivery webhooks (Resend / SES). */
const emailEventSchema = new Schema(
  {
    _id: { type: String, default: idDefault('evt') },
    provider: { type: String, enum: ['resend', 'ses'], required: true },
    providerMessageId: { type: String, required: true },
    toAddress: { type: String, required: true, lowercase: true },
    userId: { type: String, default: null },
    productId: { type: String, default: null },
    event: {
      type: String,
      enum: ['delivered', 'bounced', 'complained', 'opened', 'clicked'],
      required: true,
    },
    bounceType: { type: String, enum: ['hard', 'soft', null], default: null },
    ts: { type: Date, default: () => new Date() },
    rawPayload: { type: Schema.Types.Mixed, default: {} },
    _v: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'emailEvents' },
);

emailEventSchema.index({ providerMessageId: 1, event: 1 });
emailEventSchema.index({ userId: 1, event: 1, ts: -1 });
emailEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 15_552_000 });

export type EmailEventDoc = InferSchemaType<typeof emailEventSchema> & { _id: string };
export const EmailEvent: Model<EmailEventDoc> = model<EmailEventDoc>('EmailEvent', emailEventSchema);
