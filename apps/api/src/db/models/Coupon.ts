import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §7.2 `coupons` (GAP-18). */
const couponSchema = new Schema(
  {
    _id: { type: String, default: idDefault('cpn') },
    productId: { type: String, default: null },
    code: { type: String, required: true },
    codeNormalized: { type: String, required: true, lowercase: true },
    discountType: { type: String, enum: ['percent', 'fixed'], required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: null },
    duration: { type: String, enum: ['once', 'repeating', 'forever'], default: 'once' },
    durationInMonths: { type: Number, default: null },
    maxUses: { type: Number, default: null },
    usedCount: { type: Number, default: 0 },
    maxUsesPerCustomer: { type: Number, default: 1 },
    planIds: { type: [String], default: null },
    expiresAt: { type: Date, default: null },
    status: { type: String, enum: ['ACTIVE', 'DISABLED', 'EXPIRED'], default: 'ACTIVE' },
    gatewayRefs: {
      // No default: field is absent when not set so sparse unique index skips it.
      stripeCouponId: { type: String },
    },
    createdBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'coupons' },
);

couponSchema.index({ productId: 1, codeNormalized: 1 }, { unique: true });
couponSchema.index({ status: 1, expiresAt: 1 });
couponSchema.index({ 'gatewayRefs.stripeCouponId': 1 }, { sparse: true, unique: true });

export type CouponDoc = InferSchemaType<typeof couponSchema> & { _id: string };
export const Coupon: Model<CouponDoc> = model<CouponDoc>('Coupon', couponSchema);
