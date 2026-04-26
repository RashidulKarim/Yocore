/**
 * Phase 3.4 Wave 2 — Stripe checkout + webhook (Flow J1, J1.6).
 *
 * - POST /v1/billing/checkout — initiates a Stripe checkout session
 * - POST /v1/webhooks/stripe — handles `checkout.session.completed` and
 *   creates the corresponding subscription row (with dedup + signature
 *   verification).
 *
 * Stripe HTTP is fully stubbed via `stripeApi` + `stripeWebhookApi` overrides
 * on the AppContext (see `createCheckoutService` / `createStripeWebhookService`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../test/integration-setup.js';
import { signJwt } from '../lib/jwt.js';
import { createCheckoutService, type StripeApi } from '../services/checkout.service.js';
import {
  createStripeWebhookService,
  type StripeWebhookApi,
} from '../services/stripe-webhook.service.js';
import { Product } from '../db/models/Product.js';
import { PaymentGateway } from '../db/models/PaymentGateway.js';
import { Workspace } from '../db/models/Workspace.js';
import { WorkspaceMember } from '../db/models/WorkspaceMember.js';
import { Subscription } from '../db/models/Subscription.js';
import { WebhookEventProcessed } from '../db/models/WebhookEventProcessed.js';
import { WebhookDelivery } from '../db/models/WebhookDelivery.js';
import { BillingPlan } from '../db/models/BillingPlan.js';
import { User } from '../db/models/User.js';
import { ProductUser } from '../db/models/ProductUser.js';
import { encrypt } from '../lib/encryption.js';
import { hash as hashSecret } from '../lib/password.js';
import { signWebhook } from '../lib/webhook-signature.js';
import { randomBytes } from 'node:crypto';

const ACCESS_TTL = 900;
const STRIPE_WHSEC = 'whsec_test_dummy_secret_value_xx';

// ── Fixture builder ────────────────────────────────────────────────────
interface Fixture {
  productId: string;
  workspaceId: string;
  userId: string;
  planId: string;
  token: string;
  email: string;
}

async function buildFixture(slug = 'tco'): Promise<Fixture> {
  const { ctx } = await getTestContext();

  // Product + Stripe gateway with a known webhook secret
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
    credentialsEncrypted: {
      secretKey: encrypt('sk_test_dummy'),
      webhookSecret: encrypt(STRIPE_WHSEC),
    },
    lastVerifiedAt: new Date(),
    lastVerificationStatus: 'ok',
    lastVerificationError: null,
  });

  // User + product user
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

  // Workspace + OWNER membership
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

  // Plan (ACTIVE w/ a stripe price id pre-set)
  const plan = await BillingPlan.create({
    productId: product._id,
    name: 'Pro',
    slug: 'pro',
    isFree: false,
    amount: 2900,
    currency: 'usd',
    interval: 'month',
    intervalCount: 1,
    status: 'ACTIVE',
    visibility: 'public',
    gatewayPriceIds: { stripe: 'price_test_pro' },
  });

  // JWT for the end-user (productId + workspaceId scoped)
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
    planId: plan._id,
    token,
    email,
  };
}

function buildStripeApiStub(): {
  api: StripeApi;
  calls: {
    findCustomer: number;
    createCustomer: number;
    createSession: number;
    last?: { customerId?: string; priceId?: string };
  };
} {
  const calls = { findCustomer: 0, createCustomer: 0, createSession: 0 } as {
    findCustomer: number;
    createCustomer: number;
    createSession: number;
    last?: { customerId?: string; priceId?: string };
  };
  const api: StripeApi = {
    async findCustomerByYocoreUserId() {
      calls.findCustomer += 1;
      return null;
    },
    async createCustomer({ yocoreUserId }) {
      calls.createCustomer += 1;
      return { id: `cus_test_${yocoreUserId.slice(-6)}` };
    },
    async createCheckoutSession(args) {
      calls.createSession += 1;
      calls.last = { customerId: args.customerId, priceId: args.priceId };
      return {
        id: `cs_test_${randomBytes(4).toString('hex')}`,
        url: `https://checkout.stripe.test/${args.idempotencyKey}`,
      };
    },
  };
  return { api, calls };
}

describe('Phase 3.4 Wave 2 — Stripe checkout + webhook (Flow J1)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('POST /v1/billing/checkout returns a hosted checkout url', async () => {
    const { app, ctx, redis } = await getTestContext();
    const fx = await buildFixture('tco1');
    const { api, calls } = buildStripeApiStub();
    ctx.checkout = createCheckoutService({ redis, stripeApi: api });

    const res = await request(app)
      .post('/v1/billing/checkout')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({
        planId: fx.planId,
        workspaceId: fx.workspaceId,
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      gateway: 'stripe',
      sessionId: expect.stringMatching(/^cs_test_/),
      url: expect.stringContaining('checkout.stripe.test'),
    });
    expect(calls.createCustomer).toBe(1);
    expect(calls.createSession).toBe(1);
    expect(calls.last?.priceId).toBe('price_test_pro');
  });

  it('rejects checkout when no active subscription guard fires', async () => {
    const { app, ctx, redis } = await getTestContext();
    const fx = await buildFixture('tco2');
    const { api } = buildStripeApiStub();
    ctx.checkout = createCheckoutService({ redis, stripeApi: api });

    // Pre-existing active subscription for the same workspace.
    await Subscription.create({
      productId: fx.productId,
      planId: fx.planId,
      subjectType: 'workspace',
      subjectWorkspaceId: fx.workspaceId,
      gateway: 'stripe',
      status: 'ACTIVE',
      amount: 2900,
      currency: 'usd',
    });

    const res = await request(app)
      .post('/v1/billing/checkout')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({
        planId: fx.planId,
        workspaceId: fx.workspaceId,
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('RESOURCE_CONFLICT');
  });

  it('rejects checkout for free plan with VALIDATION_FAILED', async () => {
    const { app, ctx, redis } = await getTestContext();
    const fx = await buildFixture('tco3');
    const { api } = buildStripeApiStub();
    ctx.checkout = createCheckoutService({ redis, stripeApi: api });
    await BillingPlan.findByIdAndUpdate(fx.planId, {
      $set: { isFree: true, amount: 0 },
    });

    const res = await request(app)
      .post('/v1/billing/checkout')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({
        planId: fx.planId,
        workspaceId: fx.workspaceId,
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });

  it('reuses an existing Stripe customer (J1.2b dedup)', async () => {
    const { app, ctx, redis } = await getTestContext();
    const fx = await buildFixture('tco4');
    // Pre-existing canceled sub with a stripeCustomerId for this user.
    await Subscription.create({
      productId: fx.productId,
      planId: fx.planId,
      subjectType: 'user',
      subjectUserId: fx.userId,
      gateway: 'stripe',
      gatewayRefs: { stripeCustomerId: 'cus_existing_123' },
      status: 'CANCELED',
      amount: 2900,
      currency: 'usd',
    });
    const { api, calls } = buildStripeApiStub();
    ctx.checkout = createCheckoutService({ redis, stripeApi: api });

    const res = await request(app)
      .post('/v1/billing/checkout')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({
        planId: fx.planId,
        workspaceId: fx.workspaceId,
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      });
    expect(res.status).toBe(200);
    expect(calls.createCustomer).toBe(0); // reused
    expect(calls.findCustomer).toBe(0); // shortcut from subscriptions
    expect(calls.last?.customerId).toBe('cus_existing_123');
  });

  it('webhook checkout.session.completed creates a subscription row', async () => {
    const { app, ctx } = await getTestContext();
    const fx = await buildFixture('twh1');
    // Inject a Stripe-webhook stub that returns a synthetic subscription.
    const stripeWebhookApi: StripeWebhookApi = {
      async retrieveSubscription({ subscriptionId }) {
        const now = Math.floor(Date.now() / 1000);
        return {
          id: subscriptionId,
          customer: 'cus_test_abc',
          status: 'active',
          current_period_start: now,
          current_period_end: now + 30 * 24 * 3600,
          trial_end: null,
          items: {
            data: [{ price: { id: 'price_test_pro', unit_amount: 2900, currency: 'usd' } }],
          },
          latest_invoice: 'in_test_xxx',
        };
      },
    };
    ctx.stripeWebhook = createStripeWebhookService({ stripeApi: stripeWebhookApi });

    const event = {
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_xx',
          customer: 'cus_test_abc',
          subscription: 'sub_test_xx',
          mode: 'subscription',
          status: 'complete',
          metadata: {
            yocoreProductId: fx.productId,
            yocoreUserId: fx.userId,
            yocorePlanId: fx.planId,
            yocoreSubjectType: 'workspace',
            yocoreSubjectWorkspaceId: fx.workspaceId,
          },
        },
      },
    };
    const raw = JSON.stringify(event);
    const sig = signWebhook(raw, STRIPE_WHSEC).header;

    const res = await request(app)
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', sig)
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, deduped: false, handled: 'checkout.session.completed' });

    const sub = await Subscription.findOne({
      'gatewayRefs.stripeSubscriptionId': 'sub_test_xx',
    }).lean();
    expect(sub).toBeTruthy();
    expect(sub?.status).toBe('ACTIVE');
    expect(sub?.productId).toBe(fx.productId);
    expect(sub?.subjectWorkspaceId).toBe(fx.workspaceId);
    expect(sub?.amount).toBe(2900);

    // Outbound webhook delivery enqueued
    const delivery = await WebhookDelivery.findOne({
      productId: fx.productId,
      event: 'subscription.activated',
    }).lean();
    expect(delivery).toBeTruthy();
    expect(delivery?.status).toBe('PENDING');

    // Dedup row written
    const dedup = await WebhookEventProcessed.findOne({
      provider: 'stripe',
      eventId: 'evt_test_1',
    }).lean();
    expect(dedup).toBeTruthy();
  });

  it('webhook is idempotent — replaying the same event id is a noop 200', async () => {
    const { app, ctx } = await getTestContext();
    const fx = await buildFixture('twh2');
    let calls = 0;
    const stripeWebhookApi: StripeWebhookApi = {
      async retrieveSubscription({ subscriptionId }) {
        calls += 1;
        const now = Math.floor(Date.now() / 1000);
        return {
          id: subscriptionId,
          customer: 'cus_test_abc',
          status: 'active',
          current_period_start: now,
          current_period_end: now + 30 * 24 * 3600,
          trial_end: null,
          items: {
            data: [{ price: { id: 'price_test_pro', unit_amount: 2900, currency: 'usd' } }],
          },
          latest_invoice: 'in_test_xxx',
        };
      },
    };
    ctx.stripeWebhook = createStripeWebhookService({ stripeApi: stripeWebhookApi });

    const event = {
      id: 'evt_test_dup',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_dup',
          customer: 'cus_test_abc',
          subscription: 'sub_test_dup',
          mode: 'subscription',
          metadata: {
            yocoreProductId: fx.productId,
            yocoreUserId: fx.userId,
            yocorePlanId: fx.planId,
            yocoreSubjectType: 'workspace',
            yocoreSubjectWorkspaceId: fx.workspaceId,
          },
        },
      },
    };
    const raw = JSON.stringify(event);
    const sig = signWebhook(raw, STRIPE_WHSEC).header;

    const r1 = await request(app)
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', sig)
      .send(raw);
    expect(r1.status).toBe(200);
    expect(r1.body.deduped).toBe(false);

    const r2 = await request(app)
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', sig)
      .send(raw);
    expect(r2.status).toBe(200);
    expect(r2.body.deduped).toBe(true);

    expect(calls).toBe(1); // Stripe retrieve called only the first time
  });

  it('webhook with bad signature is rejected with WEBHOOK_SIGNATURE_INVALID', async () => {
    const { app, ctx } = await getTestContext();
    const fx = await buildFixture('twh3');
    ctx.stripeWebhook = createStripeWebhookService({
      stripeApi: { async retrieveSubscription() { throw new Error('unreachable'); } },
    });

    const event = {
      id: 'evt_bad_sig',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_x',
          customer: 'cus_x',
          subscription: 'sub_x',
          mode: 'subscription',
          metadata: { yocoreProductId: fx.productId },
        },
      },
    };
    const raw = JSON.stringify(event);
    // Sign with a WRONG secret.
    const sig = signWebhook(raw, 'whsec_WRONG_SECRET').header;

    const res = await request(app)
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', sig)
      .send(raw);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('webhook missing yocoreProductId metadata fails with WEBHOOK_PAYLOAD_INVALID', async () => {
    const { app } = await getTestContext();
    const event = {
      id: 'evt_no_meta',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_x', metadata: {} } },
    };
    const raw = JSON.stringify(event);
    const res = await request(app)
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signWebhook(raw, STRIPE_WHSEC).header)
      .send(raw);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('WEBHOOK_PAYLOAD_INVALID');
  });

  it('non-OWNER/non-ADMIN member cannot checkout (PERMISSION_DENIED)', async () => {
    const { app, ctx, redis } = await getTestContext();
    const fx = await buildFixture('tco5');
    const { api } = buildStripeApiStub();
    ctx.checkout = createCheckoutService({ redis, stripeApi: api });

    // Demote the membership to MEMBER.
    await WorkspaceMember.updateOne(
      { workspaceId: fx.workspaceId, userId: fx.userId },
      { $set: { roleSlug: 'MEMBER' } },
    );

    const res = await request(app)
      .post('/v1/billing/checkout')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({
        planId: fx.planId,
        workspaceId: fx.workspaceId,
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('PERMISSION_DENIED');
  });
});
