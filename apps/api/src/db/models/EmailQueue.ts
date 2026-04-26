import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.22 `emailQueue` — Outbound mail with retry. */
const emailQueueSchema = new Schema(
  {
    _id: { type: String, default: idDefault('mq') },
    productId: { type: String, default: null },
    userId: { type: String, default: null },
    toAddress: { type: String, required: true, lowercase: true },
    fromAddress: { type: String, required: true },
    fromName: { type: String, default: null },
    subject: { type: String, required: true },
    templateId: { type: String, required: true },
    templateData: { type: Schema.Types.Mixed, default: {} },

    provider: { type: String, enum: ['resend', 'ses'], default: 'resend' },
    providerMessageId: { type: String, default: null },
    status: {
      type: String,
      enum: ['PENDING', 'SENT', 'FAILED', 'DEAD'],
      default: 'PENDING',
    },
    attempts: { type: [Schema.Types.Mixed], default: [] },
    attemptCount: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    sentAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    priority: { type: String, enum: ['critical', 'normal', 'bulk'], default: 'normal' },
    category: {
      type: String,
      enum: ['transactional', 'billing', 'marketing', 'security'],
      default: 'transactional',
    },
    _v: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'emailQueue' },
);

emailQueueSchema.index({ status: 1, nextAttemptAt: 1, priority: 1 });
emailQueueSchema.index({ providerMessageId: 1 }, { sparse: true });
emailQueueSchema.index({ userId: 1, category: 1, createdAt: -1 });
emailQueueSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7_776_000 });

export type EmailQueueDoc = InferSchemaType<typeof emailQueueSchema> & { _id: string };
export const EmailQueue: Model<EmailQueueDoc> = model<EmailQueueDoc>('EmailQueue', emailQueueSchema);
