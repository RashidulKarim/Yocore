import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * §7.1 `superAdminConfig` — Singleton document.
 * Always read/write with `_id: "super_admin_config"`.
 */
const superAdminConfigSchema = new Schema(
  {
    _id: { type: String, default: 'super_admin_config' },
    adminIpAllowlist: { type: [String], default: [] },
    adminIpAllowlistEnabled: { type: Boolean, default: false },
    updatedBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'superAdminConfig' },
);

export type SuperAdminConfigDoc = InferSchemaType<typeof superAdminConfigSchema> & { _id: string };
export const SuperAdminConfig: Model<SuperAdminConfigDoc> = model<SuperAdminConfigDoc>(
  'SuperAdminConfig',
  superAdminConfigSchema,
);
