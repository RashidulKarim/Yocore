/**
 * BillingPlan repository — `billingPlans` collection.
 *
 * Multi-tenant: every query scoped by `productId`. Repos NEVER call gateways
 * — that's the service. Repos return null (or counts) and let the service
 * decide error semantics.
 *
 * Owned by Phase 3.4 (Flow D / AO).
 */
import { BillingPlan, type BillingPlanDoc } from '../db/models/BillingPlan.js';
import { Subscription } from '../db/models/Subscription.js';

export type BillingPlanLean = BillingPlanDoc;

export type PlanStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type PlanVisibility = 'public' | 'private' | 'grandfathered';

export interface CreatePlanInput {
  productId: string;
  name: string;
  slug: string;
  description?: string | null;
  isFree?: boolean;
  amount?: number;
  currency?: string;
  interval?: 'month' | 'year' | 'one_time';
  intervalCount?: number;
  trialDays?: number;
  limits?: Record<string, unknown>;
  seatBased?: boolean;
  perSeatAmount?: number | null;
  includedSeats?: number | null;
  isMetered?: boolean;
  usageTiers?: Array<{ upTo: number | null; unitPrice: number }>;
  metricNames?: string[];
  usageHardCap?: number | null;
  usageHardCapAction?: 'block' | 'alert_only' | null;
  visibility?: PlanVisibility;
  createdBy?: string | null;
}

export async function createPlan(input: CreatePlanInput): Promise<BillingPlanLean> {
  const doc = await BillingPlan.create({
    productId: input.productId,
    name: input.name,
    slug: input.slug,
    description: input.description ?? null,
    isFree: input.isFree ?? false,
    amount: input.amount ?? 0,
    currency: (input.currency ?? 'usd').toLowerCase(),
    interval: input.interval ?? 'month',
    intervalCount: input.intervalCount ?? 1,
    trialDays: input.trialDays ?? 0,
    limits: input.limits ?? {},
    seatBased: input.seatBased ?? false,
    perSeatAmount: input.perSeatAmount ?? null,
    includedSeats: input.includedSeats ?? null,
    isMetered: input.isMetered ?? false,
    usageTiers: input.usageTiers ?? [],
    metricNames: input.metricNames ?? [],
    usageHardCap: input.usageHardCap ?? null,
    usageHardCapAction: input.usageHardCapAction ?? null,
    visibility: input.visibility ?? 'public',
    status: 'DRAFT',
    createdBy: input.createdBy ?? null,
  });
  return doc.toObject() as BillingPlanLean;
}

export async function findPlanById(
  productId: string,
  planId: string,
): Promise<BillingPlanLean | null> {
  return BillingPlan.findOne({ productId, _id: planId }).lean<BillingPlanLean | null>();
}

export async function findPlanBySlug(
  productId: string,
  slug: string,
): Promise<BillingPlanLean | null> {
  return BillingPlan.findOne({ productId, slug: slug.toLowerCase() }).lean<BillingPlanLean | null>();
}

export interface ListPlansFilter {
  status?: PlanStatus;
  visibility?: PlanVisibility;
}

export async function listPlans(
  productId: string,
  filter: ListPlansFilter = {},
): Promise<BillingPlanLean[]> {
  const q: Record<string, unknown> = { productId };
  if (filter.status) q['status'] = filter.status;
  if (filter.visibility) q['visibility'] = filter.visibility;
  return BillingPlan.find(q).sort({ amount: 1, createdAt: 1 }).lean<BillingPlanLean[]>();
}

export interface UpdatePlanPatch {
  name?: string;
  description?: string | null;
  amount?: number;
  currency?: string;
  interval?: 'month' | 'year' | 'one_time';
  intervalCount?: number;
  trialDays?: number;
  limits?: Record<string, unknown>;
  seatBased?: boolean;
  perSeatAmount?: number | null;
  includedSeats?: number | null;
  visibility?: PlanVisibility;
}

export async function updatePlan(
  productId: string,
  planId: string,
  patch: UpdatePlanPatch,
): Promise<BillingPlanLean | null> {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) set[k] = v;
  }
  if (Object.keys(set).length === 0) return findPlanById(productId, planId);
  return BillingPlan.findOneAndUpdate(
    { productId, _id: planId },
    { $set: set },
    { new: true },
  ).lean<BillingPlanLean | null>();
}

export async function setPlanStatus(
  productId: string,
  planId: string,
  status: PlanStatus,
): Promise<BillingPlanLean | null> {
  return BillingPlan.findOneAndUpdate(
    { productId, _id: planId },
    { $set: { status } },
    { new: true },
  ).lean<BillingPlanLean | null>();
}

export async function setStripePriceId(
  productId: string,
  planId: string,
  stripePriceId: string,
): Promise<BillingPlanLean | null> {
  return BillingPlan.findOneAndUpdate(
    { productId, _id: planId },
    { $set: { 'gatewayPriceIds.stripe': stripePriceId } },
    { new: true },
  ).lean<BillingPlanLean | null>();
}

/** Count subscriptions still attached to this plan in non-terminal states. */
export async function countActiveSubscriptionsForPlan(
  productId: string,
  planId: string,
): Promise<number> {
  return Subscription.countDocuments({
    productId,
    planId,
    status: { $in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'INCOMPLETE'] },
  });
}
