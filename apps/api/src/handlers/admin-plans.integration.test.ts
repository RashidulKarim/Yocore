/**
 * Phase 3.4 — Wave 1 Plans (integration).
 *
 * Drives Flow D (create + publish + Stripe price sync) and Flow AO (archive
 * + grandfathering). Uses an in-memory Stripe stub injected via
 * `ctx.plan = createPlanService({ stripeCreatePrice })` after boot so we
 * don't talk to the real Stripe API.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../test/integration-setup.js';
import { signJwt } from '../lib/jwt.js';
import { createPlanService } from '../services/plan.service.js';
import { Product } from '../db/models/Product.js';
import { PaymentGateway } from '../db/models/PaymentGateway.js';
import { Subscription } from '../db/models/Subscription.js';
import { encrypt } from '../lib/encryption.js';
import { hash as hashSecret } from '../lib/password.js';
import { randomBytes } from 'node:crypto';

const ACCESS_TTL = 900;

async function mintSuperAdminToken(): Promise<{ token: string; userId: string }> {
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

async function createProductDirect(slug = 'tplans'): Promise<string> {
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

async function attachStripeGateway(productId: string, mode: 'live' | 'test' = 'test'): Promise<void> {
  await PaymentGateway.create({
    productId,
    provider: 'stripe',
    mode,
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

describe('Phase 3.4 Wave 1 — admin plans (Flow D / AO)', () => {
  beforeEach(async () => {
    await resetDatabase();
    // Reset plan service with a fresh Stripe stub each test.
    const { ctx, redis } = await getTestContext();
    let calls: Array<unknown> = [];
    (ctx as { _stripeCalls?: Array<unknown> })._stripeCalls = calls;
    ctx.plan = createPlanService({
      redis,
      stripeCreatePrice: async (input) => {
        calls.push(input);
        return { id: `price_test_${Math.random().toString(36).slice(2, 10)}` };
      },
    });
  });

  it('creates a plan in DRAFT status', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await createProductDirect('tcreate');
    const res = await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Pro',
        slug: 'pro',
        amount: 2900,
        currency: 'usd',
        interval: 'month',
      });
    expect(res.status).toBe(201);
    expect(res.body.plan).toMatchObject({
      slug: 'pro',
      status: 'DRAFT',
      amount: 2900,
      currency: 'usd',
      visibility: 'public',
    });
    expect(res.body.plan.id).toMatch(/^plan_/);
    expect(res.body.plan.gatewayPriceIds.stripe).toBeNull();
  });

  it('rejects duplicate slug with 409 RESOURCE_CONFLICT', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await createProductDirect('tdup');
    await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Pro', slug: 'pro', amount: 100, currency: 'usd', interval: 'month' });
    const res = await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Pro2', slug: 'pro', amount: 200, currency: 'usd', interval: 'month' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('RESOURCE_CONFLICT');
  });

  it('rejects free=false + amount=0 with 422 VALIDATION_FAILED', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await createProductDirect('tval');
    const res = await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad', slug: 'bad', amount: 0, currency: 'usd', interval: 'month' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });

  it('publishes a paid plan and syncs Stripe price', async () => {
    const { app, ctx } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await createProductDirect('tpub');
    await attachStripeGateway(productId);

    const create = await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Pro', slug: 'pro', amount: 2900, currency: 'usd', interval: 'month' });
    const planId = create.body.plan.id;

    const pub = await request(app)
      .post(`/v1/admin/products/${productId}/plans/${planId}/publish`)
      .set('Authorization', `Bearer ${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.plan.status).toBe('ACTIVE');
    expect(pub.body.plan.gatewayPriceIds.stripe).toMatch(/^price_test_/);

    const calls = (ctx as { _stripeCalls?: Array<{ amount: number; currency: string }> })
      ._stripeCalls!;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ amount: 2900, currency: 'usd', interval: 'month' });
  });

  it('publishes a free plan WITHOUT calling Stripe', async () => {
    const { app, ctx } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await createProductDirect('tfree');
    await attachStripeGateway(productId);

    const create = await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Free',
        slug: 'free',
        isFree: true,
        amount: 0,
        currency: 'usd',
        interval: 'month',
      });
    const planId = create.body.plan.id;

    const pub = await request(app)
      .post(`/v1/admin/products/${productId}/plans/${planId}/publish`)
      .set('Authorization', `Bearer ${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.plan.gatewayPriceIds.stripe).toBeNull();

    const calls = (ctx as { _stripeCalls?: Array<unknown> })._stripeCalls!;
    expect(calls).toHaveLength(0);
  });

  it('publish is idempotent on already-ACTIVE plans', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await createProductDirect('tidemp');
    await attachStripeGateway(productId);
    const create = await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Pro', slug: 'pro', amount: 100, currency: 'usd', interval: 'month' });
    const planId = create.body.plan.id;
    await request(app)
      .post(`/v1/admin/products/${productId}/plans/${planId}/publish`)
      .set('Authorization', `Bearer ${token}`);
    const second = await request(app)
      .post(`/v1/admin/products/${productId}/plans/${planId}/publish`)
      .set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body.plan.status).toBe('ACTIVE');
  });

  it('blocks amount/currency edit on ACTIVE plans (Stripe immutable)', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await createProductDirect('timmut');
    await attachStripeGateway(productId);
    const create = await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Pro', slug: 'pro', amount: 100, currency: 'usd', interval: 'month' });
    const planId = create.body.plan.id;
    await request(app)
      .post(`/v1/admin/products/${productId}/plans/${planId}/publish`)
      .set('Authorization', `Bearer ${token}`);

    const upd = await request(app)
      .patch(`/v1/admin/products/${productId}/plans/${planId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 999 });
    expect(upd.status).toBe(409);
    expect(upd.body.error).toBe('BILLING_PLAN_IMMUTABLE');

    // But updating name still works.
    const ok = await request(app)
      .patch(`/v1/admin/products/${productId}/plans/${planId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Pro Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.plan.name).toBe('Pro Renamed');
  });

  it('archives a plan and reports affected subscriptions (Flow AO)', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await createProductDirect('tarch');
    const create = await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Pro', slug: 'pro', amount: 100, currency: 'usd', interval: 'month' });
    const planId = create.body.plan.id;

    // Seed 2 active + 1 canceled subscription.
    await Subscription.create([
      {
        productId,
        planId,
        subjectType: 'workspace',
        subjectWorkspaceId: 'ws_a',
        status: 'ACTIVE',
        amount: 100,
        currency: 'usd',
      },
      {
        productId,
        planId,
        subjectType: 'workspace',
        subjectWorkspaceId: 'ws_b',
        status: 'TRIALING',
        amount: 100,
        currency: 'usd',
      },
      {
        productId,
        planId,
        subjectType: 'workspace',
        subjectWorkspaceId: 'ws_c',
        status: 'CANCELED',
        amount: 100,
        currency: 'usd',
      },
    ]);

    const arch = await request(app)
      .post(`/v1/admin/products/${productId}/plans/${planId}/archive`)
      .set('Authorization', `Bearer ${token}`);
    expect(arch.status).toBe(200);
    expect(arch.body.plan.status).toBe('ARCHIVED');
    expect(arch.body.affectedSubscriptions).toBe(2);
  });

  it('lists plans with filter', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await createProductDirect('tlist');
    await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'A', slug: 'plan-a', amount: 100, currency: 'usd', interval: 'month' });
    const b = await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'B', slug: 'plan-b', amount: 200, currency: 'usd', interval: 'month' });
    await attachStripeGateway(productId);
    await request(app)
      .post(`/v1/admin/products/${productId}/plans/${b.body.plan.id}/publish`)
      .set('Authorization', `Bearer ${token}`);

    const all = await request(app)
      .get(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`);
    expect(all.body.plans).toHaveLength(2);

    const onlyActive = await request(app)
      .get(`/v1/admin/products/${productId}/plans?status=ACTIVE`)
      .set('Authorization', `Bearer ${token}`);
    expect(onlyActive.body.plans).toHaveLength(1);
    expect(onlyActive.body.plans[0].slug).toBe('plan-b');
  });
});

describe('Phase 3.4 Wave 1 — public plans endpoint', () => {
  beforeEach(async () => {
    await resetDatabase();
    const { ctx, redis } = await getTestContext();
    ctx.plan = createPlanService({
      redis,
      stripeCreatePrice: async () => ({ id: 'price_pub_stub' }),
    });
  });

  it('returns ACTIVE+public plans only, no auth required', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await createProductDirect('tpub-list');
    await attachStripeGateway(productId);

    // Plan A: ACTIVE + public → visible
    const a = await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'A', slug: 'plan-a', amount: 100, currency: 'usd', interval: 'month' });
    await request(app)
      .post(`/v1/admin/products/${productId}/plans/${a.body.plan.id}/publish`)
      .set('Authorization', `Bearer ${token}`);

    // Plan B: ACTIVE + private → hidden
    const b = await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'B',
        slug: 'plan-b',
        amount: 200,
        currency: 'usd',
        interval: 'month',
        visibility: 'private',
      });
    await request(app)
      .post(`/v1/admin/products/${productId}/plans/${b.body.plan.id}/publish`)
      .set('Authorization', `Bearer ${token}`);

    // Plan C: DRAFT → hidden
    await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'C', slug: 'plan-c', amount: 300, currency: 'usd', interval: 'month' });

    const res = await request(app).get(`/v1/products/tpub-list/plans`);
    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0]).toMatchObject({ slug: 'plan-a', amount: 100 });
    // Public projection omits gatewayPriceIds.
    expect(res.body.plans[0].gatewayPriceIds).toBeUndefined();
    expect(res.headers['cache-control']).toContain('max-age=300');
  });

  it('returns 404 PRODUCT_NOT_FOUND for unknown slug', async () => {
    const { app } = await getTestContext();
    const res = await request(app).get('/v1/products/no-such-product/plans');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
  });

  it('serves from Redis cache on second request', async () => {
    const { app, redis } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await createProductDirect('tcache');
    await attachStripeGateway(productId);
    const a = await request(app)
      .post(`/v1/admin/products/${productId}/plans`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'A', slug: 'plan-a', amount: 100, currency: 'usd', interval: 'month' });
    await request(app)
      .post(`/v1/admin/products/${productId}/plans/${a.body.plan.id}/publish`)
      .set('Authorization', `Bearer ${token}`);

    // First call populates the cache.
    await request(app).get(`/v1/products/tcache/plans`);
    const cached = await redis.get(`cache:plans:${productId}`);
    expect(cached).not.toBeNull();

    // Second call must hit cache (mutate the plan's name in Mongo and verify
    // the API still returns the OLD name, proving the cache hit).
    const { BillingPlan } = await import('../db/models/BillingPlan.js');
    await BillingPlan.updateOne({ _id: a.body.plan.id }, { $set: { name: 'CHANGED' } });
    const second = await request(app).get(`/v1/products/tcache/plans`);
    expect(second.body.plans[0].name).toBe('A');
  });
});
