/**
 * Subscription repository — `subscriptions` collection.
 *
 * Multi-tenant: every query scoped by `productId` (FIX-MT / ADR-001).
 * Owned by Phase 3.4 Wave 2+ (Flow J / G / R / N / etc.).
 */
import { Subscription, type SubscriptionDoc } from '../db/models/Subscription.js';

export type SubscriptionLean = SubscriptionDoc;

export type SubscriptionStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELED'
  | 'INCOMPLETE'
  | 'PAUSED';

export type GatewayName = 'stripe' | 'sslcommerz' | 'paypal' | 'paddle';

export interface CreateSubscriptionInput {
  productId: string;
  planId: string;
  subjectType: 'user' | 'workspace';
  subjectUserId?: string | null;
  subjectWorkspaceId?: string | null;
  gateway: GatewayName | null;
  gatewayRefs?: Record<string, unknown>;
  status: SubscriptionStatus;
  amount: number;
  currency: string;
  quantity?: number;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  trialStartsAt?: Date | null;
  trialEndsAt?: Date | null;
  lastWebhookEventId?: string | null;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<SubscriptionLean> {
  const doc = await Subscription.create({
    productId: input.productId,
    planId: input.planId,
    subjectType: input.subjectType,
    subjectUserId: input.subjectUserId ?? null,
    subjectWorkspaceId: input.subjectWorkspaceId ?? null,
    gateway: input.gateway,
    gatewayRefs: input.gatewayRefs ?? {},
    status: input.status,
    amount: input.amount,
    currency: input.currency.toLowerCase(),
    quantity: input.quantity ?? 1,
    currentPeriodStart: input.currentPeriodStart ?? null,
    currentPeriodEnd: input.currentPeriodEnd ?? null,
    trialStartsAt: input.trialStartsAt ?? null,
    trialEndsAt: input.trialEndsAt ?? null,
    lastWebhookEventId: input.lastWebhookEventId ?? null,
    lastWebhookProcessedAt: input.lastWebhookEventId ? new Date() : null,
  });
  return doc.toObject() as SubscriptionLean;
}

export async function findById(
  productId: string,
  subscriptionId: string,
): Promise<SubscriptionLean | null> {
  return Subscription.findOne({
    productId,
    _id: subscriptionId,
  }).lean<SubscriptionLean | null>();
}

/** Find by Stripe subscription id. NOT scoped by productId because the
 *  webhook handler doesn't know productId yet — but the unique sparse
 *  index on `gatewayRefs.stripeSubscriptionId` makes this safe. */
export async function findByStripeSubscriptionId(
  stripeSubscriptionId: string,
): Promise<SubscriptionLean | null> {
  return Subscription.findOne({
    'gatewayRefs.stripeSubscriptionId': stripeSubscriptionId,
  }).lean<SubscriptionLean | null>();
}

/** Find any existing Stripe customer for this user (for J1.2b dedup). */
export async function findStripeCustomerForUser(
  productId: string,
  userId: string,
): Promise<string | null> {
  const sub = await Subscription.findOne({
    productId,
    subjectUserId: userId,
    'gatewayRefs.stripeCustomerId': { $exists: true, $ne: null },
  })
    .select({ 'gatewayRefs.stripeCustomerId': 1 })
    .lean<{ gatewayRefs?: { stripeCustomerId?: string } } | null>();
  return sub?.gatewayRefs?.stripeCustomerId ?? null;
}

/** Find an existing subscription for this subject + product (single-active rule). */
export async function findActiveBySubject(args: {
  productId: string;
  subjectType: 'user' | 'workspace';
  subjectUserId?: string | null;
  subjectWorkspaceId?: string | null;
}): Promise<SubscriptionLean | null> {
  const q: Record<string, unknown> = {
    productId: args.productId,
    status: { $in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'INCOMPLETE'] },
  };
  if (args.subjectType === 'workspace' && args.subjectWorkspaceId) {
    q['subjectWorkspaceId'] = args.subjectWorkspaceId;
  } else if (args.subjectType === 'user' && args.subjectUserId) {
    q['subjectUserId'] = args.subjectUserId;
  } else {
    return null;
  }
  return Subscription.findOne(q).lean<SubscriptionLean | null>();
}

export interface UpsertFromStripeSessionInput {
  productId: string;
  planId: string;
  subjectType: 'user' | 'workspace';
  subjectUserId?: string | null;
  subjectWorkspaceId?: string | null;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripeLatestInvoiceId?: string | null;
  status: SubscriptionStatus;
  amount: number;
  currency: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  lastWebhookEventId: string;
}

/** Idempotent upsert keyed on `gatewayRefs.stripeSubscriptionId`. */
export async function upsertFromStripeSession(
  input: UpsertFromStripeSessionInput,
): Promise<SubscriptionLean> {
  const now = new Date();
  const doc = await Subscription.findOneAndUpdate(
    { 'gatewayRefs.stripeSubscriptionId': input.stripeSubscriptionId },
    {
      $set: {
        productId: input.productId,
        planId: input.planId,
        subjectType: input.subjectType,
        subjectUserId: input.subjectUserId ?? null,
        subjectWorkspaceId: input.subjectWorkspaceId ?? null,
        gateway: 'stripe',
        'gatewayRefs.stripeCustomerId': input.stripeCustomerId,
        'gatewayRefs.stripeSubscriptionId': input.stripeSubscriptionId,
        'gatewayRefs.stripeLatestInvoiceId': input.stripeLatestInvoiceId ?? null,
        status: input.status,
        amount: input.amount,
        currency: input.currency.toLowerCase(),
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        lastWebhookEventId: input.lastWebhookEventId,
        lastWebhookProcessedAt: now,
      },
      $setOnInsert: { quantity: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean<SubscriptionLean | null>();
  if (!doc) throw new Error('upsertFromStripeSession returned null');
  return doc;
}

// ── SSLCommerz (Flow J4) ──────────────────────────────────────────────

export interface CreateSslcommerzPendingInput {
  productId: string;
  planId: string;
  subjectType: 'user' | 'workspace';
  subjectUserId?: string | null;
  subjectWorkspaceId?: string | null;
  amount: number;
  currency: string; // 'bdt'
  quantity?: number;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripeLatestInvoiceId: string;
  sslcommerzTranId: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}

/** Create the INCOMPLETE subscription row for an SSLCommerz checkout. */
export async function createSslcommerzPending(
  input: CreateSslcommerzPendingInput,
): Promise<SubscriptionLean> {
  const doc = await Subscription.create({
    productId: input.productId,
    planId: input.planId,
    subjectType: input.subjectType,
    subjectUserId: input.subjectUserId ?? null,
    subjectWorkspaceId: input.subjectWorkspaceId ?? null,
    gateway: 'sslcommerz',
    gatewayRefs: {
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripeLatestInvoiceId: input.stripeLatestInvoiceId,
      sslcommerzTranId: input.sslcommerzTranId,
      sslcommerzValId: null,
    },
    status: 'INCOMPLETE',
    amount: input.amount,
    currency: input.currency.toLowerCase(),
    quantity: input.quantity ?? 1,
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
  });
  return doc.toObject() as SubscriptionLean;
}

/** Find an SSLCommerz subscription by `tran_id` (across products — the
 *  IPN handler doesn't know productId until the row is found). */
export async function findBySslcommerzTranId(
  tranId: string,
): Promise<SubscriptionLean | null> {
  return Subscription.findOne({
    'gatewayRefs.sslcommerzTranId': tranId,
  }).lean<SubscriptionLean | null>();
}

/** Activate an SSLCommerz subscription after IPN double-validation. */
export async function activateSslcommerzSubscription(args: {
  subscriptionId: string;
  sslcommerzValId: string;
  currentPeriodEnd: Date | null;
  lastWebhookEventId: string;
}): Promise<SubscriptionLean | null> {
  return Subscription.findOneAndUpdate(
    { _id: args.subscriptionId },
    {
      $set: {
        status: 'ACTIVE',
        'gatewayRefs.sslcommerzValId': args.sslcommerzValId,
        currentPeriodEnd: args.currentPeriodEnd,
        lastWebhookEventId: args.lastWebhookEventId,
        lastWebhookProcessedAt: new Date(),
      },
    },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

/** Mark an SSLCommerz subscription PAST_DUE — used by Flow J4.11 desync guard. */
export async function markPastDue(subscriptionId: string): Promise<void> {
  await Subscription.updateOne(
    { _id: subscriptionId },
    { $set: { status: 'PAST_DUE' } },
  );
}
