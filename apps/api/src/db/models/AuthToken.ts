import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.3 `authTokens` — Single-use tokens (verify, reset, magic link, PKCE code, ...). */
const authTokenSchema = new Schema(
  {
    _id: { type: String, default: idDefault('atk') },
    userId: { type: String, required: true, index: true },
    productId: { type: String, default: null },
    type: {
      type: String,
      enum: [
        'email_verify',
        'password_reset',
        'email_change',
        'product_join_confirm',
        'magic_link',
        'pkce_code',
      ],
      required: true,
    },
    tokenHash: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    createdAt: { type: Date, default: () => new Date() },
    ip: { type: String, default: null },
  },
  { collection: 'authTokens' },
);

authTokenSchema.index({ tokenHash: 1 }, { unique: true });
authTokenSchema.index({ userId: 1, type: 1 });
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type AuthTokenDoc = InferSchemaType<typeof authTokenSchema> & { _id: string };
export const AuthToken: Model<AuthTokenDoc> = model<AuthTokenDoc>('AuthToken', authTokenSchema);
