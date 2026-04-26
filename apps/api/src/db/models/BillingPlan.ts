import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.9 + §3.2 v1.7 `billingPlans` — Plan definitions per product. */
const billingPlanSchema = new Schema(
  {
    _id: { type: String, default: idDefault('plan') },
    productId: { type: String, required: true },
    name: { type: String, required: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, default: null },

    isFree: { type: Boolean, default: false },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: 'usd', lowercase: true },
    interval: { type: String, enum: ['month', 'year', 'one_time'], default: 'month' },
    intervalCount: { type: Number, default: 1 },
    trialDays: { type: Number, default: 0 },

    gatewayPriceIds: {
      stripe: { type: String, default: null },
      sslcommerz: { type: String, default: null },
      paypal: { type: String, default: null },
      paddle: { type: String, default: null },
    },

    limits: { type: Schema.Types.Mixed, default: {} },

    seatBased: { type: Boolean, default: false },
    perSeatAmount: { type: Number, default: null },
    includedSeats: { type: Number, default: null },

    // v1.7 metered billing
    isMetered: { type: Boolean, default: false },
    usageTiers: {
      type: [{ _id: false, upTo: { type: Number, default: null }, unitPrice: Number }],
      default: [],
    },
    metricNames: { type: [String], default: [] },
    usageHardCap: { type: Number, default: null },
    usageHardCapAction: {
      type: String,
      enum: ['block', 'alert_only', null],
      default: null,
    },

    status: { type: String, enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'], default: 'DRAFT' },
    visibility: { type: String, enum: ['public', 'private', 'grandfathered'], default: 'public' },

    createdBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'billingPlans' },
);

billingPlanSchema.index({ productId: 1, slug: 1 }, { unique: true });
billingPlanSchema.index({ productId: 1, status: 1, visibility: 1 });

export type BillingPlanDoc = InferSchemaType<typeof billingPlanSchema> & { _id: string };
export const BillingPlan: Model<BillingPlanDoc> = model<BillingPlanDoc>(
  'BillingPlan',
  billingPlanSchema,
);
