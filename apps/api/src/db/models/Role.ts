import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.8 `roles` — Per-product role definitions. */
const roleSchema = new Schema(
  {
    _id: { type: String, default: idDefault('role') },
    productId: { type: String, required: true },
    slug: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    isPlatform: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false },
    permissions: { type: [String], default: [] },
    inheritsFrom: { type: String, default: null },
  },
  { timestamps: true, collection: 'roles' },
);

roleSchema.index({ productId: 1, slug: 1 }, { unique: true });

export type RoleDoc = InferSchemaType<typeof roleSchema> & { _id: string };
export const Role: Model<RoleDoc> = model<RoleDoc>('Role', roleSchema);
