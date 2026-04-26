import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.18 `mfaFactors` — TOTP secrets + recovery codes. */
const mfaFactorSchema = new Schema(
  {
    _id: { type: String, default: idDefault('mfa') },
    userId: { type: String, required: true },
    productId: { type: String, default: null },
    type: { type: String, enum: ['totp', 'recovery_code'], required: true },

    // TOTP fields
    secretEncrypted: { type: String, default: null },
    issuer: { type: String, default: 'YoCore' },
    accountLabel: { type: String, default: null },
    algorithm: { type: String, default: 'SHA1' },
    digits: { type: Number, default: 6 },
    period: { type: Number, default: 30 },
    verifiedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    lastUsedCounter: { type: Number, default: 0 },

    // Recovery code fields
    codeHash: { type: String, default: null },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'mfaFactors' },
);

mfaFactorSchema.index({ userId: 1, type: 1, verifiedAt: 1 });
// Unique verified-TOTP per (user, product). Non-verified rows and recovery codes are unaffected.
mfaFactorSchema.index(
  { userId: 1, productId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { type: 'totp', verifiedAt: { $ne: null } },
  },
);

export type MfaFactorDoc = InferSchemaType<typeof mfaFactorSchema> & { _id: string };
export const MfaFactor: Model<MfaFactorDoc> = model<MfaFactorDoc>('MfaFactor', mfaFactorSchema);
