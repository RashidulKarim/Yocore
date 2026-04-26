/**
 * Phase 3.4 Wave 3 — SSLCommerz checkout + IPN (Flow J4 / ADR-005).
 *
 * Verifies:
 *   • POST /v1/billing/checkout with a BDT plan + sslcommerz routing returns
 *     a GatewayPageURL and persists an INCOMPLETE subscription row keyed on
 *     the YoCore-minted `tran_id`.
 *   • POST /v1/webhooks/sslcommerz with a VALID, signed IPN activates the
 *     subscription, calls Stripe `invoices.pay({paid_out_of_band:true})`,
 *     enqueues an outbound webhook, and dedupes replays.
 *   • Bad signatures, unknown tran_id, and FAILED status are all handled
 *     correctly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createHash, createHmac } from 'node:crypto';
import { getTestContext, resetDatabase } from '../../test/integration-setup.js';
import { signJwt } from '../lib/jwt.js';
import { createCheckoutService } from '../services/checkout.service.js';
import { createSslcommerzWebhookService } from '../services/sslcommerz-webhook.service.js';
import type { SslcommerzGatewayApi } from '../services/sslcommerz-api.js';
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
import { randomBytes } from 'node:crypto';

const ACCESS_TTL = 900;
const SSL_STORE_ID = 'yocoretest';
const SSL_STORE_PASSWD = 'yocoretest@ssl';

interface Fixture {
  productId: string;
  workspaceId: string;
  userId: string;
  planId: string;
  token: string;
  email: string;
}

async function buildFixture(slug: string): Promise<Fixture> {
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
    billingConfig: { gatewayRouting: { default: 'stripe', bdt: 'sslcommerz' } },
  });

  // Stripe gateway (calendar)
  await PaymentGateway.create({
    productId: product._id,
    provider: 'stripe',
    mode: 'test',
    status: 'ACTIVE',
    credentialsEncrypted: {
      secretKey: encrypt('sk_test_dummy'),
      webhookSecret: encrypt('whsec_dummy_xx'),
    },
  });
  // SSLCommerz gateway
  await PaymentGateway.create({
    productId: product._id,
    provider: 'sslcommerz',
    mode: 'test',
    status: 'ACTIVE',
    credentialsEncrypted: {
      storeId: encrypt(SSL_STORE_ID),
      storePasswd: encrypt(SSL_STORE_PASSWD),
    },
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

  // BDT plan with stripe calendar price already published.
  const plan = await BillingPlan.create({
    productId: product._id,
    name: 'Pro BDT',
    slug: 'pro-bdt',
    isFree: false,
    amount: 30000, // BDT 300.00
    currency: 'bdt',
    interval: 'month',
    intervalCount: 1,
    status: 'ACTIVE',
    visibility: 'public',
    gatewayPriceIds: { stripe: 'price_test_pro_bdt' },
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
    planId: plan._id,
    token,
    email,
  };
}

interface StubCalls {
  custCalls: number;
  subCalls: number;
  sessionCalls: number;
  validateCalls: number;
  payCalls: number;
  lastTotal?: number;
  lastTranId?: string;
}

function buildSslcommerzStub(opts: {
  validationStatus?: 'VALID' | 'VALIDATED' | 'INVALID_TRANSACTION';
  amountMajor?: string;
  failPay?: boolean;
} = {}): { api: SslcommerzGatewayApi; calls: StubCalls } {
  const calls: StubCalls = {
    custCalls: 0,
    subCalls: 0,
    sessionCalls: 0,
    validateCalls: 0,
    payCalls: 0,
  };
  const api: SslcommerzGatewayApi = {
    async findOrCreateStripeCalendarCustomer({ yocoreUserId }) {
      calls.custCalls += 1;
      return { id: `cus_cal_${yocoreUserId.slice(-6)}` };
    },
    async createStripeCalendarSubscription({ customerId }) {
      calls.subCalls += 1;
      const now = Math.floor(Date.now() / 1000);
      return {
        id: `sub_cal_${randomBytes(4).toString('hex')}`,
        customer: customerId,
        latest_invoice: `in_test_${randomBytes(4).toString('hex')}`,
        current_period_start: now,
        current_period_end: now + 30 * 24 * 3600,
      };
    },
    async createSslcommerzSession({ tranId, totalAmount }) {
      calls.sessionCalls += 1;
      calls.lastTotal = totalAmount;
      calls.lastTranId = tranId;
      return {
        status: 'SUCCESS',
        GatewayPageURL: `https://sandbox.sslcommerz.com/EasyCheckOut/${tranId}`,
        sessionkey: 'sk_test',
      };
    },
    async validateSslcommerzTransaction({ valId }) {
      calls.validateCalls += 1;
      return {
        status: opts.validationStatus ?? 'VALID',
        val_id: valId,
        amount: opts.amountMajor ?? '300.00',
        currency: 'BDT',
      };
    },
    async payStripeInvoiceOutOfBand({ invoiceId }) {
      calls.payCalls += 1;
      if (opts.failPay) throw new Error('stripe pay failed');
      return { id: invoiceId, status: 'paid' };
    },
  };
  return { api, calls };
}

/**
 * Build a valid IPN body + signature for tests. We set `verify_key` to the
 * comma-separated list of signing-input keys (matching SSLCommerz behavior),
 * sort them alphabetically, build `key=value&...&store_passwd=md5(passwd)`,
 * and HMAC-SHA256 with `storePasswd`.
 */
function buildSignedIpn(args: {
  tranId: string;
  valId: string;
  amount: string; // major units, e.g. '300.00'
  currency?: string;
  status?: string;
}): Record<string, string> {
  const body: Record<string, string> = {
    tran_id: args.tranId,
    val_id: args.valId,
    amount: args.amount,
    currency: args.currency ?? 'BDT',
    status: args.status ?? 'VALID',
    bank_tran_id: '999',
    card_type: 'VISA',
    store_amount: args.amount,
  };
  const verifyKeys = Object.keys(body).sort();
  body['verify_key'] = verifyKeys.join(',');

  // canonical = sorted key=value joined w/ & + &store_passwd=md5(passwd)
  const sorted = [...verifyKeys].sort();
  const parts = sorted.map((k) => `${k}=${body[k]}`);
  const passwdHash = createHash('md5').update(SSL_STORE_PASSWD).digest('hex');
  parts.push(`store_passwd=${passwdHash}`);
  const canonical = parts.join('&');
  const sigSha2 = createHmac('sha256', SSL_STORE_PASSWD).update(canonical).digest('hex');
  body['verify_sign_sha2'] = sigSha2;
  // Also include MD5 form for completeness.
  body['verify_sign'] = createHash('md5').update(canonical).digest('hex');
  return body;
}

describe('Phase 3.4 Wave 3 — SSLCommerz checkout + IPN (Flow J4)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('POST /v1/billing/checkout returns a SSLCommerz GatewayPageURL for a BDT plan', async () => {
    const { app, ctx, redis } = await getTestContext();
    const fx = await buildFixture('twssl1');
    const { api, calls } = buildSslcommerzStub();
    ctx.checkout = createCheckoutService({ redis, sslcommerzApi: api });

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
    expect(res.body.gateway).toBe('sslcommerz');
    expect(res.body.url).toContain('sslcommerz.com/EasyCheckOut/');
    expect(res.body.sessionId).toMatch(/^yc_[a-f0-9]+$/);

    expect(calls.custCalls).toBe(1);
    expect(calls.subCalls).toBe(1);
    expect(calls.sessionCalls).toBe(1);
    expect(calls.lastTotal).toBe(300); // 30000 minor → 300 major

    const sub = await Subscription.findOne({
      'gatewayRefs.sslcommerzTranId': res.body.sessionId,
    }).lean();
    expect(sub).toBeTruthy();
    expect(sub?.status).toBe('INCOMPLETE');
    expect(sub?.gateway).toBe('sslcommerz');
    expect(sub?.amount).toBe(30000);
    expect(sub?.currency).toBe('bdt');
  });

  it('rejects when SSLCommerz gateway is missing', async () => {
    const { app, ctx, redis } = await getTestContext();
    const fx = await buildFixture('twssl2');
    await PaymentGateway.deleteMany({ productId: fx.productId, provider: 'sslcommerz' });
    const { api } = buildSslcommerzStub();
    ctx.checkout = createCheckoutService({ redis, sslcommerzApi: api });

    const res = await request(app)
      .post('/v1/billing/checkout')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({
        planId: fx.planId,
        workspaceId: fx.workspaceId,
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      });
    expect(res.status).toBe(412);
    expect(res.body.error).toBe('BILLING_GATEWAY_CONFIG_MISSING');
  });

  it('IPN with VALID signature activates the subscription + closes Stripe loop', async () => {
    const { app, ctx, redis } = await getTestContext();
    const fx = await buildFixture('twssl3');
    const { api, calls } = buildSslcommerzStub();
    ctx.checkout = createCheckoutService({ redis, sslcommerzApi: api });
    ctx.sslcommerzWebhook = createSslcommerzWebhookService({ sslcommerzApi: api });

    const co = await request(app)
      .post('/v1/billing/checkout')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({
        planId: fx.planId,
        workspaceId: fx.workspaceId,
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      });
    expect(co.status).toBe(200);
    const tranId = co.body.sessionId as string;

    const ipn = buildSignedIpn({ tranId, valId: 'val_xxx', amount: '300.00' });
    const res = await request(app)
      .post('/v1/webhooks/sslcommerz')
      .type('form')
      .send(ipn);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, deduped: false, activated: true });

    const sub = await Subscription.findOne({
      'gatewayRefs.sslcommerzTranId': tranId,
    }).lean();
    expect(sub?.status).toBe('ACTIVE');
    expect((sub?.gatewayRefs as { sslcommerzValId?: string })?.sslcommerzValId).toBe('val_xxx');

    expect(calls.validateCalls).toBe(1);
    expect(calls.payCalls).toBe(1);

    const dedup = await WebhookEventProcessed.findOne({
      provider: 'sslcommerz',
      eventId: tranId,
    }).lean();
    expect(dedup).toBeTruthy();

    const delivery = await WebhookDelivery.findOne({
      productId: fx.productId,
      event: 'subscription.activated',
    }).lean();
    expect(delivery).toBeTruthy();
  });

  it('IPN replay is idempotent (deduped:true)', async () => {
    const { app, ctx, redis } = await getTestContext();
    const fx = await buildFixture('twssl4');
    const { api } = buildSslcommerzStub();
    ctx.checkout = createCheckoutService({ redis, sslcommerzApi: api });
    ctx.sslcommerzWebhook = createSslcommerzWebhookService({ sslcommerzApi: api });

    const co = await request(app)
      .post('/v1/billing/checkout')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({
        planId: fx.planId,
        workspaceId: fx.workspaceId,
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      });
    const tranId = co.body.sessionId as string;
    const ipn = buildSignedIpn({ tranId, valId: 'val_xxx', amount: '300.00' });

    const r1 = await request(app).post('/v1/webhooks/sslcommerz').type('form').send(ipn);
    expect(r1.status).toBe(200);
    expect(r1.body.deduped).toBe(false);

    const r2 = await request(app).post('/v1/webhooks/sslcommerz').type('form').send(ipn);
    expect(r2.status).toBe(200);
    expect(r2.body.deduped).toBe(true);
  });

  it('IPN with bad signature is rejected (401 WEBHOOK_SIGNATURE_INVALID)', async () => {
    const { app, ctx, redis } = await getTestContext();
    const fx = await buildFixture('twssl5');
    const { api } = buildSslcommerzStub();
    ctx.checkout = createCheckoutService({ redis, sslcommerzApi: api });
    ctx.sslcommerzWebhook = createSslcommerzWebhookService({ sslcommerzApi: api });

    const co = await request(app)
      .post('/v1/billing/checkout')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({
        planId: fx.planId,
        workspaceId: fx.workspaceId,
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      });
    const tranId = co.body.sessionId as string;
    const ipn = buildSignedIpn({ tranId, valId: 'val_xxx', amount: '300.00' });
    ipn.verify_sign_sha2 = 'deadbeef'.repeat(8); // garbage
    ipn.verify_sign = 'deadbeef'.repeat(4);

    const res = await request(app).post('/v1/webhooks/sslcommerz').type('form').send(ipn);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('IPN with unknown tran_id is rejected (422 WEBHOOK_PAYLOAD_INVALID)', async () => {
    const { app, ctx } = await getTestContext();
    const { api } = buildSslcommerzStub();
    ctx.sslcommerzWebhook = createSslcommerzWebhookService({ sslcommerzApi: api });

    const ipn = buildSignedIpn({ tranId: 'yc_unknown_xx', valId: 'v', amount: '300.00' });
    const res = await request(app).post('/v1/webhooks/sslcommerz').type('form').send(ipn);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('WEBHOOK_PAYLOAD_INVALID');
  });

  it('IPN with status=FAILED does not activate but is recorded', async () => {
    const { app, ctx, redis } = await getTestContext();
    const fx = await buildFixture('twssl6');
    const { api, calls } = buildSslcommerzStub();
    ctx.checkout = createCheckoutService({ redis, sslcommerzApi: api });
    ctx.sslcommerzWebhook = createSslcommerzWebhookService({ sslcommerzApi: api });

    const co = await request(app)
      .post('/v1/billing/checkout')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({
        planId: fx.planId,
        workspaceId: fx.workspaceId,
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      });
    const tranId = co.body.sessionId as string;

    const ipn = buildSignedIpn({
      tranId,
      valId: 'val_x',
      amount: '300.00',
      status: 'FAILED',
    });
    const res = await request(app).post('/v1/webhooks/sslcommerz').type('form').send(ipn);
    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(false);

    expect(calls.validateCalls).toBe(0);
    expect(calls.payCalls).toBe(0);

    const sub = await Subscription.findOne({
      'gatewayRefs.sslcommerzTranId': tranId,
    }).lean();
    expect(sub?.status).toBe('INCOMPLETE');
  });

  it('IPN with Stripe pay-out-of-band failure marks subscription PAST_DUE (J4.11 desync guard)', async () => {
    const { app, ctx, redis } = await getTestContext();
    const fx = await buildFixture('twssl7');
    const { api } = buildSslcommerzStub({ failPay: true });
    ctx.checkout = createCheckoutService({ redis, sslcommerzApi: api });
    ctx.sslcommerzWebhook = createSslcommerzWebhookService({ sslcommerzApi: api });

    const co = await request(app)
      .post('/v1/billing/checkout')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({
        planId: fx.planId,
        workspaceId: fx.workspaceId,
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      });
    const tranId = co.body.sessionId as string;

    const ipn = buildSignedIpn({ tranId, valId: 'val_xxx', amount: '300.00' });
    const res = await request(app).post('/v1/webhooks/sslcommerz').type('form').send(ipn);
    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);

    const sub = await Subscription.findOne({
      'gatewayRefs.sslcommerzTranId': tranId,
    }).lean();
    expect(sub?.status).toBe('PAST_DUE');
  });
});
