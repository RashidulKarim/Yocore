/**
 * Coupon redemption ledger — `couponRedemptions` collection.
 * Used to enforce `maxUsesPerCustomer` (Flow AF).
 */
import { CouponRedemption, type CouponRedemptionDoc } from '../db/models/CouponRedemption.js';

export type CouponRedemptionLean = CouponRedemptionDoc;

export async function recordRedemption(input: {
  couponId: string;
  productId: string;
  userId: string;
  workspaceId?: string | null;
  subscriptionId: string;
  discountAmount: number;
  currency: string;
}): Promise<CouponRedemptionLean> {
  const doc = await CouponRedemption.create({
    couponId: input.couponId,
    productId: input.productId,
    userId: input.userId,
    workspaceId: input.workspaceId ?? null,
    subscriptionId: input.subscriptionId,
    redeemedAt: new Date(),
    discountAmount: input.discountAmount,
    currency: input.currency.toLowerCase(),
  });
  return doc.toObject() as CouponRedemptionLean;
}

export async function countForCustomer(
  couponId: string,
  userId: string,
): Promise<number> {
  return CouponRedemption.countDocuments({ couponId, userId });
}

export async function listForSubscription(
  subscriptionId: string,
): Promise<CouponRedemptionLean[]> {
  return CouponRedemption.find({ subscriptionId })
    .sort({ redeemedAt: -1 })
    .lean<CouponRedemptionLean[]>();
}
