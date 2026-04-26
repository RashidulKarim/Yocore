import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.2 `sessions` — Active auth sessions (one per user × product × device). */
const sessionSchema = new Schema(
  {
    _id: { type: String, default: idDefault('ses') },
    userId: { type: String, required: true },
    productId: { type: String, required: true },
    workspaceId: { type: String, default: null },
    refreshTokenHash: { type: String, required: true },
    refreshTokenFamilyId: { type: String, required: true },
    jwtId: { type: String, required: true },
    rememberMe: { type: Boolean, default: false },

    device: {
      userAgent: { type: String, default: null },
      ip: { type: String, default: null },
      fingerprint: { type: String, default: null },
      geo: {
        country: { type: String, default: null },
        city: { type: String, default: null },
      },
    },

    createdAt: { type: Date, default: () => new Date() },
    lastUsedAt: { type: Date, default: () => new Date() },
    refreshExpiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: {
      type: String,
      enum: ['user_logout', 'admin', 'refresh_reuse', 'password_change', 'mfa_reset', 'rotated', null],
      default: null,
    },
  },
  { collection: 'sessions' },
);

sessionSchema.index({ refreshTokenHash: 1 }, { unique: true });
sessionSchema.index({ userId: 1, productId: 1, revokedAt: 1 });
sessionSchema.index({ refreshExpiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ refreshTokenFamilyId: 1 });

export type SessionDoc = InferSchemaType<typeof sessionSchema> & { _id: string };
export const Session: Model<SessionDoc> = model<SessionDoc>('Session', sessionSchema);
