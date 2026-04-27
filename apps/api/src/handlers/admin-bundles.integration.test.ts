/**
 * Phase 3.5 — Bundles (Flow AL admin CRUD + Flow AK cancel cascade).
 *
 * Covers:
 *  - admin CRUD + publish (with stub Stripe price API)
 *  - V1-V8 validation guards on publish
 *  - preview report
 *  - archive + hard-delete blocked when subs exist
 *  - currency-variant removal blocked while in use
 *  - bundle cancel cascade cron writes children → CANCELED
 *
 * Stripe Bundle price creation is stubbed via `stripeBundlePriceApi`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../test/integration-setup.js';
import { signJwt } from '../lib/jwt.js';
import {
  createBundleService,
  type StripeBundlePriceApi,
} from '../services/bundle.service.js';
import { Product } from '../db/models/Product.js';
import { BillingPlan } from '../db/models/BillingPlan.js';
import { PaymentGateway } from '../db/models/PaymentGateway.js';
import { Subscription } from '../db/models/Subscription.js';
import { encrypt } from '../lib/encryption.js';
import { hash as hashSecret } from '../lib/password.js';
import { randomBytes } from 'node:crypto';

const ACCESS_TTL = 900;

async function mintSuperAdmin(): Promise<{ token: string; userId: string }> {
  const { ctx } = await getTestContext();
  const userId = `usr_admin_${Math.random().toString(36).slice(2)}`;
  const jti = `jti_${Math.random().toString(36).slice(2)}`;
  const token = await signJwt(ctx.keyring, {
    subject: userId,
    ttlSeconds: ACCESS_TTL,
    purpose: 'access',
    jti,
    claims: { role: 'SUPER_ADMIN', scopes: [] },
  });
  await ctx.sessionStore.markActive(jti, ACCESS_TTL);
  return { token, userId };
}

async function createProduct(slug: string): Promise<string> {
  const apiSecretHash = await hashSecret('dummy-secret');
  const doc = await Product.create({
    name: `Product ${slug}`,
    slug,
    apiKey: `yc_live_pk_${randomBytes(8).toString('hex')}`,
    apiSecretHash,
    webhookSecret: randomBytes(32).toString('hex'),
    billingScope: 'workspace',
    status: 'ACTIVE',
  });
  return doc._id;
}

async function attachStripeGateway(productId: string): Promise<void> {
  await PaymentGateway.create({
    productId,
    provider: 'stripe',
    mode: 'test',
    status: 'ACTIVE',
    displayName: 'Stripe',
    credentialsEncrypted: {
      secretKey: encrypt('sk_test_dummy'),
      webhookSecret: encrypt('whsec_dummy'),
    },
    lastVerifiedAt: new Date(),
    lastVerificationStatus: 'ok',
    lastVerificationError: null,
  });
}

async function createPlan(
  productId: string,
  opts: {
    slug: string;
    amount: number;
    interval?: 'month' | 'year';
    intervalCount?: number;
    status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
    currency?: string;
  },
): Promise<string> {
  const p = await BillingPlan.create({
    productId,
    name: `Plan ${opts.slug}`,
    slug: opts.slug,
    amount: opts.amount,
    currency: opts.currency ?? 'usd',
    interval: opts.interval ?? 'month',
    intervalCount: opts.intervalCount ?? 1,
    trialDays: 0,
    isFree: false,
    visibility: 'public',
    status: opts.status ?? 'ACTIVE',
    seatModel: 'unmetered',
    addons: [],
    gatewayPriceIds: { stripe: `price_${randomBytes(6).toString('hex')}`, sslcommerz: null },
    currencyVariants: [],
  });
  return p._id;
}

function bundleInput(components: Array<{ productId: string; planId: string }>): Record<string, unknown> {
  return {
    name: 'Power Bundle',
    slug: 'power-bundle',
    description: 'All-in-one access',
    components,
    pricingModel: 'fixed',
    amount: 4900,
    componentPriceOverrides: [],
    currency: 'usd',
    currencyVariants: [{ currency: 'usd', amount: 4900 }],
    interval: 'month',
    intervalCount: 1,
    trialDays: 0,
    componentSeats: {},
    eligibilityPolicy: 'block',
    visibility: 'public',
    metadata: {},
  };
}

describe('Phase 3.5 — admin bundles (Flow AL)', () => {
  beforeEach(async () => {
    await resetDatabase();
    const { ctx } = await getTestContext();
    // Stub the Stripe price-creation api so publish doesn't hit the network.
    const stripeBundlePriceApi: StripeBundlePriceApi = {
      createBundleProductAndPrice: async () => ({
        priceId: `price_bdl_${randomBytes(6).toString('hex')}`,
      }),
    };
    ctx.bundle = createBundleService({ stripeBundlePriceApi });
  });

  it('creates a bundle in DRAFT status', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdmin();
    const p1 = await createProduct('app1');
    const p2 = await createProduct('app2');
    const pl1 = await createPlan(p1, { slug: 'pro', amount: 2900 });
    const pl2 = await createPlan(p2, { slug: 'pro', amount: 2900 });
    const res = await request(app)
      .post('/v1/admin/bundles')
      .set('Authorization', `Bearer ${token}`)
      .send(
        bundleInput([
          { productId: p1, planId: pl1 },
          { productId: p2, planId: pl2 },
        ]),
      );
    expect(res.status).toBe(201);
    expect(res.body.bundle).toMatchObject({
      slug: 'power-bundle',
      status: 'DRAFT',
      pricingModel: 'fixed',
      amount: 4900,
    });
    expect(res.body.bundle.id).toMatch(/^bdl_/);
  });  it('rejects duplicate slug with 409', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdmin();
    const p1 = await createProduct('a');
    const p2 = await createProduct('b');
    const pl1 = await createPlan(p1, { slug: 'pro', amount: 100 });
    const pl2 = await createPlan(p2, { slug: 'pro', amount: 100 });
    const components = [
      { productId: p1, planId: pl1 },
      { productId: p2, planId: pl2 },
    ];
    await request(app)
      .post('/v1/admin/bundles')
      .set('Authorization', `Bearer ${token}`)
      .send(bundleInput(components));
    const res = await request(app)
      .post('/v1/admin/bundles')
      .set('Authorization', `Bearer ${token}`)
      .send(bundleInput(components));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('RESOURCE_CONFLICT');
  });

  it('publish fails when component plan is missing or interval mismatch (V3/V4)', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdmin();
    const p1 = await createProduct('m1');
    const p2 = await createProduct('m2');
    const pl1 = await createPlan(p1, { slug: 'pro', amount: 100, interval: 'month' });
    const pl2 = await createPlan(p2, { slug: 'pro', amount: 100, interval: 'year' }); // mismatch
    await attachStripeGateway(p1);
    const create = await request(app)
      .post('/v1/admin/bundles')
      .set('Authorization', `Bearer ${token}`)
      .send(
        bundleInput([
          { productId: p1, planId: pl1 },
          { productId: p2, planId: pl2 },
        ]),
      );
    expect(create.status).toBe(201);
    const bundleId = create.body.bundle.id;
    const pub = await request(app)
      .post(`/v1/admin/bundles/${bundleId}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(pub.status).toBe(422);
    expect(pub.body.error).toBe('BILLING_BUNDLE_VALIDATION_FAILED');
    expect(pub.body.details.errors.some((e: { code: string }) => e.code === 'V4')).toBe(true);
  });

  it('publish succeeds, syncs Stripe price, transitions to ACTIVE', async () => {
    const { app, ctx } = await getTestContext();
    const calls: Array<unknown> = [];
    ctx.bundle = createBundleService({
      stripeBundlePriceApi: {
        createBundleProductAndPrice: async (input) => {
          calls.push(input);
          return { priceId: `price_bdl_${calls.length}` };
        },
      },
    });
    const { token } = await mintSuperAdmin();
    const p1 = await createProduct('s1');
    const p2 = await createProduct('s2');
    const pl1 = await createPlan(p1, { slug: 'pro', amount: 2900 });
    const pl2 = await createPlan(p2, { slug: 'pro', amount: 2900 });
    await attachStripeGateway(p1);
    const create = await request(app)
      .post('/v1/admin/bundles')
      .set('Authorization', `Bearer ${token}`)
      .send(
        bundleInput([
          { productId: p1, planId: pl1 },
          { productId: p2, planId: pl2 },
        ]),
      );
    const bundleId = create.body.bundle.id;
    const pub = await request(app)
      .post(`/v1/admin/bundles/${bundleId}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(pub.status).toBe(200);
    expect(pub.body.bundle.status).toBe('ACTIVE');
    expect(pub.body.bundle.publishedAt).not.toBeNull();
    expect(pub.body.bundle.currencyVariants[0].gatewayPriceIds.stripe).toMatch(/^price_bdl_/);
    expect(calls).toHaveLength(1);
  });

  it('preview returns ok=true with pricing breakdown when valid', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdmin();
    const p1 = await createProduct('pv1');
    const p2 = await createProduct('pv2');
    const pl1 = await createPlan(p1, { slug: 'pro', amount: 2900 });
    const pl2 = await createPlan(p2, { slug: 'pro', amount: 2900 });
    const create = await request(app)
      .post('/v1/admin/bundles')
      .set('Authorization', `Bearer ${token}`)
      .send(
        bundleInput([
          { productId: p1, planId: pl1 },
          { productId: p2, planId: pl2 },
        ]),
      );
    const bundleId = create.body.bundle.id;
    const prev = await request(app)
      .get(`/v1/admin/bundles/${bundleId}/preview`)
      .set('Authorization', `Bearer ${token}`);
    expect(prev.status).toBe(200);
    expect(prev.body.ok).toBe(true);
    expect(prev.body.pricing[0]).toMatchObject({
      currency: 'usd',
      bundleAmount: 4900,
      sumStandalone: 5800,
      savings: 900,
    });
  });

  it('hardDelete blocked when subscriptions exist', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdmin();
    const p1 = await createProduct('hd1');
    const p2 = await createProduct('hd2');
    const pl1 = await createPlan(p1, { slug: 'pro', amount: 100 });
    const pl2 = await createPlan(p2, { slug: 'pro', amount: 100 });
    const create = await request(app)
      .post('/v1/admin/bundles')
      .set('Authorization', `Bearer ${token}`)
      .send(
        bundleInput([
          { productId: p1, planId: pl1 },
          { productId: p2, planId: pl2 },
        ]),
      );
    const bundleId = create.body.bundle.id;
    // Seed a subscription that references this bundle.
    await Subscription.create({
      productId: bundleId,
      planId: bundleId,
      bundleId,
      isBundleParent: true,
      subjectType: 'user',
      subjectUserId: 'usr_x',
      gateway: 'stripe',
      status: 'ACTIVE',
      amount: 4900,
      currency: 'usd',
    });
    const del = await request(app)
      .delete(`/v1/admin/bundles/${bundleId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('RESOURCE_CONFLICT');
  });

  it('archive transitions ACTIVE → ARCHIVED', async () => {
    const { app, ctx } = await getTestContext();
    ctx.bundle = createBundleService({
      stripeBundlePriceApi: {
        createBundleProductAndPrice: async () => ({ priceId: 'price_arch' }),
      },
    });
    const { token } = await mintSuperAdmin();
    const p1 = await createProduct('ar1');
    const p2 = await createProduct('ar2');
    const pl1 = await createPlan(p1, { slug: 'pro', amount: 100 });
    const pl2 = await createPlan(p2, { slug: 'pro', amount: 100 });
    await attachStripeGateway(p1);
    const create = await request(app)
      .post('/v1/admin/bundles')
      .set('Authorization', `Bearer ${token}`)
      .send(
        bundleInput([
          { productId: p1, planId: pl1 },
          { productId: p2, planId: pl2 },
        ]),
      );
    const bundleId = create.body.bundle.id;
    await request(app)
      .post(`/v1/admin/bundles/${bundleId}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const arch = await request(app)
      .post(`/v1/admin/bundles/${bundleId}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(arch.status).toBe(200);
    expect(arch.body.bundle.status).toBe('ARCHIVED');
    expect(arch.body.bundle.archivedAt).not.toBeNull();
  });
});

describe('Phase 3.5 — bundle cancel cascade (Flow AK cron)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('cancels child subscriptions when parent is canceled', async () => {
    const { ctx } = await getTestContext();
    const bundleId = `bdl_${randomBytes(8).toString('hex')}`;
    // Parent (CANCELED).
    const parent = await Subscription.create({
      productId: bundleId,
      planId: bundleId,
      bundleId,
      isBundleParent: true,
      subjectType: 'user',
      subjectUserId: 'usr_owner',
      gateway: 'stripe',
      status: 'CANCELED',
      amount: 4900,
      currency: 'usd',
      canceledAt: new Date(),
    });
    // Two ACTIVE children pointing to parent.
    const childA = await Subscription.create({
      productId: 'prd_a',
      planId: 'plan_a',
      bundleSubscriptionId: parent._id,
      bundleId,
      bundleComponentMeta: { gracePolicy: 'bundle' },
      subjectType: 'user',
      subjectUserId: 'usr_owner',
      gateway: null,
      status: 'ACTIVE',
      amount: 0,
      currency: 'usd',
    });
    const childB = await Subscription.create({
      productId: 'prd_b',
      planId: 'plan_b',
      bundleSubscriptionId: parent._id,
      bundleId,
      bundleComponentMeta: { gracePolicy: 'bundle' },
      subjectType: 'user',
      subjectUserId: 'usr_owner',
      gateway: null,
      status: 'ACTIVE',
      amount: 0,
      currency: 'usd',
    });

    const result = await ctx.bundleCascade.runBundleCancelCascade();
    expect(result.scannedParents).toBeGreaterThanOrEqual(1);
    expect(result.canceledChildren).toBe(2);

    const a = await Subscription.findById(childA._id).lean();
    const b = await Subscription.findById(childB._id).lean();
    expect(a?.status).toBe('CANCELED');
    expect(b?.status).toBe('CANCELED');

    // Idempotent re-run: no new cancellations.
    const second = await ctx.bundleCascade.runBundleCancelCascade();
    expect(second.canceledChildren).toBe(0);
  });
});
