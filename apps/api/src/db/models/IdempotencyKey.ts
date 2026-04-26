import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §7.7 `idempotencyKeys` — Mutation dedup mirror (primary store is Redis). */
const idempotencyKeySchema = new Schema(
  {
    _id: { type: String, default: idDefault('idem') },
    productId: { type: String, default: null },
    scope: { type: String, required: true },
    key: { type: String, required: true },
    endpoint: { type: String, required: true },
    requestBodyHash: { type: String, required: true },
    responseStatus: { type: Number, required: true },
    responseBody: { type: Schema.Types.Mixed, default: {} },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'idempotencyKeys' },
);

idempotencyKeySchema.index({ productId: 1, scope: 1, key: 1 }, { unique: true });
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type IdempotencyKeyDoc = InferSchemaType<typeof idempotencyKeySchema> & { _id: string };
export const IdempotencyKey: Model<IdempotencyKeyDoc> = model<IdempotencyKeyDoc>(
  'IdempotencyKey',
  idempotencyKeySchema,
);
