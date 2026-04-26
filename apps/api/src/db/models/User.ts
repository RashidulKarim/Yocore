import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/**
 * §1.1 `users` — Global identity anchor.
 * Email is the only truly global field. SUPER_ADMIN credentials live here;
 * END_USER credentials live in `productUsers`.
 */
const userSchema = new Schema(
  {
    _id: { type: String, default: idDefault('usr') },
    email: { type: String, required: true, lowercase: true, trim: true },
    emailNormalized: { type: String, required: true },

    // SUPER_ADMIN-only auth (null for END_USER)
    passwordHash: { type: String, default: null },
    passwordUpdatedAt: { type: Date, default: null },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    lastLoginIp: { type: String, default: null },

    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date, default: null },
    emailVerifiedMethod: {
      type: String,
      enum: ['email_link', 'invitation', 'oauth_google', 'oauth_github', null],
      default: null,
    },

    role: { type: String, enum: ['SUPER_ADMIN', 'END_USER'], default: 'END_USER', required: true },

    // v1.5 ToS / Privacy acceptance
    tosAcceptedAt: { type: Date, default: null },
    tosVersion: { type: String, default: null },
    privacyPolicyAcceptedAt: { type: Date, default: null },
    privacyPolicyVersion: { type: String, default: null },

    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'users' },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ emailNormalized: 1 });
userSchema.index({ createdAt: -1 });
// FIX-G3: Only one SUPER_ADMIN ever
userSchema.index(
  { role: 1 },
  { unique: true, partialFilterExpression: { role: 'SUPER_ADMIN' } },
);
userSchema.index({ tosVersion: 1 });

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: string };
export const User: Model<UserDoc> = model<UserDoc>('User', userSchema);
