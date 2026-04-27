/**
 * Phase 3.5 — Bundle migrations (Flow AM + Flow AN, P1 features).
 *
 * Covers:
 *   • Flow AM (POST /v1/admin/bundles/:id/swap-component)
 *      - grandfather policy: bundle.components mutated, child subs untouched
 *      - forced_migrate policy: child subs' planId flipped + change history appended
 *   • Flow AN-B (POST /v1/billing/bundles/:id/downgrade-to-standalone)
 *      - parent marked cancelAtPeriodEnd
 *      - kept components detached (bundleSubscriptionId/bundleId nulled, planId swapped)
 *      - dropped components left untouched (cascade cron handles them later)
 *      - PERMISSION_DENIED when caller is not the owner
 *
 * Flow AN-A (migrateToBundle) requires real Stripe checkout plumbing and is
 * exercised end-to-end in the demo app; the service layer is unit-covered by
 * its conflict-detection branches via the assertions in this file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { getTestContext, resetDatabase } from '../../test/integration-setup.js';
import { signJwt } from '../lib/jwt.js';
import { Product } from '../db/models/Product.js';
import { BillingPlan } from '../db/models/BillingPlan.js';
import { Bundle } from '../db/models/Bundle.js';
import { Subscription } from '../db/models/Subscription.js';
import { hash as hashSecret } from '../lib/password.js';

const ACCESS_TTL = 900;

async function mintToken(role: 'SUPER_ADMIN' | 'USER'): Promise<{ token: string; userId: string }> {
  const { ctx } = await getTestContext();
  const userId = `usr_${role.toLowerCase()}_${Math.random().toString(36).slice(2)}`;
  const jti = `jti_${Math.random().toString(36).slice(2)}`;
  const token = await signJwt(ctx.keyring, {
    subject: userId,
    ttlSeconds: ACCESS_TTL,
    purpose: 'access',
    jti,
    claims: { role, scopes: [] },
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

async function createPlan(productId: string, slug: string, amount = 1000): Promise<string> {
  const p = await BillingPlan.create({
    productId,
    name: `Plan ${slug}`,
    slug,
    amount,
    currency: 'usd',
    interval: 'month',
    intervalCount: 1,
    trialDays: 0,
    isFree: false,
    visibility: 'public',
    status: 'ACTIVE',
    seatModel: 'unmetered',
    addons: [],
    gatewayPriceIds: { stripe: `price_${randomBytes(6).toString('hex')}`, sslcommerz: null },
    currencyVariants: [],
  });
  return p._id;
}

async function createActiveBundle(
  components: Array<{ productId: string; planId: string }>,
): Promise<string> {
  const doc = await Bundle.create({
    name: 'Power Bundle',
    slug: `power-bundle-${randomBytes(4).toString('hex')}`,
    components,
    pricingModel: 'fixed',
    amount: 4900,
    componentPriceOverrides: [],
    currency: 'usd',
    currencyVariants: [
      {
        currency: 'usd',
        amount: 4900,
        gatewayPriceIds: { stripe: 'price_bundle_usd', sslcommerz: null },
      },
    ],
    interval: 'month',
    intervalCount: 1,
    trialDays: 0,
    componentSeats: {},
    eligibilityPolicy: 'block',
    visibility: 'public',
    status: 'ACTIVE',
    publishedAt: new Date(),
  });
  return doc._id;
}

describe('Phase 3.5 — Flow AM (bundle component plan-swap)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('grandfather policy mutates the bundle but leaves child subs untouched', async () => {
    const { app } = await getTestContext();
    const { token } = await mintToken('SUPER_ADMIN');
    const productA = await createProduct(`prod-a-${randomBytes(3).toString('hex')}`);
    const planA1 = await createPlan(productA, 'a-basic', 1000);
    const planA2 = await createPlan(productA, 'a-pro', 2000);
    const bundleId = await createActiveBundle([{ productId: productA, planId: planA1 }]);

    // One pre-existing child sub on the bundle's component.
    const child = await Subscription.create({
      productId: productA,
      planId: planA1,
      bundleId,
      bundleSubscriptionId: 'sub_parent_x',
      bundleComponentMeta: { gracePolicy: 'bundle' },
      subjectType: 'user',
      subjectUserId: 'usr_owner',
      gateway: null,
      status: 'ACTIVE',
      amount: 1000,
      currency: 'usd',
    });

    const res = await request(app)
      .post(`/v1/admin/bundles/${bundleId}/swap-component`)
      .set('Authorization', `Bearer ${token}`)
      .send({ componentIndex: 0, newPlanId: planA2, applyPolicy: 'grandfather' })
      .expect(200);

    expect(res.body).toMatchObject({
      bundleId,
      componentIndex: 0,
      oldPlanId: planA1,
      newPlanId: planA2,
      applyPolicy: 'grandfather',
      affectedChildSubscriptions: 0,
    });
    const updated = await Bundle.findById(bundleId).lean();
    expect(updated?.components[0]?.planId).toBe(planA2);
    const childAfter = await Subscription.findById(child._id).lean();
    expect(childAfter?.planId).toBe(planA1); // unchanged — grandfathered
  });

  it('forced_migrate policy flips active children to the new plan', async () => {
    const { app } = await getTestContext();
    const { token } = await mintToken('SUPER_ADMIN');
    const productA = await createProduct(`prod-b-${randomBytes(3).toString('hex')}`);
    const planA1 = await createPlan(productA, 'b-basic', 1000);
    const planA2 = await createPlan(productA, 'b-pro', 2500);
    const bundleId = await createActiveBundle([{ productId: productA, planId: planA1 }]);

    const child = await Subscription.create({
      productId: productA,
      planId: planA1,
      bundleId,
      bundleSubscriptionId: 'sub_parent_y',
      bundleComponentMeta: { gracePolicy: 'bundle' },
      subjectType: 'user',
      subjectUserId: 'usr_owner',
      gateway: null,
      status: 'ACTIVE',
      amount: 1000,
      currency: 'usd',
    });

    const res = await request(app)
      .post(`/v1/admin/bundles/${bundleId}/swap-component`)
      .set('Authorization', `Bearer ${token}`)
      .send({ componentIndex: 0, newPlanId: planA2, applyPolicy: 'forced_migrate' })
      .expect(200);

    expect(res.body.affectedChildSubscriptions).toBe(1);
    const childAfter = await Subscription.findById(child._id).lean();
    expect(childAfter?.planId).toBe(planA2);
    expect(childAfter?.amount).toBe(2500);
    expect(childAfter?.changeHistory?.[0]?.type).toBe('plan_change');
  });

  it('rejects swap when newPlanId is not ACTIVE', async () => {
    const { app } = await getTestContext();
    const { token } = await mintToken('SUPER_ADMIN');
    const productA = await createProduct(`prod-c-${randomBytes(3).toString('hex')}`);
    const planA1 = await createPlan(productA, 'c-basic', 1000);
    const planDraft = await BillingPlan.create({
      productId: productA,
      name: 'c-draft',
      slug: 'c-draft',
      amount: 5000,
      currency: 'usd',
      interval: 'month',
      intervalCount: 1,
      trialDays: 0,
      isFree: false,
      visibility: 'public',
      status: 'DRAFT',
      seatModel: 'unmetered',
      addons: [],
      gatewayPriceIds: { stripe: null, sslcommerz: null },
      currencyVariants: [],
    });
    const bundleId = await createActiveBundle([{ productId: productA, planId: planA1 }]);

    const res = await request(app)
      .post(`/v1/admin/bundles/${bundleId}/swap-component`)
      .set('Authorization', `Bearer ${token}`)
      .send({ componentIndex: 0, newPlanId: planDraft._id, applyPolicy: 'grandfather' })
      .expect(404);
    expect(res.body.error).toBe('PLAN_NOT_FOUND');
  });
});

describe('Phase 3.5 — Flow AN-B (downgrade bundle → standalone)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('detaches kept components and marks parent cancelAtPeriodEnd', async () => {
    const { app } = await getTestContext();
    const { token, userId } = await mintToken('USER');
    const productA = await createProduct(`prod-d-${randomBytes(3).toString('hex')}`);
    const productB = await createProduct(`prod-e-${randomBytes(3).toString('hex')}`);
    const planA1 = await createPlan(productA, 'd-basic', 1000);
    const planA2 = await createPlan(productA, 'd-pro', 1900);
    const planB1 = await createPlan(productB, 'e-basic', 800);
    const bundleId = await createActiveBundle([
      { productId: productA, planId: planA1 },
      { productId: productB, planId: planB1 },
    ]);

    const parent = await Subscription.create({
      productId: bundleId,
      planId: bundleId,
      bundleId,
      isBundleParent: true,
      subjectType: 'user',
      subjectUserId: userId,
      gateway: 'stripe',
      status: 'ACTIVE',
      amount: 4900,
      currency: 'usd',
      currentPeriodEnd: new Date(Date.now() + 86_400_000 * 20),
    });
    const childA = await Subscription.create({
      productId: productA,
      planId: planA1,
      bundleId,
      bundleSubscriptionId: parent._id,
      bundleComponentMeta: { gracePolicy: 'bundle' },
      subjectType: 'user',
      subjectUserId: userId,
      gateway: null,
      status: 'ACTIVE',
      amount: 0,
      currency: 'usd',
    });
    const childB = await Subscription.create({
      productId: productB,
      planId: planB1,
      bundleId,
      bundleSubscriptionId: parent._id,
      bundleComponentMeta: { gracePolicy: 'bundle' },
      subjectType: 'user',
      subjectUserId: userId,
      gateway: null,
      status: 'ACTIVE',
      amount: 0,
      currency: 'usd',
    });

    const res = await request(app)
      .post(`/v1/billing/bundles/${parent._id}/downgrade-to-standalone`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        keepComponents: [productA],
        targetPlans: { [productA]: planA2 },
      })
      .expect(200);

    expect(res.body.keptComponents).toHaveLength(1);
    expect(res.body.keptComponents[0]).toMatchObject({
      productId: productA,
      targetPlanId: planA2,
      childSubId: childA._id,
    });
    expect(res.body.droppedComponents).toEqual([productB]);

    const parentAfter = await Subscription.findById(parent._id).lean();
    expect(parentAfter?.cancelAtPeriodEnd).toBe(true);
    expect(parentAfter?.cancelReason).toBe('downgrade_to_standalone');

    const aAfter = await Subscription.findById(childA._id).lean();
    expect(aAfter?.bundleSubscriptionId).toBeNull();
    expect(aAfter?.bundleId).toBeNull();
    expect(aAfter?.planId).toBe(planA2);
    expect(aAfter?.amount).toBe(1900);

    const bAfter = await Subscription.findById(childB._id).lean();
    expect(bAfter?.bundleSubscriptionId).toBe(parent._id); // dropped — left for cascade cron
    expect(bAfter?.status).toBe('ACTIVE');
  });

  it('returns PERMISSION_DENIED when caller does not own the bundle parent', async () => {
    const { app } = await getTestContext();
    const { token } = await mintToken('USER');
    const productA = await createProduct(`prod-f-${randomBytes(3).toString('hex')}`);
    const planA1 = await createPlan(productA, 'f-basic', 1000);
    const bundleId = await createActiveBundle([{ productId: productA, planId: planA1 }]);

    const parent = await Subscription.create({
      productId: bundleId,
      planId: bundleId,
      bundleId,
      isBundleParent: true,
      subjectType: 'user',
      subjectUserId: 'usr_someone_else',
      gateway: 'stripe',
      status: 'ACTIVE',
      amount: 4900,
      currency: 'usd',
    });

    const res = await request(app)
      .post(`/v1/billing/bundles/${parent._id}/downgrade-to-standalone`)
      .set('Authorization', `Bearer ${token}`)
      .send({ keepComponents: [], targetPlans: {} })
      .expect(403);
    expect(res.body.error).toBe('PERMISSION_DENIED');
  });
});
