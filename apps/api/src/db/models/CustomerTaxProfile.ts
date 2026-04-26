import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.32 v1.7 `customerTaxProfiles` — B2B tax identity. */
const customerTaxProfileSchema = new Schema(
  {
    _id: { type: String, default: idDefault('ctp') },
    userId: { type: String, required: true },
    workspaceId: { type: String, required: false },
    productId: { type: String, required: true },

    taxIdType: { type: String, required: true },
    taxIdValue: { type: String, required: true },
    verificationStatus: {
      type: String,
      enum: ['unverified', 'pending', 'verified', 'invalid'],
      default: 'unverified',
    },
    verificationDetails: { type: Schema.Types.Mixed, default: null },
    gatewayTaxIdRef: { type: String, default: null },

    billingName: { type: String, default: null },
    billingAddressLine1: { type: String, default: null },
    billingAddressLine2: { type: String, default: null },
    billingCity: { type: String, default: null },
    billingPostalCode: { type: String, default: null },
    billingState: { type: String, default: null },
    billingCountry: { type: String, default: null },

    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'customerTaxProfiles' },
);

// YC-005: partialFilterExpression so user-billed profiles (workspaceId absent) don't collide with workspace-billed
customerTaxProfileSchema.index(
  { userId: 1, productId: 1 },
  { unique: true, partialFilterExpression: { workspaceId: { $exists: false } } },
);
customerTaxProfileSchema.index(
  { workspaceId: 1, productId: 1 },
  { unique: true, partialFilterExpression: { workspaceId: { $exists: true } } },
);
customerTaxProfileSchema.index({ taxIdType: 1, taxIdValue: 1 });

export type CustomerTaxProfileDoc = InferSchemaType<typeof customerTaxProfileSchema> & {
  _id: string;
};
export const CustomerTaxProfile: Model<CustomerTaxProfileDoc> = model<CustomerTaxProfileDoc>(
  'CustomerTaxProfile',
  customerTaxProfileSchema,
);
