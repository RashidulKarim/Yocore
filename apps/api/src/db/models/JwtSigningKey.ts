import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.21 `jwtSigningKeys` — Dual-keyring rotation registry. */
const jwtSigningKeySchema = new Schema(
  {
    _id: { type: String, default: idDefault('kid') },
    algorithm: { type: String, enum: ['EdDSA', 'RS256'], default: 'EdDSA' },
    publicKey: { type: String, required: true },
    /** AES-256-GCM envelope-encrypted private key (string token from `lib/encryption.ts`). */
    privateKeyEncrypted: { type: String, required: true },
    status: { type: String, enum: ['active', 'verifying', 'retired'], required: true },
    activatedAt: { type: Date, default: () => new Date() },
    rotatedAt: { type: Date, default: null },
    verifyUntil: { type: Date, default: null },
    retiredAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'jwtSigningKeys' },
);

jwtSigningKeySchema.index({ status: 1, activatedAt: -1 });
jwtSigningKeySchema.index(
  { status: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);

export type JwtSigningKeyDoc = InferSchemaType<typeof jwtSigningKeySchema> & { _id: string };
export const JwtSigningKey: Model<JwtSigningKeyDoc> = model<JwtSigningKeyDoc>(
  'JwtSigningKey',
  jwtSigningKeySchema,
);
