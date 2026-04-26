import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §7.5 `tosVersions` — Published Terms / Privacy versions (B-05). */
const tosVersionSchema = new Schema(
  {
    _id: { type: String, default: idDefault('tosv') },
    type: { type: String, enum: ['terms_of_service', 'privacy_policy'], required: true },
    version: { type: String, required: true },
    publishedAt: { type: Date, default: () => new Date() },
    effectiveAt: { type: Date, required: true },
    contentUrl: { type: String, required: true },
    contentHash: { type: String, required: true },
    changeSummary: { type: String, default: null },
    publishedBy: { type: String, required: true },
    isCurrent: { type: Boolean, default: false },
    _v: { type: Number, default: 1 },
  },
  { collection: 'tosVersions' },
);

tosVersionSchema.index({ type: 1, version: 1 }, { unique: true });
tosVersionSchema.index(
  { type: 1, isCurrent: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true } },
);

export type TosVersionDoc = InferSchemaType<typeof tosVersionSchema> & { _id: string };
export const TosVersion: Model<TosVersionDoc> = model<TosVersionDoc>('TosVersion', tosVersionSchema);
