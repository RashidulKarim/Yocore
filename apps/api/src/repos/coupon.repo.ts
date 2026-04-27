/**
 * Coupon repository — `coupons` collection (Flow AF — Phase 3.4 Wave 8).
 *
 * Coupons may be either product-scoped (`productId` set) or platform-wide
 * (`productId === null`, super-admin only). All other queries from
 * product code MUST pass `productId` and the repo enforces the OR with
 * platform-wide via `$or`.
 */
import { Coupon, type CouponDoc } from '../db/models/Coupon.js';

export type CouponLean = CouponDoc;

export interface CreateCouponInput {
  productId: string | null;
  code: string;
  discountType: 'percent' | 'fixed';
  amount: number;
  currency?: string | null;
  duration: 'once' | 'repeating' | 'forever';
  durationInMonths?: number | null;
  maxUses?: number | null;
  maxUsesPerCustomer?: number;
  planIds?: string[] | null;
  expiresAt?: Date | null;
  createdBy?: string | null;
  gatewayRefs?: { stripeCouponId?: string | null };
}

export async function createCoupon(input: CreateCouponInput): Promise<CouponLean> {
  const doc = await Coupon.create({
    productId: input.productId,
    code: input.code,
    codeNormalized: input.code.toLowerCase(),
    discountType: input.discountType,
    amount: input.amount,
    currency: input.currency ?? null,
    duration: input.duration,
    durationInMonths: input.durationInMonths ?? null,
    maxUses: input.maxUses ?? null,
    usedCount: 0,
    maxUsesPerCustomer: input.maxUsesPerCustomer ?? 1,
    planIds: input.planIds ?? null,
    expiresAt: input.expiresAt ?? null,
    status: 'ACTIVE',
    gatewayRefs: input.gatewayRefs ?? { stripeCouponId: null },
    createdBy: input.createdBy ?? null,
  });
  return doc.toObject() as CouponLean;
}

/** Find a coupon by code for the given product. Falls back to platform-wide. */
export async function findByCode(
  productId: string,
  code: string,
): Promise<CouponLean | null> {
  return Coupon.findOne({
    codeNormalized: code.toLowerCase(),
    $or: [{ productId }, { productId: null }],
  }).lean<CouponLean | null>();
}

export async function findById(couponId: string): Promise<CouponLean | null> {
  return Coupon.findById(couponId).lean<CouponLean | null>();
}

export async function listForProduct(productId: string): Promise<CouponLean[]> {
  return Coupon.find({ $or: [{ productId }, { productId: null }] })
    .sort({ createdAt: -1 })
    .lean<CouponLean[]>();
}

export async function setStatus(
  couponId: string,
  status: 'ACTIVE' | 'DISABLED' | 'EXPIRED',
): Promise<CouponLean | null> {
  return Coupon.findByIdAndUpdate(
    couponId,
    { $set: { status } },
    { new: true },
  ).lean<CouponLean | null>();
}

export async function incrementUsedCount(couponId: string): Promise<void> {
  await Coupon.updateOne({ _id: couponId }, { $inc: { usedCount: 1 } });
}

export async function deleteCoupon(couponId: string): Promise<boolean> {
  const res = await Coupon.deleteOne({ _id: couponId });
  return (res.deletedCount ?? 0) > 0;
}
