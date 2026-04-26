import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.20 `deletionRequests` — Soft-delete grace tracking (30d). */
const deletionRequestSchema = new Schema(
  {
    _id: { type: String, default: idDefault('del') },
    userId: { type: String, required: true },
    scope: { type: String, enum: ['product', 'account'], required: true },
    productId: { type: String, default: null },
    requestedAt: { type: Date, default: () => new Date() },
    finalizeAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ['PENDING', 'CANCELED', 'FINALIZED', 'BLOCKED'],
      default: 'PENDING',
    },
    blockedReason: { type: String, default: null },
    blockedDetails: { type: Schema.Types.Mixed, default: {} },
    canceledAt: { type: Date, default: null },
    finalizedAt: { type: Date, default: null },
    finalizedByCronRun: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'deletionRequests' },
);

deletionRequestSchema.index({ userId: 1, status: 1 });
deletionRequestSchema.index({ status: 1, finalizeAt: 1 });
deletionRequestSchema.index(
  { userId: 1, productId: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING' } },
);

export type DeletionRequestDoc = InferSchemaType<typeof deletionRequestSchema> & { _id: string };
export const DeletionRequest: Model<DeletionRequestDoc> = model<DeletionRequestDoc>(
  'DeletionRequest',
  deletionRequestSchema,
);
