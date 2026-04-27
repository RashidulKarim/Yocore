/**
 * Phase 3.4 Wave 5 — Plan upgrade / downgrade (Flow R + GAP-13/B-14 → Flow AE).
 *
 * Verifies:
 *   • GET preview returns Stripe proration math (stubbed) for an active sub.
 *   • Seat-overflow guard returns 402 BILLING_PLAN_MEMBER_OVERFLOW.
 *   • POST apply (Stripe path) calls Stripe update + persists planId/amount,
 *     pushes a `plan_change` history entry, and enqueues outbound webhook.
 *   • SSLCommerz subs schedule via `pendingPlanChange` (no live Stripe call).
 *   • TRIALING subs swap planId immediately in DB only.
 *   • Same-plan apply → 409 RESOURCE_CONFLICT.
 *   • Currency mismatch → 422 VALIDATION_FAILED.
 *   • Free target plan → 409 BILLING_DOWNGRADE_BLOCKED.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { getTestContext, resetDatabase } from '../../test/integration-setup.js';
import { signJwt } from '../lib/jwt.js';
import {
  createChangePlanService,
  type StripePlanApi,
} from '../services/change-plan.service.js';
import { Product } from '../db/models/Product.js';
import { PaymentGateway } from '../db/models/PaymentGateway.js';
import { Workspace } from '../db/models/Workspace.js';
import { WorkspaceMember } from '../db/models/WorkspaceMember.js';
import { Subscription } from '../db/models/Subscription.js';
import { WebhookDelivery } from '../db/models/WebhookDelivery.js';
import { BillingPlan } from '../db/models/BillingPlan.js';
import { User } from '../db/models/User.js';
import { ProductUser } from '../db/models/ProductUser.js';
import { encrypt } from '../lib/encryption.js';
import { hash as hashSecret } from '../lib/password.js';

const ACCESS_TTL = 900;

interface Fixture {
  productId: string;
  workspaceId: string;
  userId: string;
  planFromId: string;
  planToId: string;
  token: string;
}

interface FixtureOpts {
  fromPriceStripe?: string | null;
  toPriceStripe?: string | null;
  toLimitsMaxMembers?: number;
  fromCurrency?: string;
  toCurrency?: string;
  toIsFree?: boolean;
  extraMembers?: number;
}

async function buildFixture(slug: string, opts: FixtureOpts = {}): Promise<Fixture> {
  const { ctx } = await getTestContext();
  const apiSecretHash = await hashSecret('dummy');
  const product = await Product.create({
    name: 'P',
    slug,
    apiKey: `yc_live_pk_${randomBytes(8).toString('hex')}`,
    apiSecretHash,
    webhookSecret: randomBytes(32).toString('hex'),
    webhookUrl: 'https://example.test/webhooks',
    billingScope: 'workspace',
    status: 'ACTIVE',
    billingConfig: { gatewayRouting: { default: 'stripe', usd: 'stripe' } },
  });
  await PaymentGateway.create({
    productId: product._id,
    provider: 'stripe',
    mode: 'test',
    status: 'ACTIVE',
    credentialsEncrypted: { secretKey: encrypt('sk_test_dummy') },
    lastVerifiedAt: new Date(),
    lastVerificationStatus: 'ok',
    lastVerificationError: null,
  });

  const email = `u_${randomBytes(4).toString('hex')}@test.local`;
  const user = await User.create({
    email,
    emailNormalized: email,
    role: 'END_USER',
    emailVerified: true,
    emailVerifiedAt: new Date(),
  });
  await ProductUser.create({
    productId: product._id,
    userId: user._id,
    passwordHash: await hashSecret('Password!1234'),
    name: { first: 'Alice', last: 'A', display: 'Alice A' },
    status: 'ACTIVE',
    productRole: 'END_USER',
    joinedAt: new Date(),
  });

  const workspace = await Workspace.create({
    productId: product._id,
    name: 'WS',
    slug: 'ws',
    ownerUserId: user._id,
    billingContactUserId: user._id,
    status: 'ACTIVE',
  });
  await WorkspaceMember.create({
    workspaceId: workspace._id,
    productId: product._id,
    userId: user._id,
    roleId: 'role_owner',
    roleSlug: 'OWNER',
    status: 'ACTIVE',
    joinedAt: new Date(),
  });
  // Optional extra members (for seat-overflow tests).
  for (let i = 0; i < (opts.extraMembers ?? 0); i++) {
    const u = await User.create({
      email: `m${i}_${randomBytes(3).toString('hex')}@t.l`,
      emailNormalized: `m${i}_${randomBytes(3).toString('hex')}@t.l`,
      role: 'END_USER',
    });
    await WorkspaceMember.create({
      workspaceId: workspace._id,
      productId: product._id,
      userId: u._id,
      roleId: 'role_member',
      roleSlug: 'MEMBER',
      status: 'ACTIVE',
      joinedAt: new Date(),
    });
  }

  const planFrom = await BillingPlan.create({
    productId: product._id,
    name: 'Starter',
    slug: 'starter',
    isFree: false,
    amount: 1000,
    currency: opts.fromCurrency ?? 'usd',
    interval: 'month',
    intervalCount: 1,
    status: 'ACTIVE',
    visibility: 'public',
    gatewayPriceIds: { stripe: opts.fromPriceStripe ?? 'price_starter' },
  });
  const planTo = await BillingPlan.create({
    productId: product._id,
    name: 'Pro',
    slug: 'pro',
    isFree: opts.toIsFree ?? false,
    amount: opts.toIsFree ? 0 : 2900,
    currency: opts.toCurrency ?? 'usd',
    interval: 'month',
    intervalCount: 1,
    status: 'ACTIVE',
    visibility: 'public',
    limits: opts.toLimitsMaxMembers != null ? { maxMembers: opts.toLimitsMaxMembers } : {},
    gatewayPriceIds: { stripe: opts.toPriceStripe ?? 'price_pro' },
  });

  const jti = `jti_${randomBytes(4).toString('hex')}`;
  const token = await signJwt(ctx.keyring, {
    subject: user._id,
    ttlSeconds: ACCESS_TTL,
    purpose: 'access',
    jti,
    claims: { role: 'END_USER', pid: product._id, wid: workspace._id, scopes: [] },
  });
  await ctx.sessionStore.markActive(jti, ACCESS_TTL);

  return {
    productId: product._id,
    workspaceId: workspace._id,
    userId: user._id,
    planFromId: planFrom._id,
    planToId: planTo._id,
    token,
  };
}

interface StripeStubCalls {
  retrieve: number;
  upcoming: number;
  update: number;
  lastUpdate?: { subId: string; itemId: string; newPriceId: string };
}

function buildStripePlanApi(opts: {
  itemId?: string;
  upcomingAmountDue?: number;
  upcomingPeriodEnd?: number;
}): { api: StripePlanApi; calls: StripeStubCalls } {
  const calls: StripeStubCalls = { retrieve: 0, upcoming: 0, update: 0 };
  const itemId = opts.itemId ?? 'si_test_item';
  const api: StripePlanApi = {
    async retrieveSubscription({ subscriptionId }) {
      calls.retrieve += 1;
      return {
        customerId: 'cus_test',
        currentPeriodEnd: 1700000000,
        items: [{ id: itemId, priceId: 'price_starter', quantity: 1 }],
      };
    },
    async retrieveUpcomingInvoice() {
      calls.upcoming += 1;
      return {
        amountDue: opts.upcomingAmountDue ?? 1900,
        currency: 'usd',
        periodEnd: opts.upcomingPeriodEnd ?? 1700000000,
      };
    },
    async updateSubscription({ subscriptionId, subscriptionItemId, newPriceId }) {
      calls.update += 1;
      calls.lastUpdate = { subId: subscriptionId, itemId: subscriptionItemId, newPriceId };
      return { currentPeriodEnd: 1700000000, latestInvoiceId: 'in_test_new' };
    },
  };
  return { api, calls };
}

describe('Phase 3.4 Wave 5 — Plan change (Flow R / AE)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('GET preview returns Stripe proration math for an ACTIVE subscription', async () => {
    const { app, ctx } = await getTestContext();
    const fx = await buildFixture('cp1');
    const { api, calls } = buildStripePlanApi({ upcomingAmountDue: 1900 });
    ctx.changePlan = createChangePlanService({ stripePlanApi: api });

    await Subscription.create({
      productId: fx.productId,
      planId: fx.planFromId,
      subjectType: 'workspace',
      subjectWorkspaceId: fx.workspaceId,
      gateway: 'stripe',
      gatewayRefs: { stripeSubscriptionId: 'sub_live_1', stripeCustomerId: 'cus_test' },
      status: 'ACTIVE',
      amount: 1000,
      currency: 'usd',
      currentPeriodEnd: new Date(1700000000 * 1000),
    });

    const res = await request(app)
      .get('/v1/billing/subscription/change-plan/preview')
      .query({ newPlanId: fx.planToId, workspaceId: fx.workspaceId })
      .set('Authorization', `Bearer ${fx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.gateway).toBe('stripe');
    expect(res.body.prorationAmount).toBe(1900);
    expect(res.body.currency).toBe('usd');
    expect(calls.retrieve).toBe(1);
    expect(calls.upcoming).toBe(1);
  });

  it('preview returns 402 BILLING_PLAN_MEMBER_OVERFLOW when target plan caps members', async () => {
    const { app, ctx } = await getTestContext();
    const fx = await buildFixture('cp2', { toLimitsMaxMembers: 1, extraMembers: 2 });
    const { api } = buildStripePlanApi({});
    ctx.changePlan = createChangePlanService({ stripePlanApi: api });

    await Subscription.create({
      productId: fx.productId,
      planId: fx.planFromId,
      subjectType: 'workspace',
      subjectWorkspaceId: fx.workspaceId,
      gateway: 'stripe',
      gatewayRefs: { stripeSubscriptionId: 'sub_live_2' },
      status: 'ACTIVE',
      amount: 1000,
      currency: 'usd',
    });

    const res = await request(app)
      .get('/v1/billing/subscription/change-plan/preview')
      .query({ newPlanId: fx.planToId, workspaceId: fx.workspaceId })
      .set('Authorization', `Bearer ${fx.token}`);

    expect(res.status).toBe(402);
    expect(res.body.error).toBe('BILLING_PLAN_MEMBER_OVERFLOW');
    expect(res.body.details.currentMembers).toBe(3);
    expect(res.body.details.allowedMembers).toBe(1);
    expect(res.body.details.mustRemove).toBe(2);
  });

  it('POST apply on a Stripe sub updates the price + persists planId + emits webhook', async () => {
    const { app, ctx } = await getTestContext();
    const fx = await buildFixture('cp3');
    const { api, calls } = buildStripePlanApi({});
    ctx.changePlan = createChangePlanService({ stripePlanApi: api });

    const sub = await Subscription.create({
      productId: fx.productId,
      planId: fx.planFromId,
      subjectType: 'workspace',
      subjectWorkspaceId: fx.workspaceId,
      gateway: 'stripe',
      gatewayRefs: { stripeSubscriptionId: 'sub_live_3', stripeCustomerId: 'cus_test' },
      status: 'ACTIVE',
      amount: 1000,
      currency: 'usd',
    });

    const res = await request(app)
      .post('/v1/billing/subscription/change-plan')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({ newPlanId: fx.planToId, workspaceId: fx.workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.scheduled).toBe(false);
    expect(res.body.subscription.planId).toBe(fx.planToId);
    expect(res.body.subscription.amount).toBe(2900);
    expect(calls.update).toBe(1);
    expect(calls.lastUpdate?.newPriceId).toBe('price_pro');

    const fresh = await Subscription.findById(sub._id).lean();
    expect(fresh?.planId).toBe(fx.planToId);
    expect(fresh?.amount).toBe(2900);
    expect(fresh?.changeHistory?.length).toBe(1);
    expect(fresh?.changeHistory?.[0]?.type).toBe('plan_change');
    expect((fresh?.gatewayRefs as { stripeLatestInvoiceId?: string })?.stripeLatestInvoiceId).toBe(
      'in_test_new',
    );

    const deliveries = await WebhookDelivery.find({ productId: fx.productId }).lean();
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]?.event).toBe('subscription.plan_changed');
  });

  it('POST apply on an SSLCommerz sub schedules via pendingPlanChange (no Stripe call)', async () => {
    const { app, ctx } = await getTestContext();
    const fx = await buildFixture('cp4');
    const { api, calls } = buildStripePlanApi({});
    ctx.changePlan = createChangePlanService({ stripePlanApi: api });

    const periodEnd = new Date(Date.now() + 7 * 86_400_000);
    const sub = await Subscription.create({
      productId: fx.productId,
      planId: fx.planFromId,
      subjectType: 'workspace',
      subjectWorkspaceId: fx.workspaceId,
      gateway: 'sslcommerz',
      gatewayRefs: { sslcommerzTranId: 'yc_xx' },
      status: 'ACTIVE',
      amount: 1000,
      currency: 'usd',
      currentPeriodEnd: periodEnd,
    });

    const res = await request(app)
      .post('/v1/billing/subscription/change-plan')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({ newPlanId: fx.planToId, workspaceId: fx.workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.scheduled).toBe(true);
    // Live planId/amount unchanged; pendingPlanChange populated.
    expect(res.body.subscription.planId).toBe(fx.planFromId);

    const fresh = await Subscription.findById(sub._id).lean() as
      | (Record<string, unknown> & { pendingPlanChange?: { newPlanId: string } | null })
      | null;
    expect(fresh?.pendingPlanChange?.newPlanId).toBe(fx.planToId);
    expect(calls.update).toBe(0);
  });

  it('POST apply on the same plan returns 409 RESOURCE_CONFLICT', async () => {
    const { app, ctx } = await getTestContext();
    const fx = await buildFixture('cp5');
    const { api } = buildStripePlanApi({});
    ctx.changePlan = createChangePlanService({ stripePlanApi: api });

    await Subscription.create({
      productId: fx.productId,
      planId: fx.planFromId,
      subjectType: 'workspace',
      subjectWorkspaceId: fx.workspaceId,
      gateway: 'stripe',
      gatewayRefs: { stripeSubscriptionId: 'sub_live_5' },
      status: 'ACTIVE',
      amount: 1000,
      currency: 'usd',
    });

    const res = await request(app)
      .post('/v1/billing/subscription/change-plan')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({ newPlanId: fx.planFromId, workspaceId: fx.workspaceId });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('RESOURCE_CONFLICT');
  });

  it('POST apply across currencies returns 422 VALIDATION_FAILED', async () => {
    const { app, ctx } = await getTestContext();
    const fx = await buildFixture('cp6', { toCurrency: 'bdt' });
    const { api } = buildStripePlanApi({});
    ctx.changePlan = createChangePlanService({ stripePlanApi: api });

    await Subscription.create({
      productId: fx.productId,
      planId: fx.planFromId,
      subjectType: 'workspace',
      subjectWorkspaceId: fx.workspaceId,
      gateway: 'stripe',
      gatewayRefs: { stripeSubscriptionId: 'sub_live_6' },
      status: 'ACTIVE',
      amount: 1000,
      currency: 'usd',
    });

    const res = await request(app)
      .post('/v1/billing/subscription/change-plan')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({ newPlanId: fx.planToId, workspaceId: fx.workspaceId });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });

  it('POST apply targeting a free plan returns 409 BILLING_DOWNGRADE_BLOCKED', async () => {
    const { app, ctx } = await getTestContext();
    const fx = await buildFixture('cp7', { toIsFree: true });
    const { api } = buildStripePlanApi({});
    ctx.changePlan = createChangePlanService({ stripePlanApi: api });

    await Subscription.create({
      productId: fx.productId,
      planId: fx.planFromId,
      subjectType: 'workspace',
      subjectWorkspaceId: fx.workspaceId,
      gateway: 'stripe',
      gatewayRefs: { stripeSubscriptionId: 'sub_live_7' },
      status: 'ACTIVE',
      amount: 1000,
      currency: 'usd',
    });

    const res = await request(app)
      .post('/v1/billing/subscription/change-plan')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({ newPlanId: fx.planToId, workspaceId: fx.workspaceId });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('BILLING_DOWNGRADE_BLOCKED');
  });

  it('POST apply on a TRIALING sub swaps the plan immediately in DB only', async () => {
    const { app, ctx } = await getTestContext();
    const fx = await buildFixture('cp8');
    const { api, calls } = buildStripePlanApi({});
    ctx.changePlan = createChangePlanService({ stripePlanApi: api });

    const sub = await Subscription.create({
      productId: fx.productId,
      planId: fx.planFromId,
      subjectType: 'workspace',
      subjectWorkspaceId: fx.workspaceId,
      gateway: null,
      gatewayRefs: {},
      status: 'TRIALING',
      amount: 1000,
      currency: 'usd',
      trialStartsAt: new Date(),
      trialEndsAt: new Date(Date.now() + 5 * 86_400_000),
    });

    const res = await request(app)
      .post('/v1/billing/subscription/change-plan')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({ newPlanId: fx.planToId, workspaceId: fx.workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.scheduled).toBe(false);
    expect(res.body.subscription.planId).toBe(fx.planToId);
    expect(calls.update).toBe(0);

    const fresh = await Subscription.findById(sub._id).lean();
    expect(fresh?.planId).toBe(fx.planToId);
    expect(fresh?.amount).toBe(2900);
    expect(fresh?.status).toBe('TRIALING');
  });
});
