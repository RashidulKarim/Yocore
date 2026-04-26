import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.15 `bundles` — Cross-product packages (v1.6 expanded). */
const bundleSchema = new Schema(
  {
    _id: { type: String, default: idDefault('bdl') },
    name: { type: String, required: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, default: null },
    heroImageUrl: { type: String, default: null },

    components: {
      type: [{ _id: false, productId: String, planId: String }],
      default: [],
    },

    pricingModel: {
      type: String,
      enum: ['fixed', 'percent_discount', 'per_component_override'],
      default: 'fixed',
    },
    amount: { type: Number, default: null },
    percentDiscount: { type: Number, default: null },
    componentPriceOverrides: {
      type: [{ _id: false, productId: String, amount: Number }],
      default: [],
    },
    currency: { type: String, default: 'usd', lowercase: true },

    currencyVariants: {
      type: [
        {
          _id: false,
          currency: String,
          amount: Number,
          gatewayPriceIds: Schema.Types.Mixed,
        },
      ],
      default: [],
    },

    interval: { type: String, enum: ['month', 'year'], default: 'month' },
    intervalCount: { type: Number, default: 1 },

    trialDays: { type: Number, default: 0 },

    componentSeats: { type: Schema.Types.Mixed, default: {} },

    eligibilityPolicy: {
      type: String,
      enum: ['block', 'cancel_and_credit', 'replace_immediately'],
      default: 'block',
    },

    visibility: { type: String, enum: ['public', 'unlisted', 'private'], default: 'public' },
    grantedAccess: {
      type: [
        {
          _id: false,
          userId: { type: String, default: null },
          workspaceId: { type: String, default: null },
          grantedBy: String,
          grantedAt: Date,
        },
      ],
      default: [],
    },

    maxRedemptions: { type: Number, default: null },
    redemptionCount: { type: Number, default: 0 },

    status: { type: String, enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'], default: 'DRAFT' },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },

    changeHistory: { type: [Schema.Types.Mixed], default: [] },
    metadata: { type: Schema.Types.Mixed, default: {} },

    createdBy: { type: String, default: null },
    publishedAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    _v: { type: Number, default: 2 },
  },
  { timestamps: true, collection: 'bundles' },
);

bundleSchema.index({ slug: 1 }, { unique: true });
bundleSchema.index({ status: 1 });
bundleSchema.index({ visibility: 1, status: 1 });
bundleSchema.index({ 'components.productId': 1, status: 1 });
bundleSchema.index({ 'grantedAccess.userId': 1 }, { sparse: true });
bundleSchema.index({ 'grantedAccess.workspaceId': 1 }, { sparse: true });

export type BundleDoc = InferSchemaType<typeof bundleSchema> & { _id: string };
export const Bundle: Model<BundleDoc> = model<BundleDoc>('Bundle', bundleSchema);
