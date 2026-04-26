import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §7.6 `mfaRecoveryRequests` — End-user MFA recovery (B-01). */
const mfaRecoveryRequestSchema = new Schema(
  {
    _id: { type: String, default: idDefault('mfarr') },
    userId: { type: String, required: true },
    productId: { type: String, required: true },
    emailHash: { type: String, required: true },
    tokenHash: { type: String, required: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'EXPIRED', 'FAILED'],
      default: 'PENDING',
    },
    expiresAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'mfaRecoveryRequests' },
);

mfaRecoveryRequestSchema.index({ tokenHash: 1 }, { unique: true });
mfaRecoveryRequestSchema.index({ userId: 1, productId: 1, createdAt: -1 });
mfaRecoveryRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type MfaRecoveryRequestDoc = InferSchemaType<typeof mfaRecoveryRequestSchema> & {
  _id: string;
};
export const MfaRecoveryRequest: Model<MfaRecoveryRequestDoc> = model<MfaRecoveryRequestDoc>(
  'MfaRecoveryRequest',
  mfaRecoveryRequestSchema,
);
