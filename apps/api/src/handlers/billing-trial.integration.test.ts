/**
 * Phase 3.4 Wave 4 — Trial flow (Flow G — Path 2: Free trial).
 *
 * Verifies:
 *   • POST /v1/billing/trial/start creates a TRIALING subscription with no
 *     gateway and resets workspace trial-warning bookkeeping.
 *   • Plan without trialDays → BILLING_TRIAL_INELIGIBLE.
 *   • Single-active guard rejects a second trial-start.
 *   • runTrialTick (Day 11): emits 3-day warning email + flips workspace flag.
 *   • runTrialTick (Day 13): emits 1-day warning email + flips workspace flag.
 *   • runTrialTick (Day 14+): cancels subscription + suspends workspace +
 *     enqueues outbound `subscription.trial_expired` webhook + writes audit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { getTestContext, resetDatabase } from '../../test/integration-setup.js';
import { signJwt } from '../lib/jwt.js';
import { Product } from '../db/models/Product.js';
import { Workspace } from '../db/models/Workspace.js';
import { WorkspaceMember } from '../db/models/WorkspaceMember.js';
import { Subscription } from '../db/models/Subscription.js';
import { WebhookDelivery } from '../db/models/WebhookDelivery.js';
import { BillingPlan } from '../db/models/BillingPlan.js';
import { EmailQueue } from '../db/models/EmailQueue.js';
import { AuditLog } from '../db/models/AuditLog.js';
import { User } from '../db/models/User.js';
import { ProductUser } from '../db/models/ProductUser.js';
import { hash as hashSecret } from '../lib/password.js';

const ACCESS_TTL = 900;
const DAY_MS = 86_400_000;

interface Fixture {
  productId: string;
  workspaceId: string;
  userId: string;
  trialPlanId: string;
  noTrialPlanId: string;
  token: string;
  email: string;
}

async function buildFixture(slug: string): Promise<Fixture> {
  const { ctx } = await getTestContext();
  const product = await Product.create({
    name: 'P',
    slug,
    apiKey: `yc_live_pk_${randomBytes(8).toString('hex')}`,
    apiSecretHash: await hashSecret('dummy'),
    webhookSecret: randomBytes(32).toString('hex'),
    webhookUrl: 'https://example.test/webhooks',
    billingScope: 'workspace',
    status: 'ACTIVE',
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

  const trialPlan = await BillingPlan.create({
    productId: product._id,
    name: 'Pro',
    slug: 'pro',
    isFree: false,
    amount: 2900,
    currency: 'usd',
    interval: 'month',
    intervalCount: 1,
    trialDays: 14,
    status: 'ACTIVE',
    visibility: 'public',
  });
  const noTrialPlan = await BillingPlan.create({
    productId: product._id,
    name: 'Lite',
    slug: 'lite',
    isFree: false,
    amount: 900,
    currency: 'usd',
    interval: 'month',
    intervalCount: 1,
    trialDays: 0,
    status: 'ACTIVE',
    visibility: 'public',
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
    trialPlanId: trialPlan._id,
    noTrialPlanId: noTrialPlan._id,
    token,
    email,
  };
}

describe('Phase 3.4 Wave 4 — Trial flow (Flow G)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('POST /v1/billing/trial/start creates a TRIALING subscription', async () => {
    const { app } = await getTestContext();
    const fx = await buildFixture('trl1');

    const res = await request(app)
      .post('/v1/billing/trial/start')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({ planId: fx.trialPlanId, workspaceId: fx.workspaceId });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('TRIALING');
    expect(typeof res.body.subscriptionId).toBe('string');

    const sub = await Subscription.findById(res.body.subscriptionId).lean();
    expect(sub?.status).toBe('TRIALING');
    expect(sub?.gateway).toBeNull();
    expect(sub?.trialEndsAt).toBeTruthy();

    const ws = await Workspace.findById(fx.workspaceId).lean();
    expect(ws?.trialConverted).toBe(false);
    expect(ws?.trialWarningSent?.days3).toBe(false);
    expect(ws?.trialWarningSent?.days1).toBe(false);
  });

  it('rejects plans without a trial period', async () => {
    const { app } = await getTestContext();
    const fx = await buildFixture('trl2');

    const res = await request(app)
      .post('/v1/billing/trial/start')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({ planId: fx.noTrialPlanId, workspaceId: fx.workspaceId });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('BILLING_TRIAL_INELIGIBLE');
  });

  it('refuses a second trial when one is already active', async () => {
    const { app } = await getTestContext();
    const fx = await buildFixture('trl3');

    const a = await request(app)
      .post('/v1/billing/trial/start')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({ planId: fx.trialPlanId, workspaceId: fx.workspaceId });
    expect(a.status).toBe(201);

    const b = await request(app)
      .post('/v1/billing/trial/start')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({ planId: fx.trialPlanId, workspaceId: fx.workspaceId });
    expect(b.status).toBe(409);
    expect(b.body.error).toBe('RESOURCE_CONFLICT');
  });

  it('runTrialTick sends 3-day warning email and flips workspace flag', async () => {
    const { ctx } = await getTestContext();
    const fx = await buildFixture('trl4');

    // Start trial then back-date trialEndsAt to 2.5 days from now.
    const start = new Date();
    const trialEndsAt = new Date(start.getTime() + 2.5 * DAY_MS);
    await Subscription.create({
      productId: fx.productId,
      planId: fx.trialPlanId,
      subjectType: 'workspace',
      subjectWorkspaceId: fx.workspaceId,
      gateway: null,
      gatewayRefs: {},
      status: 'TRIALING',
      amount: 2900,
      currency: 'usd',
      trialStartsAt: start,
      trialEndsAt,
    });

    const report = await ctx.trial.runTrialTick();
    expect(report.warned3d).toBe(1);
    expect(report.warned1d).toBe(0);
    expect(report.expired).toBe(0);

    const ws = await Workspace.findById(fx.workspaceId).lean();
    expect(ws?.trialWarningSent?.days3).toBe(true);
    expect(ws?.trialWarningSent?.days1).toBe(false);

    const emails = await EmailQueue.find({
      productId: fx.productId,
      templateId: 'billing.trial.warning_days3',
    }).lean();
    expect(emails.length).toBe(1);
    expect(emails[0]?.toAddress).toBe(fx.email);

    // Re-running the tick should not re-send.
    const report2 = await ctx.trial.runTrialTick();
    expect(report2.warned3d).toBe(0);
  });

  it('runTrialTick sends 1-day warning when trial is closer to expiry', async () => {
    const { ctx } = await getTestContext();
    const fx = await buildFixture('trl5');

    const start = new Date();
    const trialEndsAt = new Date(start.getTime() + 0.5 * DAY_MS);
    await Subscription.create({
      productId: fx.productId,
      planId: fx.trialPlanId,
      subjectType: 'workspace',
      subjectWorkspaceId: fx.workspaceId,
      gateway: null,
      gatewayRefs: {},
      status: 'TRIALING',
      amount: 2900,
      currency: 'usd',
      trialStartsAt: start,
      trialEndsAt,
    });

    const report = await ctx.trial.runTrialTick();
    expect(report.warned1d).toBe(1);

    const ws = await Workspace.findById(fx.workspaceId).lean();
    expect(ws?.trialWarningSent?.days1).toBe(true);

    const emails = await EmailQueue.find({
      productId: fx.productId,
      templateId: 'billing.trial.warning_days1',
    }).lean();
    expect(emails.length).toBe(1);
  });

  it('runTrialTick expires a TRIALING sub with no payment method (Scenario B)', async () => {
    const { ctx } = await getTestContext();
    const fx = await buildFixture('trl6');

    const start = new Date(Date.now() - 14 * DAY_MS);
    const trialEndsAt = new Date(Date.now() - 60_000); // 1 minute ago
    const created = await Subscription.create({
      productId: fx.productId,
      planId: fx.trialPlanId,
      subjectType: 'workspace',
      subjectWorkspaceId: fx.workspaceId,
      gateway: null,
      gatewayRefs: {},
      status: 'TRIALING',
      amount: 2900,
      currency: 'usd',
      trialStartsAt: start,
      trialEndsAt,
    });

    const report = await ctx.trial.runTrialTick();
    expect(report.expired).toBe(1);

    const sub = await Subscription.findById(created._id).lean();
    expect(sub?.status).toBe('CANCELED');
    expect(sub?.cancelReason).toBe('trial_no_payment_method');
    expect(sub?.canceledAt).toBeTruthy();

    const ws = await Workspace.findById(fx.workspaceId).lean();
    expect(ws?.suspended).toBe(true);
    expect(ws?.suspensionReason).toBe('trial_expired');
    expect(ws?.status).toBe('SUSPENDED');

    const deliveries = await WebhookDelivery.find({
      productId: fx.productId,
      event: 'subscription.trial_expired',
    }).lean();
    expect(deliveries.length).toBe(1);

    const audits = await AuditLog.find({
      productId: fx.productId,
      action: 'subscription.trial_expired',
    }).lean();
    expect(audits.length).toBe(1);
    expect(audits[0]?.actor.id).toBe('cron:billing.trial.tick');
  });
});
