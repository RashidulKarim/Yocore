/**
 * Bundle repository — `bundles` collection.
 *
 * Bundles are GLOBAL (no productId scope — they span products by definition).
 * See ADR-001 §3 (allowed unscoped collections) and System-Design §1.15 / §5.7.
 *
 * Owned by Phase 3.5 (Flow AL).
 */
import { Bundle, type BundleDoc } from '../db/models/Bundle.js';
import { Subscription } from '../db/models/Subscription.js';

export type BundleLean = BundleDoc;

export interface BundleComponent {
  productId: string;
  planId: string;
}

export interface BundleCurrencyVariant {
  currency: string;
  amount: number;
  gatewayPriceIds?: Record<string, string | null>;
}

export interface BundleComponentPriceOverride {
  productId: string;
  amount: number;
}

export interface CreateBundleInput {
  name: string;
  slug: string;
  description?: string | null;
  heroImageUrl?: string | null;
  components: BundleComponent[];
  pricingModel: 'fixed' | 'percent_discount' | 'per_component_override';
  amount?: number | null;
  percentDiscount?: number | null;
  componentPriceOverrides?: BundleComponentPriceOverride[];
  currency: string;
  currencyVariants: BundleCurrencyVariant[];
  interval: 'month' | 'year';
  intervalCount: number;
  trialDays: number;
  componentSeats?: Record<string, number>;
  eligibilityPolicy: 'block' | 'cancel_and_credit' | 'replace_immediately';
  visibility: 'public' | 'unlisted' | 'private';
  maxRedemptions?: number | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
}

export async function createBundle(input: CreateBundleInput): Promise<BundleLean> {
  const doc = await Bundle.create({
    name: input.name,
    slug: input.slug.toLowerCase(),
    description: input.description ?? null,
    heroImageUrl: input.heroImageUrl ?? null,
    components: input.components,
    pricingModel: input.pricingModel,
    amount: input.amount ?? null,
    percentDiscount: input.percentDiscount ?? null,
    componentPriceOverrides: input.componentPriceOverrides ?? [],
    currency: input.currency.toLowerCase(),
    currencyVariants: input.currencyVariants.map((v) => ({
      currency: v.currency.toLowerCase(),
      amount: v.amount,
      gatewayPriceIds: v.gatewayPriceIds ?? {},
    })),
    interval: input.interval,
    intervalCount: input.intervalCount,
    trialDays: input.trialDays,
    componentSeats: input.componentSeats ?? {},
    eligibilityPolicy: input.eligibilityPolicy,
    visibility: input.visibility,
    maxRedemptions: input.maxRedemptions ?? null,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    metadata: input.metadata ?? {},
    createdBy: input.createdBy ?? null,
    status: 'DRAFT',
    changeHistory: [
      {
        changedAt: new Date(),
        changedBy: input.createdBy ?? 'system',
        type: 'created',
      },
    ],
  });
  return doc.toObject() as BundleLean;
}

export async function findBundleById(bundleId: string): Promise<BundleLean | null> {
  return Bundle.findById(bundleId).lean<BundleLean | null>();
}

export async function findBundleBySlug(slug: string): Promise<BundleLean | null> {
  return Bundle.findOne({ slug: slug.toLowerCase() }).lean<BundleLean | null>();
}

export async function listBundles(filter: {
  status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  visibility?: 'public' | 'unlisted' | 'private';
  productId?: string;
}): Promise<BundleLean[]> {
  const q: Record<string, unknown> = {};
  if (filter.status) q['status'] = filter.status;
  if (filter.visibility) q['visibility'] = filter.visibility;
  if (filter.productId) q['components.productId'] = filter.productId;
  return Bundle.find(q).sort({ createdAt: -1 }).lean<BundleLean[]>();
}

export async function updateBundleFields(
  bundleId: string,
  patch: Record<string, unknown>,
): Promise<BundleLean | null> {
  if (Object.keys(patch).length === 0) return findBundleById(bundleId);
  return Bundle.findByIdAndUpdate(bundleId, { $set: patch }, { new: true }).lean<BundleLean | null>();
}

export async function appendBundleChangeHistory(
  bundleId: string,
  entry: {
    changedAt: Date;
    changedBy: string;
    type: string;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
  },
): Promise<void> {
  await Bundle.updateOne({ _id: bundleId }, { $push: { changeHistory: entry } });
}

export async function setBundleStatus(
  bundleId: string,
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED',
  extra: Record<string, unknown> = {},
): Promise<BundleLean | null> {
  return Bundle.findByIdAndUpdate(
    bundleId,
    { $set: { status, ...extra } },
    { new: true },
  ).lean<BundleLean | null>();
}

/**
 * Atomically increment redemptionCount, with maxRedemptions guard. Returns
 * the new bundle doc, or null if the bundle hit its cap (and therefore the
 * checkout should be rejected). The caller is responsible for archiving the
 * bundle when count == maxRedemptions afterwards.
 */
export async function incrementRedemptionCount(bundleId: string): Promise<BundleLean | null> {
  const bundle = await Bundle.findById(bundleId).lean<BundleLean | null>();
  if (!bundle) return null;
  if (bundle.maxRedemptions != null && bundle.redemptionCount >= bundle.maxRedemptions) {
    return null;
  }
  // Optimistic guard: only increment if (maxRedemptions == null OR count < max).
  const updated = await Bundle.findOneAndUpdate(
    {
      _id: bundleId,
      $or: [
        { maxRedemptions: null },
        { $expr: { $lt: ['$redemptionCount', '$maxRedemptions'] } },
      ],
    },
    { $inc: { redemptionCount: 1 } },
    { new: true },
  ).lean<BundleLean | null>();
  return updated;
}

/** Add a granted-access entry (private bundles). */
export async function addBundleGrantedAccess(
  bundleId: string,
  entry: { userId?: string | null; workspaceId?: string | null; grantedBy: string },
): Promise<BundleLean | null> {
  return Bundle.findByIdAndUpdate(
    bundleId,
    {
      $push: {
        grantedAccess: {
          userId: entry.userId ?? null,
          workspaceId: entry.workspaceId ?? null,
          grantedBy: entry.grantedBy,
          grantedAt: new Date(),
        },
      },
    },
    { new: true },
  ).lean<BundleLean | null>();
}

/** Set gatewayPriceIds on a specific currency variant. */
export async function setBundleCurrencyVariantGatewayId(
  bundleId: string,
  currency: string,
  gateway: string,
  priceId: string,
): Promise<void> {
  await Bundle.updateOne(
    { _id: bundleId, 'currencyVariants.currency': currency.toLowerCase() },
    { $set: { [`currencyVariants.$.gatewayPriceIds.${gateway}`]: priceId } },
  );
}

/** Count subscriptions referencing this bundle (parents + children). */
export async function countBundleSubscriptions(bundleId: string): Promise<number> {
  return Subscription.countDocuments({
    $or: [{ bundleId }, { bundleSubscriptionId: { $exists: true, $ne: null } }],
    bundleId,
  });
}

/** Hard-delete a bundle row (only when zero subscriptions reference it). */
export async function hardDeleteBundle(bundleId: string): Promise<boolean> {
  const res = await Bundle.deleteOne({ _id: bundleId });
  return (res.deletedCount ?? 0) > 0;
}
