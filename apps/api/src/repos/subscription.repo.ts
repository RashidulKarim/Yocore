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

// ── Trial flow (Flow G — Phase 3.4 Wave 4) ────────────────────────────

export interface CreateTrialingInput {
  productId: string;
  planId: string;
  subjectType: 'user' | 'workspace';
  subjectUserId?: string | null;
  subjectWorkspaceId?: string | null;
  amount: number;
  currency: string;
  quantity?: number;
  trialStartsAt: Date;
  trialEndsAt: Date;
}

/** Create a TRIALING subscription with no gateway attached (Flow G Path 2). */
export async function createTrialing(
  input: CreateTrialingInput,
): Promise<SubscriptionLean> {
  const doc = await Subscription.create({
    productId: input.productId,
    planId: input.planId,
    subjectType: input.subjectType,
    subjectUserId: input.subjectUserId ?? null,
    subjectWorkspaceId: input.subjectWorkspaceId ?? null,
    gateway: null,
    gatewayRefs: {},
    status: 'TRIALING',
    amount: input.amount,
    currency: input.currency.toLowerCase(),
    quantity: input.quantity ?? 1,
    currentPeriodStart: input.trialStartsAt,
    currentPeriodEnd: input.trialEndsAt,
    trialStartsAt: input.trialStartsAt,
    trialEndsAt: input.trialEndsAt,
  });
  return doc.toObject() as SubscriptionLean;
}

/** TRIALING subscriptions whose trial ends before `before`. Used by the
 *  cron for both warning emails (`before = now + 3d`) and expiry
 *  (`before = now`). Cross-tenant (the cron is global). */
export async function listTrialingDueBefore(before: Date): Promise<SubscriptionLean[]> {
  return Subscription.find({
    status: 'TRIALING',
    trialEndsAt: { $lte: before, $ne: null },
  })
    .sort({ trialEndsAt: 1 })
    .limit(500)
    .lean<SubscriptionLean[]>();
}

/** Cancel a TRIALING subscription that expired without a payment method
 *  (Flow G Path 2 Scenario B). Conditional on status to avoid races. */
export async function cancelTrialNoPaymentMethod(
  subscriptionId: string,
  at: Date,
): Promise<SubscriptionLean | null> {
  return Subscription.findOneAndUpdate(
    { _id: subscriptionId, status: 'TRIALING' },
    {
      $set: {
        status: 'CANCELED',
        canceledAt: at,
        cancelReason: 'trial_no_payment_method',
      },
    },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

// ── Plan change (Flow R / AE — Phase 3.4 Wave 5) ──────────────────────

export interface ChangeHistoryEntry {
  changedAt: Date;
  changedBy: string;
  type: 'plan_change' | 'plan_change_scheduled' | 'plan_archival_forced_downgrade';
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason?: string | null;
  correlationId?: string | null;
}

/** Apply a plan change immediately (Stripe path). Updates planId/amount/
 *  currency, optional gateway-ref patches, and pushes a `changeHistory`
 *  entry. Clears any prior `pendingPlanChange`. */
export async function applyPlanChange(args: {
  productId: string;
  subscriptionId: string;
  newPlanId: string;
  newAmount: number;
  newCurrency: string;
  currentPeriodEnd?: Date | null;
  gatewayRefsPatch?: Record<string, unknown>;
  history: ChangeHistoryEntry;
}): Promise<SubscriptionLean | null> {
  const set: Record<string, unknown> = {
    planId: args.newPlanId,
    amount: args.newAmount,
    currency: args.newCurrency.toLowerCase(),
    pendingPlanChange: null,
  };
  if (args.currentPeriodEnd !== undefined) {
    set['currentPeriodEnd'] = args.currentPeriodEnd;
  }
  if (args.gatewayRefsPatch) {
    for (const [k, v] of Object.entries(args.gatewayRefsPatch)) {
      set[`gatewayRefs.${k}`] = v;
    }
  }
  return Subscription.findOneAndUpdate(
    { _id: args.subscriptionId, productId: args.productId },
    {
      $set: set,
      $push: { changeHistory: args.history },
    },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

/** Schedule a plan change for the next renewal (SSLCommerz path).
 *  Records a `pendingPlanChange` blob + appends a `plan_change_scheduled`
 *  history entry. Does NOT mutate the live `planId/amount`. */
export async function setPendingPlanChange(args: {
  productId: string;
  subscriptionId: string;
  newPlanId: string;
  newAmount: number;
  newCurrency: string;
  scheduledFor: Date;
  requestedBy: string;
  reason?: string | null;
  history: ChangeHistoryEntry;
}): Promise<SubscriptionLean | null> {
  return Subscription.findOneAndUpdate(
    { _id: args.subscriptionId, productId: args.productId },
    {
      $set: {
        pendingPlanChange: {
          newPlanId: args.newPlanId,
          newAmount: args.newAmount,
          newCurrency: args.newCurrency.toLowerCase(),
          scheduledFor: args.scheduledFor,
          requestedAt: new Date(),
          requestedBy: args.requestedBy,
          reason: args.reason ?? null,
        },
      },
      $push: { changeHistory: args.history },
    },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

// ── Seat change (Flow S — Phase 3.4 Wave 6) ───────────────────────────

/** Update the `quantity` (seats) on a sub. Pushes a `seat_change` history
 *  entry. Used for both immediate (Stripe/TRIAL) and scheduled paths. */
export async function applySeatChange(args: {
  productId: string;
  subscriptionId: string;
  newQuantity: number;
  history: ChangeHistoryEntry;
}): Promise<SubscriptionLean | null> {
  return Subscription.findOneAndUpdate(
    { _id: args.subscriptionId, productId: args.productId },
    {
      $set: { quantity: args.newQuantity },
      $push: { changeHistory: args.history },
    },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

// ── Pause / Resume (Flow AC — Phase 3.4 Wave 7) ───────────────────────

export async function pauseSubscription(args: {
  productId: string;
  subscriptionId: string;
  pausedAt: Date;
  resumeAt?: Date | null;
  reason?: string | null;
}): Promise<SubscriptionLean | null> {
  return Subscription.findOneAndUpdate(
    { _id: args.subscriptionId, productId: args.productId, status: { $in: ['ACTIVE', 'PAST_DUE'] } },
    {
      $set: {
        status: 'PAUSED',
        pausedAt: args.pausedAt,
        resumeAt: args.resumeAt ?? null,
        cancelReason: args.reason ?? null,
      },
    },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

export async function resumeSubscription(args: {
  productId: string;
  subscriptionId: string;
}): Promise<SubscriptionLean | null> {
  return Subscription.findOneAndUpdate(
    { _id: args.subscriptionId, productId: args.productId, status: 'PAUSED' },
    {
      $set: { status: 'ACTIVE', pausedAt: null, resumeAt: null },
    },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

// ── Coupon attach (Flow AF — Phase 3.4 Wave 8) ────────────────────────

export async function attachCoupon(args: {
  productId: string;
  subscriptionId: string;
  couponId: string;
}): Promise<SubscriptionLean | null> {
  return Subscription.findOneAndUpdate(
    { _id: args.subscriptionId, productId: args.productId },
    { $set: { couponId: args.couponId } },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

// ── Refund (Flow AD — Phase 3.4 Wave 9) ───────────────────────────────

export async function recordRefund(args: {
  productId: string;
  subscriptionId: string;
  amount: number;
  reason: string;
  refundedAt: Date;
}): Promise<SubscriptionLean | null> {
  return Subscription.findOneAndUpdate(
    { _id: args.subscriptionId, productId: args.productId },
    {
      $set: {
        refundedAt: args.refundedAt,
        refundAmount: args.amount,
        refundReason: args.reason,
        refundPending: false,
      },
    },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

// ── Failed payment grace lifecycle (Flow N — Phase 3.4 Wave 11) ───────

/** Mark a sub PAST_DUE + paymentFailedAt; clears prior grace email flags
 *  so a new failure cycle restarts the cadence. */
export async function markPaymentFailed(args: {
  subscriptionId: string;
  failedAt: Date;
}): Promise<SubscriptionLean | null> {
  return Subscription.findOneAndUpdate(
    { _id: args.subscriptionId },
    {
      $set: {
        status: 'PAST_DUE',
        paymentFailedAt: args.failedAt,
        'graceEmailsSent.day1': false,
        'graceEmailsSent.day5': false,
        'graceEmailsSent.day7': false,
      },
    },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

/** Clear paymentFailedAt + status:ACTIVE on successful retry. */
export async function clearPaymentFailed(args: {
  subscriptionId: string;
  currentPeriodEnd?: Date | null;
}): Promise<SubscriptionLean | null> {
  const set: Record<string, unknown> = {
    status: 'ACTIVE',
    paymentFailedAt: null,
    'graceEmailsSent.day1': false,
    'graceEmailsSent.day5': false,
    'graceEmailsSent.day7': false,
  };
  if (args.currentPeriodEnd !== undefined) set['currentPeriodEnd'] = args.currentPeriodEnd;
  return Subscription.findOneAndUpdate(
    { _id: args.subscriptionId },
    { $set: set },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

/** Cross-tenant: list PAST_DUE subs with paymentFailedAt set. Used by
 *  `billing.grace.tick` cron. */
export async function listPastDueOlderThan(
  before: Date,
  limit = 500,
): Promise<SubscriptionLean[]> {
  return Subscription.find({
    status: 'PAST_DUE',
    paymentFailedAt: { $lte: before, $ne: null },
  })
    .sort({ paymentFailedAt: 1 })
    .limit(limit)
    .lean<SubscriptionLean[]>();
}

/** Mark a single grace-email bucket as sent (idempotent). */
export async function markGraceEmailSent(
  subscriptionId: string,
  bucket: 'day1' | 'day5' | 'day7',
): Promise<void> {
  await Subscription.updateOne(
    { _id: subscriptionId },
    { $set: { [`graceEmailsSent.${bucket}`]: true } },
  );
}

/** Cancel a sub during grace finalization (Day 7 / hard cap). */
export async function cancelForGrace(args: {
  subscriptionId: string;
  reason: string;
  at: Date;
}): Promise<SubscriptionLean | null> {
  return Subscription.findOneAndUpdate(
    { _id: args.subscriptionId, status: 'PAST_DUE' },
    {
      $set: {
        status: 'CANCELED',
        canceledAt: args.at,
        cancelReason: args.reason,
      },
    },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

/** Cancel any active sub for a subject (used by gateway migration). */
export async function cancelSubscription(args: {
  productId: string;
  subscriptionId: string;
  reason: string;
  at: Date;
}): Promise<SubscriptionLean | null> {
  return Subscription.findOneAndUpdate(
    { _id: args.subscriptionId, productId: args.productId },
    {
      $set: {
        status: 'CANCELED',
        canceledAt: args.at,
        cancelReason: args.reason,
      },
    },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

// ── Bundle support (Phase 3.5 — Flow T / AK) ──────────────────────────

export interface CreateBundleParentInput {
  bundleId: string;
  subjectType: 'user' | 'workspace';
  subjectUserId?: string | null;
  subjectWorkspaceId?: string | null;
  gateway: GatewayName;
  gatewayRefs: Record<string, unknown>;
  status: SubscriptionStatus;
  amount: number;
  currency: string;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  trialStartsAt?: Date | null;
  trialEndsAt?: Date | null;
  lastWebhookEventId?: string | null;
}

/** Create a bundle PARENT subscription. Parents have:
 *  - productId = bundleId (sentinel; bundles span products)
 *  - planId = null
 *  - isBundleParent = true
 *  - bundleId set
 *  See System-Design §5.7 step 4. */
export async function createBundleParent(
  input: CreateBundleParentInput,
): Promise<SubscriptionLean> {
  const doc = await Subscription.create({
    productId: input.bundleId, // sentinel (bundles are global)
    planId: input.bundleId, // sentinel — bundle parent has no plan
    bundleId: input.bundleId,
    isBundleParent: true,
    subjectType: input.subjectType,
    subjectUserId: input.subjectUserId ?? null,
    subjectWorkspaceId: input.subjectWorkspaceId ?? null,
    gateway: input.gateway,
    gatewayRefs: input.gatewayRefs,
    status: input.status,
    amount: input.amount,
    currency: input.currency.toLowerCase(),
    currentPeriodStart: input.currentPeriodStart ?? null,
    currentPeriodEnd: input.currentPeriodEnd ?? null,
    trialStartsAt: input.trialStartsAt ?? null,
    trialEndsAt: input.trialEndsAt ?? null,
    lastWebhookEventId: input.lastWebhookEventId ?? null,
    lastWebhookProcessedAt: input.lastWebhookEventId ? new Date() : null,
  });
  return doc.toObject() as SubscriptionLean;
}

export interface CreateBundleChildInput {
  productId: string;
  planId: string;
  bundleSubscriptionId: string;
  bundleId: string;
  subjectType: 'user' | 'workspace';
  subjectUserId?: string | null;
  subjectWorkspaceId?: string | null;
  status: SubscriptionStatus;
  amount: number;
  currency: string;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  trialStartsAt?: Date | null;
  trialEndsAt?: Date | null;
  originalStandaloneSubId?: string | null;
}

/** Create a bundle CHILD subscription (one per component product).
 *  Children have:
 *  - real productId + planId
 *  - gateway = null (parent owns billing)
 *  - bundleSubscriptionId = parent._id
 *  - bundleComponentMeta.gracePolicy = 'bundle'
 */
export async function createBundleChild(
  input: CreateBundleChildInput,
): Promise<SubscriptionLean> {
  const doc = await Subscription.create({
    productId: input.productId,
    planId: input.planId,
    bundleSubscriptionId: input.bundleSubscriptionId,
    bundleId: input.bundleId,
    bundleComponentMeta: {
      gracePolicy: 'bundle',
      originalStandaloneSubId: input.originalStandaloneSubId ?? null,
    },
    subjectType: input.subjectType,
    subjectUserId: input.subjectUserId ?? null,
    subjectWorkspaceId: input.subjectWorkspaceId ?? null,
    gateway: null,
    gatewayRefs: {},
    status: input.status,
    amount: input.amount,
    currency: input.currency.toLowerCase(),
    currentPeriodStart: input.currentPeriodStart ?? null,
    currentPeriodEnd: input.currentPeriodEnd ?? null,
    trialStartsAt: input.trialStartsAt ?? null,
    trialEndsAt: input.trialEndsAt ?? null,
  });
  return doc.toObject() as SubscriptionLean;
}

/** Find a bundle parent by id (cross-tenant lookup since bundles are global). */
export async function findBundleParentById(
  parentId: string,
): Promise<SubscriptionLean | null> {
  return Subscription.findOne({
    _id: parentId,
    isBundleParent: true,
  }).lean<SubscriptionLean | null>();
}

/** List bundle children for a parent. */
export async function listBundleChildren(
  parentId: string,
  opts: { excludeStatuses?: SubscriptionStatus[] } = {},
): Promise<SubscriptionLean[]> {
  const q: Record<string, unknown> = { bundleSubscriptionId: parentId };
  if (opts.excludeStatuses && opts.excludeStatuses.length > 0) {
    q['status'] = { $nin: opts.excludeStatuses };
  }
  return Subscription.find(q).lean<SubscriptionLean[]>();
}

/** List bundle parents that were canceled within the cascade window. */
export async function listCanceledBundleParents(
  sinceDate: Date,
  limit = 500,
): Promise<SubscriptionLean[]> {
  return Subscription.find({
    isBundleParent: true,
    status: 'CANCELED',
    canceledAt: { $gte: sinceDate, $ne: null },
  })
    .sort({ canceledAt: 1 })
    .limit(limit)
    .lean<SubscriptionLean[]>();
}

/** Mark a bundle PARENT canceled. Cross-tenant (parents have productId=bundleId). */
export async function cancelBundleParent(args: {
  subscriptionId: string;
  reason: string;
  at: Date;
  cancelAtPeriodEnd?: boolean;
}): Promise<SubscriptionLean | null> {
  const set: Record<string, unknown> = {
    cancelReason: args.reason,
  };
  if (args.cancelAtPeriodEnd) {
    set['cancelAtPeriodEnd'] = true;
  } else {
    set['status'] = 'CANCELED';
    set['canceledAt'] = args.at;
  }
  return Subscription.findOneAndUpdate(
    { _id: args.subscriptionId, isBundleParent: true },
    { $set: set },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

/** Cancel a bundle CHILD (used by AK cascade cron). */
export async function cancelBundleChild(args: {
  childId: string;
  reason: string;
  at: Date;
  changedBy: string;
}): Promise<SubscriptionLean | null> {
  return Subscription.findOneAndUpdate(
    { _id: args.childId, bundleSubscriptionId: { $ne: null } },
    {
      $set: {
        status: 'CANCELED',
        canceledAt: args.at,
        cancelReason: args.reason,
      },
      $push: {
        changeHistory: {
          changedAt: args.at,
          changedBy: args.changedBy,
          type: 'bundle_cascade_canceled',
          reason: args.reason,
        },
      },
    },
    { new: true },
  ).lean<SubscriptionLean | null>();
}

/** Find an active subscription for this subject across ANY component product
 *  in the bundle. Used by Flow T eligibility checks. */
export async function findActiveSubsForSubjectsAcrossProducts(
  subjects: Array<{ productId: string; subjectType: 'user' | 'workspace'; subjectUserId?: string; subjectWorkspaceId?: string }>,
): Promise<SubscriptionLean[]> {
  if (subjects.length === 0) return [];
  const orClauses = subjects.map((s) => {
    const clause: Record<string, unknown> = {
      productId: s.productId,
      status: { $in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED'] },
    };
    if (s.subjectType === 'workspace' && s.subjectWorkspaceId) {
      clause['subjectType'] = 'workspace';
      clause['subjectWorkspaceId'] = s.subjectWorkspaceId;
    } else if (s.subjectType === 'user' && s.subjectUserId) {
      clause['subjectType'] = 'user';
      clause['subjectUserId'] = s.subjectUserId;
    }
    return clause;
  });
  return Subscription.find({ $or: orClauses }).lean<SubscriptionLean[]>();
}
