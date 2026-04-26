import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §7.8 `couponRedemptions` — Per-customer redemption ledger. */
const couponRedemptionSchema = new Schema(
  {
    _id: { type: String, default: idDefault('cprd') },
    couponId: { type: String, required: true },
    productId: { type: String, required: true },
    userId: { type: String, required: true },
    workspaceId: { type: String, default: null },
    subscriptionId: { type: String, required: true },
    redeemedAt: { type: Date, default: () => new Date() },
    discountAmount: { type: Number, required: true },
    currency: { type: String, default: 'usd', lowercase: true },
  },
  { collection: 'couponRedemptions' },
);

couponRedemptionSchema.index({ couponId: 1, userId: 1 });
couponRedemptionSchema.index({ subscriptionId: 1 });

export type CouponRedemptionDoc = InferSchemaType<typeof couponRedemptionSchema> & { _id: string };
export const CouponRedemption: Model<CouponRedemptionDoc> = model<CouponRedemptionDoc>(
  'CouponRedemption',
  couponRedemptionSchema,
);
